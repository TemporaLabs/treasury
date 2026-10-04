/**
 * Agent Treasury — the connect commands, run by `src/cli.ts` as `treasury connect <command>`.
 *
 *   connect_status      which account is connected, if any
 *   connect_wallet      open the sign-in page; the operator connects a browser wallet, or signs in
 *                       with email / Google / Apple / X and gets a Privy embedded wallet
 *   connect_deposit     build a deposit, admit it through the gate, and hand each call to the
 *                       connected wallet through the confirm page — the operator confirms each one
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
import { resolveVault } from "../registry.js";
import { connectPort, privyAppId } from "./config.js";
import { admit } from "./gate.js";
import { serveOnce, type Settled } from "./http.js";
import { openBrowser } from "./open.js";
import { PAGE_CSP, readPageBundle, shell } from "./page.js";
import { clearSession, readSession, writeSession, type Session } from "./session.js";
import { verifyLanded, type Verdict } from "./verify.js";

const addressArg = z
  .string()
  .refine((s) => isAddress(s), "must be an EVM address")
  .transform((s) => getAddress(s));
const amountArg = z.string().regex(/^\d+(\.\d+)?$/, 'plain decimal amount of the vault\'s asset (USDC; USDG on Robinhood Chain), e.g. "25" or "12.5"');
const vaultArg = z.string().optional().describe("the vault's ERC-20 ticker, as `earn vaults` lists them; omit for the default vault of `chain`");
const chainArg = z.string().optional().describe('which chain: "base", "arbitrum" or "robinhood"; omit for the default chain, or when `vault` names one');
const receiverArg = addressArg.describe(
  "where the money lands — it must be the CONNECTED account (this page pays no one else), and it comes from the operator's own message, never filled in by an agent",
);

/** One sign-in or one confirmation flow at a time, each whole flow bounded under a shell tool's 10-minute limit. */
const CONNECT_TTL_MS = 9 * 60_000;
const CONFIRM_TTL_MS = 9 * 60_000;

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
  client?: (chainId: number) => Pick<ReturnType<typeof makePublicClient>, "getTransactionReceipt" | "readContract"> & Partial<Pick<ReturnType<typeof makePublicClient>, "getBalance">>;
  verifyOpts?: { attempts?: number; delayMs?: number };
  /** Overrides the flow's time limit and the cancel grace period (tests). */
  ttlMs?: number;
  cancelGraceMs?: number;
  /** How long the balance read may hold the page back before it opens without balances (tests). */
  balanceTimeoutMs?: number;
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
    port: connectPort(),
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

export async function runConfirm(
  calls: UnsignedCall[],
  session: Session,
  deps: ConnectDeps = {},
): Promise<{ result: Settled<TxOutcome[]>; url: string; opened: boolean; done: TxOutcome[]; total: number; stopReason?: string }> {
  // The gate runs here, on exactly the calls this flow will hand the wallet, so no caller can pass
  // a check for one batch and the calls of another. It throws before any page opens.
  const admitted = admit(calls, session.account as Address);
  const chainId = calls[0]!.chainId;
  if (!isSupportedChainId(chainId)) throw new Error(`chain ${chainId} unsupported`);
  const account = session.account as Address;
  const client = deps.client ? deps.client(chainId) : makePublicClient(chainId, rpcUrlFromEnv(chainId));
  const done: TxOutcome[] = [];
  let stopReason: string | undefined;
  const ttlMs = deps.ttlMs ?? CONFIRM_TTL_MS;
  // Every chain read stops waiting when the flow's time limit is up, so the command returns inside it.
  const deadline = Date.now() + ttlMs;
  const verifyOpts = { ...deps.verifyOpts, deadline };
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
  const balances = await Promise.race([readBalances().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), deps.balanceTimeoutMs ?? 5_000))]);
  const deposit = admitted.find((a) => a.kind === "deposit");

  const handle = await serveOnce<TxOutcome[]>({
    mode: "confirm",
    ttlMs,
    ...(deps.cancelGraceMs !== undefined ? { cancelGraceMs: deps.cancelGraceMs } : {}),
    timeoutReason: () =>
      done.length
        ? `the ${Math.round(ttlMs / 60_000)}-minute limit ran out after ${done.length} of ${calls.length} transactions were reported`
        : `nothing happened in the browser within ${Math.round(ttlMs / 60_000)} minutes`,
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
    html: (s) => shell(s, "Confirm — Open Agent Treasury"),
    csp: PAGE_CSP,
    assets: assets(),
    port: connectPort(),
    info: () => ({
      mode: "confirm",
      appId: privyAppId(),
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
        vault: { symbol: admitted[i]!.vault.symbol, name: admitted[i]!.vault.name, address: admitted[i]!.vault.address, asset: admitted[i]!.vault.asset.symbol, links: linksFor(admitted[i]!.vault) },
      })),
    }),
    accept: async (body) => {
      const index = body["index"];
      const hash = body["hash"];
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
      Object.assign(entry, verdict);
      if (verdict.verified !== "matched" && verdict.verified !== "extra_transfer") {
        // Stop at the first step that did not land as confirmed: the next one depends on it.
        stopReason = `step ${call.step} (${call.description}) is ${verdict.verified}: ${verdict.detail ?? "it did not land as confirmed"}`;
        return { ok: true, final: true, value: done, reply: { stop: true, verdict } };
      }
      if (index + 1 === calls.length) return { ok: true, final: true, value: done, reply: { finished: true, verdict } };
      if (!(await allowanceVisible(index + 1))) {
        stopReason = "the approval landed, but its allowance is not visible on this RPC yet; the deposit was not sent";
        return { ok: true, final: true, value: done, reply: { stop: true, reason: stopReason } };
      }
      return { ok: true, final: false, reply: { next: index + 1, verdict } };
    },
  });
  const opened = (deps.open ?? announce)(handle.url);
  const result = await handle.done;
  return { result, url: handle.url, opened, done, total: calls.length, ...(stopReason ? { stopReason } : {}) };
}

