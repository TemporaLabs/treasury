import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describeWrapped, startConfirm, startConnect, verifyLanded } from "../src/flows.ts";
import type { Connected } from "../src/flows.ts";

const ME = "0x1111111111111111111111111111111111111111";
const VAULT = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}`;
const data = encodeFunctionData({ abi: parseAbi(["function deposit(uint256 assets, address receiver)"]), functionName: "deposit", args: [1_000_000n, ME] });
const call = { to: VAULT, data };
const noOpen = { openBrowser: () => true };
const txFor = (over: Partial<{ from: string; to: string; input: string; value: bigint }> = {}) => async () => ({ from: ME, to: VAULT, input: data, value: 0n, ...over });

const secretOf = (url: string) => new URL(url).searchParams.get("s")!;
const originOf = (url: string) => new URL(url).origin;
async function postResult(url: string, body: Record<string, unknown>, path = "/result") {
  const r = await fetch(`${originOf(url)}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: originOf(url) }, body: JSON.stringify({ s: secretOf(url), ...body }) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const embedded: Connected = { account: ME, chainId: 8453, walletType: "embedded", signerSession: "tok" };
const external: Connected = { account: ME, chainId: 8453, walletType: "external" };

test("confirm page info shows the decoded call and who signs", async () => {
  const h = await startConfirm(call, embedded, noOpen);
  const info = (await (await fetch(`${originOf(h.url)}/info?s=${secretOf(h.url)}`)).json()) as { signer: string; decoded: { summary: string; rows: string[][] } };
  assert.equal(info.signer, "service");
  assert.equal(info.decoded.summary, "Deposit USDC into a vault");
  h.close();
  const w = await startConfirm(call, external, noOpen);
  assert.equal(((await (await fetch(`${originOf(w.url)}/info?s=${secretOf(w.url)}`)).json()) as { signer: string }).signer, "wallet");
  w.close();
});

test("embedded wallet: nothing is signed until Confirm, then the service signs exactly once", async () => {
  let sends = 0;
  const h = await startConfirm(call, embedded, { ...noOpen, sendViaSigner: async () => (sends++, { status: "submitted" as const, hash: HASH }), getTransaction: txFor() });
  const early = await postResult(h.url, {});
  assert.equal(early.status, 400);
  assert.equal(sends, 0, "no signing without confirmed:true");
  const [a, b] = await Promise.all([postResult(h.url, { confirmed: true }), postResult(h.url, { confirmed: true })]);
  assert.equal(sends, 1, "a double click never signs twice");
  assert.ok([a.status, b.status].includes(200));
  const r = await h.done;
  assert.deepEqual(r, { ok: true, value: { hash: HASH, verified: "matched" } });
});

test("embedded wallet: a refusal from the signing service ends the flow with its reason", async () => {
  const h = await startConfirm(call, embedded, { ...noOpen, sendViaSigner: async () => ({ status: "rejected" as const, reason: "the signing service refused the call: over the cap" }) });
  const res = await postResult(h.url, { confirmed: true });
  assert.equal(res.status, 400);
  assert.deepEqual(await h.done, { ok: false, reason: "the signing service refused the call: over the cap" });
});

test("rejecting on the page settles as rejected and never signs", async () => {
  let sends = 0;
  const h = await startConfirm(call, embedded, { ...noOpen, sendViaSigner: async () => (sends++, { status: "submitted" as const, hash: HASH }) });
  await postResult(h.url, { rejected: true, reason: "rejected on the confirmation page" });
  assert.deepEqual(await h.done, { ok: false, reason: "rejected on the confirmation page" });
  assert.equal(sends, 0);
});

test("external wallet: a returned hash is verified against the requested call", async () => {
  const ok = await startConfirm(call, external, { ...noOpen, getTransaction: txFor() });
  await postResult(ok.url, { hash: HASH });
  assert.deepEqual(await ok.done, { ok: true, value: { hash: HASH, verified: "matched" } });
  const bad = await startConfirm(call, external, { ...noOpen, getTransaction: txFor({ input: `${data}ff` }) });
  await postResult(bad.url, { hash: HASH });
  const r = await bad.done;
  assert.ok(r.ok && r.value.verified === "mismatch" && r.value.detail?.includes("wrapped batch"));
});

