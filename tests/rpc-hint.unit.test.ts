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
import { describe, it, expect, afterEach } from "vitest";
import { buildCommands } from "../src/earn/commands.js";
import { publicRpcHint } from "../src/client.js";

type Handler = (a: unknown, extra: unknown) => Promise<string>;
const tools = () => (buildCommands() as unknown as Record<string, { handler: Handler }>);

afterEach(() => {
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

  // That a configured endpoint's failure carries no setup hint was asserted here through the EVM health check, which
  // reads the Tempora API now and no RPC at all; on Solana it is `solana-rpc-hint.unit.test.ts`'s.

  it("does not fire on a SUCCESSFUL result that merely mentions nothing about RPC", async () => {
    // `chain: solana`: the disclosures, read from this client alone — offline, as every case here must be.
    const out = (await tools()["earn_terms"]!.handler({ chain: "solana" }, {}));
    expect(JSON.parse(out).items.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/setup_required/);
  });
});
