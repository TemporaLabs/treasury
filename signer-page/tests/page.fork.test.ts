/**
 * The page, in a real browser, against real contracts. Gated behind TREASURY_FORK=1 (it spawns
 * anvil and Chrome) and, like the other fork tests, needs an upstream Base endpoint.
 *
 * What is real: the opener, the page and its validator, headless Chrome, an anvil fork of Base, and
 * the vault. What is faked: the wallet extension. `window.ethereum` here is a bridge to this file,
 * which plays the wallet: it answers EIP-1193 requests, forwards `eth_sendTransaction` to anvil
 * (which impersonates the account — an address, never a key), and can be made to fail the ways a
 * real wallet does. The one thing this cannot prove is that a real extension injects itself into a
 * page served with the opener's policy; that needs a person and MetaMask, and the PR says so.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";
import { erc4626Abi } from "../../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw, type UnsignedCall } from "../../src/build.js";
import { getVault } from "../../src/registry.js";
import { EARN } from "../../src/config/earn.js";
import { encodePayload, slimPayload } from "../validate.mjs";

const CHROME = [process.env["CHROME_BIN"], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));
const upstream = process.env["TREASURY_RPC_BASE"] || process.env["BASE_RPC_URL"];
const enabled = process.env["TREASURY_FORK"] === "1" && !!upstream;
if (process.env["TREASURY_FORK"] === "1" && !CHROME) console.warn("signer-page fork tests SKIPPED: no Chrome found (set CHROME_BIN); nothing about the page was checked in a browser");
const fork = enabled && CHROME ? describe : describe.skip;

const OPENER = resolve(import.meta.dirname, "..", "open.mjs");
const ACCOUNT: Address = EARN.fixtures.usdcWhale;
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const vault = getVault(EARN.roundTripVault);
const PORT = 20545 + (process.pid % 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 60_000 }) });

let anvil: ChildProcess | undefined;
let chrome: ChildProcess | undefined;
let profile = "";
let cdp: Cdp;

async function anvilRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string; code: number } };
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A just-enough Chrome DevTools Protocol client, over the WebSocket Node already has. */
class Cdp {
  private id = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private listeners: ((m: any) => void)[] = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? w?.no(new Error(m.error.message)) : w?.ok(m.result); }
      else this.listeners.forEach((l) => l(m));
    };
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error(`cannot reach Chrome at ${url}`)); });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    // A call Chrome never answers must fail by name, not hang the run behind the test's own timeout.
    return new Promise((ok, no) => {
      const timer = setTimeout(() => { this.waiting.delete(id); no(new Error(`Chrome did not answer ${method} within 30s`)); }, 30_000);
      this.waiting.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, no: (e) => { clearTimeout(timer); no(e); } });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(l: (m: any) => void) { this.listeners.push(l); }
  off(l: (m: any) => void) { this.listeners = this.listeners.filter((x) => x !== l); }
  close() { this.ws.close(); }
}

/** The page half of the fake wallet: every request goes out through a binding and waits for the reply. */
const WALLET_SHIM = `(() => {
  const pending = new Map(); const handlers = {}; let n = 0;
  window.__walletReply = (id, result, error) => { const p = pending.get(id); pending.delete(id); error ? p.no(Object.assign(new Error(error.message), { code: error.code })) : p.ok(result); };
  window.__emit = (ev, ...a) => (handlers[ev] || []).forEach((f) => f(...a));
  window.ethereum = {
    request: ({ method, params }) => new Promise((ok, no) => { const id = ++n; pending.set(id, { ok, no }); window.__wallet(JSON.stringify({ id, method, params: params || [] })); }),
    on: (ev, f) => { (handlers[ev] = handlers[ev] || []).push(f); },
  };
})();`;

type Handler = (params: unknown[]) => Promise<unknown> | unknown;
/** The wallet the page talks to. `calls` is everything it was asked; `on` overrides one method. */
class FakeWallet {
  calls: { method: string; params: any[] }[] = [];
  chainId = "0x2105";
  account: string = ACCOUNT;
  private overrides = new Map<string, Handler>();
  on(method: string, h: Handler) { this.overrides.set(method, h); }
  sent() { return this.calls.filter((c) => c.method === "eth_sendTransaction"); }
  async handle(method: string, params: any[]): Promise<unknown> {
    this.calls.push({ method, params });
    const o = this.overrides.get(method);
    if (o) return o(params);
    if (method === "eth_chainId") return this.chainId;
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [this.account];
    if (method === "wallet_switchEthereumChain") return null;
    return anvilRpc(method, params); // the fork: reads, estimates, and (impersonated) sends
  }
}

/** One browser tab with a fake wallet in it. */
async function openTab(wallet: FakeWallet | null, opts: { fastClock?: boolean } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
  const listener = async (m: any) => {
    if (m.sessionId !== sessionId || m.method !== "Runtime.bindingCalled" || m.params.name !== "__wallet") return;
    const { id, method, params } = JSON.parse(m.params.payload);
    let result: unknown = null, error: { message: string; code?: number } | null = null;
    try { result = await wallet!.handle(method, params); } catch (e: any) { error = { message: String(e?.message ?? e), code: e?.code }; }
    await s("Runtime.evaluate", { expression: `window.__walletReply(${id}, ${JSON.stringify(result ?? null)}, ${JSON.stringify(error)})` });
  };
  cdp.on(listener);
  await s("Page.enable"); await s("Runtime.enable");
  if (wallet) { await s("Runtime.addBinding", { name: "__wallet" }); await s("Page.addScriptToEvaluateOnNewDocument", { source: WALLET_SHIM }); }
  // The page gives up on a receipt after ~3 minutes. To reach that state in a test, this tab's timers
  // longer than half a second run in 5ms. Injected here only; the shipped page has no such switch.
  if (opts.fastClock) await s("Page.addScriptToEvaluateOnNewDocument", { source: "{ const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms > 500 ? 5 : ms, ...a); }" });
  const ev = async (expression: string) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    ev,
    goto: async (url: string) => { await s("Page.navigate", { url }); },
    /** Wait until `expression` is truthy; on timeout, fail with the page's own text so the reason is visible. */
    waitFor: async (expression: string, what: string, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await ev(`(() => { try { return !!(${expression}); } catch { return false; } })()`).catch(() => false)) return; await sleep(100); }
      throw new Error(`timed out waiting for ${what}. The page says: ${await ev("document.body.innerText").catch(() => "(unreadable)")}`);
    },
    text: (sel: string) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`) as Promise<string>,
    click: (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`),
    disabled: (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).disabled`) as Promise<boolean>,
    close: async () => { cdp.off(listener); await cdp.send("Target.closeTarget", { targetId }); },
  };
}
type Tab = Awaited<ReturnType<typeof openTab>>;
const step = (k: number, part: string) => `#steps .step:nth-child(${k}) ${part}`;
const send = (k: number) => step(k, ".head button");

