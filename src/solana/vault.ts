/**
 * A Kamino vault on Solana, read and simulated: what the earn commands report for `chain: "solana"`.
 *
 * Every verdict here comes from the chain. Amounts out of a quote, a pre-flight or a position's exit are
 * read from a SIMULATED transaction's post-state — the token balance the user's account would hold after
 * it — never computed from a rule this client restates. That matters on this program in particular:
 * measured on mainnet on 2026-10-11, each `withdraw` INSTRUCTION keeps up to 0.001 USDC in the vault (one
 * instruction: 10,000 base units paid 9,000, 2,000,000 kept 1,000; the same 2,000,000 as two instructions
 * kept 1,929; a two-leg full exit kept 1,000), and one worth 0.001 USDC or less is refused (error 7049). The
 * cause is the vault program's GLOBAL withdrawal penalty — its global config account
 * (BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX) holds `withdrawalPenaltyLamports` = 1000 and
 * `withdrawalPenaltyBps` = 0 — while this vault's own penalty settings read 0. Kamino can change the global
 * value, and how it combines across legs is not a rule this client restates: a simulated quote is exact.
 */
import { address, type Base64EncodedWireTransaction, type Instruction } from "@solana/kit";
import type { SolanaVaultEntry } from "../registry-schema.js";
import { formatAmount, parseAmount } from "../units.js";
import { describeError } from "../redact.js";
import { decodeReserve, decodeVaultState, vaultHoldings, type ReserveView, type VaultHoldings, type VaultStateView } from "./layout.js";
import {
  associatedTokenAccount,
  compileUnsigned,
  DISCRIMINATORS,
  createAtaIdempotentIx,
  depositIx,
  setComputeUnitLimitIx,
  withdrawIx,
  type Lifetime,
  type ReserveAccounts,
  type VaultAccounts,
} from "./kvault.js";
import { DEFAULT_PUBKEY, KVAULT_PROGRAM_ID, MAX_COMPUTE_UNITS, MAX_TRANSACTION_BYTES } from "./constants.js";
import type { SolanaRpc } from "./rpc.js";

/** The vault and every reserve it allocates to, read at (about) one slot. */
export interface VaultRead {
  readonly entry: SolanaVaultEntry;
  readonly state: VaultStateView;
  readonly reserves: ReadonlyMap<string, ReserveView>;
  readonly holdings: VaultHoldings;
  readonly accounts: VaultAccounts;
  readonly slot: bigint;
}

const b64 = (data: readonly [string, string] | unknown): Uint8Array => new Uint8Array(Buffer.from((data as [string, string])[0], "base64"));

/**
 * Reads the vault state and its reserves, and refuses a row the chain disagrees with: the registry's asset,
 * share mint and decimals are claims, and the vault state is the authority over them.
 */
export async function readVault(rpc: SolanaRpc, entry: SolanaVaultEntry): Promise<VaultRead> {
  const first = await rpc.getAccountInfo(address(entry.address), { encoding: "base64" }).send();
  if (!first.value) throw new Error(`no account at ${entry.address} on this cluster — the endpoint is not Solana mainnet, or the registry row is wrong`);
  const state = decodeVaultState(b64(first.value.data));
  const disagree: string[] = [];
  if (state.tokenMint !== entry.asset.address) disagree.push(`asset ${entry.asset.address} != the vault's token mint ${state.tokenMint}`);
  if (state.sharesMint !== entry.sharesMint) disagree.push(`sharesMint ${entry.sharesMint} != the vault's ${state.sharesMint}`);
  if (Number(state.tokenMintDecimals) !== entry.asset.decimals) disagree.push(`asset decimals ${entry.asset.decimals} != ${state.tokenMintDecimals}`);
  if (Number(state.sharesMintDecimals) !== entry.shareDecimals) disagree.push(`shareDecimals ${entry.shareDecimals} != ${state.sharesMintDecimals}`);
  if (disagree.length > 0) throw new Error(`the registry row for ${entry.symbol} disagrees with the chain: ${disagree.join("; ")}`);

  const keys = state.allocations.map((a) => address(a.reserve));
  const res = keys.length === 0 ? { value: [], context: first.context } : await rpc.getMultipleAccounts(keys, { encoding: "base64" }).send();
  const reserves = new Map<string, ReserveView>();
  res.value.forEach((acc, i) => {
    if (!acc) throw new Error(`the vault allocates to reserve ${keys[i]}, which does not exist on this cluster`);
    reserves.set(keys[i]!, decodeReserve(b64(acc.data)));
  });
  return {
    entry,
    state,
    reserves,
    holdings: vaultHoldings(state, reserves),
    accounts: {
      vaultState: entry.address,
      tokenVault: state.tokenVault,
      tokenMint: state.tokenMint,
      baseVaultAuthority: state.baseVaultAuthority,
      sharesMint: state.sharesMint,
      vaultReserves: state.allocations.map((a) => ({ reserve: a.reserve, lendingMarket: reserves.get(a.reserve)!.lendingMarket })),
    },
    slot: BigInt(res.context.slot),
  };
}

