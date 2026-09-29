/**
 * Unit — wallet-session.ts against a mocked @walletconnect/sign-client and qrcode-terminal.
 * No real relay, no real wallet: every test controls the mock's `connect()` return and resolves
 * or rejects the wallet's own `approval()` by hand, the way a real wallet eventually would.
 *
 * Module state (the in-memory `pending`/`lastRejection`, the on-disk session file) is reset
 * between tests via `vi.resetModules()` + a fresh dynamic import and a fresh temp config dir —
 * there is no test-only backdoor in the production module itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockOn = vi.fn();
const mockInit = vi.fn();
const mockRequest = vi.fn();

// Named export, matching the real package — @walletconnect/sign-client's `default` export is NOT
// the SignClient class (measured directly: `import SignClient from "..."` resolved to an unrelated
// object whose `.init` was undefined, a real bug this mock's earlier `default`-only shape had been
// silently matching rather than catching). Mocking the wrong shape here would reintroduce exactly
// that blind spot.
vi.mock("@walletconnect/sign-client", () => ({
  SignClient: { init: (...args: unknown[]) => mockInit(...args) },
}));

vi.mock("qrcode", () => ({
  default: { toString: async (uri: string) => `QR(${uri})` },
}));

let dir: string;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "treasury-connect-test-"));
  process.env.TREASURY_CONNECT_HOME = dir;
  process.env.WALLETCONNECT_PROJECT_ID = "test-project-id";
  mockInit.mockResolvedValue({ connect: mockConnect, disconnect: mockDisconnect, on: mockOn, request: mockRequest });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TREASURY_CONNECT_HOME;
  delete process.env.WALLETCONNECT_PROJECT_ID;
});

/** A controllable stand-in for the `approval` function SignClient's connect() returns. */
function deferredApproval() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { approval: () => promise, resolve, reject };
}

const session = (topic: string, account: string) => ({
  topic,
  namespaces: { eip155: { accounts: [`eip155:8453:${account}`] } },
});

describe("status()", () => {
  it("reports disconnected with nothing set up", async () => {
    const { status } = await import("../src/wallet-session.js");
    expect(await status()).toEqual({ status: "disconnected" });
  });
});

describe("connect()", () => {
  it("throws a clear, actionable error when WALLETCONNECT_PROJECT_ID is unset — never a raw SDK error", async () => {
    delete process.env.WALLETCONNECT_PROJECT_ID;
    const { connect } = await import("../src/wallet-session.js");
    await expect(connect()).rejects.toThrow(/WALLETCONNECT_PROJECT_ID/);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("returns awaiting_approval with a uri and rendered qr immediately, without waiting for approval", async () => {
    const { approval } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    const { connect } = await import("../src/wallet-session.js");
    const s = await connect();
    expect(s).toMatchObject({ status: "awaiting_approval", uri: "wc:abc123" });
    expect((s as { qr: string }).qr).toBe("QR(wc:abc123)");
  });

  it("moves to connected once the wallet approves, extracting the address from the eip155 CAIP-10 account", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    const { connect, status } = await import("../src/wallet-session.js");
    await connect();
    resolve(session("topic-1", "0x1111111111111111111111111111111111111111"));
    await new Promise((r) => setTimeout(r, 0)); // let the approval().then(...) microtask land
    expect(await status()).toMatchObject({
      status: "connected",
      account: "0x1111111111111111111111111111111111111111",
      chainId: 8453,
      topic: "topic-1",
    });
  });

  it("reports rejected exactly once, then falls back to disconnected", async () => {
    const { approval, reject } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    const { connect, status } = await import("../src/wallet-session.js");
    await connect();
    reject(new Error("User rejected the session proposal"));
    await new Promise((r) => setTimeout(r, 0));
    expect(await status()).toMatchObject({ status: "rejected", reason: "User rejected the session proposal" });
    expect(await status()).toEqual({ status: "disconnected" });
  });

  it("returns the existing connected state instead of starting a new pairing", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    const { connect } = await import("../src/wallet-session.js");
    await connect();
    resolve(session("topic-1", "0x2222222222222222222222222222222222222222"));
    await new Promise((r) => setTimeout(r, 0));
    mockConnect.mockClear();
    const second = await connect();
    expect(second).toMatchObject({ status: "connected", account: "0x2222222222222222222222222222222222222222" });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("throws if the wallet approves with no eip155 account in the session namespace", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    const { connect, status } = await import("../src/wallet-session.js");
    await connect();
    resolve({ topic: "topic-1", namespaces: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(await status()).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no eip155 account/) });
  });
});

