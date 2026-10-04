import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, isAddress, verifyMessage } from "viem";
import { base } from "viem/chains";
import { BASE_CHAIN_HEX, BASE_CHAIN_ID, connectPort, privyAppId } from "./config.ts";
import { describeCall } from "./decode.ts";
import type { Call } from "./decode.ts";
import { serveOnce } from "./http.ts";
import type { Handle, ServeDeps } from "./http.ts";
import { CONFIRM_HTML, PLAIN_CSP, PRIVY_CSP, privyShell } from "./pages.ts";

const rpcClient = () => createPublicClient({ chain: base, transport: http(process.env.TREASURY_RPC_BASE || process.env.BASE_RPC_URL || undefined) });

// A connected wallet is either an external one (a browser extension) or the Privy embedded wallet
// created by a Google/email login. Both prove the address by signing the server's challenge; neither
// is ever signed for by this process: the operator's own wallet, or Privy's modal, signs each send.
// `walletName` is the wallet the operator signed in with (e.g. "MetaMask"), so the confirm page can offer only that one.
export type Connected = { account: string; chainId: number; walletType: "external" | "embedded"; walletName?: string };

type Verified = { verified: "matched" | "mismatch" | "unverified"; detail?: string };
export type Confirmed = { hash: string } & Verified;

export interface ConnectDeps extends ServeDeps {
  verifySignature?: (a: { address: `0x${string}`; message: string; signature: `0x${string}` }) => Promise<boolean>;
  readBundle?: () => string | Buffer;
  port?: number;
}

export interface ConfirmDeps extends ServeDeps {
  readBundle?: () => string | Buffer;
  port?: number;
  getTransaction?: (hash: `0x${string}`) => Promise<{ from: string; to: string | null; input: string; value: bigint }>;
}

async function defaultVerifySignature(a: { address: `0x${string}`; message: string; signature: `0x${string}` }): Promise<boolean> {
  try {
    if (await verifyMessage(a)) return true;
  } catch {
    // Fall through to the on-chain check, which also covers smart-contract wallets (ERC-1271).
  }
  try {
    return await rpcClient().verifyMessage(a);
  } catch {
    return false;
  }
}

const defaultReadBundle = (): Buffer => {
  try {
    return readFileSync(new URL("./privy-page.js", import.meta.url));
  } catch {
    throw new Error("the Google/email sign-in page is not built (dist/privy-page.js is missing) — run `npm run build`");
  }
};

export function signInMessage(a: { address: string; origin: string; nonce: string; issuedAt: string }): string {
  return [
    `${new URL(a.origin).host} wants you to sign in with your Ethereum account:`,
    a.address,
    "",
    "Connect this wallet to Tempora Treasury. This signature costs no gas and authorizes no transaction.",
    "",
    `URI: ${a.origin}`,
    "Version: 1",
    `Chain ID: ${BASE_CHAIN_ID}`,
    `Nonce: ${a.nonce}`,
    `Issued At: ${a.issuedAt}`,
  ].join("\n");
}

// One connect page. /connect serves the Privy bundle: one "Connect" button, one modal with email,
// Google and browser wallets. Whichever wallet results signs the server's challenge, and the
// signature is checked locally; Privy's login is never trusted for who controls the address.
export async function startConnect(deps: ConnectDeps = {}): Promise<Handle<Connected>> {
  const verify = deps.verifySignature ?? defaultVerifySignature;
  const bundle = (deps.readBundle ?? defaultReadBundle)();
  return serveOnce<Connected>(
    {
      mode: "connect",
      ttlMs: 10 * 60_000,
      pages: {
        "/connect": { html: privyShell, csp: PRIVY_CSP },
      },
      assets: { "/app.js": { type: "text/javascript; charset=utf-8", body: bundle } },
      info: () => ({ mode: "connect", appId: privyAppId() }),
      challenge: (address, origin, nonce) => signInMessage({ address, origin, nonce, issuedAt: new Date().toISOString() }),
      accept: async (body, ctx) => {
        if (typeof body.address !== "string" || !isAddress(body.address)) return { ok: false, reason: "not an address" };
        const address = getAddress(body.address);
        if (body.kind === "external" || body.kind === "embedded") {
          if (!ctx.message || ctx.challengedAddress !== address) return { ok: false, reason: "no sign-in message was issued for this address" };
          if (body.chainId !== BASE_CHAIN_HEX) return { ok: false, reason: "the wallet is not on Base" };
          if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return { ok: false, reason: "malformed signature" };
          const ok = await verify({ address, message: ctx.message, signature: body.signature as `0x${string}` });
          const walletName = typeof body.walletName === "string" ? body.walletName.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60) : "";
          return ok ? { ok: true, value: { account: address, chainId: BASE_CHAIN_ID, walletType: body.kind, ...(walletName ? { walletName } : {}) } } : { ok: false, reason: "the signature does not match the address" };
        }
        return { ok: false, reason: "unknown sign-in kind" };
      },
      port: deps.port ?? connectPort(),
      // Privy lists origins by exact string, and `localhost` is the host it documents for local pages.
      hostname: "localhost",
    },
    deps,
  );
}

