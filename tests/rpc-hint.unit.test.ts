/**
 * Unit — an unconfigured RPC failure must say what to DO, not just that it failed.
 *
 * 🔴 Measured through the installed plugin with no configuration: the deposit pre-flight returns
 * UNRESOLVED 3/3 on the public endpoint ("RPC Request failed") and NEEDS_APPROVAL 3/3 on a keyed
 * one. A stranger's first five minutes therefore end in a message that reads as "this product is
 * broken" rather than "you need a key". These assert the hint appears exactly when it should —
 * and, more importantly, NOT when a keyed RPC is configured, so a real chain fault is never
 * mislabelled as a setup problem.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { buildServer } from "../src/mcp/server.js";
import { publicRpcHint } from "../src/client.js";

const PORT = 59993;
let srv: Server | undefined;
type Handler = (a: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
const tools = () => (buildServer() as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

beforeEach(async () => {
  // a server that always fails, so every case below is a transport failure
  await new Promise<void>((r) => {
    srv = createServer((_q, res) => { res.writeHead(503); res.end("upstream unavailable"); });
    srv.listen(PORT, "127.0.0.1", () => r());
  });
});
afterEach(async () => {
  await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
  srv = undefined;
  delete process.env["TREASURY_RPC_BASE"];
});

describe("the public-endpoint hint", () => {
  // The hint's own condition, tested directly. The wiring cannot be exercised hermetically in the
  // positive direction: "unconfigured" means the real public endpoint, and a single getBlockNumber
  // SUCCEEDS there — it is the heavier pre-flight that rate-limits. Forcing a failure requires
  // setting a variable, which by definition makes it configured. So the condition is unit-tested
  // and the end-to-end behaviour is measured through the installed plugin instead.
  it("is offered when nothing is configured, and withheld when something is", () => {
    delete process.env["TREASURY_RPC_BASE"];
    const unconfigured = publicRpcHint(8453);
    expect(unconfigured).toMatch(/TREASURY_RPC_BASE/);
    expect(unconfigured).toMatch(/rate-limits/);
    process.env["TREASURY_RPC_BASE"] = "https://example.invalid/v2/key12345678";
    expect(publicRpcHint(8453)).toBeUndefined(); // a real fault must not read as a setup problem
  });

  it("does NOT appear when a keyed RPC IS configured — a real fault must not read as a setup problem", async () => {
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:${PORT}/v2/configuredkey123`;
    const out = (await tools()["earn_status"]!.handler({}, {})).content[0]!.text;
    const d = JSON.parse(out);
    expect(d.rpc).toBe("unreachable"); // it still failed
    expect(d.setup_required).toBeUndefined(); // but it is not a setup problem
    expect(d.rpcSource).toBe("TREASURY_RPC_BASE");
  });

  it("does not fire on a SUCCESSFUL result that merely mentions nothing about RPC", async () => {
    const out = (await tools()["earn_terms"]!.handler({}, {})).content[0]!.text;
    expect(out).not.toMatch(/setup_required/);
  });
});
