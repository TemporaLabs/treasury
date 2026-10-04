/**
 * Read-only against real Base, and against real Arbitrum One. Each chain's block is skipped unless
 * THAT chain's RPC is configured. No transactions.
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
import { makePublicClient, endpointChainId, rpcUrlFromEnv, PUBLIC_RPC } from "../src/client.js";
import { preflightDeposit } from "../src/preflight.js";
import { quoteDeposit, quoteWithdraw } from "../src/quote.js";
import { getPosition, UNKNOWN_INCOMPLETE_SCAN } from "../src/position.js";
import { defaultVault, getVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";
import { findRoleHolder } from "./access.js";

const STRANGER = EARN.fixtures.stranger;
/** The whitelist-gated Fusion sibling — the vault the access-discrimination tests run on. */
const GATED = "tlCashPlusUSDC2A";
const hasRpc = Boolean(process.env["TREASURY_RPC_BASE"] || process.env["BASE_RPC_URL"]);
const live = hasRpc ? describe : describe.skip;

/** Spark USDC Vault (MetaMorpho, sparkUSDC) — a public 4626 that is NOT ours. The positive control. (name() verified on-chain 2026-09-11) */
const control: VaultEntry = {
  symbol: "sparkUSDC",
  name: "Spark USDC Vault (control, not a Tempora vault)",
  warning: "CONTROL ROW — a third-party vault used to prove a measurement discriminates. Never offered.",
  chainId: 8453,
  address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A",
  chassis: "morpho-v2",
  backend: "morpho",
  isDefault: false,
  asset: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  shareDecimals: 18,
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
    expect(a.shares).toMatch(new RegExp(`^\\d+(\\.\\d+)? ${control.symbol}$`));
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
    expect(q.expectedShares).toMatch(new RegExp(`${defaultVault().symbol}$`));
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

  it("with the public fallback, a real position's history is read whole or reported as cut short, never silently partial", async () => {
    // The account with history on the default vault is whoever the chain says OWNS it — the operator
    // seeded it from that wallet. Read from the contract, never written here. `owner()` is a Morpho
    // Vault V2 surface, not ERC-4626: a default on another chassis fails here loudly, by revert.
    const owner = await client.readContract({ address: defaultVault().address, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
    const fallbackClient = makePublicClient(8453, PUBLIC_RPC[8453]);
    const p = await getPosition({ vault: defaultVault(), principal: owner, client, fallbackClient });
    const deployed = BigInt(defaultVault().deployedAtBlock!);
    // Two outcomes, and which one this is depends on the configured endpoint, not on the code. An
    // endpoint with a wide eth_getLogs window (10,000 blocks) reads the whole history in a few
    // seconds. One with a narrow window (Alchemy's free tier: 10 blocks) hands over to the public
    // fallback, which serves 2,000 blocks a request: reaching the deployment block from the head now
    // takes several hundred requests per event, which no request cap or time budget the client
    // defaults to allows, and every day of the vault's age adds more. A scan that is cut short must
    // SAY so and must not claim a lifetime figure; it is not a failure.
    if (!p.scan.capped) {
      expect(p.scan.fromBlock).toBe(String(deployed));
      expect(p.scan.deposits).toBeGreaterThanOrEqual(1);
      // Reconciliation is the property: shares in − shares out equals the balance, whatever it is now.
      expect(p.scan.complete).toBe(true);
      expect(p.scan.wholeHistory).toBe(true);
      expect(p.entryBasisUsdc).toMatch(/^\d+(\.\d+)? USDC$/);
    } else {
      expect(BigInt(p.scan.fromBlock)).toBeGreaterThan(deployed); // it did not reach the deployment block...
      expect(p.scan.wholeHistory).toBe(false); // ...so it must not say it did,
      expect(p.scan.note).toMatch(/CUT SHORT/); // ...it says where it stopped,
      expect(p.entryBasisUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN); // ...and gives no lifetime figure
      expect(p.accruedYieldUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    }
    // The client's own budgets are 12 s for the exit simulations and 30 s for the scan, taken one
    // after the other, so a cut-short read takes about 45 s: past the 20 s default every test gets.
  }, 120_000);
});

const hasArbitrumRpc = Boolean(process.env["TREASURY_RPC_ARBITRUM"] || process.env["ARBITRUM_RPC_URL"]);
const liveArbitrum = hasArbitrumRpc ? describe : describe.skip;

/**
 * The same instrument on the second chain. What these establish that the unit tier cannot: the
 * classifier's revert selectors, measured on Base, are the ones Arbitrum's contracts actually
 * return — the vault is the same Morpho Vault V2 code and the asset is Circle's native USDC, but
 * "the same code" is a claim about a deployment, and only a call against it settles that.
 */
liveArbitrum("preflight, quotes and position against live Arbitrum One (read-only)", () => {
  const client = makePublicClient(42161, rpcUrlFromEnv(42161));
  const vault = () => defaultVault(42161);

  it("the configured endpoint IS Arbitrum One — and the check that says so can say otherwise", async () => {
    expect(await endpointChainId(client, rpcUrlFromEnv(42161))).toBe(42161);
    // The control: Base's public endpoint through the same function says 8453. Without this arm, a
    // probe that always returned 42161 would pass the line above.
    expect(await endpointChainId(makePublicClient(8453, PUBLIC_RPC[8453]), PUBLIC_RPC[8453])).toBe(8453);
  });

  it("the Arbitrum default (Morpho V2, open) classifies NEEDS_APPROVAL from a stranger while maxDeposit() reads 0", async () => {
    const r = await preflightDeposit({ vault: vault(), depositor: STRANGER, client });
    expect(r.status, JSON.stringify(r, null, 2)).toBe("NEEDS_APPROVAL");
    expect(r.canDeposit).toBe(true);
    expect(r.findings[0]).toMatch(/identity OK/); // asset() and decimals() agree with the registry row, on this chain
    expect(r.findings.at(-1)).toMatch(/TransferFromReverted \(0xe65b7a77\)/);
    expect(r.advisory!.maxDepositRaw).toBe("0"); // why the pre-flight simulates instead of reading it
    expect(r.measuredAtBlock).toBeGreaterThan(vault().deployedAtBlock!);
  });

  it("🔴 the Arbitrum vault read through a BASE endpoint is not a verdict — the identity reads fail, and nothing is classified", async () => {
    // What a misconfigured variable produces, and why `earn_status` names it: on Base there is no
    // contract at this address, so the reads return no data. It must come back UNRESOLVED — never
    // as a gated or closed vault, which would be a verdict about a vault that was never asked.
    const r = await preflightDeposit({ vault: vault(), depositor: STRANGER, client: makePublicClient(8453, PUBLIC_RPC[8453]) as never });
    expect(r.status, JSON.stringify(r, null, 2)).toBe("UNRESOLVED");
    expect(r.canDeposit).toBe(false);
    // The finding is what distinguishes this from "nothing answered" (a refused port gives the same
    // status): the chain ANSWERED, and said the address holds no contract.
    expect(r.findings.at(-1)).toMatch(/returned no data \("0x"\)/);
  });

  it("quote_deposit on the Arbitrum default: expected shares in ITS ticker, and no rate quoted", async () => {
    const q = await quoteDeposit({ vault: vault(), depositor: STRANGER, assetsHuman: "100", client });
    expect(q.preflight.status).toBe("NEEDS_APPROVAL");
    expect(q.canProceed).toBe(true);
    expect(q.expectedShares).toMatch(/tlCashPlusUSDC2C$/);
    expect(Number(q.expectedShares.split(" ")[0])).toBeGreaterThan(50); // ~1 USDC/share
    expect(q).not.toHaveProperty("currentApy");
  });

  it("quote_withdraw for an address with no shares REVERTS in simulation", async () => {
    const EMPTY = "0x1111111111111111111111111111111111111111" as const;
    const bal = await client.readContract({ address: vault().address, abi: erc4626Abi, functionName: "balanceOf", args: [EMPTY] });
    expect(bal, "precondition: the test address must hold no shares").toBe(0n);
    const q = await quoteWithdraw({ vault: vault(), owner: EMPTY, assetsHuman: "1", client });
    expect(q.simulated).toBe("REVERTED");
    expect(q.canProceed).toBe(false);
  });

  it("a real position's whole history reconciles from the vault's deployment block", async () => {
    // As on Base: the account with history is whoever the chain says OWNS the vault — read from the
    // contract, never written here. The fallback is Arbitrum's own public endpoint.
    const owner = await client.readContract({ address: vault().address, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" });
    const fallbackClient = makePublicClient(42161, PUBLIC_RPC[42161]);
    const p = await getPosition({ vault: vault(), principal: owner, client, fallbackClient });
    expect(p.scan.fromBlock).toBe(String(vault().deployedAtBlock));
    expect(p.scan.deposits).toBeGreaterThanOrEqual(1);
    if (!p.scan.capped) {
      expect(p.scan.complete).toBe(true);
      expect(p.scan.wholeHistory).toBe(true);
      expect(p.entryBasisUsdc).toMatch(/^\d+(\.\d+)? USDC$/); // a number, because the whole history was read
    }
    expect(p.usdcValue).toMatch(/^\d+(\.\d+)? USDC$/);
    expect(p.measuredAtBlock).toBeGreaterThan(510_270_114);
  }, 120_000);
});
