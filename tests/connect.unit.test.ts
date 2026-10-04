import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, maxUint256, parseAbiItem, type Address, type Hex } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw } from "../src/build.js";
import { admit, type GateCall } from "../src/connect/gate.js";
import { verifyLanded } from "../src/connect/verify.js";
import { outcome, runConfirm, runConnect, signInMessage } from "../src/connect/commands.js";
import { readSession, writeSession } from "../src/connect/session.js";
import { defaultVault, listVaults } from "../src/registry.js";

/**
 * `treasury connect`, offline. No browser and no key: the tests play the page by speaking its HTTP
 * protocol to the real local server, and stub only the two things a browser and a chain provide — a
 * signature check and a receipt.
 */

const ACCOUNT = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const vault = defaultVault();
const usdc = vault.asset.address;
const asGate = (calls: ReturnType<typeof buildDeposit>): GateCall[] => calls.map((c) => ({ chainId: c.chainId, to: c.to, data: c.data, value: c.value }));

describe("the gate admits exactly the registry's own calls for the connected account", () => {
  it("control: a built deposit (approve + deposit) and a built withdrawal pass", () => {
    const dep = admit(asGate(buildDeposit(vault, { assetsHuman: "1", receiver: ACCOUNT, account: ACCOUNT })), ACCOUNT);
    expect(dep.map((a) => a.kind)).toEqual(["approve", "deposit"]);
    expect(dep[0]!.amount).toBe(1_000_000n);
    const wd = admit(asGate(buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" })), ACCOUNT);
    expect(wd.map((a) => a.kind)).toEqual(["withdraw"]);
  });

  const deposit = (receiver: Address = ACCOUNT, assets = 1_000_000n): GateCall => ({
    chainId: vault.chainId,
    to: vault.address,
    data: encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [assets, receiver] }),
    value: "0x0",
  });
  const approve = (spender: Address = vault.address, value = 1_000_000n, to: Address = usdc): GateCall => ({
    chainId: vault.chainId,
    to,
    data: encodeFunctionData({ abi: erc4626Abi, functionName: "approve", args: [spender, value] }),
    value: "0x0",
  });

  const refused: [string, GateCall[], RegExp][] = [
    ["shares to someone else", [deposit(OTHER)], /not the connected account/],
    ["an unlimited approval", [approve(vault.address, maxUint256), deposit()], /unlimited/],
    ["an approval to a non-vault spender", [approve(OTHER), deposit()], /not to a listed vault/],
    ["an approval on a token that is no vault's asset", [approve(vault.address, 1_000_000n, OTHER), deposit()], /not the asset of a listed vault/],
    ["an approval not followed by its deposit", [approve()], /must be followed by a deposit/],
    ["an approval for more than the deposit", [approve(vault.address, 2_000_000n), deposit()], /must be followed by a deposit of exactly/],
    ["a call to a contract outside the registry", [{ ...deposit(), to: OTHER }], /not a listed vault/],
    ["attached native value", [{ ...deposit(), value: "0x1" }], /native value/],
    ["an unsupported chain", [{ ...deposit(), chainId: 1 }], /not supported/],
    ["a plain token transfer", [{ chainId: vault.chainId, to: usdc, data: ("0xa9059cbb" + "00".repeat(64)) as Hex, value: "0x0" }], /not an approve, deposit, withdraw or redeem/],
    ["nothing at all", [], /nothing to confirm/],
  ];
  for (const [what, calls, why] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => admit(calls, ACCOUNT)).toThrow(why);
    });
  }

  it("refuses a withdrawal that pays or burns for anyone but the connected account", () => {
    const w = (receiver: Address, owner: Address): GateCall => ({
      chainId: vault.chainId,
      to: vault.address,
      data: encodeFunctionData({ abi: erc4626Abi, functionName: "withdraw", args: [1n, receiver, owner] }),
      value: "0x0",
    });
    expect(() => admit([w(OTHER, ACCOUNT)], ACCOUNT)).toThrow(/the funds would go to/);
    expect(() => admit([w(ACCOUNT, OTHER)], ACCOUNT)).toThrow(/burns the shares of/);
    expect(admit([w(ACCOUNT, ACCOUNT)], ACCOUNT)).toHaveLength(1);
  });
});

