/**
 * `treasury connect` on Solana: the sign-in and the confirm flow for a vault on Solana. The counterparts of
 * `runConnect` and `runConfirm` in `commands.ts`, on the same one-shot local page and the same rules:
 *
 * - Sign-in: the operator's Solana wallet (a browser wallet, or a Privy wallet from an email or social login)
 *   signs a free sign-in message whose nonce is this flow's secret; the signature is checked here (ed25519).
 * - Confirm: the page asks this process for the transaction when the operator presses Confirm — a Solana
 *   transaction names a blockhash and lands only within about a minute, so it is built then, not when the
 *   page opened — and every transaction built is held to the acknowledged intent by the gate
 *   (`gate-solana.ts`) and simulated before the page receives it. The wallet signs and sends it; this process
 *   then reads the signature's status and the account's token balances.
 *
 * Nothing here signs or sends.
 */
import { getBase58Encoder, getBase64Encoder, getPublicKeyFromAddress, isAddress as isSolanaAddress, verifySignature, type Address, type Signature, type SignatureBytes } from "@solana/kit";
import { solanaRpcUrlFromEnv } from "../client.js";
import type { SolanaVaultEntry } from "../registry-schema.js";
import { redactEndpoints } from "../redact.js";
import { formatAmount } from "../units.js";
import { associatedTokenAccount } from "../solana/kvault.js";
import { makeSolanaRpc, type SolanaRpc } from "../solana/rpc.js";
import { compileUnsigned, depositInstructions, describeSimulation, freshLifetime, isWithdrawInstruction, partialWithdrawal, readVault, simulate, simulateWithdrawal, tokenBalance, withdrawInstructions } from "../solana/vault.js";
import { admitSolana } from "./gate-solana.js";
import { serveOnce, type Settled } from "./http.js";
import type { Session } from "./session.js";
import type { Verdict } from "./verify.js";

export function solanaSignInMessage(a: { address: string; origin: string; nonce: string; issuedAt: string }): string {
  return [
    `${new URL(a.origin).host} wants you to sign in with your Solana account:`,
    a.address,
    "",
    "Connect this wallet to Open Agent Treasury. This signature costs no fee and authorizes no transaction.",
    "",
    `URI: ${a.origin}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${a.nonce}`,
    `Issued At: ${a.issuedAt}`,
  ].join("\n");
}

