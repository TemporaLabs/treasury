import { readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, isAddress, verifyMessage } from "viem";
import { base } from "viem/chains";
import { BASE_CHAIN_HEX, BASE_CHAIN_ID, connectPort, privyAppId, signerId, signerPolicyIds } from "./config.ts";
import { describeCall } from "./decode.ts";
import type { Call } from "./decode.ts";
import { serveOnce } from "./http.ts";
import type { Handle, ServeDeps } from "./http.ts";
import { CONFIRM_HTML, PLAIN_CSP, PRIVY_CSP, privyShell } from "./pages.ts";
import { createSignerSession, sendViaSigner } from "./signer-client.ts";
import type { SendResult } from "./signer-client.ts";

const rpcClient = () => createPublicClient({ chain: base, transport: http(process.env.TREASURY_RPC_BASE || process.env.BASE_RPC_URL || undefined) });

// A connected wallet is either an external one signed in directly (no Privy involved) or a Privy
// embedded wallet that the operator delegated to the signing service.
export type Connected =
  | { account: string; chainId: number; walletType: "external" }
  | { account: string; chainId: number; walletType: "embedded"; signerSession: string };

type Verified = { verified: "matched" | "mismatch" | "unverified"; detail?: string };
export type Confirmed = { hash: string } & Verified;

export interface ConnectDeps extends ServeDeps {
  verifySignature?: (a: { address: `0x${string}`; message: string; signature: `0x${string}` }) => Promise<boolean>;
  createSession?: typeof createSignerSession;
  readBundle?: () => string | Buffer;
  port?: number;
}

export interface ConfirmDeps extends ServeDeps {
  sendViaSigner?: typeof sendViaSigner;
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
// Google and browser wallets. An embedded wallet goes through the signing service; a browser wallet
// signs the server's challenge and the signature is checked locally.
export async function startConnect(deps: ConnectDeps = {}): Promise<Handle<Connected>> {
  const verify = deps.verifySignature ?? defaultVerifySignature;
  const createSession = deps.createSession ?? createSignerSession;
  const bundle = (deps.readBundle ?? defaultReadBundle)();
  return serveOnce<Connected>(
    {
      mode: "connect",
      ttlMs: 10 * 60_000,
      pages: {
        "/connect": { html: privyShell, csp: PRIVY_CSP },
      },
      assets: { "/app.js": { type: "text/javascript; charset=utf-8", body: bundle } },
      info: () => ({ mode: "connect", appId: privyAppId(), signerId: signerId() ?? null, policyIds: signerPolicyIds() }),
      challenge: (address, origin, nonce) => signInMessage({ address, origin, nonce, issuedAt: new Date().toISOString() }),
      accept: async (body, ctx) => {
        if (typeof body.address !== "string" || !isAddress(body.address)) return { ok: false, reason: "not an address" };
        const address = getAddress(body.address);
        if (body.kind === "embedded") {
          if (typeof body.accessToken !== "string" || body.accessToken.length < 20 || body.accessToken.length > 4096) return { ok: false, reason: "missing Privy access token" };
          const s = await createSession(body.accessToken, address);
          if (!s.ok) return { ok: false, reason: s.reason };
          if (getAddress(s.account) !== address) return { ok: false, reason: "the signing service answered for a different address" };
          return { ok: true, value: { account: address, chainId: BASE_CHAIN_ID, walletType: "embedded", signerSession: s.token } };
        }
        if (body.kind === "external") {
          if (!ctx.message || ctx.challengedAddress !== address) return { ok: false, reason: "no sign-in message was issued for this address" };
          if (body.chainId !== BASE_CHAIN_HEX) return { ok: false, reason: "the wallet is not on Base" };
          if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return { ok: false, reason: "malformed signature" };
          const ok = await verify({ address, message: ctx.message, signature: body.signature as `0x${string}` });
          return ok ? { ok: true, value: { account: address, chainId: BASE_CHAIN_ID, walletType: "external" } } : { ok: false, reason: "the signature does not match the address" };
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
// embedded wallet is signed by the signing service only after the click on the page; an external
// wallet gets its own prompt after the click.
export async function startConfirm(call: Call, session: Connected, deps: ConfirmDeps = {}): Promise<Handle<Confirmed>> {
  const send = deps.sendViaSigner ?? sendViaSigner;
  const full: Call = { to: call.to, data: call.data, value: call.value ?? "0x0" };
  const decoded = describeCall(full, session.account);
  return serveOnce<Confirmed>(
    {
      mode: "confirm",
      ttlMs: 3 * 60_000,
      pages: { "/confirm": { html: CONFIRM_HTML, csp: PLAIN_CSP } },
      info: () => ({ mode: "confirm", signer: session.walletType === "embedded" ? "service" : "wallet", account: session.account, call: full, decoded }),
      accept: async (body) => {
        let hash: string;
        if (session.walletType === "embedded") {
          if (body.confirmed !== true) return { ok: false, reason: "the transaction was not confirmed" };
          const r: SendResult = await send(full, session.account, session.signerSession);
          if (r.status !== "submitted") return { ok: false, reason: r.reason, fatal: true };
          hash = r.hash;
        } else {
          if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) return { ok: false, reason: "the wallet returned something that is not a transaction hash" };
          hash = body.hash;
        }
        const checked = await verifyLanded(hash as `0x${string}`, full, session.account, deps);
        return { ok: true, value: { hash, ...checked }, reply: { hash } };
      },
    },
    deps,
  );
}