// ---- receipts --------------------------------------------------------------------------------
const ev = {
  approval: parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)"),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  deposit: parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)"),
};
const log = (address: Address, topics: Hex[], data: Hex) => ({ address, topics, data, blockHash: "0x" as Hex, blockNumber: 1n, logIndex: 0, transactionHash: "0x" as Hex, transactionIndex: 0, removed: false });
const transferLog = (from: Address, to: Address, value: bigint) =>
  log(usdc, encodeEventTopics({ abi: [ev.transfer], eventName: "Transfer", args: { from, to } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [value]));
const depositLog = (owner: Address, assets: bigint) =>
  log(vault.address, encodeEventTopics({ abi: [ev.deposit], eventName: "Deposit", args: { sender: owner, owner } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, assets]));
const approvalLog = (owner: Address, spender: Address, value: bigint) =>
  log(usdc, encodeEventTopics({ abi: [ev.approval], eventName: "Approval", args: { owner, spender } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [value]));
const receiptClient = (r: { status: "success" | "reverted"; logs: ReturnType<typeof log>[] } | "missing") => ({
  getTransactionReceipt: async () => {
    if (r === "missing") throw new Error("not found");
    return r as never;
  },
});
const HASH = `0x${"ab".repeat(32)}` as Hex;
const depositCall = { kind: "deposit" as const, vault, amount: 600_000n };

describe("verification reads the receipt, not the transaction envelope", () => {
  it("matched: the vault's Deposit for this account and amount, and only the pull it implies", async () => {
    const v = await verifyLanded(receiptClient({ status: "success", logs: [transferLog(ACCOUNT, vault.address, 600_000n), depositLog(ACCOUNT, 600_000n)] }), HASH, depositCall, ACCOUNT);
    expect(v.verified).toBe("matched");
  });

  it("extra_transfer: a smart-account batch that also pays a third address (the shape measured on Base, 2026-10-03)", async () => {
    const v = await verifyLanded(
      receiptClient({ status: "success", logs: [transferLog(ACCOUNT, vault.address, 600_000n), depositLog(ACCOUNT, 600_000n), transferLog(ACCOUNT, OTHER, 62_637n)] }),
      HASH,
      depositCall,
      ACCOUNT,
    );
    expect(v.verified).toBe("extra_transfer");
    expect(v.alsoMoved).toEqual([{ to: OTHER, amountRaw: "62637" }]);
  });

  it("mismatch: success with no Deposit for this account — or for a different amount", async () => {
    expect((await verifyLanded(receiptClient({ status: "success", logs: [] }), HASH, depositCall, ACCOUNT)).verified).toBe("mismatch");
    expect((await verifyLanded(receiptClient({ status: "success", logs: [depositLog(OTHER, 600_000n)] }), HASH, depositCall, ACCOUNT)).verified).toBe("mismatch");
    expect((await verifyLanded(receiptClient({ status: "success", logs: [depositLog(ACCOUNT, 599_999n)] }), HASH, depositCall, ACCOUNT)).verified).toBe("mismatch");
  });

  it("reverted, and unverified when no receipt arrives", async () => {
    expect((await verifyLanded(receiptClient({ status: "reverted", logs: [] }), HASH, depositCall, ACCOUNT)).verified).toBe("reverted");
    expect((await verifyLanded(receiptClient("missing"), HASH, depositCall, ACCOUNT, { attempts: 2, delayMs: 1 })).verified).toBe("unverified");
  });

  it("stops waiting for a receipt once the flow's deadline has passed", async () => {
    let reads = 0;
    const client = { getTransactionReceipt: async () => (reads++, Promise.reject(new Error("not yet"))) as never };
    const v = await verifyLanded(client, HASH, { kind: "deposit", vault, amount: 1n }, ACCOUNT, { attempts: 30, delayMs: 1, deadline: Date.now() - 1 });
    expect([v.verified, reads]).toEqual(["unverified", 0]);
  });

  it("an approval is matched by its own Approval event, to the vault, for the amount", async () => {
    const call = { kind: "approve" as const, vault, amount: 600_000n };
    expect((await verifyLanded(receiptClient({ status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }), HASH, call, ACCOUNT)).verified).toBe("matched");
    expect((await verifyLanded(receiptClient({ status: "success", logs: [approvalLog(ACCOUNT, OTHER, 600_000n)] }), HASH, call, ACCOUNT)).verified).toBe("mismatch");
  });
});

// ---- the page protocol, against the real local server ------------------------------------------
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

let home: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "treasury-connect-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_CONNECT_PORT"] = String(await freePort());
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
  delete process.env["TREASURY_CONNECT_PORT"];
});

