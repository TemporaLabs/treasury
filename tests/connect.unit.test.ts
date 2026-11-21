import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { getAddress } from "viem";
import { buildConnectCommands, outcome, runConnect, signInMessage, type ConnectDeps } from "../src/connect/commands.js";
import { claimPageLock, pageLockPath, pendingAckPath, readSession, replaceStale, writeSession } from "../src/connect/session.js";
import { serveOnce, type Flow } from "../src/connect/http.js";
import { DEFAULT_CONNECT_PORTS, connectPorts } from "../src/connect/config.js";
import { readOwnerToken, writeOwnerToken, type TokenKey } from "../src/connect/owner-tokens.js";
import { PAGE_CSP, shell } from "../src/connect/page.js";
import { runConfirmSolana } from "../src/connect/solana.js";
import { getBase58Decoder } from "@solana/kit";
import { associatedTokenAccount } from "../src/solana/kvault.js";
import { readVault } from "../src/solana/vault.js";
import { ACK_TTL_MS } from "../src/connect/ack.js";
import { run } from "../src/cli.js";
import { DISCLOSURES } from "../src/disclosures.js";
import { operatorWarning } from "../src/connect/ack.js";
import { linksFor } from "../src/links.js";
import { defaultVault, getVault, listSolanaVaults, listVaults } from "../src/registry.js";
import { tokenKeyFor } from "../src/invest/api.js";
import { keptTokenWallet, noHttp, standInApi } from "./fixtures/api.js";

/**
 * `treasury connect`, offline. No browser and no key: the tests play the page by speaking its HTTP
 * protocol to the real local server, and stub only what a browser, the Tempora API and a chain provide —
 * a signature check, the API's answers, and Solana's reads.
 */

const ACCOUNT = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const vault = defaultVault();

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
  it.each([
    ["another account", OTHER, false],
    ["the same account again", ACCOUNT, true],
  ])("connecting %s forgets the owner tokens kept for the account before it, or keeps them", async (_n, before, kept) => {
    writeSession({ account: before, walletType: "external", connectedAtIso: new Date().toISOString() });
    const key: TokenKey = { host: "api.staging.example", clientId: "treasury-cli", owner: before, audience: "http" };
    writeOwnerToken(key, { token: "tok-1", expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() });
    let url = "";
    const cmd = buildConnectCommands({ open: (u) => ((url = u), true), verifySignature: async () => true })["connect_wallet"]!;
    const run = cmd.handler({} as never);
    await new Promise((r) => setTimeout(r, 50));
    const p = page(url);
    await p.post("/challenge", { address: ACCOUNT });
    await p.post("/result", { address: ACCOUNT, signature: "0x1234", walletType: "external" });
    await run;
    expect(readSession()?.account).toBe(ACCOUNT);
    expect(readOwnerToken(key) === "tok-1").toBe(kept);
  });

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

/**
 * The page server every confirm flow runs on (`serveOnce`): one result at a time, a cancel that waits only so long for
 * a check in flight, a time limit that does not wait at all, and a page that is told when its flow has ended. Driven
 * with a stand-in `accept` whose check can be made to hang, the way a slow chain read or API call does.
 */
