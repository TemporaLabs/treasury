import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, maxUint256, parseAbiItem, type Address, type Hex } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildDeposit, buildWithdraw } from "../src/build.js";
import { admit, type GateCall } from "../src/connect/gate.js";
import { verifyLanded } from "../src/connect/verify.js";
import { buildConnectCommands, outcome, runConfirm, runConnect, signInMessage, type ConnectDeps } from "../src/connect/commands.js";
import { pendingAckPath, readSession, writeSession } from "../src/connect/session.js";
import { PAGE_CSP } from "../src/connect/page.js";
import { ACK_TTL_MS } from "../src/connect/ack.js";
import { run } from "../src/cli.js";
import { DISCLOSURES } from "../src/disclosures.js";
import { operatorWarning } from "../src/connect/ack.js";
import { linksFor } from "../src/links.js";
import { defaultVault, getVault, listVaults } from "../src/registry.js";

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
    [
      "an approval to one vault followed by a deposit of that amount into another vault on the chain",
      [approve(), { ...deposit(), to: listVaults().find((v) => v.chainId === vault.chainId && v.address !== vault.address && v.asset.address === usdc)!.address }],
      /must be followed by a deposit of exactly that amount into the same vault/,
    ],
  ];
  for (const [what, calls, why] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => admit(calls, ACCOUNT)).toThrow(why);
    });
  }

  const withdraw = (data?: Hex, v = vault): GateCall => ({
    chainId: v.chainId,
    to: v.address,
    data: data ?? encodeFunctionData({ abi: erc4626Abi, functionName: "withdraw", args: [1_000_000n, ACCOUNT, ACCOUNT] }),
    value: "0x0",
  });
  const arbVault = listVaults().find((v) => v.chainId === 42161)!;

  it("refuses a batch on more than one chain, before anything else is read", () => {
    expect(() => admit([withdraw(), withdraw(undefined, arbVault)], ACCOUNT)).toThrow(/more than one chain/);
    expect(() => admit([...asGate(buildDeposit(vault, { assetsHuman: "1", receiver: ACCOUNT, account: ACCOUNT })), withdraw(undefined, arbVault)], ACCOUNT)).toThrow(/more than one chain/);
  });

  it("refuses any batch that is not approve+deposit, withdraw or redeem", () => {
    const redeem: GateCall = { ...withdraw(), data: encodeFunctionData({ abi: erc4626Abi, functionName: "redeem", args: [1n, ACCOUNT, ACCOUNT] }) };
    for (const calls of [[deposit()], [withdraw(), withdraw()], [withdraw(), redeem], [approve(), deposit(), deposit()], [approve(), deposit(), withdraw()]]) {
      expect(() => admit(calls, ACCOUNT)).toThrow(/is not a batch this page confirms/);
    }
    expect(admit([redeem], ACCOUNT).map((a) => a.kind)).toEqual(["redeem"]);
  });

  it("refuses calldata that is not its own canonical encoding: trailing bytes, or stray bits in an address word", () => {
    const clean = withdraw().data;
    // withdraw(uint256 assets, address receiver, address owner): word 1 is the receiver.
    const dirtyReceiver = (clean.slice(0, 10) + clean.slice(10, 74) + "ff" + clean.slice(76)) as Hex;
    const ap = approve().data;
    const dirtySpender = (ap.slice(0, 10) + "01" + ap.slice(12)) as Hex;
    expect(admit([withdraw(clean)], ACCOUNT)).toHaveLength(1);
    for (const data of [`${clean}00`, `${clean}${"00".repeat(32)}`, `${clean}${"ab".repeat(64)}`, dirtyReceiver]) {
      expect(() => admit([withdraw(data as Hex)], ACCOUNT)).toThrow(/not the canonical encoding/);
    }
    expect(() => admit([{ ...approve(), data: dirtySpender }, deposit()], ACCOUNT)).toThrow(/not the canonical encoding/);
    // Decoding accepts arguments in upper case once the selector is lower case; the wallet would sign those bytes.
    const upperArgs = (clean.slice(0, 10) + clean.slice(10).toUpperCase()) as Hex;
    expect(upperArgs).not.toBe(clean);
    expect(() => admit([withdraw(upperArgs)], ACCOUNT)).toThrow(/not the canonical encoding/);
  });

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
  withdraw: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"),
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
const withdrawLog = (receiver: Address, owner: Address, assets: bigint, shares: bigint) =>
  log(vault.address, encodeEventTopics({ abi: [ev.withdraw], eventName: "Withdraw", args: { sender: owner, receiver, owner } }) as Hex[], encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, shares]));
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

  it("a withdrawal is matched only when the vault paid the connected account itself", async () => {
    const call = { kind: "withdraw" as const, vault, amount: 600_000n };
    expect((await verifyLanded(receiptClient({ status: "success", logs: [withdrawLog(ACCOUNT, ACCOUNT, 600_000n, 5n)] }), HASH, call, ACCOUNT)).verified).toBe("matched");
    expect((await verifyLanded(receiptClient({ status: "success", logs: [withdrawLog(OTHER, ACCOUNT, 600_000n, 5n)] }), HASH, call, ACCOUNT)).verified).toBe("mismatch");
  });

  it("a redeem is matched on the shares it burned, not on the assets it paid", async () => {
    const call = { kind: "redeem" as const, vault, amount: 5n };
    expect((await verifyLanded(receiptClient({ status: "success", logs: [withdrawLog(ACCOUNT, ACCOUNT, 600_000n, 5n)] }), HASH, call, ACCOUNT)).verified).toBe("matched");
    expect((await verifyLanded(receiptClient({ status: "success", logs: [withdrawLog(ACCOUNT, ACCOUNT, 600_000n, 4n)] }), HASH, call, ACCOUNT)).verified).toBe("mismatch");
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

  it("the page is served with exactly PAGE_CSP, the policy connect-page-source.unit.test.ts pins", async () => {
    let url = "";
    const run = runConnect({ open: (u) => ((url = u), true), verifySignature: async () => false });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    await page(url).post("/result", { rejected: true });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
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

  it("a transaction that landed is not reported as still being checked", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}` as Hex;
    const h2 = `0x${"02".repeat(32)}` as Hex;
    // Step 1 matched (no detail of its own); step 2 extra_transfer (a detail of its own).
    const client = () => ({
      getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
        (hash === h1
          ? { status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }
          : { status: "success", logs: [transferLog(ACCOUNT, vault.address, 600_000n), depositLog(ACCOUNT, 600_000n), transferLog(ACCOUNT, OTHER, 62_637n)] }) as never,
      readContract: async () => 600_000n as never,
    });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    await p.post("/result", { index: 0, hash: h1 });
    await p.post("/result", { index: 1, hash: h2 });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; txs: { verified: string; detail?: string }[] };
    expect(out.status).toBe("completed");
    expect(out.txs.map((t) => t.verified)).toEqual(["matched", "extra_transfer"]);
    expect(out.txs[0]!.detail).toBeUndefined();
    expect(out.txs[1]!.detail).toMatch(/also sent/);
    for (const t of out.txs) expect(t.detail ?? "").not.toMatch(/still being checked/);
  });

  it("stops at the first step that did not land as confirmed, and sends nothing after it", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const client = () => ({ getTransactionReceipt: async () => ({ status: "reverted", logs: [] }) as never, readContract: async () => 0n as never });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    expect((await (await page(url).post("/result", { index: 0, hash: `0x${"01".repeat(32)}` })).json()) as { stop: boolean }).toMatchObject({ stop: true });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string; calls_total: number; txs: unknown[] };
    expect(out.status).toBe("stopped");
    expect(out.reason).toMatch(/deposit was not sent/);
    expect([out.txs.length, out.calls_total]).toEqual([1, 2]);
  });

  it("tells the page what the wallet holds, what the deposit needs, and where to look a transaction up", async () => {
    writeSession({ account: ACCOUNT, walletType: "embedded", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const client = () => ({
      getTransactionReceipt: () => new Promise<never>(() => {}),
      readContract: async (q: { functionName: string; args: readonly unknown[] }) => (q.functionName === "balanceOf" && q.args[0] === ACCOUNT ? 250_000n : 0n) as never,
      getBalance: async ({ address }: { address: Address }) => (address === ACCOUNT ? 0n : 1n) as never,
    });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    expect(await p.info()).toMatchObject({
      balances: { asset: "250000", native: "0" },
      needs: "600000",
      asset: { symbol: "USDC", decimals: 6 },
      nativeSymbol: "ETH",
      txBase: "https://basescan.org/tx/",
    });
    await p.post("/result", { rejected: true });
    await run;
  });

  it("a balance read that hangs leaves balances out instead of holding the page back", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" });
    const client = () => ({ getTransactionReceipt: () => new Promise<never>(() => {}), readContract: () => new Promise<never>(() => {}) });
    let url = "";
    const started = Date.now();
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, balanceTimeoutMs: 100 });
    while (!url && Date.now() - started < 2_000) await new Promise((r) => setTimeout(r, 10));
    expect(Date.now() - started).toBeLessThan(1_000);
    const info = await page(url).info();
    expect(info["balances"]).toBeUndefined();
    expect(info["needs"]).toBeUndefined();
    await page(url).post("/result", { rejected: true });
    await run;
  });

  it("runs the gate itself on the calls it will hand the wallet, before any page opens", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const session = readSession()!;
    let opened = false;
    const deps = { open: () => (opened = true), client: hungReceipt };
    const dep = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const arb = listVaults().find((v) => v.chainId === 42161)!;
    // shares to someone else; a batch across two chains; a batch shape no builder emits
    await expect(runConfirm(buildDeposit(vault, { assetsHuman: "0.6", receiver: OTHER, account: ACCOUNT }), session, deps)).rejects.toThrow(/not the connected account/);
    await expect(runConfirm([...buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" }), ...buildWithdraw(arb, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" })], session, deps)).rejects.toThrow(/more than one chain/);
    await expect(runConfirm([dep[1]!], session, deps)).rejects.toThrow(/is not a batch this page confirms/);
    expect(opened).toBe(false);
  });

  it("the allowance read before a deposit comes from the admitted calls, not the call's own precondition field", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const built = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    // A precondition that would always hold, naming another token, owner and spender.
    const calls = built.map((c) => (c.precondition ? { ...c, precondition: { ...c.precondition, contract: OTHER, owner: OTHER, spender: OTHER, minimum: "0" } } : c));
    const reads: unknown[] = [];
    const client = () => ({
      getTransactionReceipt: async () => ({ status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }) as never,
      readContract: async (q: { address: Address; functionName: string; args: readonly unknown[] }) => (q.functionName === "allowance" && reads.push([q.address, ...q.args]), 599_999n) as never,
    });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    expect((await (await page(url).post("/result", { index: 0, hash: `0x${"01".repeat(32)}` })).json()) as { stop: boolean }).toMatchObject({ stop: true });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string };
    expect(out).toMatchObject({ status: "stopped", reason: expect.stringMatching(/deposit was not sent/) });
    expect(reads).toEqual([[usdc, ACCOUNT, vault.address]]);
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: async () => ({}) as never, readContract: async () => 0n as never }) });
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
      await expect(runConfirm(calls, readSession()!, { open: () => true })).rejects.toThrow(/in use on ::1/);
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: hungReceipt, ttlMs: 400 });
    await new Promise((r) => setTimeout(r, 50));
    void page(url).post("/result", { index: 0, hash: h1 }).catch(() => undefined);
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; reason: string; txs: { hash: string; verified: string; detail?: string }[] };
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(out.status).toBe("stopped");
    expect(out.txs.map((t) => [t.hash, t.verified])).toEqual([[h1, "unverified"]]);
    // The check never finished, so the placeholder is the true account of this hash.
    expect(out.txs[0]!.detail).toMatch(/still being checked/);
    expect(out.reason).toMatch(/limit ran out after 1 of 2 transactions/);
  });

  it("a cancel waits for a check in flight only up to its grace period", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const h1 = `0x${"01".repeat(32)}`;
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: hungReceipt, cancelGraceMs: 150 });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: hungReceipt });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
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

describe("confirm: one result at a time", () => {
  it("a second result posted while the first is being checked is refused, so one call is never handed over twice", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    const client = () => ({
      getTransactionReceipt: async () => (await new Promise((r) => setTimeout(r, 300)), { status: "success", logs: [approvalLog(ACCOUNT, vault.address, 600_000n)] }) as never,
      readContract: async () => 600_000n as never,
    });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    const first = p.post("/result", { index: 0, hash: `0x${"01".repeat(32)}` });
    await new Promise((r) => setTimeout(r, 50));
    const second = await p.post("/result", { index: 0, hash: `0x${"02".repeat(32)}` });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { reason: string }).reason).toMatch(/already in progress/);
    expect((await first).status).toBe(200);
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: matchedApprove, verifyOpts: { attempts: 1, delayMs: 1 } });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: () => new Promise<never>(() => {}), readContract: async () => 0n as never }), cancelGraceMs: 50 });
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
    const run2 = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: matchedApprove });
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
      const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, ttlMs: 300, verifyOpts: { attempts: 1_000_000, delayMs: 5 } });
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
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: () => new Promise<never>(() => {}), readContract: async () => 0n as never }), ttlMs: 300 });
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    void p.post("/result", { index: 0, hash: `0x${"01".repeat(32)}` }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await p.post("/result", { rejected: true, reason: "cancelled by the operator" });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { reason: string };
    expect(out.reason).toBe("cancelled by the operator");
  });

  it("a flow that ended before every call was reported says so, even with no step's own reason", () => {
    const tx = { step: 1, description: "approve", hash: `0x${"01".repeat(32)}`, verified: "matched" as const };
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, { result: { ok: true, value: [tx] }, opened: true, done: [tx], total: 2 })) as { status: string; reason?: string };
    expect(out.status).toBe("stopped");
    expect(out.reason).toBe("the flow ended after 1 of 2 transactions");
  });

  it("a stop on a step that did not land carries a reason", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildDeposit(vault, { assetsHuman: "0.6", receiver: ACCOUNT, account: ACCOUNT });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client: () => ({ getTransactionReceipt: async () => ({ status: "reverted", logs: [] }) as never, readContract: async () => 0n as never }), verifyOpts: { attempts: 1, delayMs: 1 } });
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

/**
 * `connect deposit` / `connect withdraw` open the signing page only after the operator's
 * acknowledgement. The browser opener and the chain client are stubs, and a page that opens is left
 * to time out, so what is observed is only whether it opened.
 */
describe("the acknowledgement before any signing page opens", () => {
  let clock: Date;
  let opened: string[];
  beforeEach(() => {
    clock = new Date("2026-10-04T12:00:00Z");
    opened = [];
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-10-04T11:59:00Z" });
  });
  const deps = (): ConnectDeps => ({
    open: (u) => (opened.push(u), true),
    client: () => ({ getTransactionReceipt: async () => ({}) as never, readContract: async () => 0n as never }),
    ttlMs: 150,
    balanceTimeoutMs: 20,
    now: () => clock,
  });
  async function connect(name: "connect_deposit" | "connect_withdraw", args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const c = buildConnectCommands(deps())[name]!;
    return JSON.parse(await c.handler(c.inputSchema.parse({ receiver: ACCOUNT, vault: vault.symbol, ...args }) as never)) as Record<string, unknown>;
  }

  describe("without --ack, nothing opens: the command returns the operator's acknowledgement", () => {
    it("a deposit returns needs_acknowledgement, opens no page, and records the acknowledgement as pending", async () => {
      const r = await connect("connect_deposit", { amount_usdc: "1" });
      expect(r["status"]).toBe("needs_acknowledgement");
      expect(r["opened"]).toBe(false);
      expect(opened).toEqual([]);
      expect(r["ack"]).toMatch(/^[0-9a-f]{8}$/);
      expect(r["expiresAtIso"]).toBe(new Date(clock.getTime() + ACK_TTL_MS).toISOString());
      expect(existsSync(pendingAckPath())).toBe(true);
      expect(String(r["next_step"])).toContain(`--ack ${String(r["ack"])}`);
    });

    it("the text names the amount, chain, vault and its link, the receiver, the warning and every disclosure, and asks yes or no", async () => {
      const text = String((await connect("connect_deposit", { amount_usdc: "1" }))["acknowledgement"]);
      for (const part of [
        "Deposit: 1 USDC",
        `${vault.chainId}`,
        vault.name,
        vault.symbol,
        linksFor(vault).explorer,
        `Shares go to: ${ACCOUNT}`,
        operatorWarning(vault.warning),
        ...DISCLOSURES.plain.deposit,
        ...DISCLOSURES.plain.always,
        DISCLOSURES.plain.fullTerms,
        "Reply yes or no.",
      ]) {
        expect(text).toContain(part);
      }
    });

    it("the operator reads the vault's warning, not the instruction to the agent that ends it in the registry", async () => {
      expect(vault.warning, "premise: the registry's warning carries that instruction").toMatch(/Show this warning before preparing any deposit\./);
      for (const name of ["connect_deposit", "connect_withdraw"] as const) {
        const text = String((await connect(name, { amount_usdc: "1" }))["acknowledgement"]);
        expect(text).toContain("WARNING: TEST VAULT");
        expect(text).not.toMatch(/Show this warning/);
      }
    });

    it("a withdrawal's warning drops the deposit advice; a deposit's keeps it", async () => {
      expect(vault.warning, "premise: the registry's warning carries deposit advice").toMatch(/Deposit only an amount/);
      const wd = String((await connect("connect_withdraw", { amount_usdc: "1" }))["acknowledgement"]);
      expect(wd).toContain("WARNING: TEST VAULT");
      expect(wd).not.toMatch(/Deposit only an amount/);
      const dep = String((await connect("connect_deposit", { amount_usdc: "1" }))["acknowledgement"]);
      expect(dep).toMatch(/Deposit only an amount you are fully prepared to lose/);
    });

    it("a deposit says the wallet will ask twice, approve then deposit; a withdrawal says once", async () => {
      const dep = String((await connect("connect_deposit", { amount_usdc: "1" }))["acknowledgement"]);
      expect(dep).toContain("Your wallet will ask you twice: first to approve 1 USDC to the vault, then to make the deposit.");
      const wd = String((await connect("connect_withdraw", { amount_usdc: "1" }))["acknowledgement"]);
      expect(wd).toContain("Your wallet will ask you once, to make the withdrawal.");
    });

    it("says who signs: the operator's own wallet through connect, or their own signer, never this client", async () => {
      // Through `connect` the operator's wallet signs, so a note naming only "the operator's own signer" described the prepare path alone.
      const note = DISCLOSURES.clientNotes[0];
      expect(note).toBe("This client never signs, sends, or moves funds. Every transaction is signed by the operator's own wallet (through `connect`) or the operator's own signer, and the operator is responsible for what it signs.");
      // The acknowledgement says the same in plain words, on a deposit and on a withdrawal.
      for (const name of ["connect_deposit", "connect_withdraw"] as const) {
        expect(String((await connect(name, { amount_usdc: "1" }))["acknowledgement"])).toContain("This software never signs or moves your money. You approve every transaction in your own wallet");
      }
    });

    it("a deposit into a vault that is not open to every account says so; an open vault's text does not", async () => {
      const gated = getVault("tlCashPlusUSDC2A");
      expect(gated.depositOpen.open, "premise: this vault is whitelist-gated").toBe(false);
      expect(vault.depositOpen.open, "premise: the default vault is open").toBe(true);
      expect(String((await connect("connect_deposit", { amount_usdc: "1", vault: gated.symbol }))["acknowledgement"])).toContain(DISCLOSURES.plain.gatedDeposit);
      expect(String((await connect("connect_deposit", { amount_usdc: "1" }))["acknowledgement"])).not.toContain(DISCLOSURES.plain.gatedDeposit);
      expect(String((await connect("connect_withdraw", { amount_usdc: "1", vault: gated.symbol }))["acknowledgement"])).not.toContain(DISCLOSURES.plain.gatedDeposit);
    });

    it("carries the disclosures in plain words, short enough to read every time; the full text stays in earn terms", async () => {
      const text = String((await connect("connect_deposit", { amount_usdc: "1" }))["acknowledgement"]);
      // The full, formal items are what `earn terms` returns; none of them is pasted here.
      for (const full of [...DISCLOSURES.items, ...DISCLOSURES.clientNotes]) expect(text).not.toContain(full);
      expect(text.length).toBeLessThan(1_600);
      // A gated vault's deposit is the longest form: one more line, and still well short of the full text.
      expect(String((await connect("connect_deposit", { amount_usdc: "1", vault: "tlCashPlusUSDC2A" }))["acknowledgement"]).length).toBeLessThan(1_750);
      // Every full item still has its plain sentence: the points an operator must not lose.
      for (const point of [/not a bank deposit/, /no deposit insurance/, /can go down/, /third-party protocols/, /past performance, not a promise/, /may not come out right away/, /can charge fees/, /not because it pays the most/, /never signs or moves your money/, /where you live/]) {
        expect(text).toMatch(point);
      }
    });

    it("is generated, not composed: the same calls always produce the same text, under a fresh code", async () => {
      const a = await connect("connect_deposit", { amount_usdc: "1" });
      clock = new Date(clock.getTime() + 60_000);
      const b = await connect("connect_deposit", { amount_usdc: "1" });
      expect(b["acknowledgement"]).toBe(a["acknowledgement"]);
      expect(b["ack"]).not.toBe(a["ack"]);
    });

    it("a withdrawal says what it pays and to whom, with the points that hold for every action but not the pre-deposit ones", async () => {
      const text = String((await connect("connect_withdraw", { amount_usdc: "1" }))["acknowledgement"]);
      expect(text).toContain("Withdraw: 1 USDC");
      expect(text).toContain(`USDC goes to: ${ACCOUNT}`);
      for (const note of DISCLOSURES.plain.always) expect(text).toContain(note);
      for (const dep of DISCLOSURES.plain.deposit) expect(text).not.toContain(dep);
      expect(opened).toEqual([]);
    });

    it("an exit of every share is named in shares, as such", async () => {
      const text = String((await connect("connect_withdraw", { all: true, shares_exact: "0.5" }))["acknowledgement"]);
      expect(text).toContain(`Withdraw: 0.5 ${vault.symbol} shares (the amount given; it is the whole position only if it equals the account's share balance, which is not checked here)`);
      expect(text).not.toMatch(/every share the account holds/);
    });
  });

  it("a withdrawal given both an amount and --all, or --shares_exact without --all, is refused rather than half-read", async () => {
    await expect(connect("connect_withdraw", { all: true, shares_exact: "5", amount_usdc: "100" })).rejects.toThrow(/not both/);
    await expect(connect("connect_withdraw", { amount_usdc: "1", shares_exact: "3" })).rejects.toThrow(/--shares_exact goes with --all/);
    expect(existsSync(pendingAckPath())).toBe(false);
  });

  describe("with --ack, the page opens only for the calls the operator acknowledged, once", () => {
    it("the pending code opens the page, and is spent before it opens", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      const r = await connect("connect_deposit", { amount_usdc: "1", ack });
      expect(opened).toHaveLength(1);
      expect(r["status"]).toBe("not_reported");
      expect(existsSync(pendingAckPath())).toBe(false);
    });

    it("a spent code cannot open a second page", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      await connect("connect_deposit", { amount_usdc: "1", ack });
      await expect(connect("connect_deposit", { amount_usdc: "1", ack })).rejects.toThrow(/no acknowledgement is pending/);
      expect(opened).toHaveLength(1);
    });

    it("a code that is not the pending one is refused", async () => {
      await connect("connect_deposit", { amount_usdc: "1" });
      await expect(connect("connect_deposit", { amount_usdc: "1", ack: "00000000" })).rejects.toThrow(/not the pending acknowledgement's code/);
      expect(opened).toEqual([]);
    });

    it("with nothing pending, any code is refused", async () => {
      await expect(connect("connect_deposit", { amount_usdc: "1", ack: "0123abcd" })).rejects.toThrow(/no acknowledgement is pending/);
      expect(opened).toEqual([]);
    });

    it("a newer acknowledgement replaces the older one, whose code then opens nothing", async () => {
      const first = await connect("connect_deposit", { amount_usdc: "1" });
      clock = new Date(clock.getTime() + 1_000);
      await connect("connect_deposit", { amount_usdc: "1" });
      await expect(connect("connect_deposit", { amount_usdc: "1", ack: first["ack"] })).rejects.toThrow(/not the pending acknowledgement's code/);
      expect(opened).toEqual([]);
    });

    it("an acknowledgement whose expiry cannot be read counts as expired", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      const pending = JSON.parse(readFileSync(pendingAckPath(), "utf8")) as Record<string, unknown>;
      writeFileSync(pendingAckPath(), JSON.stringify({ ...pending, expiresAtIso: "not-a-date" }));
      await expect(connect("connect_deposit", { amount_usdc: "1", ack })).rejects.toThrow(/expired/);
      expect(opened).toEqual([]);
    });

    it("refused once expired", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      clock = new Date(clock.getTime() + ACK_TTL_MS + 1);
      await expect(connect("connect_deposit", { amount_usdc: "1", ack })).rejects.toThrow(/expired/);
      expect(opened).toEqual([]);
    });

    it("refused for a different amount than the one acknowledged", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      await expect(connect("connect_deposit", { amount_usdc: "2", ack })).rejects.toThrow(/not the ones the operator acknowledged/);
      expect(opened).toEqual([]);
    });

    it("refused for a different vault than the one acknowledged", async () => {
      const other = listVaults().find((v) => v.chainId === vault.chainId && v.address !== vault.address);
      expect(other, "a second vault on the default chain").toBeDefined();
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      await expect(connect("connect_deposit", { amount_usdc: "1", vault: other!.symbol, ack })).rejects.toThrow(/not the ones the operator acknowledged/);
      expect(opened).toEqual([]);
    });

    it("refused for the same withdrawal from a different vault on the same chain: a withdraw's calldata is the same on every vault, so only its destination tells them apart", async () => {
      const a = getVault("tlCashPlusUSDC2B");
      const b = getVault("tlCashPlusUSDC2A");
      expect(a.chainId, "premise: both vaults are on one chain").toBe(b.chainId);
      expect(a.address).not.toBe(b.address);
      const { ack } = await connect("connect_withdraw", { amount_usdc: "1", vault: a.symbol });
      await expect(connect("connect_withdraw", { amount_usdc: "1", vault: b.symbol, ack })).rejects.toThrow(/not the ones the operator acknowledged/);
      expect(opened).toEqual([]);
    });

    it("an acknowledged deposit does not open a withdrawal", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      await expect(connect("connect_withdraw", { amount_usdc: "1", ack })).rejects.toThrow(/not the ones the operator acknowledged/);
      expect(opened).toEqual([]);
    });

    it("the code is spent before the page opens: a page that fails to start leaves nothing to reuse", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      const port = Number(process.env["TREASURY_CONNECT_PORT"]);
      const squatter = createServer();
      const held = await new Promise<boolean>((resolve) => {
        squatter.once("error", () => resolve(false));
        squatter.listen({ port, host: "::1", ipv6Only: true }, () => resolve(true));
      });
      // A machine with IPv6 switched off has no `::1` for anyone to hold; there is nothing to test.
      if (!held) return;
      try {
        await expect(connect("connect_deposit", { amount_usdc: "1", ack })).rejects.toThrow(/in use/);
        expect(existsSync(pendingAckPath())).toBe(false);
        await expect(connect("connect_deposit", { amount_usdc: "1", ack })).rejects.toThrow(/no acknowledgement is pending/);
        expect(opened).toEqual([]);
      } finally {
        await new Promise((r) => squatter.close(r));
      }
    });

    it("connect disconnect voids the pending acknowledgement", async () => {
      await connect("connect_deposit", { amount_usdc: "1" });
      expect(existsSync(pendingAckPath())).toBe(true);
      await buildConnectCommands(deps())["connect_disconnect"]!.handler({} as never);
      expect(existsSync(pendingAckPath())).toBe(false);
    });

    it("a new wallet connection voids the acknowledgement given before it", async () => {
      const { ack } = await connect("connect_deposit", { amount_usdc: "1" });
      writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-10-04T12:01:00Z" });
      await expect(connect("connect_deposit", { amount_usdc: "1", ack })).rejects.toThrow(/no acknowledgement is pending/);
      expect(opened).toEqual([]);
    });

    it("the CLI refuses a malformed --ack before anything runs", async () => {
      const r = await run(["connect", "deposit", "--amount_usdc", "1", "--receiver", ACCOUNT, "--ack", "yes"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--ack/);
      expect(opened).toEqual([]);
    });
  });
});

