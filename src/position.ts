import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, parseAbiItem, type Address } from "viem";
import { erc4626Abi } from "./abi/erc4626.js";
import { type VaultEntry } from "./registry-schema.js";
import { describeError } from "./redact.js";
import { formatAmount } from "./units.js";
import type { ReadClient } from "./client.js";

/** ERC-4626's own events — the only durable record of what an account put in and took out. */
const depositEvent = parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)");
const withdrawEvent = parseAbiItem(
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
);

/** The value `entryBasisUsdc` / `accruedYieldUsdc` carry when the event scan failed outright: not a number. */
export const UNKNOWN_AFTER_SCAN_FAILURE = "unknown — event scan failed; see scan.note";

/**
 * What `entryBasisUsdc` / `accruedYieldUsdc` carry when the scan read events but did NOT cover this
 * position's history: shares in − shares out does not reconcile to the balance, so the deposits that
 * produced these shares are outside the window. Reporting the partial sums there renders a position
 * whose deposit was missed as 100% yield (measured in review: 10.011996 USDC of
 * "accrued yield" on a 10 USDC position). A bound nobody can see the bounds of is not a number.
 */
export const UNKNOWN_INCOMPLETE_SCAN = "unknown — the scan did not cover this position's history; see scan.note";

export interface Position {
  vault: string;
  principal: Address;
  /** Shares held, exact, in share units — pass this string back to earn_prepare_withdraw({ all }) unchanged. */
  sharesExact: string;
  shares: string;
  /** What the shares redeem for now (convertToAssets). 🔴 This is what the position is WORTH, not what
   * can be taken out — see `exit`. */
  usdcValue: string;
  /**
   * What a withdrawal would actually pay RIGHT NOW, measured by simulating it rather than by reading
   * the vault's own view. `maxWithdraw()` answers what a holder is ENTITLED to, not what the vault can
   * pay: measured on a live Fusion vault at block 51327076, it reported the full 14.999970
   * USDC position while 1.498874 already reverted — the exit was capped at the vault's 1.498873 USDC
   * idle balance, to the unit.
   */
  exit: {
    /** The largest amount this simulation found payable now, or `"unknown"` when neither attempt resolved. */
    exitableNow: string;
    /** What that number is: the whole position, the vault's liquid balance, or neither. */
    measuredAs: "full position" | "vault's liquid balance" | "nothing to withdraw" | "refused, size unknown" | "not measured";
    /** The vault's own balance of the asset — what it can pay without unwinding, on a chassis that pays from it. */
    instantLiquidity: string;
    /** `maxWithdraw()`, reported because callers see it elsewhere — never as the verdict. */
    maxWithdrawSays: string;
    note: string;
  };
  /** Σ deposited − Σ withdrawn for this owner, from the vault's Deposit/Withdraw events over the scanned window — or `UNKNOWN_AFTER_SCAN_FAILURE` when no events could be read at all. */
  entryBasisUsdc: string;
  /** usdcValue − entryBasis. Negative means withdrawals exceeded deposits inside the window, or the window missed deposits — or `UNKNOWN_AFTER_SCAN_FAILURE`. */
  accruedYieldUsdc: string;
  sharePriceInAssets: string;
  /**
   * `source` names which RPC served the event scan, never its URL: `"logs rpc"` (the configured one)
   * or `"fallback"` (the endpoint `TREASURY_LOGS_FALLBACK` names, Base's public one by default, used
   * when the configured one could not cover the range). 🔴 `complete` is only a RECONCILIATION and is
   * vacuously true for an empty window — `wholeHistory` is the coverage claim, and the note is written
   * from it.
   */
  scan: {
    fromBlock: string;
    toBlock: string;
    deposits: number;
    withdrawals: number;
    complete: boolean;
    capped: boolean;
    providerWindow?: string;
    source: "logs rpc" | "fallback";
    /** `fromBlock` is at or before the vault's deployment block AND the scan reconciles: only then is this the WHOLE history. */
    wholeHistory: boolean;
    note: string;
  };
  measuredAtBlock: number;
}

