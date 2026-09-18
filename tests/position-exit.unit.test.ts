/**
 * What a position can ACTUALLY be withdrawn for, measured by simulation rather than by reading the
 * vault's own view.
 *
 * The defect this closes: `usdcValue` is `convertToAssets(shares)` — what the position is
 * worth — and a depositor reads it as what they can have. On a live Fusion test vault at block
 * 51327076 the difference was 10×: `maxWithdraw()` reported the whole 14.999970 USDC position, and
 * 1.498874 already reverted, because a Fusion vault with no instant-withdrawal fuses pays only from its
 * own 1.498873 USDC balance.
 *
 * Simulation, not arithmetic, because the ceiling is chassis-specific in BOTH directions: Fusion pays
 * from its own balance; Morpho V2 holds almost none and still pays out of the markets beneath it.
 */
import { describe, it, expect } from "vitest";
import { BaseError, CallExecutionError, ExecutionRevertedError, HttpRequestError } from "viem";
import { getPosition } from "../src/position.js";
import { getVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";

const ACCOUNT = EARN.fixtures.stranger;
const HEAD = 51_327_076n;

/** What the CHAIN says when it refuses — the shape viem actually produces, not a bare Error. */
const revert = (reason: string) => new BaseError("withdraw reverted", { cause: new ExecutionRevertedError({ cause: new Error(reason) }) });
/** What a broken RPC produces: no revert anywhere in the chain. */
const transportFailure = () => new BaseError("request failed", { cause: new CallExecutionError(new HttpRequestError({ url: "https://rpc.invalid", status: 502 }), {}) });

/** A vault holding `shares` worth `value`, whose `withdraw` succeeds only up to `payable`. */
function vaultClient(opts: { shares: bigint; value: bigint; liquid?: bigint; payable: bigint; maxWithdraw?: bigint; failSimulation?: (assets: bigint) => boolean }) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      getBlockNumber: async () => HEAD,
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
        const vault = getVault("cash-plus-usdc-2a");
        if (functionName === "balanceOf") return address.toLowerCase() === vault.asset.address.toLowerCase() ? (opts.liquid ?? 0n) : opts.shares;
        if (functionName === "convertToAssets") return args?.[0] === opts.shares ? opts.value : 1_000_000n;
        if (functionName === "maxWithdraw") return opts.maxWithdraw ?? opts.value;
        return 0n;
      },
      simulateContract: async ({ args }: { args: readonly unknown[] }) => {
        const assets = args[0] as bigint;
        calls.push(assets.toString());
        if (opts.failSimulation?.(assets)) throw transportFailure();
        if (assets > opts.payable) throw revert("ERC20: transfer amount exceeds balance");
        return { result: 0n };
      },
      getLogs: async () => [],
    } as never,
  };
}

const vault = getVault("cash-plus-usdc-2a");

