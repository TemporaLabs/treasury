/**
 * `connect deposit`, `connect withdraw` and `connect plan --run` for a vault on an EVM chain, through the Tempora API: a
 * stand-in API (`fixtures/api.ts`), and the page played over its own HTTP protocol. Every step the page is handed must
 * have passed the client's `checkSteps`; every hash it posts goes to the API; nothing is sent twice.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildConnectCommands, type ConnectDeps } from "../src/connect/commands.js";
import { writeSession } from "../src/connect/session.js";
import { writeOwnerToken } from "../src/connect/owner-tokens.js";
import { tokenKeyFor } from "../src/invest/api.js";
import { defaultVault, listVaults } from "../src/registry.js";
import { keptTokenWallet, noHttp, productIdOf, standInApi, TERMS, type StandIn } from "./fixtures/api.js";

const ACCOUNT = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const vault = defaultVault();
const other = listVaults().find((v) => v.chainId !== vault.chainId && v.depositOpen.open)!;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

let home: string;
let clock: Date;
let opened: string[];
let api: StandIn;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "treasury-connect-api-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_CONNECT_PORT"] = String(await freePort());
  clock = new Date("2026-11-14T12:00:00Z");
  opened = [];
  api = standInApi({ owner: ACCOUNT });
  writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-11-14T11:59:00Z" });
  writeOwnerToken(tokenKeyFor(ACCOUNT), { token: "tok", expiresAtIso: "2026-11-15T00:00:00Z" }, clock.getTime());
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_PORT"];
});

const deps = (over: Partial<ConnectDeps> = {}): ConnectDeps => ({
  open: (u) => (opened.push(u), true),
  mcp: api.mcp,
  apiClient: noHttp,
  wallet: () => keptTokenWallet(),
  ttlMs: 3_000,
  // A plan's page starts a leg only with this much of its run left; these runs are short on purpose.
  legMinMs: 0,
  pollMs: 1,
  sleep: async () => undefined,
  now: () => clock,
  ...over,
});
const cmd = async (name: string, args: Record<string, unknown>, d: ConnectDeps = deps()) => {
  const c = buildConnectCommands(d)[name]!;
  return JSON.parse(await c.handler(c.inputSchema.parse(args) as never)) as Record<string, unknown>;
};

/** The page, as a test plays it. */
async function page(before = 0) {
  for (let i = 0; i < 300 && opened.length <= before; i++) await new Promise((r) => setTimeout(r, 10));
  const u = new URL(opened.at(-1)!);
  const s = u.searchParams.get("s")!;
  const info = async () => (await (await fetch(`${u.origin}/info?s=${s}`)).json()) as Record<string, any>;
  const post = async (body: Record<string, unknown>) =>
    (await (await fetch(`${u.origin}/result`, { method: "POST", headers: { "content-type": "application/json", origin: u.origin }, body: JSON.stringify({ s, ...body }) })).json()) as Record<string, any>;
  return { info, post };
}

/** Runs a single deposit or withdrawal: the acknowledgement, then the run with its code. */
async function acknowledged(name: "connect_deposit" | "connect_withdraw", args: Record<string, unknown>) {
  const first = await cmd(name, { receiver: ACCOUNT, vault: vault.symbol, ...args });
  expect(first["status"]).toBe("needs_acknowledgement");
  return cmd(name, { receiver: ACCOUNT, vault: vault.symbol, ...args, ack: first["ack"] });
}

