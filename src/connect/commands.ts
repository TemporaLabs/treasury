/**
 * Agent Treasury — the connect commands, run by `src/cli.ts` as `treasury connect <command>`.
 *
 *   connect_status      which account is connected, if any
 *   connect_wallet      open the sign-in page; the operator connects a browser wallet, or signs in
 *                       with email / Google / Apple / X and gets a Privy embedded wallet
 *   connect_deposit     build a deposit and admit it through the gate; without --ack, return the
 *                       operator's acknowledgement (`ack.ts`) and open nothing; with the code, hand
 *                       each call to the connected wallet through the confirm page
 *   connect_withdraw    the same for a withdrawal
 *   connect_disconnect  forget the connected account
 *
 * Nothing here signs. The page asks the operator's own wallet (an extension, or Privy's embedded
 * wallet with its own confirmation dialog) to send each call, after the operator has read it; this
 * process only checks what landed (`verify.ts`). Both sign-in paths prove the account the same way:
 * the wallet signs a free sign-in message whose nonce is this flow's secret, checked here.
 */
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { z } from "zod";
import { buildDeposit, buildWithdraw, type UnsignedCall } from "../build.js";
import { CHAIN_INFO, chains, makePublicClient, rpcUrlFromEnv, isSupportedChainId } from "../client.js";
import { erc4626Abi } from "../abi/erc4626.js";
import type { Command } from "../earn/commands.js";
import { explorerTxUrl, linksFor } from "../links.js";
import { redactEndpoints } from "../redact.js";
import { resolveAnyVault, resolveVault } from "../registry.js";
import { isAddress as isSolanaAddress } from "@solana/kit";
import type { SolanaVaultEntry } from "../registry-schema.js";
import { parseAmount, formatAmount } from "../units.js";
import { makeSolanaRpc, type SolanaRpc } from "../solana/rpc.js";
import { readVault, tokenBalance } from "../solana/vault.js";
import { associatedTokenAccount } from "../solana/kvault.js";
import { solanaRpcUrlFromEnv } from "../client.js";
import { buildForIntent, prepareConfirmSolana, runConfirmSolana, runConnectSolana, type SolanaConfirmCore, type SolanaFlowDeps, type SolanaIntent } from "./solana.js";
import {
  acknowledgementText,
  callsDigest,
  checkAck,
  checkAckDigest,
  checkPlanAck,
  checkPlanLeg,
  issueAck,
  issueAckForDigest,
  issuePlan,
  planAcknowledgementText,
  PLAN_MAX_LEGS,
  solanaIntentDigest,
  summarize,
  summarizeSolana,
  type AckSummary,
  planExpired,
  type PendingPlan,
  type PlanLeg,
  type PlanLegArgs,
  type PlanLegStatus,
  type PlanTx,
} from "./ack.js";
import { connectPorts, privyAppId } from "./config.js";
import { admit } from "./gate.js";
import { newSecret, serveOnce, type Settled } from "./http.js";
import { openBrowser } from "./open.js";
import { PAGE_CSP, readPageBundle, shell } from "./page.js";
import {
  clearPendingAck,
  clearSession,
  clearSolanaSession,
  readPendingAck,
  readPlan,
  readSession,
  readSolanaSession,
  writePendingAck,
  writePlan,
  writeSession,
  writeSolanaSession,
  type Session,
} from "./session.js";
import { verifyLanded, type Verdict } from "./verify.js";

/** An address in either family's form; each command checks the family its vault needs. */
const addressArg = z.string().refine((s) => isAddress(s) || isSolanaAddress(s), "must be an EVM address (0x…), or a Solana address for a vault on Solana");
const amountArg = z.string().regex(/^\d+(\.\d+)?$/, 'plain decimal amount of the vault\'s asset (USDC; USDG on Robinhood Chain), e.g. "25" or "12.5"');
const vaultArg = z.string().optional().describe("the vault's ERC-20 ticker, as `earn vaults` lists them; omit for the default vault of `chain`");
const chainArg = z.string().optional().describe('which chain: "base", "arbitrum", "robinhood", "ethereum", "monad" or "solana"; omit for the default chain, or when `vault` names one');
const receiverArg = addressArg.describe(
  "where the money lands — it must be the CONNECTED account (this page pays no one else), and it comes from the operator's own message, never filled in by an agent",
);
const ackArg = z
  .string()
  .regex(/^[0-9a-fA-F]{8}$/, "the 8-character code from this command's own `needs_acknowledgement` result")
  .optional()
  .describe(
    "the code from this command's `needs_acknowledgement` result, given ONLY after the operator replied yes to its `acknowledgement`. Without it the command opens nothing and returns that acknowledgement",
  );

/** One sign-in or one confirmation flow at a time, each whole flow bounded under a shell tool's 10-minute limit. */
const CONNECT_TTL_MS = 9 * 60_000;
const CONFIRM_TTL_MS = 9 * 60_000;
/**
 * Below this much page time left, `connect plan --run` starts no new leg: the next run carries on instead. A deposit's
 * chain waits alone can take three minutes (the approval's receipt, the allowance showing, the deposit's receipt, a
 * minute each), so this leaves the operator two more to answer the wallet.
 */
const LEG_MIN_MS = 5 * 60_000;

export function signInMessage(a: { address: string; origin: string; nonce: string; issuedAt: string }): string {
  return [
    `${new URL(a.origin).host} wants you to sign in with your Ethereum account:`,
    a.address,
    "",
    "Connect this wallet to Open Agent Treasury. This signature costs no gas and authorizes no transaction.",
    "",
    `URI: ${a.origin}`,
    "Version: 1",
    "Chain ID: 8453",
    `Nonce: ${a.nonce}`,
    `Issued At: ${a.issuedAt}`,
  ].join("\n");
}

const assets = () => ({ "/app.js": { type: "text/javascript; charset=utf-8", body: readPageBundle() } });

/** Opens the page, or says where it is when no browser could be opened from here. */
function announce(url: string): boolean {
  const opened = openBrowser(url);
  process.stderr.write(`${opened ? "Opened" : "Open this page in a browser on this machine"}: ${url}\n`);
  return opened;
}

export interface ConnectDeps {
  verifySignature?: (a: { address: Address; message: string; signature: Hex }) => Promise<boolean>;
  open?: (url: string) => boolean;
  /** The confirm flow's chain reads (receipts, allowance, balances), injectable for tests. */
  client?: (chainId: number) => Pick<ReturnType<typeof makePublicClient>, "getTransactionReceipt" | "readContract"> & Partial<Pick<ReturnType<typeof makePublicClient>, "getBalance" | "getBlockNumber">>;
  verifyOpts?: { attempts?: number; delayMs?: number };
  /** Overrides the flow's time limit and the cancel grace period (tests). */
  ttlMs?: number;
  cancelGraceMs?: number;
  /** How long the balance read may hold the page back before it opens without balances (tests). */
  balanceTimeoutMs?: number;
  /** The clock acknowledgements are issued and checked against (tests). */
  now?: () => Date;
  /** The Solana flows' chain reads (tests). */
  solanaRpc?: SolanaFlowDeps["rpc"];
  /** Overrides the page time `connect plan --run` keeps back before starting a leg (tests). */
  legMinMs?: number;
}

export async function runConnect(deps: ConnectDeps = {}): Promise<{ result: Settled<Session>; url: string; opened: boolean }> {
  // An ordinary wallet's signature is checked offline. A smart-contract wallet (a Coinbase smart
  // wallet, for one) has no key of its own to recover, so its signature is checked by asking the
  // wallet's contract on Base (ERC-1271 / ERC-6492) — the fallback, and only when the first fails.
  const verify =
    deps.verifySignature ??
    (async (a) => {
      if (await verifyMessage(a).catch(() => false)) return true;
      return makePublicClient(8453, rpcUrlFromEnv(8453))
        .verifyMessage(a)
        .catch(() => false);
    });
  const handle = await serveOnce<Session>({
    mode: "connect",
    ttlMs: deps.ttlMs ?? CONNECT_TTL_MS,
    html: (s) => shell(s, "Connect to Open Agent Treasury"),
    csp: PAGE_CSP,
    assets: assets(),
    ports: connectPorts(),
    info: () => ({ mode: "connect", appId: privyAppId() }),
    challenge: (address, origin, nonce) => signInMessage({ address, origin, nonce, issuedAt: new Date().toISOString() }),
    accept: async (body, ctx) => {
      const a = body["address"];
      if (typeof a !== "string" || !isAddress(a)) return { ok: false, reason: "not an address" };
      const address = getAddress(a);
      if (!ctx.message || ctx.challengedAddress !== address) return { ok: false, reason: "no sign-in message was issued for this address" };
      const sig = body["signature"];
      if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) return { ok: false, reason: "malformed signature" };
      const walletType = body["walletType"] === "embedded" ? "embedded" : "external";
      if (!(await verify({ address, message: ctx.message, signature: sig as Hex }))) return { ok: false, reason: "the signature does not match the address" };
      return { ok: true, final: true, value: { account: address, walletType, connectedAtIso: new Date().toISOString() } };
    },
  });
  const opened = (deps.open ?? announce)(handle.url);
  const result = await handle.done;
  if (result.ok) writeSession(result.value);
  return { result, url: handle.url, opened };
}

interface TxOutcome extends Verdict {
  step: number;
  description: string;
  hash: string;
}