describe("earn_balance says what can be withdrawn now, not only what the position is worth", () => {
  it("the live Fusion shape: maxWithdraw reports the whole position, only the idle balance is payable", async () => {
    const v = vaultClient({ shares: 1_500_000_000n, value: 14_999_970n, liquid: 1_498_873n, payable: 1_498_873n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.usdcValue).toBe("14.99997 USDC"); // unchanged: what it is worth
    expect(p.exit.exitableNow).toBe("1.498873 USDC"); // what it can pay
    expect(p.exit.measuredAs).toBe("vault's liquid balance");
    expect(p.exit.maxWithdrawSays).toBe("14.99997 USDC");
    expect(p.exit.note).toMatch(/entitlement, not an amount the vault can pay/);
    expect(v.calls).toEqual(["14999970", "1498873"]); // the full position first, then the liquid bound
  });

  it("a vault that pays the whole position says so, and stops after one simulation", async () => {
    const v = vaultClient({ shares: 5n * 10n ** 18n, value: 5_100_000n, liquid: 0n, payable: 5_100_000n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.exitableNow).toBe("5.1 USDC");
    expect(p.exit.measuredAs).toBe("full position");
    expect(v.calls).toEqual(["5100000"]);
  });

  it("Morpho V2's shape — no liquid balance of its own, still pays — is not reported as zero", async () => {
    // The mirror failure: sizing the exit from the vault's own token balance would say 0 here.
    const v = vaultClient({ shares: 10n ** 18n, value: 1_000_000n, liquid: 0n, payable: 1_000_000n, maxWithdraw: 0n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.exitableNow).toBe("1 USDC");
    expect(p.exit.measuredAs).toBe("full position");
    expect(p.exit.maxWithdrawSays).toBe("0 USDC"); // reported, never the verdict
  });

  it("a refusal this client cannot size is `unknown`, never a number", async () => {
    const v = vaultClient({ shares: 1_000n, value: 1_000_000n, liquid: 500_000n, payable: 0n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.exitableNow).toBe("unknown");
    expect(p.exit.measuredAs).toBe("refused, size unknown");
    expect(p.exit.note).toMatch(/REFUSED a full-position withdrawal and one bounded by its liquid balance/);
  });

  it("🔴 a second probe that PAYS is believed, whatever bound produced it", async () => {
    // Reproduced live: liquid 5 USDC against a 1 USDC position, the first attempt
    // reverts and an identical retry succeeds — two calls against "latest" can straddle a block, or a
    // cooldown can clear. The old gate reused the attempt condition as the TRUST condition, discarded
    // the success, and then claimed the vault had refused both.
    let seen = 0;
    const v = vaultClient({ shares: 10n ** 18n, value: 1_000_000n, liquid: 5_000_000n, payable: 0n });
    const client = {
      ...(v.client as Record<string, unknown>),
      simulateContract: async ({ args }: { args: readonly unknown[] }) => {
        v.calls.push(String(args[0]));
        seen += 1;
        if (seen === 1) throw revert("cooldown");
        return { result: 0n };
      },
    } as never;
    const p = await getPosition({ vault, principal: ACCOUNT, client, maxLogRequests: 1 });
    expect(v.calls).toEqual(["1000000", "1000000"]);
    expect(p.exit.exitableNow).toBe("1 USDC");
    expect(p.exit.measuredAs).toBe("full position");
    expect(p.exit.note).toMatch(/an identical retry succeeded/);
  });

  it("when the liquid balance is at or above the position, the note says what was ASKED", async () => {
    // the note named a withdrawal "bounded by its liquid balance" that
    // nobody had simulated — both attempts were the same amount, because there was no smaller bound.
    const v = vaultClient({ shares: 10n ** 18n, value: 215n, liquid: 1_498_873n, payable: 0n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(v.calls).toEqual(["215", "215"]);
    expect(p.exit.note).toMatch(/twice — its liquid balance \(1\.498873 USDC\) is at or above the position/);
    expect(p.exit.note).not.toMatch(/one bounded by its liquid balance/);
  });

  it("the scan's clock starts AFTER the exit, so the exit cannot spend it", async () => {
    // an earlier revision's separate exit budget did not separate the clocks — the
    // scan's deadline was taken before the exit ran, so the exit's seconds came out of the scan's
    // allowance and the comment saying otherwise was false.
    let clock = 0;
    const seen: string[] = [];
    const v = vaultClient({ shares: 10n ** 18n, value: 1_000_000n, liquid: 0n, payable: 1_000_000n });
    const client = {
      ...(v.client as Record<string, unknown>),
      getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
        // The first call asks for the whole range and is refused with a window; the WALK that follows
        // is what the scan's budget pays for, so that is what this counts.
        if (a.toBlock - a.fromBlock > 2_000n) throw revert("eth_getLogs is limited to a 2,000 range");
        seen.push(String(a.fromBlock));
        return [];
      },
    } as never;
    const p = await getPosition({
      vault, principal: ACCOUNT, client, maxLogRequests: 3,
      exitBudgetMs: 12_000, budgetMs: 5_000, now: () => (clock += 2_000),
    });
    expect(p.exit.measuredAs).toBe("full position"); // the exit ran on its own 12s
    expect(seen.length).toBeGreaterThan(0); // and the scan still had a budget of its own to WALK with
  });

  it("the exit has its OWN budget: a spent scan budget does not starve it", async () => {
    // three zero-config runs at 31.6 / 30.8 / 29.2 s — the exit and the
    // scan competed for one 30 s allowance, so the headline number appeared run to run.
    let clock = 1_000;
    const v = vaultClient({ shares: 10n ** 18n, value: 1_000_000n, liquid: 0n, payable: 1_000_000n });
    const p = await getPosition({
      vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1,
      budgetMs: 0, exitBudgetMs: 12_000, now: () => (clock += 1),
    });
    expect(p.exit.measuredAs).toBe("full position"); // the scan's budget is gone; the exit still ran
    expect(v.calls).toEqual(["1000000"]);
  });

  it("🔴 a transport failure on the FIRST simulation is not an answer from the vault", async () => {
    // Measured through a proxy that failed exactly one call. A position
    // that could exit in full (0.000215 USDC against 1.498873 liquid) reported `unknown` AND blamed the
    // vault — one attempt made, the vault never asked. A revert and a 502 are distinguishable in viem's
    // own error chain, and only the revert is an answer.
    const v = vaultClient({ shares: 21_500n, value: 215n, liquid: 1_498_873n, payable: 1_498_873n, failSimulation: (x) => x === 215n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.exitableNow).toBe("unknown");
    expect(p.exit.measuredAs).toBe("not measured");
    expect(p.exit.note).toMatch(/failure to ASK the vault, not an answer from it/);
    expect(p.exit.note).not.toMatch(/refus/i);
    expect(v.calls).toEqual(["215"]); // it stops; it does not probe on to a number it would then report
  });

  it("a transport failure on the SECOND simulation is also not an answer", async () => {
    const v = vaultClient({ shares: 1_500_000_000n, value: 14_999_970n, liquid: 1_498_873n, payable: 1_498_873n, failSimulation: (x) => x === 1_498_873n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.measuredAs).toBe("not measured");
    expect(p.exit.note).toMatch(/second simulation did not complete/);
  });

  it("a vault that refuses the full amount for some OTHER reason is still probed at the liquid bound", async () => {
    // the old `liquid < value` guard skipped the probe whenever the vault held enough,
    // so a refusal with obvious capacity reported `unknown` without ever asking a second question.
    const v = vaultClient({ shares: 10n ** 18n, value: 1_000_000n, liquid: 5_000_000n, payable: 0n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(v.calls).toEqual(["1000000", "1000000"]); // probed again, bounded by the position, not skipped
    expect(p.exit.measuredAs).toBe("refused, size unknown");
  });

  it("shares that convert to nothing are a known zero, not a refusal — and are never simulated", async () => {
    // the same shape as the empty-account return, one rounding step later.
    const v = vaultClient({ shares: 5n, value: 0n, liquid: 1_000_000n, payable: 1_000_000n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.exitableNow).toBe("0 USDC");
    expect(p.exit.measuredAs).toBe("nothing to withdraw");
    expect(p.exit.note).toMatch(/converts to nothing at this share price/);
    expect(v.calls).toEqual([]);
  });

  it("an empty account is not simulated at all", async () => {
    const v = vaultClient({ shares: 0n, value: 0n, liquid: 1_000_000n, payable: 0n });
    const p = await getPosition({ vault, principal: ACCOUNT, client: v.client, maxLogRequests: 1 });
    expect(p.exit.exitableNow).toBe("0 USDC");
    expect(p.exit.measuredAs).toBe("nothing to withdraw");
    expect(p.exit.instantLiquidity).toBe("not read"); // the highest-traffic tool pays for nothing here
    expect(v.calls).toEqual([]);
  });
});
