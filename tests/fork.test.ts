/**
 * Acceptance: a full deposit → redeem round trip on a fork of Base against the default vault,
 * using ONLY the calls this package builds. Gated behind TREASURY_FORK=1 because it spawns anvil.
 *
 * The signer here is anvil impersonating a USDC-rich account. That is the point: the skill emits
 * unsigned calls, and something else — here the fork node — signs them. No key is read anywhere.
 *
 * Process hygiene: a distinct port per run, the PID recorded, only that PID killed, and the port
 * confirmed free afterwards — so a concurrent session's anvil is never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw } from "../src/build.js";
import { getPosition, UNKNOWN_INCOMPLETE_SCAN } from "../src/position.js";
import { quoteWithdraw } from "../src/quote.js";
import { preflightDeposit, extractRevert } from "../src/preflight.js";
import { getVault } from "../src/registry.js";
import { EARN } from "../src/config/earn.js";
import { findRoleHolder } from "./access.js";

const enabled = process.env["TREASURY_FORK"] === "1";
const upstream = process.env["TREASURY_RPC_BASE"] || process.env["BASE_RPC_URL"];
const fork = enabled && upstream ? describe : describe.skip;

// Every address and amount below comes from config/earn.ts — nothing is named here.
const WHALE: Address = EARN.fixtures.usdcWhale;
const STRANGER: Address = EARN.fixtures.stranger;
const ROUND_TRIP = EARN.roundTripVault;
/** The whitelist-gated sibling, for the access-discrimination pair. Its member is DISCOVERED from the chain. */
const GATED = "tlCashPlusUSDC2A";
/**
 * The account holding the gated vault's deposit role, DISCOVERED FROM THE CHAIN in `beforeAll` and
 * impersonated — an address, never a key, and never written down here (`tests/access.ts` says why).
 * `undefined` if the chain names nobody; the pair test then fails with that reason, not the arm.
 */
let gatedMember: Address | undefined;
const PORT = 18545 + (process.pid % 1000);
const RPC = `http://127.0.0.1:${PORT}`;

let anvil: ChildProcess | undefined;

async function waitForRpc(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  const c = createPublicClient({ chain: base, transport: http(RPC) });
  while (Date.now() < deadline) {
    try {
      await c.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`anvil on ${RPC} did not come up in ${ms}ms`);
}

fork("fork round trip: deposit → redeem through the package's unsigned calls", () => {
  // 60s: a fork's first touch of a contract's storage is an upstream round-trip per slot, and can stall past viem's 10s default.
  const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 60_000 }) });
  const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC, { timeout: 60_000 }) });
  const wallet = createWalletClient({ chain: base, transport: http(RPC, { timeout: 60_000 }) });


/**
 * Send with a buffered gas limit. Morpho V2 deposit/redeem gas depends on time elapsed since the
 * last interest accrual; an estimate taken at the current timestamp under-counts the storage
 * writes the mined block will do, and the tx dies out-of-gas while every simulation succeeds
 * (measured: redeem reverted at 310,505 gas with simulate + prior-block re-sim both green).
 */
