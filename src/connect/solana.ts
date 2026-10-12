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
import { compileUnsigned, depositInstructions, describeSimulation, freshLifetime, partialWithdrawal, readVault, simulate, simulateWithdrawal, tokenBalance, withdrawInstructions } from "../solana/vault.js";
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
  html: (secret: string, title: string) => string;
  csp: string;
  assets: Record<string, { type: string; body: string | Buffer }>;
  port: number;
  appId: string;
}

export async function runConnectSolana(deps: SolanaFlowDeps): Promise<{ result: Settled<Session>; url: string; opened: boolean }> {
  const handle = await serveOnce<Session>({
    mode: "connect",
    ttlMs: deps.ttlMs,
    html: (s) => deps.html(s, "Connect to Open Agent Treasury"),
    csp: deps.csp,
    assets: deps.assets,
    port: deps.port,
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
type TokenBal = { owner?: string; mint: string; uiTokenAmount: { amount: string } };

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
  opts: { attempts?: number; delayMs?: number; deadline: number; built: ReadonlySet<string> },
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
      // Bound to what this flow built: the page is handed a transaction with a fresh blockhash, recorded in
      // `built`. A signature for any other transaction — an older one of the same shape, or a share transfer
      // — names another blockhash, and its balances say nothing about this deposit or withdrawal.
      const message = (tx as unknown as { transaction?: { message?: { recentBlockhash?: string; accountKeys?: readonly string[] } } }).transaction?.message;
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
        if (-asset < intent.raw) {
          return { verified: "mismatch", detail: `the transaction landed, but the account's ${a.symbol} fell by ${formatAmount(-asset > 0n ? -asset : 0n, a.decimals)} ${a.symbol}, not the ${formatAmount(intent.raw, a.decimals)} ${a.symbol} acknowledged` };
        }
        if (-asset > intent.raw) {
          return { verified: "extra_transfer", detail: `the deposit landed, and the account's ${a.symbol} fell by ${formatAmount(-asset, a.decimals)}, more than the ${formatAmount(intent.raw, a.decimals)} deposited. Tell the operator.`, alsoMoved: [{ to: "unknown", amountRaw: (-asset - intent.raw).toString() }] };
        }
        return { verified: "matched", detail: `received ${formatAmount(shares, intent.vault.shareDecimals)} ${intent.vault.symbol}` };
      }
      if (-shares !== intent.raw) {
        // The program pays what a leg can and leaves the rest of the shares with the account, without an error.
        return { verified: "mismatch", detail: `a PARTIAL withdrawal: it burned ${formatAmount(-shares, intent.vault.shareDecimals)} of the ${formatAmount(intent.raw, intent.vault.shareDecimals)} shares acknowledged and paid ${formatAmount(asset > 0n ? asset : 0n, intent.vault.asset.decimals)} ${intent.vault.asset.symbol}; the rest of the shares are still in the account. Check \`earn balance --chain solana\` before withdrawing again.` };
      }
      if (asset <= 0n) return { verified: "mismatch", detail: `the shares burned but the account's ${a.symbol} did not rise` };
      return { verified: "matched", detail: `received ${formatAmount(asset, a.decimals)} ${a.symbol}` };
    }
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 2_000));
  }
  return { verified: "unverified", detail: "no confirmation within the wait; look the signature up before retrying anything" };
}

/** Builds the intent's transaction now, holds it to the intent through the gate, and simulates it. */
export async function buildForIntent(rpc: SolanaRpc, intent: SolanaIntent, account: string): Promise<{ wire: string; expiresAfterBlockHeight: string; blockhash: string }> {
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
    const { sim, burned, legs } = await simulateWithdrawal(rpc, v, account, ixs);
    if (burned === undefined) throw new Error(`the simulated withdraw fails at slot ${sim.slot}: ${describeSimulation(sim)}`);
    const partial = partialWithdrawal(intent.raw, burned, legs, intent.vault.shareDecimals, sim.slot);
    if (partial) throw new Error(`refused: ${partial}`);
  }
  return { wire, expiresAfterBlockHeight: life.lastValidBlockHeight.toString(), blockhash: life.blockhash };
}

