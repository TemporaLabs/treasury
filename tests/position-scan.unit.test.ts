/**
 * The position scan is deterministic about WHERE it reads history from (the 2026-09-14
 * real round trip, where the scan failed on both the free-tier keyed RPC and publicnode):
 * - it starts at the vault's deployment block, so a complete scan is the whole history;
 * - a configured logs RPC that cannot cover the range hands the scan to a fallback, and says so;
 * - with no fallback, the old degrade-to-bounds behaviour is unchanged.
 * Every error string below is one a real provider returned on 2026-09-14.
 */
import { describe, it, expect } from "vitest";
import { getPosition, UNKNOWN_AFTER_SCAN_FAILURE, UNKNOWN_INCOMPLETE_SCAN } from "../src/position.js";
import { getVault, listVaults } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";

const ACCOUNT = EARN.fixtures.stranger;
/**
 * The default vault, and a head DERIVED FROM ITS DEPLOYMENT BLOCK rather than written down. A
 * literal head silently goes below `deployedAtBlock` the day the registry points at a newer vault,
 * and every scan test then fails on an empty range while claiming to be about windows and fallbacks.
 */
const VAULT = getVault("tlCashPlusUSDC2A");
const DEPLOYED = BigInt(VAULT.deployedAtBlock!);
const HEAD = DEPLOYED + 3_384n;
const PUBLICNODE_ARCHIVE = "Archive requests require a personal token. Get one at: https://example.invalid";
const ALCHEMY_FREE = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";
const BASE_PUBLIC = "eth_getLogs is limited to a 2,000 range";

type GetLogsArgs = { fromBlock: bigint; toBlock: bigint; event: { name: string } };

/** 1 share held, deposited once in a single Deposit event at `depositBlock`; the provider enforces `window`. */
function provider(opts: { window?: bigint; fail?: string; depositBlock?: bigint; withdrawBlock?: bigint; shares?: bigint }) {
  const calls: GetLogsArgs[] = [];
  const client = {
    getBlockNumber: async () => HEAD,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return opts.shares ?? 100_000_000n; // 1 share, 8 decimals
      if (functionName === "convertToAssets") return 1_000_000n;
      return 0n;
    },
    getLogs: async (a: GetLogsArgs) => {
      calls.push(a);
      if (opts.fail) throw new Error(opts.fail);
      if (opts.window !== undefined && a.toBlock - a.fromBlock + 1n > opts.window) throw new Error(BASE_PUBLIC.replace("2,000", opts.window.toLocaleString("en-US")) + (opts.window === 10n ? ` ${ALCHEMY_FREE}` : ""));
      const b = opts.depositBlock;
      if (a.event.name === "Deposit" && b !== undefined && a.fromBlock <= b && b <= a.toBlock) return [{ args: { assets: 1_000_000n, shares: 100_000_000n } }];
      const x = opts.withdrawBlock;
      if (a.event.name === "Withdraw" && x !== undefined && a.fromBlock <= x && x <= a.toBlock) return [{ args: { assets: 1_000_000n, shares: 100_000_000n } }];
      return [];
    },
  };
  return { client: client as never, calls };
}

describe("registry: every vault records the block its contract was deployed at", () => {
  it("each row carries deployedAtBlock, below every measurement taken on it", () => {
    for (const v of listVaults()) {
      expect(v.deployedAtBlock, v.symbol).toBeTypeOf("number");
      expect(v.deployedAtBlock!, v.symbol).toBeLessThan(v.depositOpen.measuredAtBlock);
    }
  });
});