/** What one share is worth in the asset, as a decimal string at the asset's precision (stored reserve state). */
export function sharePrice(v: VaultRead): string {
  if (v.state.sharesIssued === 0n) return formatAmount(10n ** BigInt(v.entry.asset.decimals), v.entry.asset.decimals);
  return formatAmount((v.holdings.netAum * 10n ** BigInt(v.entry.shareDecimals)) / v.state.sharesIssued, v.entry.asset.decimals);
}

/** An SPL token account's balance, or 0 when the account does not exist. */
export async function tokenBalance(rpc: SolanaRpc, account: string): Promise<{ exists: boolean; amount: bigint }> {
  const r = await rpc.getAccountInfo(address(account), { encoding: "base64" }).send();
  if (!r.value) return { exists: false, amount: 0n };
  return { exists: true, amount: splAmount(b64(r.value.data)) };
}

/** The `amount` of an SPL token account: a u64 at offset 64. */
function splAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error(`a token account is at least 72 bytes, got ${data.length}`);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/* ─────────────────────────── building ─────────────────────────── */

/**
 * Compute-unit limits. Measured by simulation on mainnet, 2026-10-11, with two funded reserves: a deposit
 * used about 115,000 units; a withdrawal about 144,000 paid from idle, 186,000 when it disinvests from one
 * reserve, and 346,000 for a two-leg exit. The limits (400,000 per leg) leave room and cost nothing unless a
 * priority fee is set.
 */
export const DEPOSIT_COMPUTE_UNITS = 400_000;
export const WITHDRAW_COMPUTE_UNITS_PER_RESERVE = 400_000;

/**
 * Refuses while the vault requires a co-signer. Kamino's program lets a "permissioning authority" be set on a
 * vault, after which it must co-sign every deposit AND every withdrawal; this client builds single-signer
 * transactions only, so it cannot move money in or out while one is set. Unset today; checked on every build.
 */
export function assertNoCoSigner(v: VaultRead): void {
  const refusal = coSignerRefusal(v);
  if (refusal) throw new Error(`refused: ${refusal} Nothing was prepared.`);
}

/** Why the vault refuses this client while a co-signer is set, or `undefined` when none is. */
function coSignerRefusal(v: VaultRead): string | undefined {
  if (v.state.permissioningAuthority === DEFAULT_PUBKEY) return undefined;
  return `${v.entry.symbol} now requires a co-signer (permissioning authority ${v.state.permissioningAuthority}) for every deposit and withdrawal, and this client builds single-signer transactions only.`;
}

/** The deposit: create the user's share account if it is missing, then deposit `amount` base units. */
export async function depositInstructions(v: VaultRead, user: string, amount: bigint): Promise<Instruction[]> {
  assertNoCoSigner(v);
  return [
    setComputeUnitLimitIx(DEPOSIT_COMPUTE_UNITS),
    await createAtaIdempotentIx(user, v.state.sharesMint),
    await depositIx({
      ...v.accounts,
      user,
      userTokenAta: await associatedTokenAccount(user, v.state.tokenMint),
      userSharesAta: await associatedTokenAccount(user, v.state.sharesMint),
      maxAmount: amount,
    }),
  ];
}

function reserveAccounts(v: VaultRead, reserve: string): ReserveAccounts {
  const r = v.reserves.get(reserve)!;
  return { reserve, lendingMarket: r.lendingMarket, liquiditySupplyVault: r.liquiditySupplyVault, collateralMint: r.collateralMint };
}

/**
 * The withdrawal of `shares`: the account's USDC account if it is missing, then one `withdraw` per reserve
 * it needs. Each pays from the vault's idle balance
 * first and then from its named reserve, so the shares are split across reserves in order of what each can
 * release now (the vault's position in it, capped by the reserve's own available liquidity). A vault with no
 * reserves cannot be withdrawn from by this program's instruction, and is refused.
 *
 * ⚠️ The program CAPS a leg that asks for more than it can pay rather than reverting it (measured: a leg
 * oversized by 500,000 shares succeeded, paid the leg's maximum and left the excess shares with the user).
 * So every build path simulates the withdrawal and refuses it unless every share burns, less rounding
 * (`simulateWithdrawal`, `partialWithdrawal`). A reserve's state can still move between that simulation and the send, and then the
 * transaction lands paying less, with no error; `verifySolanaLanded` reports that as a partial withdrawal.
 */
