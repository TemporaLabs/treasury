/**
 * A one-shot localhost server: it exists for one sign-in or one confirmation, answers only requests
 * that carry its random secret, its own Host and (for POSTs) its own Origin, and closes itself once
 * the flow settles or times out.
 *
 * The page talks back by POSTing to `/challenge` (sign-in only) and `/result`. A `/result` handler
 * may answer "not yet" (`final: false`) to keep the flow open — the confirm flow uses that to take
 * one transaction at a time — and anything it refuses with `fatal` ends the flow at once.
 */
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress } from "viem";

const MAX_BODY_BYTES = 16 * 1024;

export type Accepted<T> =
  | { ok: true; final: true; value: T; reply?: Record<string, unknown> }
  | { ok: true; final: false; reply?: Record<string, unknown> }
  | { ok: false; reason: string; fatal?: boolean };
export type Settled<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface Flow<T> {
  mode: "connect" | "confirm";
  ttlMs: number;
  /** The page served at `/<mode>`, as a function of the flow's secret. */
  html: (secret: string) => string;
  csp: string;
  /** Static assets served at their path. */
  assets: Record<string, { type: string; body: string | Buffer }>;
  info: () => Record<string, unknown>;
  challenge?: (address: string, origin: string, nonce: string) => string;
  accept: (body: Record<string, unknown>, ctx: { nonce: string; origin: string; message?: string; challengedAddress?: string }) => Promise<Accepted<T>>;
  port: number;
}

export interface Handle<T> {
  url: string;
  done: Promise<Settled<T>>;
  close: () => void;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function serveOnce<T>(flow: Flow<T>): Promise<Handle<T>> {
  const secret = randomBytes(24).toString("hex");
  // Privy matches allowed origins by exact string, and `localhost` is the host it documents.
  const origin = `http://localhost:${flow.port}`;
  let settled = false;
  let busy = false;
  let resolveDone!: (r: Settled<T>) => void;
  const done = new Promise<Settled<T>>((r) => (resolveDone = r));
  let issued: { address: string; message: string } | undefined;

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
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new Error("body is not a JSON object"));
        }
      });
      req.on("error", reject);
    });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (String(req.headers.host ?? "") !== new URL(origin).host) return json(res, 403, { ok: false, reason: "bad host" });
        const url = new URL(req.url ?? "/", origin);

        if (req.method === "GET") {
          if (!same(url.searchParams.get("s") ?? "", secret)) return json(res, 404, { ok: false, reason: "not found" });
          if (url.pathname === "/info") return json(res, 200, flow.info());
          if (url.pathname === `/${flow.mode}`) {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy": flow.csp,
              "x-content-type-options": "nosniff",
            });
            return res.end(flow.html(secret));
          }
          const asset = flow.assets[url.pathname];
          if (asset) {
            res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
            return res.end(asset.body);
          }
          return json(res, 404, { ok: false, reason: "not found" });
        }

        if (req.method === "POST" && (url.pathname === "/challenge" || url.pathname === "/result")) {
          if (req.headers.origin !== origin) return json(res, 403, { ok: false, reason: "bad origin" });
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { ok: false, reason: "expected JSON" });
          if (settled) return json(res, 409, { ok: false, reason: "already finished" });
          const body = await readBody(req);
          if (typeof body["s"] !== "string" || !same(body["s"], secret)) return json(res, 404, { ok: false, reason: "not found" });

          if (url.pathname === "/challenge") {
            if (!flow.challenge) return json(res, 404, { ok: false, reason: "not found" });
            const a = body["address"];
            if (typeof a !== "string" || !isAddress(a)) return json(res, 400, { ok: false, reason: "not an address" });
            const address = getAddress(a);
            const message = flow.challenge(address, origin, secret);
            issued = { address, message };
            return json(res, 200, { ok: true, message });
          }

          if (body["rejected"] === true) {
            const reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 300) : "declined in the browser";
            finish({ ok: false, reason });
            return json(res, 200, { ok: true });
          }
          // One result at a time: a double click must never hand the same call over twice.
          if (busy) return json(res, 409, { ok: false, reason: "already in progress" });
          busy = true;
          try {
            const r = await flow.accept(body, { nonce: secret, origin, ...(issued ? { message: issued.message, challengedAddress: issued.address } : {}) });
            if (!r.ok) {
              if (r.fatal) finish({ ok: false, reason: r.reason });
              return json(res, 400, { ok: false, reason: r.reason });
            }
            if (r.final) finish({ ok: true, value: r.value });
            return json(res, 200, { ok: true, ...r.reply });
          } finally {
            busy = false;
          }
        }
        return json(res, 405, { ok: false, reason: "method not allowed" });
      } catch (e) {
        return json(res, 400, { ok: false, reason: e instanceof Error ? e.message : "bad request" });
      }
    })();
  });

  const finish = (r: Settled<T>) => {
    if (settled) return;
    settled = true;
    resolveDone(r);
    // A short grace period lets the page receive its last answer before the socket closes.
    setTimeout(() => {
      server.close();
      server.closeAllConnections();
    }, 1500).unref();
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`port ${flow.port} is in use — another sign-in or confirmation page is probably still open; finish or close it, then retry`)
          : e,
      ),
    );
    server.listen(flow.port, "127.0.0.1", () => resolve());
  });
  const timer = setTimeout(() => finish({ ok: false, reason: `nothing happened in the browser within ${Math.round(flow.ttlMs / 60_000)} minutes` }), flow.ttlMs);
  timer.unref();
  void done.then(() => clearTimeout(timer));
  return { url: `${origin}/${flow.mode}?s=${secret}`, done, close: () => finish({ ok: false, reason: "cancelled" }) };
}
