/**
 * Unit — a keyed RPC URL must not reach tool output even when the PROVIDER echoes it back.
 *
 * 🔴 Measured by review against a real viem client and a real HTTP server, and reproduced
 * here: a provider that rejects a key and repeats it in its response body puts the key in viem's
 * `Details:` line, as prose inside JSON. No scheme, no errno, no header keyword — every shape rule
 * misses it, and the key crossed the tool boundary. That is the class: a keyed provider URL IS
 * a secret.
 *
 * The fix is not another pattern. `rpcUrlFromEnv` resolved the value, so the redactor masks the
 * literal wherever it appears. These tests drive a REAL viem failure through a REAL handler.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildServer } from "../src/mcp/server.js";
import { FIXTURE, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";

// The unit tiers exercise code paths (18-decimal shares, an open vault) that the shipped
// registry does not offer; `fixtures/registry.ts` explains why they are synthetic.
beforeAll(() => useFixtureRegistry());
afterAll(() => useShippedRegistry());

// 🔴 A key whose percent-ENCODED and DECODED forms DIFFER. The earlier key here was
// `SECRETKEY123abc`, which encodes to itself — so the test could not distinguish the two forms and
// passed while the decoded form leaked (review). Any test of an encoding boundary must use
// an input that makes the transformation real.
const KEY = "sk-Live_a+b/c=d9f8e7";
const PORT = 59997;
let srv: Server | undefined;

const start = (body: string, status = 401) =>
  new Promise<void>((resolve) => {
    srv = createServer((_q, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    srv.listen(PORT, "127.0.0.1", () => resolve());
  });

afterEach(async () => {
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = undefined;
  delete process.env["TREASURY_RPC_BASE"];
  delete process.env["TREASURY_LOGS_RPC_BASE"];
});

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
const tools = () => (buildServer() as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

describe("a provider that echoes the rejected key back in its BODY", () => {
  it("earn_status returns a verdict and the key is not in it", async () => {
    await start(JSON.stringify({ error: { message: `invalid api key: ${KEY}` } }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${encodeURIComponent(KEY)}`;
    const res = await tools()["earn_status"]!.handler({}, {});
    const out = res.content[0]!.text;
    expect(out).not.toContain(KEY); // the whole point
    expect(JSON.parse(out).rpc).toBe("unreachable"); // and it still ANSWERS
  });

  it("a throwing tool is redacted by guarded() on the same path", async () => {
    await start(JSON.stringify({ error: { message: `bad key ${KEY}` } }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${encodeURIComponent(KEY)}`;
    process.env["TREASURY_LOGS_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${encodeURIComponent(KEY)}`;
    let thrown = "";
    try {
      await tools()["earn_balance"]!.handler({ account: "0x000000000000000000000000000000000000dEaD", vault: FIXTURE.morphoOpen, max_log_requests: 1 }, {});
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown).not.toContain(KEY);
  });

  it("the key is masked even in a shape with no scheme, errno or header keyword", async () => {
    await start(JSON.stringify({ error: `auth failed for token ${KEY}` }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${encodeURIComponent(KEY)}`;
    const out = (await tools()["earn_status"]!.handler({}, {})).content[0]!.text;
    expect(out).not.toContain(KEY);
  });

  it("the ENCODED form in the URL and the DECODED form a provider prints are BOTH masked", async () => {
    await start(JSON.stringify({ error: { message: `invalid api key: ${KEY}` } }));
    const enc = encodeURIComponent(KEY);
    expect(enc).not.toBe(KEY); // the guard on this test: the transformation must be real
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/${enc}`;
    const out = (await tools()["earn_status"]!.handler({}, {})).content[0]!.text;
    expect(out).not.toContain(KEY); // decoded — what the provider echoes
    expect(out).not.toContain(enc); // encoded — what sits in the URL
  });

  it("a key in a QUERY parameter carrying a literal + is masked in both readings", async () => {
    // URL.searchParams decodes `+` as a SPACE, so trusting it alone leaves the form the provider
    // actually echoes unregistered (review). Same defect as the path form, other branch.
    const QKEY = "sk+Live_abcdefgh";
    expect(new URL(`http://x/y?k=${QKEY}`).searchParams.get("k")).not.toBe(QKEY); // premise is real
    await start(JSON.stringify({ error: { message: `invalid api key: ${QKEY}` } }));
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/rpc?apikey=${QKEY}`;
    const out = (await tools()["earn_status"]!.handler({}, {})).content[0]!.text;
    expect(out).not.toContain(QKEY);
  });
});