export async function withdrawInstructions(v: VaultRead, user: string, shares: bigint): Promise<Instruction[]> {
  assertNoCoSigner(v);
  if (v.state.allocations.length === 0) throw new Error(`${v.entry.symbol} has no reserve, and a withdrawal names one`);
  if (shares <= 0n) throw new Error("a withdrawal of 0 shares");
  const userTokenAta = await associatedTokenAccount(user, v.state.tokenMint);
  const userSharesAta = await associatedTokenAccount(user, v.state.sharesMint);
  const perShareNum = v.holdings.netAum;
  const perShareDen = v.state.sharesIssued === 0n ? 1n : v.state.sharesIssued;
  const capacity = (reserve: string) => {
    const held = v.holdings.byReserve.get(reserve) ?? 0n;
    const avail = v.reserves.get(reserve)!.totalAvailableAmount;
    return held < avail ? held : avail;
  };
  const order = [...v.state.allocations.map((a) => a.reserve)].sort((a, b) => (capacity(b) > capacity(a) ? 1 : capacity(b) < capacity(a) ? -1 : 0));
  const legs: { reserve: string; shares: bigint }[] = [];
  let left = shares;
  let idle = v.holdings.idle;
  for (const [i, reserve] of order.entries()) {
    if (left === 0n) break;
    const tokens = idle + capacity(reserve);
    const fits = perShareNum === 0n ? left : (tokens * perShareDen) / perShareNum;
    // The last reserve in ORDER takes the rest. Counting the legs pushed so far missed it whenever an earlier
    // reserve could release nothing (no leg pushed), and the rest then became a second leg on order[0].
    const take = i === order.length - 1 || fits >= left ? left : fits;
    if (take > 0n) legs.push({ reserve, shares: take });
    left -= take;
    idle = 0n;
  }
  if (left > 0n) legs.push({ reserve: order[0]!, shares: left });
  // The account's own USDC account must exist for the program to pay into; create it if it does not
  // (idempotent: nothing happens when it exists, which is the usual case for an account that deposited).
  const ixs: Instruction[] = [
    setComputeUnitLimitIx(Math.min(MAX_COMPUTE_UNITS, WITHDRAW_COMPUTE_UNITS_PER_RESERVE * legs.length)),
    await createAtaIdempotentIx(user, v.state.tokenMint),
  ];
  for (const leg of legs) {
    ixs.push(await withdrawIx({ ...v.accounts, user, userTokenAta, userSharesAta, sharesAmount: leg.shares, reserve: reserveAccounts(v, leg.reserve) }));
  }
  return ixs;
}

/* ─────────────────────────── simulation ─────────────────────────── */

export interface Simulated {
  readonly ok: boolean;
  /** The program's error, as the RPC reports it; `null` on success. */
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: bigint | null;
  readonly slot: bigint;
  /** Each watched token account's balance AFTER the transaction, or `null` if it would not exist. */
  readonly after: ReadonlyMap<string, bigint | null>;
}

/**
 * Simulates an unsigned transaction against the RPC's current state. `sigVerify: false` lets the signer slot
 * be any address (nothing is signed); `replaceRecentBlockhash` makes the blockhash irrelevant. READ-ONLY:
 * nothing lands, nothing is paid.
 */
export async function simulate(rpc: SolanaRpc, ixs: readonly Instruction[], feePayer: string, watch: readonly string[]): Promise<Simulated> {
  const tx = compileUnsigned(ixs, feePayer, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n });
  if (tx.bytes > MAX_TRANSACTION_BYTES) throw new Error(`the transaction is ${tx.bytes} bytes, over Solana's ${MAX_TRANSACTION_BYTES}-byte limit`);
  const res = await rpc
    .simulateTransaction(tx.base64 as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { addresses: watch.map((a) => address(a)), encoding: "base64" },
    })
    .send();
  const after = new Map<string, bigint | null>();
  (res.value.accounts ?? []).forEach((acc, i) => after.set(watch[i]!, acc ? splAmount(b64(acc.data)) : null));
  return { ok: res.value.err === null, err: res.value.err, logs: res.value.logs ?? [], unitsConsumed: res.value.unitsConsumed ?? null, slot: BigInt(res.context.slot), after };
}