describe("a deposit through the API: two steps, the second prepared only once the first is recorded", () => {
  it("the acknowledgement names the terms the deposit sends; nothing starts at the API before the operator's yes", async () => {
    const r = await cmd("connect_deposit", { receiver: ACCOUNT, vault: vault.symbol, amount_usdc: "1" });
    expect(r["terms"]).toEqual({ version: TERMS.version, sha256: TERMS.sha256 });
    expect(String(r["acknowledgement"])).toContain(`Terms: version ${TERMS.version}, sha256 ${TERMS.sha256}`);
    expect(api.log).toEqual(["products"]);
    expect(opened).toEqual([]);
  });

  it("puts step 1 on the page, hands its hash to the API, then step 2 once it is ready; completed, with the request named", async () => {
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    const first = await p.info();
    expect(first["requestId"]).toBe("req_1");
    expect(first["calls"].map((c: any) => [c.step, c.kind, c.state, c.to === "" ? "nothing to send" : c.to])).toEqual([
      [1, "approve", "ready", vault.asset.address],
      [2, "deposit", "waiting", "nothing to send"],
    ]);
    expect(first["calls"][0].function).toBe("approve(address spender, uint256 value)");
    expect((await p.post({ index: 0, hash: H(1) }))["next"]).toBe(1);
    const second = await p.info();
    expect(second["calls"][1]).toMatchObject({ state: "ready", to: vault.address, kind: "deposit" });
    expect(second["calls"][0].to).toBe(""); // a step sent once has nothing more to send
    expect((await p.post({ index: 1, hash: H(2) }))["finished"]).toBe(true);
    const out = await run;
    expect(out).toMatchObject({ status: "completed", requestId: "req_1", chain: "base", chainId: vault.chainId });
    expect((out["txs"] as any[]).map((t) => [t.step, t.hash, t.verified])).toEqual([
      [1, H(1), "matched"],
      [2, H(2), "matched"],
    ]);
    expect(api.log.filter((l) => l !== "products")).toEqual(["deposit", "submit:s1", "submit:s2"]);
    expect(api.submits.map((x) => x.body)).toEqual([
      { kind: "transaction", txHash: H(1), wallet: null },
      { kind: "transaction", txHash: H(2), wallet: null },
    ]);
  });

  it("the deposit sends the terms version and sha256 the operator acknowledged, and exactly the amount", async () => {
    const bodies: unknown[] = [];
    const mcp = new Proxy(api.mcp, { get: (t, n: string) => (n === "deposit" ? async (i: any) => (bodies.push(i.body), (t as any).deposit(i)) : (t as any)[n]) });
    const run = (async () => {
      const first = await cmd("connect_deposit", { receiver: ACCOUNT, vault: vault.symbol, amount_usdc: "2.5" }, deps({ mcp }));
      return cmd("connect_deposit", { receiver: ACCOUNT, vault: vault.symbol, amount_usdc: "2.5", ack: first["ack"] }, deps({ mcp }));
    })();
    const p = await page();
    await p.post({ rejected: true, reason: "cancelled by the operator on the confirm page" });
    await run;
    expect(bodies).toEqual([{ product: productIdOf(vault.symbol), amount: { kind: "assets", assetId: `eip155:${vault.chainId}/erc20:${vault.asset.address}`, raw: "2500000" }, vaultTerms: { version: TERMS.version, sha256: TERMS.sha256 } }]);
  });

  it("a request cancelled on the page before anything was sent is withdrawn at the API", async () => {
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    await p.post({ rejected: true, reason: "cancelled by the operator on the confirm page" });
    const out = await run;
    expect(out["status"]).toBe("not_reported");
    expect(api.log).toContain("cancel");
    expect(api.submits).toEqual([]);
  });
});

describe("a withdrawal through the API", () => {
  it("one checked step, sent and recorded: completed", async () => {
    const run = acknowledged("connect_withdraw", { amount_usdc: "1.5" });
    const p = await page();
    const i = await p.info();
    expect(i["calls"]).toHaveLength(1);
    expect(i["calls"][0]).toMatchObject({ kind: "withdraw", to: vault.address, function: "withdraw(uint256 assets, address receiver, address owner)" });
    expect((await p.post({ index: 0, hash: H(7) }))["finished"]).toBe(true);
    expect(await run).toMatchObject({ status: "completed", txs: [{ hash: H(7), verified: "matched" }] });
  });

  it("--all alone withdraws the whole position, as a redeem of every share the request names", async () => {
    const run = acknowledged("connect_withdraw", { all: true });
    const p = await page();
    expect((await p.info())["calls"][0].function).toBe("redeem(uint256 shares, address receiver, address owner)");
    await p.post({ index: 0, hash: H(8) });
    expect((await run)["status"]).toBe("completed");
  });
});