export interface PositionArgs {
  vault: VaultEntry;
  principal: Address;
  client: ReadClient;
  /**
   * How far back to try to scan for events. Default: from the vault's `deployedAtBlock` (the whole
   * history), or 2,000,000 blocks (~46 days on Base at 2s) for a row that does not record it. The
   * EFFECTIVE window is bounded by `maxLogRequests × the provider's per-request cap`: 100 × 10 = 1,000
   * blocks on Alchemy's free tier, 100 × 2,000 = 200,000 (~4.6 days) on Base's public RPC. A vault
   * older than that needs a provider with a wide eth_getLogs range for a complete history.
   * The result's `scan` block says what was actually covered; `complete` is the reconciliation test.
   */
  lookbackBlocks?: bigint;
  /**
   * Cap on eth_getLogs requests per scan. RPC providers cap the block range per request (measured:
   * Alchemy free tier 10 blocks, Base public RPC 2,000), so a long lookback is walked in chunks and
   * may not reach `lookbackBlocks` — the result says how far it got. Default 100 (per event).
   */
  maxLogRequests?: number;
  /**
   * A second read client for the event scan, used only when `client` cannot cover the range: its
   * eth_getLogs error is one no window can be sized from (measured 2026-09-14: publicnode refuses any
   * range older than ~2,000 blocks with "Archive requests require a personal token"), or its window
   * would need more than `maxLogRequests` requests (Alchemy free tier: 10 blocks). The server passes
   * Base's public endpoint, whose 2,000-block window serves history. Omitted ⇒ no fallback.
   */
  fallbackClient?: ReadClient;
  /**
   * Wall-clock budget for the event walk, milliseconds (default 30,000). A provider-sized walk over a
   * long range is unbounded in time — measured at 40 s on the public endpoint, longer under 429s — and
   * a tool that never returns is worse than one that returns a bounded answer. On expiry the walk stops
   * where it is and the result is `capped`, with the budget named in the note.
   */
  budgetMs?: number;
  /** Wall-clock budget for the two exit simulations, milliseconds (default 12,000). Separate from the scan's. */
  exitBudgetMs?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

type LogEvent = typeof depositEvent | typeof withdrawEvent;

/**
 * Parses the provider's stated maximum range out of its error, e.g. "limited to a 2,000 range" /
 * "up to a 10 block range". `undefined` means the failure is NOT a window refusal — a caller must
 * rethrow rather than narrow, or a dead provider and an empty result become the same answer.
 * Exported for `tests/access.ts`, which walks a different contract's logs and needs the same
 * distinction; NOT re-exported from index.ts.
 */
export function rangeLimitFromError(e: unknown): bigint | undefined {
  const m = String(e).replace(/,/g, "").match(/(?:limited to a|up to a)\s+(\d+)\s*(?:block)?\s*range/i);
  return m ? BigInt(m[1]!) : undefined;
}

async function scanLogs<E extends LogEvent>(
  client: ReadClient,
  address: Address,
  event: E,
  owner: Address,
  from: bigint,
  to: bigint,
  maxRequests: number,
  refuseIfCapped: boolean,
  deadline: number,
  now: () => number,
): Promise<{ logs: Awaited<ReturnType<typeof client.getLogs<E>>>; coveredFrom: bigint; requests: number; capped: boolean; window?: bigint }> {
  const argsFilter = { owner } as never;
  try {
    const logs = await client.getLogs({ address, event, args: argsFilter, fromBlock: from, toBlock: to });
    return { logs, coveredFrom: from, requests: 1, capped: false };
  } catch (e) {
    const window = rangeLimitFromError(e);
    if (!window) throw e;
    // Decide BEFORE walking whether the walk can finish. A walk that would stop short spends
    // `maxRequests` calls to produce a bound; when a fallback exists, hand it the range instead.
    const needed = (to - from + window) / window;
    if (refuseIfCapped && needed > BigInt(maxRequests)) throw new WindowTooNarrow(window, needed);
    // Walk backwards from `to` in provider-sized windows until the lookback is covered or the cap is hit.
    const out: Awaited<ReturnType<typeof client.getLogs<E>>> = [] as never;
    let hi = to;
    let requests = 0;
    while (hi >= from && requests < maxRequests && now() < deadline) {
      const lo = hi - window + 1n > from ? hi - window + 1n : from;
      const chunk = await client.getLogs({ address, event, args: argsFilter, fromBlock: lo, toBlock: hi });
      (out as unknown[]).push(...(chunk as unknown[]));
      requests += 1;
      hi = lo - 1n;
    }
    return { logs: out, coveredFrom: hi + 1n, requests, capped: hi >= from, window };
  }
}

/** The provider's window would need more requests than allowed to cover the range. */
class WindowTooNarrow extends Error {
  constructor(
    readonly window: bigint,
    readonly needed: bigint,
  ) {
    super(`the provider's ${window}-block eth_getLogs window needs ${needed} requests for this range`);
  }
}

type EventLog = { args: { assets?: bigint; shares?: bigint } };
type Scan = { logs: EventLog[]; coveredFrom: bigint; capped: boolean; window: bigint | undefined };

/**
 * Did the CHAIN refuse this, or did the RPC fail to ask it? Every failure used to read as "cannot pay",
 * so one HTTP 502 on the first simulation reported a fully-exitable position as unexitable AND blamed
 * the vault for it (measured through a proxy that failed exactly one call: one attempt made, the vault
 * never asked, `exitableNow: "unknown"`, note "the refusal is the vault's").
 * viem's own error chain separates them: a real revert carries a ContractFunctionRevertedError or an
 * ExecutionRevertedError; a transport failure does not.
 */
function isRevert(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ExecutionRevertedError) !== null;
}