/**
 * Simulates a withdrawal and reads, from the account's own token accounts, what it would pay and how many shares
 * it would burn. The program caps a leg it cannot pay in full rather than failing it (see `withdrawInstructions`),
 * so `burned` short of the shares asked for means the transaction would land as a partial withdrawal. Both are
 * `undefined` when the simulation fails or the account's USDC account would not exist. `legs` is the number of
 * withdraw instructions.
 */
export async function simulateWithdrawal(rpc: SolanaRpc, v: VaultRead, user: string, ixs: readonly Instruction[]): Promise<{ sim: Simulated; received?: bigint; burned?: bigint; legs: number }> {
  const tokenAta = await associatedTokenAccount(user, v.state.tokenMint);
  const sharesAta = await associatedTokenAccount(user, v.state.sharesMint);
  const [token, held] = await Promise.all([tokenBalance(rpc, tokenAta), tokenBalance(rpc, sharesAta)]);
  const sim = await simulate(rpc, ixs, user, [tokenAta, sharesAta]);
  const legs = ixs.filter((ix) => isWithdrawInstruction(ix.programAddress, ix.data)).length;
  const tokenAfter = sim.after.get(tokenAta);
  if (!sim.ok || tokenAfter === null || tokenAfter === undefined) return { sim, legs };
  return { sim, received: tokenAfter - token.amount, burned: held.amount - (sim.after.get(sharesAta) ?? 0n), legs };
}

/** A kVault withdraw instruction: the program's address and the instruction's discriminator. */
export function isWithdrawInstruction(programAddress: string, data: ArrayLike<number> | undefined): boolean {
  return programAddress === KVAULT_PROGRAM_ID && data !== undefined && DISCRIMINATORS.withdraw.every((x, i) => data[i] === x);
}

/**
 * Why a simulated withdrawal that burns fewer shares than asked for is refused, or `undefined` when it burns them
 * all. Up to one share unit per withdraw instruction is rounding, not a capped leg: the program floors what a
 * leg pays and then ceils the shares that payment burns, which comes out one unit short when a share is worth
 * less than one base unit of the asset. A capped leg falls short by the part its reserve could not pay.
 */
export function partialWithdrawal(asked: bigint, burned: bigint, legs: number, shareDecimals: number, slot: bigint): string | undefined {
  if (burned + BigInt(legs) >= asked) return undefined;
  return `the simulated withdrawal at slot ${slot} burns ${formatAmount(burned, shareDecimals)} of the ${formatAmount(asked, shareDecimals)} shares asked for: a reserve cannot pay its full part now, so it would land as a partial withdrawal. Ask the operator whether to withdraw a smaller amount, or try again later`;
}