describe("a receipt mined before the confirm flow started is not this flow's transaction", () => {
  const atBlock = (blockNumber: bigint, logs: ReturnType<typeof log>[]) => ({ getTransactionReceipt: async () => ({ status: "success", blockNumber, logs }) as never });

  it("verifyLanded: an older receipt of the same shape is a mismatch; one at or after the start block matches", async () => {
    const logs = [transferLog(ACCOUNT, vault.address, 600_000n), depositLog(ACCOUNT, 600_000n)];
    const old = await verifyLanded(atBlock(99n, logs), HASH, depositCall, ACCOUNT, { notBefore: 100n });
    expect(old.verified).toBe("mismatch");
    expect(old.detail).toMatch(/block 99, before this confirm flow started \(block 100\)/);
    expect((await verifyLanded(atBlock(100n, logs), HASH, depositCall, ACCOUNT, { notBefore: 100n })).verified).toBe("matched");
  });

  it("runConfirm reads the start block and stops on a hash from before it", async () => {
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "" });
    const calls = buildWithdraw(vault, { receiver: ACCOUNT, owner: ACCOUNT, assetsHuman: "1" });
    const client = () => ({
      getBlockNumber: async () => 100n,
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 99n, logs: [withdrawLog(ACCOUNT, ACCOUNT, 1_000_000n, 1_000_000n)] }) as never,
      readContract: async () => 0n as never,
    });
    let url = "";
    const run = runConfirm(calls, readSession()!, { open: (u) => ((url = u), true), client, verifyOpts: { attempts: 1, delayMs: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    await page(url).post("/result", { index: 0, hash: HASH });
    const out = JSON.parse(outcome(vault.chainId, ACCOUNT, await run)) as { status: string; txs: { verified: string; detail?: string }[] };
    expect(out.status).toBe("stopped");
    expect(out.txs[0]!.verified).toBe("mismatch");
    expect(out.txs[0]!.detail).toMatch(/before this confirm flow started/);
  });
});