/** Checks an ed25519 signature (base64) over `message` against the Solana address that claims it. */
export async function verifySolanaSignIn(address: string, message: string, signatureBase64: string): Promise<boolean> {
  try {
    const sig = getBase64Encoder().encode(signatureBase64);
    if (sig.length !== 64) return false;
    const key = await getPublicKeyFromAddress(address as Address);
    return await verifySignature(key, sig as SignatureBytes, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export interface SolanaFlowDeps {
  open: (url: string) => boolean;
  ttlMs: number;
  cancelGraceMs?: number;
  /** The confirm flow's chain reads, injectable for tests. */
  rpc?: SolanaRpc;
  verifyOpts?: { attempts?: number; delayMs?: number };
  /** Run as a plan's leg: a signature already on record for another leg of that plan is never this one's. */
  recordedElsewhere?: (signature: string) => boolean;
  html: (secret: string, title: string) => string;
  csp: string;
  assets: Record<string, { type: string; body: string | Buffer }>;
  ports: readonly number[];
  appId: string;
}

export async function runConnectSolana(deps: SolanaFlowDeps): Promise<{ result: Settled<Session>; url: string; opened: boolean }> {
  const handle = await serveOnce<Session>({
    mode: "connect",
    ttlMs: deps.ttlMs,
    html: (s) => deps.html(s, "Connect to Open Agent Treasury"),
    csp: deps.csp,
    assets: deps.assets,
    ports: deps.ports,
    info: () => ({ mode: "connect", chain: "solana", appId: deps.appId }),
    challengeAddress: (a) => (typeof a === "string" && isSolanaAddress(a) ? a : undefined),
    challenge: (address, origin, nonce) => solanaSignInMessage({ address, origin, nonce, issuedAt: new Date().toISOString() }),
    accept: async (body, ctx) => {
      const address = body["address"];
      if (typeof address !== "string" || !isSolanaAddress(address)) return { ok: false, reason: "not a Solana address" };
      if (!ctx.message || ctx.challengedAddress !== address) return { ok: false, reason: "no sign-in message was issued for this address" };
      const sig = body["signature"];
      if (typeof sig !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return { ok: false, reason: "malformed signature" };
      const walletType = body["walletType"] === "embedded" ? "embedded" : "external";
      if (!(await verifySolanaSignIn(address, ctx.message, sig))) return { ok: false, reason: "the signature does not match the address" };
      return { ok: true, final: true, value: { account: address, walletType, connectedAtIso: new Date().toISOString() } };
    },
  });
  const opened = deps.open(handle.url);
  return { result: await handle.done, url: handle.url, opened };
}

/** What the operator acknowledged: the action, the vault, and its raw amount (base units in, or shares burned). */
export interface SolanaIntent {
  kind: "deposit" | "withdraw";
  vault: SolanaVaultEntry;
  raw: bigint;
  /** A withdrawal by amount: the asset's base units the operator acknowledged (`raw` is the shares worth them). */
  assets?: bigint;
}

export interface SolanaTxOutcome extends Verdict {
  step: 1;
  description: string;
  hash: string;
}

const wellFormedSignature = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s) && getBase58Encoder().encode(s).length === 64;

/** The account's balance of `mint` before and after the transaction, from its own token-balance records. */
function tokenDelta(meta: { preTokenBalances?: readonly TokenBal[] | null; postTokenBalances?: readonly TokenBal[] | null }, owner: string, mint: string): bigint {
  const pick = (list: readonly TokenBal[] | null | undefined) => BigInt(list?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.amount ?? "0");
  return pick(meta.postTokenBalances) - pick(meta.preTokenBalances);
}
type TokenBal = { accountIndex?: number; owner?: string; mint: string; uiTokenAmount: { amount: string } };

/**
 * Every token account of `mint` the transaction touched, from its token-balance records: the account's own net
 * change, and each OTHER owner whose balance rose (money the transaction sent there). `net` is the sum over all
 * of them, 0 when the transaction only moved the asset around. A string says why the records cannot answer.
 */
function assetFlows(meta: { preTokenBalances?: readonly TokenBal[] | null; postTokenBalances?: readonly TokenBal[] | null }, owner: string, mint: string): { own: bigint; rose: { to: string; amountRaw: bigint }[]; net: bigint } | string {
  const pre = (meta.preTokenBalances ?? []).filter((b) => b.mint === mint);
  const post = (meta.postTokenBalances ?? []).filter((b) => b.mint === mint);
  const byIndex = new Map<number, { owner: string | undefined; before: bigint; after?: bigint }>();
  for (const b of pre) {
    if (b.accountIndex === undefined) return "the transaction's token-balance records do not name their accounts";
    byIndex.set(b.accountIndex, { owner: b.owner, before: BigInt(b.uiTokenAmount.amount) });
  }
  for (const b of post) {
    if (b.accountIndex === undefined) return "the transaction's token-balance records do not name their accounts";
    const row = byIndex.get(b.accountIndex);
    byIndex.set(b.accountIndex, { owner: b.owner ?? row?.owner, before: row?.before ?? 0n, after: BigInt(b.uiTokenAmount.amount) });
  }
  let own = 0n;
  let net = 0n;
  const rose: { to: string; amountRaw: bigint }[] = [];
  for (const row of byIndex.values()) {
    if (row.owner === undefined) return "the transaction's token-balance records do not name the owner of every account they list";
    // No record after: the account was closed, which the token program allows only at a balance of 0. One that
    // held the asset before and has no record after is a record missing, not a balance that fell to 0.
    if (row.after === undefined) {
      if (row.before !== 0n) return `the transaction's token-balance records hold no balance after it for an account of ${row.owner} that held ${row.before} base units before`;
      continue;
    }
    const delta = row.after - row.before;
    net += delta;
    if (row.owner === owner) own += delta;
    else if (delta > 0n) rose.push({ to: row.owner, amountRaw: delta });
  }
  return { own, rose, net };
}

/**
 * Did the transaction land, and do the account's own balances say it did what was acknowledged? Read from the
 * signature's status and the transaction's token-balance records — not from the wallet's word, and not from
 * a blockhash-expiry wait: a wallet can report "block height exceeded" for a transaction that in fact landed.
 */
export async function verifySolanaLanded(
  rpc: SolanaRpc,
  signature: string,
  intent: SolanaIntent,
  account: string,
  opts: { attempts?: number; delayMs?: number; deadline: number; built: ReadonlySet<string>; simulated?: ReadonlyMap<string, bigint> },
): Promise<Verdict> {
  const sig = signature as Signature;
  for (let i = 0; i < (opts.attempts ?? 45) && Date.now() < opts.deadline; i++) {
    const st = (await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send()).value[0];
    if (st && st.err) return { verified: "reverted", detail: `the transaction failed on chain: ${JSON.stringify(st.err, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}` };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const tx = await rpc.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
      if (!tx || !tx.meta) return { verified: "unverified", detail: "the signature is confirmed but its transaction could not be read; look it up before retrying anything" };
      const meta = tx.meta as unknown as { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] };
      if (meta.err) return { verified: "reverted", detail: `the transaction failed on chain: ${JSON.stringify(meta.err)}` };
      if (!meta.preTokenBalances || !meta.postTokenBalances) return { verified: "unverified", detail: "the transaction landed, but this RPC returned no token-balance records for it, so what it moved cannot be checked; look it up before retrying anything" };
      // Bound to what this flow built: the page is handed a transaction with a fresh blockhash, recorded in
      // `built`. A signature for any other transaction — an older one of the same shape, or a share transfer
      // — names another blockhash, and its balances say nothing about this deposit or withdrawal.
      const message = (tx as unknown as { transaction?: { message?: { recentBlockhash?: string; accountKeys?: readonly string[]; instructions?: readonly { programIdIndex: number; data: string }[] } } }).transaction?.message;
      if (!message?.recentBlockhash || !opts.built.has(message.recentBlockhash)) {
        return { verified: "mismatch", detail: `${signature} is not the transaction this page built (its blockhash is not one handed to the page); check \`earn balance --chain solana\` before retrying anything` };
      }
      if (message.accountKeys?.[0] !== account) {
        return { verified: "mismatch", detail: `${signature} was paid for by ${message.accountKeys?.[0] ?? "an unknown account"}, not the connected account` };
      }
      const shares = tokenDelta(meta, account, intent.vault.sharesMint);
      const asset = tokenDelta(meta, account, intent.vault.asset.address);
      const a = intent.vault.asset;
      if (intent.kind === "deposit") {
        if (shares <= 0n) return { verified: "mismatch", detail: `the transaction landed but the account received no ${intent.vault.symbol} shares` };
        // The program mints whole share units and takes only the asset that backs them, so it can take less than
        // asked by up to one share unit's worth (measured: 1,999,999 of 2,000,000). Short by more is not this deposit.
        const taken = -asset;
        if (taken < intent.raw && (intent.raw - taken) * shares >= taken + shares) {
          return { verified: "mismatch", detail: `the transaction landed, but the account's ${a.symbol} fell by ${formatAmount(-asset > 0n ? -asset : 0n, a.decimals)} ${a.symbol}, not the ${formatAmount(intent.raw, a.decimals)} ${a.symbol} acknowledged` };
        }
        if (-asset > intent.raw) {
          return { verified: "extra_transfer", detail: `the deposit landed, and the account's ${a.symbol} fell by ${formatAmount(-asset, a.decimals)}, more than the ${formatAmount(intent.raw, a.decimals)} deposited. Tell the operator.`, alsoMoved: [{ to: "unknown", amountRaw: (-asset - intent.raw).toString() }] };
        }
        return { verified: "matched", detail: `received ${formatAmount(shares, intent.vault.shareDecimals)} ${intent.vault.symbol}` };
      }
      // The program pays what a leg can and leaves the rest of the shares with the account, without an error. Up to
      // one share unit per withdraw instruction is rounding, the same allowance the simulation before sending makes.
      const keys = message.accountKeys ?? [];
      const legs = (message.instructions ?? []).filter((ix) => isWithdrawInstruction(keys[ix.programIdIndex] ?? "", getBase58Encoder().encode(ix.data))).length;
      if (-shares > intent.raw || -shares + BigInt(legs) < intent.raw) {
        return { verified: "mismatch", detail: `a PARTIAL withdrawal: it burned ${formatAmount(-shares, intent.vault.shareDecimals)} of the ${formatAmount(intent.raw, intent.vault.shareDecimals)} shares acknowledged and paid ${formatAmount(asset > 0n ? asset : 0n, intent.vault.asset.decimals)} ${intent.vault.asset.symbol}; the rest of the shares are still in the account. Check \`earn balance --chain solana\` before withdrawing again.` };
      }
      // What the vault paid out, from every account of the asset: the account's own rise plus anything the same
      // transaction sent on to another owner. Each such owner is reported, as an outgoing transfer is on EVM.
      const flows = assetFlows(meta, account, a.address);
      if (typeof flows === "string") return { verified: "unverified", detail: `${flows}; look the transaction up before retrying anything` };
      if (flows.net !== 0n) {
        return { verified: "mismatch", detail: `the ${a.symbol} balances in this transaction do not add up: they ${flows.net > 0n ? "rose" : "fell"} by ${formatAmount(flows.net > 0n ? flows.net : -flows.net, a.decimals)} ${a.symbol} in total, which a withdrawal cannot do` };
      }
      const alsoMoved = flows.rose.map((r) => ({ to: r.to, amountRaw: r.amountRaw.toString() }));
      const paid = flows.own + flows.rose.reduce((sum, r) => sum + r.amountRaw, 0n);
      if (paid <= 0n) return { verified: "mismatch", detail: `the shares burned but the account's ${a.symbol} did not rise`, ...(alsoMoved.length ? { alsoMoved } : {}) };
      // A withdrawal by amount pays what was acknowledged, less what Kamino keeps of each withdraw instruction
      // (up to 0.001 of the asset, as the acknowledgement says). The shares were rounded up, so it can pay more.
      const keptPerLeg = 10n ** BigInt(Math.max(a.decimals - 3, 0));
      if (intent.assets !== undefined && paid + keptPerLeg * BigInt(legs) < intent.assets) {
        return { verified: "mismatch", detail: `the withdrawal paid ${formatAmount(paid, a.decimals)} ${a.symbol}, less than the ${formatAmount(intent.assets, a.decimals)} ${a.symbol} acknowledged, by more than the up to ${formatAmount(keptPerLeg, a.decimals)} ${a.symbol} Kamino keeps per withdraw instruction. Tell the operator.`, ...(alsoMoved.length ? { alsoMoved } : {}) };
      }
      // The simulation of exactly this transaction, before it was handed to the wallet. A share's value only accrues
      // between the two, so paying less (beyond rounding) means the vault lost value or the transaction differs.
      const simulated = opts.simulated?.get(message.recentBlockhash);
      if (simulated !== undefined && paid + BigInt(legs) < simulated) {
        return { verified: "mismatch", detail: `the withdrawal paid ${formatAmount(paid, a.decimals)} ${a.symbol}, less than the ${formatAmount(simulated, a.decimals)} ${a.symbol} its simulation before sending paid. Tell the operator.`, ...(alsoMoved.length ? { alsoMoved } : {}) };
      }
      if (alsoMoved.length) {
        return { verified: "extra_transfer", detail: `the withdrawal landed and paid ${formatAmount(paid, a.decimals)} ${a.symbol}, and in the same transaction ${formatAmount(paid - flows.own, a.decimals)} ${a.symbol} of it went to another owner (alsoMoved). That was not part of the withdrawal. Tell the operator. (SOL the transaction moved is not checked, as on EVM.)`, alsoMoved };
      }
      return { verified: "matched", detail: `received ${formatAmount(paid, a.decimals)} ${a.symbol} (SOL the transaction moved is not checked, as on EVM)` };
    }
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 2_000));
  }
  return { verified: "unverified", detail: "no confirmation within the wait; look the signature up before retrying anything" };
}