/** Start the opener for real, exactly as an operator would, and return the URL it prints. */
function serve(envelope: unknown, account: string | null = ACCOUNT, thenEnvelope?: unknown): Promise<{ url: string; stop: () => void }> {
  const thenArgs: string[] = [];
  if (thenEnvelope) { const f = join(mkdtempSync(join(tmpdir(), "treasury-then-")), "then.json"); writeFileSync(f, JSON.stringify(thenEnvelope)); thenArgs.push("--then", f); }
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", ...(account ? ["--account", account] : []), ...thenArgs], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stderr!.on("data", (d) => (err += d));
    child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok({ url: m[1]!, stop: () => child.kill() }); });
    child.on("exit", (c) => no(new Error(`opener exited ${c}: ${err}`)));
    child.stdin!.end(JSON.stringify(envelope));
  });
}
/** Start the opener in manual mode (no envelope) and return the URL it prints. */
function serveManual(): Promise<{ url: string; stop: () => void }> {
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", "--manual"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stderr!.on("data", (d) => (err += d));
    child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok({ url: m[1]!, stop: () => child.kill() }); });
    child.on("exit", (c) => no(new Error(`opener exited ${c}: ${err}`)));
  });
}
const unsigned = (calls: UnsignedCall[]) => ({ requires_signature: true, status: "unsigned", calls });
const AMOUNT = "1"; // USDC: enough to see every number move, cheap enough that no assertion depends on the whale's balance
const depositCalls = (usdc = AMOUNT) => buildDeposit(vault, { assetsHuman: usdc, receiver: ACCOUNT, account: ACCOUNT });
/** Send calls straight to the fork as the impersonated account, the way the page's wallet does: estimate, × 1.5, send. */
async function direct(calls: UnsignedCall[]) {
  for (const c of calls) {
    const est = BigInt((await anvilRpc("eth_estimateGas", [{ from: ACCOUNT, to: c.to, data: c.data, value: "0x0" }])) as string);
    await anvilRpc("eth_sendTransaction", [{ from: ACCOUNT, to: c.to, data: c.data, value: "0x0", gas: "0x" + ((est * 3n) / 2n).toString(16) }]);
  }
}
const shares = () => pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "balanceOf", args: [ACCOUNT] }) as Promise<bigint>;
const allowance = () => pub.readContract({ address: vault.asset.address, abi: erc20Abi, functionName: "allowance", args: [ACCOUNT, vault.address] });