describe("the confirm page server: one result at a time, a bounded cancel, and the time limit", () => {
  const confirmFlow = (over: Partial<Flow<string>> & { accept: Flow<string>["accept"] }): Flow<string> => ({
    mode: "confirm",
    ttlMs: 5_000,
    html: () => "",
    csp: PAGE_CSP,
    assets: {},
    info: () => ({ mode: "confirm" }),
    ports: [Number(process.env["TREASURY_CONNECT_PORT"])],
    ...over,
  });
  const hangs = async (): Promise<never> => new Promise<never>(() => {});
  const H1 = `0x${"01".repeat(32)}`;

  it("a second result posted while the first is being checked is refused, so one call is never handed over twice", async () => {
    const h = await serveOnce(confirmFlow({ accept: async () => (await new Promise((r) => setTimeout(r, 300)), { ok: true, final: false, reply: { next: 1 } }) }));
    const p = page(h.url);
    const first = p.post("/result", { index: 0, hash: H1 });
    await new Promise((r) => setTimeout(r, 50));
    const second = await p.post("/result", { index: 0, hash: `0x${"02".repeat(32)}` });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { reason: string }).reason).toMatch(/already in progress/);
    expect((await first).status).toBe(200);
    h.close();
    await h.done;
  });

  it("the time limit ends the flow at once, even while a check hangs, and gives the flow's own reason", async () => {
    const started = Date.now();
    const h = await serveOnce(confirmFlow({ ttlMs: 400, accept: hangs, timeoutReason: () => "the limit ran out after 1 of 2 transactions were reported" }));
    void page(h.url).post("/result", { index: 0, hash: H1 }).catch(() => undefined);
    const r = await h.done;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(r).toEqual({ ok: false, reason: "the limit ran out after 1 of 2 transactions were reported" });
  });

  it("a cancel waits for a check in flight only up to its grace period", async () => {
    const h = await serveOnce(confirmFlow({ cancelGraceMs: 150, accept: hangs }));
    const p = page(h.url);
    void p.post("/result", { index: 0, hash: H1 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const cancelledAt = Date.now();
    await p.post("/result", { rejected: true, reason: "cancelled" });
    expect(await h.done).toEqual({ ok: false, reason: "cancelled" });
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
  });

  it("a cancel still waiting on a check is the reason given, even when the time limit then ends the flow", async () => {
    const h = await serveOnce(confirmFlow({ ttlMs: 300, accept: hangs, timeoutReason: () => "the limit ran out" }));
    const p = page(h.url);
    void p.post("/result", { index: 0, hash: H1 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await p.post("/result", { rejected: true, reason: "cancelled by the operator" });
    expect(await h.done).toEqual({ ok: false, reason: "cancelled by the operator" });
  });

  it("a rejection's body reaches the flow before it ends, so a hash the page could not hand over is put on record", async () => {
    const rejected: Record<string, unknown>[] = [];
    const h = await serveOnce(confirmFlow({ accept: hangs, onReject: (b) => rejected.push(b) }));
    await page(h.url).post("/result", { rejected: true, reason: "the result POST failed", index: 0, hash: H1 });
    expect(await h.done).toEqual({ ok: false, reason: "the result POST failed" });
    expect(rejected).toMatchObject([{ index: 0, hash: H1 }]);
  });

  it("/info says how long is left; once the flow has ended, a page left open is told so before it asks the wallet for anything", async () => {
    const h = await serveOnce(confirmFlow({ ttlMs: 9 * 60_000, accept: hangs }));
    const p = page(h.url);
    const left = (await p.info())["msLeft"] as number;
    expect(left).toBeGreaterThan(8 * 60_000);
    expect(left).toBeLessThanOrEqual(9 * 60_000);
    await p.post("/result", { rejected: true, reason: "declined" });
    await h.done;
    expect((await fetch(h.url.replace("/confirm?", "/info?"))).status).toBe(410);
  });

  it("refuses to start when another process already holds `::1` on its port, and releases 127.0.0.1", async () => {
    const port = Number(process.env["TREASURY_CONNECT_PORT"]);
    const squatter = createServer();
    const held = await new Promise<boolean>((resolve) => {
      squatter.once("error", () => resolve(false));
      squatter.listen({ port, host: "::1", ipv6Only: true }, () => resolve(true));
    });
    // A machine with IPv6 switched off has no `::1` for anyone to hold; there is nothing to test.
    if (!held) return;
    try {
      await expect(serveOnce(confirmFlow({ accept: hangs }))).rejects.toThrow(/in use on ::1/);
      const v4 = createServer();
      await new Promise<void>((resolve, reject) => {
        v4.once("error", reject);
        v4.listen(port, "127.0.0.1", () => v4.close(() => resolve()));
      });
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });
});

describe("a confirm flow's outcome", () => {
  it("with no transaction reported, the result does not claim that nothing was sent", () => {
    const out = JSON.parse(outcome(8453, ACCOUNT, { result: { ok: false, reason: "declined" }, opened: true, done: [], total: 2 })) as { status: string; next_step: string };
    expect(out.status).toBe("not_reported");
    expect(out.next_step).toMatch(/not proof that none was sent/);
  });

  it("a flow that ended before every call was reported says so, even with no step's own reason", () => {
    const tx = { step: 1, description: "approve", hash: `0x${"01".repeat(32)}`, verified: "matched" as const };
    const out = JSON.parse(outcome(8453, ACCOUNT, { result: { ok: true, value: [tx] }, opened: true, done: [tx], total: 2 })) as { status: string; reason?: string };
    expect(out.status).toBe("stopped");
    expect(out.reason).toBe("the flow ended after 1 of 2 transactions");
  });

  it("a cancelled flow with a transaction on record is stopped, never not_reported", () => {
    const tx = { step: 1, description: "approve", hash: `0x${"01".repeat(32)}`, verified: "unverified" as const, detail: "the flow ended while this transaction was still being checked" };
    const out = JSON.parse(outcome(8453, ACCOUNT, { result: { ok: false, reason: "cancelled" }, opened: true, done: [tx], total: 2 })) as { status: string; reason: string; txs: { hash: string }[] };
    expect(out.status).toBe("stopped");
    expect(out.reason).toBe("cancelled");
    expect(out.txs.map((t) => t.hash)).toEqual([tx.hash]);
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
});

/**
 * `connect deposit` / `connect withdraw` open the signing page only after the operator's
 * acknowledgement. The browser opener and the chain client are stubs, and a page that opens is left
 * to time out, so what is observed is only whether it opened.
 */
describe("the acknowledgement before any signing page opens", () => {
  let clock: Date;
  let opened: string[];
  // A vault on an EVM chain is the Tempora API's: a stand-in whose products mirror the registry's EVM rows.
  let api: ReturnType<typeof standInApi>;
  beforeEach(() => {
    clock = new Date("2026-10-04T12:00:00Z");
    opened = [];
    api = standInApi({ owner: ACCOUNT });
    writeSession({ account: ACCOUNT, walletType: "external", connectedAtIso: "2026-10-04T11:59:00Z" });
    writeOwnerToken(tokenKeyFor(ACCOUNT), { token: "tok", expiresAtIso: "2026-10-05T00:00:00Z" }, clock.getTime());
  });
  const deps = (): ConnectDeps => ({
    open: (u) => (opened.push(u), true),
    ttlMs: 150,
    now: () => clock,
    mcp: api.mcp,
    apiClient: noHttp,
    wallet: () => keptTokenWallet(),
    pollMs: 1,
    sleep: async () => undefined,
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

    it("the deposit advice is cut at its sentence end, not at a decimal point", () => {
      expect(operatorWarning("Test vault. Deposit only up to 0.5 USDC per account. Funds can be lost.", "withdraw")).toBe("Test vault. Funds can be lost.");
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
      // The terms line (the version and sha256 the deposit is made under) is on top of the same budget as before.
      const terms = text.split("\n").find((l) => l.trim().startsWith("Terms: version"))!;
      expect(terms, "a deposit names the terms it is made under").toBeDefined();
      expect(text.length).toBeLessThan(1_600 + terms.length);
      // A gated vault's deposit is the longest form: one more line, and still well short of the full text.
      expect(String((await connect("connect_deposit", { amount_usdc: "1", vault: "tlCashPlusUSDC2A" }))["acknowledgement"]).length).toBeLessThan(1_750 + terms.length);
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

describe("a Solana withdrawal by amount: the acknowledgement survives the vault's value moving", () => {
  // The vault earns between the operator reading the acknowledgement and the --ack run, so the shares worth
  // the same amount change. The acknowledgement must cover what the operator asked for (the amount), not a
  // share count recomputed on each run, or the second run refuses what the operator just said yes to.
  const SOL_ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const fx = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as {
    slot: number;
    vault: string;
    accounts: Record<string, { data: string }>;
  };
  let bump = 0n;
  const data = (a: string) => {
    const b = Buffer.from(fx.accounts[a]!.data, "base64");
    if (a === fx.vault && bump) b.writeBigUInt64LE(b.readBigUInt64LE(224) + bump, 224); // the vault's idle USDC
    return [b.toString("base64"), "base64"];
  };
  const rpc = {
    getAccountInfo: (a: string) => ({ send: async () => ({ value: { data: data(String(a)) }, context: { slot: BigInt(fx.slot) } }) }),
    getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: data(String(k)) })), context: { slot: BigInt(fx.slot) } }) }),
  };
  const withdraw = (args: Record<string, unknown>) =>
    buildConnectCommands({ solanaRpc: rpc as never, open: () => false, ttlMs: 50 })["connect_withdraw"]!.handler({ chain: "solana", receiver: SOL_ACCOUNT, ...args } as never);

  beforeEach(() => {
    bump = 0n;
    writeFileSync(join(home, "connect-session-solana.json"), JSON.stringify({ account: SOL_ACCOUNT, walletType: "external", connectedAtIso: new Date().toISOString() }));
  });

  it("the acknowledgement names the amount asked for, and the --ack run accepts it after the vault earned", async () => {
    const first = JSON.parse(await withdraw({ amount_usdc: "25" })) as { status: string; amount: string; ack: string };
    expect(first.status).toBe("needs_acknowledgement");
    expect(first.amount).toBe("25 USDC");
    bump = 1000n; // 0.001 USDC lands in the vault between the two runs
    expect(existsSync(pendingAckPath())).toBe(true);
    // Past the acknowledgement, the flow goes on to build the transaction, which this stub RPC cannot serve;
    // what matters here is that the acknowledgement was accepted and spent, not refused.
    const second = await withdraw({ amount_usdc: "25", ack: first.ack }).then(() => "", (e: Error) => e.message);
    expect(second).not.toMatch(/acknowledged/);
    expect(existsSync(pendingAckPath())).toBe(false);
  });

  it("refuses a receiver other than the connected Solana account, for a withdrawal and a deposit", async () => {
    const other = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    await expect(withdraw({ amount_usdc: "25", receiver: other })).rejects.toThrow(/is not the connected Solana account/);
    const deposit = buildConnectCommands({ solanaRpc: rpc as never, open: () => false, ttlMs: 50 })["connect_deposit"]!;
    await expect(deposit.handler({ chain: "solana", amount_usdc: "1", receiver: other } as never)).rejects.toThrow(/not the connected Solana account/);
  });

  it("still refuses an --ack run for a different amount", async () => {
    const first = JSON.parse(await withdraw({ amount_usdc: "25" })) as { ack: string };
    await expect(withdraw({ amount_usdc: "26", ack: first.ack })).rejects.toThrow(/acknowledged/);
  });

  // Solana shares and USDC both have 6 decimals, so 25 shares and 25 USDC are the same raw number: only the
  // action in the acknowledgement keeps a withdrawal of one from being confirmed as a withdrawal of the other.
  it("refuses an --ack run for 25 USDC with an acknowledgement given for 25 shares", async () => {
    const first = JSON.parse(await withdraw({ all: true, shares_exact: "25" })) as { ack: string };
    await expect(withdraw({ amount_usdc: "25", ack: first.ack })).rejects.toThrow(/acknowledged/);
  });

  it("refuses an --ack run for 25 shares with an acknowledgement given for 25 USDC", async () => {
    const first = JSON.parse(await withdraw({ amount_usdc: "25" })) as { ack: string };
    await expect(withdraw({ all: true, shares_exact: "25", ack: first.ack })).rejects.toThrow(/acknowledged/);
  });
});

describe("the Solana confirm flow binds the landed transaction to one it built", () => {
  const solVault = listSolanaVaults()[0]!;
  const SOL_ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const SOL_SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
  const snapshot = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as { slot: number; accounts: Record<string, { data: string }> };
  const tokenAccount = (amount: bigint) => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(amount, 64);
    return [b.toString("base64"), "base64"];
  };
  const bal = (mint: string, amount: string) => ({ owner: SOL_ACCOUNT, mint, uiTokenAmount: { amount } });

  /** The recorded vault, a deposit that simulates clean, and a landed transaction naming `landed()`'s blockhash. */
  const solRpc = (landed: () => string) =>
    ({
      getAccountInfo: (a: string) => ({ send: async () => ({ value: snapshot.accounts[String(a)] ? { data: [snapshot.accounts[String(a)]!.data, "base64"] } : { data: tokenAccount(0n) }, context: { slot: BigInt(snapshot.slot) } }) }),
      getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: [snapshot.accounts[String(k)]!.data, "base64"] })), context: { slot: BigInt(snapshot.slot) } }) }),
      getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn", lastValidBlockHeight: 1150n } }) }),
      getBlockHeight: () => ({ send: async () => 1000n }),
      getBalance: () => ({ send: async () => ({ value: 10_000_000n }) }),
      simulateTransaction: (_tx: string, cfg?: { accounts?: { addresses: string[] } }) => ({
        send: async () => ({ context: { slot: BigInt(snapshot.slot) }, value: { err: null, logs: [], unitsConsumed: 100_000n, accounts: (cfg?.accounts?.addresses ?? []).map(() => ({ data: tokenAccount(0n) })) } }),
      }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: "confirmed" }] }) }),
      getTransaction: () => ({
        send: async () => ({
          transaction: { message: { recentBlockhash: landed(), accountKeys: [SOL_ACCOUNT] } },
          meta: { err: null, preTokenBalances: [bal(solVault.asset.address, "5000000")], postTokenBalances: [bal(solVault.asset.address, "4000000"), bal(solVault.sharesMint, "999000")] },
        }),
      }),
    }) as never;

  async function deposit(landed: (built: string) => string) {
    let url = "";
    let builtHash = "";
    const run = runConfirmSolana({ kind: "deposit", vault: solVault, raw: 1_000_000n }, { account: SOL_ACCOUNT, walletType: "external", connectedAtIso: "" } as never, {
      open: (u) => ((url = u), true),
      ttlMs: 5_000,
      rpc: solRpc(() => landed(builtHash)),
      verifyOpts: { attempts: 1, delayMs: 1 },
      html: shell,
      csp: PAGE_CSP,
      assets: {},
      ports: [Number(process.env["TREASURY_CONNECT_PORT"])],
      appId: "test",
    });
    while (!url) await new Promise((r) => setTimeout(r, 10));
    const p = page(url);
    const reply = (await (await p.post("/result", { build: true })).json()) as { wire: string; blockhash: string };
    expect(reply.wire.length).toBeGreaterThan(0);
    builtHash = reply.blockhash;
    await p.post("/result", { hash: SOL_SIG });
    const r = await run;
    return r.result.ok ? r.result.value[0]! : r.done[0]!;
  }

  it("the transaction the page was handed lands as matched", async () => {
    expect((await deposit((built) => built)).verified).toBe("matched");
  });

  it("a signature for a transaction with any other blockhash is a mismatch", async () => {
    const v = await deposit(() => "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
    expect(v.verified).toBe("mismatch");
    expect(v.detail).toMatch(/not the transaction this page built/);
  });

  /**
   * The recorded vault, an account holding `HELD` shares, a withdrawal of `raw` shares whose simulation pays
   * `simPays`, and a landed transaction (naming the blockhash `built()` returns) that pays `landedPays`.
   */
  async function withdrawRpc(raw: bigint, simPays: bigint, landedPays: bigint, built: () => string) {
    const HELD = 50_000_000n;
    const sharesAta = String(await associatedTokenAccount(SOL_ACCOUNT, solVault.sharesMint));
    const tokenAta = String(await associatedTokenAccount(SOL_ACCOUNT, solVault.asset.address));
    const VAULT_SIDE = "D6hDbSjoZ7mJ4u2UtsD5X1h9WyTWsZbqdMahLkcmGpmn";
    const rec = (accountIndex: number, owner: string, mint: string, amount: bigint) => ({ accountIndex, owner, mint, uiTokenAmount: { amount: amount.toString() } });
    const base = solRpc(built) as unknown as Record<string, unknown>;
    return {
      ...base,
      getAccountInfo: (a: string) => ({
        send: async () => ({ value: snapshot.accounts[String(a)] ? { data: [snapshot.accounts[String(a)]!.data, "base64"] } : { data: tokenAccount(String(a) === sharesAta ? HELD : 0n) }, context: { slot: BigInt(snapshot.slot) } }),
      }),
      simulateTransaction: (_tx: string, cfg?: { accounts?: { addresses: string[] } }) => ({
        send: async () => ({
          context: { slot: BigInt(snapshot.slot) },
          value: { err: null, logs: [], unitsConsumed: 100_000n, accounts: (cfg?.accounts?.addresses ?? []).map((k) => ({ data: tokenAccount(k === tokenAta ? simPays : k === sharesAta ? HELD - raw : 0n) })) },
        }),
      }),
      getTransaction: () => ({
        send: async () => ({
          transaction: { message: { recentBlockhash: built(), accountKeys: [SOL_ACCOUNT] } },
          meta: {
            err: null,
            preTokenBalances: [rec(2, SOL_ACCOUNT, solVault.sharesMint, HELD), rec(3, SOL_ACCOUNT, solVault.asset.address, 0n), rec(4, VAULT_SIDE, solVault.asset.address, 50_000_000n)],
            postTokenBalances: [rec(2, SOL_ACCOUNT, solVault.sharesMint, HELD - raw), rec(3, SOL_ACCOUNT, solVault.asset.address, landedPays), rec(4, VAULT_SIDE, solVault.asset.address, 50_000_000n - landedPays)],
          },
        }),
      }),
    };
  }

  /** A withdrawal of 1 share whose simulation pays `simPays`, landing with the account's asset up by `landedPays`. */
  async function withdraw(simPays: bigint, landedPays: bigint) {
    const raw = 1_000_000n;
    let builtHash = "";
    const rpc = await withdrawRpc(raw, simPays, landedPays, () => builtHash);
    let url = "";
    const run = runConfirmSolana({ kind: "withdraw", vault: solVault, raw }, { account: SOL_ACCOUNT, walletType: "external", connectedAtIso: "" } as never, {
      open: (u) => ((url = u), true),
      ttlMs: 5_000,
      rpc: rpc as never,
      verifyOpts: { attempts: 1, delayMs: 1 },
      html: shell,
      csp: PAGE_CSP,
      assets: {},
      ports: [Number(process.env["TREASURY_CONNECT_PORT"])],
      appId: "test",
    });
    // The gate runs before the page opens: a refusal there ends the run with no page.
    let refused: unknown;
    run.catch((e: unknown) => (refused = e));
    while (!url && !refused) await new Promise((r) => setTimeout(r, 10));
    if (refused) throw refused;
    const p = page(url);
    const reply = (await (await p.post("/result", { build: true })).json()) as { wire: string; blockhash: string; received?: unknown };
    expect(reply.wire.length).toBeGreaterThan(0);
    // What the simulation paid stays with the flow: the page is handed only the transaction.
    expect(reply.received).toBeUndefined();
    builtHash = reply.blockhash;
    await p.post("/result", { hash: SOL_SIG });
    const r = await run;
    return r.result.ok ? r.result.value[0]! : r.done[0]!;
  }

  it("a withdrawal paying what the simulation of the transaction it built paid lands as matched", async () => {
    const v = await withdraw(1_000_000n, 1_000_000n);
    expect(v.verified, v.detail).toBe("matched");
  });

  it("connect withdraw by amount: a landed withdrawal paying less than the amount acknowledged is a mismatch, even when the simulation paid the same", async () => {
    // The shares worth 25 USDC, rounded up, as the command computes them from the same recorded vault.
    const v = await readVault(solRpc(() => "") as never, solVault);
    const raw = (25_000_000n * v.state.sharesIssued + v.holdings.netAum - 1n) / v.holdings.netAum;
    let builtHash = "";
    const rpc = await withdrawRpc(raw, 24_900_000n, 24_900_000n, () => builtHash);
    let url = "";
    const cmd = buildConnectCommands({ solanaRpc: rpc as never, open: (u) => ((url = u), true), ttlMs: 5_000, verifyOpts: { attempts: 1, delayMs: 1 } })["connect_withdraw"]!;
    writeFileSync(join(home, "connect-session-solana.json"), JSON.stringify({ account: SOL_ACCOUNT, walletType: "external", connectedAtIso: new Date().toISOString() }));
    const first = JSON.parse(await cmd.handler({ chain: "solana", receiver: SOL_ACCOUNT, amount_usdc: "25" } as never)) as { ack: string };
    const run = cmd.handler({ chain: "solana", receiver: SOL_ACCOUNT, amount_usdc: "25", ack: first.ack } as never);
    let refused: unknown;
    run.catch((e: unknown) => (refused = e));
    while (!url && !refused) await new Promise((r) => setTimeout(r, 10));
    if (refused) throw refused;
    const p = page(url);
    builtHash = ((await (await p.post("/result", { build: true })).json()) as { blockhash: string }).blockhash;
    await p.post("/result", { hash: SOL_SIG });
    const r = JSON.parse(await run) as { status: string; txs: { verified: string; detail: string }[] };
    expect(r.txs[0]!.verified).toBe("mismatch");
    expect(r.txs[0]!.detail).toMatch(/paid 24\.9 USDC, less than the 25 USDC acknowledged/);
  });

  it("a withdrawal paying less than the simulation of the transaction it built is a mismatch", async () => {
    const v = await withdraw(1_000_000n, 999_998n);
    expect(v.verified).toBe("mismatch");
    expect(v.detail).toMatch(/its simulation before sending paid/);
  });
});