/** Builds the intent's transaction now, holds it to the intent through the gate, and simulates it. */
export async function buildForIntent(rpc: SolanaRpc, intent: SolanaIntent, account: string): Promise<{ wire: string; expiresAfterBlockHeight: string; blockhash: string; received?: bigint }> {
  const v = await readVault(rpc, intent.vault);
  const ixs = intent.kind === "deposit" ? await depositInstructions(v, account, intent.raw) : await withdrawInstructions(v, account, intent.raw);
  const life = await freshLifetime(rpc);
  const wire = compileUnsigned(ixs, account, life).base64;
  const admitted = await admitSolana(wire, account);
  if (admitted.kind !== intent.kind || admitted.vault.address !== intent.vault.address || admitted.amount !== intent.raw) {
    throw new Error(`refused: the transaction built (${admitted.kind} ${admitted.amount} on ${admitted.vault.symbol}) is not the one acknowledged (${intent.kind} ${intent.raw} on ${intent.vault.symbol})`);
  }
  if (intent.kind === "deposit") {
    const sim = await simulate(rpc, ixs, account, []);
    if (!sim.ok) throw new Error(`the simulated deposit fails at slot ${sim.slot}: ${describeSimulation(sim)}`);
  } else {
    // A leg the program caps would land as a partial withdrawal with no error, so the shares it burns are
    // checked here, before the page opens, rather than only after it lands.
    const { sim, burned, legs, received } = await simulateWithdrawal(rpc, v, account, ixs);
    if (burned === undefined) throw new Error(`the simulated withdraw fails at slot ${sim.slot}: ${describeSimulation(sim)}`);
    const partial = partialWithdrawal(intent.raw, burned, legs, intent.vault.shareDecimals, sim.slot);
    if (partial) throw new Error(`refused: ${partial}`);
    return { wire, expiresAfterBlockHeight: life.lastValidBlockHeight.toString(), blockhash: life.blockhash, ...(received !== undefined ? { received } : {}) };
  }
  return { wire, expiresAfterBlockHeight: life.lastValidBlockHeight.toString(), blockhash: life.blockhash };
}