/** Plays the page: the same requests the browser bundle makes. */
function page(url: string) {
  const u = new URL(url);
  const origin = u.origin;
  const s = u.searchParams.get("s")!;
  return {
    origin,
    s,
    info: async () => (await fetch(`${origin}/info?s=${s}`)).json() as Promise<Record<string, unknown>>,
    post: async (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify({ s, ...body }) }),
  };
}

describe("sign-in: the wallet signs the process's own message, whose nonce is the flow secret", () => {
  it("a correct signature connects, and the session file is written owner-only", async () => {
    let checked: { address: string; message: string } | undefined;
    let url = "";
    const run = runConnect({
      open: (u) => ((url = u), true),
      verifySignature: async (a) => ((checked = a), a.signature === "0x1234"),
    });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    expect((await p.info())["mode"]).toBe("connect");
    const ch = (await (await p.post("/challenge", { address: ACCOUNT.toLowerCase() })).json()) as { message: string };
    expect(ch.message).toContain(`Nonce: ${p.s}`);
    expect(ch.message).toContain(ACCOUNT);
    expect((await p.post("/result", { address: ACCOUNT, signature: "0x1234", walletType: "embedded" })).status).toBe(200);
    const r = await run;
    expect(r.result.ok).toBe(true);
    expect(checked!.message).toBe(ch.message);
    expect(readSession()).toMatchObject({ account: ACCOUNT, walletType: "embedded" });
    expect(statSync(join(home, "connect-session.json")).mode & 0o777).toBe(0o600);
  });

  it("a wrong signature is refused and leaves the page open; a rejection ends the flow and writes nothing", async () => {
    let url = "";
    const run = runConnect({ open: (u) => ((url = u), true), verifySignature: async () => false });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    await p.post("/challenge", { address: ACCOUNT });
    const bad = await p.post("/result", { address: ACCOUNT, signature: "0x99", walletType: "external" });
    expect(bad.status).toBe(400);
    await p.post("/result", { rejected: true, reason: "closed the window" });
    const r = await run;
    expect(r.result).toEqual({ ok: false, reason: "closed the window" });
    expect(readSession()).toBeUndefined();
  });

  it("a signature for an address no message was issued to is refused", async () => {
    let url = "";
    const run = runConnect({ open: (u) => ((url = u), true), verifySignature: async () => true });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    await p.post("/challenge", { address: ACCOUNT });
    expect((await (await p.post("/result", { address: OTHER, signature: "0x12", walletType: "external" })).json()) as { reason: string }).toMatchObject({ reason: /no sign-in message/ });
    await p.post("/result", { rejected: true });
    await run;
  });

  it("the server answers only its own secret, Host and Origin", async () => {
    let url = "";
    const run = runConnect({ open: (u) => ((url = u), true), verifySignature: async () => true });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    expect((await fetch(`${p.origin}/info?s=wrong`)).status).toBe(404);
    expect((await fetch(`${p.origin.replace("localhost", "127.0.0.1")}/info?s=${p.s}`)).status).toBe(403);
    expect((await p.post("/challenge", { address: ACCOUNT }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(`${p.origin}/challenge`, { method: "POST", headers: { "content-type": "application/json", origin: p.origin }, body: JSON.stringify({ s: "wrong", address: ACCOUNT }) })).status).toBe(404);
    await p.post("/result", { rejected: true });
    await run;
  });
});

describe("confirm: one call at a time, each checked on its receipt before the next may go", () => {
  it("approve then deposit: both matched, the allowance read gates step 2, the result lists both hashes", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-10-03T00:00:00Z" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const admitted = admit(asGate(calls), ACCOUNT);
    const h1 = `0x${"01".repeat(32)}` as Hex;
    const h2 = `0x${"02".repeat(32)}` as Hex;
    let allowanceReads = 0;
    const client = () => ({
      getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
        (hash === h1
          ? { status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }
          : { status: "success", logs: [transferLog(ACCOUNT, vault.address, 600_000n), depositLog(ACCOUNT, 600_000n)] }) as never,
      readContract: async () => (allowanceReads++, 600_000n) as never,
    });
    let url = "";
    const run = runConfirm(calls, admitted, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    const info = await p.info();
    expect(info["account"]).toBe(ACCOUNT);
    expect((info["calls"] as { kind: string }[]).map((c) => c.kind)).toEqual(["approve", "deposit"]);
    expect((await (await p.post("/result", { index: 1, hash: h2 })).json()) as { reason: string }).toMatchObject({ reason: /expected step 1/ });
    expect((await (await p.post("/result", { index: 0, hash: h1 })).json()) as { next: number }).toMatchObject({ next: 1 });
    expect(allowanceReads).toBeGreaterThan(0);
    expect((await (await p.post("/result", { index: 1, hash: h2 })).json()) as { finished: boolean }).toMatchObject({ finished: true });
    const r = await run;
    expect(r.result.ok && r.result.value.map((t) => [t.hash, t.verified])).toEqual([
      [h1, "matched"],
      [h2, "matched"],
    ]);
  });

  it("stops at the first step that did not land as confirmed, and sends nothing after it", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const client = () => ({ getTransactionReceipt: async () => ({ status: "reverted", logs: [] }) as never, readContract: async () => 0n as never });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    expect((await (await p.post("/result", { index: 0, hash: `0x${"01".repeat(32)}` })).json()) as { stop: boolean }).toMatchObject({ stop: true });
    const r = await run;
    expect(r.result.ok && r.result.value).toHaveLength(1);
    expect(r.result.ok && r.result.value[0]!.verified).toBe("reverted");
  });

  it("an approval whose allowance never shows is reported as stopped, never completed", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const client = () => ({
      getTransactionReceipt: async () => ({ status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }) as never,
      readContract: async () => 0n as never,
    });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    expect((await (await page(url).post("/result", { index: 0, hash: `0x${"01".repeat(32)}` })).json()) as { stop: boolean }).toMatchObject({ stop: true });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string; calls_total: number; txs: unknown[] };
    expect(out.status).toBe("stopped");
    expect(out.reason).toMatch(/deposit was not sent/);
    expect([out.txs.length, out.calls_total]).toEqual([1, 2]);
  });

  it("a cancel that arrives while a sent transaction is being checked never hides that transaction", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    const client = () => ({
      getTransactionReceipt: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] } as never;
      },
      readContract: async () => 600_000n as never,
    });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    const inFlight = p.post("/result", { index: 0, hash: h1 });
    await new Promise((r) => setTimeout(r, 100));
    let ended = false;
    void run.then(() => (ended = true));
    await p.post("/result", { rejected: true, reason: "cancelled in a second tab" });
    await new Promise((r) => setTimeout(r, 30));
    // The cancel waits for the check in flight: the command must not return before the verdict.
    expect(ended).toBe(false);
    await inFlight;
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string; txs: { hash: string; verified: string }[] };
    expect(out.status).toBe("stopped");
    expect(out.txs.map((t) => [t.hash, t.verified])).toEqual([[h1, "matched"]]);
    expect(out.reason).toMatch(/second tab/);
  });

  it("with no transaction reported, the result does not claim that nothing was sent", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: async () => ({}) as never, readContract: async () => 0n as never }) });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    await p.post("/result", { rejected: true, reason: "declined" });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; next_step: string };
    expect(out.status).toBe("not_reported");
    expect(out.next_step).toMatch(/not proof that none was sent/);
    // A page left open after the flow ended is told so before it asks the wallet for anything.
    expect((await fetch(url.replace("/confirm?", "/info?"))).status).toBe(410);
  });

  it("refuses to start when another process already holds `::1` on its port, and releases 127.0.0.1", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" });
    const port = Number(process.env["TREASURY_CONNECT_PORT"]);
    const squatter = createServer();
    const held = await new Promise<boolean>((resolve) => {
      squatter.once("error", () => resolve(false));
      squatter.listen({ port, host: "::1", ipv6Only: true }, () => resolve(true));
    });
    // A machine with IPv6 switched off has no `::1` for anyone to hold; there is nothing to test.
    if (!held) return;
    try {
      await expect(runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: () => true })).rejects.toThrow(/in use on ::1/);
      const v4 = createServer();
      await new Promise<void>((resolve, reject) => {
        v4.once("error", reject);
        v4.listen(port, "127.0.0.1", () => v4.close(() => resolve()));
      });
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });

  const hungReceipt = () => ({ getTransactionReceipt: () => new Promise<never>(() => {}), readContract: async () => 0n as never });

  it("the time limit ends the flow at once, even while a check hangs, and still reports the hash", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    let url = "";
    const started = Date.now();
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: hungReceipt, ttlMs: 400 });
    await new Promise((r) => setTimeout(r, 50));
    void page(url).post("/result", { index: 0, hash: h1 }).catch(() => undefined);
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string; txs: { hash: string; verified: string }[] };
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(out.status).toBe("stopped");
    expect(out.txs.map((t) => [t.hash, t.verified])).toEqual([[h1, "unverified"]]);
    expect(out.reason).toMatch(/limit ran out after 1 of 2 transactions/);
  });

  it("a cancel waits for a check in flight only up to its grace period", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: hungReceipt, cancelGraceMs: 150 });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    void p.post("/result", { index: 0, hash: h1 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const cancelledAt = Date.now();
    await p.post("/result", { rejected: true, reason: "cancelled" });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; txs: { hash: string; verified: string }[] };
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
    expect(out.status).toBe("stopped");
    expect(out.txs.map((t) => [t.hash, t.verified])).toEqual([[h1, "unverified"]]);
  });

  it("a hash the page could not hand over is put on record from its rejection", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: hungReceipt });
    await new Promise((r) => setTimeout(r, 50));
    await page(url).post("/result", { rejected: true, reason: "the result POST failed", hash: h1 });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; txs: { hash: string; verified: string }[] };
    expect(out.status).toBe("stopped");
    expect(out.txs.map((t) => [t.hash, t.verified])).toEqual([[h1, "unverified"]]);
  });

  it("a receipt that cannot be read stops the flow; it never lets the next step through", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const client = () => ({
      getTransactionReceipt: async () => ({ status: "success", logs: [{ address: "not-an-address", topics: [], data: "0x" }] }) as never,
      readContract: async () => 600_000n as never,
    });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const reply = (await (await page(url).post("/result", { index: 0, hash: `0x${"01".repeat(32)}` })).json()) as { stop: boolean; verdict: { verified: string } };
    expect(reply).toMatchObject({ stop: true, verdict: { verified: "unverified" } });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string };
    expect(out.status).toBe("stopped");
  });

  it("a hash already reported is refused for a later step, and /info says how long is left", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    const client = () => ({
      getTransactionReceipt: async () => ({ status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }) as never,
      readContract: async () => 600_000n as never,
    });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    const left = (await p.info())["msLeft"] as number;
    expect(left).toBeGreaterThan(8 * 60_000);
    expect(left).toBeLessThanOrEqual(9 * 60_000);
    expect((await (await p.post("/result", { index: 0, hash: h1 })).json()) as { next: number }).toMatchObject({ next: 1 });
    expect((await (await p.post("/result", { index: 1, hash: h1.toUpperCase().replace("0X", "0x") })).json()) as { reason: string }).toMatchObject({ reason: /already reported/ });
    await p.post("/result", { rejected: true });
    await run;
  });
});