// A wallet that relays calls inside a smart-account batch produces a wrapper transaction. Say what
// is inside it, including any transfer riding along, rather than calling the mismatch a glitch.
export function describeWrapped(input: string, call: Call): string {
  const hex = input.toLowerCase().replace(/^0x/, "");
  const includesRequested = hex.includes(call.data.toLowerCase().replace(/^0x/, ""));
  const transfers: string[] = [];
  const re = /a9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})/g;
  for (let m = re.exec(hex); m; m = re.exec(hex)) transfers.push(`transfer(0x${m[1]}, ${BigInt(`0x${m[2]}`)} raw units)`);
  const unique = [...new Set(transfers)];
  return (
    `the transaction on chain is a wrapped batch, not the requested call: the requested call is ${includesRequested ? "inside it" : "NOT found inside it"}` +
    (unique.length ? `, and it also contains ${unique.join("; ")} that you did not ask for` : "")
  );
}

export async function verifyLanded(hash: `0x${string}`, call: Call, account: string, deps: Pick<ConfirmDeps, "getTransaction"> = {}): Promise<Verified> {
  const get = deps.getTransaction ?? ((h: `0x${string}`) => rpcClient().getTransaction({ hash: h }));
  for (let i = 0; i < 8; i++) {
    try {
      const tx = await get(hash);
      const ok =
        tx.from.toLowerCase() === account.toLowerCase() &&
        (tx.to ?? "").toLowerCase() === call.to.toLowerCase() &&
        tx.input.toLowerCase() === call.data.toLowerCase() &&
        tx.value === BigInt(call.value ?? "0x0");
      return ok ? { verified: "matched" } : { verified: "mismatch", detail: describeWrapped(tx.input, call) };
    } catch {
      await new Promise((r) => setTimeout(r, deps.getTransaction ? 5 : 2000));
    }
  }
  return { verified: "unverified" };
}

// Every send goes through this one-shot confirmation page, whichever wallet is connected. An
// external wallet gets its own prompt after the click. An embedded wallet loads the Privy bundle on
// this page and sends from the browser: Privy's own modal is the signature, and nothing here holds
// a key or signs for it.
export async function startConfirm(call: Call, session: Connected, deps: ConfirmDeps = {}): Promise<Handle<Confirmed>> {
  const full: Call = { to: call.to, data: call.data, value: call.value ?? "0x0" };
  const decoded = describeCall(full, session.account);
  const embedded = session.walletType === "embedded";
  const bundle = embedded ? (deps.readBundle ?? defaultReadBundle)() : undefined;
  return serveOnce<Confirmed>(
    {
      mode: "confirm",
      ttlMs: 3 * 60_000,
      pages: { "/confirm": embedded ? { html: privyShell, csp: PRIVY_CSP } : { html: CONFIRM_HTML, csp: PLAIN_CSP } },
      ...(bundle ? { assets: { "/app.js": { type: "text/javascript; charset=utf-8", body: bundle } } } : {}),
      info: () => ({ mode: "confirm", signer: embedded ? "privy" : "wallet", appId: privyAppId(), account: session.account, walletName: session.walletName ?? null, call: full, decoded }),
      // Privy accepts one exact origin and keeps its login in that origin's storage, so an embedded
      // wallet's confirmation must be served from the same host and port as the connect page. An
      // external wallet gets the same origin so its extension keeps the approval given at sign-in.
      port: deps.port ?? connectPort(),
      hostname: "localhost",
      accept: async (body) => {
        if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) return { ok: false, reason: "the wallet returned something that is not a transaction hash" };
        const hash = body.hash;
        const checked = await verifyLanded(hash as `0x${string}`, full, session.account, deps);
        return { ok: true, value: { hash, ...checked }, reply: { hash } };
      },
    },
    deps,
  );
}
