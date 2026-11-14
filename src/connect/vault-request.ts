/**
 * A vault deposit or withdrawal on an EVM chain, carried through the confirm page as a request of the Tempora API.
 *
 * The API prepares each step; nothing it says about a step is trusted. The whole request is held by the client's own
 * `checkSteps` to what the operator acknowledged (the vault the API lists, the connected owner, the exact amount) when
 * it starts and again every time it is read, and the page is handed only a step that passed: its `to`, `data` and
 * `value`, which it sends unchanged on the step's chain. The page posts the hash it got from the wallet; this process
 * hands that hash to the API (`submit`), and reads the request again (`status`) until the step has landed and the next
 * one is `ready`, or the request has settled. The API reads the chain itself at that hash and says how the step landed.
 *
 * The guards are `invest`'s (`../invest/flow.ts`), for a flow the page drives rather than the command:
 *   - a step re-issued after it was sent is never put to the wallet again: the leg stops and names the hash;
 *   - a hash the page could not hand over normally (`sent_unrecorded`) is still submitted, by that hash, once;
 *   - a submit the API refuses after a send stops the leg with the hash, and says not to send it again;
 *   - a request that stops passing the check stops the leg, and nothing more is sent.
 */
import { checkSteps, type Client, type DepositBody, type Request, type Result, type WithdrawBody } from "@temporalabs/client";
import type { McpClient } from "@temporalabs/client/mcp";
import { formatUnits, getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { CHAIN_INFO, chains, type SupportedChainId } from "../client.js";
import { DISCLOSURES } from "../disclosures.js";
import { assetsAmount, chainOf, shortAddress, tickerOf, vaultLabel, verifiedTerms, type VaultProduct } from "../earn/api.js";
import { describeStep, depositIntent, withdrawIntent, type WithdrawAmount } from "../earn/request.js";
import { failure } from "../invest/api.js";
import { FINAL_STATES } from "../invest/flow.js";
import { explorerTxUrl } from "../links.js";
import { parseAmount } from "../units.js";
import { operatorWarning, type AckSummary } from "./ack.js";
import type { Session } from "./session.js";
import type { Verdict } from "./verify.js";

/** One owner call to the API's MCP endpoint, with the owner's token. */
export type OwnerCall = <T>(fn: (m: McpClient, ownerToken: string) => Promise<Result<T>>) => Promise<Result<T>>;

/** What the operator asked for, in the form a connect command takes it. */
export interface VaultAsk {
  action: "deposit" | "withdraw";
  amount_usdc?: string | undefined;
  all?: boolean | undefined;
  shares_exact?: string | undefined;
}

/** A leg as it is acknowledged and run: the vault the API lists, the request body, and the intent every step is held to. */
export interface VaultLeg {
  product: VaultProduct;
  chainId: SupportedChainId;
  action: "deposit" | "withdraw";
  body: DepositBody | WithdrawBody;
  /** The withdrawal's form, for the check; a deposit's raw amount is in `body`. */
  form: { kind: "deposit"; raw: bigint } | { kind: "withdraw"; amount: WithdrawAmount };
  digest: string;
  summary: AckSummary;
}

/** The asset the vault takes, by the symbol the API lists for it. */
const assetSymbol = (p: VaultProduct) => p.tokens[0] ?? "the vault's asset";

/** The vault as the pages name it: its ticker, or its contract address shortened when it has none. Never the API's product id. */
const pageSymbol = (p: VaultProduct) => tickerOf(p.vault.vaultAddress, chainOf(p).chainId) ?? shortAddress(p.vault.vaultAddress);

/**
 * The leg for `ask` on `p`, for the connected `owner`: its body, the intent its steps are held to, and the digest the
 * acknowledgement binds. A deposit carries the vault's terms, verified here against their own sha256: the version and
 * sha256 the operator acknowledges are the ones the deposit sends.
 */
export function vaultLeg(p: VaultProduct, owner: Address, ask: VaultAsk): VaultLeg {
  const c = chainOf(p);
  if (c.chainId === null) throw new Error(`refused: ${vaultLabel(p)} is on ${c.caip2}, a chain this client does not support`);
  const chainId = c.chainId as SupportedChainId;
  const sym = assetSymbol(p);
  let body: DepositBody | WithdrawBody;
  let form: VaultLeg["form"];
  let amount: string;
  let terms: { version: string; sha256: string } | undefined;
  if (ask.action === "deposit") {
    const t = verifiedTerms(p);
    terms = { version: t.version, sha256: t.sha256 };
    const a = assetsAmount(p, ask.amount_usdc!);
    body = { product: p.id, amount: a.amount, vaultTerms: terms };
    form = { kind: "deposit", raw: a.raw };
    amount = `${formatUnits(a.raw, p.vault.assetDecimals)} ${sym}`;
  } else if (ask.all && ask.shares_exact === undefined) {
    body = { product: p.id, amount: { kind: "all" } };
    form = { kind: "withdraw", amount: { kind: "all" } };
    amount = `your whole position in ${pageSymbol(p)}, as it stands when the withdrawal runs`;
  } else if (ask.all) {
    const raw = parseAmount(ask.shares_exact!, p.vault.shareDecimals, "shares_exact");
    body = { product: p.id, amount: { kind: "shares", raw: raw.toString() } };
    form = { kind: "withdraw", amount: { kind: "shares", raw: raw.toString() } };
    amount = `${formatUnits(raw, p.vault.shareDecimals)} ${pageSymbol(p)} shares (the amount given; it is the whole position only if it equals the account's share balance, which is not checked here)`;
  } else {
    const a = assetsAmount(p, ask.amount_usdc!);
    body = { product: p.id, amount: a.amount };
    form = { kind: "withdraw", amount: { kind: "assets", raw: a.amount.raw } };
    amount = `${formatUnits(a.raw, p.vault.assetDecimals)} ${sym}`;
  }
  const amountKey = form.kind === "deposit" ? ["assets", form.raw.toString()] : form.amount.kind === "all" ? ["all"] : [form.amount.kind, form.amount.raw];
  const digest = keccak256(stringToHex(JSON.stringify(["api", owner, p.id, p.vault.chain, p.vault.vaultAddress, p.vault.assetAddress, ask.action, amountKey, terms?.version ?? null, terms?.sha256 ?? null])));
  const summary: AckSummary = {
    action: ask.action,
    amount,
    asset: sym,
    chain: CHAIN_INFO[chainId].name,
    chainId,
    vault: { symbol: pageSymbol(p), name: p.name, address: p.vault.vaultAddress, explorer: p.vaultLinks?.explorer ?? "" },
    receiver: owner,
    warning: operatorWarning(p.warnings.join(" "), ask.action),
    // A vault the API gates by an allowlist takes deposits only from accounts admitted to it: said before a deposit.
    disclosures:
      ask.action === "deposit"
        ? [...DISCLOSURES.plain.deposit, ...(p.gates?.includes("allowlist") ? [DISCLOSURES.plain.gatedDeposit] : []), ...DISCLOSURES.plain.always]
        : [...DISCLOSURES.plain.always],
    ...(terms ? { terms } : {}),
  };
  return { product: p, chainId, action: ask.action, body, form, digest, summary };
}

const intentOf = (leg: VaultLeg, owner: Address) =>
  leg.form.kind === "deposit" ? depositIntent(leg.product, owner, leg.form.raw) : withdrawIntent(leg.product, owner, leg.form.amount);

type Step = Request["steps"][number];
type Sendable = { to: Address; data: Hex; value: string; generation?: number };
const payloadOf = (s: Step): Sendable | undefined => (s as { payload?: Sendable }).payload;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const LANDED = ["landed", "completed"];
const FAILED: Record<string, Verdict["verified"]> = { reverted: "reverted", failed: "reverted", mismatch: "mismatch", replaced: "mismatch" };

/** One transaction as the leg reports it: the step it was sent for, and how it landed as the API read it. */
export interface VaultTx extends Verdict {
  step: number;
  stepId: string;
  description: string;
  hash: string;
}

export interface VaultCoreDeps {
  call: OwnerCall;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the request is read while a step lands. */
  pollMs?: number;
}

/** The confirm flow for one leg, in the shape the confirm and plan pages drive (`ConfirmCore` in `commands.ts`). */
export interface VaultCore {
  chainId: number;
  done: VaultTx[];
  requestId: string;
  total: () => number;
  stopReason: () => string | undefined;
  info: () => Record<string, unknown>;
  accept: (index: unknown, hash: unknown) => Promise<{ ok: false; reason: string } | { ok: true; kind: "next" | "finished" | "stop"; reply: Record<string, unknown> }>;
  onReject: (body: Record<string, unknown>) => void;
  /** Waits for every hash still being handed to the API; cancels the request when nothing was sent for it. */
  settle: () => Promise<void>;
}

/**
 * Starts the leg's request with the API and checks it, before any page shows a step of it. Throws, having sent
 * nothing, when the API does not start it or the request fails the check; a request that fails the check is cancelled.
 */
export async function startVaultCore(leg: VaultLeg, session: Session, deps: VaultCoreDeps, deadline: number): Promise<VaultCore> {
  const owner = getAddress(session.account);
  const intent = intentOf(leg, owner);
  const p = leg.product;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 3_000;
  const started = await deps.call((m, ownerToken) => (leg.action === "deposit" ? m.deposit({ body: leg.body as DepositBody }, { ownerToken }) : m.withdraw({ body: leg.body as WithdrawBody }, { ownerToken })));
  if (!started.ok) throw failure(`The API did not start the ${leg.action} on ${vaultLabel(p)}`, started);
  let request = started.body;
  const rid = request.requestId;
  const read = `\`treasury earn request --request_id ${rid}\``;
  const cancel = () => deps.call((m, ownerToken) => m.cancel({ path: { requestId: rid } }, { ownerToken })).catch(() => undefined);
  const first = checkSteps(request.steps as never, intent);
  if (!first.ok) {
    await cancel();
    throw new Error(`refused${first.step !== null ? ` (step ${first.step + 1} of ${request.steps.length})` : ""}: ${first.reason}. Nothing was sent, and request ${rid} was cancelled`);
  }

  const done: VaultTx[] = [];
  /** Each step the wallet sent, by id: a step is never put to the wallet twice. */
  const sent = new Map<string, string>();
  const pending: Promise<unknown>[] = [];
  let stopReason: string | undefined;
  const known = (h: string) => done.some((t) => t.hash.toLowerCase() === h.toLowerCase());

  /** The steps as the page shows them: what to send only for a checked step that is ready and was not sent. */
  const calls = () =>
    request.steps.map((s, i) => {
      const payload = payloadOf(s);
      const sendable = payload !== undefined && s.state === "ready" && !sent.has(s.stepId);
      const d = payload ? describeStep(p, payload.to, payload.data) : undefined;
      const purpose = (s as { purpose?: string }).purpose;
      const after = (s as { after?: string }).after;
      return {
        step: i + 1,
        of: request.steps.length,
        stepId: s.stepId,
        state: s.state,
        kind: d?.call ?? (purpose === "approve" || purpose === "withdraw" || purpose === "redeem" ? purpose : leg.action),
        description: d?.description ?? (after !== undefined ? `prepared once step ${request.steps.findIndex((x) => x.stepId === after) + 1} is sent and recorded` : "not ready yet"),
        // Only a checked, ready step carries something to send; the page sends exactly these.
        to: sendable ? payload.to : "",
        data: sendable ? payload.data : "",
        value: sendable ? payload.value : "0",
        ...(d ? { function: d.function, args: d.args } : {}),
        vault: { symbol: pageSymbol(p), name: p.name, address: p.vault.vaultAddress, asset: assetSymbol(p), assetAddress: p.vault.assetAddress, links: { explorer: leg.summary.vault.explorer } },
      };
    });

  /** Hands a hash to the API. A refusal after a send is a stop that names the hash and says not to send it again. */
  const submit = async (stepId: string, hash: string): Promise<string | undefined> => {
    const r = await deps.call((m, ownerToken) => m.submit({ path: { requestId: rid, stepId }, body: { kind: "transaction", txHash: hash, wallet: null } }, { ownerToken }));
    if (r.ok) {
      request = r.body;
      return undefined;
    }
    return `the transaction was sent from your wallet (${hash}), but the API did not record it: ${r.error.code}: ${r.error.message}. Do not send it again: check it on ${CHAIN_INFO[leg.chainId].name}, and read the request with ${read}`;
  };

  /** Reads the request again and holds it to the intent; a refusal says nothing more was sent. */
  const refresh = async (): Promise<string | undefined> => {
    const r = await deps.call((m, ownerToken) => m.status({ path: { requestId: rid } }, { ownerToken }));
    if (!r.ok) return failure(`Request ${rid} could not be read`, r).message;
    request = r.body;
    return undefined;
  };
  const checked = (): string | undefined => {
    const c = checkSteps(request.steps as never, intent);
    if (!c.ok) return `refused${c.step !== null ? ` (step ${c.step + 1} of ${request.steps.length})` : ""}: ${c.reason}. Nothing more was sent; read the request with ${read}`;
    // A step sent once and put up again (a new generation, or ready again) is never sent twice.
    const again = request.steps.find((s) => sent.has(s.stepId) && s.state === "ready" && payloadOf(s) !== undefined);
    if (again) return `refused: the API asks for step ${again.stepId} again after it was sent (transaction ${sent.get(again.stepId)}); not sent twice. Read the request with ${read}`;
    return undefined;
  };

  const verdictOf = (s: Step): Verdict => {
    const v = (s as { verification?: { alsoMoved?: { to: string; amountRaw: string }[]; message?: string } }).verification;
    if (FAILED[s.state]) return { verified: FAILED[s.state]!, detail: v?.message ?? `the API reads this step as ${s.state}` };
    if (LANDED.includes(s.state)) return v?.alsoMoved?.length ? { verified: "extra_transfer", alsoMoved: v.alsoMoved, detail: "the wallet moved more than this call in the same transaction" } : { verified: "matched" };
    return { verified: "unverified", detail: `the API reads this step as ${s.state}; read the request with ${read}` };
  };

  return {
    chainId: leg.chainId,
    done,
    requestId: rid,
    total: () => request.steps.length,
    stopReason: () => stopReason,
    info: () => ({
      account: owner,
      walletType: session.walletType,
      chainId: leg.chainId,
      chainName: CHAIN_INFO[leg.chainId].name,
      next: done.length,
      txBase: explorerTxUrl(leg.chainId, ""),
      asset: { symbol: assetSymbol(p), decimals: p.vault.assetDecimals },
      nativeSymbol: chains[leg.chainId].nativeCurrency.symbol,
      requestId: rid,
      calls: calls(),
    }),
    // The page reports a hash it could not hand over (its POST failed after the wallet sent): the transaction may have
    // gone out, so it is put on record and still handed to the API, by that hash, once.
    onReject: (body) => {
      const hash = body["hash"];
      if (typeof hash !== "string" || !HASH.test(hash) || known(hash)) return;
      const i = body["index"];
      const s = typeof i === "number" && Number.isInteger(i) ? request.steps[i] : undefined;
      const entry: VaultTx = {
        step: s ? request.steps.indexOf(s) + 1 : 0,
        stepId: s?.stepId ?? "",
        description: s ? (calls()[request.steps.indexOf(s)]?.description ?? "") : "a transaction the page reported for no known step",
        hash,
        verified: "unverified",
        detail: `the page reported this transaction but could not hand it over; read the request with ${read} before retrying anything`,
      };
      done.push(entry);
      if (s && !sent.has(s.stepId)) {
        sent.set(s.stepId, hash);
        pending.push(
          submit(s.stepId, hash).then(
            (why) => void (why && (entry.detail = why)),
            () => undefined,
          ),
        );
      }
    },
    accept: async (index, hash) => {
      if (index !== done.length) return { ok: false, reason: `expected step ${done.length + 1}` };
      if (typeof hash !== "string" || !HASH.test(hash)) return { ok: false, reason: "malformed transaction hash" };
      if (known(hash)) return { ok: false, reason: "this transaction hash was already reported for an earlier step" };
      const s = request.steps[index];
      if (!s || s.state !== "ready" || payloadOf(s) === undefined || sent.has(s.stepId)) return { ok: false, reason: `step ${index + 1} is not ready to send` };
      const description = calls()[index]!.description;
      // On record before the API is asked: whatever ends the flow from here on, the command reports this transaction.
      const entry: VaultTx = { step: index + 1, stepId: s.stepId, description, hash, verified: "unverified", detail: "the flow ended while this transaction was being recorded" };
      done.push(entry);
      sent.set(s.stepId, hash);
      const stop = (why: string, verdict?: Verdict) => {
        stopReason = why;
        if (verdict) {
          delete entry.detail;
          Object.assign(entry, verdict);
        } else entry.detail = why;
        return { ok: true as const, kind: "stop" as const, reply: { stop: true, reason: why, verdict: { verified: entry.verified, detail: entry.detail } } };
      };
      const refused = await submit(s.stepId, hash);
      if (refused) return stop(refused);
      for (;;) {
        const bad = checked();
        if (bad) return stop(bad);
        const mine = request.steps.find((x) => x.stepId === s.stepId);
        if (!mine) return stop(`request ${rid} no longer has step ${s.stepId}; read it with ${read}`);
        const v = verdictOf(mine);
        if (v.verified === "reverted" || v.verified === "mismatch") return stop(`step ${index + 1} (${description}) is ${v.verified}: ${v.detail}`, v);
        if (FINAL_STATES.includes(request.state)) {
          if (request.state !== "completed") return stop(`request ${rid} ended as ${request.state}; read it with ${read}`, v);
          delete entry.detail;
          Object.assign(entry, v);
          return { ok: true, kind: "finished", reply: { finished: true, verdict: v } };
        }
        const nextReady = request.steps.find((x, j) => j > index && x.state === "ready" && payloadOf(x) !== undefined && !sent.has(x.stepId));
        if (v.verified !== "unverified" && nextReady) {
          delete entry.detail;
          Object.assign(entry, v);
          return { ok: true, kind: "next", reply: { next: index + 1, verdict: v } };
        }
        if (now() + pollMs >= deadline) return stop(`step ${index + 1} was sent and recorded, but request ${rid} is still ${request.state}; read it with ${read}`);
        await sleep(pollMs);
        const unread = await refresh();
        if (unread) return stop(`${unread}; transaction ${hash} was recorded. Do not send it again`);
      }
    },
    settle: async () => {
      await Promise.all(pending);
      // Nothing was sent for it: the request is withdrawn, so it does not hold back the next one.
      if (sent.size === 0 && !FINAL_STATES.includes(request.state)) await cancel();
    },
  };
}

/** A sign-in that never opens a page: past the start of a flow, an expired token stops the flow instead. */
export const noPageSignIn = async (): Promise<string> => {
  throw new Error("the Tempora API asked the wallet to sign in again while the signing page was open; run the command again");
};

/** For the type checker: the HTTP client signs in, the MCP client does everything else. */
export type ApiClients = { mcp: McpClient; http: Client };
