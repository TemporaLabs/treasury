/**
 * Unit — wallet-session.ts with the BROWSER method. browser-session.ts is replaced by a hand-driven
 * fake (its own HTTP behaviour is covered by browser-session.unit.test.ts); this file asserts how
 * the session layer turns its outcomes into connect/status/send states, and that it never touches
 * WalletConnect for a browser session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockInit = vi.fn();
vi.mock("@walletconnect/sign-client", () => ({ SignClient: { init: (...a: unknown[]) => mockInit(...a) } }));

type Outcome = { ok: true; value: unknown } | { ok: false; reason: string };
function fakeHandle(opened = true) {
  let resolve!: (o: Outcome) => void;
  const done = new Promise<Outcome>((r) => (resolve = r));
  const close = vi.fn(() => resolve({ ok: false, reason: "cancelled" }));
  return { handle: { url: "http://127.0.0.1:5555/connect?s=abc", opened, done, close }, resolve, close };
}
const mockStartConnect = vi.fn();
const mockStartSign = vi.fn();
vi.mock("../src/browser-session.js", () => ({
  startConnect: (...a: unknown[]) => mockStartConnect(...a),
  startSign: (...a: unknown[]) => mockStartSign(...a),
}));

const ACCT = "0x1111111111111111111111111111111111111111";
const CALL = { to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const, data: "0xdeadbeef" as const };
let dir: string;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "treasury-connect-browser-"));
  process.env.TREASURY_CONNECT_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TREASURY_CONNECT_HOME;
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("connect('browser')", () => {
  it("is the default method, and with a wait returns connected directly once the wallet answers", async () => {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect } = await import("../src/wallet-session.js");
    const p = connect(undefined, 5000);
    await tick();
    f.resolve({ ok: true, value: { account: ACCT, chainId: 8453 } });
    expect(await p).toMatchObject({ status: "connected", via: "browser", account: ACCT, chainId: 8453 });
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("returns awaiting_approval with the url when the wait runs out, then connected on a later status()", async () => {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect, status } = await import("../src/wallet-session.js");
    const s = await connect("browser", 20);
    expect(s).toMatchObject({ status: "awaiting_approval", via: "browser", url: f.handle.url, opened: true });
    f.resolve({ ok: true, value: { account: ACCT, chainId: 8453 } });
    await tick();
    expect(await status()).toMatchObject({ status: "connected", via: "browser", account: ACCT });
  });

  it("does not wait when no browser could be opened — the url comes straight back", async () => {
    const f = fakeHandle(false);
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect } = await import("../src/wallet-session.js");
    const t0 = Date.now();
    const s = await connect("browser", 5000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s).toMatchObject({ status: "awaiting_approval", via: "browser", opened: false });
  });

  it("reports a decline once, then disconnected", async () => {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect, status } = await import("../src/wallet-session.js");
    const p = connect("browser", 5000);
    await tick();
    f.resolve({ ok: false, reason: "User rejected the request." });
    expect(await p).toMatchObject({ status: "rejected", reason: "User rejected the request." });
    expect(await status()).toEqual({ status: "disconnected" });
  });

  it("a second connect while one is pending returns the same pending state, not a second server", async () => {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect } = await import("../src/wallet-session.js");
    await connect("browser", 0);
    const again = await connect("browser", 0);
    expect(again).toMatchObject({ status: "awaiting_approval", via: "browser" });
    expect(mockStartConnect).toHaveBeenCalledTimes(1);
  });

  it("disconnect cancels a pending page and persists nothing", async () => {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect, disconnect, status } = await import("../src/wallet-session.js");
    await connect("browser", 0);
    await disconnect();
    expect(f.close).toHaveBeenCalled();
    await tick();
    expect(await status()).toEqual({ status: "disconnected" });
  });

  it("disconnecting a connected browser session needs no WalletConnect client", async () => {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const { connect, disconnect, status } = await import("../src/wallet-session.js");
    const p = connect("browser", 5000);
    await tick();
    f.resolve({ ok: true, value: { account: ACCT, chainId: 8453 } });
    await p;
    expect(await disconnect()).toEqual({ disconnected: true });
    expect(mockInit).not.toHaveBeenCalled();
    expect(await status()).toEqual({ status: "disconnected" });
  });
});

describe("sendTransaction() for a browser session", () => {
  async function connected() {
    const f = fakeHandle();
    mockStartConnect.mockResolvedValue(f.handle);
    const mod = await import("../src/wallet-session.js");
    const p = mod.connect("browser", 5000);
    await tick();
    f.resolve({ ok: true, value: { account: ACCT, chainId: 8453 } });
    await p;
    return mod;
  }

  it("opens a sign page for the connected account and returns the hash with its on-chain check", async () => {
    const { sendTransaction } = await connected();
    const s = fakeHandle();
    mockStartSign.mockResolvedValue(s.handle);
    const p = sendTransaction(CALL);
    await tick();
    expect(mockStartSign).toHaveBeenCalledWith(CALL, ACCT);
    s.resolve({ ok: true, value: { hash: "0xtxhash", verified: "matched" } });
    expect(await p).toEqual({ status: "submitted", hash: "0xtxhash", verified: "matched" });
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("adds a stop-and-tell warning when the landed transaction is not the requested call", async () => {
    const { sendTransaction } = await connected();
    const s = fakeHandle();
    mockStartSign.mockResolvedValue(s.handle);
    const p = sendTransaction(CALL);
    await tick();
    s.resolve({ ok: true, value: { hash: "0xtxhash", verified: "mismatch" } });
    expect(await p).toMatchObject({ status: "submitted", verified: "mismatch", warning: expect.stringMatching(/do not match|does not match/) });
  });

  it("maps a decline or timeout to rejected", async () => {
    const { sendTransaction } = await connected();
    const s = fakeHandle();
    mockStartSign.mockResolvedValue(s.handle);
    const p = sendTransaction(CALL);
    await tick();
    s.resolve({ ok: false, reason: "User rejected the request." });
    expect(await p).toEqual({ status: "rejected", reason: "User rejected the request." });
  });

  it("throws, pointing at WalletConnect, when no browser can be opened here", async () => {
    const { sendTransaction } = await connected();
    const s = fakeHandle(false);
    mockStartSign.mockResolvedValue(s.handle);
    await expect(sendTransaction(CALL)).rejects.toThrow(/walletconnect/);
    expect(s.close).toHaveBeenCalled();
  });
});
