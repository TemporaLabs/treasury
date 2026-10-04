/**
 * The RPC-touching handlers read an Arbitrum vault through ARBITRUM's endpoint, and say which chain
 * the answer is about. Two recording mock endpoints, one per chain: the property is that the Base
 * mock receives NOTHING. A handler that picked its endpoint from the default chain would read an
 * Arbitrum vault's address on Base, where it has no contract, and nothing else in the unit tier
 * would notice — the helpers in client.ts and the health path are pinned elsewhere, the handlers'
 * wiring of them is pinned here.
 */
import { createServer } from "node:http";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { __forgetEndpointChainsForTests } from "../src/client.js";
import { buildCommands } from "../src/earn/commands.js";

type Handler = (a: unknown, extra: unknown) => Promise<string>;
const tools = () => buildCommands() as unknown as Record<string, { handler: Handler }>;
const payload = (r: string) => JSON.parse(r);
const ACCOUNT = "0x1111111111111111111111111111111111111111";

/** A mock endpoint that records every method it was asked, and can refuse eth_getLogs. */
const start = async (chainIdHex: string, logsError?: string) => {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const r = JSON.parse(b) as { id: number; method: string };
      hits.push(r.method);
      const out =
        r.method === "eth_getLogs"
          ? logsError
            ? { jsonrpc: "2.0", id: r.id, error: { code: -32602, message: logsError } }
            : { jsonrpc: "2.0", id: r.id, result: [] }
          : { jsonrpc: "2.0", id: r.id, result: r.method === "eth_blockNumber" ? "0x1e7a1f00" : r.method === "eth_chainId" ? chainIdHex : "0x" + "0".repeat(64) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v2/K${port}`, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
};

/**
 * Every RPC variable the commands read, by LITERAL name. The boundary test forbids a computed
 * `process.env[k]` outside the files it names, so a loop over a list of names is not available here.
 */
type Snapshot = Record<"b" | "bl" | "bu" | "a" | "al" | "au" | "fb", string | undefined>;
let saved: Snapshot;
beforeEach(() => {
  saved = {
    b: process.env["TREASURY_RPC_BASE"], bl: process.env["TREASURY_LOGS_RPC_BASE"], bu: process.env["BASE_RPC_URL"],
    a: process.env["TREASURY_RPC_ARBITRUM"], al: process.env["TREASURY_LOGS_RPC_ARBITRUM"], au: process.env["ARBITRUM_RPC_URL"],
    fb: process.env["TREASURY_LOGS_FALLBACK"],
  };
  delete process.env["TREASURY_RPC_BASE"]; delete process.env["TREASURY_LOGS_RPC_BASE"]; delete process.env["BASE_RPC_URL"];
  delete process.env["TREASURY_RPC_ARBITRUM"]; delete process.env["TREASURY_LOGS_RPC_ARBITRUM"]; delete process.env["ARBITRUM_RPC_URL"];
  delete process.env["TREASURY_LOGS_FALLBACK"];
});
afterEach(() => {
  // An endpoint's chain is remembered per URL; every mock is a fresh local port and the OS reuses ports.
  __forgetEndpointChainsForTests();
  const put = (k: "TREASURY_RPC_BASE" | "TREASURY_LOGS_RPC_BASE" | "BASE_RPC_URL" | "TREASURY_RPC_ARBITRUM" | "TREASURY_LOGS_RPC_ARBITRUM" | "ARBITRUM_RPC_URL" | "TREASURY_LOGS_FALLBACK", v: string | undefined) => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  put("TREASURY_RPC_BASE", saved.b); put("TREASURY_LOGS_RPC_BASE", saved.bl); put("BASE_RPC_URL", saved.bu);
  put("TREASURY_RPC_ARBITRUM", saved.a); put("TREASURY_LOGS_RPC_ARBITRUM", saved.al); put("ARBITRUM_RPC_URL", saved.au);
  put("TREASURY_LOGS_FALLBACK", saved.fb);
});

describe("an Arbitrum call is read through Arbitrum's endpoint, on every RPC-touching command, and says so", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["earn_status", { chain: "arbitrum", account: ACCOUNT }],
    ["earn_quote", { chain: "arbitrum", account: ACCOUNT, amount_usdc: "1", direction: "deposit" }],
    ["earn_quote", { vault: "tlCashPlusUSDC2C", account: ACCOUNT, amount_usdc: "1", direction: "withdraw" }],
    ["earn_balance", { chain: "arbitrum", account: ACCOUNT }],
  ];
  for (const [name, args] of cases) {
    it(`${name} ${JSON.stringify(args)}`, async () => {
      const base = await start("0x2105");
      const arb = await start("0xa4b1");
      try {
        process.env["TREASURY_RPC_BASE"] = base.url;
        process.env["TREASURY_LOGS_RPC_BASE"] = base.url;
        process.env["TREASURY_RPC_ARBITRUM"] = arb.url;
        const out = payload(await tools()[name]!.handler(args, {}));
        expect([out.chain, out.chainId], "the result names the chain it is about").toEqual(["arbitrum", 42161]);
        expect(arb.hits.length, "premise: the handler read the chain").toBeGreaterThan(0);
        expect(base.hits, "an Arbitrum vault must never be read through Base's endpoint").toEqual([]);
      } finally {
        await base.close();
        await arb.close();
      }
    });
  }

  it("earn_balance on Arbitrum with TREASURY_LOGS_FALLBACK naming a (Base) URL: that endpoint is never asked", async () => {
    const baseFallback = await start("0x2105");
    const arb = await start("0xa4b1", "Archive requests require a personal token.");
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = arb.url;
      process.env["TREASURY_LOGS_FALLBACK"] = baseFallback.url;
      const out = payload(await tools()["earn_balance"]!.handler({ chain: "arbitrum", account: ACCOUNT }, {}));
      expect(out.scan.note).toMatch(/event scan FAILED/);
      expect(out.scan.note).toContain("TREASURY_LOGS_RPC_ARBITRUM");
      expect(arb.hits).toContain("eth_getLogs");
      expect(baseFallback.hits, "a Base endpoint is not Arbitrum's history").toEqual([]);
    } finally {
      await baseFallback.close();
      await arb.close();
    }
  });
});