/** One Solana intent's confirm core: the build at the operator's press, and the verdict on what landed, without the page around it. */
export interface SolanaConfirmCore {
  done: SolanaTxOutcome[];
  stopReason: () => string | undefined;
  info: () => Record<string, unknown>;
  /** Builds the transaction now (a fresh blockhash), held to the intent by the gate and simulated: what the page hands the wallet. */
  build: () => Promise<{ ok: false; reason: string } | { ok: true; reply: Record<string, unknown> }>;
  /** Records the signature, reads what landed, and says whether it matched. */
  accept: (signature: unknown) => Promise<{ ok: false; reason: string } | { ok: true; kind: "finished" | "stop"; reply: Record<string, unknown> }>;
  /** Puts a signature the page could not hand over on record. */
  onReject: (body: Record<string, unknown>) => void;
}

/**
 * The confirm flow on Solana without its page. The caller runs the gate first (`buildForIntent`), before any page
 * opens or leg starts; the transaction the wallet gets is built again at the operator's press (`build`), and only a
 * signature for a transaction built here, for this intent, can verify. `deadline`: when every chain read stops waiting.
 */
export async function prepareConfirmSolana(
  intent: SolanaIntent,
  session: Session,
  rpc: SolanaRpc,
  verifyOpts: SolanaFlowDeps["verifyOpts"],
  deadline: number,
  /** A plan's earlier steps: a signature already on record for one of them is never this step's transaction. */
  recordedElsewhere?: (signature: string) => boolean,
): Promise<SolanaConfirmCore> {
  const account = session.account;
  const done: SolanaTxOutcome[] = [];
  // Every blockhash a transaction handed to the page was built with: the landed one must name one of them.
  const built = new Set<string>();
  // What the simulation of each built withdrawal paid, by its blockhash: the landed one is held to it.
  const simulated = new Map<string, bigint>();
  let stopReason: string | undefined;
  const a = intent.vault.asset;
  const description =
    intent.kind === "deposit"
      ? `Deposit ${formatAmount(intent.raw, a.decimals)} ${a.symbol} into ${intent.vault.name}`
      : `Withdraw: burn ${formatAmount(intent.raw, intent.vault.shareDecimals)} ${intent.vault.symbol} for ${a.symbol}, to this wallet`;
  const balances = await Promise.race([
    (async () => {
      const [held, sol] = await Promise.all([tokenBalance(rpc, await associatedTokenAccount(account, a.address)), rpc.getBalance(account as Address).send()]);
      return { asset: held.amount.toString(), native: sol.value.toString() };
    })().catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000)),
  ]);
  return {
    done,
    stopReason: () => stopReason,
    onReject: (body) => {
      const sig = body["hash"];
      if (!wellFormedSignature(sig) || done.some((t) => t.hash === sig)) return;
      done.push({ step: 1, description, hash: sig, verified: "unverified", detail: "the page reported this transaction but could not hand it over for checking; look it up before retrying anything" });
    },
    info: () => ({
      chain: "solana",
      account,
      walletType: session.walletType,
      chainName: "Solana",
      kind: intent.kind,
      description,
      next: done.length,
      txBase: "https://solscan.io/tx/",
      asset: { symbol: a.symbol, decimals: a.decimals },
      nativeSymbol: "SOL",
      ...(balances ? { balances } : {}),
      ...(intent.kind === "deposit" ? { needs: intent.raw.toString() } : {}),
      vault: { symbol: intent.vault.symbol, name: intent.vault.name, address: intent.vault.address, asset: a.symbol, links: { explorer: `https://solscan.io/account/${intent.vault.address}` } },
    }),
    build: async () => {
      if (done.length > 0) return { ok: false, reason: "the transaction was already sent" };
      try {
        const { received, ...reply } = await buildForIntent(rpc, intent, account);
        built.add(reply.blockhash);
        if (received !== undefined) simulated.set(reply.blockhash, received);
        return { ok: true, reply };
      } catch (e) {
        return { ok: false, reason: redactEndpoints(e instanceof Error ? e.message : String(e)) };
      }
    },
    accept: async (sig) => {
      if (done.length > 0) return { ok: false, reason: "the transaction was already reported" };
      if (!wellFormedSignature(sig)) return { ok: false, reason: "malformed transaction signature" };
      // Two identical steps can be built on the same blockhash, so the blockhash binding alone cannot tell them apart.
      if (recordedElsewhere?.(sig)) {
        const detail = `${sig} is the transaction of an earlier step of this plan, not one built for this step; check \`earn balance --chain solana\` before retrying anything`;
        done.push({ step: 1, description, hash: sig, verified: "mismatch", detail });
        stopReason = `the ${intent.kind} is mismatch: ${detail}`;
        return { ok: true, kind: "stop", reply: { stop: true, verdict: { verified: "mismatch", detail } } };
      }
      const entry: SolanaTxOutcome = { step: 1, description, hash: sig, verified: "unverified", detail: "the flow ended while this transaction was still being checked" };
      done.push(entry);
      let verdict: Verdict;
      try {
        verdict = await verifySolanaLanded(rpc, sig, intent, account, { ...verifyOpts, deadline, built, simulated });
      } catch (e) {
        verdict = { verified: "unverified", detail: `could not check ${sig}: ${redactEndpoints(e instanceof Error ? e.message : String(e))}; look it up before retrying anything` };
      }
      delete entry.detail;
      Object.assign(entry, verdict);
      if (verdict.verified !== "matched" && verdict.verified !== "extra_transfer") {
        stopReason = `the ${intent.kind} is ${verdict.verified}: ${verdict.detail ?? "it did not land as confirmed"}`;
        return { ok: true, kind: "stop", reply: { stop: true, verdict } };
      }
      return { ok: true, kind: "finished", reply: { finished: true, verdict } };
    },
  };
}

