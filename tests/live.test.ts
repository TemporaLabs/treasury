/**
 * Read-only against real Base. Skipped unless an RPC is configured. No transactions.
 *
 * These are the instrument-fires-on-a-known-positive checks: a Fusion vault must classify as
 * WHITELIST_GATED, a Morpho V2 vault as NEEDS_APPROVAL, and a public MetaMorpho vault that is
 * not in our registry (the control) as NEEDS_APPROVAL too. If any of these stop holding, either
 * the chain changed (a real finding) or the classifier broke (a real regression) — both matter.
 */
import { describe, it, expect } from "vitest";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { type VaultEntry } from "../src/registry-schema.js";
import { parseAbi } from "viem";
import { makePublicClient, rpcUrlFromEnv, PUBLIC_RPC } from "../src/client.js";
import { preflightDeposit } from "../src/preflight.js";
import { quoteDeposit, quoteWithdraw } from "../src/quote.js";
import { getPosition } from "../src/position.js";
import { defaultVault, getVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";
import { findRoleHolder } from "./access.js";

const STRANGER = EARN.fixtures.stranger;
/** The whitelist-gated Fusion sibling — the vault the access-discrimination tests run on. */
const GATED = "cash-plus-usdc-2a";
const hasRpc = Boolean(process.env["TREASURY_RPC_BASE"] || process.env["BASE_RPC_URL"]);
const live = hasRpc ? describe : describe.skip;

/** Spark USDC Vault (MetaMorpho, sparkUSDC) — a public 4626 that is NOT ours. The positive control. (name() verified on-chain 2026-09-11) */
const control: VaultEntry = {
  slug: "control-spark-usdc-vault",
  displayName: "Spark USDC Vault (control, not a Tempora vault)",
  chainId: 8453,
  address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A",
  chassis: "morpho-v2",
  backend: "morpho",
  isDefault: false,
  asset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  shareDecimals: 18,
  shareSymbol: "sparkUSDC",
  depositOpen: { open: true, method: "simulated-deposit-from-stranger", measuredAtBlock: 51154060, measuredAtIso: "2026-09-11T03:00:00Z" },
  notes: [],
};

live("preflight against live Base (read-only)", () => {
  const client = makePublicClient(8453, rpcUrlFromEnv(8453));

  it("control: a public MetaMorpho vault (Spark USDC) classifies NEEDS_APPROVAL from a stranger", async () => {
    const r = await preflightDeposit({ vault: control, depositor: STRANGER, client });
    expect(r.status, JSON.stringify(r, null, 2)).toBe("NEEDS_APPROVAL");
    expect(r.canDeposit).toBe(true);
    expect(r.findings[0]).toMatch(/identity OK/);
  });

  it("the gated Fusion sibling classifies WHITELIST_GATED from a stranger while maxDeposit() claims the opposite", async () => {
    const r = await preflightDeposit({ vault: getVault(GATED), depositor: STRANGER, client });
    expect(r.status, JSON.stringify(r, null, 2)).toBe("WHITELIST_GATED");
    expect(r.canDeposit).toBe(false);
    // The reason the pre-flight simulates instead of reading a number: maxDeposit() says uint256.max
    // behind the whitelist, so a client that trusted it would build a deposit that reverts.
    expect(BigInt(r.advisory!.maxDepositRaw)).toBeGreaterThan(0n);
  });

  it("the DEFAULT (Morpho V2, open) classifies NEEDS_APPROVAL from a stranger while maxDeposit() reads 0", async () => {
    const r = await preflightDeposit({ vault: defaultVault(), depositor: STRANGER, client });
    expect(r.status, JSON.stringify(r, null, 2)).toBe("NEEDS_APPROVAL");
    expect(r.canDeposit).toBe(true);
    expect(r.advisory!.maxDepositRaw).toBe("0"); // the V2 quirk, the other direction
  });

  it("the gated sibling: a stranger is WHITELIST_GATED and a member discovered on-chain is NEEDS_APPROVAL — same vault, same block", async () => {
    // The pair is the point: one vault answering both ways proves the classifier reads the
    // AccessManager (Fusion role 800 on deposit) rather than the registry row, which says
    // WHITELIST_GATED for everyone. It runs on the gated sibling, not the default: a gated chassis
    // is what the pair discriminates, and the default is open.
    const vault = getVault(GATED);
    const member = await findRoleHolder(client as never, vault);
    expect(member, "the chain names no account holding the deposit role — the whitelist is empty, or the vault is not gated the way the registry says").toBeDefined();
    const gated = await preflightDeposit({ vault, depositor: STRANGER, assetsHuman: EARN.roundTripAmountUsdc, client });
    expect(gated.status, JSON.stringify(gated, null, 2)).toBe("WHITELIST_GATED");
    expect(gated.canDeposit).toBe(false);
    const open = await preflightDeposit({ vault, depositor: member!, assetsHuman: EARN.roundTripAmountUsdc, client });
    expect(open.status, JSON.stringify(open, null, 2)).toBe("NEEDS_APPROVAL");
    expect(open.canDeposit).toBe(true);
    // and the findings say WHY the stale row was not trusted
    expect(open.findings[0]).toMatch(/registry says deposits were CLOSED .* re-measuring live/);
    expect(gated.measuredAtBlock).toBeGreaterThan(vault.deployedAtBlock!);
  }, 180_000);

  it("the gated sibling refuses a stranger with WHITELIST_GATED, never a guess", async () => {
    const r = await preflightDeposit({ vault: getVault(GATED), depositor: STRANGER, client });
    expect(r.status, JSON.stringify(r, null, 2)).toBe("WHITELIST_GATED");
    expect(r.canDeposit).toBe(false);
    expect(r.findings.some((f) => /identity OK/.test(f))).toBe(true);
    expect(r.findings.at(-1)).toMatch(/AccessManagedUnauthorized/);
  }, 180_000);

  it("getPosition returns a well-formed, internally consistent view for an arbitrary holder", async () => {
    // Do not assert a ZERO position for a fixed address: 0x…dEaD was found holding one share of a Tempora
    // vault on Base (2026-09-11) — a premise about chain state nobody had checked. Assert shape
    // and consistency instead, which cannot be falsified by someone burning shares to the address.
    const a = await getPosition({ vault: control, principal: STRANGER, client, maxLogRequests: 2 });
    expect(a.shares).toMatch(new RegExp(`^\\d+(\\.\\d+)? ${control.shareSymbol}$`));
    expect(a.sharesExact).toMatch(/^\d+(\.\d+)?$/);
    expect(a.usdcValue).toMatch(/^\d+(\.\d+)? USDC$/);
    expect(a.sharePriceInAssets).toMatch(/^\d+(\.\d+)? USDC per share$/);
    const shares = Number(a.sharesExact);
    const value = Number(a.usdcValue.split(" ")[0]);
    const price = Number(a.sharePriceInAssets.split(" ")[0]);
    if (shares === 0) expect(value).toBe(0);
    else expect(Math.abs(value - shares * price)).toBeLessThan(0.01 * Math.max(1, value));
    expect(a.measuredAtBlock).toBeGreaterThan(51_000_000);
  });

  it("quote_deposit on the default for a stranger: expected shares and the open verdict carried through", async () => {
    const q = await quoteDeposit({ vault: defaultVault(), depositor: STRANGER, assetsHuman: "100", client });
    expect(q.preflight.status).toBe("NEEDS_APPROVAL"); // the default is open
    expect(q.canProceed).toBe(true);
    expect(q.expectedShares).toMatch(new RegExp(`${defaultVault().shareSymbol}$`));
    expect(Number(q.expectedShares.split(" ")[0])).toBeGreaterThan(50); // ~1 USDC/share
    // no rate is quoted at all: the field does not exist on the result
    expect(q).not.toHaveProperty("currentApy");
  });

  it("quote_withdraw for an address with no shares REVERTS in simulation and says why", async () => {
    // 0x…dEaD holds shares on some vaults (people burn shares there) — assert the premise instead of assuming it.
    const EMPTY = "0x1111111111111111111111111111111111111111" as const;
    const bal = await client.readContract({ address: defaultVault().address, abi: erc4626Abi, functionName: "balanceOf", args: [EMPTY] });
    expect(bal, "precondition: the test address must hold no shares").toBe(0n);
    const q = await quoteWithdraw({ vault: defaultVault(), owner: EMPTY, assetsHuman: "1", client });
    expect(q.simulated).toBe("REVERTED");
    expect(q.canProceed).toBe(false);
    expect(q.advisory.maxWithdrawRaw).toBe("0"); // an empty owner can withdraw nothing on any chassis
  });

  it("get_position survives a provider that caps eth_getLogs, and says how far it got", async () => {
    const EMPTY = "0x1111111111111111111111111111111111111111" as const;
    const p = await getPosition({ vault: defaultVault(), principal: EMPTY, client, lookbackBlocks: 200_000n, maxLogRequests: 5 });
    expect(p.sharesExact).toBe("0");
    expect(p.usdcValue).toBe("0 USDC");
    expect(p.scan.complete).toBe(true); // 0 in, 0 out, 0 held reconciles regardless of window
    expect(p.scan.deposits + p.scan.withdrawals).toBe(0);
    // A provider can cap the scan WITHOUT an error that names a window (publicnode refuses old
    // ranges as "archive requests"), so a capped scan either learned a window or explains the failure.
    if (p.scan.capped) expect(p.scan.providerWindow ?? p.scan.note).toMatch(/^\d+$|FAILED/);
    expect(p).not.toHaveProperty("currentApy");
  });

  it("with the public fallback, a real position's whole history reconciles on any configured RPC", async () => {
    // The account with history on the default vault is whoever the chain says OWNS it — the operator
    // seeded it from that wallet. Read from the contract, never written here. `owner()` is a Morpho
    // Vault V2 surface, not ERC-4626: a default on another chassis fails here loudly, by revert.
    const owner = await client.readContract({ address: defaultVault().address, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
    const fallbackClient = makePublicClient(8453, PUBLIC_RPC[8453]);
    const p = await getPosition({ vault: defaultVault(), principal: owner, client, fallbackClient });
    expect(p.scan.fromBlock).toBe(String(defaultVault().deployedAtBlock));
    expect(p.scan.deposits).toBeGreaterThanOrEqual(1);
    // Reconciliation is the property: shares in − shares out equals the balance, whatever it is now.
    if (!p.scan.capped) expect(p.scan.complete).toBe(true);
  });
});