describe("confirm: what the page reports with a rejection, and the deadline", () => {
  const matchedApprove = () => ({
    getTransactionReceipt: async () => ({ status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }) as never,
    readContract: async () => 600_000n as never,
  });

  it("a hash posted with a rejection is filed under the step the page names, never twice", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    const h2 = `0x${"02".repeat(32)}`;
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: matchedApprove, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    expect((await (await p.post("/result", { index: 0, hash: h1 })).json()) as { next: number }).toMatchObject({ next: 1 });
    // A second tab's approve, and a re-post of the one already recorded.
    await p.post("/result", { rejected: true, reason: "second tab", index: 0, hash: h2.toUpperCase().replace("0X", "0x") });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; txs: { hash: string; step: number; verified: string }[] };
    expect(out.status).toBe("stopped");
    expect(out.txs.map((t) => [t.step, t.verified])).toEqual([
      [calls[0]!.step, "matched"],
      [calls[0]!.step, "unverified"],
    ]);
  });

  it("a hash already on record is not recorded again from a rejection", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" });
    const h1 = `0x${"01".repeat(32)}`;
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: () => new Promise<never>(() => {}), readContract: async () => 0n as never }), cancelGraceMs: 50 });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    void p.post("/result", { index: 0, hash: h1 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await p.post("/result", { rejected: true, reason: "lost reply", index: 0, hash: h1 });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { txs: { hash: string }[] };
    expect(out.txs.map((t) => t.hash)).toEqual([h1]);
  });

  it("a hash posted with a rejection that names no step is still kept", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" });
    const h1 = `0x${"01".repeat(32)}`;
    let url = "";
    const run2 = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: matchedApprove });
    await new Promise((r) => setTimeout(r, 50));
    await page(url).post("/result", { rejected: true, reason: "no step", index: 7, hash: h1 });
    const out2 = JSON.parse(outcome(vault.chainId, ACCOUNT, await run2)) as { txs: { step: number; hash: string }[] };
    expect(out2.txs.map((t) => [t.step, t.hash])).toEqual([[0, h1]]);
  });

  it.each(["receipt", "allowance"] as const)("%s reads stop once the time limit has ended the flow", async (phase) => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    {
      let reads = 0;
      const client = () => ({
        getTransactionReceipt: async () => {
          if (phase === "receipt") return (reads++, Promise.reject(new Error("not yet"))) as never;
          return { status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] } as never;
        },
        readContract: async () => (reads++, 0n) as never,
      });
      let url = "";
      const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client, ttlMs: 300, verifyOpts: { attempts: 1_000_000, delayMs: 5 } });
      await new Promise((r) => setTimeout(r, 50));
      void page(url).post("/result", { index: 0, hash: `0x${"01".repeat(32)}` }).catch(() => undefined);
      await run;
      await new Promise((r) => setTimeout(r, 50));
      const after = reads;
      await new Promise((r) => setTimeout(r, 150));
      expect([phase, reads]).toEqual([phase, after]);
      expect(reads).toBeGreaterThan(0);
    }
  });

  it("a cancel still waiting on a check is the reason given, even when the time limit then ends the flow", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: () => new Promise<never>(() => {}), readContract: async () => 0n as never }), ttlMs: 300 });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    void p.post("/result", { index: 0, hash: `0x${"01".repeat(32)}` }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await p.post("/result", { rejected: true, reason: "cancelled by the operator" });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { reason: string };
    expect(out.reason).toBe("cancelled by the operator");
  });

  it("a stop on a step that did not land carries a reason", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    let url = "";
    const run = runConfirm(calls, admit(asGate(calls), ACCOUNT), readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: async () => ({ status: "reverted", logs: [] }) as never, readContract: async () => 0n as never }), verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    await page(url).post("/result", { index: 0, hash: `0x${"01".repeat(32)}` });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string };
    expect(out.status).toBe("stopped");
    expect(out.reason).toMatch(/step 1 .* is reverted/);
  });
});

describe("the session file", () => {
  it.skipIf(process.platform === "win32")("is owner-only even when it already existed with wider permissions", async () => {
    const { chmodSync, writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "connect-session.json"), "{}", { mode: 0o644 });
    chmodSync(join(home, "connect-session.json"), 0o644);
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    expect(statSync(join(home, "connect-session.json")).mode & 0o777).toBe(0o600);
  });
});

describe("the sign-in message", () => {
  it("names the account, the origin, the nonce, and says it moves nothing", () => {
    const m = signInMessage({ address: ACCOUNT, origin: "http://localhost:53682", nonce: "n0nce", issuedAt: "2026-10-03T00:00:00Z" });
    expect(m).toContain(ACCOUNT);
    expect(m).toContain("URI: http://localhost:53682");
    expect(m).toContain("Nonce: n0nce");
    expect(m).toMatch(/costs no gas and authorizes no transaction/);
  });
  it("every listed vault resolves for the gate (the registry the gate reads is the one shipped)", () => {
    expect(listVaults().length).toBeGreaterThan(0);
  });
});
