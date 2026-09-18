import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from "viem";
import { erc4626Abi, knownRevertSelectors } from "./abi/erc4626.js";
import { erc4626Chassis, type VaultEntry } from "./registry-schema.js";
import { describeError } from "./redact.js";
import { parseAmount, formatAmount } from "./units.js";
import type { ReadClient } from "./client.js";

export type PreflightStatus =
  /** Simulated deposit succeeds as-is: access open, allowance already sufficient. */
  | "OPEN_READY"
  /** Simulated deposit reached the token pull and failed on allowance: access is OPEN; an approve is needed first. */
  | "NEEDS_APPROVAL"
  /** Access-managed revert: the vault restricts `deposit` to a role the depositor lacks. */
  | "WHITELIST_GATED"
  /** A definite revert this client cannot name. Candidates are listed; nothing is diagnosed. */
  | "REVERTED_OTHER"
  /** The client refused before touching the chain (chassis, or registry/chain mismatch). */
  | "REFUSED_BY_CLIENT"
  /** Transport failure. Not a verdict about the vault — an absence of evidence. */
  | "UNRESOLVED";

export interface RevertObservation {
  selector?: Hex;
  reason?: string;
  raw?: Hex;
}

/**
 * Names a cause only where the instrument discriminated; otherwise lists candidates.
 * A revert is an answer. A transport error is not, and must never land here.
 */
export function classifyRevert(obs: RevertObservation): { status: PreflightStatus; note: string } {
  const sel = obs.selector?.toLowerCase();
  if (sel === knownRevertSelectors.AccessManagedUnauthorized) {
    return {
      status: "WHITELIST_GATED",
      note: `deposit() reverted AccessManagedUnauthorized (${sel}) — the vault's AccessManager restricts deposit to a role this address does not hold (on IPOR Fusion: role 800 WHITELIST). redeem() may still be public.`,
    };
  }
  if (sel === knownRevertSelectors.TransferFromReverted) {
    return {
      status: "NEEDS_APPROVAL",
      note: `deposit() reverted TransferFromReverted (${sel}) — the call passed every access gate and died pulling the asset: access is OPEN, approve first.`,
    };
  }
  if (obs.reason && /allowance|ERC20InsufficientAllowance|transfer amount exceeds/i.test(obs.reason)) {
    return {
      status: "NEEDS_APPROVAL",
      note: `deposit() reverted "${obs.reason}" — died at the token pull: access is OPEN, approve first.`,
    };
  }
  return {
    status: "REVERTED_OTHER",
    note:
      `deposit() reverted${sel ? ` with selector ${sel}` : ""}${obs.reason ? ` ("${obs.reason}")` : ""}; ` +
      `this client does not name the cause. Check, in no particular order: vault paused; per-block or supply cap; ` +
      `insufficient asset balance at the depositor; a chassis-specific gate this client has not seen. Raw: ${obs.raw ?? "n/a"}.`,
  };
}

/** Pulls the revert payload out of viem's error chain. Returns undefined for anything that is not a definite revert. */
export function extractRevert(err: unknown): RevertObservation | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return undefined;
  const raw = (r as { raw?: Hex }).raw;
  const signature = (r as { signature?: Hex }).signature;
  const selector = signature ?? (raw && raw.length >= 10 ? (raw.slice(0, 10) as Hex) : undefined);
  const out: RevertObservation = {};
  if (selector) out.selector = selector;
  if (r.reason) out.reason = r.reason;
  if (raw) out.raw = raw;
  return out;
}

export interface PreflightResult {
  vault: string;
  depositor: Address;
  status: PreflightStatus;
  canDeposit: boolean;
  /** Observations, in the order they were taken. Each is a sentence a human can act on. */
  findings: string[];
  balances?: { asset: string; shares: string; allowance: string };
  quotes?: { sharePriceInAssets: string; totalAssets: string; previewShares?: string };
  advisory?: { maxDepositRaw: string; note: string };
  measuredAtBlock?: number;
}

export interface PreflightArgs {
  vault: VaultEntry;
  depositor: Address;
  /** Optional. If omitted, one whole unit of the asset is simulated. */
  assetsHuman?: string;
  client: ReadClient;
}