/** One leg's confirm core: the gate, the chain reads, and the step-by-step verdicts, without the page around it. */
export interface ConfirmCore {
  chainId: number;
  calls: UnsignedCall[];
  done: TxOutcome[];
  stopReason: () => string | undefined;
  info: () => Record<string, unknown>;
  /** Records the hash for step `index`, reads its receipt, and says whether the next step may go. */
  accept: (index: unknown, hash: unknown) => Promise<{ ok: false; reason: string } | { ok: true; kind: "next" | "finished" | "stop"; reply: Record<string, unknown> }>;
  /** Puts a hash the page could not hand over on record, against the step it names. */
  onReject: (body: Record<string, unknown>) => void;
}

/**
 * The confirm flow without its page: the gate runs here, on exactly the calls the page will hand the
 * wallet, so no caller can pass a check for one batch and the calls of another. It throws before any
 * page opens. `deadline`: when the page closes, so every chain read stops waiting by then.
 */
export async function prepareConfirm(calls: UnsignedCall[], session: Session, deps: ConnectDeps, deadline: number): Promise<ConfirmCore> {
  const admitted = admit(calls, session.account as Address);
  const chainId = calls[0]!.chainId;
  if (!isSupportedChainId(chainId)) throw new Error(`chain ${chainId} unsupported`);
  const account = session.account as Address;
  const client = deps.client ? deps.client(chainId) : makePublicClient(chainId, rpcUrlFromEnv(chainId));
  const done: TxOutcome[] = [];
  let stopReason: string | undefined;
  // The chain head when the flow starts: a receipt mined in it or before it cannot be from this flow.
  // Read beside the balances below; a read that fails or is slow leaves no floor, never blocks the flow.
  const notBeforeRead = client.getBlockNumber
    ? Promise.race([client.getBlockNumber().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), deps.balanceTimeoutMs ?? 5_000))])
    : Promise.resolve(undefined);
  const wellFormedHash = (h: unknown): h is string => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
  const known = (h: string) => done.some((t) => t.hash.toLowerCase() === h.toLowerCase());

  /**
   * A deposit's allowance must be visible on our RPC before the page may send it. What to read is
   * derived from the admitted calls (the approval's token, the account, the vault, the deposit's
   * own amount), never from the call's `precondition` field, which the gate does not check.
   */
  const allowanceVisible = async (index: number): Promise<boolean> => {
    const a = admitted[index]!;
    if (a.kind !== "deposit" || admitted[index - 1]?.kind !== "approve") return true;
    for (let i = 0; i < (deps.verifyOpts?.attempts ?? 30) && Date.now() < deadline; i++) {
      try {
        const v = (await client.readContract({ address: a.vault.asset.address, abi: erc4626Abi, functionName: "allowance", args: [account, a.vault.address] })) as bigint;
        if (v >= a.amount) return true;
      } catch {
        // a failed read is retried, never read as "insufficient"
      }
      await new Promise((r) => setTimeout(r, deps.verifyOpts?.delayMs ?? 2_000));
    }
    return false;
  };

  // What the wallet holds, for the page to warn before a send that cannot pay (a new Privy wallet
  // starts empty). Read once, briefly; a read that fails or is slow leaves it out, never blocks.
  const asset = admitted[0]!.vault.asset;
  const readBalances = async () => {
    const [held, native] = await Promise.all([
      client.readContract({ address: asset.address, abi: erc4626Abi, functionName: "balanceOf", args: [account] }) as Promise<bigint>,
      client.getBalance ? client.getBalance({ address: account }) : Promise.resolve(undefined),
    ]);
    return { asset: held.toString(), ...(native !== undefined ? { native: native.toString() } : {}) };
  };
  const [balances, notBefore] = await Promise.all([
    Promise.race([readBalances().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), deps.balanceTimeoutMs ?? 5_000))]),
    notBeforeRead,
  ]);
  const verifyOpts = { ...deps.verifyOpts, deadline, ...(notBefore !== undefined ? { notBefore } : {}) };
  const deposit = admitted.find((a) => a.kind === "deposit");

  return {
    chainId,
    calls,
    done,
    stopReason: () => stopReason,
    info: () => ({
      account,
      walletType: session.walletType,
      chainId,
      chainName: CHAIN_INFO[chainId].name,
      next: done.length,
      txBase: explorerTxUrl(chainId, ""),
      asset: { symbol: asset.symbol, decimals: asset.decimals },
      nativeSymbol: chains[chainId].nativeCurrency.symbol,
      ...(balances ? { balances } : {}),
      ...(deposit ? { needs: deposit.amount.toString() } : {}),
      calls: calls.map((c, i) => ({
        step: c.step,
        of: c.of,
        kind: admitted[i]!.kind,
        description: c.description,
        to: c.to,
        data: c.data,
        value: c.value,
        vault: { symbol: admitted[i]!.vault.symbol, name: admitted[i]!.vault.name, address: admitted[i]!.vault.address, asset: admitted[i]!.vault.asset.symbol, assetAddress: admitted[i]!.vault.asset.address, links: linksFor(admitted[i]!.vault) },
      })),
    }),
    // The page reports a hash it could not hand over (its POST failed after the wallet sent):
    // put it on record, against the step the page names, so the command reports it unchecked
    // instead of losing it. A hash that names no step is still recorded, as such.
    onReject: (body) => {
      const hash = body["hash"];
      if (!wellFormedHash(hash) || known(hash)) return;
      const i = body["index"];
      const call = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < calls.length ? calls[i] : undefined;
      done.push({
        step: call?.step ?? 0,
        description: call?.description ?? "a transaction the page reported for no known step",
        hash,
        verified: "unverified",
        detail: "the page reported this transaction but could not hand it over for checking; look it up before retrying anything",
      });
    },
    accept: async (index, hash) => {
      if (index !== done.length) return { ok: false, reason: `expected step ${done.length + 1}` };
      if (!wellFormedHash(hash)) return { ok: false, reason: "malformed transaction hash" };
      const call = calls[index]!;
      if (known(hash)) return { ok: false, reason: "this transaction hash was already reported for an earlier step" };
      // The hash is on record before the receipt is read: whatever ends the flow from here on, the
      // command reports this transaction and never says nothing was sent.
      const entry: TxOutcome = { step: call.step, description: call.description, hash, verified: "unverified", detail: "the flow ended while this transaction was still being checked" };
      done.push(entry);
      let verdict: Verdict;
      try {
        verdict = await verifyLanded(client, hash as Hex, admitted[index]!, account, verifyOpts);
      } catch (e) {
        // A receipt that cannot be read is a stop, never a step skipped.
        verdict = { verified: "unverified", detail: `could not check ${hash}: ${redactEndpoints(e instanceof Error ? e.message : String(e))}; look it up before retrying anything` };
      }
      // The verdict replaces the placeholder: a `matched` verdict carries no `detail`, and merging
      // would leave "still being checked" on a transaction that landed.
      delete entry.detail;
      Object.assign(entry, verdict);
      if (verdict.verified !== "matched" && verdict.verified !== "extra_transfer") {
        // Stop at the first step that did not land as confirmed: the next one depends on it.
        stopReason = `step ${call.step} (${call.description}) is ${verdict.verified}: ${verdict.detail ?? "it did not land as confirmed"}`;
        return { ok: true, kind: "stop", reply: { stop: true, verdict } };
      }
      if (index + 1 === calls.length) return { ok: true, kind: "finished", reply: { finished: true, verdict } };
      if (!(await allowanceVisible(index + 1))) {
        stopReason = "the approval landed, but its allowance is not visible on this RPC yet; the deposit was not sent";
        return { ok: true, kind: "stop", reply: { stop: true, reason: stopReason } };
      }
      return { ok: true, kind: "next", reply: { next: index + 1, verdict } };
    },
  };
}

export async function runConfirm(
  calls: UnsignedCall[],
  session: Session,
  deps: ConnectDeps = {},
): Promise<{ result: Settled<TxOutcome[]>; url: string; opened: boolean; done: TxOutcome[]; total: number; stopReason?: string }> {
  const ttlMs = deps.ttlMs ?? CONFIRM_TTL_MS;
  const core = await prepareConfirm(calls, session, deps, Date.now() + ttlMs);
  const { done } = core;
  const handle = await serveOnce<TxOutcome[]>({
    mode: "confirm",
    ttlMs,
    ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
    timeoutReason: () =>
      done.length
        ? `the ${Math.round(ttlMs / 60_000)}-minute limit ran out after ${done.length} of ${calls.length} transactions were reported`
        : `nothing happened in the browser within ${Math.round(ttlMs / 60_000)} minutes`,
    onReject: core.onReject,
    html: (s) => shell(s, "Confirm — Open Agent Treasury"),
    csp: PAGE_CSP,
    assets: assets(),
    ports: connectPorts(),
    info: () => ({ mode: "confirm", appId: privyAppId(), ...core.info() }),
    accept: async (body) => {
      const r = await core.accept(body["index"], body["hash"]);
      if (!r.ok) return r;
      return r.kind === "next" ? { ok: true, final: false, reply: r.reply } : { ok: true, final: true, value: done, reply: r.reply };
    },
  });
  const opened = (deps.open ?? announce)(handle.url);
  const result = await handle.done;
  const stopReason = core.stopReason();
  return { result, url: handle.url, opened, done, total: calls.length, ...(stopReason ? { stopReason } : {}) };
}