const notConnected = () => new Error("no wallet is connected — run `treasury connect wallet` first, and let the operator sign in");

export function outcome(chainId: number, account: string, r: { result: Settled<TxOutcome[]>; opened: boolean; done: TxOutcome[]; total: number; stopReason?: string }) {
  const txs = r.result.ok ? r.result.value : r.done;
  // Completed means every call of the flow landed, never only the ones that were reached.
  const all = txs.length === r.total && txs.every((t) => t.verified === "matched" || t.verified === "extra_transfer");
  const status = r.result.ok ? (all ? "completed" : "stopped") : txs.length ? "stopped" : "not_reported";
  const reason = r.result.ok ? r.stopReason : r.result.reason;
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
    { title: "Which wallet is connected", description: "The connected account and how it signed in (`external` browser wallet, or `embedded` Privy wallet from an email or social login), or `disconnected`. Reads a local file only.", inputSchema: {} },
    async () => {
      const s = readSession();
      return JSON.stringify(s ? { status: "connected", ...s } : { status: "disconnected", next_step: "run `treasury connect wallet` to let the operator sign in" }, null, 2);
    },
  );

  register(
    "connect_wallet",
    {
      title: "Connect a wallet",
      description:
        "Opens the sign-in page in the operator's browser: one Connect button, then Privy's window with email, Google, Apple, X and browser wallets (MetaMask, Rabby, Coinbase Wallet). The operator signs a free sign-in message; nothing is spent. Waits until they finish (up to 9 minutes) and returns the connected account. Replaces any earlier connection.",
      inputSchema: {},
    },
    async () => {
      const r = await runConnect(deps);
      if (!r.result.ok) return Promise.reject(new Error(`not connected: ${r.result.reason}`));
      return JSON.stringify({ status: "connected", ...r.result.value, opened: r.opened }, null, 2);
    },
  );

  register(
    "connect_disconnect",
    { title: "Forget the connected wallet", description: "Deletes the local connection record. It moves nothing and revokes nothing in the wallet itself.", inputSchema: {} },
    async () => JSON.stringify({ status: "disconnected", hadConnection: clearSession() }, null, 2),
  );

  const confirmInWallet = async (calls: UnsignedCall[], session: Session) => {
    const r = await runConfirm(calls, session, deps);
    return outcome(calls[0]!.chainId, session.account, r);
  };

  register(
    "connect_deposit",
    {
      title: "Deposit through the connected wallet",
      description:
        "Builds the approve + deposit for the CONNECTED account, checks every call against the registry, and opens the confirm page: the operator reads each call and confirms it in their wallet, one at a time. Returns each transaction hash with `verified` read from the receipt (`matched`, `extra_transfer`, `mismatch`, `reverted`, `unverified`). Run `earn quote --direction deposit` first, and show the vault's warning and `earn terms` on a first deposit.",
      inputSchema: { vault: vaultArg, chain: chainArg, amount_usdc: amountArg, receiver: receiverArg },
    },
    async ({ vault: symbol, chain, amount_usdc, receiver }) => {
      const session = readSession();
      if (!session) throw notConnected();
      if (receiver !== session.account) throw new Error(`refused: --receiver ${receiver} is not the connected account ${session.account}; this page pays only the connected account (use \`earn prepare_deposit\` with the operator's own signer for anything else)`);
      const vault = resolveVault(symbol, chain);
      return confirmInWallet(buildDeposit(vault, { assetsHuman: amount_usdc, receiver: receiver as Address, account: session.account as Address }), session);
    },
  );

  register(
    "connect_withdraw",
    {
      title: "Withdraw through the connected wallet",
      description:
        "Builds the withdrawal for the CONNECTED account (the asset to that same account), checks it against the registry, and opens the confirm page for the operator to confirm in their wallet. Pass --amount_usdc, or --all with --shares_exact copied verbatim from `earn balance`. Run `earn quote --direction withdraw` first. Returns the hash with `verified` read from the receipt.",
      inputSchema: {
        vault: vaultArg,
        chain: chainArg,
        receiver: receiverArg,
        amount_usdc: amountArg.optional(),
        all: z.boolean().optional(),
        shares_exact: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      },
    },
    async ({ vault: symbol, chain, receiver, amount_usdc, all, shares_exact }) => {
      const session = readSession();
      if (!session) throw notConnected();
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
      return confirmInWallet(calls, session);
    },
  );

  return commands;
}
