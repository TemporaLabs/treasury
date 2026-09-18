/**
 * Unit — the MCP tool surface itself. A tool rename and the `account` normalisation
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
import { buildServer } from "../src/mcp/server.js";
import { EARN } from "../src/config/earn.js";
import { readFileSync } from "node:fs";
import { FIXTURE, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";
import { defaultVault } from "../src/registry.js";

// The unit tiers exercise code paths (18-decimal shares, an open vault) that the shipped
// registry does not offer; `fixtures/registry.ts` explains why they are synthetic.
beforeAll(() => useFixtureRegistry());
afterAll(() => useShippedRegistry());

type Handler = (a: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[] }>;
type Registered = Record<string, { handler: Handler; inputSchema?: { shape?: Record<string, unknown> } }>;

const tools = () => (buildServer() as unknown as { _registeredTools: Registered })._registeredTools;
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

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
    expect(props("earn_quote")).toEqual(["account", "amount_usdc", "direction", "vault"]);
    expect(props("earn_status")).toEqual(["account", "amount_usdc", "vault"]);
    expect(props("earn_balance")).toEqual(["account", "lookback_blocks", "max_log_requests", "vault"]);
    expect(props("earn_prepare_deposit")).toEqual(["account", "amount_usdc", "receiver", "vault"]);
    // `receiver` stays distinct from `account`: different slots, both addresses
    expect(props("earn_prepare_withdraw")).toEqual(["account", "all", "amount_usdc", "receiver", "shares_exact", "vault"]);
    expect(props("earn_vaults")).toEqual([]);
    expect(props("earn_terms")).toEqual([]);
    expect(props("earn_claim")).toEqual(["receipt_id"]);
    const all = Object.keys(t).flatMap(props);
    expect(all).not.toContain("depositor");
    expect(all).not.toContain("principal");
    expect(all).not.toContain("owner");
  });
});

describe("earn_vaults — Tempora vaults only, and the access of each is reported", () => {
  it("default is Cash Plus USDC 2 with defaultAccess open; it IS depositable; the gated sibling is listed but not depositable", async () => {
    const out = payload(await tools()["earn_vaults"]!.handler({}, {})) as {
      default: string;
      defaultAccess: string;
      depositable: string[];
      vaults: { backend: string }[];
    };
    expect(out.default).toBe("cash-plus-usdc-2");
    expect(out.defaultAccess).toBe("open");
    // This file runs on the fixture registry (shipped rows + synthetic ones), so assert membership,
    // not the exact set — registry.test.ts pins the exact shipped set.
    expect(out.depositable).toContain(out.default);
    expect(out.depositable).not.toContain("cash-plus-usdc-2a");
    expect(new Set(out.vaults.map((v) => v.backend))).toEqual(new Set(["tempora"]));
  });

  /**
   * The identity an agent DISPLAYS, and the links a human uses to check it. Both were absent: the
   * ticker was reconciled against the chain and then dropped before it reached a caller, so an
   * agent naming a vault to a depositor could only quote the internal slug. The warning matters
   * more than either — nothing in the tool surface said these are test vaults.
   */
  it("every row carries its on-chain ticker, a depositor warning, and an explorer link that resolves to its own address", async () => {
    const out = payload(await tools()["earn_vaults"]!.handler({}, {})) as {
      vaults: { slug: string; symbol: string; warning: string; address: string; chassis: string; links: { explorer: string; app?: string } }[];
    };
    expect(out.vaults.length).toBeGreaterThan(0);
    for (const v of out.vaults) {
      expect(v.symbol, `${v.slug} has no ticker`).toBeTruthy();
      expect(v.warning, `${v.slug} has no depositor warning`).toBeTruthy();
      // the link must name THIS vault — a constant that merely looks like a URL would pass a
      // truthiness check and send an operator to the wrong contract
      expect(v.links.explorer, `${v.slug} explorer link`).toContain(v.address);
      if (v.chassis === "morpho-v2") expect(v.links.app, `${v.slug} app link`).toContain(v.address);
    }
  });
});

/**
 * The warning has to reach the caller AT THE POINT OF USE, not only at discovery.
 *
 * It shipped in `earn_vaults` alone — while the warning's own text says "Show this warning before
 * preparing any deposit". So the tool that PREPARES a deposit did not carry the disclosure that
 * names preparing a deposit, and the instruction survived only if a model still happened to be
 * attending to an `earn_vaults` response from earlier in the conversation. A caller naming a vault
 * directly skips discovery entirely.
 */
describe("the test-vault warning reaches the deposit path, not just discovery", () => {
  it("earn_prepare_deposit carries the vault's warning in its envelope", async () => {
    const out = payload(
      await tools()["earn_prepare_deposit"]!.handler({ amount_usdc: "25", receiver: RECEIVER, account: RECEIVER }, {}),
    ) as { warning?: string };
    expect(out.warning, "earn_prepare_deposit must carry the warning").toBeTruthy();
    expect(out.warning).toBe(defaultVault().warning);
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
    const src = ["../src/version.ts", "../src/mcp/server.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
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

describe("earn_balance wires the fallback — the server line, not just the position layer", () => {
  // Two LOCAL mock RPCs that answer the position's reads and refuse eth_getLogs with different errors.
  // Mutating server.ts's `fallbackClient` to undefined leaves position-scan's tests green; this one fails.
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