const notConnected = () => new Error("no wallet is connected — run `treasury connect wallet` first, and let the operator sign in");

export function outcome(chainId: number, account: string, r: { result: Settled<TxOutcome[]>; opened: boolean; done: TxOutcome[]; total: number; stopReason?: string }) {
  const txs = r.result.ok ? r.result.value : r.done;
  // Completed means every call of the flow landed, never only the ones that were reached.
  const all = txs.length === r.total && txs.every((t) => t.verified === "matched" || t.verified === "extra_transfer");
  const status = r.result.ok ? (all ? "completed" : "stopped") : txs.length ? "stopped" : "not_reported";
  // A stopped flow always says why, even when no single step reported a reason.
  const reason = (r.result.ok ? r.stopReason : r.result.reason) ?? (status === "stopped" ? `the flow ended after ${txs.length} of ${r.total} transactions` : undefined);
  return JSON.stringify(
    {
      status,
      chain: CHAIN_INFO[chainId as 8453].key,
      chainId,
      account,
      opened: r.opened,
      ...(reason ? { reason } : {}),
      calls_total: r.total,
      txs,
      next_step:
        status === "completed"
          ? "Every call landed as confirmed. Report each hash to the operator; any `extra_transfer` is money the wallet moved besides the call — say so."
          : status === "stopped"
            ? "Stopped before every call landed. Do not retry blindly: read `reason` and the last transaction's `verified` and `detail`, check the account with `earn balance`, and tell the operator."
            : "No transaction was reported to this command. That is not proof that none was sent: if the wallet showed a confirmation, check the account with `earn balance` before any retry. Tell the operator why (reason).",
    },
    null,
    2,
  );
}

