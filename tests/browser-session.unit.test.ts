/**
 * Unit — browser-session.ts over a REAL loopback server. Only the two network seams (signature
 * verification for contract wallets, the on-chain lookup) are injected; the HTTP surface, the
 * secret/Host/Origin checks, and the EOA signature check (viem, no network) run for real.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { canOpenBrowser, describeCall, startConnect, startSign, type Handle } from "../src/browser-session.js";

const open: Handle<unknown>[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});
const track = <T>(h: Handle<T>): Handle<T> => (open.push(h as Handle<unknown>), h);

const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const secretOf = (url: string) => new URL(url).searchParams.get("s")!;
const originOf = (url: string) => new URL(url).origin;
const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(originOf(url) + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: originOf(url), ...headers },
    body: JSON.stringify(body),
  });
const rawGet = (url: string, hostHeader: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { host: hostHeader } }, (r) => (r.resume(), resolve(r.statusCode!))).on("error", reject);
  });

const noOpen = { openBrowser: () => true };

describe("connect flow", () => {
  it("serves the page with a strict CSP, then accepts a real EOA sign-in and finishes", async () => {
    const h = track(await startConnect(noOpen));
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connect\?s=[0-9a-f]{48}$/);
    const page = await fetch(h.url);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("eip6963");

    const s = secretOf(h.url);
    expect(await (await fetch(`${originOf(h.url)}/info?s=${s}`)).json()).toEqual({ mode: "connect" });
    const ch = (await (await post(h.url, "/challenge", { s, address: acct.address.toLowerCase() })).json()) as { message: string };
    expect(ch.message).toContain(acct.address); // checksummed, whatever case the wallet sent
    expect(ch.message).toContain(`Nonce: ${s}`);
    expect(ch.message).toContain("Chain ID: 8453");
    const signature = await acct.signMessage({ message: ch.message });
    const res = await post(h.url, "/result", { s, address: acct.address, signature, chainId: "0x2105" });
    expect(res.status).toBe(200);
    expect(await h.done).toEqual({ ok: true, value: { account: acct.address, chainId: 8453 } });
    // one-shot: a second result is refused
    expect((await post(h.url, "/result", { s, address: acct.address, signature, chainId: "0x2105" })).status).toBe(409);
  });

  it("refuses a signature from a different key — the address is proven, not claimed", async () => {
    const h = track(await startConnect({ ...noOpen, verifySignature: async () => false }));
    const s = secretOf(h.url);
    const ch = (await (await post(h.url, "/challenge", { s, address: acct.address })).json()) as { message: string };
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const signature = await other.signMessage({ message: ch.message });
    const res = await post(h.url, "/result", { s, address: acct.address, signature, chainId: "0x2105" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/does not match/);
  });

  it("refuses a result for an address no challenge was issued for", async () => {
    const h = track(await startConnect({ ...noOpen, verifySignature: async () => true }));
    const s = secretOf(h.url);
    const res = await post(h.url, "/result", { s, address: acct.address, signature: "0xabcd", chainId: "0x2105" });
    expect(res.status).toBe(400);
  });

  it("refuses a wallet that is not on Base", async () => {
    const h = track(await startConnect({ ...noOpen, verifySignature: async () => true }));
    const s = secretOf(h.url);
    await post(h.url, "/challenge", { s, address: acct.address });
    const res = await post(h.url, "/result", { s, address: acct.address, signature: "0xabcd", chainId: "0x1" });
    expect(((await res.json()) as { reason: string }).reason).toMatch(/not on Base/);
  });

  it("reports a wallet rejection as a failed result", async () => {
    const h = track(await startConnect(noOpen));
    await post(h.url, "/result", { s: secretOf(h.url), rejected: true, reason: "User rejected the request." });
    expect(await h.done).toEqual({ ok: false, reason: "User rejected the request." });
  });

  it("close() ends it as cancelled", async () => {
    const h = await startConnect(noOpen);
    h.close();
    expect(await h.done).toEqual({ ok: false, reason: "cancelled" });
  });
});

describe("request hardening", () => {
  it("404s the page and info without the secret, and with a wrong one", async () => {
    const h = track(await startConnect(noOpen));
    const o = originOf(h.url);
    expect((await fetch(`${o}/connect`)).status).toBe(404);
    expect((await fetch(`${o}/connect?s=nope`)).status).toBe(404);
    expect((await fetch(`${o}/info?s=${"0".repeat(48)}`)).status).toBe(404);
    expect((await fetch(`${o}/sign?s=${secretOf(h.url)}`)).status).toBe(404); // wrong mode for this flow
  });

  it("refuses any Host that is not the loopback origin it handed out (DNS rebinding)", async () => {
    const h = track(await startConnect(noOpen));
    expect(await rawGet(h.url, "evil.example")).toBe(403);
    expect(await rawGet(h.url, new URL(h.url).host)).toBe(200);
  });

  it("refuses a POST from another Origin, or without a JSON content type", async () => {
    const h = track(await startConnect(noOpen));
    const s = secretOf(h.url);
    expect((await post(h.url, "/challenge", { s, address: acct.address }, { origin: "https://evil.example" })).status).toBe(403);
    const plain = await fetch(originOf(h.url) + "/challenge", { method: "POST", headers: { "content-type": "text/plain", origin: originOf(h.url) }, body: JSON.stringify({ s }) });
    expect(plain.status).toBe(415);
  });

  it("refuses a POST with the wrong secret, malformed JSON, or an oversized body", async () => {
    const h = track(await startConnect(noOpen));
    expect((await post(h.url, "/challenge", { s: "nope", address: acct.address })).status).toBe(404);
    const bad = await fetch(originOf(h.url) + "/result", { method: "POST", headers: { "content-type": "application/json", origin: originOf(h.url) }, body: "{not json" });
    expect(bad.status).toBe(400);
    const big = await post(h.url, "/result", { s: secretOf(h.url), pad: "x".repeat(40_000) }).catch(() => undefined);
    expect(big === undefined || big.status === 400).toBe(true);
  });

  it("binds loopback only", async () => {
    const h = track(await startConnect(noOpen));
    expect(h.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

const approveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);
const VAULT = "0x1111111111111111111111111111111111111111" as const;
const call = { to: VAULT, data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [VAULT, 5n] }) as Hex };
const HASH = `0x${"ab".repeat(32)}` as Hex;

describe("sign flow", () => {
  const landed = (over: Partial<{ from: string; to: string; input: string; value: bigint }> = {}) => async () => ({ from: acct.address, to: call.to, input: call.data, value: 0n, ...over });

  it("serves the call for the page to show, then verifies the landed transaction", async () => {
    const h = track(await startSign(call, acct.address, { ...noOpen, getTransaction: landed() }));
    const info = (await (await fetch(`${originOf(h.url)}/info?s=${secretOf(h.url)}`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ mode: "sign", account: acct.address, call: { to: VAULT, data: call.data, value: "0x0" }, decoded: `approve(${VAULT}, 5)` });
    await post(h.url, "/result", { s: secretOf(h.url), hash: HASH });
    expect(await h.done).toEqual({ ok: true, value: { hash: HASH, verified: "matched" } });
  });

  it("flags a transaction on chain that is not the call that was asked for", async () => {
    const h = track(await startSign(call, acct.address, { ...noOpen, getTransaction: landed({ input: "0xdeadbeef" }) }));
    await post(h.url, "/result", { s: secretOf(h.url), hash: HASH });
    expect(await h.done).toEqual({ ok: true, value: { hash: HASH, verified: "mismatch" } });
  });

  it("flags a transaction sent from a different account", async () => {
    const h = track(await startSign(call, acct.address, { ...noOpen, getTransaction: landed({ from: VAULT }) }));
    await post(h.url, "/result", { s: secretOf(h.url), hash: HASH });
    expect(((await h.done) as { value: { verified: string } }).value.verified).toBe("mismatch");
  });

  it("refuses something that is not a transaction hash", async () => {
    const h = track(await startSign(call, acct.address, { ...noOpen, getTransaction: landed() }));
    const res = await post(h.url, "/result", { s: secretOf(h.url), hash: "0x1234" });
    expect(res.status).toBe(400);
  });

  it("does not serve a sign-in challenge", async () => {
    const h = track(await startSign(call, acct.address, noOpen));
    expect((await post(h.url, "/challenge", { s: secretOf(h.url), address: acct.address })).status).toBe(404);
  });
});

describe("helpers", () => {
  it("describeCall reads known calldata and returns undefined for the rest", () => {
    expect(describeCall(call.data)).toBe(`approve(${VAULT}, 5)`);
    expect(describeCall("0xdeadbeef")).toBeUndefined();
  });

  it("canOpenBrowser is false over SSH or when opening is disabled", () => {
    const keep = { ...process.env };
    try {
      delete process.env.TREASURY_CONNECT_NO_OPEN;
      delete process.env.SSH_CONNECTION;
      delete process.env.SSH_TTY;
      process.env.DISPLAY = ":0";
      expect(canOpenBrowser()).toBe(true);
      process.env.SSH_CONNECTION = "1.2.3.4 1 5.6.7.8 22";
      expect(canOpenBrowser()).toBe(false);
      delete process.env.SSH_CONNECTION;
      process.env.TREASURY_CONNECT_NO_OPEN = "1";
      expect(canOpenBrowser()).toBe(false);
    } finally {
      process.env = keep;
    }
  });
});
