import type { Address } from "viem";
import { erc4626Abi } from "./abi/erc4626.js";
import { type VaultEntry } from "./registry-schema.js";
import { describeError } from "./redact.js";
import { parseAmount, formatAmount } from "./units.js";
import type { ReadClient } from "./client.js";
import { preflightDeposit, extractRevert, type PreflightResult } from "./preflight.js";

/**
 * Pre-trade quotes. A quote is three things kept apart:
 * what the chain says the trade would do now (preview/simulate), what a data provider says the
 * and what this client cannot know (gas at inclusion, slippage the
 * vault does not bound). Each is labelled as itself.
 */
export interface DepositQuote {
  vault: string;
  depositor: Address;
  amountUsdc: string;
  expectedShares: string;
  sharePriceInAssets: string;
  preflight: PreflightResult;
  canProceed: boolean;
  rejectReason?: string;
  bounds: string;
  validUntil: string;
}

export async function quoteDeposit(args: { vault: VaultEntry; depositor: Address; assetsHuman: string; client: ReadClient }): Promise<DepositQuote> {
  const { vault, depositor, client } = args;
  const assets = parseAmount(args.assetsHuman, vault.asset.decimals, `deposit amount (${vault.asset.symbol})`);
  const pre = await preflightDeposit({ vault, depositor, assetsHuman: args.assetsHuman, client });
  const [previewShares, oneShareInAssets] = await Promise.all([
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "previewDeposit", args: [assets] }).catch(() => undefined),
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [10n ** BigInt(vault.shareDecimals)] }),
  ]);
  const q: DepositQuote = {
    vault: vault.slug,
    depositor,
    amountUsdc: `${formatAmount(assets, vault.asset.decimals)} ${vault.asset.symbol}`,
    expectedShares: previewShares === undefined ? "unavailable (previewDeposit reverted)" : `${formatAmount(previewShares, vault.shareDecimals)} ${vault.shareSymbol}`,
    sharePriceInAssets: `${formatAmount(oneShareInAssets, vault.asset.decimals)} ${vault.asset.symbol} per share`,
    preflight: pre,
    canProceed: pre.canDeposit,
    bounds:
      "ERC-4626 deposit has no on-chain min-shares parameter; the share count at inclusion may differ slightly from expectedShares as the share price moves. Gas: estimate × 1.5 (see gasAdvice on the built calls).",
    validUntil: "this block — re-quote before signing if more than a few blocks pass",
  };
  if (!pre.canDeposit) q.rejectReason = pre.findings.at(-1) ?? pre.status;
  return q;
}

export interface WithdrawQuote {
  vault: string;
  owner: Address;
  amountUsdc: string;
  sharesToBurn: string;
  sharesHeld: string;
  simulated: "OK" | "REVERTED" | "UNRESOLVED";
  note: string;
  /**
   * The vault's OWN balance of the asset — what it can pay out in this block without unwinding a
   * position. On Fusion with no instant-withdrawal fuses this is the hard ceiling on a withdrawal,
   * and `maxWithdraw()` does not know it (measured 2026-09-13: maxWithdraw 10.01, liquid 0.80).
   */
  instantLiquidity: string;
  advisory: { maxWithdrawRaw: string; note: string };
  queue: string;
  canProceed: boolean;
}

export async function quoteWithdraw(args: { vault: VaultEntry; owner: Address; assetsHuman: string; client: ReadClient }): Promise<WithdrawQuote> {
  const { vault, owner, client } = args;
  const assets = parseAmount(args.assetsHuman, vault.asset.decimals, `withdraw amount (${vault.asset.symbol})`);
  const [held, toBurn, maxW, liquid] = await Promise.all([
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "previewWithdraw", args: [assets] }).catch(() => undefined),
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "maxWithdraw", args: [owner] }).catch(() => undefined),
    client.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [vault.address] }),
  ]);
  let simulated: WithdrawQuote["simulated"] = "UNRESOLVED";
  let note = "";
  try {
    await client.simulateContract({ address: vault.address, abi: erc4626Abi, functionName: "withdraw", args: [assets, owner, owner], account: owner });
    simulated = "OK";
    note = "simulated withdraw() from the owner succeeds at this block";
  } catch (e) {
    const obs = extractRevert(e);
    if (obs) {
      simulated = "REVERTED";
      // Withdraw reverts have their own causes; classifyRevert is the DEPOSIT classifier and its
      // "approve first" wording is wrong here (it was reused, and told an agent to approve USDC
      // when the vault simply had 0.80 USDC liquid — measured 2026-09-13 on a Fusion vault).
      const reason = obs.reason ?? "";
      if (toBurn !== undefined && held < toBurn) {
        note = `withdraw() reverted: the owner holds ${formatAmount(held, vault.shareDecimals)} ${vault.shareSymbol} against ${formatAmount(toBurn, vault.shareDecimals)} needed — insufficient shares. (${reason || obs.selector})`;
      } else if (/transfer amount exceeds balance|ERC20InsufficientBalance/i.test(reason) || liquid < assets) {
        note = `withdraw() reverted: the vault holds ${formatAmount(liquid, vault.asset.decimals)} ${vault.asset.symbol} liquid against ${formatAmount(assets, vault.asset.decimals)} requested — this chassis pays withdrawals from its own balance in the same block; the rest is deployed and needs the fund to unwind first. Withdraw at most the liquid amount now, or wait. maxWithdraw() (${maxW === undefined ? "reverted" : formatAmount(maxW, vault.asset.decimals)}) does not know this.`;
      } else {
        note = `withdraw() reverted "${reason || obs.selector}" — not a balance or liquidity shortfall; treat as a vault-side refusal.`;
      }
    } else {
      note = `simulation did not return a definite revert: ${describeError(e, 160)}`;
    }
  }
  return {
    vault: vault.slug,
    owner,
    amountUsdc: `${formatAmount(assets, vault.asset.decimals)} ${vault.asset.symbol}`,
    sharesToBurn: toBurn === undefined ? "unavailable (previewWithdraw reverted)" : `${formatAmount(toBurn, vault.shareDecimals)} ${vault.shareSymbol}`,
    sharesHeld: `${formatAmount(held, vault.shareDecimals)} ${vault.shareSymbol}`,
    simulated,
    note,
    instantLiquidity: `${formatAmount(liquid, vault.asset.decimals)} ${vault.asset.symbol}`,
    advisory: {
      maxWithdrawRaw: maxW === undefined ? "reverted" : maxW.toString(),
      note: "maxWithdraw() is ADVISORY: Morpho Vault V2 returns 0 for every owner by design; The simulation above is the verdict.",
    },
    queue: "none — this chassis settles withdrawals in the same transaction; no claim step",
    canProceed: simulated === "OK",
  };
}
