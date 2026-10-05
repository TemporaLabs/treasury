/**
 * Unit — the command surface itself. A tool rename and the `account` normalisation
 * touch only this boundary, and the boundary is exactly the layer no existing test covered: the
 * library tests call `buildWithdraw`/`getPosition` directly and never go through a handler.
 *
 * These assert the CONTRACT, not the mechanism: the exact tool set, the exact input properties
 * (so a leftover `depositor` is a failure rather than a tolerated extra key), the unsigned
 * envelope's shape, `direction` echoed on the output, and `earn_status`'s three modes.
 */
import { createServer } from "node:http";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { decodeFunctionData } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import { buildCommands } from "../src/earn/commands.js";
import { EARN } from "../src/config/earn.js";
import { readFileSync } from "node:fs";
import { FIXTURE, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";
import { defaultVault } from "../src/registry.js";
import { __forgetEndpointChainsForTests } from "../src/client.js";

// The unit tiers exercise code paths (18-decimal shares, an open vault) that the shipped
// registry does not offer; `fixtures/registry.ts` explains why they are synthetic.
beforeAll(() => useFixtureRegistry());
afterAll(() => useShippedRegistry());
// An endpoint's chain is remembered per URL for the life of a process. Every mock here is a fresh
// local port, and the OS reuses ports: forget between tests so one mock never answers for the next.
afterEach(() => __forgetEndpointChainsForTests());

type Handler = (a: unknown, extra: unknown) => Promise<string>;
type Registered = Record<string, { handler: Handler; inputSchema?: { shape?: Record<string, unknown> } }>;

const tools = () => (buildCommands() as unknown as Registered);
const payload = (r: string) => JSON.parse(r);

const ACCOUNT = EARN.fixtures.stranger;
const RECEIVER = "0x1111111111111111111111111111111111111111" as const;
const OWNER = "0x2222222222222222222222222222222222222222" as const;

const EIGHT = [
  "earn_balance",
  "earn_claim",
  "earn_prepare_deposit",
  "earn_prepare_withdraw",
  "earn_quote",
  "earn_status",
  "earn_terms",
  "earn_vaults",
];

describe("tool surface", () => {
  it("registers EXACTLY these eight names — no more, no fewer, none renamed", () => {
    expect(Object.keys(tools()).sort()).toEqual(EIGHT);
  });

  it("exposes no signing or sending tool", () => {
    for (const n of Object.keys(tools())) expect(n).not.toMatch(/sign|send|transfer/i);
  });

  it("every address argument is `account` — no depositor, owner or principal survives", () => {
    const t = tools();
    const props = (n: string) => Object.keys(t[n]!.inputSchema?.shape ?? {}).sort();
    // exact property sets, so a leftover old name fails instead of passing as an extra key
    // every tool that takes `vault` takes `chain` beside it — and the three that take no vault do not
    expect(props("earn_quote")).toEqual(["account", "amount_usdc", "chain", "direction", "vault"]);
    expect(props("earn_status")).toEqual(["account", "amount_usdc", "chain", "vault"]);
    expect(props("earn_balance")).toEqual(["account", "chain", "lookback_blocks", "max_log_requests", "vault"]);
    expect(props("earn_prepare_deposit")).toEqual(["account", "amount_usdc", "chain", "receiver", "vault"]);
    // `receiver` stays distinct from `account`: different slots, both addresses
    expect(props("earn_prepare_withdraw")).toEqual(["account", "all", "amount_usdc", "chain", "receiver", "shares_exact", "vault"]);
    for (const n of Object.keys(t)) expect(props(n).includes("chain"), `${n}: chain and vault travel together`).toBe(props(n).includes("vault"));
    expect(props("earn_vaults")).toEqual([]);
    expect(props("earn_terms")).toEqual([]);
    expect(props("earn_claim")).toEqual(["receipt_id"]);
    const all = Object.keys(t).flatMap(props);
    expect(all).not.toContain("depositor");
    expect(all).not.toContain("principal");
    expect(all).not.toContain("owner");
  });
});

describe("earn_vaults — Tempora Labs vaults only, and the access of each is reported", () => {
  it("default is Cash Plus USDC 2 with defaultAccess open; it IS depositable; the gated sibling is listed but not depositable", async () => {
    const out = payload(await tools()["earn_vaults"]!.handler({}, {})) as {
      default: string;
      defaultAccess: string;
      depositable: string[];
      vaults: { backend: string }[];
    };
    expect(out.default).toBe("tlCashPlusUSDC2B");
    expect(out.defaultAccess).toBe("open");
    // This file runs on the fixture registry (shipped rows + synthetic ones), so assert membership,
    // not the exact set — registry.test.ts pins the exact shipped set.
    expect(out.depositable).toContain(out.default);
    expect(out.depositable).not.toContain("tlCashPlusUSDC2A");
    expect(new Set(out.vaults.map((v) => v.backend))).toEqual(new Set(["tempora"]));
  });

  /**
   * The identity an agent DISPLAYS, and the links a human uses to check it. Both were absent: the
   * ticker was reconciled against the chain and then dropped before it reached a caller, so an
   * agent naming a vault to a depositor could only quote the internal registry identifier. The warning matters
   * more than either — nothing in the tool surface said these are test vaults.
   */
  it("every row carries its on-chain ticker, a depositor warning, and an explorer link that resolves to its own address", async () => {
    const out = payload(await tools()["earn_vaults"]!.handler({}, {})) as {
      vaults: { symbol: string; warning: string; address: string; chassis: string; links: { explorer: string; app?: string } }[];
    };
    expect(out.vaults.length).toBeGreaterThan(0);
    for (const v of out.vaults) {
      expect(v.symbol, `${v.symbol} has no ticker`).toBeTruthy();
      expect(v.warning, `${v.symbol} has no depositor warning`).toBeTruthy();
      // the link must name THIS vault — a constant that merely looks like a URL would pass a
      // truthiness check and send an operator to the wrong contract
      expect(v.links.explorer, `${v.symbol} explorer link`).toContain(v.address);
      // an app link is offered only where the protocol's page exists (registry.test.ts pins which);
      // where one is offered it must name THIS vault, for the same reason as the explorer link
      if (v.links.app !== undefined) expect(v.links.app, `${v.symbol} app link`).toContain(v.address);
    }
    // not vacuous: at least one row carries an app link, so the branch above ran
    expect(out.vaults.some((v) => v.links.app !== undefined)).toBe(true);
  });

  it("lists the chains a deposit can go to — the default chain first, each with its own default vault — and every row says which chain it is on", async () => {
    const out = payload(await tools()["earn_vaults"]!.handler({}, {})) as {
      defaultChain: string;
      default: string;
      chains: { chain: string; chainId: number; name: string; default: string; defaultAccess: string; depositable: string[] }[];
      vaults: { symbol: string; chain: string; chainId: number }[];
    };
    expect(out.defaultChain).toBe("base");
    expect(out.chains.map((c) => [c.chain, c.chainId, c.name, c.default, c.defaultAccess])).toEqual([
      ["base", 8453, "Base", "tlCashPlusUSDC2B", "open"],
      ["arbitrum", 42161, "Arbitrum One", "tlCashPlusUSDC2C", "open"],
      ["robinhood", 4663, "Robinhood Chain", "tlCashPlusUSDG2D", "open"],
    ]);
    // the global default is the default CHAIN's default — the two fields cannot disagree
    expect(out.default).toBe(out.chains[0]!.default);
    // a chain's depositable set holds only vaults on that chain, and its default is in it
    for (const c of out.chains) {
      expect(c.depositable).toContain(c.default);
      for (const s of c.depositable) expect(out.vaults.find((v) => v.symbol === s)!.chain).toBe(c.chain);
    }
    const chainOf = Object.fromEntries(out.vaults.map((v) => [v.symbol, `${v.chain}/${v.chainId}`]));
    expect(chainOf["tlCashPlusUSDC2"]).toBe("base/8453");
    expect(chainOf["tlCashPlusUSDC2A"]).toBe("base/8453");
    expect(chainOf["tlCashPlusUSDC2C"]).toBe("arbitrum/42161");
  });
});

/**
 * `chain` decides which CONTRACTS a prepared call names. These decode the calldata's destinations
 * rather than read a label: a response that said "arbitrum" above calls built for Base would pass
 * any assertion on the label and send an operator's signer to the wrong chain's addresses.
 */
describe("`chain` selects the vault, and the calls are built for that chain's contracts", () => {
  const BASE_VAULT = "0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F"; // Test 2B, the Base default
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const ARB_VAULT = "0x4057a63953142Ac2b3E5dB1954Fc14d578662587";
  const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  type Envelope = { chain: string; chainId: number; warning?: string; next_step: string; signer_rules: string[]; calls: { chainId: number; to: string; data: `0x${string}` }[] };
  const deposit = async (extra: Record<string, unknown>) =>
    payload(await tools()["earn_prepare_deposit"]!.handler({ amount_usdc: "25", receiver: RECEIVER, account: RECEIVER, ...extra }, {})) as Envelope;

  it("neither chain nor vault → Base's default (Test 2B), and the demo vault only when named", async () => {
    const out = await deposit({});
    expect([out.chain, out.chainId]).toEqual(["base", 8453]);
    expect(out.calls.map((c) => [c.chainId, c.to])).toEqual([
      [8453, BASE_USDC], // approve, on the asset
      [8453, BASE_VAULT], // deposit, on the vault
    ]);
    // the demo vault, by name: the same chain and asset, a different vault
    const demo = await deposit({ vault: "tlCashPlusUSDC2" });
    expect([demo.chain, demo.calls.map((c) => c.to)]).toEqual(["base", [BASE_USDC, "0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf"]]);
  });

  it("chain: arbitrum → the Arbitrum default, its own USDC, chainId 42161 on every call", async () => {
    const out = await deposit({ chain: "arbitrum" });
    expect([out.chain, out.chainId]).toEqual(["arbitrum", 42161]);
    expect(out.calls.map((c) => [c.chainId, c.to])).toEqual([
      [42161, ARB_USDC],
      [42161, ARB_VAULT],
    ]);
    // the approve's spender is the Arbitrum vault — not Base's vault approved on Arbitrum's token
    const approve = decodeFunctionData({ abi: erc4626Abi, data: out.calls[0]!.data });
    expect(approve.functionName).toBe("approve");
    expect(approve.args![0]).toBe(ARB_VAULT);
    expect(out.next_step).toMatch(/Arbitrum One \(chainId 42161\)/);
  });

  it("vault alone names the chain; chain: base is the same as omitting it", async () => {
    expect((await deposit({ vault: "tlCashPlusUSDC2C" })).calls.map((c) => c.to)).toEqual([ARB_USDC, ARB_VAULT]);
    expect((await deposit({ chain: "base" })).calls.map((c) => c.to)).toEqual([BASE_USDC, BASE_VAULT]);
  });

  it("a vault on one chain and a `chain` naming another is REFUSED — in both directions, on every vault-taking tool", async () => {
    const t = tools();
    const args = { amount_usdc: "1", receiver: RECEIVER, account: RECEIVER, direction: "deposit" };
    for (const name of ["earn_prepare_deposit", "earn_prepare_withdraw", "earn_quote", "earn_status", "earn_balance"]) {
      await expect(t[name]!.handler({ ...args, vault: "tlCashPlusUSDC2", chain: "arbitrum" }, {}), name).rejects.toThrow(/is on base, not arbitrum/);
      await expect(t[name]!.handler({ ...args, vault: "tlCashPlusUSDC2C", chain: "base" }, {}), name).rejects.toThrow(/is on arbitrum, not base/);
      await expect(t[name]!.handler({ ...args, chain: "solana" }, {}), name).rejects.toThrow(/unknown chain "solana"; chains with a vault: base, arbitrum/);
    }
  });

  it("a withdrawal is built on the chain the vault is on, and still carries no deposit warning", async () => {
    const out = payload(
      await tools()["earn_prepare_withdraw"]!.handler({ vault: "tlCashPlusUSDC2C", amount_usdc: "1", receiver: RECEIVER, account: OWNER }, {}),
    ) as Envelope;
    expect([out.chain, out.chainId]).toEqual(["arbitrum", 42161]);
    expect(out.calls.map((c) => [c.chainId, c.to])).toEqual([[42161, ARB_VAULT]]);
    expect(out.warning).toBeUndefined();
  });

  it("the signer is told to send on the call's chain, first, on both envelopes", async () => {
    const dep = await deposit({ chain: "arbitrum" });
    const wd = payload(await tools()["earn_prepare_withdraw"]!.handler({ amount_usdc: "1", receiver: RECEIVER, account: OWNER }, {})) as Envelope;
    for (const out of [dep, wd]) {
      expect(out.signer_rules[0]).toMatch(/on the chain its `chainId` names, and on no other/);
      // the envelope's chain is stated BEFORE the calls and before next_step, where a reader stops
      const keys = Object.keys(out);
      expect(keys.indexOf("chain")).toBeLessThan(keys.indexOf("next_step"));
      expect(keys.indexOf("chainId")).toBeLessThan(keys.indexOf("calls"));
      // and it agrees with every call it wraps
      for (const c of out.calls) expect(c.chainId).toBe(out.chainId);
    }
  });

  it("the tool descriptions tell the agent to ask which chain, where it decides to prepare a deposit", () => {
    const d = (n: string) => (tools()[n] as unknown as { description: string }).description;
    expect(d("earn_vaults")).toMatch(/`chains`.*ASK before preparing a deposit/s);
    expect(d("earn_prepare_deposit")).toMatch(/if they have not chosen one, ask before calling this/);
    const chainProp = (tools()["earn_prepare_deposit"]!.inputSchema!.shape!["chain"] as { description?: string }).description ?? "";
    expect(chainProp).toMatch(/"base" or "arbitrum"/);
    expect(chainProp).toMatch(/ASK them before preparing a deposit/);
  });
});

/**
 * The warning has to reach the caller AT THE POINT OF USE, not only at discovery — and it has to
 * KEEP reaching it.
 *
 * It shipped on `earn_vaults` alone, a discovery call, while its own text says to show it before
 * preparing a deposit. The repair put it on three money-committing responses; two of those three
 * were then unguarded, and deleting the field from them left the whole suite green. A test per call
 * site would only guard the sites someone remembered to write one for — the same defect one level
 * up — so the attachment is a single helper in the source and the first test below pins it there.
 */
describe("the test-vault warning travels with money-committing responses, and only those", () => {
  const zero = "0x" + "0".repeat(64);
  /** Answers enough chain reads for a quote to be produced; values are irrelevant, presence is not. */
  const startRpc = async () => {
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const r = JSON.parse(b) as { id: number; method: string };
        const result = r.method === "eth_blockNumber" ? "0x30f0000" : r.method === "eth_chainId" ? "0x2105" : zero;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/v2/K`, close: () => new Promise<void>((r) => srv.close(() => r())) };
  };
  afterEach(() => {
    delete process.env["TREASURY_RPC_BASE"];
  });

  /**
   * The structural one. `commitsMoney` is the only thing that may write a `warning` field onto a
   * response, `earn_vaults`'s per-row listing aside — so a fourth money-committing tool either goes
   * through the chokepoint and is disclosed for free, or hand-rolls the field and fails here.
   */
  it("only the chokepoint and the vault listing write a warning field", () => {
    const src = readFileSync(new URL("../src/earn/commands.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const writers = src.split("\n").filter((l) => /\bwarning:/.test(l)).map((l) => l.trim());
    expect(writers).toEqual([
      "const commitsMoney = (vault: VaultEntry) => ({ warning: vault.warning });",
      "warning: v.warning,",
    ]);
  });

  it("earn_prepare_deposit carries it, before next_step", async () => {
    const out = payload(
      await tools()["earn_prepare_deposit"]!.handler({ amount_usdc: "25", receiver: RECEIVER, account: RECEIVER }, {}),
    ) as { warning?: string };
    expect(out.warning, "earn_prepare_deposit must carry the warning").toBe(defaultVault().warning);
    expect(Object.keys(out).indexOf("warning")).toBeLessThan(Object.keys(out).indexOf("next_step"));
  });

  it("earn_status's pre-flight verdict carries it", async () => {
    process.env["TREASURY_RPC_BASE"] = "http://127.0.0.1:9/v2/K"; // refused: the verdict path, not a pass
    const out = payload(await tools()["earn_status"]!.handler({ account: RECEIVER }, {})) as { mode?: string; warning?: string };
    expect(out.mode).toBe("preflight");
    expect(out.warning, "earn_status preflight must carry the warning").toBe(defaultVault().warning);
  });

  it("earn_quote carries it on the deposit side and NOT on the withdraw side", async () => {
    const rpc = await startRpc();
    process.env["TREASURY_RPC_BASE"] = rpc.url;
    try {
      const dep = payload(await tools()["earn_quote"]!.handler({ account: RECEIVER, amount_usdc: "1", direction: "deposit" }, {})) as { warning?: string };
      expect(dep.warning, "earn_quote deposit must carry the warning").toBe(defaultVault().warning);
      const wd = payload(await tools()["earn_quote"]!.handler({ account: RECEIVER, amount_usdc: "1", direction: "withdraw" }, {})) as { warning?: string };
      expect(wd.warning, "a withdrawal quote must NOT carry it — money leaving is not the risk it describes").toBeUndefined();
    } finally {
      await rpc.close();
    }
  });

  it("earn_prepare_withdraw does NOT carry it", async () => {
    const out = payload(
      await tools()["earn_prepare_withdraw"]!.handler({ amount_usdc: "1", receiver: RECEIVER, account: RECEIVER }, {}),
    ) as { warning?: string };
    expect(out.warning, "repeating a disclosure where it does not apply is what trains a reader to skip it").toBeUndefined();
  });
});

describe("earn_prepare_* return an envelope, never a bare array", () => {
  it("deposit: requires_signature, status unsigned, and calls is where the array lives", async () => {
    const out = payload(await tools()["earn_prepare_deposit"]!.handler({ amount_usdc: "25", receiver: RECEIVER, account: RECEIVER }, {}));
    expect(Array.isArray(out)).toBe(false); // the shape, not just the flag
    expect(out.requires_signature).toBe(true);
    expect(out.status).toBe("unsigned");
    expect(Array.isArray(out.calls)).toBe(true);
    expect(out.calls.length).toBeGreaterThan(0);
  });

  it("withdraw: same envelope, and `account` maps to the OWNER slot while `receiver` stays the payee", async () => {
    const out = payload(
      await tools()["earn_prepare_withdraw"]!.handler({ receiver: RECEIVER, account: OWNER, amount_usdc: "50" }, {}),
    );
    expect(out.requires_signature).toBe(true);
    expect(out.status).toBe("unsigned");
    // the description names the payee; if account/receiver transposed, this is where it shows
    expect(out.calls[0].description).toContain(RECEIVER);
    expect(out.calls[0].description).not.toContain(OWNER);
  });

  it("both envelopes carry the signer rules measured on real sends: destination, pending nonce, receipts, nonce check before a re-send", async () => {
    const dep = payload(await tools()["earn_prepare_deposit"]!.handler({ amount_usdc: "1", receiver: RECEIVER, account: RECEIVER }, {}));
    const wd = payload(await tools()["earn_prepare_withdraw"]!.handler({ receiver: RECEIVER, account: RECEIVER, amount_usdc: "1" }, {}));
    for (const out of [dep, wd]) {
      const rules = (out.signer_rules as string[]).join("\n");
      expect(rules).toMatch(/destination/);
      expect(rules).toMatch(/eth_getTransactionCount\(account, "pending"\)/);
      expect(rules).toMatch(/receipt/);
      expect(rules).toMatch(/nonce on a DIFFERENT provider before re-sending/);
      expect(out.next_step).toContain("signer_rules");
    }
  });

  // 🔴 Measured in review: transposing account/receiver in ONLY the `all: true`
  // branch left all 61 tests passing. That is the EMPTY-THE-ACCOUNT path — a redeem of the exact
  // balance paid to the wrong address — and the guard covered only its sibling. These decode the
  // real calldata on BOTH branches rather than asserting on the description: the prose assertion
  // works only because build.ts happens to name the receiver, and it would not survive a later
  // "tidy the description" commit.
  it("amount branch: account lands in the OWNER slot, receiver in the RECEIVER slot", async () => {
    const out = payload(await tools()["earn_prepare_withdraw"]!.handler({ receiver: RECEIVER, account: OWNER, amount_usdc: "50" }, {}));
    const d = decodeFunctionData({ abi: erc4626Abi, data: out.calls[0].data });
    expect(d.functionName).toBe("withdraw");
    expect(d.args![1]).toBe(RECEIVER);
    expect(d.args![2]).toBe(OWNER);
  });

  it("all=true branch: the same, on the path that empties the account", async () => {
    const out = payload(
      await tools()["earn_prepare_withdraw"]!.handler({ receiver: RECEIVER, account: OWNER, all: true, shares_exact: "1.5" }, {}),
    );
    const d = decodeFunctionData({ abi: erc4626Abi, data: out.calls[0].data });
    expect(d.functionName).toBe("redeem");
    expect(d.args![1]).toBe(RECEIVER);
    expect(d.args![2]).toBe(OWNER);
  });

  it("all=true without shares_exact refuses rather than guessing a rounded balance", async () => {
    await expect(tools()["earn_prepare_withdraw"]!.handler({ receiver: RECEIVER, account: OWNER, all: true }, {})).rejects.toThrow(
      /shares_exact/,
    );
  });
});

describe("earn_status", () => {
  // No unit test may touch the real network: every case here points at a refused local port, so
  // the health path exercises its FAILURE branch and CI needs no RPC.
  const KEY = "FAKEKEY_abc123XYZ";
  beforeEach(() => {
    process.env["TREASURY_RPC_BASE"] = `http://127.0.0.1:9/v2/${KEY}`;
  });
  afterEach(() => {
    delete process.env["TREASURY_RPC_BASE"];
  });

  it("no arguments → mode health, and never the RPC URL itself", async () => {
    const out = payload(await tools()["earn_status"]!.handler({}, {}));
    expect(out.mode).toBe("health");
    expect(out.requested).toBeUndefined();
    expect(out).toHaveProperty("rpcSource");
    expect(JSON.stringify(out)).not.toMatch(/https?:\/\//);
  });

  it("health reports the version from package.json — the declared version follows the branch, and a literal cannot", async () => {
    const declared = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    const out = payload(await tools()["earn_status"]!.handler({}, {}));
    expect(out.version).toBe(declared);
    // The literal this replaces: server.ts once carried a hard-coded version that lagged package.json
    // by two releases. Proving the MECHANISM, not a value: the sources carry no semver literal at all —
    // a `not.toBe("0.1.0")` tripwire became unsatisfiable the day 0.1.0 was the declared version.
    const src = ["../src/version.ts", "../src/earn/commands.ts", "../src/cli.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    for (const s of src) expect(s).not.toMatch(/"\d+\.\d+\.\d+"/);
  });

  it("a vault but no account → health carrying the gap as STRUCTURE, not prose", async () => {
    const out = payload(await tools()["earn_status"]!.handler({ vault: FIXTURE.morphoOpen }, {}));
    expect(out.mode).toBe("health");
    expect(out.requested).toBe("preflight");
    expect(out.missing).toEqual(["account"]);
  });

  it("an unreachable keyed RPC RETURNS a verdict — it must not throw — and leaks neither host nor key", async () => {
    const out = payload(await tools()["earn_status"]!.handler({}, {}));
    expect(out.mode).toBe("health");
    expect(out.rpc).toBe("unreachable");
    expect(out.latestBlock).toBeNull();
    const s = JSON.stringify(out);
    expect(s).not.toContain(KEY);
    expect(s).not.toContain("127.0.0.1");
    expect(s).not.toMatch(/https?:\/\//);
    expect(out.rpcSource).toBe("TREASURY_RPC_BASE"); // the NAME is reported, the value never is
  });
});

/**
 * Each chain has its own RPC variable, so health is asked PER CHAIN — and the likeliest mistake with
 * two variables is one pointed at the other chain. Nothing then fails usefully by itself: a vault's
 * address has no code there, so reads come back empty. Health names it instead.
 */
describe("earn_status health is per chain, and names an endpoint that answers for the wrong one", () => {
  /** A mock endpoint that answers for whatever chain it is told to be. */
  const startChain = async (chainIdHex: string) => {
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const r = JSON.parse(b) as { id: number; method: string };
        if (r.method === "eth_chainId" && chainIdHex === "hang") return; // never answers this one method
        const result = r.method === "eth_blockNumber" ? "0x1e7a1f00" : r.method === "eth_chainId" ? chainIdHex : "0x" + "0".repeat(64);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}/v2/ARBKEY${port}`,
      close: () =>
        new Promise<void>((r) => {
          srv.closeAllConnections(); // a hung request must not keep the server (and the test) open
          srv.close(() => r());
        }),
    };
  };
  afterEach(() => {
    delete process.env["TREASURY_RPC_ARBITRUM"];
    delete process.env["TREASURY_RPC_BASE"];
  });
  const health = async (args: Record<string, unknown>) => payload(await tools()["earn_status"]!.handler(args, {}));

  it("chain: arbitrum reports Arbitrum's chain id and ITS variable — never Base's, with both set", async () => {
    process.env["TREASURY_RPC_BASE"] = "http://127.0.0.1:9/v2/BASEKEY_abc12345";
    process.env["TREASURY_RPC_ARBITRUM"] = "http://127.0.0.1:9/v2/ARBKEY_abc12345"; // refused: no network
    const arb = await health({ chain: "arbitrum" });
    expect([arb.mode, arb.chain, arb.chainId, arb.rpcSource, arb.rpc]).toEqual(["health", "arbitrum", 42161, "TREASURY_RPC_ARBITRUM", "unreachable"]);
    const base = await health({});
    expect([base.chain, base.chainId, base.rpcSource]).toEqual(["base", 8453, "TREASURY_RPC_BASE"]);
    // naming an Arbitrum vault selects the same chain as naming the chain
    expect((await health({ vault: "tlCashPlusUSDC2C" })).rpcSource).toBe("TREASURY_RPC_ARBITRUM");
    expect(JSON.stringify(arb)).not.toMatch(/ARBKEY|127\.0\.0\.1/);
  });

  it("an Arbitrum variable pointed at a BASE endpoint → rpc: wrong_chain, naming the variable and both chains", async () => {
    const baseEndpoint = await startChain("0x2105"); // answers for 8453
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = baseEndpoint.url;
      const out = await health({ chain: "arbitrum" });
      expect(out.rpc).toBe("wrong_chain");
      expect(out.rpcChainId).toBe(8453);
      expect(out.latestBlock).toBeNull(); // a block number from the wrong chain is not this chain's head
      expect(out.reason).toMatch(/TREASURY_RPC_ARBITRUM answers for chain 8453, not Arbitrum One \(42161\)/);
      expect(JSON.stringify(out)).not.toMatch(/ARBKEY|127\.0\.0\.1/);
    } finally {
      await baseEndpoint.close();
    }
  });

  it("the same variable pointed at an endpoint that IS Arbitrum → rpc: ok, chainVerified: true (the control for the test above)", async () => {
    const arbEndpoint = await startChain("0xa4b1"); // answers for 42161
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = arbEndpoint.url;
      const out = await health({ chain: "arbitrum" });
      expect(out.rpc).toBe("ok");
      expect(out.chainVerified).toBe(true);
      expect(out.rpcChainId).toBeUndefined();
      expect(out.latestBlock).toBe(String(0x1e7a1f00));
      expect(out.logsRpc, "no separate logs endpoint is configured, so none is reported").toBeUndefined();
    } finally {
      await arbEndpoint.close();
    }
  });

  it("🔴 an endpoint that answers a block but will not say its chain is `ok` with chainVerified: FALSE — and does not hold the answer up", async () => {
    // "ok" used to mean "the chain check passed". When eth_chainId errors, is rate-limited or hangs
    // while the block read answers, it means only "it answered" — and says so. The probe is bounded:
    // an endpoint that never answers eth_chainId must not make health wait out the transport's 10 s.
    const mute = await startChain("hang");
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = mute.url;
      const t0 = Date.now();
      const out = await health({ chain: "arbitrum" });
      expect(out.rpc).toBe("ok");
      expect(out.chainVerified).toBe(false);
      expect(out.latestBlock).toBe(String(0x1e7a1f00));
      expect(Date.now() - t0).toBeLessThan(7_000);
    } finally {
      await mute.close();
    }
  }, 15_000);

  it("an unconfigured chain is not asked, and claims nothing about verification", async () => {
    // Unconfigured means the chain's public endpoint, which is this client's own constant. Asserted
    // on the refused-port path of the OTHER variable so the unit tier never reaches the network:
    // the property is that `chainVerified` appears only for a configured endpoint.
    process.env["TREASURY_RPC_ARBITRUM"] = "http://127.0.0.1:9/v2/ARBKEY_abc12345";
    const out = await health({ chain: "arbitrum" });
    expect(out.rpc).toBe("unreachable");
    expect(out).not.toHaveProperty("chainVerified"); // nothing answered, so nothing is claimed either way
  });

  it("a SEPARATE logs endpoint is checked too, and reported beside the main verdict", async () => {
    // `earn_balance` reads through the logs variable. Health used to check only the general RPC, so
    // the tool documented as the misconfiguration check passed while every balance read failed.
    const arbEndpoint = await startChain("0xa4b1");
    const baseEndpoint = await startChain("0x2105");
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = arbEndpoint.url;
      process.env["TREASURY_LOGS_RPC_ARBITRUM"] = baseEndpoint.url; // the logs variable, on the wrong chain
      const bad = await health({ chain: "arbitrum" });
      expect([bad.rpc, bad.logsRpc, bad.logsRpcSource, bad.logsRpcChainId]).toEqual(["ok", "wrong_chain", "TREASURY_LOGS_RPC_ARBITRUM", 8453]);
      process.env["TREASURY_LOGS_RPC_ARBITRUM"] = arbEndpoint.url + "/logs"; // a second endpoint on the right chain
      const good = await health({ chain: "arbitrum" });
      expect([good.rpc, good.logsRpc, good.logsRpcSource]).toEqual(["ok", "ok", "TREASURY_LOGS_RPC_ARBITRUM"]);
      expect(good.logsRpcChainId).toBeUndefined();
      expect(JSON.stringify([bad, good])).not.toMatch(/ARBKEY|127\.0\.0\.1/);
    } finally {
      delete process.env["TREASURY_LOGS_RPC_ARBITRUM"];
      await arbEndpoint.close();
      await baseEndpoint.close();
    }
  });
});

/**
 * Through an endpoint for another chain, a vault's address has no contract, so every read fails
 * with "returned no data … the address is not a contract" — loud, and naming the wrong thing. Each
 * RPC-touching tool reports the endpoint instead, by the name of the variable that holds it.
 */
describe("every tool that reads the chain names an endpoint that answers for the wrong one", () => {
  const startChain = async (chainIdHex: string) => {
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const r = JSON.parse(b) as { id: number; method: string };
        // eth_call answers "0x": what a chain says about an address with no contract on it
        const result = r.method === "eth_blockNumber" ? "0x1e7a1f00" : r.method === "eth_chainId" ? chainIdHex : r.method === "eth_getLogs" ? [] : "0x";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/v2/ARBKEY${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
  };
  const VARS = ["TREASURY_RPC_ARBITRUM", "TREASURY_LOGS_RPC_ARBITRUM", "TREASURY_RPC_BASE", "TREASURY_LOGS_RPC_BASE", "TREASURY_LOGS_FALLBACK"];
  afterEach(() => {
    for (const k of VARS) delete process.env[k];
  });
  const WRONG = /the endpoint in TREASURY_RPC_ARBITRUM answers for chain 8453, not Arbitrum One \(42161\)/;

  it("pre-flight, quote (both directions) and balance on Arbitrum, through a Base endpoint → the variable is named, not the vault", async () => {
    const baseEndpoint = await startChain("0x2105");
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = baseEndpoint.url;
      const t = tools();
      const a = { chain: "arbitrum", account: RECEIVER, amount_usdc: "1" };
      await expect(t["earn_status"]!.handler(a, {})).rejects.toThrow(WRONG);
      await expect(t["earn_quote"]!.handler({ ...a, direction: "deposit" }, {})).rejects.toThrow(WRONG);
      await expect(t["earn_quote"]!.handler({ ...a, direction: "withdraw" }, {})).rejects.toThrow(WRONG);
      await expect(t["earn_balance"]!.handler(a, {})).rejects.toThrow(WRONG);
      // and the refusal carries neither the key nor the host
      const err = await t["earn_balance"]!.handler(a, {}).then(() => "", (e: Error) => e.message);
      expect(err).not.toMatch(/ARBKEY|127\.0\.0\.1/);
    } finally {
      await baseEndpoint.close();
    }
  });

  it("the control: the same calls through an endpoint that IS Arbitrum are NOT reported as a wrong chain", async () => {
    const arbEndpoint = await startChain("0xa4b1");
    try {
      process.env["TREASURY_RPC_ARBITRUM"] = arbEndpoint.url;
      // The mock answers "0x" to every read, so these still fail — as themselves. What must not
      // happen is the wrong-chain sentence, which would be a false accusation of the endpoint.
      const out = payload(await tools()["earn_status"]!.handler({ chain: "arbitrum", account: RECEIVER }, {})) as { status: string };
      expect(out.status).toBe("UNRESOLVED");
      const err = await tools()["earn_balance"]!.handler({ chain: "arbitrum", account: RECEIVER }, {}).then(() => "no error", (e: Error) => e.message);
      expect(err).not.toMatch(/answers for chain/);
      expect(err).toMatch(/returned no data/);
    } finally {
      await arbEndpoint.close();
    }
  });

  it("earn_balance checks the LOGS endpoint it actually reads through, and a fallback the operator named", async () => {
    const arbEndpoint = await startChain("0xa4b1");
    const baseEndpoint = await startChain("0x2105");
    try {
      // the general RPC is right; the logs variable is on the wrong chain
      process.env["TREASURY_RPC_ARBITRUM"] = arbEndpoint.url;
      process.env["TREASURY_LOGS_RPC_ARBITRUM"] = baseEndpoint.url;
      await expect(tools()["earn_balance"]!.handler({ chain: "arbitrum", account: RECEIVER }, {})).rejects.toThrow(
        /the endpoint in TREASURY_LOGS_RPC_ARBITRUM answers for chain 8453, not Arbitrum One/,
      );
      // On Base, a fallback URL that is an ARBITRUM endpoint: it would answer an event scan with an
      // empty list, and an empty scan reads as a history that was covered in full.
      for (const k of VARS) delete process.env[k];
      process.env["TREASURY_RPC_BASE"] = baseEndpoint.url;
      process.env["TREASURY_LOGS_FALLBACK"] = arbEndpoint.url;
      await expect(tools()["earn_balance"]!.handler({ vault: FIXTURE.morphoOpen, account: RECEIVER }, {})).rejects.toThrow(
        /the endpoint in TREASURY_LOGS_FALLBACK answers for chain 42161, not Base \(8453\)/,
      );
    } finally {
      await arbEndpoint.close();
      await baseEndpoint.close();
    }
  });

  it("a chain's own name in the RPC URL is not masked out of a refusal that names the chain", async () => {
    // Providers put the chain in the path or the host. The redactor registers long URL segments as
    // secrets; "arbitrum" is 8 characters, and the refusal read `is on base, not <redacted>`.
    process.env["TREASURY_RPC_ARBITRUM"] = "http://127.0.0.1:9/arbitrum/KEYabcdef123456";
    const t = tools(); // buildCommands registers the secrets
    const err = await t["earn_prepare_deposit"]!
      .handler({ vault: "tlCashPlusUSDC2", chain: "arbitrum", account: RECEIVER, receiver: RECEIVER, amount_usdc: "1" }, {})
      .then(() => "no error", (e: Error) => e.message);
    expect(err).toMatch(/is on base, not arbitrum/);
    expect(err).toMatch(/pick a vault on arbitrum \(tlCashPlusUSDC2C\)/);
    expect(err).not.toMatch(/<redacted>/);
    const unknown = await t["earn_prepare_deposit"]!
      .handler({ chain: "solana", account: RECEIVER, receiver: RECEIVER, amount_usdc: "1" }, {})
      .then(() => "no error", (e: Error) => e.message);
    expect(unknown).toMatch(/chains with a vault: base, arbitrum/);
  });
});

describe("earn_quote", () => {
  it("direction is required — a call without it is rejected, there is no default side", () => {
    const shape = tools()["earn_quote"]!.inputSchema?.shape ?? {};
    const direction = shape["direction"] as { safeParse: (v: unknown) => { success: boolean } };
    expect(direction.safeParse(undefined).success).toBe(false);
    expect(direction.safeParse("deposit").success).toBe(true);
    expect(direction.safeParse("withdraw").success).toBe(true);
    expect(direction.safeParse("sideways").success).toBe(false);
  });
});

export { ACCOUNT };

describe("earn_balance wires the fallback — the command line, not just the position layer", () => {
  // Two LOCAL mock RPCs that answer the position's reads and refuse eth_getLogs with different errors.
  // Mutating commands.ts's `fallbackClient` to undefined leaves position-scan's tests green; this one fails.
  const chainReply = (method: string): unknown =>
    method === "eth_blockNumber" ? "0x30f0000" : method === "eth_chainId" ? "0x2105" : "0x" + "0".repeat(64);
  const startRpc = async (logsError: string) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const rpc = JSON.parse(body) as { id: number; method: string };
        const out =
          rpc.method === "eth_getLogs"
            ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: logsError } }
            : { jsonrpc: "2.0", id: rpc.id, result: chainReply(rpc.method) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/v2/KEY${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  };

  afterEach(() => {
    delete process.env["TREASURY_LOGS_RPC_BASE"];
    delete process.env["TREASURY_RPC_BASE"];
    delete process.env["TREASURY_LOGS_FALLBACK"];
  });

  it("names both providers when the configured one and the fallback both fail", async () => {
    const primary = await startRpc("Archive requests require a personal token.");
    const second = await startRpc("some other refusal");
    try {
      process.env["TREASURY_RPC_BASE"] = primary.url;
      process.env["TREASURY_LOGS_RPC_BASE"] = primary.url;
      process.env["TREASURY_LOGS_FALLBACK"] = second.url;
      const out = payload(await tools()["earn_balance"]!.handler({ account: RECEIVER, vault: FIXTURE.morphoOpen }, {}));
      expect(out.scan.note).toMatch(/logs rpc: .*fallback: /s);
      expect(out.scan.source).toBe("logs rpc"); // nothing served it
      expect(out.scan.wholeHistory).toBe(false);
      expect(JSON.stringify(out)).not.toMatch(/127\.0\.0\.1|KEY\d/);
    } finally {
      await primary.close();
      await second.close();
    }
  }, 30_000);

  it("TREASURY_LOGS_FALLBACK=off means no second provider is tried at all", async () => {
    const primary = await startRpc("Archive requests require a personal token.");
    try {
      process.env["TREASURY_RPC_BASE"] = primary.url;
      process.env["TREASURY_LOGS_RPC_BASE"] = primary.url;
      process.env["TREASURY_LOGS_FALLBACK"] = "off";
      const out = payload(await tools()["earn_balance"]!.handler({ account: RECEIVER, vault: FIXTURE.morphoOpen }, {}));
      expect(out.scan.note).not.toMatch(/fallback endpoint/);
      expect(out.scan.note).toMatch(/event scan FAILED/);
    } finally {
      await primary.close();
    }
  }, 30_000);
});

/**
 * A new response field an agent is expected to SURFACE has to be named in the tool's own
 * description, not only in `docs/tools.md`.
 *
 * The discriminator, which is the part worth keeping: **does an agent learn this field exists
 * without reading a file it never reads?** `docs/tools.md` is the human integrator's document; the
 * description is what reaches the model before it decides what to tell an operator. A field that
 * exists, is populated, is documented for humans and is never mentioned to the agent is
 * indistinguishable from one that was never added — which is the same shape as the vault warning
 * shipping on a discovery call nobody was required to make.
 */
describe("a response field an agent must surface is named in its tool's own description", () => {
  it("earn_balance's description names the transaction lists and their truncation rule", () => {
    const d = (tools()["earn_balance"] as unknown as { description: string }).description;
    expect(d, "the description must exist at all").toBeTypeOf("string");
    expect(d).toContain("depositTxs");
    expect(d).toContain("withdrawTxs");
    // the caveat travels with the field, or a reader takes a capped list for a complete one
    expect(d).toMatch(/100|totals/);
  });

  // `exit.instantLiquidity` is the vault's own liquid balance — per `src/position.ts` the real
  // withdrawal ceiling, which `maxWithdraw()` does not reflect. It was populated by both of these
  // tools and named by neither (#17): an agent reading `usdcValue` and `maxWithdrawSays` alone can
  // tell an operator a position is fully withdrawable when it is not. The population is the set of
  // response types that declare the field — `ExitBlock` in `src/position.ts` (earn_balance) and
  // `WithdrawQuote` in `src/quote.ts` (earn_quote).
  for (const name of ["earn_quote", "earn_balance"]) {
    it(`${name}'s description names instantLiquidity, the withdrawal ceiling maxWithdraw does not know`, () => {
      const d = (tools()[name] as unknown as { description: string }).description;
      expect(d, "the description must exist at all").toBeTypeOf("string");
      expect(d).toContain("instantLiquidity");
      // and says what it is — a name alone tells an agent nothing about why to surface it
      expect(d).toMatch(/liquid balance/);
    });
  }
});
