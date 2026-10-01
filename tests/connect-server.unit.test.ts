/**
 * Unit — the connect MCP tool surface. wallet-session.ts is mocked wholesale here; its own
 * behavior (mocked against @walletconnect/sign-client instead) is covered by
 * wallet-session.unit.test.ts. This file asserts the CONTRACT at the tool boundary: the exact
 * tool set, that no tool name reads as a signing/sending capability, and that each tool's
 * presentation layer (present()) adds its narration without dropping the underlying fields.
 */
import { describe, it, expect, vi } from "vitest";

const mockStatus = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockSwitch = vi.fn();
const mockSend = vi.fn();

vi.mock("../src/wallet-session.js", () => ({
  status: (...a: unknown[]) => mockStatus(...a),
  connect: (...a: unknown[]) => mockConnect(...a),
  disconnect: (...a: unknown[]) => mockDisconnect(...a),
  switchWallet: (...a: unknown[]) => mockSwitch(...a),
  sendTransaction: (...a: unknown[]) => mockSend(...a),
}));

const { buildServer } = await import("../src/mcp/connect-server.js");

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[] }>;
type Registered = Record<string, { handler: Handler }>;
const tools = () => (buildServer() as unknown as { _registeredTools: Registered })._registeredTools;
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

const FIVE = ["connect_send_transaction", "connect_status", "connect_wallet", "disconnect_wallet", "switch_wallet"];

describe("tool surface", () => {
  it("registers exactly these five names — no more, no fewer, none renamed", () => {
    expect(Object.keys(tools()).sort()).toEqual(FIVE);
  });

  it("exposes no signING tool, and the one send-shaped tool takes calls it did not build", () => {
    for (const n of Object.keys(tools())) expect(n).not.toMatch(/sign|transfer/i);
  });

  it("only the argument-taking tools have anything for a caller to pass, and exactly what's expected", () => {
    const t = tools() as unknown as Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
    const expected: Record<string, string[]> = {
      connect_send_transaction: ["data", "to", "value"],
    };
    for (const n of Object.keys(t)) {
      const props = Object.keys(t[n]!.inputSchema?.shape ?? {}).sort();
      expect(props).toEqual(expected[n] ?? []);
    }
  });
});

describe("connect_status", () => {
  it("passes a disconnected result straight through", async () => {
    mockStatus.mockResolvedValue({ status: "disconnected" });
    expect(payload(await tools()["connect_status"]!.handler({}, {}))).toEqual({ status: "disconnected" });
  });

  it("adds the no-signing-authority note on a connected result without dropping its fields", async () => {
    mockStatus.mockResolvedValue({ status: "connected", account: "0xabc", chainId: 8453, topic: "t1", connectedAtIso: "2026-01-01T00:00:00.000Z" });
    const out = payload(await tools()["connect_status"]!.handler({}, {}));
    expect(out).toMatchObject({ status: "connected", account: "0xabc", chainId: 8453, topic: "t1" });
    expect(out.note).toMatch(/no signing authority/);
  });
});

describe("connect_wallet", () => {
  it("adds instructions to an awaiting_approval result without dropping the uri/qr", async () => {
    mockConnect.mockResolvedValue({ status: "awaiting_approval", uri: "wc:x", qr: "Q", requestedAtIso: "2026-01-01T00:00:00.000Z" });
    const out = payload(await tools()["connect_wallet"]!.handler({}, {}));
    expect(out.status).toBe("awaiting_approval");
    expect(out.uri).toBe("wc:x");
    expect(out.qr).toBe("Q");
    expect(out.instructions).toMatch(/WalletConnect/);
  });

  it("propagates a thrown wallet-session error as the tool's own error", async () => {
    mockConnect.mockRejectedValue(new Error("WALLETCONNECT_PROJECT_ID is not set."));
    await expect(tools()["connect_wallet"]!.handler({}, {})).rejects.toThrow(/WALLETCONNECT_PROJECT_ID/);
  });
});

describe("disconnect_wallet", () => {
  it("returns the disconnect result as-is", async () => {
    mockDisconnect.mockResolvedValue({ disconnected: true });
    expect(payload(await tools()["disconnect_wallet"]!.handler({}, {}))).toEqual({ disconnected: true });
  });
});

describe("switch_wallet", () => {
  it("returns the new awaiting_approval state", async () => {
    mockSwitch.mockResolvedValue({ status: "awaiting_approval", uri: "wc:y", qr: "Q2", requestedAtIso: "2026-01-01T00:00:00.000Z" });
    const out = payload(await tools()["switch_wallet"]!.handler({}, {}));
    expect(out.uri).toBe("wc:y");
    expect(out.instructions).toMatch(/WalletConnect/);
  });
});

describe("connect_send_transaction", () => {
  const TO = "0x1111111111111111111111111111111111111111";

  // Schema validation (e.g. a malformed `to`) happens in the MCP SDK's own request routing, before
  // a handler is ever invoked — calling `.handler()` directly here, like the rest of this file, skips
  // that layer entirely, so it is not tested from this file (same limitation earn's own
  // server.unit.test.ts documents). The live bundle check run against the real protocol (see this
  // repo's CI / this session's manual verification) is what actually exercises that boundary.

  it("passes the exact to/data/value through to wallet-session, and returns a submitted hash", async () => {
    mockSend.mockResolvedValue({ status: "submitted", hash: "0xdeadbeef" });
    const out = payload(await tools()["connect_send_transaction"]!.handler({ to: TO, data: "0xabcd", value: "0x1" }, {}));
    expect(mockSend).toHaveBeenCalledWith({ to: TO, data: "0xabcd", value: "0x1" });
    expect(out).toEqual({ status: "submitted", hash: "0xdeadbeef" });
  });

  it("value is optional — omitted, not passed as undefined", async () => {
    mockSend.mockResolvedValue({ status: "submitted", hash: "0xdeadbeef" });
    await tools()["connect_send_transaction"]!.handler({ to: TO, data: "0xabcd" }, {});
    expect(mockSend).toHaveBeenCalledWith({ to: TO, data: "0xabcd" });
  });

  it("propagates a rejected result as-is, and a thrown no-wallet error as the tool's own error", async () => {
    mockSend.mockResolvedValue({ status: "rejected", reason: "User rejected the request" });
    expect(payload(await tools()["connect_send_transaction"]!.handler({ to: TO, data: "0xabcd" }, {}))).toEqual({
      status: "rejected",
      reason: "User rejected the request",
    });
    mockSend.mockRejectedValue(new Error("no wallet is connected — call connect_wallet first, then connect_status until it reports connected"));
    await expect(tools()["connect_send_transaction"]!.handler({ to: TO, data: "0xabcd" }, {})).rejects.toThrow(/no wallet is connected/);
  });
});