export async function runConfirmSolana(intent: SolanaIntent, session: Session, deps: SolanaFlowDeps): Promise<{ result: Settled<SolanaTxOutcome[]>; url: string; opened: boolean; done: SolanaTxOutcome[]; total: number; stopReason?: string }> {
  const rpc = deps.rpc ?? makeSolanaRpc(solanaRpcUrlFromEnv());
  // The gate runs before any page opens, on a transaction built for exactly this intent.
  await buildForIntent(rpc, intent, session.account);
  const core = await prepareConfirmSolana(intent, session, rpc, deps.verifyOpts, Date.now() + deps.ttlMs, deps.recordedElsewhere);
  const { done } = core;
  const handle = await serveOnce<SolanaTxOutcome[]>({
    mode: "confirm",
    ttlMs: deps.ttlMs,
    ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
    timeoutReason: () => (done.length ? `the ${Math.round(deps.ttlMs / 60_000)}-minute limit ran out after the transaction was reported` : `nothing happened in the browser within ${Math.round(deps.ttlMs / 60_000)} minutes`),
    onReject: core.onReject,
    html: (s) => deps.html(s, "Confirm — Open Agent Treasury"),
    csp: deps.csp,
    assets: deps.assets,
    ports: deps.ports,
    info: () => ({ mode: "confirm", appId: deps.appId, ...core.info() }),
    accept: async (body) => {
      // The page asks for the transaction at the moment the operator confirms.
      if (body["build"] === true) {
        const b = await core.build();
        return b.ok ? { ok: true, final: false, reply: b.reply } : b;
      }
      const r = await core.accept(body["hash"]);
      return r.ok ? { ok: true, final: true, value: done, reply: r.reply } : r;
    },
  });
  const opened = deps.open(handle.url);
  const result = await handle.done;
  const stopReason = core.stopReason();
  return { result, url: handle.url, opened, done, total: 1, ...(stopReason ? { stopReason } : {}) };
}