describe("getPosition — where the history is read from", () => {
  const vault = VAULT;

  it("scans from the vault's deployment block when no lookback is given, so complete means the whole history", async () => {
    const p = provider({ depositBlock: BigInt(vault.deployedAtBlock!) + 5n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, maxLogRequests: 1_000 });
    expect(p.calls[0]!.fromBlock).toBe(BigInt(vault.deployedAtBlock!));
    expect(pos.scan.fromBlock).toBe(String(vault.deployedAtBlock));
    expect(pos.scan.complete).toBe(true);
    expect(pos.scan.source).toBe("logs rpc");
    expect(pos.entryBasisUsdc).toBe("1 USDC");
  });

  it("an explicit lookback narrows the range but never reaches before deployment", async () => {
    const p = provider({});
    await getPosition({ vault, principal: ACCOUNT, client: p.client, lookbackBlocks: 50_000_000n });
    expect(p.calls[0]!.fromBlock).toBe(BigInt(vault.deployedAtBlock!));
    const q = provider({});
    await getPosition({ vault, principal: ACCOUNT, client: q.client, lookbackBlocks: 100n });
    expect(q.calls[0]!.fromBlock).toBe(HEAD - 100n);
  });

  it("publicnode's archive refusal hands the scan to the fallback, which reads the whole history", async () => {
    const primary = provider({ fail: PUBLICNODE_ARCHIVE });
    const fallback = provider({ window: 2_000n, depositBlock: BigInt(vault.deployedAtBlock!) + 5n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: primary.client, fallbackClient: fallback.client, maxLogRequests: 100 });
    expect(pos.scan.source).toBe("fallback");
    expect(pos.scan.complete).toBe(true);
    expect(pos.entryBasisUsdc).toBe("1 USDC");
    expect(pos.scan.note).toMatch(/could not cover this range/);
    expect(pos.scan.note).toContain("Archive requests require a personal token");
    expect(pos.scan.note).not.toMatch(/https?:\/\//);
    expect(primary.calls).toHaveLength(1); // one refused call, no retries against a provider that cannot answer
  });

  it("the handover sentence names the VARIABLE, never a host it may not be", async () => {
    // reverting this sentence to "Base's public endpoint served the scan"
    // left 152 tests green, and the note — not the enum — is what an agent reads. A custom
    // TREASURY_LOGS_FALLBACK makes that sentence false, and tsc cannot see prose.
    const primary = provider({ fail: PUBLICNODE_ARCHIVE });
    const fallback = provider({ window: 2_000n, depositBlock: BigInt(vault.deployedAtBlock!) + 5n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: primary.client, fallbackClient: fallback.client, maxLogRequests: 100 });
    expect(pos.scan.note).toContain("TREASURY_LOGS_FALLBACK");
    expect(pos.scan.note).not.toMatch(/Base's public endpoint served/);
    expect(pos.scan.source).toBe("fallback");
  });

  it("a window too narrow to finish (Alchemy free, 10 blocks) is NOT walked: the fallback gets the range", async () => {
    const primary = provider({ window: 10n });
    const fallback = provider({ window: 2_000n, depositBlock: BigInt(vault.deployedAtBlock!) + 5n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: primary.client, fallbackClient: fallback.client, maxLogRequests: 100 });
    expect(primary.calls).toHaveLength(1); // the sizing call only — not 100 requests spent producing a bound
    expect(pos.scan.source).toBe("fallback");
    expect(pos.scan.complete).toBe(true);
    expect(pos.scan.providerWindow).toBe("2000");
  });

  it("a primary whose window CAN finish keeps the scan; the fallback is never touched", async () => {
    const primary = provider({ window: 2_000n, depositBlock: BigInt(vault.deployedAtBlock!) + 5n });
    const fallback = provider({});
    const pos = await getPosition({ vault, principal: ACCOUNT, client: primary.client, fallbackClient: fallback.client, maxLogRequests: 100 });
    expect(pos.scan.source).toBe("logs rpc");
    expect(fallback.calls).toHaveLength(0);
    expect(pos.scan.complete).toBe(true);
  });

  it("when both fail, basis and yield are unknown and the note names both failures", async () => {
    const primary = provider({ fail: PUBLICNODE_ARCHIVE });
    const fallback = provider({ fail: "HTTP request failed. Status: 429" });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: primary.client, fallbackClient: fallback.client });
    expect(pos.entryBasisUsdc).toBe(UNKNOWN_AFTER_SCAN_FAILURE);
    expect(pos.scan.note).toMatch(/logs rpc: .*Archive requests.*fallback: .*429/s);
    // The source named a provider that served NOTHING, because it was set at handover.
    expect(pos.scan.source).toBe("logs rpc");
    expect(pos.scan.wholeHistory).toBe(false);
  });

  it("a lookback that starts after deployment is a WINDOW, and the note never calls it whole history", async () => {
    // Measured: a real wallet, lookback 1000 — 0 deposits, 0 withdrawals, 0 shares now,
    // so the reconciliation is vacuously true and the old note claimed the whole history regardless.
    const p = provider({ window: 2_000n, shares: 0n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, lookbackBlocks: 1_000n, maxLogRequests: 100 });
    expect(pos.scan.complete).toBe(true);
    expect(pos.scan.capped).toBe(false);
    expect(pos.scan.wholeHistory).toBe(false);
    expect(pos.scan.note).toMatch(/WINDOW, NOT the whole history/);
    expect(pos.scan.note).not.toMatch(/covers this position's whole history/);
  });

  it("a capped scan is never whole history even when the shares reconcile", async () => {
    const p = provider({ window: 10n, shares: 0n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, maxLogRequests: 2 });
    expect(pos.scan.capped).toBe(true);
    expect(pos.scan.complete).toBe(true); // 0 in, 0 out, 0 held — vacuous
    expect(pos.scan.wholeHistory).toBe(false);
    expect(pos.scan.note).toMatch(/CUT SHORT/);
    expect(pos.scan.note).toMatch(/vacuously/);
  });

  it("a position whose deposits fall outside the window reports basis and yield as UNKNOWN, not as 100% yield", async () => {
    // 10.011996 USDC of "accrued yield" on a 10 USDC position whose deposit the
    // window never saw. Shares are held, nothing reconciles them: the sums are not a bound anyone can read.
    const p = provider({ window: 2_000n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, lookbackBlocks: 4_000n });
    expect(pos.scan.complete).toBe(false);
    expect(pos.entryBasisUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.accruedYieldUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.usdcValue).toBe("1 USDC"); // the on-chain value is still real
  });

  it("🔴 a window that SAW the deposit and RECONCILES, but started after deployment, still reports unknown", async () => {
    // Measured: a live wallet at lookback 83,000 printed the right basis only
    // because that window happened to catch all thirteen events — which the client cannot know. This
    // is the case every earlier rule let through: 1 share held, one Deposit inside the window, shares
    // in − out reconciles, and the window still never reached the deployment block. The rule is one
    // sentence — a lifetime figure is reported only when the scan covered the lifetime — and this is
    // the mutant that separates it from `!complete`.
    const p = provider({ window: 2_000n, depositBlock: HEAD - 100n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, lookbackBlocks: 1_000n });
    expect(pos.scan.deposits).toBe(1);
    expect(pos.scan.complete, "the premise: this window DOES reconcile").toBe(true);
    expect(pos.scan.wholeHistory).toBe(false);
    expect(pos.entryBasisUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.accruedYieldUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.usdcValue).toBe("1 USDC");
  });

  it("an EXITED account whose window saw only the withdrawal reports unknown, not a negative basis", async () => {
    // the mirror of the case above. Shares are 0, so a `shares > 0` qualifier let
    // the partial sums through — a window that saw the exit but not the entry printed basis −1 USDC and
    // 1 USDC of "yield". `complete` is false either way; that alone is the test.
    const p = provider({ window: 2_000n, shares: 0n, withdrawBlock: HEAD - 100n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, lookbackBlocks: 4_000n });
    expect(pos.scan.withdrawals).toBe(1);
    expect(pos.scan.deposits).toBe(0);
    expect(pos.scan.complete).toBe(false);
    expect(pos.entryBasisUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.accruedYieldUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
  });

  it("an empty WINDOW prints no basis at all — a zero it never saw is not a measurement", async () => {
    // lookback 1000 over a wallet with six deposits and seven withdrawals
    // read nothing, reconciled vacuously (0 shares), and printed basis "0 USDC" as if that were known.
    const p = provider({ window: 2_000n, shares: 0n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, lookbackBlocks: 1_000n });
    expect(pos.scan.deposits + pos.scan.withdrawals).toBe(0);
    expect(pos.scan.complete).toBe(true);
    expect(pos.scan.wholeHistory).toBe(false);
    expect(pos.entryBasisUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.accruedYieldUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
  });

  it("an empty scan that DID cover the whole history reports a real zero", async () => {
    const p = provider({ window: 2_000n, shares: 0n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: p.client, maxLogRequests: 1_000 });
    expect(pos.scan.wholeHistory).toBe(true);
    expect(pos.entryBasisUsdc).toBe("0 USDC");
    expect(pos.accruedYieldUsdc).toBe("0 USDC");
  });

  it("the walk stops at its wall-clock budget and says so", async () => {
    let t = 1_000;
    const p = provider({ window: 10n });
    const pos = await getPosition({
      vault, principal: ACCOUNT, client: p.client, maxLogRequests: 10_000,
      budgetMs: 5_000, now: () => (t += 2_000),
    });
    expect(pos.scan.capped).toBe(true);
    expect(p.calls.length).toBeLessThan(10); // the budget, not the request cap, ended it
    expect(pos.scan.note).toMatch(/time budget/);
    // raising max_log_requests is a dead lever once the CLOCK ended the
    // walk, so the note must not advise it there.
    expect(pos.scan.note).not.toMatch(/raise max_log_requests/);
  });

  it("with no fallback, a too-narrow window still degrades to a bounded walk (unchanged behaviour)", async () => {
    const primary = provider({ window: 10n });
    const pos = await getPosition({ vault, principal: ACCOUNT, client: primary.client, maxLogRequests: 3 });
    expect(pos.scan.capped).toBe(true);
    expect(pos.scan.source).toBe("logs rpc");
    expect(primary.calls.length).toBe(2 * (1 + 3)); // per event: the sizing call + 3 walked windows
  });
});