/**
 * At most two simulated withdrawals — the whole position, then the vault's own liquid balance — and the
 * answer is whichever the chain accepts. Simulation rather than arithmetic because the ceiling is
 * chassis-specific: a Fusion vault with no instant-withdrawal fuses pays only from its own balance,
 * while a Morpho V2 vault holds almost none and still pays, out of the markets beneath it. Reading
 * either `maxWithdraw()` or the liquid balance alone gets one of those two wrong.
 *
 * Nothing here is reported as the vault's answer unless the vault answered.
 */
async function measureExit(a: {
  vault: VaultEntry;
  principal: Address;
  client: ReadClient;
  shares: bigint;
  value: bigint;
  deadline: number;
  now: () => number;
}): Promise<Position["exit"]> {
  const { vault, principal, client, shares, value } = a;
  const fmt = (x: bigint) => `${formatAmount(x, vault.asset.decimals)} ${vault.asset.symbol}`;

  // An empty account needs no reads at all — `earn_balance` is the most-called tool.
  if (shares === 0n) {
    return { exitableNow: fmt(0n), measuredAs: "nothing to withdraw", instantLiquidity: "not read", maxWithdrawSays: "not read", note: "the account holds no shares." };
  }

  const read = async (fn: () => Promise<bigint>): Promise<{ value?: bigint; failed: "revert" | "rpc" | undefined }> => {
    try {
      return { value: await fn(), failed: undefined };
    } catch (e) {
      return { failed: isRevert(e) ? "revert" : "rpc" };
    }
  };
  const [liquidRead, maxRead] = await Promise.all([
    read(() => client.readContract({ address: vault.asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [vault.address] }) as Promise<bigint>),
    read(() => client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "maxWithdraw", args: [principal] }) as Promise<bigint>),
  ]);
  const liquid = liquidRead.value;
  const liquidText = liquid === undefined ? (liquidRead.failed === "revert" ? "reverted" : "unavailable — the RPC call failed") : fmt(liquid);
  const maxText =
    maxRead.value === undefined ? (maxRead.failed === "revert" ? "reverted" : "unavailable — the RPC call failed") : fmt(maxRead.value);
  // Only worth saying when the vault actually answered with a number bigger than what can be paid.
  const advisory = maxRead.value !== undefined && maxRead.value > 0n ? ` maxWithdraw() says ${maxText}; that is an entitlement, not an amount the vault can pay.` : "";

  // Shares worth nothing at this share price: a known zero, not a refusal.
  if (value === 0n) {
    return {
      exitableNow: fmt(0n),
      measuredAs: "nothing to withdraw",
      instantLiquidity: liquidText,
      maxWithdrawSays: maxText,
      note: `the account holds ${formatAmount(shares, vault.shareDecimals)} ${vault.symbol}, which converts to nothing at this share price. No withdrawal was simulated.`,
    };
  }

  const attempt = async (assets: bigint): Promise<"paid" | "refused" | "unresolved"> => {
    if (assets === 0n) return "refused";
    if (a.now() >= a.deadline) return "unresolved";
    try {
      await client.simulateContract({ address: vault.address, abi: erc4626Abi, functionName: "withdraw", args: [assets, principal, principal], account: principal });
      return "paid";
    } catch (e) {
      return isRevert(e) ? "refused" : "unresolved";
    }
  };
  const unresolved = (what: string): Position["exit"] => ({
    exitableNow: "unknown",
    measuredAs: "not measured",
    instantLiquidity: liquidText,
    maxWithdrawSays: maxText,
    note: `${what} — this is a failure to ASK the vault, not an answer from it: no conclusion should be drawn about what can be withdrawn.${advisory}`,
  });

  const full = await attempt(value);
  if (full === "paid") {
    return { exitableNow: fmt(value), measuredAs: "full position", instantLiquidity: liquidText, maxWithdrawSays: maxText, note: `a withdrawal of the whole position simulates OK at this block.${advisory}` };
  }
  if (full === "unresolved") return unresolved("the simulation of a full-position withdrawal did not complete");

  // The vault refused the full amount. Probe the liquid bound whenever there is one — including when it
  // is at or above the position, where the refusal has some other cause and the probe is still the
  // cheapest thing that can tell us so.
  if (liquid === undefined) return unresolved("the vault refused a full-position withdrawal and the vault's liquid balance could not be read");
  // When `liquid >= value` the bound IS the position, so this re-asks the same question. Keep it
  // anyway: the two calls are separate requests against "latest", so a second can genuinely
  // succeed where the first reverted — a cooldown clearing, a rate limiter resetting, a new block. What
  // must NOT happen is describing it as something it was not: the note says what was
  // asked, and a success is believed whatever bound produced it.
  const boundedByLiquid = liquid < value;
  const askedFor = boundedByLiquid ? liquid : value;
  const bounded = await attempt(askedFor);
  if (bounded === "paid" && boundedByLiquid) {
    return {
      exitableNow: fmt(liquid),
      measuredAs: "vault's liquid balance",
      instantLiquidity: liquidText,
      maxWithdrawSays: maxText,
      note: `the whole position does NOT come out at this block: this chassis pays withdrawals from the vault's own balance, and the rest is deployed. ${fmt(liquid)} of ${fmt(value)} is payable now; the remainder needs the fund to unwind first.${advisory}`,
    };
  }
  // 🔴 A success is a success whatever bound produced it. The old gate reused the ATTEMPT condition as
  // the TRUST condition, so a second probe that paid was silently discarded and the result then claimed
  // both were refused — false, and reproduced live (liquid 5, value 1, first revert, second paid,
  // reported as "refused, size unknown").
  if (bounded === "paid") {
    return { exitableNow: fmt(value), measuredAs: "full position", instantLiquidity: liquidText, maxWithdrawSays: maxText, note: `a withdrawal of the whole position simulates OK at this block — the first attempt was refused and an identical retry succeeded, which two separate calls against the chain's latest state can legitimately do.${advisory}` };
  }
  if (bounded === "unresolved") return unresolved("the vault refused a full-position withdrawal and the second simulation did not complete");
  return {
    exitableNow: "unknown",
    measuredAs: "refused, size unknown",
    instantLiquidity: liquidText,
    maxWithdrawSays: maxText,
    // Say what was ASKED. When the liquid balance is at or above the position, the second attempt was
    // the same amount as the first, and describing it as "bounded by the liquid balance" names a
    // withdrawal nobody simulated.
    note: `the vault REFUSED ${boundedByLiquid ? `a full-position withdrawal and one bounded by its liquid balance (${liquidText})` : `a full-position withdrawal, twice — its liquid balance (${liquidText}) is at or above the position, so there was no smaller bound to try`} at this block. Both refusals came from the vault, so this is its answer — but it is not a shortfall this client could size.${advisory}`,
  };
}

