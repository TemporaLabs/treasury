/**
 * How an `invest` command carries a request through: the owner's own wallet, on the signing page (`page.ts`), signs or
 * sends each step the API returns, after the command has checked it, and the command hands the result back to the API.
 *
 * The page opens only when the wallet is first needed: a command whose owner token is still good, and which has nothing
 * to sign, never opens one.
 *
 * A transfer the wallet sent is never sent again by this code. When its hash could not be recorded with the API, the
 * command stops and says so, with the hash: whether it landed is a question for the chain and `invest request`, never
 * for a second transfer.
 */
import type { Client, Request, Result } from "@temporalabs/client";
import { getAddress, type Address, type Hex } from "viem";
import { INVEST } from "../config/invest.js";
import { openBrowser } from "../connect/open.js";
import { asOwner, failure, type MessageSigner } from "./api.js";
import { checkChallenge } from "./challenge.js";
import { openInvestPage, type Answer, type InvestPage, type StepView, type WalletAsk } from "./page.js";
import { apiHost } from "./api.js";

/** The states that end a request. */
export const FINAL_STATES: readonly string[] = ["completed", "partial", "failed", "cancelled"];

/** The owner's wallet, through the signing page, opened on first use. */
export interface OwnerWallet {
  /** Signs the API's sign-in message, already checked by `asOwner`. */
  signIn: MessageSigner;
  ask(view: StepView, ask: WalletAsk): Promise<Answer>;
  /** Shows the ending on the page, when one was opened, and waits for it to close. */
  finish(outcome: { ok: true; text: string } | { ok: false; reason: string }): Promise<void>;
  /** The page's address, once opened. */
  url(): string | undefined;
}

export interface WalletDeps {
  open?: (url: string) => boolean;
  ttlMs?: number;
  openPage?: typeof openInvestPage;
  now?: () => number;
}

/** Opens the page, or says where it is when no browser could be opened from here. */
function announce(url: string): boolean {
  const opened = openBrowser(url);
  process.stderr.write(`${opened ? "Opened" : "Open this page in a browser on this machine"}: ${url}\n`);
  return opened;
}

export function ownerWallet(ownerInput: string, title: string, deps: WalletDeps = {}): OwnerWallet {
  const owner = getAddress(ownerInput);
  const now = deps.now ?? Date.now;
  let page: Promise<InvestPage> | undefined;
  const opened = () => (page ??= (deps.openPage ?? openInvestPage)(owner, title, { open: deps.open ?? announce, ttlMs: deps.ttlMs ?? INVEST.pageTtlMs }));
  let shown: string | undefined;

  const ask = async (view: StepView, a: WalletAsk): Promise<Answer> => {
    const p = await opened();
    shown = p.url;
    return p.ask(view, a);
  };

  return {
    ask,
    url: () => shown,
    signIn: async (signer: Address, message: string) => {
      // `asOwner` has checked the message line by line; the facts shown are read from it again, never from the API.
      const c = checkChallenge(message, { host: apiHost(), owner: signer, now: now() });
      const a = await ask(
        {
          title: "Sign in to the Tempora API",
          description: "This signature proves you hold this wallet, so the API answers for your account. It costs no gas and moves nothing.",
          facts: [
            { label: "API", value: apiHost() },
            { label: "Wallet", value: getAddress(signer) },
            { label: "Valid until", value: c.expiresAt.toISOString() },
          ],
        },
        { kind: "sign_text", message },
      );
      if (a.kind !== "answered") throw new Error("the sign-in was not signed");
      return a.value;
    },
    finish: async (o) => {
      if (!page) return;
      const p = await page;
      p.finish(o);
      await p.done;
    },
  };
}

/** A step the command is ready to put to the wallet, as the command itself describes it. */
export interface Prepared {
  view: StepView;
  ask: WalletAsk;
}

export interface DriveDeps {
  client: Client;
  wallet: OwnerWallet;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  watchMs: number;
  pollMs: number;
}

export interface Driven {
  request: Request;
  /** True when the request reached a final state while the command watched it. */
  settled: boolean;
  /** Each step the wallet acted on: its id, and the signature or transaction hash. */
  acted: { stepId: string; kind: WalletAsk["kind"]; value: string }[];
}