describe("the page port: the first free one of a list, and one page at a time", () => {
  const flow = (ports: readonly number[]): Flow<never> => ({
    mode: "connect",
    ttlMs: 5_000,
    html: () => "",
    csp: PAGE_CSP,
    assets: {},
    info: () => ({}),
    accept: async () => ({ ok: false, reason: "not in this test" }),
    ports,
  });
  const hold = async (port: number) => {
    const s = createServer();
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => resolve());
    });
    return () => new Promise<void>((r) => s.close(() => r()));
  };
  const portOf = (url: string) => Number(new URL(url).port);

  it("defaults to 53682 first, then 53683 to 53686; TREASURY_CONNECT_PORT replaces the list with one port", () => {
    expect(connectPorts()).toEqual([Number(process.env["TREASURY_CONNECT_PORT"])]);
    delete process.env["TREASURY_CONNECT_PORT"];
    expect(connectPorts()).toEqual([53682, 53683, 53684, 53685, 53686]);
    expect(DEFAULT_CONNECT_PORTS).toEqual([53682, 53683, 53684, 53685, 53686]);
  });

  it("takes the next port when another program holds the first, and serves its origin from that port", async () => {
    const [a, b] = [await freePort(), await freePort()];
    const release = await hold(a);
    try {
      const h = await serveOnce(flow([a, b]));
      expect(portOf(h.url)).toBe(b);
      // Host and Origin are checked against the port actually bound, not the first in the list.
      const info = await fetch(h.url.replace("/connect?", "/info?"));
      expect(info.status).toBe(200);
      h.close();
      await h.done;
    } finally {
      await release();
    }
  });

  it("names every port when all are taken, and leaves no lock behind", async () => {
    const [a, b] = [await freePort(), await freePort()];
    const releases = [await hold(a), await hold(b)];
    try {
      await expect(serveOnce(flow([a, b]))).rejects.toThrow(new RegExp(`ports ${a}, ${b} are all in use by other programs`));
      expect(existsSync(pageLockPath())).toBe(false);
    } finally {
      for (const r of releases) await r();
    }
  });

  it("refuses a second page while one is open, even on a free port, and admits one once it closes", async () => {
    const [a, b] = [await freePort(), await freePort()];
    const first = await serveOnce(flow([a]));
    await expect(serveOnce(flow([b]))).rejects.toThrow(new RegExp(`another sign-in or confirmation page is still open on port ${a};`));
    first.close();
    await first.done;
    expect(existsSync(pageLockPath())).toBe(false);
    const next = await serveOnce(flow([b]));
    expect(portOf(next.url)).toBe(b);
    next.close();
    await next.done;
  });

  it("replaces a lock left by a process that has gone, or by a page that has expired", async () => {
    for (const stale of [{ pid: 2 ** 30, expiresAt: Date.now() + 60_000 }, { pid: process.pid, expiresAt: Date.now() - 1 }]) {
      // A fresh port each time: a closed page keeps its port for a short grace period.
      const port = await freePort();
      writeFileSync(pageLockPath(), JSON.stringify({ ...stale, token: "old" }));
      const h = await serveOnce(flow([port]));
      expect(portOf(h.url)).toBe(port);
      h.close();
      await h.done;
    }
  });

  it("does not replace a live lock: a running page in another process is reported, not raced", async () => {
    writeFileSync(pageLockPath(), JSON.stringify({ pid: process.ppid, expiresAt: Date.now() + 60_000, token: "theirs", port: 53682 }));
    await expect(serveOnce(flow([await freePort()]))).rejects.toThrow(/still open on port 53682;/);
    expect(JSON.parse(readFileSync(pageLockPath(), "utf8")).token).toBe("theirs");
  });

  it("a run that judged a lock stale does not remove the lock another run has just made from it (#154)", async () => {
    const stale = JSON.stringify({ pid: 2 ** 30, expiresAt: Date.now() + 60_000, token: "old" });
    writeFileSync(pageLockPath(), stale);
    // The first run takes the stale lock over; the second judged the same stale content before that.
    const first = await claimPageLock(60_000);
    const mine = readFileSync(pageLockPath(), "utf8");
    expect(replaceStale(pageLockPath(), stale)).toBe(false);
    expect(readFileSync(pageLockPath(), "utf8")).toBe(mine);
    await expect(claimPageLock(60_000)).rejects.toThrow(/another sign-in or confirmation page is still open/);
    first.release();
    expect(existsSync(pageLockPath())).toBe(false);
    // And the stale content itself is removed when it is what is there.
    writeFileSync(pageLockPath(), stale);
    expect(replaceStale(pageLockPath(), stale)).toBe(true);
    expect(existsSync(pageLockPath())).toBe(false);
  });

  it("replaces a beating lock whose process ID is alive but which nobody has touched (a reused PID, #154)", async () => {
    // This same process's PID: alive, but not the page's process any more.
    writeFileSync(pageLockPath(), JSON.stringify({ pid: process.pid, expiresAt: Date.now() + 60_000, token: "old", beat: true }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(pageLockPath(), old, old);
    const lock = await claimPageLock(60_000, { waitMs: 50 });
    expect(JSON.parse(readFileSync(pageLockPath(), "utf8")).token).not.toBe("old");
    lock.release();
  });

  it("keeps a suspect lock whose holder touches it during the wait (a laptop that slept)", async () => {
    writeFileSync(pageLockPath(), JSON.stringify({ pid: process.pid, expiresAt: Date.now() + 60_000, token: "theirs", beat: true, port: 53682 }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(pageLockPath(), old, old);
    const touch = setTimeout(() => utimesSync(pageLockPath(), new Date(), new Date()), 20);
    await expect(claimPageLock(60_000, { waitMs: 200 })).rejects.toThrow(/still open on port 53682;/);
    clearTimeout(touch);
    expect(JSON.parse(readFileSync(pageLockPath(), "utf8")).token).toBe("theirs");
  });

  it("judges a lock from a version that does not beat by its process ID alone, however old the file", async () => {
    writeFileSync(pageLockPath(), JSON.stringify({ pid: process.ppid, expiresAt: Date.now() + 60_000, token: "theirs" }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(pageLockPath(), old, old);
    await expect(claimPageLock(60_000, { waitMs: 10 })).rejects.toThrow(/another sign-in or confirmation page is still open/);
    expect(JSON.parse(readFileSync(pageLockPath(), "utf8")).token).toBe("theirs");
  });

  it("touches its own lock while held, and stops once released", async () => {
    const lock = await claimPageLock(60_000, { beatMs: 20 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(pageLockPath(), old, old);
    await new Promise((r) => setTimeout(r, 120));
    expect(Date.now() - statSync(pageLockPath()).mtimeMs).toBeLessThan(5_000);
    lock.release();
    expect(existsSync(pageLockPath())).toBe(false);
  });
});