fork("the sign page in a browser, on a fork of Base", () => {
  let snapshot: unknown;
  let served: { url: string; stop: () => void } | undefined;
  let tab: Tab | undefined;
  let wallet: FakeWallet;

  beforeAll(async () => {
    // A few blocks behind head, as the other fork test does, so a load-balanced upstream has the block
    // everywhere. TREASURY_FORK_BLOCK pins one instead: anvil caches what it fetches for a pinned block
    // on disk, so a re-run at the same block does not pay the upstream again.
    const head = await createPublicClient({ chain: base, transport: http(upstream!) }).getBlockNumber();
    const pinned = process.env["TREASURY_FORK_BLOCK"] ? BigInt(process.env["TREASURY_FORK_BLOCK"]) : head - 8n;
    anvil = spawn("anvil", ["--fork-url", upstream!, "--fork-block-number", pinned.toString(), "--port", String(PORT), "--silent", "--no-rate-limit"], { stdio: "ignore" });
    for (const end = Date.now() + 60_000; ; await sleep(300)) { try { await pub.getBlockNumber(); break; } catch { if (Date.now() > end) throw new Error("anvil did not come up"); } }
    await anvilRpc("anvil_autoImpersonateAccount", [true]);
    await anvilRpc("anvil_setBalance", [ACCOUNT, "0xde0b6b3a7640000"]);
    // A fork fetches each storage slot it touches from upstream, and the first deposit into a vault
    // touches many (measured on a public endpoint: 24s to 17 minutes cold, 0.1s warm). Pay that once
    // here rather than inside a test's wait. The fetched slots survive evm_revert (measured), and the
    // position is fully redeemed, so the account is back to no shares and no allowance without one.
    await direct(depositCalls());
    await direct(buildWithdraw(vault, { all: true, sharesExact: formatUnits(await shares(), vault.shareDecimals), receiver: ACCOUNT, owner: ACCOUNT }));
    expect(await shares()).toBe(0n);
    expect(await allowance()).toBe(0n);

    profile = mkdtempSync(join(tmpdir(), "treasury-sign-chrome-"));
    chrome = spawn(CHROME!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"], { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    for (const end = Date.now() + 30_000; !existsSync(portFile); await sleep(200)) if (Date.now() > end) throw new Error("Chrome did not open a debugging port");
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  }, 300_000);

  afterAll(async () => {
    cdp?.close();
    // Chrome writes to its profile until it has exited, so wait for that before removing it.
    const gone = chrome && new Promise<void>((r) => chrome!.once("exit", () => r()));
    chrome?.kill("SIGTERM");
    anvil?.kill("SIGTERM");
    if (gone) await Promise.race([gone, sleep(10_000)]);
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, 60_000);

  beforeEach(async () => { snapshot = await anvilRpc("evm_snapshot"); wallet = new FakeWallet(); });
  afterEach(async () => {
    await Promise.race([tab?.close().catch(() => {}), sleep(5_000)]);
    served?.stop(); tab = served = undefined;
    await anvilRpc("evm_revert", [snapshot]);
  }, 60_000);

  /** Open the page for `envelope` and connect the fake wallet, leaving it at step 1. */
  async function connected(envelope: unknown = unsigned(depositCalls()), opts: { fastClock?: boolean } = {}) {
    served = await serve(envelope);
    tab = await openTab(wallet, opts);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#destination').hidden", "the destination card");
    await tab.click("#btn-connect");
    await tab.waitFor("document.querySelector('#steps .step')", "the steps to render");
    return tab;
  }
  const confirmed = (t: Tab, k: number) => t.waitFor(`/confirmed in block/.test(document.querySelector(${JSON.stringify(step(k, ".status"))}).innerText)`, `step ${k} to confirm`);

  it("approve → deposit lands, with two wallet confirmations and no other write", async () => {
    const calls = depositCalls();
    const t = await connected(unsigned(calls));

    const card = await t.text("#destination");
    expect(card).toContain(vault.name);
    expect(card).toContain(vault.address); //           the registry's address, not the envelope's
    expect(card).toContain(vault.warning); //           the registry says to show this before any deposit
    expect(card).toContain(ACCOUNT);
    expect(card).toMatch(/Approve 1 USDC/); //          decoded from the calldata

    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    expect(await t.disabled(send(2))).toBe(true); //    the second step cannot be sent first
    await t.click(send(1));
    await confirmed(t, 1);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");
    await t.click(send(2));
    await confirmed(t, 2);
    await t.waitFor("!document.querySelector('#done').hidden", "the done card");

    expect(wallet.sent()).toHaveLength(2);
    wallet.sent().forEach((tx, i) => {
      const p = tx.params[0];
      expect({ from: p.from.toLowerCase(), to: p.to.toLowerCase(), data: p.data, value: p.value }).toEqual({ from: ACCOUNT.toLowerCase(), to: calls[i]!.to.toLowerCase(), data: calls[i]!.data, value: "0x0" });
      expect(BigInt(p.gas)).toBeGreaterThan(0n);
    });
    const writes = new Set(wallet.calls.map((c) => c.method).filter((m) => !/^eth_(chainId|accounts|call|estimateGas|getTransactionCount|getTransactionReceipt|getTransactionByHash|getBalance)$/.test(m)));
    expect([...writes].sort()).toEqual(["eth_requestAccounts", "eth_sendTransaction"]);
    // Not a USDC balance check: the fixture account is Morpho Blue itself, which the vault deposits
    // into, so its USDC nets to zero. What proves the deposit is shares minted, the allowance spent,
    // and the shares being worth what was put in.
    const minted = await shares();
    expect(minted).toBeGreaterThan(0n);
    expect(await allowance()).toBe(0n);
    const worth = (await pub.readContract({ address: vault.address, abi: erc4626Abi, functionName: "convertToAssets", args: [minted] })) as bigint;
    expect(worth).toBeGreaterThan(990_000n);
    expect(worth).toBeLessThanOrEqual(1_000_000n);
    expect(await t.text("#summary")).toMatch(/step 1: 0x[0-9a-f]{64}[\s\S]*step 2: 0x[0-9a-f]{64}/);
  }, 90_000);

  it("follow mode: an envelope prepared for another account is re-aimed at the wallet that connects", async () => {
    // Prepared for OTHER; the wallet that connects is ACCOUNT. No --account was given.
    const forOther = buildDeposit(vault, { assetsHuman: AMOUNT, receiver: OTHER, account: OTHER });
    served = await serve(unsigned(forOther), null);
    tab = await openTab(wallet);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#destination').hidden", "the destination card");
    const before = await tab.text("#destination");
    expect(before).toContain("the wallet you connect");
    expect(before).not.toContain(OTHER); //  the placeholder the agent prepared for is never shown as the destination
    expect(before).not.toContain(ACCOUNT); // and the real address is not known until a wallet connects
    await tab.click("#btn-connect");
    await tab.waitFor("document.querySelector('#steps .step')", "the steps to render");
    const after = await tab.text("#destination");
    expect(after).toContain(ACCOUNT); //     now it reads the connected wallet's address
    expect(after).not.toContain(OTHER);

    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await tab.click(send(1));
    await confirmed(tab, 1);
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");
    await tab.click(send(2));
    await confirmed(tab, 2);
    // What went to the wallet is the deposit re-aimed at ACCOUNT, and the shares landed with ACCOUNT.
    const deposit = wallet.sent()[1]!.params[0];
    expect(deposit.data.toLowerCase()).toBe(depositCalls()[1]!.data.toLowerCase());
    expect(await shares()).toBeGreaterThan(0n);
  }, 90_000);

  it("follow mode: switching account pauses the page, and Connect again re-aims the calls at the new account before anything is sent", async () => {
    served = await serve(unsigned(depositCalls()), null);
    tab = await openTab(wallet);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#destination').hidden", "the destination card");
    await tab.click("#btn-connect");
    await tab.waitFor("document.querySelector('#steps .step')", "the steps to render");
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    wallet.account = OTHER; //             the operator switches account inside the wallet
    await tab.ev("window.__emit('accountsChanged', [" + JSON.stringify(OTHER) + "])");
    await tab.waitFor("/Paused: .*not " + ACCOUNT + "/.test(document.querySelector('#wallet-status').innerText)", "the pause message");
    expect(await tab.disabled(send(1))).toBe(true);
    expect(await tab.text("#destination")).toContain(ACCOUNT); //   paused, not silently re-aimed
    expect(await tab.disabled("#btn-connect")).toBe(false); //     and there is a way forward without reloading

    await tab.click("#btn-connect"); //    the explicit choice
    await tab.waitFor("/Connected .* on Base/.test(document.querySelector('#wallet-status').innerText) && document.querySelector('#destination').innerText.includes(" + JSON.stringify(OTHER) + ")", "the page to follow the new account");
    const card = await tab.text("#destination");
    expect(card).toContain(OTHER);
    expect(card).not.toContain(ACCOUNT);
    expect(await tab.ev("document.querySelectorAll('#steps .step').length")).toBe(2); // redrawn, not duplicated
    expect(wallet.sent()).toEqual([]);
  }, 60_000);

  it("follow mode: once a transaction has been sent, the calls cannot move to another account", async () => {
    served = await serve(unsigned(depositCalls()), null);
    tab = await openTab(wallet);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#destination').hidden", "the destination card");
    await tab.click("#btn-connect");
    await tab.waitFor(`document.querySelector(${JSON.stringify(send(1))}) && !document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await tab.click(send(1));
    await confirmed(tab, 1);
    wallet.account = OTHER;
    await tab.ev("window.__emit('accountsChanged', [" + JSON.stringify(OTHER) + "])");
    await tab.waitFor("!document.querySelector('#btn-connect').disabled", "Connect to be available");
    await tab.click("#btn-connect");
    await tab.waitFor("/already been sent from/.test(document.querySelector('#wallet-status').innerText)", "the refusal");
    const card = await tab.text("#destination");
    expect(card).toContain(ACCOUNT);
    expect(card).not.toContain(OTHER);
    expect(wallet.sent()).toHaveLength(1);
  }, 90_000);

  it("deposit then withdraw on one page: the withdraw step appears only after the deposit confirms", async () => {
    // Deposit 1 USDC, then take 0.5 USDC back out, all from one address, following the connected wallet.
    const out = buildWithdraw(vault, { assetsHuman: "0.5", receiver: OTHER, owner: OTHER });
    served = await serve(unsigned(buildDeposit(vault, { assetsHuman: AMOUNT, receiver: OTHER, account: OTHER })), null, unsigned(out));
    tab = await openTab(wallet);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#destination').hidden", "the destination card");
    expect(await tab.text("#destination")).toMatch(/Withdraw 0\.5 USDC/); // disclosed up front, before connecting
    await tab.click("#btn-connect");
    await tab.waitFor("document.querySelector('#steps .step')", "the steps to render");
    const visible = () => tab!.ev("[...document.querySelectorAll('#steps .step')].filter((e) => !e.hidden).length") as Promise<number>;
    expect(await visible()).toBe(2); //           approve and deposit; no withdraw button yet
    expect(await tab.text("#steps")).not.toMatch(/Withdraw/);

    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await tab.click(send(1)); await confirmed(tab, 1);
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");
    await tab.click(send(2)); await confirmed(tab, 2);
    await tab.waitFor("document.querySelectorAll('#steps .step:not([hidden])').length === 3", "the withdraw step to appear");
    expect(await tab.text("#steps")).toMatch(/Withdraw 0\.5 USDC/);
    expect(await tab.ev("document.querySelector('#done').hidden")).toBe(true); // not done: the withdraw is still to send

    const held = await shares();
    expect(held).toBeGreaterThan(0n);
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(3))}).disabled`, "step 3 to be ready");
    await tab.click(send(3)); await confirmed(tab, 3);
    await tab.waitFor("!document.querySelector('#done').hidden", "the done card");
    const left = await shares();
    expect(left).toBeGreaterThan(0n);  //          only half came out
    expect(left).toBeLessThan(held);
    expect(wallet.sent()).toHaveLength(3);
    const w = wallet.sent()[2]!.params[0];
    expect(w.data.slice(0, 10)).toBe("0xb460af94"); // withdraw(assets, receiver, owner)
    expect(w.data.toLowerCase()).toContain(ACCOUNT.slice(2).toLowerCase()); // re-aimed at the connected wallet, not the placeholder
    expect(w.data.toLowerCase()).not.toContain(OTHER.slice(2).toLowerCase());
  }, 120_000);

  /** Open manual mode and connect the fake wallet; the position card is up when this returns. */
  async function manualConnected() {
    served = await serveManual();
    tab = await openTab(wallet);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    await tab.click("#btn-connect");
    await tab.waitFor("!document.querySelector('#manual').hidden && !document.querySelector('#btn-deposit').disabled", "the position and the deposit button");
    return tab;
  }
  const typeInto = (t: Tab, sel: string, value: string) => t.ev(`document.querySelector(${JSON.stringify(sel)}).value = ${JSON.stringify(value)}`);

  it("manual mode: a bad amount is refused with a reason, and nothing is built or sent", async () => {
    const t = await manualConnected();
    expect(await t.text("#position")).toContain(vault.name);
    expect(await t.text("#position")).toContain(vault.warning); //  shown before any deposit can be reviewed
    expect(await t.text("#position")).toContain(ACCOUNT); //     the connected wallet, from the wallet
    expect(await t.disabled("#btn-withdraw")).toBe(true); //     no shares yet, so no withdraw to offer
    expect(await t.disabled("#max-withdraw")).toBe(true);
    expect(await t.ev("document.querySelector('#send-panel').hidden")).toBe(true); // sending is a Privy-mode feature only
    for (const [typed, why] of [["", /enter an amount/], ["0", /more than zero/], ["abc", /enter an amount/], ["1e3", /enter an amount/], ["0.0000001", /decimal places/], ["900000000000", /you have/]] as const) {
      await typeInto(t, "#amt-deposit", typed);
      await t.click("#btn-deposit");
      await t.waitFor(`/${why.source}/.test(document.querySelector('#manual-msg').innerText)`, `a refusal for ${JSON.stringify(typed)}`);
      expect(await t.ev("document.querySelector('#calls').hidden")).toBe(true); // no steps were offered
    }
    expect(wallet.sent()).toEqual([]);
  }, 60_000);

  it("manual mode: deposit, take part out, then take everything out, each with an amount typed on the page", async () => {
    const t = await manualConnected();

    // Deposit 1 USDC. The page builds approve + deposit; they are what Treasury's own builder makes.
    await typeInto(t, "#amt-deposit", AMOUNT);
    await t.click("#btn-deposit");
    await t.waitFor("document.querySelectorAll('#steps .step').length === 2", "the two deposit steps");
    expect(await t.text("#destination")).toMatch(/Deposit 1 USDC/);
    expect(await t.text("#destination")).toContain(ACCOUNT);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await t.click(send(1)); await confirmed(t, 1);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");
    await t.click(send(2)); await confirmed(t, 2);
    await t.waitFor("!document.querySelector('#done').hidden", "the done card");
    const want = depositCalls();
    expect(wallet.sent().map((x) => x.params[0].data.toLowerCase())).toEqual(want.map((c) => c.data.toLowerCase()));
    const held = await shares();
    expect(held).toBeGreaterThan(0n);
    await t.waitFor("!document.querySelector('#btn-withdraw').disabled", "withdraw to be offered now there is a position");

    // More than the position is worth is refused; half of it is not.
    await typeInto(t, "#amt-withdraw", "5");
    await t.click("#btn-withdraw");
    await t.waitFor("/your position is worth/.test(document.querySelector('#manual-msg').innerText)", "the refusal");
    await typeInto(t, "#amt-withdraw", "0.5");
    await t.click("#btn-withdraw");
    await t.waitFor("document.querySelectorAll('#steps .step').length === 1 && /Withdraw 0\\.5 USDC/.test(document.querySelector('#steps').innerText)", "the withdraw step");
    expect(await t.ev("document.querySelector('#done').hidden")).toBe(true); // the earlier run's Done card is gone
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "the withdraw to be ready");
    await t.click(send(1)); await confirmed(t, 1);
    const afterHalf = await shares();
    expect(afterHalf).toBeGreaterThan(0n);
    expect(afterHalf).toBeLessThan(held);

    // Everything: a redeem of the exact share balance, so nothing is left behind.
    await t.waitFor("!document.querySelector('#max-withdraw').disabled", "withdraw everything to be offered");
    await t.click("#max-withdraw");
    await t.waitFor("document.querySelectorAll('#steps .step').length === 1 && /Redeem/.test(document.querySelector('#steps').innerText)", "the redeem step");
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "the redeem to be ready");
    await t.click(send(1)); await confirmed(t, 1);
    expect(await shares()).toBe(0n);
    await t.waitFor("document.querySelector('#btn-withdraw').disabled", "withdraw to be withdrawn again once the position is gone");
    const writes = new Set(wallet.calls.map((c) => c.method).filter((m) => !/^eth_(chainId|accounts|call|estimateGas|getTransactionCount|getTransactionReceipt|getTransactionByHash|getBalance)$/.test(m)));
    expect([...writes].sort()).toEqual(["eth_requestAccounts", "eth_sendTransaction"]);
  }, 180_000);

  it("privy mode: no wallet extension is needed, login is offered, and a new wallet is told how to get funded", async () => {
    // A stub stands in for Privy's 5 MB bundle: it answers like a wallet that was just created (no USDC, no ETH).
    const NEW_WALLET = "0x3333333333333333333333333333333333333333";
    const stubFile = join(mkdtempSync(join(tmpdir(), "treasury-privy-stub-")), "privy-provider.js");
    writeFileSync(stubFile, `export async function connectPrivy(appId) {
      globalThis.__privyAppId = appId;
      const answers = { eth_chainId: "0x2105", eth_accounts: ["${NEW_WALLET}"], eth_requestAccounts: ["${NEW_WALLET}"], eth_call: "0x" + "0".repeat(64), eth_getBalance: "0x0" };
      return { request: async ({ method }) => answers[method], on() {} };
    }`);
    const url = await new Promise<string>((ok, no) => {
      const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", "--manual", "--privy-app-id", "cmubfegl2028d0ci3n0f2u6z5", "--privy-bundle", stubFile], { stdio: ["ignore", "pipe", "pipe"] });
      served = { url: "", stop: () => child.kill() };
      let out = "";
      child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok(m[1]!); });
      child.on("exit", (c) => no(new Error(`opener exited ${c}`)));
    });
    tab = await openTab(null); //                        a browser with no wallet extension at all
    await tab.goto(url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    expect(await tab.ev("document.querySelector('#fatal').hidden")).toBe(true); // not "no wallet extension found"
    expect(await tab.text("#btn-connect")).toBe("Log in");
    expect(await tab.text("#wallet-status")).toMatch(/Choose email, Google, or a wallet/);
    expect(await tab.ev("globalThis.__privyAppId")).toBe("cmubfegl2028d0ci3n0f2u6z5");

    await tab.click("#btn-connect");
    await tab.waitFor("!document.querySelector('#manual').hidden && document.querySelector('#position').innerText.length > 0", "the position card");
    const pos = await tab.text("#position");
    expect(pos).toContain(NEW_WALLET);
    expect(pos).toMatch(/fund this wallet/i); //          told to send USDC and ETH on Base to the address shown
    expect(pos).toMatch(/low: a vault transaction can be refused/);
    // A deposit it cannot cover is refused before anything is built.
    await typeInto(tab, "#amt-deposit", "1");
    await tab.click("#btn-deposit");
    await tab.waitFor("/you have 0 USDC/.test(document.querySelector('#manual-msg').innerText)", "the refusal");
    expect(await tab.ev("document.querySelector('#calls').hidden")).toBe(true);
  }, 60_000);

  it("privy mode: Log out ends the session and lets a different person log in, on the same page, with no reload", async () => {
    // The stub tracks which of two identities is "logged in" and answers eth_accounts accordingly — a
    // real Privy session, tracked the same way, in its own storage, is what logout() actually clears.
    const FIRST = "0x1111111111111111111111111111111111111111", SECOND = "0x4444444444444444444444444444444444444444";
    const stubFile = join(mkdtempSync(join(tmpdir(), "treasury-privy-stub-")), "privy-provider.js");
    writeFileSync(stubFile, `export async function connectPrivy() {
      let who = "${FIRST}";
      const answers = () => ({ eth_chainId: "0x2105", eth_accounts: [who], eth_requestAccounts: [who], eth_call: "0x" + "0".repeat(64), eth_getBalance: "0x0" });
      return {
        request: async ({ method }) => answers()[method],
        on() {},
        async logout() { who = "${SECOND}"; globalThis.__loggedOut = (globalThis.__loggedOut ?? 0) + 1; },
      };
    }`);
    const url = await new Promise<string>((ok, no) => {
      const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", "--manual", "--privy-app-id", "cmubfegl2028d0ci3n0f2u6z5", "--privy-bundle", stubFile], { stdio: ["ignore", "pipe", "pipe"] });
      served = { url: "", stop: () => child.kill() };
      let out = "";
      child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok(m[1]!); });
      child.on("exit", (c) => no(new Error(`opener exited ${c}`)));
    });
    tab = await openTab(null);
    await tab.goto(url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    expect(await tab.ev("document.querySelector('#btn-logout').hidden")).toBe(true); // not offered before anyone is logged in

    await tab.click("#btn-connect");
    await tab.waitFor("document.querySelector('#position').innerText.includes(" + JSON.stringify(FIRST) + ")", "the first person's position");
    expect(await tab.ev("document.querySelector('#btn-logout').hidden")).toBe(false);
    expect(await tab.disabled("#btn-connect")).toBe(true); // no way to switch identity except Log out

    await tab.click("#btn-logout");
    await tab.waitFor("!document.querySelector('#btn-connect').disabled && document.querySelector('#btn-logout').hidden", "the logged-out state");
    expect(await tab.ev("globalThis.__loggedOut")).toBe(1); // Privy's own session was actually ended, not just hidden on screen
    expect(await tab.text("#wallet-status")).toMatch(/Logged out/);
    expect(await tab.ev("document.querySelector('#manual').hidden")).toBe(true); // the first person's position is off screen, not just stale

    await tab.click("#btn-connect"); // the next person's turn
    await tab.waitFor("document.querySelector('#position').innerText.includes(" + JSON.stringify(SECOND) + ")", "the second person's position");
    expect(await tab.text("#position")).not.toContain(FIRST);
  }, 60_000);

  it("privy mode: Log out is refused while a transaction from the current run is still unconfirmed", async () => {
    const stubFile = join(mkdtempSync(join(tmpdir(), "treasury-privy-stub-")), "privy-provider.js");
    writeFileSync(stubFile, "export async function connectPrivy() { return window.ethereum; }");
    await new Promise<void>((ok, no) => {
      const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", "--manual", "--privy-app-id", "cmubfegl2028d0ci3n0f2u6z5", "--privy-bundle", stubFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) { served = { url: m[1]!, stop: () => child.kill() }; ok(); } });
      child.on("exit", (c) => no(new Error(`opener exited ${c}`)));
    });
    tab = await openTab(wallet); // ACCOUNT holds USDC (the fixture whale), routed to the fork
    await tab.goto(served!.url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    await tab.click("#btn-connect");
    await tab.waitFor("!document.querySelector('#btn-deposit').disabled", "the deposit button to be ready");
    await typeInto(tab, "#amt-deposit", AMOUNT);
    await tab.click("#btn-deposit");
    await tab.waitFor("document.querySelectorAll('#steps .step').length === 2", "the two deposit steps");
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await tab.click(send(1));
    await confirmed(tab, 1);
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");
    // The deposit's second step has not been sent yet: logging out here would abandon it mid-sequence.
    await tab.click("#btn-logout");
    await tab.waitFor("/has not finished/.test(document.querySelector('#wallet-status').innerText)", "the refusal");
    expect(await tab.ev("document.querySelector('#btn-logout').hidden")).toBe(false); // still logged in
    expect(await tab.disabled(send(2))).toBe(false); // the run itself is untouched
  }, 90_000);

  it("privy mode: send USDC to another address, which is checked in full, and lands exactly", async () => {
    // The stub hands the page the injected fake wallet (routed to the fork) as if it were Privy's provider.
    const RECIPIENT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address; // an EIP-55 test-vector address
    const stubFile = join(mkdtempSync(join(tmpdir(), "treasury-privy-stub-")), "privy-provider.js");
    writeFileSync(stubFile, "export async function connectPrivy() { return window.ethereum; }");
    await new Promise<void>((ok, no) => {
      const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", "--manual", "--privy-app-id", "cmubfegl2028d0ci3n0f2u6z5", "--privy-bundle", stubFile], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) { served = { url: m[1]!, stop: () => child.kill() }; ok(); } });
      child.on("exit", (c) => no(new Error(`opener exited ${c}`)));
    });
    tab = await openTab(wallet);
    await tab.goto(served!.url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    await tab.click("#btn-connect");
    await tab.waitFor("!document.querySelector('#manual').hidden && !document.querySelector('#btn-send').disabled", "the send panel to be ready");
    expect(await tab.ev("document.querySelector('#send-panel').hidden")).toBe(false);

    const refuse = async (amount: string, to: string, why: RegExp) => {
      await typeInto(tab!, "#amt-send", amount);
      await typeInto(tab!, "#send-to", to);
      await tab!.click("#btn-send");
      await tab!.waitFor(`/${why.source}/.test(document.querySelector('#manual-msg').innerText)`, `a refusal for ${JSON.stringify(to)} / ${amount}`);
      expect(await tab!.ev("document.querySelector('#calls').hidden")).toBe(true); // nothing was built
    };
    await refuse("1", "", /enter the full address/);
    await refuse("1", "0x1234", /enter the full address/);
    await refuse("1", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd", /typo/); //   one capital letter changed
    await refuse("1", ACCOUNT, /own address/);
    await refuse("1", vault.address, /token or vault contract/);
    await refuse("1", vault.asset.address, /token or vault contract/);
    await refuse("1", "0x" + "0".repeat(40), /zero address/);
    await refuse("0", RECIPIENT, /more than zero/);
    await refuse("900000000000", RECIPIENT, /you have/);
    expect(wallet.sent()).toEqual([]);

    const usdcOf = (a: Address) => pub.readContract({ address: vault.asset.address, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
    const before = await usdcOf(RECIPIENT);
    await typeInto(tab, "#amt-send", "1.25");
    await typeInto(tab, "#send-to", RECIPIENT.toLowerCase()); //   pasted in one case: accepted, and shown checksummed
    await tab.click("#btn-send");
    await tab.waitFor("document.querySelectorAll('#steps .step').length === 1", "the send step");
    const card = await tab.text("#destination");
    expect(card).toContain(RECIPIENT); //                          the recipient in full, in its checksummed form
    expect(card).toMatch(/Send 1\.25 USDC to /);
    expect(card).toMatch(/Check every character/);
    expect(card).not.toContain(vault.name); //                     a send is not shown as a vault action
    await tab.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "the send to be ready");
    await tab.click(send(1)); await confirmed(tab, 1);

    expect((await usdcOf(RECIPIENT)) - before).toBe(1_250_000n); // exactly what was typed, to exactly that address
    const tx = wallet.sent()[0]!.params[0];
    expect(tx.to.toLowerCase()).toBe(vault.asset.address.toLowerCase());
    expect(tx.data.toLowerCase()).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 1_250_000n] }).toLowerCase());
    const writes = new Set(wallet.calls.map((c) => c.method).filter((m) => !/^eth_(chainId|accounts|call|estimateGas|getTransactionCount|getTransactionReceipt|getTransactionByHash|getBalance)$/.test(m)));
    expect([...writes].sort()).toEqual(["eth_requestAccounts", "eth_sendTransaction"]);
  }, 120_000);

  it("privy mode with the REAL bundle: email, Google and wallet options render together on one screen — no second click to find a wallet", async () => {
    // Not a stub here: the actual ~5.6 MB Privy bundle this repo builds, so this is the one place a CSP
    // regression (a host silently dropped from the allow-list) would actually be caught, and the one place
    // a regression to the old "Continue with a wallet" button (one extra click to even see a wallet) would
    // be caught too.
    const url = await new Promise<string>((ok, no) => {
      const child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "5", "--manual", "--privy-app-id", "cmubfegl2028d0ci3n0f2u6z5"], { stdio: ["ignore", "pipe", "pipe"] });
      served = { url: "", stop: () => child.kill() };
      let out = "";
      child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok(m[1]!); });
      child.on("exit", (c) => no(new Error(`opener exited ${c}`)));
    });
    tab = await openTab(null); // a browser with no wallet extension at all
    await tab.goto(url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    expect(await tab.ev("document.querySelector('#fatal').hidden")).toBe(true); // real Privy starts cleanly under this policy
    await tab.click("#btn-connect");
    // The wallet tiles are fetched from explorer-api.walletconnect.com, which this policy must allow. A
    // blocked fetch does not error visibly — the modal just never grows past email — so the real signal is
    // that specific wallet names (not this test's own words) show up unprompted, on the very first screen.
    await tab.waitFor("/Google/.test(document.body.innerText) && /Wallet|MetaMask|Coinbase|Rainbow/.test(document.body.innerText) && !document.body.innerText.includes('Continue with a wallet')", "email, Google and wallet tiles together, with no intermediate button", 15_000);
    expect(await tab.ev("document.querySelector('#fatal').hidden")).toBe(true);
  }, 60_000);

  it("withdraw everything (redeem the exact share balance) empties the position", async () => {
    // Put a position in place directly on the fork, then take it out through the page.
    await direct(depositCalls());
    const held = await shares();
    expect(held).toBeGreaterThan(0n);
    const t = await connected(unsigned(buildWithdraw(vault, { all: true, sharesExact: formatUnits(held, vault.shareDecimals), receiver: ACCOUNT, owner: ACCOUNT })));
    expect(await t.text("#destination")).toMatch(/Redeem/);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await t.click(send(1));
    await confirmed(t, 1);
    expect(await shares()).toBe(0n);
  }, 90_000);

  it("a poisoned envelope pasted into the address never reaches the wallet", async () => {
    served = await serve(unsigned(depositCalls())); // a good opener, only to serve the page's files
    const evil = slimPayload(ACCOUNT, buildDeposit(vault, { assetsHuman: "1", receiver: OTHER, account: ACCOUNT }));
    tab = await openTab(wallet);
    await tab.goto(served.url.split("#")[0] + "#" + encodePayload(evil));
    await tab.waitFor("!document.querySelector('#fatal').hidden", "the refusal");
    expect(await tab.text("#fatal")).toMatch(/Stopped: .*receiver .* is not the connected account/);
    expect(await tab.ev("document.querySelector('#destination').hidden && document.querySelector('#connect').hidden")).toBe(true);
    await sleep(500);
    expect(wallet.calls).toEqual([]); // not even a chainId read: the wallet was never asked anything
  }, 60_000);

  it("the agent's description is shown as text and never becomes markup", async () => {
    const calls = depositCalls().map((c) => ({ ...c, description: `<img src=x onerror="window.__pwned=1"><b>bold</b>` }));
    const t = await connected(unsigned(calls as UnsignedCall[]));
    expect(await t.text("#steps")).toContain(`<img src=x onerror="window.__pwned=1"><b>bold</b>`);
    expect(await t.ev("document.querySelectorAll('#steps img, #steps b').length")).toBe(0);
    expect(await t.ev("window.__pwned === undefined")).toBe(true);
  }, 60_000);

  it("a rejected confirmation can be tried again; nothing was sent by the rejection", async () => {
    let first = true;
    wallet.on("eth_sendTransaction", (p) => { if (first) { first = false; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } return anvilRpc("eth_sendTransaction", p as unknown[]); });
    const t = await connected();
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    const nonce = await pub.getTransactionCount({ address: ACCOUNT });
    await t.click(send(1));
    await t.waitFor(`/rejected it in the wallet/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the rejection message");
    expect(await pub.getTransactionCount({ address: ACCOUNT })).toBe(nonce);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "the button to come back");
    await t.click(send(1));
    await confirmed(t, 1);
    expect(await pub.getTransactionCount({ address: ACCOUNT })).toBe(nonce + 1);
    expect(await allowance()).toBe(1_000_000n);
  }, 90_000);

  it("a receipt poll that errors is not a failed transaction: the page keeps watching and never sends again", async () => {
    let polls = 0;
    wallet.on("eth_getTransactionReceipt", (p) => { if (++polls <= 3) throw new Error("rpc unavailable"); return anvilRpc("eth_getTransactionReceipt", p as unknown[]); });
    const t = await connected();
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    const nonce = await pub.getTransactionCount({ address: ACCOUNT });
    await t.click(send(1));
    await t.waitFor(`/waiting for the receipt/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the page to be polling");
    expect(await t.disabled(send(1))).toBe(true); // the polls are failing right now, and the button is still off
    expect(await t.disabled(send(2))).toBe(true);
    await confirmed(t, 1); //                       the fourth poll succeeds
    expect(wallet.sent()).toHaveLength(1);
    expect(await pub.getTransactionCount({ address: ACCOUNT })).toBe(nonce + 1);
  }, 90_000);

  it("a hash the wallet returns but the network never received is called out, and the step can then be sent again", async () => {
    // The wallet says "sent" with a hash, and nothing is broadcast: no node knows the hash, the nonce never moves.
    wallet.on("eth_sendTransaction", () => "0x" + "ab".repeat(32));
    const t = await connected(undefined, { fastClock: true });
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    const nonce = await pub.getTransactionCount({ address: ACCOUNT });
    await t.click(send(1));
    await t.waitFor(`/never reached Base/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the not-on-the-network message");
    expect(await pub.getTransactionCount({ address: ACCOUNT })).toBe(nonce); // truly nothing was sent
    expect(await t.disabled(send(1))).toBe(false); //                            so it may be sent again

    // The wallet works this time: same page, same step, and it lands.
    wallet.on("eth_sendTransaction", (p) => anvilRpc("eth_sendTransaction", p as unknown[]));
    await t.click(send(1));
    await confirmed(t, 1);
    expect(await pub.getTransactionCount({ address: ACCOUNT })).toBe(nonce + 1);
  }, 90_000);

  it("a transaction that is merely slow is never called lost: if the nonce moved, the step stays locked", async () => {
    // Same missing receipt and unknown hash, but the account's pending nonce has moved: the wallet's node
    // has the transaction. This is the case where a re-send would be a second approve, so it must not unlock.
    let sent = false;
    wallet.on("eth_sendTransaction", () => { sent = true; return "0x" + "cd".repeat(32); });
    wallet.on("eth_getTransactionCount", async (p) => { const n = BigInt((await anvilRpc("eth_getTransactionCount", p as unknown[])) as string); return "0x" + (sent ? n + 1n : n).toString(16); });
    const t = await connected(undefined, { fastClock: true });
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await t.click(send(1));
    await t.waitFor(`/no receipt yet/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the still-pending message");
    expect(await t.text(step(1, ".status"))).not.toMatch(/never reached/);
    expect(await t.disabled(send(1))).toBe(true);
  }, 90_000);

  it("when the receipt never shows, the step stays locked as sent, and can be checked again", async () => {
    // Polling has given up here, so nothing is "busy": only the recorded transaction hash keeps the
    // send button off. This is the state in which a re-send would be a second approve or deposit.
    let withhold = true;
    wallet.on("eth_getTransactionReceipt", (p) => (withhold ? null : anvilRpc("eth_getTransactionReceipt", p as unknown[])));
    const t = await connected(undefined, { fastClock: true });
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    const nonce = await pub.getTransactionCount({ address: ACCOUNT });
    await t.click(send(1));
    await t.waitFor(`/no receipt yet/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the page to give up polling");
    expect(await t.disabled(send(1))).toBe(true);
    expect(await t.disabled(send(2))).toBe(true);
    expect(await t.ev(`!document.querySelector(${JSON.stringify(step(1, "button.secondary"))}).hidden`)).toBe(true);
    expect(wallet.sent()).toHaveLength(1);
    expect(await pub.getTransactionCount({ address: ACCOUNT })).toBe(nonce + 1); // it did land; a re-send would move this to +2

    withhold = false;
    await t.click(step(1, "button.secondary"));
    await confirmed(t, 1);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");
    expect(wallet.sent()).toHaveLength(1);
  }, 60_000);

  it("an error after the transaction was broadcast blocks the step instead of offering a re-send", async () => {
    wallet.on("eth_sendTransaction", async (p) => { await anvilRpc("eth_sendTransaction", p as unknown[]); throw new Error("connection to the wallet dropped"); });
    const t = await connected();
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await t.click(send(1));
    await t.waitFor(`/may have been sent/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the blocked message");
    expect(await t.text(step(1, ".status"))).toMatch(/will not send it again/);
    expect(await t.disabled(send(1))).toBe(true);
    expect(await t.disabled(send(2))).toBe(true);
    expect(wallet.sent()).toHaveLength(1);
    expect(await allowance()).toBe(1_000_000n); // it did land; a second send would have been a second approve
  }, 60_000);

  it("a wallet that leaves Base between steps pauses the page, sends nothing, and resumes when it is back", async () => {
    const t = await connected();
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    await t.click(send(1));
    await confirmed(t, 1);
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "step 2 to be ready");

    wallet.chainId = "0x1";
    await t.ev("window.__emit('chainChanged', '0x1')");
    await t.waitFor("/Paused: .*not Base/.test(document.querySelector('#wallet-status').innerText)", "the pause message");
    expect(await t.disabled(send(2))).toBe(true);
    expect(wallet.sent()).toHaveLength(1);

    wallet.chainId = "0x2105";
    await t.ev("window.__emit('chainChanged', '0x2105')");
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(2))}).disabled`, "the page to resume");
    await t.click(send(2));
    await confirmed(t, 2);
    expect(wallet.sent()).toHaveLength(2);
  }, 90_000);

  it("a chain change the page is not told about is still caught at the moment of sending", async () => {
    const t = await connected();
    await t.waitFor(`!document.querySelector(${JSON.stringify(send(1))}).disabled`, "step 1 to be ready");
    wallet.chainId = "0x89"; // no event: the page's flag still says fine
    await t.click(send(1));
    await t.waitFor(`/Not sent: .*not Base/.test(document.querySelector(${JSON.stringify(step(1, ".status"))}).innerText)`, "the refusal");
    expect(wallet.sent()).toEqual([]);
  }, 60_000);

  it("a wallet whose selected account is not the envelope's is refused at connect, and no step appears", async () => {
    wallet.account = OTHER;
    served = await serve(unsigned(depositCalls()));
    tab = await openTab(wallet);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#connect').hidden", "the connect card");
    await tab.click("#btn-connect");
    await tab.waitFor("/will not adapt the calls/.test(document.querySelector('#wallet-status').innerText)", "the mismatch message");
    expect(await tab.ev("document.querySelector('#calls').hidden")).toBe(true);
    expect(wallet.sent()).toEqual([]);
  }, 60_000);

  it("a browser with no wallet says so instead of showing a dead button", async () => {
    served = await serve(unsigned(depositCalls()));
    tab = await openTab(null);
    await tab.goto(served.url);
    await tab.waitFor("!document.querySelector('#fatal').hidden", "the no-wallet message", 10_000);
    expect(await tab.text("#fatal")).toMatch(/no wallet extension found/);
    expect(await tab.ev("document.querySelector('#connect').hidden")).toBe(true);
  }, 30_000);
});