type Step = Request["steps"][number];
const payloadOf = (s: Step): { generation?: unknown } | undefined => (s as { payload?: { generation?: unknown } }).payload;

/**
 * Carries a request through. Before every step is put to the wallet, the whole request is checked again (`check`): a
 * request the API changed between two steps is held to the same intent. A step is prepared (`prepare`) only from the
 * checked request. A refused check stops the command, and nothing more is signed or sent.
 */
export async function drive(
  first: Request,
  owner: Address,
  o: {
    check: (r: Request) => { ok: true } | { ok: false; step: number | null; reason: string };
    prepare: (r: Request, s: Step) => Prepared;
  },
  deps: DriveDeps,
): Promise<Driven> {
  const call = <T>(fn: (c: Client, token: string) => Promise<Result<T>>) => asOwner(owner, deps.wallet.signIn, fn, { client: deps.client, now: deps.now });
  const acted: Driven["acted"] = [];
  const answered = new Set<string>();
  let request = first;
  let watchUntil = deps.now() + deps.watchMs;

  for (;;) {
    const c = o.check(request);
    if (!c.ok) {
      throw new Error(`refused${c.step !== null ? ` (step ${c.step + 1} of ${request.steps.length})` : ""}: ${c.reason}. Nothing more was signed or sent; request ${request.requestId}`);
    }
    if (FINAL_STATES.includes(request.state)) return { request, settled: true, acted };

    const next = request.steps.find((s) => s.state === "ready" && payloadOf(s) !== undefined && !answered.has(`${s.stepId}#${String(payloadOf(s)?.generation)}`));
    if (next) {
      if (acted.length >= INVEST.maxSteps) throw new Error(`refused: request ${request.requestId} asks for more than ${INVEST.maxSteps} steps`);
      const { view, ask } = o.prepare(request, next);
      const answer = await deps.wallet.ask(view, ask).catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        // A send that ended without a hash may still have gone out: the request is named, so it can be read before anything is retried.
        throw new Error(ask.kind === "send" ? `${why}; request ${request.requestId}: read it with \`treasury invest request\` before trying again` : why);
      });
      answered.add(`${next.stepId}#${String(payloadOf(next)?.generation)}`);
      const value = answer.kind === "answered" ? answer.value : answer.hash;
      acted.push({ stepId: next.stepId, kind: ask.kind, value });
      const body =
        ask.kind === "send"
          ? // The wallet's own view of the transaction is not read here: the API reads the chain itself, at this hash.
            ({ kind: "transaction", txHash: value as Hex, wallet: null } as const)
          : ({ kind: "signature", signature: value } as const);
      const r = await call((cl, token) => cl.submit({ path: { requestId: request.requestId, stepId: next.stepId }, body }, { ownerToken: token }));
      if (!r.ok) {
        if (ask.kind === "send") {
          throw new Error(
            `the transfer was sent from your wallet (transaction ${value}), but the API did not record it: ${r.error.code}: ${r.error.message}. ` +
              `Do not send it again. Check the transaction on BNB Chain, and read request ${request.requestId} with \`treasury invest request\`.`,
          );
        }
        throw failure(`The API did not take step ${next.stepId} of request ${request.requestId}`, r);
      }
      request = r.body;
      watchUntil = deps.now() + deps.watchMs;
      continue;
    }

    // Nothing for the wallet: the request is settling (a transfer landing, a withdrawal running). Read it again.
    if (deps.now() >= watchUntil) return { request, settled: false, acted };
    await deps.sleep(deps.pollMs);
    const r = await call((cl, token) => cl.status({ path: { requestId: request.requestId } }, { ownerToken: token }));
    if (!r.ok) throw failure(`Request ${request.requestId} could not be read`, r);
    request = r.body;
  }
}

/** The request as the operator reads it: its state, and each step's kind and state. Never a payload. */
export function summary(r: Request) {
  return {
    requestId: r.requestId,
    action: r.action,
    state: r.state,
    ...(r.smartAccount !== undefined && { smartAccount: r.smartAccount }),
    ...(r.warning ? { warning: r.warning } : {}),
    steps: r.steps.map((s) => {
      const v = (s as { verification?: unknown }).verification;
      return { stepId: s.stepId, kind: s.kind, state: s.state, ...(v !== undefined && { verification: v }) };
    }),
    expiresAt: r.expiresAt,
  };
}
