/**
 * Browser sign-in — the `claude login` shape. The MCP process opens one short-lived page on
 * 127.0.0.1, the operator's own wallet extension answers in it, the page reports back to this
 * process, and the server closes. Nothing stays running and no key is ever seen: the wallet signs.
 *
 * Two one-shot flows share one server:
 *   connect  the wallet proves control of an address with a gasless sign-in message (EIP-4361 shape),
 *            verified here, so the address is not just what a page claimed.
 *   sign     ONE call Earn already built is handed to the wallet; the hash that comes back is then
 *            looked up on chain and compared with what was asked for.
 *
 * Hardening, all of it enforced in `serveOnce`: loopback bind; Host must be the loopback origin we
 * gave out (DNS rebinding); a 192-bit URL secret compared in constant time; POSTs must be JSON from
 * that exact Origin (a cross-site form cannot send either); bodies are capped; the result is
 * accepted once; the server stops after a TTL; CSP `connect-src 'self'` leaves the page nowhere to
 * send anything but back here.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createPublicClient, decodeFunctionData, getAddress, http as viemHttp, isAddress, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { erc4626Abi } from "./abi/erc4626.js";
import { PAGE_HTML } from "./browser-page.js";

export const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_HEX = "0x2105";
const MAX_BODY_BYTES = 16 * 1024;

export type Call = { to: Address; data: Hex; value?: Hex };
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
export type Handle<T> = { url: string; opened: boolean; done: Promise<Result<T>>; close: () => void };
export type Verified = "matched" | "mismatch" | "unverified";

/** Seams for the two things that need the network, so tests never reach it. */
export type Deps = {
  verifySignature?: (a: { address: Address; message: string; signature: Hex }) => Promise<boolean>;
  getTransaction?: (hash: Hex) => Promise<{ from: string; to: string | null; input: string; value: bigint }>;
  openBrowser?: (url: string) => boolean;
};

const rpcClient = () => createPublicClient({ chain: base, transport: viemHttp(process.env.BASE_RPC_URL || undefined) });

/** EOA first (no network); a contract wallet's ERC-1271/6492 signature needs a call to the chain. */
async function defaultVerifySignature(a: { address: Address; message: string; signature: Hex }): Promise<boolean> {
  try {
    if (await verifyMessage(a)) return true;
  } catch {
    /* not an EOA signature — fall through */
  }
  try {
    return await rpcClient().verifyMessage(a);
  } catch {
    return false;
  }
}

