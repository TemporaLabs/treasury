/**
 * The earn commands on Solana: what `src/earn/commands.ts` answers when the vault is on Solana.
 *
 * The same contracts as on EVM, adapted where Solana differs:
 * - A prepared deposit or withdrawal is ONE unsigned transaction (base64 wire bytes), not a list of calls,
 *   and it EXPIRES: it names a recent blockhash and lands only before `lastValidBlockHeight`, about a minute
 *   later. The envelope says so in structure (`transaction.expiresAfterBlockHeight`), not only in prose.
 * - It is simulated before it is returned. A transaction the program would refuse is not handed to a signer:
 *   the refusal comes back instead, with the program's own reason.
 * - There is no receiver. A Kamino vault mints shares to the signer's own account and pays a withdrawal to the
 *   account that burns the shares, so `--receiver` must be the account, and anything else is refused.
 * - There is no approve step, and no event scan: entry basis and yield are not read on Solana, and say so.
 */
import { isAddress as isSolanaAddress } from "@solana/kit";
import { SOLANA_INFO, solanaRpcSourceForEnv, solanaRpcUrlFromEnv } from "../client.js";
import type { SolanaVaultEntry } from "../registry-schema.js";
import { describeError, redactEndpoints } from "../redact.js";
import { formatAmount, parseAmount } from "../units.js";
import { PACKAGE_VERSION } from "../version.js";
import { loadRegistry } from "../registry.js";
import { MAINNET_GENESIS_HASH } from "../solana/constants.js";
import { associatedTokenAccount, compileUnsigned } from "../solana/kvault.js";
import { makeSolanaRpc, solanaCluster, type SolanaRpc } from "../solana/rpc.js";
import { depositInstructions, describeSimulation, freshLifetime, partialWithdrawal, preflightDepositSolana, readVault, sharePrice, simulate, simulateWithdrawal, tokenBalance, withdrawInstructions, type VaultRead } from "../solana/vault.js";

/** Which chain a Solana response is about: the name a caller passes back, and the cluster a wallet must be on. */
export const onSolana = { chain: SOLANA_INFO.key, chainId: null, cluster: "mainnet-beta", genesisHash: MAINNET_GENESIS_HASH } as const;

/** The explorer page for a Solana account or transaction. */
export const solscan = (kind: "account" | "tx", id: string) => `https://solscan.io/${kind}/${id}`;

/** A Solana address argument, checked here: the CLI's schema accepts either family's address form. */
export function solanaAccount(v: string, what: string): string {
  if (!isSolanaAddress(v)) throw new Error(`${what} must be a Solana address for a vault on Solana; got ${v}`);
  return v;
}

/** Every Solana read goes through one client per command, on the endpoint the environment names. */
function rpcAndCheck(): { rpc: SolanaRpc; source: string } {
  return { rpc: makeSolanaRpc(solanaRpcUrlFromEnv()), source: solanaRpcSourceForEnv().source };
}

/**
 * Runs the reads WHILE asking the endpoint which cluster it is. A devnet or local endpoint answers every
 * read, and the vault's address has no account there, so the reads fail as "no account" — a mismatch is
 * reported INSTEAD, naming the variable, as on EVM.
 */
