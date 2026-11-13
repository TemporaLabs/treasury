/**
 * The invest signing page: one local page for one command, through which the owner's own wallet signs or sends each
 * step, one at a time, in the order the command asks for them.
 *
 * The command decides what comes next (a sign-in, an enrolment, a transfer, a withdrawal authorization), so the page
 * does not hold a list. It asks this process for the current step (`/info`), shows it, has the wallet act on it, and
 * posts the result (`/result`). Every step is checked by the command before it is put here; the page only shows it and
 * hands it to the wallet. Each result is checked again here before the command sees it: a signature must recover to the
 * connected owner, and a transaction hash must be a hash. Nothing here signs.
 */
import { getAddress, verifyMessage, verifyTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import { serveOnce, type Handle } from "../connect/http.js";
import { connectPorts, privyAppId } from "../connect/config.js";
import { PAGE_CSP, readPageBundle, shell } from "../connect/page.js";

/** The chain every Smart Growth step is on. */
export const INVEST_CHAIN = { chainId: 56, name: "BNB Chain" } as const;

/** What the page shows for a step: built by the command from the step's own checked bytes, never from the API's words. */
export interface StepView {
  title: string;
  /** One or two plain sentences for the owner. */
  description: string;
  /** Label and value pairs shown under the description. */
  facts: { label: string; value: string }[];
  /** A caution shown above the wallet button, when the step needs one. */
  warning?: string;
}

/** One thing the wallet is asked to do. */
export type WalletAsk =
  | { kind: "sign_text"; message: string }
  | { kind: "sign_bytes"; bytes: Hex }
  | { kind: "sign_typed"; typedData: Record<string, unknown> }
  | { kind: "send"; to: Address; data: Hex; value: "0" };

export interface InvestPage {
  url: string;
  opened: boolean;
  /** Puts one step on the page and waits for the wallet's answer: a signature, or a transaction hash for `send`. */
  ask(view: StepView, ask: WalletAsk): Promise<string>;
  /** Ends the page with what happened, shown to the owner. */
  finish(outcome: { ok: true; text: string } | { ok: false; reason: string }): void;
  done: Promise<unknown>;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]+$/;

export interface InvestPageDeps {
  open: (url: string) => boolean;
  ttlMs: number;
  /** Overrides the offline signature checks (tests). */
  verify?: { message: typeof verifyMessage; typedData: typeof verifyTypedData };
}

/** Opens the page for one owner. The page refuses a wallet other than this owner. */
export async function openInvestPage(ownerInput: string, title: string, deps: InvestPageDeps): Promise<InvestPage> {
  const owner = getAddress(ownerInput);
  const verify = deps.verify ?? { message: verifyMessage, typedData: verifyTypedData };
  let index = 0;
  let current: { index: number; view: StepView; ask: WalletAsk; resolve: (v: string) => void; reject: (e: Error) => void } | undefined;
  let ending: { ok: boolean; text: string } | undefined;
  let handle!: Handle<"done">;

  handle = await serveOnce<"done">({
    mode: "invest",
    ttlMs: deps.ttlMs,
    html: (s) => shell(s, title),
    csp: PAGE_CSP,
    assets: { "/app.js": { type: "text/javascript; charset=utf-8", body: readPageBundle() } },
    ports: connectPorts(),
    info: () => ({
      mode: "invest",
      appId: privyAppId(),
      title,
      owner,
      chainId: INVEST_CHAIN.chainId,
      chainName: INVEST_CHAIN.name,
      ...(current ? { step: { index: current.index, view: current.view, ask: current.ask } } : {}),
      ...(ending ? { ending } : {}),
    }),
    onReject: (body) => {
      const why = typeof body["reason"] === "string" ? body["reason"].slice(0, 300) : "declined in the browser";
      current?.reject(new Error(why));
      current = undefined;
    },
    accept: async (body) => {
      if (!current || body["index"] !== current.index) return { ok: false, reason: "that step is not the one waiting" };
      const { ask } = current;
      const value = body["value"];
      if (typeof value !== "string") return { ok: false, reason: "no signature or hash" };
      if (ask.kind === "send") {
        if (!HASH.test(value)) return { ok: false, reason: "not a transaction hash" };
      } else {
        if (!SIG.test(value)) return { ok: false, reason: "malformed signature" };
        const sig = value as Hex;
        const good =
          ask.kind === "sign_typed"
            ? await verify.typedData({ ...(ask.typedData as unknown as TypedDataDefinition), address: owner, signature: sig }).catch(() => false)
            : await verify.message({ address: owner, message: ask.kind === "sign_text" ? ask.message : { raw: ask.bytes }, signature: sig }).catch(() => false);
        if (!good) return { ok: false, reason: `the signature is not from ${owner}` };
      }
      const resolve = current.resolve;
      current = undefined;
      resolve(value);
      return { ok: true, final: false };
    },
  });

  const opened = deps.open(handle.url);
  void handle.done.then((r) => {
    if (current) {
      current.reject(new Error(r.ok ? "the page closed" : r.reason));
      current = undefined;
    }
  });

  return {
    url: handle.url,
    opened,
    done: handle.done,
    ask: (view, ask) =>
      new Promise<string>((resolve, reject) => {
        if (current) return reject(new Error("a step is already waiting on the page"));
        current = { index: index++, view, ask, resolve, reject };
      }),
    finish: (o) => {
      ending = o.ok ? { ok: true, text: o.text } : { ok: false, text: o.reason };
      // The page reads the ending on its next look, then the flow closes.
      setTimeout(() => handle.settle(o.ok ? { ok: true, value: "done" } : { ok: false, reason: o.reason }), 3_000).unref();
    },
  };
}