test("external wallet: a non-hash result is refused", async () => {
  const h = await startConfirm(call, external, noOpen);
  assert.equal((await postResult(h.url, { hash: "0x1234" })).status, 400);
  h.close();
});

test("requests without the secret or from another origin are refused", async () => {
  const h = await startConfirm(call, external, noOpen);
  const noSecret = await fetch(`${originOf(h.url)}/info`);
  assert.equal(noSecret.status, 404);
  const badOrigin = await fetch(`${originOf(h.url)}/result`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify({ s: secretOf(h.url), hash: HASH }) });
  assert.equal(badOrigin.status, 403);
  h.close();
});

test("a wrapped batch is described, including a transfer riding along", () => {
  const input = `0x${"00".repeat(4)}${data.slice(2)}a9059cbb${"0".repeat(24)}${"44".repeat(20)}${(60000n).toString(16).padStart(64, "0")}`;
  const d = describeWrapped(input, call);
  assert.match(d, /requested call is inside it/);
  assert.match(d, /transfer\(0x4444444444444444444444444444444444444444, 60000 raw units\)/);
});

test("verifyLanded reports unverified when the lookup never answers", async () => {
  const r = await verifyLanded(HASH as `0x${string}`, call, ME, { getTransaction: async () => { throw new Error("nope"); } });
  assert.deepEqual(r, { verified: "unverified" });
});

test("connect: an external wallet is verified locally and the signing service is never called", async () => {
  const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
  let sessions = 0;
  const h = await startConnect({ ...noOpen, port: 0, readBundle: () => "// bundle", createSession: async () => (sessions++, { ok: false as const, reason: "must not be called" }) });
  const ch = await postResult(h.url, { address: acct.address }, "/challenge");
  const signature = await acct.signMessage({ message: ch.body.message as string });
  const res = await postResult(h.url, { kind: "external", address: acct.address, signature, chainId: "0x2105" });
  assert.equal(res.status, 200);
  assert.deepEqual(await h.done, { ok: true, value: { account: acct.address, chainId: 8453, walletType: "external" } });
  assert.equal(sessions, 0);
});

test("connect: a wrong signature, or a wallet not on Base, is refused", async () => {
  const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const h = await startConnect({ ...noOpen, port: 0, readBundle: () => "// bundle", verifySignature: async (a) => a.address === acct.address && false });
  const ch = await postResult(h.url, { address: acct.address }, "/challenge");
  const forged = await other.signMessage({ message: ch.body.message as string });
  assert.equal((await postResult(h.url, { kind: "external", address: acct.address, signature: forged, chainId: "0x2105" })).status, 400);
  assert.equal((await postResult(h.url, { kind: "external", address: acct.address, signature: forged, chainId: "0x1" })).status, 400);
  h.close();
});

test("connect: an embedded sign-in goes to the signing service and keeps its session token", async () => {
  const h = await startConnect({ ...noOpen, port: 0, readBundle: () => "// bundle", createSession: async (_t, address) => ({ ok: true as const, token: "sess", account: address }) });
  const res = await postResult(h.url, { kind: "embedded", address: ME, accessToken: "x".repeat(40) });
  assert.equal(res.status, 200);
  assert.deepEqual(await h.done, { ok: true, value: { account: ME, chainId: 8453, walletType: "embedded", signerSession: "sess" } });
});

test("connect page serves two separate paths: plain /connect without the Privy bundle, /privy with it", async () => {
  const h = await startConnect({ ...noOpen, port: 0, readBundle: () => "// bundle" });
  const s = secretOf(h.url);
  const connect = await (await fetch(`${originOf(h.url)}/connect?s=${s}`)).text();
  assert.match(connect, /Continue with Google or email/);
  assert.match(connect, /Connect a wallet/);
  assert.doesNotMatch(connect, /app\.js/);
  const privy = await (await fetch(`${originOf(h.url)}/privy?s=${s}`)).text();
  assert.match(privy, /app\.js/);
  assert.equal((await fetch(`${originOf(h.url)}/app.js?s=${s}`)).status, 200);
  h.close();
});