describe("the check holds before every step, and nothing is ever sent twice", () => {
  it("a request that fails the check when it starts opens no page, and is cancelled", async () => {
    api.bend = (r, event) => {
      if (event === "start") (r.steps[0] as any).payload.data = encodeFunctionData({ abi: erc4626Abi, functionName: "approve", args: [STRANGER, 1_000_000n] });
      return r;
    };
    await expect(acknowledged("connect_deposit", { amount_usdc: "1" })).rejects.toThrow(/refused \(step 1 of 2\): the approval names a spender other than the vault\. Nothing was sent, and request req_1 was cancelled/);
    expect(opened).toEqual([]);
    expect(api.log).toContain("cancel");
  });

  it("a deposit step that pays the shares to another account, once the approval is recorded: stopped, and nothing more is sent", async () => {
    api.bend = (r, event) => {
      const s2 = r.steps[1] as any;
      if (event !== "start" && s2.payload) s2.payload.data = encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [1_000_000n, STRANGER] });
      return r;
    };
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    const reply = await p.post({ index: 0, hash: H(1) });
    expect(reply["stop"]).toBe(true);
    expect(String(reply["reason"])).toMatch(/refused \(step 2 of 2\): the deposit's receiver is not the owner\. Nothing more was sent/);
    const out = await run;
    expect(out["status"]).toBe("stopped");
    expect((await p.info().catch(() => ({})))["calls"]).toBeUndefined(); // the page has ended
    expect(api.submits.map((x) => x.stepId)).toEqual(["s1"]);
  });

  it("a step the API re-issues after it was sent is refused, never sent twice", async () => {
    api.bend = (r, event) => {
      if (event === "submit") Object.assign(r.steps[0] as any, { state: "ready", payload: { ...(r.steps[0] as any).payload, generation: 2 } });
      return r;
    };
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    const reply = await p.post({ index: 0, hash: H(1) });
    expect(String(reply["reason"])).toMatch(/the API asks for step s1 again after it was sent \(transaction 0x0+1\); not sent twice/);
    expect((await run)["status"]).toBe("stopped");
  });

  it("a second hash posted for a step already sent is refused", async () => {
    api.landing[H(1)] = "pending";
    const run = acknowledged("connect_withdraw", { amount_usdc: "1" });
    const p = await page();
    const first = p.post({ index: 0, hash: H(1) });
    const again = await p.post({ index: 0, hash: H(2) });
    expect(again["ok"]).toBe(false);
    await first;
    await run;
    expect(api.submits.map((x) => x.body)).toEqual([{ kind: "transaction", txHash: H(1), wallet: null }]);
  });

  it("a hash the page could not hand over (sent_unrecorded) is still submitted by its hash, once, and reported", async () => {
    const run = acknowledged("connect_withdraw", { amount_usdc: "1" });
    const p = await page();
    await p.post({ rejected: true, reason: "sent, but the page could not finish checking it: offline", hash: H(9), index: 0 });
    const out = await run;
    expect(api.submits).toEqual([{ requestId: "req_1", stepId: "s1", body: { kind: "transaction", txHash: H(9), wallet: null } }]);
    expect(out["status"]).toBe("stopped");
    expect(out["txs"]).toMatchObject([{ hash: H(9), verified: "unverified" }]);
    expect(String(out["reason"])).toContain("request req_1: read it with `treasury earn request --request_id req_1`");
    expect(api.log).not.toContain("cancel"); // something was sent: the request stands
  });

  it("a submit the API refuses after a send stops the flow with the hash, and says not to send it again", async () => {
    api.refuseSubmit = { code: "transfer_mismatch", message: "that transaction is not this step" };
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    const reply = await p.post({ index: 0, hash: H(1) });
    expect(String(reply["reason"])).toMatch(/the transaction was sent from your wallet \(0x0+1\), but the API did not record it: transfer_mismatch: that transaction is not this step\. Do not send it again/);
    const out = await run;
    expect(out["status"]).toBe("stopped");
    expect(out["txs"]).toMatchObject([{ hash: H(1) }]);
  });

  it("a wallet error after the send was asked for reads 'not confirmed sent', and names the request", async () => {
    const run = acknowledged("connect_withdraw", { amount_usdc: "1" });
    const p = await page();
    await p.post({ rejected: true, reason: "not confirmed sent: the wallet returned an error without a transaction hash; it may or may not have been sent: boom" });
    const out = await run;
    expect(String(out["reason"])).toMatch(/^not confirmed sent: .*; request req_1: read it with `treasury earn request --request_id req_1` before trying again$/);
    expect(api.log).toContain("cancel"); // no hash reached the API, so the request is withdrawn
  });

  it("a step that lands reverted is reported as such, and the leg stops", async () => {
    api.landing[H(1)] = "reverted";
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    expect((await p.post({ index: 0, hash: H(1) }))["stop"]).toBe(true);
    expect(await run).toMatchObject({ status: "stopped", txs: [{ hash: H(1), verified: "reverted" }] });
  });
});

