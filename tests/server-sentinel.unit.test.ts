/**
 * Unit — the scan-failure sentinel survives the TOOL BOUNDARY, not just the library call.
 *
 * `redaction.unit.test.ts` already asserts UNKNOWN_AFTER_SCAN_FAILURE through `getPosition()`
 * directly. Nothing asserted it through `tools["earn_balance"].handler(...)` — and that wiring
 * is exactly what a rename touches (a tool renamed, `principal`→`account`).
 * A copy-paste error in the handler — constructing the client wrong, or failing to pass the
 * account through — would pass every library test and still be broken.
 *
 * The client is mocked because the handler builds its own; that is the point of the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { UNKNOWN_AFTER_SCAN_FAILURE } from "../src/position.js";
import { FIXTURE, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";

// The unit tiers exercise code paths (18-decimal shares, an open vault) that the shipped
// registry does not offer; `fixtures/registry.ts` explains why they are synthetic.
beforeAll(() => useFixtureRegistry());
afterAll(() => useShippedRegistry());

const STRANGER = "0x000000000000000000000000000000000000dEaD" as const;

// Reads succeed, only getLogs fails — a real position with an unreadable history.
//
// 🔴 The stub BRANCHES ON THE ADDRESS IT IS ASKED ABOUT. A reviewer measured that an earlier version
// returned the same canned values regardless of `args`, so replacing `principal: account` in the
// handler with a hardcoded wrong address left all 61 tests passing: the test proved the SENTINEL
// survived the handler, and proved nothing about whether the ACCOUNT did — the exact wiring gap it
// was written to close. Anything other than STRANGER now reads as an empty account, so a wrong or
// hardcoded address fails loudly on sharesExact instead of passing silently.
const stub = {
  getBlockNumber: async () => 51_000_000n,
  readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    if (functionName === "balanceOf") return args?.[0] === STRANGER ? 5n * 10n ** 18n : 0n;
    if (functionName === "convertToAssets") return args?.[0] === 10n ** 18n ? 1_020_000n : 5_100_000n;
    return 0n;
  },
  getLogs: async () => {
    throw new Error("query returned more than 10000 results");
  },
};

vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  return { ...actual, makePublicClient: () => stub };
});

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;

describe("the sentinel survives the MCP handler, not just the library function", () => {
  it("earn_balance reports basis and yield as UNKNOWN when the event scan fails", async () => {
    const { buildServer } = await import("../src/mcp/server.js");
    const tools = (buildServer() as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

    const res = await tools["earn_balance"]!.handler(
      { account: STRANGER, vault: FIXTURE.morphoOpen, max_log_requests: 3 },
      {},
    );
    const p = JSON.parse(res.content[0]!.text);

    // the account reached the library through the renamed parameter
    expect(p.sharesExact).toBe("5");
    expect(p.usdcValue).toBe("5.1 USDC");
    // and the property that must not silently become "0 USDC" / "<whole value> USDC"
    expect(p.entryBasisUsdc).toBe(UNKNOWN_AFTER_SCAN_FAILURE);
    expect(p.accruedYieldUsdc).toBe(UNKNOWN_AFTER_SCAN_FAILURE);
    expect(p.scan.complete).toBe(false);
    expect(p.scan.note).toMatch(/event scan FAILED/);
  });
});
