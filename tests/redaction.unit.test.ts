/**
 * Unit. The tool boundary must never emit an RPC endpoint (found in the first review): viem's
 * error messages carry `URL: https://…/v2/<key>`, a keyed provider URL is a secret, and the MCP SDK
 * forwards a thrown error's message verbatim. Two layers, each tested: `describeError` at every
 * String(e) site, and `guarded()` around every handler for anything that escapes unwrapped.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { describeError, redactEndpoints, redactSecrets } from "../src/redact.js";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { preflightDeposit } from "../src/preflight.js";
import { getPosition, UNKNOWN_AFTER_SCAN_FAILURE } from "../src/position.js";
import { getVault } from "../src/registry.js";
import { buildServer } from "../src/mcp/server.js";
import { EARN } from "../src/config/earn.js";
import { FIXTURE, fixtureVault, useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";

// The unit tiers exercise code paths (18-decimal shares, an open vault) that the shipped
// registry does not offer; `fixtures/registry.ts` explains why they are synthetic.
beforeAll(() => useFixtureRegistry());
afterAll(() => useShippedRegistry());

const FAKE = "FAKEKEY_abc123XYZ";
// A refused local port: viem wraps it as HttpRequestError whose message carries `URL: …` — the
// exact shape reproduced in review against Alchemy (a 1 ms abort does NOT: it yields UnknownRpcError, no URL).
const FAKE_URL = `http://127.0.0.1:9/v2/${FAKE}`;
const STRANGER = EARN.fixtures.stranger;

// A transport that fails the way a bad key does — the URL is in the error, the key is in the URL.
const failing = () =>
  createPublicClient({
    chain: base,
    transport: http(FAKE_URL, { retryCount: 0, timeout: 2_000 }),
  });

describe("describeError / redactEndpoints", () => {
  it("strips a viem-shaped message down to something with no endpoint in it", () => {
    const msg = `HTTP request failed.\n\nURL: https://base-mainnet.g.alchemy.com/v2/${FAKE}\nRequest body: {"method":"eth_call"}\n\nDetails: fetch failed\nVersion: viem@2.56.3`;
    const out = describeError(new Error(msg));
    expect(out).not.toContain(FAKE);
    expect(out).not.toContain("http");
    expect(out.length).toBeGreaterThan(0);
  });
  it("prefers viem's shortMessage when present and still redacts", () => {
    const e = Object.assign(new Error(`long\nURL: ${FAKE_URL}`), { shortMessage: `HTTP request failed. https://x.y/v2/${FAKE}` });
    expect(describeError(e)).not.toContain(FAKE);
  });
  it("redactEndpoints masks every URL, not just the first", () => {
    expect(redactEndpoints(`a https://a.b/v2/${FAKE} b http://c.d/${FAKE}`)).not.toContain(FAKE);
  });

  // The pattern used to be anchored to http(s). review found three shapes that would
  // have passed a key through if anything ever produced them. None is reachable via viem's HTTP
  // transport today — this closes a gap in the redactor, not a live leak.
  it("masks a ws:// or wss:// endpoint, not just http(s)", () => {
    expect(redactEndpoints(`socket died: wss://base-mainnet.g.alchemy.com/v2/${FAKE}`)).not.toContain(FAKE);
    expect(redactEndpoints(`ws://host/v2/${FAKE}`)).not.toContain(FAKE);
  });

  it("masks a BARE host in a DNS failure, which carries no scheme to match on", () => {
    const msg = `getaddrinfo ENOTFOUND base-mainnet.g.alchemy.com/v2/${FAKE}`;
    expect(redactEndpoints(msg)).not.toContain(FAKE);
    expect(redactEndpoints(`connect ECONNREFUSED my-node.example.com/${FAKE}`)).not.toContain(FAKE);
  });

  it("masks a key travelling as a header rather than in the URL", () => {
    expect(redactEndpoints(`headers: x-api-key: ${FAKE}`)).not.toContain(FAKE);
    expect(redactEndpoints(`authorization: Bearer ${FAKE}`)).not.toContain(FAKE);
  });

  // ⚠️ The errno rule used to consume `\S+` unconditionally, so it ate whatever followed —
  // fabricating a redaction in messages containing no endpoint at all (review).
  it("does not eat the token after an errno unless it is HOST-SHAPED", () => {
    expect(redactEndpoints("ETIMEDOUT after 30000ms while reading block 51220859")).toBe(
      "ETIMEDOUT after 30000ms while reading block 51220859",
    );
  });

  it("never masks loopback or a unix socket — not secrets, and the detail a developer needs", () => {
    // the single most common local failure is anvil not running; the port is the whole message
    expect(redactEndpoints("ECONNREFUSED 127.0.0.1:8545")).toBe("ECONNREFUSED 127.0.0.1:8545");
    expect(redactEndpoints("ECONNREFUSED /var/run/docker.sock")).toBe("ECONNREFUSED /var/run/docker.sock");
    expect(redactEndpoints("ECONNREFUSED localhost:8545")).toBe("ECONNREFUSED localhost:8545");
  });

  it("still masks a real keyed host after an errno", () => {
    expect(redactEndpoints(`getaddrinfo ENOTFOUND base-mainnet.g.alchemy.com/v2/${FAKE}`)).not.toContain(FAKE);
  });

  // Value-matching is the PRIMARY defence; these are shapes the pattern rules alone cannot reach
  // (review: no scheme, no errno, no header keyword). With the value known, shape is moot.
  it("masks a known secret VALUE in shapes no pattern matches", () => {
    const secrets = [FAKE];
    expect(redactSecrets(`{"error":"bad key","key":"${FAKE}"}`, secrets)).not.toContain(FAKE);
    expect(redactSecrets(`auth rejected token ${FAKE}`, secrets)).not.toContain(FAKE);
    expect(redactSecrets(`connect failed to base-mainnet.g.alchemy.com:443/v2/${FAKE}`, secrets)).not.toContain(FAKE);
  });

  it("ignores short values, so a path segment like v2 is never masked", () => {
    expect(redactSecrets("reading v2 of the registry", ["v2"])).toBe("reading v2 of the registry");
  });

  it("does not redact so hard that the error stops being diagnostic", () => {
    const out = redactEndpoints(`HTTP request failed.\nURL: https://x.y/v2/${FAKE}\nDetails: fetch failed`);
    expect(out).toContain("HTTP request failed");
    expect(out).toContain("fetch failed");
  });
});

describe("describeError carries the provider's own sentence, not only viem's generic headline", () => {
  it("a JSON-RPC error body's message (viem `details`) reaches the described string, masked", async () => {
    // Measured in review, 2026-09-17: every tool path through describeError() reported a provider at
    // its monthly cap as "RPC Request failed." — viem's shortMessage — and the sentence that names the
    // key ("Monthly capacity limit exceeded") lived only in `details`, which describeError never read.
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Monthly capacity limit exceeded. Visit https://example.invalid/upgrade?key=SECRETKEY1234" } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const err = await createPublicClient({ chain: base, transport: http(url, { retryCount: 0 }) }).getBlockNumber().then(() => undefined, (e: unknown) => e);
      const s = describeError(err);
      expect(s).toContain("Monthly capacity limit exceeded");
      expect(s).not.toContain("SECRETKEY1234");
      expect(s).not.toContain("example.invalid");
    } finally {
      srv.close();
    }
  });
});

describe("no tool output carries the RPC key when the RPC fails", () => {
  it("preflightDeposit → UNRESOLVED, findings free of the key", async () => {
    const r = await preflightDeposit({ vault: fixtureVault(FIXTURE.morphoOpen), depositor: STRANGER, client: failing() as never });
    expect(r.status).toBe("UNRESOLVED");
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });

  it("an unwrapped throw crossing a tool handler is redacted by guarded()", async () => {
    process.env["TREASURY_RPC_BASE"] = FAKE_URL;
    process.env["TREASURY_LOGS_RPC_BASE"] = FAKE_URL;
    try {
      const server = buildServer();
      // Reach the registered handler the way the SDK does, without a transport.
      const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
      expect(Object.keys(tools)).toContain("earn_balance");
      let thrown: unknown;
      try {
        await tools["earn_balance"]!.handler({ account: STRANGER, vault: FIXTURE.morphoOpen, max_log_requests: 1 }, {});
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(FAKE);
      expect((thrown as Error).message).not.toMatch(/https?:\/\//);
    } finally {
      delete process.env["TREASURY_RPC_BASE"];
      delete process.env["TREASURY_LOGS_RPC_BASE"];
    }
  });
});

describe("getPosition degrades when the provider's eth_getLogs error is not one it can size a window from", () => {
  it("returns a position with scan.capped=true and a FAILED note instead of throwing", async () => {
    const vault = fixtureVault(FIXTURE.morphoOpen);
    // Reads succeed; only getLogs fails, with wording rangeLimitFromError does not recognise.
    const client = {
      getBlockNumber: async () => 51_000_000n,
      // 5 shares worth 5.1 USDC (share price 1.02): a real position, so a wrong "yield" would be visible.
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "balanceOf") return 5n * 10n ** 18n;
        if (functionName === "convertToAssets") return args?.[0] === 10n ** 18n ? 1_020_000n : 5_100_000n;
        return 0n;
      },
      getLogs: async () => {
        throw new Error("query returned more than 10000 results");
      },
    };
    const p = await getPosition({ vault, principal: STRANGER, client: client as never, maxLogRequests: 3 });
    expect(p.scan.capped).toBe(true);
    expect(p.scan.complete).toBe(false);
    expect(p.scan.deposits).toBe(0);
    expect(p.scan.note).toMatch(/event scan FAILED/);
    expect(p.scan.note).toContain("more than 10000 results");
    expect(p.sharesExact).toBe("5");
    // The PROPERTY, not the mechanism: with nothing read, basis and yield must be
    // unknown — not "0 USDC" and "<whole value> USDC", which the note would then contradict.
    expect(p.entryBasisUsdc).toBe(UNKNOWN_AFTER_SCAN_FAILURE);
    expect(p.accruedYieldUsdc).toBe(UNKNOWN_AFTER_SCAN_FAILURE);
    expect(p.entryBasisUsdc).not.toMatch(/^\d/);
    expect(p.accruedYieldUsdc).not.toMatch(/USDC$/);
    expect(p.usdcValue).toBe("5.1 USDC"); // the on-chain value is still real and still reported
  });
});