describe("connect plan: each EVM leg is one API request, driven in order on one page", () => {
  it("two EVM legs, each started at the API when the page starts it, each step checked and recorded: the plan completed", async () => {
    const legs = `deposit ${vault.symbol} 1; withdraw ${other.symbol} 2`;
    const first = await cmd("connect_plan", { legs });
    expect(String(first["acknowledgement"])).toContain(`Terms: version ${TERMS.version}`);
    await cmd("connect_plan", { legs, ack: first["ack"] });
    const run = cmd("connect_plan", { run: true });
    const p = await page();
    expect((await p.post({ start: 1 }))["started"]).toBe(1);
    let i = await p.info();
    expect(i["current"].calls.map((c: any) => c.state)).toEqual(["ready", "waiting"]);
    expect((await p.post({ index: 0, hash: H(1) }))["next"]).toBe(1);
    i = await p.info();
    expect(i["current"].calls[1].to).toBe(vault.address);
    expect((await p.post({ index: 1, hash: H(2) }))["legDone"]).toBe(true);
    expect((await p.post({ start: 2 }))["started"]).toBe(2);
    i = await p.info();
    expect(i["current"].calls[0]).toMatchObject({ kind: "withdraw", to: other.address });
    expect((await p.post({ index: 0, hash: H(3) }))["planDone"]).toBe(true);
    const out = await run;
    expect(out["status"]).toBe("completed");
    expect((out["legs"] as any[]).map((l) => [l.leg, l.status, l.txs.map((t: any) => t.hash)])).toEqual([
      [1, "completed", [H(1), H(2)]],
      [2, "completed", [H(3)]],
    ]);
    expect(api.log.filter((l) => l !== "products" && l !== "positions")).toEqual(["deposit", "submit:s1", "submit:s2", "withdraw", "submit:s1"]);
  });

  it("a plan leg run on its own page (`--plan --leg`) is the same API request", async () => {
    const legs = `withdraw ${other.symbol} 2`;
    const first = await cmd("connect_plan", { legs });
    const acked = await cmd("connect_plan", { legs, ack: first["ack"] });
    const command = String((acked["legs"] as any[])[0].command);
    expect(command).toBe(`connect withdraw --vault ${other.address} --amount_usdc 2 --receiver ${ACCOUNT} --plan ${first["ack"]} --leg 1`);
    const run = cmd("connect_withdraw", { vault: other.address, amount_usdc: "2", receiver: ACCOUNT, plan: first["ack"], leg: 1 });
    const p = await page();
    await p.post({ index: 0, hash: H(4) });
    expect(await run).toMatchObject({ status: "completed", requestId: "req_1", plan: { leg: 1, of: 1 } });
  });

  it("an EVM `withdraw … all` leg is the whole position when it runs: nothing is read before, and the command says --all alone", async () => {
    const legs = `withdraw ${other.symbol} all`;
    const first = await cmd("connect_plan", { legs });
    expect(String(first["acknowledgement"])).toContain(`your whole position in ${other.symbol}, as it stands when the withdrawal runs`);
    const acked = await cmd("connect_plan", { legs, ack: first["ack"] });
    expect(String((acked["legs"] as any[])[0].command)).toBe(`connect withdraw --vault ${other.address} --all --receiver ${ACCOUNT} --plan ${first["ack"]} --leg 1`);
  });
});

describe("what the page may send", () => {
  it("the page is never handed something to send for a step that is waiting, or for one already sent", async () => {
    api.landing[H(1)] = "pending";
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    const before = await p.info();
    expect(before["calls"][1]).toMatchObject({ to: "", data: "" });
    // Step 2 cannot be posted before it is ready, whatever a page claims.
    expect((await p.post({ index: 1, hash: H(5) }))["ok"]).toBe(false);
    await p.post({ index: 0, hash: H(1) });
    await run;
  });

  it("a hash posted for a step the API has not made ready is refused, and nothing reaches the API", async () => {
    // The API holds step 1 back (waiting, nothing to send): a page that posts a hash for it anyway is refused.
    api.bend = (r, event) => {
      if (event === "start") Object.assign(r.steps[0] as any, { state: "waiting", payload: undefined });
      return r;
    };
    const run = acknowledged("connect_deposit", { amount_usdc: "1" });
    const p = await page();
    expect((await p.info())["calls"][0]).toMatchObject({ state: "waiting", to: "" });
    expect(await p.post({ index: 0, hash: H(1) })).toMatchObject({ ok: false, reason: "step 1 is not ready to send" });
    await p.post({ rejected: true, reason: "cancelled by the operator on the confirm page" });
    await run;
    expect(api.submits).toEqual([]);
  });

  it("an account other than the connected one is never the receiver", async () => {
    await expect(cmd("connect_deposit", { receiver: STRANGER as Address, vault: vault.symbol, amount_usdc: "1" })).rejects.toThrow(/is not the connected account/);
    expect(api.log).toEqual([]);
  });
});