describe("disconnect()", () => {
  it("reports disconnected: false when nothing was connected, and never calls the client", async () => {
    const { disconnect } = await import("../src/wallet-session.js");
    expect(await disconnect()).toEqual({ disconnected: false });
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it("tears down the session with the right topic/reason and clears the record even if the SDK call fails", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    mockDisconnect.mockRejectedValue(new Error("relay unreachable"));
    const { connect, disconnect, status } = await import("../src/wallet-session.js");
    await connect();
    resolve(session("topic-1", "0x3333333333333333333333333333333333333333"));
    await new Promise((r) => setTimeout(r, 0));
    expect(await disconnect()).toEqual({ disconnected: true });
    expect(mockDisconnect).toHaveBeenCalledWith({ topic: "topic-1", reason: { code: 6000, message: "User disconnected" } });
    expect(await status()).toEqual({ status: "disconnected" });
  });
});

describe("sendTransaction()", () => {
  const CALL = { to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const, data: "0xdeadbeef" as const };

  it("throws when no wallet is connected — never calls the client", async () => {
    const { sendTransaction } = await import("../src/wallet-session.js");
    await expect(sendTransaction(CALL)).rejects.toThrow(/no wallet is connected/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("relays exactly the given call as eth_sendTransaction from the connected account, and returns the hash", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    mockRequest.mockResolvedValue("0xtxhash");
    const { connect, sendTransaction } = await import("../src/wallet-session.js");
    await connect();
    resolve(session("topic-1", "0x5555555555555555555555555555555555555555"));
    await new Promise((r) => setTimeout(r, 0));

    const result = await sendTransaction(CALL);
    expect(result).toEqual({ status: "submitted", hash: "0xtxhash" });
    expect(mockRequest).toHaveBeenCalledWith({
      topic: "topic-1",
      chainId: "eip155:8453",
      request: { method: "eth_sendTransaction", params: [{ from: "0x5555555555555555555555555555555555555555", to: CALL.to, data: CALL.data, value: "0x0" }] },
    });
  });

  it("passes an explicit value through instead of defaulting it", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    mockRequest.mockResolvedValue("0xtxhash");
    const { connect, sendTransaction } = await import("../src/wallet-session.js");
    await connect();
    resolve(session("topic-1", "0x6666666666666666666666666666666666666666"));
    await new Promise((r) => setTimeout(r, 0));

    await sendTransaction({ ...CALL, value: "0x2386f26fc10000" });
    const req = mockRequest.mock.calls[0]![0] as { request: { params: [{ value: string }] } };
    expect(req.request.params[0]!.value).toBe("0x2386f26fc10000");
  });

  it("reports a wallet rejection as a result, not a thrown error", async () => {
    const { approval, resolve } = deferredApproval();
    mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
    mockRequest.mockRejectedValue(new Error("User rejected the request"));
    const { connect, sendTransaction } = await import("../src/wallet-session.js");
    await connect();
    resolve(session("topic-1", "0x7777777777777777777777777777777777777777"));
    await new Promise((r) => setTimeout(r, 0));

    expect(await sendTransaction(CALL)).toEqual({ status: "rejected", reason: "User rejected the request" });
  });

  it("times out rather than hanging forever if the wallet never answers", async () => {
    vi.useFakeTimers();
    try {
      const { approval, resolve } = deferredApproval();
      mockConnect.mockResolvedValue({ uri: "wc:abc123", approval });
      mockRequest.mockReturnValue(new Promise(() => {})); // never settles
      const { connect, sendTransaction } = await import("../src/wallet-session.js");
      await connect();
      resolve(session("topic-1", "0x8888888888888888888888888888888888888888"));
      await vi.advanceTimersByTimeAsync(0);

      const pending = sendTransaction(CALL);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await pending).toEqual({ status: "rejected", reason: expect.stringMatching(/timed out/) });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("switchWallet()", () => {
  it("disconnects the existing session, then starts a fresh pairing", async () => {
    const first = deferredApproval();
    mockConnect.mockResolvedValueOnce({ uri: "wc:first", approval: first.approval });
    mockDisconnect.mockResolvedValue(undefined);
    const { connect, switchWallet } = await import("../src/wallet-session.js");
    await connect();
    first.resolve(session("topic-1", "0x4444444444444444444444444444444444444444"));
    await new Promise((r) => setTimeout(r, 0));

    const second = deferredApproval();
    mockConnect.mockResolvedValueOnce({ uri: "wc:second", approval: second.approval });
    const s = await switchWallet();
    expect(mockDisconnect).toHaveBeenCalledWith({ topic: "topic-1", reason: { code: 6000, message: "User disconnected" } });
    expect(s).toMatchObject({ status: "awaiting_approval", uri: "wc:second" });
  });
});