async function sendBuffered(to: Address, data: `0x${string}`, from: Address = WHALE): Promise<`0x${string}`> {
  const est = await pub.estimateGas({ account: from, to, data, value: 0n });
  return wallet.sendTransaction({ account: from, to, data, value: 0n, gas: (est * 15n) / 10n });
}
  beforeAll(async () => {
    // Pin the fork a few blocks behind head: a load-balanced upstream can serve lazy state fetches
    // from replicas that have not yet seen the very latest block, which surfaces as a spurious
    // revert mid-test. Blocks a little behind head exist everywhere.
    const head = await createPublicClient({ chain: base, transport: http(upstream!) }).getBlockNumber();
    const pinned = head - 8n;
    anvil = spawn(
      "anvil",
      ["--fork-url", upstream!, "--fork-block-number", pinned.toString(), "--port", String(PORT), "--silent", "--no-rate-limit"],
      { stdio: "ignore" },
    );
    await waitForRpc(60_000);
    await test.impersonateAccount({ address: WHALE });
    await test.setBalance({ address: WHALE, value: parseUnits("1", 18) });

    // The round-trip target is OPEN (measured), so the whale deposits directly. WHO may deposit into
    // the gated sibling is read from its AccessManager, not from this repository; a stale address
    // would produce an AccessManagedUnauthorized that reads like a broken test.
    expect(getVault(ROUND_TRIP).depositOpen.open, `${ROUND_TRIP} is the round-trip target and must be measured open`).toBe(true);
    gatedMember = await findRoleHolder(pub as never, getVault(GATED));
    if (gatedMember && gatedMember !== WHALE) {
      await test.impersonateAccount({ address: gatedMember });
      await test.setBalance({ address: gatedMember, value: parseUnits("1", 18) });
    }
  }, 180_000);

  afterAll(async () => {
    if (anvil?.pid) {
      anvil.kill("SIGTERM");
      // verify the RESOURCE is released, not just that the process exited
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await pub.getBlockNumber();
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          return;
        }
      }
      anvil.kill("SIGKILL");
    }
  });

  it(`${GATED} (gated Fusion sibling): the SAME fork classifies a stranger WHITELIST_GATED and the discovered member NEEDS_APPROVAL`, async () => {
    // The discriminating pair on one vault at one block: if both read the same, the classifier is
    // not seeing the AccessManager. Kept on the gated sibling now that the default is open.
    expect(gatedMember, `${GATED}: no account holds the deposit role on its AccessManager — the whitelist is empty, or the vault is not gated the way the registry says`).toBeDefined();
    const vault = getVault(GATED);
    const gated = await preflightDeposit({ vault, depositor: STRANGER, assetsHuman: EARN.fixtures.forkDepositUsdc, client: pub as never });
    expect(gated.status, JSON.stringify(gated, null, 2)).toBe("WHITELIST_GATED");
    expect(gated.canDeposit).toBe(false);
    const open = await preflightDeposit({ vault, depositor: gatedMember!, assetsHuman: EARN.fixtures.forkDepositUsdc, client: pub as never });
    expect(open.status, JSON.stringify(open, null, 2)).toBe("NEEDS_APPROVAL");
    expect(open.canDeposit).toBe(true);
  }, 120_000);

  // The round trip runs on the DEFAULT, which is open: the whale deposits directly, no member needed.
  // The chassis coverage the unit tiers give is in `tests/fixtures/registry.ts`; what only a fork can
  // prove is the round trip through the real contracts, and the pair above proves the gate is read.
  it.each([[`${ROUND_TRIP} (the round-trip target and the DEFAULT, open — the whale deposits)`, ROUND_TRIP]])(
    "%s: preflight NEEDS_APPROVAL → approve+deposit mint shares → OPEN_READY → redeem returns the USDC",
    async (_label, symbol) => {
      const depositor = WHALE;
    const vault = getVault(symbol);
    const amount = EARN.fixtures.forkDepositUsdc;
    const usdcBefore = await pub.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
    expect(usdcBefore).toBeGreaterThan(parseUnits(amount, 6));
    // A depositor may already hold shares on mainnet (the discovered member held 10.01 USDC, measured
    // 2026-09-13; the fork inherits that). Every position assertion below is a DELTA against this, so the
    // test is correct for a fresh depositor and for one with history the event window cannot see.
    const sharesBefore = await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
    const valueBefore = Number(formatUnits(await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [sharesBefore] }), 6));

    const pre = await preflightDeposit({ vault, depositor: depositor, assetsHuman: amount, client: pub as never });
    expect(pre.status, JSON.stringify(pre, null, 2)).toBe("NEEDS_APPROVAL");

    // The package builds; the fork signs. Two calls, in order.
    const calls = buildDeposit(vault, { assetsHuman: amount, receiver: depositor, account: depositor });
    for (const c of calls) {
      const hash = await sendBuffered(c.to, c.data, depositor);
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") {
        // Re-simulate at the block before it mined to recover the revert reason; a bare
        // "reverted" receipt is an observation with the diagnosis stripped off.
        let why = "(no revert data recovered)";
        try {
          await pub.call({ account: depositor, to: c.to, data: c.data, blockNumber: rcpt.blockNumber - 1n });
          why = "(re-simulation at the prior block SUCCEEDED — state changed between estimate and mine, or gas)";
        } catch (e) {
          const obs = extractRevert(e);
          why = obs ? `selector=${obs.selector} reason=${obs.reason ?? ""} raw=${obs.raw ?? ""}` : String(e).slice(0, 300);
        }
        const bal = await pub.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
        const alw = await pub.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "allowance", args: [depositor, vault.address] });
        throw new Error(`${c.description} REVERTED in tx ${hash} (block ${rcpt.blockNumber}, gasUsed ${rcpt.gasUsed}): ${why}; whale USDC=${bal} allowance=${alw}`);
      }
    }

    const after = await getPosition({ vault, principal: depositor, client: pub as never, maxLogRequests: 2 });
    const shares = await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
    expect(shares).toBeGreaterThan(sharesBefore);
    expect(after.shares).toMatch(new RegExp(`${vault.symbol}$`));

    // After the approve landed, a fresh preflight for the same amount is OPEN_READY — the allowance was the only thing in the way.
    // (The approve was consumed by the deposit, so approve again for the check to be about access, not allowance.)
    const reapprove = buildDeposit(vault, { assetsHuman: amount, receiver: depositor, account: depositor })[0]!;
    await pub.waitForTransactionReceipt({ hash: await sendBuffered(reapprove.to, reapprove.data, depositor) });
    const pre2 = await preflightDeposit({ vault, depositor: depositor, assetsHuman: amount, client: pub as never });
    expect(pre2.status, JSON.stringify(pre2, null, 2)).toBe("OPEN_READY");

    // Position after the deposit: value grew by ≈ 100 USDC, and the vault's own events show the deposit.
    // A 50-block window is NOT the whole history, whoever the depositor is: the deposit is in the
    // window, the value moved by 100, but basis/yield are lifetime figures and read `unknown` here.
    // The basis arithmetic is covered where a scan CAN reach the deployment block —
    // tests/position-scan.unit.test.ts, "scans from the vault's deployment block".
    const pos = await getPosition({ vault, principal: depositor, client: pub as never, lookbackBlocks: 50n });
    expect(pos.scan.deposits).toBeGreaterThanOrEqual(1);
    expect(Number(pos.usdcValue.split(" ")[0]) - valueBefore).toBeCloseTo(100, 0);
    expect(pos.scan.wholeHistory, "a 50-block window never reaches the deployment block").toBe(false);
    expect(pos.entryBasisUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    expect(pos.accruedYieldUsdc).toBe(UNKNOWN_INCOMPLETE_SCAN);
    if (sharesBefore === 0n) {
      expect(pos.scan.complete, "a fresh depositor's 50-block window reconciles — and that is still not coverage").toBe(true);
    } else {
      expect(pos.scan.complete, "a 50-block window cannot cover a pre-existing position, and must say so").toBe(false);
    }

    // Partial withdrawal in USDC terms — the caller never names a share amount. Quote first: the
    // quote's simulation is the verdict, and the agent must be told BEFORE signing.
    const q50 = await quoteWithdraw({ vault, owner: depositor, assetsHuman: "50", client: pub as never });
    expect(q50.simulated, q50.note).toBe("OK");
    const [w50] = buildWithdraw(vault, { receiver: depositor, owner: depositor, assetsHuman: "50" });
    const wr = await pub.waitForTransactionReceipt({ hash: await sendBuffered(w50!.to, w50!.data, depositor) });
    expect(wr.status, "withdraw 50 USDC").toBe("success");

    // Withdraw everything, using the EXACT share string get_position reports — no floats anywhere.
    const pos2 = await getPosition({ vault, principal: depositor, client: pub as never, lookbackBlocks: 50n });
    const sharesNow = await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
    expect(pos2.sharesExact).toBe(formatUnits(sharesNow, vault.shareDecimals));
    const remaining = formatUnits(await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [sharesNow] }), vault.asset.decimals);
    const qAll = await quoteWithdraw({ vault, owner: depositor, assetsHuman: remaining, client: pub as never });
    const [redeem] = buildWithdraw(vault, { receiver: depositor, owner: depositor, all: true, sharesExact: pos2.sharesExact });

    if (qAll.simulated === "REVERTED") {
      // The skill says the vault cannot pay this out now. Two things must be true: it said WHY in
      // liquidity terms (measured 2026-09-13 on the Fusion vault: 0.80 liquid, 9.21 deployed, no
      // instant-withdrawal fuses, and maxWithdraw() claiming the full amount), and it was RIGHT —
      // sending anyway must revert, or the quote is refusing something the chain would allow.
      expect(qAll.note).toMatch(/liquid against .* requested/);
      expect(Number(qAll.instantLiquidity.split(" ")[0])).toBeLessThan(Number(remaining));
      await expect(pub.estimateGas({ account: depositor, to: redeem!.to, data: redeem!.data })).rejects.toThrow(/exceeds balance|InsufficientBalance/);
      // …and the liquid part IS recoverable through the same calls, which is what the agent is told to do.
      const liquid = qAll.instantLiquidity.split(" ")[0]!;
      const qLiq = await quoteWithdraw({ vault, owner: depositor, assetsHuman: liquid, client: pub as never });
      expect(qLiq.simulated, qLiq.note).toBe("OK");
      const [wLiq] = buildWithdraw(vault, { receiver: depositor, owner: depositor, assetsHuman: liquid });
      const lr = await pub.waitForTransactionReceipt({ hash: await sendBuffered(wLiq!.to, wLiq!.data, depositor) });
      expect(lr.status, `withdraw the liquid ${liquid}`).toBe("success");
      const usdcAfter = await pub.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
      // Recovered: 50 + the liquid amount; the rest is still in the vault, deployed — not lost, not liquid.
      expect(Number(formatUnits(usdcAfter - usdcBefore, 6))).toBeCloseTo(-100 + 50 + Number(liquid), 1);
      return;
    }

    expect(qAll.simulated, qAll.note).toBe("OK");
    const rh = await sendBuffered(redeem!.to, redeem!.data, depositor);
    const rr = await pub.waitForTransactionReceipt({ hash: rh });
    if (rr.status !== "success") {
      let why = "(no revert data)";
      try {
        await pub.call({ account: depositor, to: redeem!.to, data: redeem!.data, blockNumber: rr.blockNumber - 1n });
        why = "re-simulation at prior block SUCCEEDED";
      } catch (e) {
        const obs = extractRevert(e);
        why = obs ? `selector=${obs.selector} reason=${obs.reason ?? ""}` : String(e).slice(0, 300);
      }
      throw new Error(`REDEEM-ALL reverted (${symbol}) tx ${rh} gasUsed ${rr.gasUsed}; shares=${sharesNow}; ${why}`);
    }

    const usdcAfter = await pub.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
    const sharesAfter = await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [depositor] });
    // Rounding on a live share price can leave dust; the round trip must recover essentially all of it.
    // Redeem-all also returns any PRE-EXISTING position, so the loss bound is offset by that value.
    // (Only a LOSS is bounded: a Morpho V2 vault paid a 100-USDC round trip back 100.90 on the fork,
    // 2026-09-13 — a vault-side observation, not a client property to assert here.)
    expect(Number(formatUnits(usdcBefore - usdcAfter, 6)) + valueBefore).toBeLessThan(0.01);
    // Dust bound in the vault's OWN share decimals (1e-6 share): the old literal 10n**12n was 1e-6 of an
    // 18-decimal share and would have accepted 10,000 whole 8-decimal Fusion shares as "dust".
    expect(sharesAfter).toBeLessThan(10n ** BigInt(vault.shareDecimals - 6));
    },
    290_000,
  );

});