/** True when a page opened on this machine can plausibly reach the operator (and loopback reach it back). */
export function canOpenBrowser(): boolean {
  if (process.env.TREASURY_CONNECT_NO_OPEN) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

/**
 * Hands the url to the operating system's own opener. One literal command per platform on purpose:
 * the boundary test pins exactly which programs this package may start (never a computed one), and
 * the only argument is the loopback url this module just built.
 */
function defaultOpen(url: string): boolean {
  if (!canOpenBrowser()) return false;
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no opener on this machine — the URL is returned to the caller either way */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Body = Record<string, unknown>;

type Flow<T> = {
  mode: "connect" | "sign";
  ttlMs: number;
  info: () => Body;
  /** connect only: the exact message the wallet will be asked to sign, for this address. */
  challenge?: (address: Address, origin: string, nonce: string) => string;
  accept: (body: Body, ctx: { nonce: string; origin: string; message?: string | undefined; challengedAddress?: Address | undefined }) => Promise<Result<T>>;
};

async function serveOnce<T>(flow: Flow<T>, deps: Deps): Promise<Handle<T>> {
  const secret = randomBytes(24).toString("hex");
  let settled = false;
  let resolveDone!: (r: Result<T>) => void;
  const done = new Promise<Result<T>>((r) => (resolveDone = r));
  let issued: { address: Address; message: string } | undefined;
  let origin = "";

  const finish = (r: Result<T>): void => {
    if (settled) return;
    settled = true;
    resolveDone(r);
    // Leave a moment for the page's final response to flush before the socket goes away.
    setTimeout(() => {
      server.close();
      server.closeAllConnections();
    }, 1500).unref();
  };

  const json = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<Body> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
          resolve(v as Body);
        } catch {
          reject(new Error("body is not a JSON object"));
        }
      });
      req.on("error", reject);
    });

  // CSP: the provider-injecting scripts some wallets add need `unsafe-inline`; what matters is that
  // `connect-src 'self'` leaves the page no way to send anything anywhere but back here.
  const CSP = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? "");
      if (host !== new URL(origin).host) return void json(res, 403, { ok: false, reason: "bad host" });
      const url = new URL(req.url ?? "/", origin);

      if (req.method === "GET") {
        if (!same(url.searchParams.get("s") ?? "", secret)) return void json(res, 404, { ok: false, reason: "not found" });
        if (url.pathname === "/info") return void json(res, 200, flow.info());
        if (url.pathname === `/${flow.mode}`) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": CSP, "x-content-type-options": "nosniff" });
          return void res.end(PAGE_HTML);
        }
        return void json(res, 404, { ok: false, reason: "not found" });
      }

      if (req.method === "POST" && (url.pathname === "/challenge" || url.pathname === "/result")) {
        if (req.headers.origin !== origin) return void json(res, 403, { ok: false, reason: "bad origin" });
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return void json(res, 415, { ok: false, reason: "expected JSON" });
        if (settled) return void json(res, 409, { ok: false, reason: "already finished" });
        const body = await readBody(req);
        if (typeof body.s !== "string" || !same(body.s, secret)) return void json(res, 404, { ok: false, reason: "not found" });

        if (url.pathname === "/challenge") {
          if (flow.mode !== "connect" || !flow.challenge) return void json(res, 404, { ok: false, reason: "not found" });
          if (typeof body.address !== "string" || !isAddress(body.address)) return void json(res, 400, { ok: false, reason: "not an address" });
          const address = getAddress(body.address);
          const message = flow.challenge(address, origin, secret);
          issued = { address, message };
          return void json(res, 200, { ok: true, message });
        }

        if (body.rejected === true) {
          finish({ ok: false, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : "the wallet declined" });
          return void json(res, 200, { ok: true });
        }
        const r = await flow.accept(body, { nonce: secret, origin, message: issued?.message, challengedAddress: issued?.address });
        if (!r.ok) return void json(res, 400, { ok: false, reason: r.reason });
        finish(r);
        return void json(res, 200, { ok: true });
      }

      json(res, 405, { ok: false, reason: "method not allowed" });
    } catch (e) {
      json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "bad request" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/${flow.mode}?s=${secret}`;

  setTimeout(() => finish({ ok: false, reason: `nothing happened in the browser within ${Math.round(flow.ttlMs / 60000)} minutes` }), flow.ttlMs).unref();
  const opened = (deps.openBrowser ?? defaultOpen)(url);
  return { url, opened, done, close: () => finish({ ok: false, reason: "cancelled" }) };
}

/** The sign-in message. Exported for tests; the server is the only place that builds it for real. */
export function signInMessage(a: { address: Address; origin: string; nonce: string; issuedAt: string }): string {
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

export async function startConnect(deps: Deps = {}): Promise<Handle<{ account: Address; chainId: number }>> {
  const verify = deps.verifySignature ?? defaultVerifySignature;
  return serveOnce<{ account: Address; chainId: number }>(
    {
      mode: "connect",
      ttlMs: 5 * 60_000,
      info: () => ({ mode: "connect" }),
      challenge: (address, origin, nonce) => signInMessage({ address, origin, nonce, issuedAt: new Date().toISOString() }),
      accept: async (body, ctx) => {
        if (typeof body.address !== "string" || !isAddress(body.address)) return { ok: false, reason: "not an address" };
        const address = getAddress(body.address);
        if (!ctx.message || ctx.challengedAddress !== address) return { ok: false, reason: "no sign-in message was issued for this address" };
        if (body.chainId !== BASE_CHAIN_HEX) return { ok: false, reason: "the wallet is not on Base" };
        if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return { ok: false, reason: "malformed signature" };
        const ok = await verify({ address, message: ctx.message, signature: body.signature as Hex });
        return ok ? { ok: true, value: { account: address, chainId: BASE_CHAIN_ID } } : { ok: false, reason: "the signature does not match the address" };
      },
    },
    deps,
  );
}

const approveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);

/** Plain-words reading of calldata for the page, or undefined when it is not a call we recognise. */
export function describeCall(data: Hex): string | undefined {
  try {
    const d = decodeFunctionData({ abi: [...erc4626Abi, ...approveAbi], data });
    return `${d.functionName}(${(d.args ?? []).map((a) => String(a)).join(", ")})`;
  } catch {
    return undefined;
  }
}

async function verifyLanded(hash: Hex, call: Call, account: Address, deps: Deps): Promise<Verified> {
  const get = deps.getTransaction ?? ((h: Hex) => rpcClient().getTransaction({ hash: h }));
  for (let i = 0; i < 8; i++) {
    try {
      const tx = await get(hash);
      const ok =
        tx.from.toLowerCase() === account.toLowerCase() &&
        (tx.to ?? "").toLowerCase() === call.to.toLowerCase() &&
        tx.input.toLowerCase() === call.data.toLowerCase() &&
        tx.value === BigInt(call.value ?? "0x0");
      return ok ? "matched" : "mismatch";
    } catch {
      await new Promise((r) => setTimeout(r, deps.getTransaction ? 5 : 2000));
    }
  }
  return "unverified";
}

export async function startSign(call: Call, account: Address, deps: Deps = {}): Promise<Handle<{ hash: Hex; verified: Verified }>> {
  const value = call.value ?? "0x0";
  return serveOnce<{ hash: Hex; verified: Verified }>(
    {
      mode: "sign",
      ttlMs: 3 * 60_000,
      info: () => ({ mode: "sign", account, call: { to: call.to, data: call.data, value }, decoded: describeCall(call.data) ?? null }),
      accept: async (body) => {
        if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) return { ok: false, reason: "the wallet returned something that is not a transaction hash" };
        const hash = body.hash as Hex;
        return { ok: true, value: { hash, verified: await verifyLanded(hash, call, account, deps) } };
      },
    },
    deps,
  );
}