export function buildConnectCommands(deps: ConnectDeps = {}): Record<string, Command> {
  const commands: Record<string, Command> = {};
  const register = <S extends z.ZodRawShape>(name: string, meta: { title: string; description: string; inputSchema: S }, handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>) => {
    commands[name] = {
      ...meta,
      inputSchema: z.object(meta.inputSchema),
      handler: (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return await handler(args);
        } catch (e) {
          throw new Error(redactEndpoints(e instanceof Error ? e.message : String(e)));
        }
      }) as Command["handler"],
    };
  };

  register(
    "connect_status",
    {
      title: "Which wallet is connected",
      description:
        "The connected account and how it signed in (`external` browser wallet, or `embedded` Privy wallet from an email or social login), or `disconnected`. `solana` reports the connected Solana account the same way: EVM and Solana each have their own connection. Reads local files only.",
      inputSchema: {},
    },
    async () => {
      const s = readSession();
      const sol = readSolanaSession();
      return JSON.stringify(
        {
          ...(s ? { status: "connected", ...s } : { status: "disconnected", next_step: "run `treasury connect wallet` to let the operator sign in" }),
          solana: sol ? { status: "connected", ...sol } : { status: "disconnected", next_step: "run `treasury connect wallet --chain solana` for a vault on Solana" },
        },
        null,
        2,
      );
    },
  );

  register(
    "connect_wallet",
    {
      title: "Connect a wallet",
      description:
        "Opens the sign-in page in the operator's browser: one Connect button, then Privy's window with email, Google, Apple, X and browser wallets (MetaMask, Rabby, Coinbase Wallet). The operator signs a free sign-in message; nothing is spent. Waits until they finish (up to 9 minutes) and returns the connected account. Replaces any earlier connection. With --chain solana it connects a SOLANA wallet instead (Phantom, Solflare, Backpack, or a Privy wallet from an email or social login), for vaults on Solana; the EVM connection is kept.",
      inputSchema: { chain: z.string().optional().describe('"solana" to connect a Solana wallet; omit for an EVM wallet') },
    },
    async ({ chain }) => {
      if (chain !== undefined && chain !== "" && chain !== "solana") throw new Error(`--chain takes "solana" (a Solana wallet) or nothing (an EVM wallet, used on every EVM chain); got "${chain}"`);
      if (chain === "solana") {
        const r = await runConnectSolana(solanaDeps());
        if (!r.result.ok) return Promise.reject(new Error(`not connected: ${r.result.reason}`));
        writeSolanaSession(r.result.value);
        return JSON.stringify({ status: "connected", chain: "solana", ...r.result.value, opened: r.opened }, null, 2);
      }
      const r = await runConnect(deps);
      if (!r.result.ok) return Promise.reject(new Error(`not connected: ${r.result.reason}`));
      return JSON.stringify({ status: "connected", ...r.result.value, opened: r.opened }, null, 2);
    },
  );

  register(
    "connect_disconnect",
    {
      title: "Forget the connected wallet",
      description: "Deletes the local connection record, the EVM and the Solana one. It moves nothing and revokes nothing in the wallet itself.",
      inputSchema: {},
    },
    async () => JSON.stringify({ status: "disconnected", hadConnection: clearSession(), hadSolanaConnection: clearSolanaSession() }, null, 2),
  );

  const now = deps.now ?? (() => new Date());

  /** What the Solana flows need from this file: the same page, port, policy, app and time limits. */
  const solanaDeps = (): SolanaFlowDeps => ({
    open: deps.open ?? announce,
    ttlMs: deps.ttlMs ?? CONFIRM_TTL_MS,
    ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
    ...(deps.verifyOpts ? { verifyOpts: deps.verifyOpts } : {}),
    ...(deps.solanaRpc ? { rpc: deps.solanaRpc } : {}),
    html: shell,
    csp: PAGE_CSP,
    assets: assets(),
    ports: connectPorts(),
    appId: privyAppId(),
  });

  const notConnectedSolana = () => new Error("no Solana wallet is connected — run `treasury connect wallet --chain solana` first, and let the operator sign in");

  /**
   * How a deposit or withdrawal run is authorised. `ack`: the single acknowledgement (none yet: issue it).
   * `plan`: leg `leg` of an acknowledged plan (`connect plan`). `describe`: build and gate-check the calls and
   * return what the acknowledgement would say, writing nothing — how `connect plan` reads each of its legs.
   */
  type Mode = { kind: "ack"; ack: string | undefined } | { kind: "plan"; code: string; leg: number } | { kind: "describe" };
  interface Described {
    digest: string;
    summary: AckSummary;
  }

  /** A transaction as a plan keeps it: the hash, the verdict, and what else the wallet moved with it. */
  const planTx = (t: PlanTx): PlanTx => ({ hash: t.hash, verified: t.verified, ...(t.alsoMoved?.length ? { alsoMoved: t.alsoMoved } : {}) });

  /** Records a leg's progress on the plan it belongs to, unless a newer plan has replaced it meanwhile. */
  const markLeg = (code: string, index: number, update: Partial<PlanLeg>) => {
    const cur = readPlan();
    if (!cur || cur.code !== code) return;
    cur.legs[index] = { ...cur.legs[index]!, ...update };
    writePlan(cur);
  };

  /**
   * Runs leg `index` of `plan` through `run` (the existing confirm flow), recording it as running before the
   * page opens and as its outcome after, and adds where the plan stands to the result. A leg that throws, or
   * does not complete, ends the plan.
   */
  const runPlanLeg = async (plan: PendingPlan, index: number, run: (open: (url: string) => boolean) => Promise<string>): Promise<string> => {
    markLeg(plan.code, index, { status: "running" });
    let opened = false;
    const open = (url: string) => ((opened = true), (deps.open ?? announce)(url));
    let text: string;
    try {
      text = await run(open);
    } catch (e) {
      const message = redactEndpoints(e instanceof Error ? e.message : String(e));
      if (!opened) {
        // No page opened, so nothing could be sent: the leg stays pending and the plan stands.
        markLeg(plan.code, index, { status: "pending" });
        throw new Error(`${message} (no page opened and nothing was sent; leg ${plan.legs[index]!.leg} of the plan can run again)`);
      }
      markLeg(plan.code, index, { status: "not_reported", reason: message });
      throw e;
    }
    const r = JSON.parse(text) as { status: PlanLegStatus; txs?: PlanTx[]; reason?: string; next_step: string };
    const status: PlanLegStatus = r.status === "completed" ? "completed" : r.status === "stopped" ? "stopped" : "not_reported";
    markLeg(plan.code, index, { status, txs: (r.txs ?? []).map(planTx), ...(r.reason ? { reason: r.reason } : {}) });
    const leg = plan.legs[index]!;
    const next = plan.legs[index + 1];
    const next_step =
      status !== "completed"
        ? `The plan ended at leg ${leg.leg} of ${plan.legs.length}: the legs after it will not run. ${r.next_step}`
        : next
          ? `Leg ${leg.leg} of ${plan.legs.length} completed. Report its hashes to the operator, then run leg ${next.leg} without asking again (their yes covered every leg): ${next.command}`
          : `Leg ${leg.leg} of ${plan.legs.length} completed, and with it the whole plan. Report every leg's hashes to the operator (\`connect plan --status\` lists them).`;
    return JSON.stringify({ ...r, plan: { code: plan.code, leg: leg.leg, of: plan.legs.length }, next_step }, null, 2);
  };

  /** A Solana confirm flow's result, in the same shape as `outcome`'s. */
  const solanaOutcome = (session: Session, r: Awaited<ReturnType<typeof runConfirmSolana>>) => {
    const txs = r.result.ok ? r.result.value : r.done;
    const all = txs.length === r.total && txs.every((t) => t.verified === "matched" || t.verified === "extra_transfer");
    const status = r.result.ok ? (all ? "completed" : "stopped") : txs.length ? "stopped" : "not_reported";
    const reason = (r.result.ok ? r.stopReason : r.result.reason) ?? (status === "stopped" ? "the flow ended before the transaction was confirmed" : undefined);
    return JSON.stringify(
      {
        status,
        chain: "solana",
        chainId: null,
        account: session.account,
        opened: r.opened,
        ...(reason ? { reason } : {}),
        calls_total: r.total,
        txs,
        next_step:
          status === "completed"
            ? "The transaction landed as confirmed. Report its signature to the operator; any `extra_transfer` is money the wallet moved besides the call — say so."
            : status === "stopped"
              ? "Stopped before the transaction landed as confirmed. Do not retry blindly: read `reason` and the transaction's `verified` and `detail`, check the account with `earn balance --chain solana`, and tell the operator."
              : "No transaction was reported to this command. That is not proof that none was sent: if the wallet showed a confirmation, check the account with `earn balance --chain solana` before any retry. Tell the operator why (reason).",
      },
      null,
      2,
    );
  };

  /**
   * The Solana counterpart of `confirmInWallet`: the same two runs. The acknowledgement covers what the
   * operator asked for (`acked`: account, vault, action, raw amount), because the transaction itself is built
   * when the operator confirms. `intent` gives the shares and amount to build from; it runs again after the
   * acknowledgement is accepted, so a withdrawal by amount burns the shares worth that amount at that moment.
   */
  const confirmSolana = async (
    acked: { kind: "deposit" | "withdraw" | "withdraw-assets"; vault: SolanaVaultEntry; raw: bigint },
    amountText: string,
    session: Session,
    mode: Mode,
    intent: () => Promise<SolanaIntent>,
  ): Promise<string | Described> => {
    const digest = solanaIntentDigest(session.account, acked.vault.address, acked.kind, acked.raw);
    if (mode.kind === "describe" || (mode.kind === "ack" && mode.ack === undefined)) {
      // Resolves the request (for a withdrawal by amount, the shares it burns now), so one that cannot be priced
      // fails before the operator is asked. It is NOT the gate: no transaction is built or simulated here. The
      // --ack run builds and simulates it (buildForIntent) before any page opens.
      await intent();
      const summary = summarizeSolana(acked.kind === "deposit" ? "deposit" : "withdraw", acked.vault, amountText, session.account);
      if (mode.kind === "describe") return { digest, summary };
      const pending = issueAckForDigest(digest, now());
      writePendingAck(pending);
      return JSON.stringify(
        {
          status: "needs_acknowledgement",
          opened: false,
          action: acked.kind === "deposit" ? "deposit" : "withdraw",
          amount: summary.amount,
          chain: "solana",
          chainId: null,
          vault: summary.vault,
          account: session.account,
          receiver: session.account,
          acknowledgement: acknowledgementText(summary),
          ack: pending.code,
          expiresAtIso: pending.expiresAtIso,
          next_step: `Post \`acknowledgement\` to the operator word for word, as it is, and wait for their reply. Only an explicit yes they give after reading it is an acknowledgement: not a "go" from before they saw it, and not your own reading of the conversation. On yes, run this same command again with --ack ${pending.code} added, and the signing page opens. On anything else, stop. The code works once, for exactly this ${acked.kind === "deposit" ? "deposit" : "withdrawal"}, until ${pending.expiresAtIso}.`,
        },
        null,
        2,
      );
    }
    if (mode.kind === "plan") {
      const plan = readPlan();
      const index = checkPlanLeg(mode.code, mode.leg, plan, digest, now());
      return runPlanLeg(plan!, index, async (open) => solanaOutcome(session, await runConfirmSolana(await intent(), session, { ...solanaDeps(), open })));
    }
    checkAckDigest(mode.ack!, readPendingAck(), digest, now());
    clearPendingAck();
    return solanaOutcome(session, await runConfirmSolana(await intent(), session, solanaDeps()));
  };

  /** A Solana withdrawal's shares: `shares_exact` verbatim, or the shares worth `amount_usdc`, rounded up. */
  const solanaWithdrawShares = async (vault: SolanaVaultEntry, amount_usdc: string | undefined, shares_exact: string | undefined): Promise<bigint> => {
    if (shares_exact !== undefined) return parseAmount(shares_exact, vault.shareDecimals, "shares_exact");
    const v = await readVault(deps.solanaRpc ?? makeSolanaRpc(solanaRpcUrlFromEnv()), vault);
    const amount = parseAmount(amount_usdc!, vault.asset.decimals, `withdrawal amount (${vault.asset.symbol})`);
    if (v.holdings.netAum === 0n) throw new Error(`${vault.symbol} holds nothing to withdraw`);
    return (amount * v.state.sharesIssued + v.holdings.netAum - 1n) / v.holdings.netAum;
  };

  /**
   * A Solana deposit or withdrawal as it is acknowledged (`acked`: the action and its raw amount; the digest adds the
   * account and vault) and the intent to build from. One derivation for a single run, a plan's leg run and `--run`.
   */
  const solanaRequest = (action: "deposit" | "withdraw", v: SolanaVaultEntry, a: { amount_usdc?: string | undefined; all?: boolean | undefined; shares_exact?: string | undefined }) => {
    if (action === "deposit") {
      const raw = parseAmount(a.amount_usdc!, v.asset.decimals, `deposit amount (${v.asset.symbol})`);
      if (raw === 0n) throw new Error("a deposit of 0");
      const intent: SolanaIntent = { kind: "deposit", vault: v, raw };
      return { acked: { kind: "deposit" as const, vault: v, raw }, amountText: `${formatAmount(raw, v.asset.decimals)} ${v.asset.symbol}`, intent: async () => intent };
    }
    const intent = async (): Promise<SolanaIntent> => {
      const raw = await solanaWithdrawShares(v, a.all ? undefined : a.amount_usdc, a.all ? a.shares_exact : undefined);
      if (raw === 0n) throw new Error("a withdrawal of 0");
      return { kind: "withdraw", vault: v, raw, ...(a.all ? {} : { assets: parseAmount(a.amount_usdc!, v.asset.decimals, `withdrawal amount (${v.asset.symbol})`) }) };
    };
    if (a.all) {
      const shares = parseAmount(a.shares_exact!, v.shareDecimals, "shares_exact");
      return { acked: { kind: "withdraw" as const, vault: v, raw: shares }, amountText: `${formatAmount(shares, v.shareDecimals)} ${v.symbol} shares`, intent };
    }
    const assets = parseAmount(a.amount_usdc!, v.asset.decimals, `withdrawal amount (${v.asset.symbol})`);
    return { acked: { kind: "withdraw-assets" as const, vault: v, raw: assets }, amountText: `${formatAmount(assets, v.asset.decimals)} ${v.asset.symbol}`, intent };
  };

  /**
   * Without `ack`: gate-check the calls, record them as pending, and return the acknowledgement for
   * the operator; nothing opens. With `ack`: open the confirm page only for the calls the operator
   * acknowledged, spending the acknowledgement first so it can never open a second page. As a plan's leg:
   * the same page, for the calls that leg was acknowledged as.
   */
  const confirmInWallet = async (action: "deposit" | "withdraw", calls: UnsignedCall[], session: Session, receiver: Address, mode: Mode): Promise<string | Described> => {
    const account = session.account as Address;
    if (mode.kind === "describe") return { digest: callsDigest(calls, account), summary: summarize(action, calls, admit(calls, account), receiver) };
    if (mode.kind === "plan") {
      const plan = readPlan();
      const index = checkPlanLeg(mode.code, mode.leg, plan, callsDigest(calls, account), now());
      return runPlanLeg(plan!, index, async (open) => outcome(calls[0]!.chainId, session.account, await runConfirm(calls, session, { ...deps, open })));
    }
    const ack = mode.ack;
    if (ack === undefined) {
      const summary = summarize(action, calls, admit(calls, account), receiver);
      const pending = issueAck(calls, account, now());
      writePendingAck(pending);
      return JSON.stringify(
        {
          status: "needs_acknowledgement",
          opened: false,
          action,
          amount: summary.amount,
          chain: CHAIN_INFO[summary.chainId as 8453].key,
          chainId: summary.chainId,
          vault: summary.vault,
          account,
          receiver,
          acknowledgement: acknowledgementText(summary),
          ack: pending.code,
          expiresAtIso: pending.expiresAtIso,
          next_step: `Post \`acknowledgement\` to the operator word for word, as it is, and wait for their reply. Only an explicit yes they give after reading it is an acknowledgement: not a "go" from before they saw it, and not your own reading of the conversation. On yes, run this same command again with --ack ${pending.code} added, and the signing page opens. On anything else, stop. The code works once, for exactly these calls, until ${pending.expiresAtIso}.`,
        },
        null,
        2,
      );
    }
    checkAck(ack, readPendingAck(), calls, account, now());
    // Spent before the page opens, so a flow that fails to start leaves nothing to reuse. Two
    // concurrent runs could both pass the check; only one page opens, because the page lock admits one.
    clearPendingAck();
    const r = await runConfirm(calls, session, deps);
    return outcome(calls[0]!.chainId, session.account, r);
  };

  /** `--ack`, or `--plan` with `--leg`, never both: which authorisation this run uses. */
  const modeOf = (a: { ack?: string | undefined; plan?: string | undefined; leg?: number | undefined }): Mode => {
    if (a.plan !== undefined || a.leg !== undefined) {
      if (a.ack !== undefined) throw new Error("give --ack (a single acknowledgement) or --plan with --leg (a leg of an acknowledged plan), not both");
      if (a.plan === undefined || a.leg === undefined) throw new Error("--plan and --leg go together: the plan's code and the leg's number, as `connect plan` gave them");
      return { kind: "plan", code: a.plan, leg: a.leg };
    }
    return { kind: "ack", ack: a.ack };
  };

  const asText = (r: string | Described) => {
    if (typeof r !== "string") throw new Error("internal: a run returned a description");
    return r;
  };

  interface DepositArgs {
    vault?: string | undefined;
    chain?: string | undefined;
    amount_usdc: string;
    receiver: string;
  }
  const depositLeg = async ({ vault: symbol, chain, amount_usdc, receiver: rawReceiver }: DepositArgs, mode: Mode) => {
    const target = resolveAnyVault(symbol, chain);
    if (target.family === "solana") {
      const session = readSolanaSession();
      if (!session) throw notConnectedSolana();
      if (rawReceiver !== session.account) throw new Error(`refused: --receiver ${rawReceiver} is not the connected Solana account ${session.account}; on Solana the shares can only go to the account that deposits`);
      const r = solanaRequest("deposit", target.vault, { amount_usdc });
      return confirmSolana(r.acked, r.amountText, session, mode, r.intent);
    }
    const session = readSession();
    if (!session) throw notConnected();
    const receiver = isAddress(rawReceiver) ? getAddress(rawReceiver) : rawReceiver;
    if (receiver !== session.account) throw new Error(`refused: --receiver ${receiver} is not the connected account ${session.account}; this page pays only the connected account (use \`earn prepare_deposit\` with the operator's own signer for anything else)`);
    const vault = resolveVault(symbol, chain);
    return confirmInWallet("deposit", buildDeposit(vault, { assetsHuman: amount_usdc, receiver: receiver as Address, account: session.account as Address }), session, receiver as Address, mode);
  };

  interface WithdrawArgs {
    vault?: string | undefined;
    chain?: string | undefined;
    receiver: string;
    amount_usdc?: string | undefined;
    all?: boolean | undefined;
    shares_exact?: string | undefined;
  }
  const withdrawLeg = async ({ vault: symbol, chain, receiver: rawReceiver, amount_usdc, all, shares_exact }: WithdrawArgs, mode: Mode) => {
    if (all && amount_usdc) throw new Error("give --amount_usdc or --all with --shares_exact, not both");
    if (!all && shares_exact) throw new Error("--shares_exact goes with --all; for an amount in the asset, use --amount_usdc alone");
    if (all && !shares_exact) throw new Error("--all requires --shares_exact (copy it verbatim from `earn balance`)");
    if (!all && !amount_usdc) throw new Error("provide --amount_usdc, or --all with --shares_exact");
    const target = resolveAnyVault(symbol, chain);
    if (target.family === "solana") {
      const session = readSolanaSession();
      if (!session) throw notConnectedSolana();
      if (rawReceiver !== session.account) throw new Error(`refused: --receiver ${rawReceiver} is not the connected Solana account ${session.account}; on Solana a withdrawal pays only the account whose shares burn`);
      const r = solanaRequest("withdraw", target.vault, { amount_usdc, all, shares_exact });
      return confirmSolana(r.acked, r.amountText, session, mode, r.intent);
    }
    const session = readSession();
    if (!session) throw notConnected();
    const receiver = isAddress(rawReceiver) ? getAddress(rawReceiver) : rawReceiver;
    if (receiver !== session.account) throw new Error(`refused: --receiver ${receiver} is not the connected account ${session.account}; this page pays only the connected account`);
    const vault = resolveVault(symbol, chain);
    const owner = session.account as Address;
    let calls: UnsignedCall[];
    if (all) {
      if (!shares_exact) throw new Error("--all requires --shares_exact (copy it verbatim from `earn balance`)");
      calls = buildWithdraw(vault, { receiver: receiver as Address, owner, all: true, sharesExact: shares_exact });
    } else {
      if (!amount_usdc) throw new Error("provide --amount_usdc, or --all with --shares_exact");
      calls = buildWithdraw(vault, { receiver: receiver as Address, owner, assetsHuman: amount_usdc });
    }
    return confirmInWallet("withdraw", calls, session, receiver as Address, mode);
  };

  const planCodeArg = z
    .string()
    .regex(/^[0-9a-fA-F]{8}$/, "the 8-character code of an acknowledged plan, from `connect plan`")
    .optional()
    .describe("run this as a leg of an acknowledged plan (`connect plan`): the plan's code, with --leg. Use the leg's command exactly as `connect plan` gave it; instead of --ack");
  const legArg = z.number().int().positive().optional().describe("which leg of the plan this is (1, 2, …), with --plan; legs run in order");

  register(
    "connect_deposit",
    {
      title: "Deposit through the connected wallet",
      description:
        "Builds the approve + deposit for the CONNECTED account and checks every call against the registry. Runs twice. Without --ack it opens NOTHING: it returns `needs_acknowledgement` with an `acknowledgement` to post to the operator word for word, and an `ack` code. Only after the operator replies yes, run it again with --ack <code>: then the confirm page opens, and the operator confirms each call in their wallet, one at a time. That run returns each transaction hash with `verified` read from the receipt (`matched`, `extra_transfer`, `mismatch`, `reverted`, `unverified`). Run `earn quote --direction deposit` first. As a leg of a plan the operator acknowledged with `connect plan`, run it with --plan <code> --leg <n> instead of --ack, exactly as the plan gave it.",
      inputSchema: { vault: vaultArg, chain: chainArg, amount_usdc: amountArg, receiver: receiverArg, ack: ackArg, plan: planCodeArg, leg: legArg },
    },
    async (args) => asText(await depositLeg(args, modeOf(args))),
  );

  register(
    "connect_withdraw",
    {
      title: "Withdraw through the connected wallet",
      description:
        "Builds the withdrawal for the CONNECTED account (the asset to that same account) and checks it against the registry. Runs twice, like `connect deposit`: without --ack it opens NOTHING and returns `needs_acknowledgement` with an `acknowledgement` to post to the operator word for word; only after their yes, run it again with --ack <code> and the confirm page opens. Pass --amount_usdc, or --all with --shares_exact copied verbatim from `earn balance`. Run `earn quote --direction withdraw` first. The second run returns the hash with `verified` read from the receipt. As a leg of a plan the operator acknowledged with `connect plan`, run it with --plan <code> --leg <n> instead of --ack, exactly as the plan gave it.",
      inputSchema: {
        vault: vaultArg,
        chain: chainArg,
        receiver: receiverArg,
        amount_usdc: amountArg.optional(),
        all: z.boolean().optional(),
        shares_exact: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        ack: ackArg,
        plan: planCodeArg,
        leg: legArg,
      },
    },
    async (args) => asText(await withdrawLeg(args, modeOf(args))),
  );

  /** One leg of `--legs`, as typed: `deposit <vault> <amount>` or `withdraw <vault> <amount|all>`. */
  const parseLegs = (text: string) => {
    const parts = text
      .split(/[;\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) throw new Error('--legs names no leg; give e.g. "deposit tlCashPlusUSDC2B 1; withdraw tlCashPlusUSDC2C all"');
    if (parts.length > PLAN_MAX_LEGS) throw new Error(`a plan holds at most ${PLAN_MAX_LEGS} legs, and --legs names ${parts.length}; split it into more than one plan`);
    return parts.map((p, i) => {
      const [action, vault, amount, ...rest] = p.split(/\s+/);
      const where = `leg ${i + 1} ("${p}")`;
      if (rest.length || !vault || !amount) throw new Error(`${where}: write each leg as "deposit <vault> <amount>" or "withdraw <vault> <amount|all>"`);
      if (action !== "deposit" && action !== "withdraw") throw new Error(`${where}: the action is "deposit" or "withdraw", not "${action}"`);
      if (amount === "all") {
        if (action === "deposit") throw new Error(`${where}: "all" withdraws a whole position; a deposit takes an amount the operator chose`);
      } else if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`${where}: "${amount}" is not a plain decimal amount (e.g. "25" or "12.5"), or "all" for a whole withdrawal`);
      return { action, vault, amount } as { action: "deposit" | "withdraw"; vault: string; amount: string };
    });
  };

  /** The account's whole share balance in `symbol`, read now: what a `withdraw <vault> all` leg redeems. */
  const wholePosition = async (symbol: string, account: string): Promise<string> => {
    const target = resolveAnyVault(symbol);
    if (target.family === "solana") {
      const v = target.vault;
      const held = await tokenBalance(deps.solanaRpc ?? makeSolanaRpc(solanaRpcUrlFromEnv()), await associatedTokenAccount(account, v.sharesMint));
      return formatAmount(held.amount, v.shareDecimals);
    }
    const v = target.vault;
    const client = deps.client ? deps.client(v.chainId) : makePublicClient(v.chainId, rpcUrlFromEnv(v.chainId));
    const shares = (await client.readContract({ address: v.address, abi: erc4626Abi, functionName: "balanceOf", args: [account as Address] })) as bigint;
    return formatAmount(shares, v.shareDecimals);
  };

  /** Every leg of `--legs`, built and gate-checked exactly as its own run will be, with the args that run takes. */
  const describeLegs = async (text: string) => {
    const parsed = parseLegs(text);
    const out: { action: "deposit" | "withdraw"; symbol: string; chain: string; family: "evm" | "solana"; args: WithdrawArgs; d: Described; whole: boolean; asset: { symbol: string; decimals: number } }[] = [];
    for (const [i, l] of parsed.entries()) {
      const target = resolveAnyVault(l.vault);
      const session = target.family === "solana" ? readSolanaSession() : readSession();
      if (!session) throw target.family === "solana" ? notConnectedSolana() : notConnected();
      const chain = target.family === "solana" ? "solana" : CHAIN_INFO[target.vault.chainId].key;
      const whole = l.amount === "all";
      // A whole withdrawal is bound to the share balance read now, so it must be the only leg on its vault that
      // could change that balance before it runs, and nothing on that vault can follow it.
      const earlier = out.find((o) => o.symbol === target.vault.symbol);
      if (whole && earlier) {
        throw new Error(`leg ${i + 1} withdraws all of ${target.vault.symbol}, which an earlier leg ${earlier.action === "deposit" ? "deposits into" : "withdraws from"}; the share balance is read now, before that leg runs, so withdraw it in a later plan`);
      }
      if (earlier?.whole) {
        throw new Error(`leg ${i + 1} is on ${target.vault.symbol}, which an earlier leg withdraws in full; put it in a later plan`);
      }
      // The receiver is the connected account for the leg's chain family: the only account a page pays.
      let args: WithdrawArgs = { vault: target.vault.symbol, receiver: session.account, amount_usdc: l.amount };
      if (whole) {
        const shares = await wholePosition(target.vault.symbol, session.account);
        if (/^0(\.0+)?$/.test(shares)) throw new Error(`leg ${i + 1} withdraws all of ${target.vault.symbol}, but ${session.account} holds no shares of it`);
        args = { vault: target.vault.symbol, receiver: session.account, all: true, shares_exact: shares };
      }
      const d =
        l.action === "deposit"
          ? await depositLeg({ vault: target.vault.symbol, receiver: session.account, amount_usdc: l.amount }, { kind: "describe" })
          : await withdrawLeg(args, { kind: "describe" });
      if (typeof d === "string") throw new Error("internal: a leg did not describe itself");
      // The single acknowledgement's wording says a given share amount is not checked against the balance; here it was read.
      if (whole) d.summary.amount = `${args.shares_exact} ${target.vault.symbol} shares (your whole position, read when this plan was made; shares that arrive after that are not included)`;
      out.push({ action: l.action, symbol: target.vault.symbol, chain, family: target.family, args, d, whole, asset: target.vault.asset });
    }
    return out;
  };

  /** "deposit 3 USDC and 1 USDG; withdraw 1 USDC and the whole position in 2 vaults". */
  const planTotals = (legs: Awaited<ReturnType<typeof describeLegs>>) => {
    const sum = (action: "deposit" | "withdraw") => {
      const by = new Map<string, { raw: bigint; decimals: number }>();
      for (const l of legs.filter((x) => x.action === action && !x.whole)) {
        const t = by.get(l.asset.symbol) ?? { raw: 0n, decimals: l.asset.decimals };
        t.raw += parseAmount(l.args.amount_usdc!, l.asset.decimals, "amount");
        by.set(l.asset.symbol, t);
      }
      const parts = [...by].map(([s, t]) => `${formatAmount(t.raw, t.decimals)} ${s}`);
      const whole = legs.filter((x) => x.action === action && x.whole).length;
      if (whole) parts.push(`the whole position in ${whole} ${whole === 1 ? "vault" : "vaults"}`);
      return parts.length ? `${action} ${parts.join(" and ")}` : undefined;
    };
    return [sum("deposit"), sum("withdraw")].filter((x): x is string => x !== undefined);
  };

  /** The command that runs one leg, exactly: what `connect plan` hands the agent. */
  const legCommand = (l: Awaited<ReturnType<typeof describeLegs>>[number], code: string, leg: number) =>
    [
      `connect ${l.action}`,
      `--vault ${l.symbol}`,
      ...(l.args.all ? ["--all", `--shares_exact ${l.args.shares_exact}`] : [`--amount_usdc ${l.args.amount_usdc}`]),
      `--receiver ${l.args.receiver}`,
      `--plan ${code}`,
      `--leg ${leg}`,
    ].join(" ");

  /** A leg's arguments as the plan file keeps them, so `--run` rebuilds the same calls. */
  const legArgs = (a: WithdrawArgs): PlanLegArgs => ({
    vault: a.vault!,
    receiver: a.receiver,
    ...(a.all ? { all: true, shares_exact: a.shares_exact! } : { amount_usdc: a.amount_usdc! }),
  });

  /** The calls leg `leg` was acknowledged as, rebuilt for the connected account; `checkPlanLeg` holds them to its digest. */
  const legCalls = (leg: PlanLeg, session: Session): UnsignedCall[] => {
    const a = leg.args;
    if (!a) throw new Error(`refused: leg ${leg.leg} was recorded without its arguments (a plan made by an older version); make the plan again with \`connect plan --legs\``);
    const vault = resolveVault(a.vault);
    const account = session.account as Address;
    const receiver = (isAddress(a.receiver) ? getAddress(a.receiver) : a.receiver) as Address;
    if (leg.action === "deposit") return buildDeposit(vault, { assetsHuman: a.amount_usdc!, receiver, account });
    return a.all ? buildWithdraw(vault, { receiver, owner: account, all: true, sharesExact: a.shares_exact! }) : buildWithdraw(vault, { receiver, owner: account, assetsHuman: a.amount_usdc! });
  };

  /**
   * A Solana leg as it was acknowledged, rebuilt for the connected Solana account: its digest, which `checkPlanLeg`
   * holds it to, and the intent its transaction is built from. The same derivation as its own `--plan --leg` run.
   */
  const legSolana = (leg: PlanLeg, session: Session): { digest: string; intent: () => Promise<SolanaIntent> } => {
    const a = leg.args;
    if (!a) throw new Error(`refused: leg ${leg.leg} was recorded without its arguments (a plan made by an older version); make the plan again with \`connect plan --legs\``);
    const target = resolveAnyVault(a.vault);
    if (target.family !== "solana") throw new Error(`refused: leg ${leg.leg} names ${a.vault}, which is not a vault on Solana`);
    if (a.receiver !== session.account) throw new Error(`refused: leg ${leg.leg} pays ${a.receiver}, which is not the connected Solana account ${session.account}`);
    const r = solanaRequest(leg.action, target.vault, a);
    return { digest: solanaIntentDigest(session.account, target.vault.address, r.acked.kind, r.acked.raw), intent: r.intent };
  };

  /** What the page shows for a leg: the sentence, where the money goes, and how far it got. */
  const legView = (leg: PlanLeg) => {
    const base = { leg: leg.leg, action: leg.action, amount: leg.amount, receiver: leg.args?.receiver, status: leg.status, ...(leg.reason ? { reason: leg.reason } : {}), txs: leg.txs ?? [] };
    const target = resolveAnyVault(leg.vault);
    if (target.family === "solana") {
      const v = target.vault;
      const explorer = `https://solscan.io/account/${v.address}`;
      return { ...base, family: "solana", chainId: null, chainName: "Solana", vault: { symbol: v.symbol, name: v.name, address: v.address, asset: v.asset.symbol, assetAddress: v.asset.address, links: { explorer } }, txBase: "https://solscan.io/tx/" };
    }
    const v = target.vault;
    return {
      ...base,
      family: "evm",
      chainId: v.chainId,
      chainName: CHAIN_INFO[v.chainId].name,
      vault: { symbol: v.symbol, name: v.name, address: v.address, asset: v.asset.symbol, assetAddress: v.asset.address, links: linksFor(v) },
      txBase: explorerTxUrl(v.chainId, ""),
    };
  };

  /** The plan as `--run` and `--status` report it. */
  const planSummary = (p: PendingPlan) => p.legs.map((l) => ({ leg: l.leg, action: l.action, vault: l.vault, chain: l.chain, amount: l.amount, status: l.status, ...(l.reason ? { reason: l.reason } : {}), txs: l.txs ?? [] }));

  /**
   * `connect plan --run`: ONE page for every leg of the acknowledged plan (#174), EVM and Solana legs alike (#184).
   * Each leg is still rebuilt, held to the digest it was acknowledged as (`checkPlanLeg`), and admitted by the same
   * gate: an EVM leg's calls through `prepareConfirm`, checked from their receipts; a Solana leg's transaction through
   * `buildForIntent` when the leg starts and again when the operator presses for it (`prepareConfirmSolana`: a
   * blockhash lasts about a minute), checked from what landed. One leg at a time; a leg that does not complete ends
   * the plan, exactly as `--plan --leg`. The page lives across runs: it keeps the plan's secret and port, so a run that
   * stops for the shell's time limit (`in_progress`, never mid-leg) and the run after it serve the same page, and the
   * operator's tab carries on.
   */
  const runPlanPage = async (): Promise<string> => {
    const plan = readPlan();
    if (!plan) throw new Error("no plan is pending; `connect plan --legs …` makes one");
    if (!plan.acknowledged) throw new Error(`refused: plan ${plan.code} has not been acknowledged; post its acknowledgement and, on the operator's yes, run \`connect plan\` with --ack ${plan.code}`);
    // Each chain family's connection, needed only when the plan has a leg on it: a Solana-only plan needs no EVM one.
    const isSolana = (l: PlanLeg) => l.chain === "solana";
    const session = plan.legs.some((l) => !isSolana(l)) ? readSession() : undefined;
    if (plan.legs.some((l) => !isSolana(l)) && !session) throw notConnected();
    const solSession = plan.legs.some(isSolana) ? readSolanaSession() : undefined;
    if (plan.legs.some(isSolana) && !solSession) throw notConnectedSolana();
    let solRpc: SolanaRpc | undefined;
    const solanaRpc = () => (solRpc ??= deps.solanaRpc ?? makeSolanaRpc(solanaRpcUrlFromEnv()));
    const report = (status: string, p: PendingPlan, extra: Record<string, unknown>, next_step: string) =>
      JSON.stringify({ status, code: p.code, expiresAtIso: p.expiresAtIso, ...extra, legs: planSummary(p), next_step }, null, 2);
    const endedReport = (p: PendingPlan, opened = false) => {
      const ended = p.legs.find((l) => l.status !== "pending" && l.status !== "completed");
      if (ended) {
        return report(
          ended.status === "running" ? "not_reported" : ended.status,
          p,
          { opened },
          ended.status === "running"
            ? `Leg ${ended.leg}'s run never finished, so whether it sent anything is not known here. Check the account with \`earn balance\` and tell the operator; the legs after it do not run.`
            : `The plan ended at leg ${ended.leg} (${ended.status}${ended.reason ? `: ${ended.reason}` : ""}); the legs after it did not run. Report each leg's transactions to the operator, check the account with \`earn balance\`, and do not retry blindly.`,
        );
      }
      if (p.legs.every((l) => l.status === "completed")) {
        return report("completed", p, { opened }, "Every leg landed as confirmed. Report each leg's transactions to the operator; any `extra_transfer` is money the wallet moved besides the call — say so.");
      }
      return undefined;
    };
    const done0 = endedReport(plan);
    if (done0) return done0;
    if (planExpired(plan, now())) {
      return report("expired", plan, { opened: false }, `The plan expired at ${plan.expiresAtIso}; legs that had not started did not run. Tell the operator; for what is left, make a new plan and ask again.`);
    }
    // Every leg still to run must rebuild to what was acknowledged, for the connected account of its family, before a
    // page opens.
    const account = session?.account as Address | undefined;
    const legDigest = (l: PlanLeg) => (isSolana(l) ? legSolana(l, solSession!).digest : callsDigest(legCalls(l, session!), account!));
    for (const l of plan.legs.filter((x) => x.status === "pending")) {
      if (legDigest(l) !== l.digest) {
        const who = isSolana(l) ? solSession!.account : account;
        throw new Error(`refused: leg ${l.leg} is not what the operator acknowledged for the connected account ${who} (the account, an amount or a share balance changed); make a new plan with \`connect plan --legs\``);
      }
    }

    const ttlMs = deps.ttlMs ?? CONFIRM_TTL_MS;
    const legMinMs = deps.legMinMs ?? LEG_MIN_MS;
    const endsAt = Date.now() + ttlMs;
    // The leg in the wallet, with its family's confirm core.
    type Current = { index: number; family: "evm"; core: ConfirmCore } | { index: number; family: "solana"; core: SolanaConfirmCore };
    let current: Current | undefined;
    let paused = false;
    // This run's own copy of its plan: every leg outcome is recorded here first, and the report is built from it. The
    // plan file is written too, but only while it still holds this plan (`markLeg`): another command can replace it
    // (`connect plan --legs`) or clear it (`connect disconnect`, `connect wallet`) while the page is open, and an
    // outcome must never land on another plan, nor be lost with the file.
    const mine: PendingPlan = structuredClone(plan);
    const record = (index: number, update: Partial<PlanLeg>) => {
      mine.legs[index] = { ...mine.legs[index]!, ...update };
      markLeg(plan.code, index, update);
    };
    const replaced = () => readPlan()?.code !== plan.code;
    // Pending here AND in the file: a `--plan --leg` run of the same plan, in another shell, marks its leg running in
    // the file, and the page must not start that leg too.
    const startable = (index: number) => mine.legs[index]?.status === "pending" && readPlan()?.legs[index]?.status === "pending";
    // Once the plan is replaced or cleared, no leg starts: the first one still pending is recorded as stopped.
    const endReplaced = () => {
      const next = mine.legs.findIndex((l) => l.status === "pending");
      if (next >= 0) mine.legs[next] = { ...mine.legs[next]!, status: "stopped", reason: "the plan was replaced or cleared by another command while its page was open" };
    };
    const reused = plan.page;
    const legStatusOf = (status: PlanLegStatus, txs: readonly PlanTx[], reason?: string) => ({ status, txs: txs.map(planTx), ...(reason ? { reason } : {}) });
    const pendingLeft = () => mine.legs.some((l) => l.status === "pending");

    const serve = (secret: string, ports: readonly number[]) => serveOnce<"settled">({
      mode: "plan",
      secret,
      ttlMs,
      ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
      timeoutReason: () => (current ? "the page's time limit ran out during a leg" : "paused for the shell's time limit"),
      html: (s) => shell(s, "Your plan — Open Agent Treasury"),
      csp: PAGE_CSP,
      assets: assets(),
      ports,
      info: () => {
        const p = mine;
        return {
          mode: "plan",
          appId: privyAppId(),
          ...(session ? { account, walletType: session.walletType } : {}),
          ...(solSession ? { solanaAccount: solSession.account, solanaWalletType: solSession.walletType } : {}),
          code: p.code,
          expiresAtIso: p.expiresAtIso,
          legMinMs,
          legs: p.legs.map(legView),
          current: current ? { leg: p.legs[current.index]!.leg, ...current.core.info() } : null,
        };
      },
      // The operator stopped the plan on the page: after the wallet declined (nothing sent), or between legs. A hash
      // the page could not hand over is put on record first, and its leg is then "may have been sent".
      onReject: (body) => {
        const reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 300) : "stopped on the page";
        if (current) {
          current.core.onReject(body);
          const out = current.core.done;
          const unverified = out.some((t) => t.verified === "unverified");
          record(current.index, unverified ? legStatusOf("not_reported", out, `may have been sent: ${reason}`) : legStatusOf(body["declined"] === true ? "stopped" : "not_reported", out, reason));
          current = undefined;
          return;
        }
        const next = mine.legs.findIndex((l) => l.status === "pending");
        if (next < 0) return;
        // `unprepared`: the page could not get ready before this leg (a plan's Solana account is connected and checked
        // when it starts), so nothing was asked of the wallet.
        const stop = { status: "stopped" as const, reason: body["unprepared"] === true ? `not prepared: ${reason}` : `the operator stopped the plan before this leg: ${reason}` };
        // A leg another shell is running keeps its record in the file: that run writes its own outcome.
        if (startable(next)) record(next, stop);
        else mine.legs[next] = { ...mine.legs[next]!, ...stop };
      },
      accept: async (body) => {
        if (body["start"] !== undefined) {
          if (current) return { ok: false, reason: "a leg is already in progress on this page" };
          // Never start a leg the page cannot finish: hand over to the next run instead.
          if (endsAt - Date.now() < legMinMs) {
            paused = true;
            return { ok: true, final: true, value: "settled", reply: { paused: true } };
          }
          if (replaced()) {
            endReplaced();
            return { ok: false, fatal: true, reason: "this plan was replaced or cleared by another command, so nothing more runs on this page" };
          }
          if (planExpired(mine, now())) return { ok: false, fatal: true, reason: `the plan expired at ${mine.expiresAtIso}; legs that had not started do not run` };
          const leg = mine.legs.find((l) => l.leg === body["start"]);
          if (!leg) return { ok: false, reason: `no leg ${String(body["start"])} in this plan` };
          if (!startable(mine.legs.indexOf(leg))) return { ok: false, reason: `leg ${leg.leg} is running, or has run, elsewhere; this page does not start it` };
          let next: Current;
          try {
            if (isSolana(leg)) {
              // Held to its digest now; its shares (a withdrawal by amount) worked out now; and the gate and simulation
              // run on a transaction built now, before the leg is marked running. The wallet's transaction is built later,
              // at the operator's press.
              const sl = legSolana(leg, solSession!);
              const index = checkPlanLeg(plan.code, leg.leg, mine, sl.digest, now());
              const intent = await sl.intent();
              await buildForIntent(solanaRpc(), intent, solSession!.account);
              next = { index, family: "solana", core: await prepareConfirmSolana(intent, solSession!, solanaRpc(), deps.verifyOpts, endsAt) };
            } else {
              const calls = legCalls(leg, session!);
              const index = checkPlanLeg(plan.code, leg.leg, mine, callsDigest(calls, account!), now());
              next = { index, family: "evm", core: await prepareConfirm(calls, session!, deps, endsAt) };
            }
          } catch (e) {
            return { ok: false, reason: redactEndpoints(e instanceof Error ? e.message : String(e)) };
          }
          // Preparing awaits the chain reads, and meanwhile the page may have stopped the plan, another tab may have
          // started this leg, or another command may have replaced the plan.
          if (current || !startable(next.index) || replaced()) return { ok: false, reason: "the plan was stopped, replaced, or this leg started, while it was being prepared" };
          record(next.index, { status: "running" });
          current = next;
          return { ok: true, final: false, reply: { started: leg.leg } };
        }
        if (!current) return { ok: false, reason: "no leg is in progress; start one first" };
        const cur = current;
        if (cur.family === "solana" && body["build"] === true) {
          // The operator pressed for this Solana leg's transaction: built now, for this leg only, and handed to no other.
          const b = await cur.core.build();
          if (current !== cur) return { ok: false, reason: "the plan was stopped on the page while this step was being prepared" };
          return b.ok ? { ok: true, final: false, reply: b.reply } : b;
        }
        const r = cur.family === "solana" ? await cur.core.accept(body["hash"]) : await cur.core.accept(body["index"], body["hash"]);
        if (current !== cur) {
          // The plan was stopped on the page, or the page's time limit ended the leg, while this step's receipt was being
          // read, and its leg is already on record. Its status stands; only its transactions take what the read found.
          record(cur.index, { txs: cur.core.done.map(planTx) });
          return { ok: false, reason: "the plan was stopped on the page while this step was being checked" };
        }
        if (!r.ok) return r;
        if (r.kind === "next") return { ok: true, final: false, reply: r.reply };
        const { index, core } = cur;
        current = undefined;
        if (r.kind === "stop") {
          record(index, legStatusOf("stopped", core.done, core.stopReason()));
          return { ok: true, final: true, value: "settled", reply: r.reply };
        }
        record(index, legStatusOf("completed", core.done));
        if (replaced()) {
          endReplaced();
          return { ok: true, final: true, value: "settled", reply: { ...r.reply, legDone: true } };
        }
        if (!pendingLeft()) return { ok: true, final: true, value: "settled", reply: { ...r.reply, planDone: true } };
        if (endsAt - Date.now() < legMinMs) {
          paused = true;
          return { ok: true, final: true, value: "settled", reply: { ...r.reply, legDone: true, paused: true } };
        }
        return { ok: true, final: false, reply: { ...r.reply, legDone: true } };
      },
    });
    // The page carries on from the last run's: same secret, same port, so the operator's open tab keeps working. A
    // secret is only ever served on the port it was minted for: if that port is taken now, the old tab cannot reach
    // this page anyway, and whatever holds the old port must not be handed a secret this page still accepts.
    let handle: Awaited<ReturnType<typeof serve>>;
    let secret = reused?.secret ?? newSecret();
    let sameTab = false;
    if (reused?.port) {
      try {
        handle = await serve(secret, [reused.port]);
        sameTab = true;
      } catch (e) {
        const others = connectPorts().filter((p) => p !== reused.port);
        if (!(e as { inUse?: boolean }).inUse || others.length === 0) throw e;
        secret = newSecret();
        handle = await serve(secret, others);
      }
    } else {
      handle = await serve(secret, connectPorts());
    }
    // The page outlives this run: its secret and port stay on the plan for the next one.
    const pNow = readPlan();
    if (pNow && pNow.code === plan.code) writePlan({ ...pNow, page: { secret, port: handle.port } });
    const opened = sameTab ? (process.stderr.write(`The plan's page is already open: ${handle.url}\n`), false) : (deps.open ?? announce)(handle.url);
    const result = await handle.done;
    if (current) {
      // The time limit or a cancel ended the page while a leg was in the wallet: whether it went out is not known here.
      // Cleared, so a receipt still being read cannot overwrite this afterwards.
      record(current.index, legStatusOf("not_reported", current.core.done, result.ok ? "the page closed during this leg" : result.reason));
      current = undefined;
    }
    if (replaced()) endReplaced();
    const after = mine;
    const ended = endedReport(after, opened);
    if (ended) return ended;
    if (planExpired(after, now())) {
      return report("expired", after, { opened }, `The plan expired at ${after.expiresAtIso}; legs that had not started did not run. Tell the operator; for what is left, make a new plan and ask again.`);
    }
    const nextLeg = after.legs.find((l) => l.status === "pending");
    return report(
      "in_progress",
      after,
      { opened, ...(paused ? {} : { reason: result.ok ? "paused" : result.reason }) },
      `The plan's page is waiting for you: run \`connect plan --run\` again now, with no other flag, and the operator's open page carries on${nextLeg ? ` from leg ${nextLeg.leg}` : ""}. Do not ask the operator again: their yes covers every leg. Give the shell call a timeout of at least 9 minutes.`,
    );
  };

  register(
    "connect_plan",
    {
      title: "One acknowledgement for several deposits and withdrawals",
      description:
        'For a request that moves money in more than one vault (any mix of deposits and withdrawals, across chains): ONE acknowledgement for the whole plan instead of one per vault. Runs twice, like `connect deposit`. Pass --legs, e.g. "deposit tlCashPlusUSDC2B 25; withdraw tlCashPlusUSDC2G all" (each leg "deposit <vault> <amount>" or "withdraw <vault> <amount|all>"; "all" redeems the share balance read now). Without --ack it opens NOTHING: every leg is built and checked as its own run would be, and it returns `needs_acknowledgement` with ONE `acknowledgement` covering every leg, to post to the operator word for word, and an `ack` code. Only after the operator replies yes, run it again with the same --legs and --ack <code>: that records the yes, opens nothing, and returns each leg\'s exact command. Then run `connect plan --run`: one signing page walks every leg in order, EVM and Solana legs alike (a leg can also run on a page of its own, as `connect deposit|withdraw … --plan <code> --leg <n>`, which is each leg\'s `command`). A leg that does not complete ends the plan. --status (alone) reports the plan\'s legs and their transactions. Each EVM and Solana leg needs that family\'s wallet connected; money lands only in the connected account.',
      inputSchema: {
        legs: z.string().optional().describe('the plan, in order: legs separated by ";", each "deposit <vault> <amount>" or "withdraw <vault> <amount|all>" — vaults by their ticker, as `earn vaults` lists them; amounts the operator chose'),
        ack: ackArg,
        status: z.boolean().optional().describe("report the current plan and each leg's status and transactions; reads a local file only"),
        run: z
          .boolean()
          .optional()
          .describe("open ONE signing page for every leg of the acknowledged plan (EVM and Solana legs), instead of one page per leg; returns `in_progress` when the shell's time limit is near: run it again and the operator's open page carries on"),
      },
    },
    async ({ legs, ack, status, run }) => {
      if (run) {
        if (legs !== undefined || ack !== undefined || status) throw new Error("--run takes no other flag: it runs the acknowledged plan");
        return runPlanPage();
      }
      if (status) {
        if (legs !== undefined || ack !== undefined) throw new Error("--status takes no other flag");
        const p = readPlan();
        if (!p) return JSON.stringify({ status: "none", next_step: "no plan is pending; `connect plan --legs …` makes one" }, null, 2);
        return JSON.stringify({ status: p.acknowledged ? "acknowledged" : "needs_acknowledgement", code: p.code, expiresAtIso: p.expiresAtIso, legs: p.legs }, null, 2);
      }
      if (legs === undefined) throw new Error('give --legs (e.g. "deposit tlCashPlusUSDC2B 25; withdraw tlCashPlusUSDC2C all"), or --status');
      const described = await describeLegs(legs);
      const digests = described.map((l) => l.d.digest);
      if (ack === undefined) {
        const plan = issuePlan(
          described.map((l, i) => ({ leg: i + 1, action: l.action, vault: l.symbol, chain: l.chain, amount: l.d.summary.amount, digest: l.d.digest, command: "", args: legArgs(l.args) })),
          now(),
        );
        plan.legs = plan.legs.map((x, i) => ({ ...x, command: legCommand(described[i]!, plan.code, i + 1) }));
        writePlan(plan);
        return JSON.stringify(
          {
            status: "needs_acknowledgement",
            opened: false,
            legs: plan.legs.map((x, i) => ({ leg: x.leg, action: x.action, vault: x.vault, chain: x.chain, amount: x.amount, receiver: described[i]!.args.receiver })),
            acknowledgement: planAcknowledgementText(
              described.map((l) => l.d.summary),
              planTotals(described),
            ),
            ack: plan.code,
            expiresAtIso: plan.expiresAtIso,
            next_step: `Post \`acknowledgement\` to the operator word for word, as it is, and wait for their reply. Only an explicit yes they give after reading it is an acknowledgement: not a "go" from before they saw it, and not your own reading of the conversation. On yes, run this same command again, with the same --legs, and --ack ${plan.code} added: that records the yes, opens nothing, and returns each leg's command. On anything else, stop. The plan is good until ${plan.expiresAtIso}; a leg not started by then does not run.`,
          },
          null,
          2,
        );
      }
      const plan = readPlan();
      checkPlanAck(ack, plan, digests, now());
      plan!.acknowledged = true;
      writePlan(plan!);
      return JSON.stringify(
        {
          status: "acknowledged",
          opened: false,
          code: plan!.code,
          expiresAtIso: plan!.expiresAtIso,
          legs: plan!.legs.map((x) => ({ leg: x.leg, action: x.action, vault: x.vault, chain: x.chain, amount: x.amount, command: x.command })),
          next_step:
            "The operator's yes covers every leg: do not ask again between legs. Run `connect plan --run`: it opens ONE signing page that walks every leg in order, and waits up to 9 minutes, so give the shell call a timeout of at least 9 minutes. If it returns `in_progress`, run it again at once: the operator's open page carries on. When it returns any other status, report each leg's result and transactions to the operator.",
        },
        null,
        2,
      );
    },
  );
  return commands;
}