async function onMainnet<T>(rpc: SolanaRpc, source: string, work: () => Promise<T>): Promise<T> {
  const [cluster, settled] = await Promise.all([
    solanaRpcSourceForEnv().configured ? solanaCluster(rpc) : Promise.resolve("mainnet" as const),
    work().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (cluster === "other") throw new Error(`the endpoint in ${source} is not Solana mainnet-beta (its genesis hash differs). Point ${SOLANA_INFO.rpcEnv[0]} at a mainnet endpoint; until then no Solana read can be trusted.`);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

/** The row `earn vaults` lists for a Solana vault. */
export function solanaVaultRow(v: SolanaVaultEntry) {
  return {
    symbol: v.symbol,
    name: v.name,
    warning: v.warning,
    links: { explorer: solscan("account", v.address) },
    backend: v.backend,
    isDefault: v.isDefault,
    chain: SOLANA_INFO.key,
    chainId: null,
    address: v.address,
    chassis: v.chassis,
    asset: v.asset,
    sharesMint: v.sharesMint,
    shareDecimals: v.shareDecimals,
    depositOpen: v.depositOpen,
    notes: v.notes,
  };
}

/** `earn status` with no account: is the Solana endpoint up, and is it mainnet. Never throws. */
export async function solanaHealth(vault: SolanaVaultEntry, partial: Record<string, unknown>) {
  const src = solanaRpcSourceForEnv();
  const base = {
    mode: "health",
    ...partial,
    server: "treasury",
    version: PACKAGE_VERSION,
    registry: { schemaVersion: loadRegistry().schemaVersion, vaults: loadRegistry().vaults.length + loadRegistry().solanaVaults.length, reconciledAtIso: loadRegistry().reconciledAtIso },
    ...onSolana,
    vault: vault.symbol,
    rpcSource: src.source,
    rpcConfigured: src.configured,
  };
  try {
    const rpc = makeSolanaRpc(solanaRpcUrlFromEnv());
    const [cluster, slot] = await Promise.all([solanaCluster(rpc), rpc.getSlot({ commitment: "confirmed" }).send()]);
    if (cluster === "other") {
      return { ...base, rpc: "wrong_chain", latestSlot: null, reason: `the endpoint in ${src.source} is not Solana mainnet-beta (its genesis hash differs). Point ${SOLANA_INFO.rpcEnv[0]} at a mainnet endpoint.` };
    }
    return { ...base, rpc: "ok", chainVerified: cluster === "mainnet", latestSlot: slot.toString() };
  } catch (e) {
    return { ...base, rpc: "unreachable", latestSlot: null, reason: redactEndpoints(e instanceof Error ? e.message : String(e)) };
  }
}

/** `earn status --account`: the deposit pre-flight. */
export async function solanaPreflight(vault: SolanaVaultEntry, account: string, amountHuman?: string) {
  const { rpc, source } = rpcAndCheck();
  const r = await onMainnet(rpc, source, () => preflightDepositSolana(rpc, vault, solanaAccount(account, "account"), amountHuman));
  const { expectedSharesRaw: _raw, ...rest } = r as typeof r & { expectedSharesRaw?: bigint };
  return rest;
}

/** `earn quote --direction deposit`. */
export async function solanaQuoteDeposit(vault: SolanaVaultEntry, account: string, amountHuman: string) {
  const { rpc, source } = rpcAndCheck();
  const pf = await onMainnet(rpc, source, () => preflightDepositSolana(rpc, vault, solanaAccount(account, "account"), amountHuman));
  const raw = (pf as { expectedSharesRaw?: bigint }).expectedSharesRaw;
  const { expectedSharesRaw: _raw, ...preflight } = pf as typeof pf & { expectedSharesRaw?: bigint };
  return {
    vault: vault.symbol,
    depositor: account,
    amountUsdc: `${amountHuman} ${vault.asset.symbol}`,
    expectedShares: raw === undefined ? "unknown — the simulated deposit did not succeed; see preflight" : `${formatAmount(raw, vault.shareDecimals)} ${vault.symbol}`,
    sharePriceInAssets: (preflight as { quotes?: { sharePriceInAssets: string } }).quotes?.sharePriceInAssets,
    preflight,
    note: "Read from a simulated deposit at the slot shown: the shares the account would receive. This client quotes no rate.",
  };
}

/** Shares for `amountHuman` of the asset, rounded UP so the withdrawal is worth at least the amount asked. */
function sharesFor(v: VaultRead, amountHuman: string): bigint {
  const amount = parseAmount(amountHuman, v.entry.asset.decimals, `withdrawal amount (${v.entry.asset.symbol})`);
  if (amount === 0n) throw new Error("a withdrawal of 0");
  if (v.holdings.netAum === 0n) throw new Error(`${v.entry.symbol} holds nothing to withdraw`);
  return (amount * v.state.sharesIssued + v.holdings.netAum - 1n) / v.holdings.netAum;
}

/** Simulates a withdrawal of `shares` and reads what the account would receive and how many shares it would burn. */
async function simulateWithdraw(rpc: SolanaRpc, v: VaultRead, account: string, shares: bigint) {
  return simulateWithdrawal(rpc, v, account, await withdrawInstructions(v, account, shares));
}

/** `earn quote --direction withdraw`. */
export async function solanaQuoteWithdraw(vault: SolanaVaultEntry, account: string, amountHuman: string) {
  const { rpc, source } = rpcAndCheck();
  return onMainnet(rpc, source, async () => {
    const owner = solanaAccount(account, "account");
    const v = await readVault(rpc, vault);
    const held = await tokenBalance(rpc, await associatedTokenAccount(owner, v.state.sharesMint));
    const shares = sharesFor(v, amountHuman);
    const base = {
      vault: vault.symbol,
      owner,
      amountUsdc: `${amountHuman} ${vault.asset.symbol}`,
      sharesToBurn: `${formatAmount(shares, vault.shareDecimals)} ${vault.symbol}`,
      sharesHeld: `${formatAmount(held.amount, vault.shareDecimals)} ${vault.symbol}`,
      instantLiquidity: `${formatAmount(v.holdings.idle, vault.asset.decimals)} ${vault.asset.symbol}`,
      sharePriceInAssets: `${sharePrice(v)} ${vault.asset.symbol} per share`,
    };
    if (shares > held.amount) {
      return { ...base, canWithdraw: false, note: `the account holds ${formatAmount(held.amount, vault.shareDecimals)} shares, fewer than the ${formatAmount(shares, vault.shareDecimals)} this amount needs` };
    }
    const { sim, received, burned } = await simulateWithdraw(rpc, v, owner, shares);
    if (received === undefined || burned === undefined) return { ...base, canWithdraw: false, measuredAtSlot: Number(sim.slot), note: `the simulated withdrawal failed: ${describeSimulation(sim)}` };
    const partial = partialWithdrawal(shares, burned, vault.shareDecimals, sim.slot);
    if (partial) return { ...base, canWithdraw: false, measuredAtSlot: Number(sim.slot), note: partial };
    return {
      ...base,
      canWithdraw: true,
      receives: `${formatAmount(received, vault.asset.decimals)} ${vault.asset.symbol}`,
      measuredAtSlot: Number(sim.slot),
      note: "simulated withdrawal succeeds at this slot. `receives` is what the account's USDC balance would rise by — net of the up to 0.001 USDC Kamino keeps per withdraw instruction.",
    };
  });
}

/** `earn balance`: shares, value, and what a full exit would pay now. No event scan on Solana. */
export async function solanaBalance(vault: SolanaVaultEntry, account: string) {
  const { rpc, source } = rpcAndCheck();
  return onMainnet(rpc, source, async () => {
    const owner = solanaAccount(account, "account");
    const v = await readVault(rpc, vault);
    const held = await tokenBalance(rpc, await associatedTokenAccount(owner, v.state.sharesMint));
    const value = v.state.sharesIssued === 0n ? 0n : (held.amount * v.holdings.netAum) / v.state.sharesIssued;
    let exit: Record<string, string>;
    if (held.amount === 0n) {
      exit = { exitableNow: `0 ${vault.asset.symbol}`, measuredAs: "no position" };
    } else {
      try {
        const { sim, received } = await simulateWithdraw(rpc, v, owner, held.amount);
        exit =
          received === undefined
            ? { exitableNow: "unknown", measuredAs: "refused", note: `a full withdrawal was refused at this slot: ${describeSimulation(sim)}` }
            : { exitableNow: `${formatAmount(received, vault.asset.decimals)} ${vault.asset.symbol}`, measuredAs: "a simulated full withdrawal", note: "net of the up to 0.001 USDC Kamino keeps per withdraw instruction" };
      } catch (e) {
        exit = { exitableNow: "unknown", measuredAs: "not measured", note: describeError(e) };
      }
    }
    return {
      vault: vault.symbol,
      account: owner,
      sharesExact: formatAmount(held.amount, vault.shareDecimals),
      shares: `${formatAmount(held.amount, vault.shareDecimals)} ${vault.symbol}`,
      usdcValue: `${formatAmount(value, vault.asset.decimals)} ${vault.asset.symbol}`,
      sharePriceInAssets: `${sharePrice(v)} ${vault.asset.symbol} per share`,
      exit: { ...exit, instantLiquidity: `${formatAmount(v.holdings.idle, vault.asset.decimals)} ${vault.asset.symbol}` },
      entryBasisUsdc: "unknown — not read on Solana; see scan.note",
      accruedYieldUsdc: "unknown — not read on Solana; see scan.note",
      scan: {
        complete: false,
        wholeHistory: false,
        note: "On Solana this client reads the position, not its history: entry basis and yield are not derived. The account's own deposit and withdrawal transactions are the record (solscan.io lists them).",
      },
      measuredAtSlot: Number(v.slot),
    };
  });
}

/**
 * What a Solana signer must do for a prepared transaction to land exactly once. Stated with every build,
 * because nothing here signs or sends.
 */
export const SOLANA_SIGNER_RULES = [
  "Sign and send on Solana mainnet-beta only: check the wallet's network before signing.",
  "Send before block height `transaction.expiresAfterBlockHeight` (about a minute after it was prepared). If that height has passed, do not sign: prepare the transaction again.",
  "Before signing, check the fee payer and signer is the account the operator named, and the vault the transaction calls (`vaultAddress`) is the vault named. Do not sign a transaction whose account you did not confirm.",
  "Confirm by the signature's status. If a send fails with no status, read the account's share balance before preparing again: a transaction that did land would be repeated by a new one.",
] as const;

/**
 * The envelope a Solana build returns: one unsigned transaction, its expiry, and what simulating it showed.
 * The deposit warning is NOT attached here: `commitsMoney` in ./commands.ts is the one place that writes it.
 */
async function envelope(rpc: SolanaRpc, v: VaultRead, account: string, kind: "deposit" | "withdraw", simulated: string, ixs: Awaited<ReturnType<typeof depositInstructions>>, expected: string) {
  const life = await freshLifetime(rpc);
  const tx = compileUnsigned(ixs, account, life);
  return {
    requires_signature: true,
    status: "unsigned",
    ...onSolana,
    next_step: `This is ONE Solana transaction, for Solana mainnet-beta: tell the operator which chain. Hand it to the operator's own Solana wallet now — it lands only until block height ${life.lastValidBlockHeight}, about a minute from now — following \`signer_rules\`. Nothing has been submitted; no funds have moved.`,
    signer_rules: SOLANA_SIGNER_RULES,
    vault: v.entry.symbol,
    vaultAddress: v.entry.address,
    account,
    kind,
    expected,
    simulated,
    transaction: {
      encoding: "base64",
      wire: tx.base64,
      bytes: tx.bytes,
      feePayer: account,
      blockhash: life.blockhash,
      preparedAtBlockHeight: life.currentBlockHeight.toString(),
      expiresAfterBlockHeight: life.lastValidBlockHeight.toString(),
    },
  };
}

/** The receiver must be the account: shares and withdrawals go to the signer's own accounts on this program. */
function sameAsAccount(receiver: string, account: string): void {
  if (receiver !== account) {
    throw new Error(
      `on Solana the receiver must be the account itself: a Kamino vault mints shares to the signer's own account and pays a withdrawal to the account whose shares burn. --receiver ${receiver} is not --account ${account}.`,
    );
  }
}

/** `earn prepare_deposit` on Solana. Simulated first; a deposit the program would refuse is not returned. */
export async function solanaPrepareDeposit(vault: SolanaVaultEntry, account: string, amountHuman: string, receiver: string) {
  const user = solanaAccount(account, "account");
  sameAsAccount(solanaAccount(receiver, "receiver"), user);
  const { rpc, source } = rpcAndCheck();
  return onMainnet(rpc, source, async () => {
    const v = await readVault(rpc, vault);
    const amount = parseAmount(amountHuman, vault.asset.decimals, `deposit amount (${vault.asset.symbol})`);
    if (amount === 0n) throw new Error("a deposit of 0");
    const ixs = await depositInstructions(v, user, amount);
    const sharesAta = await associatedTokenAccount(user, v.state.sharesMint);
    const before = await tokenBalance(rpc, sharesAta);
    const sim = await simulate(rpc, ixs, user, [sharesAta]);
    if (!sim.ok) throw new Error(`not prepared: the simulated deposit fails at slot ${sim.slot}: ${describeSimulation(sim)}. Run \`earn status --chain solana --account ${user}\` for the reason in words.`);
    const minted = (sim.after.get(sharesAta) ?? 0n) - before.amount;
    return envelope(rpc, v, user, "deposit", `deposit ${formatAmount(amount, vault.asset.decimals)} ${vault.asset.symbol}; the simulation at slot ${sim.slot} minted ${formatAmount(minted, vault.shareDecimals)} ${vault.symbol}`, ixs, `${formatAmount(minted, vault.shareDecimals)} ${vault.symbol}`);
  });
}

/** `earn prepare_withdraw` on Solana. `all` burns exactly `sharesExact`. Simulated first. */
export async function solanaPrepareWithdraw(vault: SolanaVaultEntry, account: string, receiver: string, args: { amountHuman?: string; sharesExact?: string }) {
  const user = solanaAccount(account, "account");
  sameAsAccount(solanaAccount(receiver, "receiver"), user);
  const { rpc, source } = rpcAndCheck();
  return onMainnet(rpc, source, async () => {
    const v = await readVault(rpc, vault);
    const shares = args.sharesExact !== undefined ? parseAmount(args.sharesExact, vault.shareDecimals, "shares_exact") : sharesFor(v, args.amountHuman!);
    const held = await tokenBalance(rpc, await associatedTokenAccount(user, v.state.sharesMint));
    if (shares > held.amount) throw new Error(`the account holds ${formatAmount(held.amount, vault.shareDecimals)} shares, fewer than the ${formatAmount(shares, vault.shareDecimals)} this withdrawal burns`);
    const ixs = await withdrawInstructions(v, user, shares);
    const { sim, received, burned } = await simulateWithdraw(rpc, v, user, shares);
    if (received === undefined || burned === undefined) throw new Error(`not prepared: the simulated withdrawal fails at slot ${sim.slot}: ${describeSimulation(sim)}`);
    const partial = partialWithdrawal(shares, burned, vault.shareDecimals, sim.slot);
    if (partial) throw new Error(`not prepared: ${partial}`);
    const got = `${formatAmount(received, vault.asset.decimals)} ${vault.asset.symbol}`;
    return envelope(rpc, v, user, "withdraw", `burn ${formatAmount(shares, vault.shareDecimals)} ${vault.symbol}; the simulation at slot ${sim.slot} paid ${got} (net of the up to 0.001 USDC Kamino keeps per withdraw instruction)`, ixs, got);
  });
}