export async function getPosition(args: PositionArgs): Promise<Position> {
  const { vault, principal, client } = args;
  const lookback = args.lookbackBlocks ?? 2_000_000n;
  const oneShare = 10n ** BigInt(vault.shareDecimals);

  const [block, shares, oneShareInAssets] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [principal] }),
    client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [oneShare] }),
  ]);
  const value =
    shares === 0n
      ? 0n
      : await client.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] });

  const now = args.now ?? Date.now;
  // 🔴 The exit's clock, and the scan's, must not overlap. An earlier revision gave the exit its own 12 s but left
  // the scan's deadline computed HERE, before the exit ran — so the exit still spent the scan's wall
  // clock and the comment claiming otherwise was false (four zero-config runs: exit "not measured" and the
  // scan cut short at 42,000 of 108,533 blocks, four for four). The scan's deadline is taken AFTER the
  // exit returns, below.
  const exitDeadline = now() + (args.exitBudgetMs ?? 12_000);
  const exit = await measureExit({ vault, principal, client, shares, value, deadline: exitDeadline, now });
  const deadline = now() + (args.budgetMs ?? 30_000);

  // The scan starts at the vault's deployment block when the registry records it: a position has no
  // history before its vault existed, so that range is the whole history. An explicit lookback still
  // narrows it (never widens it past deployment).
  const deployed = vault.deployedAtBlock === undefined ? undefined : BigInt(vault.deployedAtBlock);
  const byLookback = block > lookback ? block - lookback : 0n;
  const wanted =
    deployed === undefined ? byLookback : args.lookbackBlocks === undefined ? deployed : byLookback > deployed ? byLookback : deployed;
  const maxReq = args.maxLogRequests ?? 100;
  const fallback = args.fallbackClient;

  // One scan = deposits then withdrawals, SEQUENTIALLY: two concurrent walks double the request rate
  // against a provider that is already the thing rate-limiting us.
  const scanBoth = async (c: ReadClient, refuseIfCapped: boolean): Promise<[Scan, Scan]> => {
    const d = await scanLogs(c, vault.address, depositEvent, principal, wanted, block, maxReq, refuseIfCapped, deadline, now);
    const w = await scanLogs(c, vault.address, withdrawEvent, principal, wanted, block, maxReq, refuseIfCapped, deadline, now);
    return [d as unknown as Scan, w as unknown as Scan];
  };

  // Primary first. It hands over to the fallback on exactly two conditions, both decided by the
  // provider's own answer: an eth_getLogs error no window can be sized from, or a window too narrow to
  // finish inside `maxReq`. Anything else a primary returns is its answer.
  // A provider whose eth_getLogs error wording matches neither phrasing `rangeLimitFromError` knows
  // makes scanLogs re-throw. That must degrade the way a capped scan does — an empty, incomplete
  // window with the reason in the note — not fail the whole position read.
  let scanFailure: string | undefined;
  let source: "logs rpc" | "fallback" = "logs rpc";
  let handover: string | undefined;
  const empty: Scan = { logs: [], coveredFrom: block, capped: true, window: undefined };
  let result: [Scan, Scan];
  try {
    result = await scanBoth(client, fallback !== undefined);
  } catch (primaryError: unknown) {
    if (!fallback) {
      scanFailure = describeError(primaryError);
      result = [empty, empty];
    } else {
      handover = primaryError instanceof WindowTooNarrow ? primaryError.message : `eth_getLogs failed: ${describeError(primaryError, 120)}`;
      try {
        result = await scanBoth(fallback, false);
        // 🔴 Set ONLY once the fallback has RESOLVED. Setting it at handover made a both-failed scan
        // report a source for data nothing served.
        source = "fallback";
      } catch (fallbackError: unknown) {
        scanFailure = `logs rpc: ${handover}; fallback: ${describeError(fallbackError)}`;
        result = [empty, empty];
      }
    }
  }
  const [d, w] = result;
  const deps = d.logs;
  const wds = w.logs;
  const fromBlock = d.coveredFrom > w.coveredFrom ? d.coveredFrom : w.coveredFrom;
  const capped = d.capped || w.capped;
  const timedOut = capped && now() >= deadline;
  const providerWindow = d.window ?? w.window;
  const depositedAssets = deps.reduce((n, l) => n + (l.args.assets ?? 0n), 0n);
  const withdrawnAssets = wds.reduce((n, l) => n + (l.args.assets ?? 0n), 0n);
  const depositedShares = deps.reduce((n, l) => n + (l.args.shares ?? 0n), 0n);
  const withdrawnShares = wds.reduce((n, l) => n + (l.args.shares ?? 0n), 0n);
  const basis = depositedAssets - withdrawnAssets;
  // Completeness check the numbers themselves can make: if the shares in the window do not account
  // for the shares held, the window missed history (or shares were transferred in/out).
  const complete = depositedShares - withdrawnShares === shares;
  // 🔴 `complete` alone is a RECONCILIATION, and it is vacuously true for an empty window on an
  // account with no shares — or, with a short lookback, for a window that saw neither the deposits nor
  // the withdrawals that cancel out. Whole history is a claim about COVERAGE: the scan reached the
  // block the vault was deployed at, nothing was cut short, and the shares reconcile.
  const wholeHistory = deployed !== undefined && fromBlock <= deployed && !capped && complete;
  // 🔴 A LIFETIME FIGURE IS REPORTED ONLY WHEN THE SCAN COVERED THE LIFETIME. Basis and yield
  // are sums over the account's whole history; a window that reconciles is not evidence it saw that
  // history. Measured: a live wallet at lookback 83,000 reported the
  // right basis ONLY because that window happened to catch all thirteen events — which the client
  // cannot know. Every earlier formulation was a special case of this one: `!complete` (an exited
  // account whose window saw the withdrawal but not the deposit printed a NEGATIVE basis),
  // and the empty-window clause (an account that deposited and exited before the window printed a
  // confident "0 USDC"). `!wholeHistory` subsumes both, including the honest zero.
  const basisUnknown = !wholeHistory;

  const fmtA = (x: bigint) => `${formatAmount(x, vault.asset.decimals)} ${vault.asset.symbol}`;
  return {
    vault: vault.symbol,
    principal,
    sharesExact: formatAmount(shares, vault.shareDecimals),
    shares: `${formatAmount(shares, vault.shareDecimals)} ${vault.symbol}`,
    usdcValue: fmtA(value),
    exit,
    // On a scan failure NOTHING was read, so basis and yield are unknown — never 0 and value−0, which
    // would report the whole position as yield while the note says "unknown".
    entryBasisUsdc: scanFailure ? UNKNOWN_AFTER_SCAN_FAILURE : basisUnknown ? UNKNOWN_INCOMPLETE_SCAN : fmtA(basis),
    accruedYieldUsdc: scanFailure ? UNKNOWN_AFTER_SCAN_FAILURE : basisUnknown ? UNKNOWN_INCOMPLETE_SCAN : fmtA(value - basis),
    sharePriceInAssets: `${formatAmount(oneShareInAssets, vault.asset.decimals)} ${vault.asset.symbol} per share`,
    scan: {
      fromBlock: fromBlock.toString(),
      toBlock: block.toString(),
      deposits: deps.length,
      withdrawals: wds.length,
      complete,
      capped,
      ...(providerWindow !== undefined ? { providerWindow: providerWindow.toString() } : {}),
      source,
      wholeHistory,
      note: (handover && !scanFailure ? `the configured logs RPC could not cover this range (${handover}), so the fallback endpoint (TREASURY_LOGS_FALLBACK, Base's public endpoint by default) served the scan. ` : "") + (scanFailure
        ? `event scan FAILED (${scanFailure}): the provider's eth_getLogs error was not one this client can size a window from, so no history was read — basis and yield are unknown, not zero. Set TREASURY_LOGS_RPC_BASE to a provider with a known window (Alchemy, Base public), or use the agent's own deposit receipts.`
        : wholeHistory
          ? "the scan covered every block from the vault's deployment, and shares in − shares out reconciles to the balance: the basis covers this position's whole history"
          : capped
            ? `the scan was CUT SHORT — ${block - fromBlock + 1n} of the ${block - (deployed ?? 0n) + 1n} blocks since deployment, at the provider's ${providerWindow ?? "?"}-block eth_getLogs window and ${timedOut ? `a ${Math.round((args.budgetMs ?? 30_000) / 1000)}s time budget` : `${maxReq} requests`}; covering the rest needs about ${providerWindow ? (block - (deployed ?? 0n) + providerWindow) / providerWindow : BigInt(maxReq)} requests per event. ${complete ? "Shares in − shares out happens to reconcile over that window, which an empty window does vacuously — it is NOT evidence the history was covered." : "Basis and yield are unknown, not bounds."} Set TREASURY_LOGS_RPC_BASE to a provider with a wide eth_getLogs range${timedOut ? "" : ", raise max_log_requests"}, or use the agent's own deposit receipts.`
            : complete
              ? `shares in − shares out reconciles over the ${block - fromBlock + 1n} blocks scanned, but the scan started at block ${fromBlock}${deployed === undefined ? " and the registry does not record when this vault was deployed" : `, after the vault's deployment block ${deployed}`} — deposits and withdrawals before it cancel out unseen, so this is a WINDOW, NOT the whole history. Omit lookback_blocks to scan from deployment.`
              : "shares in − shares out ≠ balance: history predates the window or shares moved by transfer — basis and yield are unknown, not totals"),
    },
    measuredAtBlock: Number(block),
  };
}