/** One line for a failed simulation: the program's error and the last log lines that say why. */
export function describeSimulation(s: Simulated): string {
  const err = JSON.stringify(s.err, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  const why = s.logs.filter((l) => /error|failed|insufficient|exceed|cap|Error Message/i.test(l)).slice(-3);
  return why.length > 0 ? `${err} — ${why.join(" | ")}` : err;
}

/** A fee payer with no SOL, or a transaction it cannot pay for: the account itself cannot send anything yet. */
const NO_FEE_ACCOUNT = /AccountNotFound|InvalidAccountForFee|InsufficientFundsForFee|insufficient lamports/i;
/** The token transfer refused: the account has no USDC account, or less USDC than asked. */
const NO_TOKENS = /insufficient funds|InsufficientFunds|custom program error: 0x1\b|AccountNotInitialized|invalid account data for instruction/i;

export type SolanaPreflightStatus = "OPEN_READY" | "NEEDS_FUNDS" | "REVERTED_OTHER" | "UNRESOLVED";

/** What `earn status --account` and `earn quote --direction deposit` report on Solana. */
export async function preflightDepositSolana(rpc: SolanaRpc, entry: SolanaVaultEntry, account: string, amountHuman: string | undefined) {
  const amount = parseAmount(amountHuman ?? "1", entry.asset.decimals, `deposit amount (${entry.asset.symbol})`);
  const findings: string[] = [];
  let v: VaultRead;
  try {
    v = await readVault(rpc, entry);
  } catch (e) {
    return { vault: entry.symbol, depositor: account, status: "UNRESOLVED" as SolanaPreflightStatus, canDeposit: false, findings: [`vault read failed: ${describeError(e)}`] };
  }
  findings.push(`identity OK at slot ${v.slot}: token mint ${v.state.tokenMint}, share mint ${v.state.sharesMint}, ${v.state.allocations.length} reserve(s)`);
  // A co-signer refuses every deposit this client can build: a verdict about the vault, given in full.
  const coSigner = coSignerRefusal(v);
  if (coSigner) return { vault: entry.symbol, depositor: account, status: "REVERTED_OTHER" as SolanaPreflightStatus, canDeposit: false, findings: [...findings, coSigner] };
  const tokenAta = await associatedTokenAccount(account, v.state.tokenMint);
  const sharesAta = await associatedTokenAccount(account, v.state.sharesMint);
  let held: { exists: boolean; amount: bigint };
  let shares: { exists: boolean; amount: bigint };
  try {
    [held, shares] = await Promise.all([tokenBalance(rpc, tokenAta), tokenBalance(rpc, sharesAta)]);
  } catch (e) {
    return { vault: entry.symbol, depositor: account, status: "UNRESOLVED" as SolanaPreflightStatus, canDeposit: false, findings: [...findings, `balance reads failed: ${describeError(e)}`] };
  }
  const cap = v.state.depositCap;
  const overCap = cap !== 0n && v.holdings.aumIncludingFees + amount > cap;
  if (overCap) {
    findings.push(`the vault's deposit cap is ${formatAmount(cap, entry.asset.decimals)} ${entry.asset.symbol} and it holds ${formatAmount(v.holdings.aumIncludingFees, entry.asset.decimals)}: this deposit would exceed it`);
  }
  if (!held.exists) findings.push(`the account has no ${entry.asset.symbol} token account yet, so it holds no ${entry.asset.symbol} on Solana`);
  else if (held.amount < amount) findings.push(`the account holds ${formatAmount(held.amount, entry.asset.decimals)} ${entry.asset.symbol}, less than the ${formatAmount(amount, entry.asset.decimals)} asked`);

  let sim: Simulated;
  try {
    sim = await simulate(rpc, await depositInstructions(v, account, amount), account, [sharesAta]);
  } catch (e) {
    return { vault: entry.symbol, depositor: account, status: "UNRESOLVED" as SolanaPreflightStatus, canDeposit: false, findings: [...findings, `simulation failed to run: ${describeError(e)}`] };
  }
  const balances = { asset: formatAmount(held.amount, entry.asset.decimals), shares: formatAmount(shares.amount, entry.shareDecimals) };
  const base = { vault: entry.symbol, depositor: account, balances, quotes: { sharePriceInAssets: `${sharePrice(v)} ${entry.asset.symbol} per share` }, measuredAtSlot: Number(sim.slot) };
  if (sim.ok) {
    const minted = (sim.after.get(sharesAta) ?? 0n) - shares.amount;
    findings.push(`simulated deposit succeeds at slot ${sim.slot}: ${formatAmount(minted, entry.shareDecimals)} shares (${sim.unitsConsumed ?? "?"} compute units)`);
    return { ...base, status: "OPEN_READY" as SolanaPreflightStatus, canDeposit: true, expectedSharesRaw: minted, findings };
  }
  const why = describeSimulation(sim);
  const text = `${why} ${sim.logs.join(" ")}`;
  // canDeposit is a yes only when the simulation reached the vault and the vault did not refuse. One that
  // stopped at the fee never reached it, and a deposit over the cap would be refused there once funded.
  if (NO_FEE_ACCOUNT.test(text)) {
    findings.push(
      `the account cannot pay a transaction fee: it holds no SOL (${why}). It needs SOL for the fee and for its share account's rent, about 0.003 SOL in all. The simulation stopped there, before the vault, so whether the vault takes this deposit was not checked`,
    );
    return { ...base, status: "NEEDS_FUNDS" as SolanaPreflightStatus, canDeposit: false, findings };
  }
  if (NO_TOKENS.test(text)) {
    findings.push(
      overCap
        ? `the deposit stopped at the account's own ${entry.asset.symbol} (${why}), and it is over the vault's deposit cap, so the vault would refuse it once funded`
        : `the deposit stopped at the account's own ${entry.asset.symbol} (${why}): the vault did not refuse the account; it needs ${entry.asset.symbol} on Solana`,
    );
    return { ...base, status: "NEEDS_FUNDS" as SolanaPreflightStatus, canDeposit: !overCap, findings };
  }
  findings.push(`simulated deposit reverted: ${why}`);
  return { ...base, status: "REVERTED_OTHER" as SolanaPreflightStatus, canDeposit: false, findings };
}

/** A fresh blockhash: what an unsigned transaction is bound to, and the block height it expires after. */
export async function freshLifetime(rpc: SolanaRpc): Promise<Lifetime & { currentBlockHeight: bigint }> {
  const [{ value }, height] = await Promise.all([rpc.getLatestBlockhash({ commitment: "confirmed" }).send(), rpc.getBlockHeight({ commitment: "confirmed" }).send()]);
  return { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight), currentBlockHeight: BigInt(height) };
}

export { compileUnsigned };