export async function preflightDeposit(args: PreflightArgs): Promise<PreflightResult> {
  const { vault, depositor, client } = args;
  const findings: string[] = [];
  const refuse = (why: string): PreflightResult => ({
    vault: vault.slug,
    depositor,
    status: "REFUSED_BY_CLIENT",
    canDeposit: false,
    findings: [...findings, why],
  });

  if (!erc4626Chassis.has(vault.chassis)) {
    return refuse(`${vault.chassis} exposes no ERC-4626 deposit path; refusing (${vault.depositOpen.detail ?? "see registry"})`);
  }
  if (!vault.depositOpen.open) {
    findings.push(
      `registry says deposits were CLOSED when last measured (block ${vault.depositOpen.measuredAtBlock}, ${vault.depositOpen.reason}); re-measuring live rather than trusting the row`,
    );
  }

  // Cross-artifact identity check: the registry row and the contract must agree about each other.
  // A presence check cannot detect a swapped address; asking the vault what its asset is can.
  let block: bigint;
  let onchainAsset: Address;
  let onchainDecimals: number;
  try {
    [block, onchainAsset, onchainDecimals] = await Promise.all([
      client.getBlockNumber(),
      client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "asset" }),
      client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "decimals" }),
    ]);
  } catch (e) {
    return { vault: vault.slug, depositor, status: "UNRESOLVED", canDeposit: false, findings: [...findings, `identity reads failed: ${describeError(e)}`] };
  }
  if (onchainAsset.toLowerCase() !== vault.asset.address.toLowerCase()) {
    return refuse(`registry asset ${vault.asset.address} != on-chain asset() ${onchainAsset} — registry row is wrong or the address is a different contract`);
  }
  if (onchainDecimals !== vault.shareDecimals) {
    return refuse(`registry shareDecimals ${vault.shareDecimals} != on-chain decimals() ${onchainDecimals}`);
  }
  findings.push(`identity OK at block ${block}: asset()=${onchainAsset}, decimals()=${onchainDecimals}`);

  const assets = parseAmount(args.assetsHuman ?? "1", vault.asset.decimals, `deposit amount (${vault.asset.symbol})`);

  // Reads. Each on its own; a failure here is UNRESOLVED, never a verdict.
  let assetBal: bigint, shareBal: bigint, allowance: bigint, oneShareInAssets: bigint, totalAssets: bigint, maxDep: bigint;
  try {
    [assetBal, shareBal, allowance, oneShareInAssets, totalAssets, maxDep] = await Promise.all([
      client.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] }),
      client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] }),
      client.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "allowance", args: [depositor, vault.address] }),
      client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [10n ** BigInt(vault.shareDecimals)] }),
      client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "totalAssets" }),
      client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "maxDeposit", args: [depositor] }),
    ]);
  } catch (e) {
    return { vault: vault.slug, depositor, status: "UNRESOLVED", canDeposit: false, findings: [...findings, `state reads failed: ${describeError(e)}`] };
  }

  const balances = {
    asset: `${formatAmount(assetBal, vault.asset.decimals)} ${vault.asset.symbol}`,
    shares: `${formatAmount(shareBal, vault.shareDecimals)} ${vault.shareSymbol}`,
    allowance: `${formatAmount(allowance, vault.asset.decimals)} ${vault.asset.symbol}`,
  };
  const quotes: PreflightResult["quotes"] = {
    sharePriceInAssets: `${formatAmount(oneShareInAssets, vault.asset.decimals)} ${vault.asset.symbol} per share`,
    totalAssets: `${formatAmount(totalAssets, vault.asset.decimals)} ${vault.asset.symbol}`,
  };
  const advisory = {
    maxDepositRaw: maxDep.toString(),
    note: "maxDeposit() is ADVISORY ONLY: measured returning uint256.max on a whitelist-gated Fusion vault and 0 on an open Morpho V2 vault. The simulation below is the verdict.",
  };
  if (assetBal < assets) findings.push(`depositor holds ${balances.asset}, less than the ${formatAmount(assets, vault.asset.decimals)} requested — a live deposit would fail on balance even if access is open`);

  // Preview (does not depend on access) — gives the shares quote where the chassis supports it.
  try {
    const previewShares = await client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "previewDeposit", args: [assets] });
    quotes.previewShares = `${formatAmount(previewShares, vault.shareDecimals)} ${vault.shareSymbol}`;
  } catch {
    findings.push("previewDeposit() reverted; no shares quote");
  }

  // The verdict: simulate the real call from the real depositor.
  try {
    await client.simulateContract({
      address: vault.address,
      abi: erc4626Abi,
      functionName: "deposit",
      args: [assets, depositor],
      account: depositor,
    });
    findings.push("simulated deposit() SUCCEEDED from this address with the current allowance");
    return { vault: vault.slug, depositor, status: "OPEN_READY", canDeposit: true, findings, balances, quotes, advisory, measuredAtBlock: Number(block) };
  } catch (e) {
    const obs = extractRevert(e);
    if (!obs) {
      return { vault: vault.slug, depositor, status: "UNRESOLVED", canDeposit: false, findings: [...findings, `simulation did not return a definite revert: ${describeError(e)}`], balances, quotes, advisory, measuredAtBlock: Number(block) };
    }
    const c = classifyRevert(obs);
    findings.push(c.note);
    return {
      vault: vault.slug,
      depositor,
      status: c.status,
      canDeposit: c.status === "NEEDS_APPROVAL",
      findings,
      balances,
      quotes,
      advisory,
      measuredAtBlock: Number(block),
    };
  }
}
