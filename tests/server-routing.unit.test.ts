/**
 * Unit — `earn_quote` routes `direction` to the RIGHT side, and says so truthfully.
 *
 * Measured in review, confirmed by three reviewers independently: swapping the two branches
 * so `direction: "deposit"` called `quoteWithdraw` and vice versa left `tsc -b` CLEAN and all 61
 * tests passing, byte-identical. Nothing discriminated it — merging two tools behind a flag
 * created a routing decision that nothing verified, and `server.unit.test.ts` only ever touched
 * the inputSchema, never the handler.
 *
 * The tag is now emitted inside each branch, so tag and body cannot disagree. That makes a swap
 * wrong about the REQUEST rather than about the BODY — which is what `requested === returned`
 * below is for. Both assertions are needed: the shape catches the body, the tag catches the route.
 */
import { describe, it, expect, vi } from "vitest";
import { EARN } from "../src/config/earn.js";

const DEPOSIT_MARK = { expectedShares: "DEPOSIT_SIDE", preflight: { status: "OPEN_READY" } };
const WITHDRAW_MARK = { sharesToBurn: "WITHDRAW_SIDE", sharesHeld: "x", advisory: { maxWithdrawRaw: "0", note: "" } };

vi.mock("../src/quote.js", () => ({
  quoteDeposit: vi.fn(async () => DEPOSIT_MARK),
  quoteWithdraw: vi.fn(async () => WITHDRAW_MARK),
}));

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
const ACCOUNT = EARN.fixtures.stranger;

const call = async (direction: string) => {
  const { buildServer } = await import("../src/mcp/server.js");
  const tools = (buildServer() as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  const res = await tools["earn_quote"]!.handler({ account: ACCOUNT, amount_usdc: "25", direction }, {});
  return JSON.parse(res.content[0]!.text);
};

describe("earn_quote — direction routes to the matching side", () => {
  it('direction "deposit" returns DEPOSIT-shaped fields, and the tag agrees with the request', async () => {
    const out = await call("deposit");
    expect(out.expectedShares).toBe("DEPOSIT_SIDE"); // body: only the deposit side produces this
    expect(out.sharesToBurn).toBeUndefined(); // and never the withdraw side's
    expect(out.direction).toBe("deposit"); // route: requested === returned
  });

  it('direction "withdraw" returns WITHDRAW-shaped fields, and the tag agrees with the request', async () => {
    const out = await call("withdraw");
    expect(out.sharesToBurn).toBe("WITHDRAW_SIDE");
    expect(out.expectedShares).toBeUndefined();
    expect(out.direction).toBe("withdraw");
  });
});
