import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress } from "viem";

const MAX_BODY_BYTES = 16 * 1024;

export type Accepted<T> =
  | { ok: true; value: T; reply?: Record<string, unknown> }
  // `fatal` ends the whole flow (the terminal learns of it at once) instead of leaving the page open to retry.
  | { ok: false; reason: string; fatal?: boolean };
export type Settled<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface Page {
  /** The page body, or a function of the flow's secret when the page must embed it. */
  html: string | ((secret: string) => string);
  csp: string;
}

export interface Flow<T> {
  mode: "connect" | "confirm";
  ttlMs: number;
  /** Pages served at their path (GET, secret required). */
  pages: Record<string, Page>;
  /** Static assets served at their path (GET, secret required). */
  assets?: Record<string, { type: string; body: string | Buffer }>;
  info: () => Record<string, unknown>;
  challenge?: (address: string, origin: string, nonce: string) => string;
  accept: (body: Record<string, unknown>, ctx: { nonce: string; origin: string; message?: string; challengedAddress?: string }) => Promise<Accepted<T>>;
  port?: number;
  hostname?: string;
}

export interface Handle<T> {
  url: string;
  opened: boolean;
  done: Promise<Settled<T>>;
  close: () => void;
}

export interface ServeDeps {
  openBrowser?: (url: string) => boolean;
}

export function canOpenBrowser(): boolean {
  if (process.env.TREASURY_CONNECT_NO_OPEN) return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

function defaultOpen(url: string): boolean {
  if (!canOpenBrowser()) return false;
  try {
    const child =
      process.platform === "darwin" ? spawn("open", [url], { stdio: "ignore", detached: true })
      : process.platform === "win32" ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
      : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// A one-shot localhost server: it exists for one sign-in or one confirmation, answers only requests
// that carry its random secret and its own origin, and closes itself once the flow settles.
export async function serveOnce<T>(flow: Flow<T>, deps: ServeDeps = {}): Promise<Handle<T>> {
  const secret = randomBytes(24).toString("hex");
  let settled = false;
  let busy = false;
  let resolveDone!: (r: Settled<T>) => void;
  const done = new Promise<Settled<T>>((r) => (resolveDone = r));
  let issued: { address: string; message: string } | undefined;
  let origin = "";

  const finish = (r: Settled<T>) => {
    if (settled) return;
    settled = true;
    resolveDone(r);
    // Stop listening at once so a pinned port is free for the next flow; let the reply in flight finish.
    server.close();
    setTimeout(() => server.closeAllConnections(), 1500).unref();
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
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
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new Error("body is not a JSON object"));
        }
      });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    try {
      if (String(req.headers.host ?? "") !== new URL(origin).host) return void json(res, 403, { ok: false, reason: "bad host" });
      const url = new URL(req.url ?? "/", origin);

      if (req.method === "GET") {
        if (!same(url.searchParams.get("s") ?? "", secret)) return void json(res, 404, { ok: false, reason: "not found" });
        if (url.pathname === "/info") return void json(res, 200, flow.info());
        const page = flow.pages[url.pathname];
        if (page) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": page.csp, "x-content-type-options": "nosniff" });
          return void res.end(typeof page.html === "function" ? page.html(secret) : page.html);
        }
        const asset = flow.assets?.[url.pathname];
        if (asset) {
          res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return void res.end(asset.body);
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
        // One accept at a time: a double click must never sign twice.
        if (busy) return void json(res, 409, { ok: false, reason: "already in progress" });
        busy = true;
        try {
          const r = await flow.accept(body, { nonce: secret, origin, message: issued?.message, challengedAddress: issued?.address });
          if (!r.ok) {
            if (r.fatal) finish({ ok: false, reason: r.reason });
            return void json(res, 400, { ok: false, reason: r.reason });
          }
          finish({ ok: true, value: r.value });
          return void json(res, 200, { ok: true, ...r.reply });
        } finally {
          busy = false;
        }
      }
      json(res, 405, { ok: false, reason: "method not allowed" });
    } catch (e) {
      json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "bad request" });
    }
  });

  // A pinned port may still be held for a moment by the previous flow, so retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(flow.port ?? 0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      if (!flow.port || (e as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const port = (server.address() as { port: number }).port;
  origin = `http://${flow.hostname ?? "127.0.0.1"}:${port}`;
  const url = `${origin}/${flow.mode}?s=${secret}`;
  setTimeout(() => finish({ ok: false, reason: `nothing happened in the browser within ${Math.round(flow.ttlMs / 60_000)} minutes` }), flow.ttlMs).unref();
  const opened = (deps.openBrowser ?? defaultOpen)(url);
  return { url, opened, done, close: () => finish({ ok: false, reason: "cancelled" }) };
}