export async function runConfirmSolana(intent: SolanaIntent, session: Session, deps: SolanaFlowDeps): Promise<{ result: Settled<SolanaTxOutcome[]>; url: string; opened: boolean; done: SolanaTxOutcome[]; total: number; stopReason?: string }> {
  const account = session.account;
  const rpc = deps.rpc ?? makeSolanaRpc(solanaRpcUrlFromEnv());
  // The gate runs before any page opens, on a transaction built for exactly this intent.
  await buildForIntent(rpc, intent, account);
  const done: SolanaTxOutcome[] = [];
  // Every blockhash a transaction handed to the page was built with: the landed one must name one of them.
  const built = new Set<string>();
  let stopReason: string | undefined;
  const deadline = Date.now() + deps.ttlMs;
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
  const handle = await serveOnce<SolanaTxOutcome[]>({
    mode: "confirm",
    ttlMs: deps.ttlMs,
    ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
    timeoutReason: () => (done.length ? `the ${Math.round(deps.ttlMs / 60_000)}-minute limit ran out after the transaction was reported` : `nothing happened in the browser within ${Math.round(deps.ttlMs / 60_000)} minutes`),
    onReject: (body) => {
      const sig = body["hash"];
      if (!wellFormedSignature(sig) || done.some((t) => t.hash === sig)) return;
      done.push({ step: 1, description, hash: sig, verified: "unverified", detail: "the page reported this transaction but could not hand it over for checking; look it up before retrying anything" });
    },
    html: (s) => deps.html(s, "Confirm — Open Agent Treasury"),
    csp: deps.csp,
    assets: deps.assets,
    port: deps.port,
    info: () => ({
      mode: "confirm",
      chain: "solana",
      appId: deps.appId,
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
    accept: async (body) => {
      // The page asks for the transaction at the moment the operator confirms.
      if (body["build"] === true) {
        if (done.length > 0) return { ok: false, reason: "the transaction was already sent" };
        try {
          const reply = await buildForIntent(rpc, intent, account);
          built.add(reply.blockhash);
          return { ok: true, final: false, reply };
        } catch (e) {
          return { ok: false, reason: redactEndpoints(e instanceof Error ? e.message : String(e)) };
        }
      }
      const sig = body["hash"];
      if (done.length > 0) return { ok: false, reason: "the transaction was already reported" };
      if (!wellFormedSignature(sig)) return { ok: false, reason: "malformed transaction signature" };
      const entry: SolanaTxOutcome = { step: 1, description, hash: sig, verified: "unverified", detail: "the flow ended while this transaction was still being checked" };
      done.push(entry);
      let verdict: Verdict;
      try {
        verdict = await verifySolanaLanded(rpc, sig, intent, account, { ...deps.verifyOpts, deadline, built });
      } catch (e) {
        verdict = { verified: "unverified", detail: `could not check ${sig}: ${redactEndpoints(e instanceof Error ? e.message : String(e))}; look it up before retrying anything` };
      }
      delete entry.detail;
      Object.assign(entry, verdict);
      if (verdict.verified !== "matched" && verdict.verified !== "extra_transfer") {
        stopReason = `the ${intent.kind} is ${verdict.verified}: ${verdict.detail ?? "it did not land as confirmed"}`;
        return { ok: true, final: true, value: done, reply: { stop: true, verdict } };
      }
      return { ok: true, final: true, value: done, reply: { finished: true, verdict } };
    },
  });
  const opened = deps.open(handle.url);
  const result = await handle.done;
  return { result, url: handle.url, opened, done, total: 1, ...(stopReason ? { stopReason } : {}) };
}
