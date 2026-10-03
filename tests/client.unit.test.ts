import { afterEach, describe, expect, it } from "vitest";
import { CHAIN_INFO, chainIdForKey, logsFallbackUrlFromEnv, logsRpcUrlFromEnv, makePublicClient, makeRateLimitedFetch, PUBLIC_RPC, publicRpcHint, resolvedRpcSecrets, RPC_TIMEOUT_MS, endpointChainId, firstEndpointOnWrongChain, __forgetEndpointChainsForTests, logsRpcSourceForEnv, rpcSourceForEnv, rpcUrlFromEnv, supportedChainIds } from "../src/client.js";
import { createServer } from "node:http";

const KEYS = ["TREASURY_RPC_BASE", "TREASURY_LOGS_RPC_BASE", "BASE_RPC_URL", "TREASURY_RPC_ARBITRUM", "TREASURY_LOGS_RPC_ARBITRUM", "ARBITRUM_RPC_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function clearAll() {
  for (const k of KEYS) delete process.env[k];
}

const PUBLIC = "https://mainnet.base.org";

describe("rpcUrlFromEnv — a placeholder is not a URL", () => {
  it("nothing set → public default", () => {
    clearAll();
    expect(rpcUrlFromEnv(8453)).toBe(PUBLIC);
    expect(logsRpcUrlFromEnv(8453)).toBe(PUBLIC);
  });

  it("an unexpanded `${VAR}` placeholder (what an MCP host passes when the var is unset) → public default", () => {
    // Measured 2026-09-12: Claude Code forwards `${TREASURY_RPC_BASE}` verbatim when the host var is unset,
    // and every RPC-touching tool then died on "Failed to parse URL from ${TREASURY_RPC_BASE}".
    clearAll();
    process.env.TREASURY_RPC_BASE = "${TREASURY_RPC_BASE}";
    process.env.TREASURY_LOGS_RPC_BASE = "${TREASURY_LOGS_RPC_BASE}";
    expect(rpcUrlFromEnv(8453)).toBe(PUBLIC);
    expect(logsRpcUrlFromEnv(8453)).toBe(PUBLIC);
  });

  it("empty string and whitespace → public default", () => {
    clearAll();
    process.env.TREASURY_RPC_BASE = "";
    expect(rpcUrlFromEnv(8453)).toBe(PUBLIC);
    process.env.TREASURY_RPC_BASE = "   ";
    expect(rpcUrlFromEnv(8453)).toBe(PUBLIC);
  });

  it("a real http(s) URL is used; a non-URL is skipped in favour of the next candidate", () => {
    clearAll();
    process.env.TREASURY_RPC_BASE = "not a url";
    process.env.BASE_RPC_URL = "https://base-mainnet.g.alchemy.com/v2/KEY";
    expect(rpcUrlFromEnv(8453)).toBe("https://base-mainnet.g.alchemy.com/v2/KEY");
    process.env.TREASURY_RPC_BASE = "http://127.0.0.1:8545";
    expect(rpcUrlFromEnv(8453)).toBe("http://127.0.0.1:8545");
  });

  it("logs RPC: placeholder falls through to the general RPC, not to the public default", () => {
    clearAll();
    process.env.TREASURY_RPC_BASE = "https://example.invalid/v2/KEY";
    process.env.TREASURY_LOGS_RPC_BASE = "${TREASURY_LOGS_RPC_BASE}";
    expect(logsRpcUrlFromEnv(8453)).toBe("https://example.invalid/v2/KEY");
  });

  it("a non-http scheme (ws://) is not accepted by the http transport → skipped", () => {
    clearAll();
    process.env.TREASURY_RPC_BASE = "wss://base.example/ws";
    expect(rpcUrlFromEnv(8453)).toBe(PUBLIC);
  });
});

describe("makeRateLimitedFetch — waits out a 429, reports everything else at once", () => {
  const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });

  it("retries a 429 until the provider answers, with backoff", async () => {
    const answers = [res(429), res(429), res(200)];
    const slept: number[] = [];
    const f = makeRateLimitedFetch(async () => answers.shift()!, async (ms) => void slept.push(ms));
    expect((await f("https://x.invalid")).status).toBe(200);
    expect(slept).toEqual([500, 1000]);
  });

  it("honours Retry-After", async () => {
    const answers = [res(429, { "retry-after": "2" }), res(200)];
    const slept: number[] = [];
    const f = makeRateLimitedFetch(async () => answers.shift()!, async (ms) => void slept.push(ms));
    await f("https://x.invalid");
    expect(slept).toEqual([2000]);
  });

  it("gives up after 5 retries and returns the 429 for viem to report", async () => {
    let n = 0;
    const f = makeRateLimitedFetch(async () => (n++, res(429)), async () => {});
    expect((await f("https://x.invalid")).status).toBe(429);
    expect(n).toBe(6);
  });

  it("a 429 whose body says the limit is monthly or capacity is returned at once — it will not clear in 15 s", async () => {
    // Measured 2026-09-17: a keyed provider at its monthly cap answered 429 in 77 ms, and the wrapper
    // retried it five times anyway — 15.5 s of waiting for a limit that resets next month.
    let n = 0;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Monthly capacity limit exceeded" } });
    const f = makeRateLimitedFetch(async () => (n++, new Response(body, { status: 429 })), async () => {});
    const r = await f("https://x.invalid");
    expect(r.status).toBe(429);
    expect(n).toBe(1);
    // and the body is still readable by the caller — viem reports it
    expect(await r.text()).toContain("Monthly capacity limit exceeded");
  });

  it("a per-second THROTTLE 429 is still waited out — Alchemy's throttle body says 'capacity' too", async () => {
    // Measured in review, 2026-09-17: Alchemy's documented throttle body is "Your app has exceeded its
    // compute units per second capacity…" — a bare /capacity/ short-circuited the wrapper on the exact
    // case 2026-09-14 built it for. Only the measured exhausted-plan phrase short-circuits.
    const throttle = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message." } });
    const answers = [new Response(throttle, { status: 429 }), res(200)];
    const slept: number[] = [];
    const f = makeRateLimitedFetch(async () => answers.shift()!, async (ms) => void slept.push(ms));
    expect((await f("https://x.invalid")).status).toBe(200);
    expect(slept).toEqual([500]);
  });

  it("the sleep honours the transport's abort signal and hands back the last 429 — so viem reports a 429, never its timeout", async () => {
    // viem's withTimeout ABORTS on its deadline and only rejects with TimeoutError if the fetch throws an
    // abort error; a value returned after the abort is resolved as-is. A sleep that ignores the signal
    // therefore turns every persistent 429 into "The request took too long to respond".
    let n = 0;
    const ac = new AbortController();
    const f = makeRateLimitedFetch(async () => (n++, res(429, { "retry-after": "10" })), (ms) => new Promise((r) => setTimeout(r, ms)));
    const t0 = Date.now();
    const p = f("https://x.invalid", { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.status).toBe(429);
    expect(n).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("the total wait is bounded even when every 429 carries a Retry-After — it must fit inside the transport timeout", async () => {
    let n = 0;
    const slept: number[] = [];
    const f = makeRateLimitedFetch(async () => (n++, res(429, { "retry-after": "10" })), async (ms) => void slept.push(ms));
    expect((await f("https://x.invalid")).status).toBe(429);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15_500);
  });

  it("does not retry a 500 or a network failure — those are faults, not limits", async () => {
    let n = 0;
    const f = makeRateLimitedFetch(async () => (n++, res(500)), async () => {});
    expect((await f("https://x.invalid")).status).toBe(500);
    expect(n).toBe(1);
    const g = makeRateLimitedFetch(async () => { n++; throw new TypeError("fetch failed"); }, async () => {});
    await expect(g("https://x.invalid")).rejects.toThrow("fetch failed");
    expect(n).toBe(2);
  });
});

describe("makePublicClient — a provider at its quota is reported as a 429, not as a timeout", () => {
  it("an always-429 'capacity' provider surfaces the provider's message, fast", async () => {
    // Measured 2026-09-17 before this test: `TimeoutError: The request took too long to respond`
    // after 15.5 s and 5 fetches — the 429 body never reached the caller, and a whole live tier
    // read as "the RPC is slow" when the key was out of quota.
    const srv = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Monthly capacity limit exceeded. Visit https://example.invalid/upgrade" } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const t0 = Date.now();
    try {
      const err = await makePublicClient(8453, url).getBlockNumber().then(() => undefined, (e: unknown) => e as Error);
      expect(err).toBeDefined();
      expect(err!.name).not.toBe("TimeoutError");
      // viem parses a JSON-RPC error body and reports the provider's own sentence (it drops the HTTP
      // status when the body parses) — that sentence is what names the key rather than the vault.
      expect(String(err!.message)).toContain("Monthly capacity limit exceeded");
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      srv.close();
    }
  }, 20_000);

  it("a plain persistent 429 (no quota sentence) is waited out to the transport deadline and then reported as a 429 — never as a timeout", async () => {
    // The original shape: Retry-After 3 s × 5 would sleep 15 s, past viem's 10 s transport timeout;
    // before, the caller got `TimeoutError` and the 429 never surfaced. Now the deadline aborts the
    // sleep and the last 429 is what viem reports. Slow on purpose — the claim is about the deadline.
    let hits = 0;
    const srv = createServer((_req, res) => { hits++; res.writeHead(429, { "retry-after": "3", "content-type": "text/plain" }); res.end("Too Many Requests"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const t0 = Date.now();
    try {
      const err = await makePublicClient(8453, url).getBlockNumber().then(() => undefined, (e: unknown) => e as Error);
      const elapsed = Date.now() - t0;
      expect(err).toBeDefined();
      expect(err!.name).not.toBe("TimeoutError");
      expect(String(err!.message)).toMatch(/429/);
      expect(hits).toBeGreaterThanOrEqual(3);
      expect(elapsed).toBeGreaterThanOrEqual(RPC_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(RPC_TIMEOUT_MS + 1_500);
    } finally {
      srv.close();
    }
  }, 40_000);

  it("a host that accepts the connection and never answers still fails at the 10 s transport deadline — a fault, not a limit, and earn_status must not wait 25 s for it", async () => {
    // Measured in review, 2026-09-17: raising the transport timeout to 25.5 s made this case 2.5× slower
    // and falsified client.ts's own sentence about unreachable hosts. The deadline stays at viem's 10 s.
    const srv = createServer(() => { /* never answer */ });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const t0 = Date.now();
    try {
      const err = await makePublicClient(8453, url).getBlockNumber().then(() => undefined, (e: unknown) => e as Error);
      expect(err).toBeDefined();
      expect(Date.now() - t0).toBeLessThan(RPC_TIMEOUT_MS + 1_500);
      expect(RPC_TIMEOUT_MS).toBe(10_000);
    } finally {
      srv.closeAllConnections?.(); srv.close();
    }
  }, 30_000);
});

describe("resolvedRpcSecrets — every URL the package will actually call is a secret source", () => {
  it("registers the key in TREASURY_LOGS_FALLBACK — a real transport, not only a flag", () => {
    // Measured in review, 2026-09-17: the fallback URL builds a real client (earn/commands.ts) that
    // getPosition scans through, and a provider body echoing ITS key survived redaction because only the
    // three primary variables were registered. Dormant until describeError started reading `details`.
    clearAll();
    process.env.TREASURY_LOGS_FALLBACK = "https://base-mainnet.g.alchemy.com/v2/fbk9876secret";
    try {
      const s = resolvedRpcSecrets();
      expect(s).toContain("fbk9876secret");
    } finally {
      delete process.env.TREASURY_LOGS_FALLBACK;
    }
  });
});

describe("logsFallbackUrlFromEnv — the operator can refuse the third-party fallback", () => {
  const PRIMARY = "https://base-mainnet.g.alchemy.com/v2/KEY";
  it("unset → Base's public endpoint", () => {
    clearAll(); delete process.env.TREASURY_LOGS_FALLBACK;
    expect(logsFallbackUrlFromEnv(8453, PRIMARY)).toBe(PUBLIC);
  });
  it("anything that is not a usable URL turns the fallback off — it FAILS CLOSED", () => {
    // `disabled` used to leave the public fallback in place, and the test
    // here encoded that as intended. A privacy control that fails open is not one.
    clearAll();
    for (const v of ["off", "Off", "false", "0", " off ", "disabled", "no", "not a url", "ws://x.invalid"]) {
      process.env.TREASURY_LOGS_FALLBACK = v;
      expect(logsFallbackUrlFromEnv(8453, PRIMARY), v).toBeUndefined();
    }
    delete process.env.TREASURY_LOGS_FALLBACK;
  });
  it("a URL → that endpoint", () => {
    clearAll();
    process.env.TREASURY_LOGS_FALLBACK = "https://my-archive.invalid/rpc";
    expect(logsFallbackUrlFromEnv(8453, PRIMARY)).toBe("https://my-archive.invalid/rpc");
    delete process.env.TREASURY_LOGS_FALLBACK;
  });
  it("an unexpanded placeholder is not a refusal — it is an unset variable", () => {
    clearAll();
    process.env.TREASURY_LOGS_FALLBACK = "${TREASURY_LOGS_FALLBACK}";
    expect(logsFallbackUrlFromEnv(8453, PRIMARY)).toBe(PUBLIC);
    delete process.env.TREASURY_LOGS_FALLBACK;
  });
  it("a fallback equal to the primary is not a fallback", () => {
    clearAll(); delete process.env.TREASURY_LOGS_FALLBACK;
    expect(logsFallbackUrlFromEnv(8453, PUBLIC)).toBeUndefined();
  });
});

describe("the read client's retry budget is the wrapper's alone", () => {
  it("a persistently rate-limited read makes 6 HTTP requests, not 24", async () => {
    // viem's own retryCount sits OUTSIDE the transport's fetchFn and also retries 429, so leaving it at
    // its default multiplied this wrapper's 6 attempts by 4. Counted here against a real local server.
    let hits = 0;
    const server = createServer((_req, res) => { hits += 1; res.writeHead(429, { "retry-after": "1" }); res.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const client = makePublicClient(8453, `http://127.0.0.1:${port}`);
      await expect(client.getBlockNumber()).rejects.toThrow();
      // 1 + 5 retries, all of them this wrapper's. With viem's own retryCount left at its default of 3
      // this is ~24 (measured); the assertion discriminates the two by a factor of four.
      expect(hits).toBe(6);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("makePublicClient — CCIP-read is OFF, so a contract cannot send this client to a host nobody configured", () => {
  it("ccipRead is false on the client viem builds", () => {
    // viem's default is enabled (`client.ccipRead !== false` gates the OffchainLookup branch), so an
    // absent value would read as "on". Assert the literal, not merely that it is falsy.
    expect(makePublicClient(8453, "https://rpc.example/key").ccipRead).toBe(false);
  });
});

/**
 * A second chain means a second set of variables. The property that matters is ISOLATION: a chain
 * reads its own names and nothing else, because the same address read on the other chain answers
 * with empty data — "no position", "no contract" — and never with an error naming the mistake.
 */
describe("each chain resolves its RPC from its OWN variables", () => {
  const ARB_PUBLIC = "https://arb1.arbitrum.io/rpc";

  it("the chain table is complete: every supported chain has a key, a name, variables and a public endpoint", () => {
    expect(supportedChainIds).toEqual([8453, 42161]);
    expect(supportedChainIds.map((id) => CHAIN_INFO[id].key)).toEqual(["base", "arbitrum"]);
    for (const id of supportedChainIds) {
      const info = CHAIN_INFO[id];
      expect(chainIdForKey(info.key)).toBe(id);
      expect(info.rpcEnv.length).toBeGreaterThan(0);
      expect(PUBLIC_RPC[id]).toBe(info.publicRpc);
      expect(info.publicRpc).toMatch(/^https:\/\//);
    }
    expect(chainIdForKey("solana")).toBeUndefined();
    // no variable name is shared between two chains — a shared name would cross the two endpoints
    const names = supportedChainIds.flatMap((id) => [...CHAIN_INFO[id].rpcEnv, CHAIN_INFO[id].logsRpcEnv]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("nothing set → each chain's own public endpoint", () => {
    clearAll();
    expect(rpcUrlFromEnv(42161)).toBe(ARB_PUBLIC);
    expect(logsRpcUrlFromEnv(42161)).toBe(ARB_PUBLIC);
    expect(rpcSourceForEnv(42161)).toEqual({ source: "public default", configured: false });
  });

  it("🔴 Base's variables never reach an Arbitrum call, and Arbitrum's never reach a Base call", () => {
    clearAll();
    process.env.TREASURY_RPC_BASE = "https://base.example.invalid/v2/BASEKEY1234";
    process.env.BASE_RPC_URL = "https://base2.example.invalid/v2/BASEKEY5678";
    process.env.TREASURY_LOGS_RPC_BASE = "https://baselogs.example.invalid/v2/BASEKEY9012";
    expect(rpcUrlFromEnv(42161)).toBe(ARB_PUBLIC);
    expect(logsRpcUrlFromEnv(42161)).toBe(ARB_PUBLIC);
    expect(rpcSourceForEnv(42161).configured).toBe(false);
    clearAll();
    process.env.TREASURY_RPC_ARBITRUM = "https://arb.example.invalid/v2/ARBKEY1234";
    process.env.TREASURY_LOGS_RPC_ARBITRUM = "https://arblogs.example.invalid/v2/ARBKEY5678";
    expect(rpcUrlFromEnv(8453)).toBe(PUBLIC);
    expect(logsRpcUrlFromEnv(8453)).toBe(PUBLIC);
    expect(rpcSourceForEnv(8453).configured).toBe(false);
    // and each is used for its own chain
    expect(rpcUrlFromEnv(42161)).toBe("https://arb.example.invalid/v2/ARBKEY1234");
    expect(logsRpcUrlFromEnv(42161)).toBe("https://arblogs.example.invalid/v2/ARBKEY5678");
    expect(rpcSourceForEnv(42161)).toEqual({ source: "TREASURY_RPC_ARBITRUM", configured: true });
  });

  it("the conventional name is the second candidate, and a placeholder is not a URL — the same rules as Base", () => {
    clearAll();
    process.env.TREASURY_RPC_ARBITRUM = "${TREASURY_RPC_ARBITRUM}";
    expect(rpcUrlFromEnv(42161)).toBe(ARB_PUBLIC);
    process.env.ARBITRUM_RPC_URL = "https://arb-mainnet.example.invalid/v2/KEY12345";
    expect(rpcUrlFromEnv(42161)).toBe("https://arb-mainnet.example.invalid/v2/KEY12345");
    expect(rpcSourceForEnv(42161).source).toBe("ARBITRUM_RPC_URL");
    // the logs variable falls through to the general one for the SAME chain
    process.env.TREASURY_LOGS_RPC_ARBITRUM = "${TREASURY_LOGS_RPC_ARBITRUM}";
    expect(logsRpcUrlFromEnv(42161)).toBe("https://arb-mainnet.example.invalid/v2/KEY12345");
  });

  it("every Arbitrum endpoint is a secret source for the redactor, exactly as Base's are", () => {
    clearAll();
    process.env.TREASURY_RPC_ARBITRUM = "https://arb.example.invalid/v2/arbsecret11";
    process.env.TREASURY_LOGS_RPC_ARBITRUM = "https://arblogs.example.invalid/v2/arbsecret22";
    process.env.ARBITRUM_RPC_URL = "https://arb3.example.invalid/v2/arbsecret33";
    const s = resolvedRpcSecrets();
    for (const k of ["arbsecret11", "arbsecret22", "arbsecret33"]) expect(s, k).toContain(k);
  });

  it("the setup hint names the chain that failed, its variable and its public host", () => {
    clearAll();
    const arb = publicRpcHint(42161)!;
    expect(arb).toMatch(/Arbitrum One/);
    expect(arb).toMatch(/TREASURY_RPC_ARBITRUM/);
    expect(arb).toMatch(/arb1\.arbitrum\.io/);
    expect(arb).not.toMatch(/TREASURY_RPC_BASE|mainnet\.base\.org/);
    const base = publicRpcHint(8453)!;
    expect(base).toMatch(/TREASURY_RPC_BASE/);
    expect(base).toMatch(/mainnet\.base\.org/);
    expect(base).not.toMatch(/ARBITRUM|arbitrum/);
    // configuring ONE chain silences only that chain's hint
    process.env.TREASURY_RPC_BASE = "https://base.example.invalid/v2/BASEKEY1234";
    expect(publicRpcHint(8453)).toBeUndefined();
    expect(publicRpcHint(42161)).toBeDefined();
  });
});

describe("logsFallbackUrlFromEnv on a second chain — TREASURY_LOGS_FALLBACK names a Base endpoint", () => {
  const ARB_PRIMARY = "https://arb.example.invalid/v2/KEY";
  const ARB_PUBLIC = "https://arb1.arbitrum.io/rpc";
  it("unset → Arbitrum's own public endpoint, never Base's", () => {
    clearAll(); delete process.env.TREASURY_LOGS_FALLBACK;
    expect(logsFallbackUrlFromEnv(42161, ARB_PRIMARY)).toBe(ARB_PUBLIC);
    process.env.TREASURY_LOGS_FALLBACK = "${TREASURY_LOGS_FALLBACK}"; // an unexpanded placeholder is unset
    expect(logsFallbackUrlFromEnv(42161, ARB_PRIMARY)).toBe(ARB_PUBLIC);
    delete process.env.TREASURY_LOGS_FALLBACK;
    expect(logsFallbackUrlFromEnv(42161, ARB_PUBLIC)).toBeUndefined(); // equal to the primary: not a fallback
  });
  it("🔴 a URL there is NEVER used for Arbitrum: it is a Base endpoint, and Base's logs are not this chain's history", () => {
    clearAll();
    process.env.TREASURY_LOGS_FALLBACK = "https://my-base-archive.invalid/rpc";
    try {
      expect(logsFallbackUrlFromEnv(8453, "https://base.example.invalid")).toBe("https://my-base-archive.invalid/rpc"); // Base: used
      expect(logsFallbackUrlFromEnv(42161, ARB_PRIMARY)).toBeUndefined(); // Arbitrum: no fallback at all
    } finally {
      delete process.env.TREASURY_LOGS_FALLBACK;
    }
  });
  it("the opt-out applies on every chain", () => {
    clearAll();
    for (const v of ["off", "disabled", "not a url"]) {
      process.env.TREASURY_LOGS_FALLBACK = v;
      expect(logsFallbackUrlFromEnv(42161, ARB_PRIMARY), v).toBeUndefined();
    }
    delete process.env.TREASURY_LOGS_FALLBACK;
  });
});

describe("endpointChainId — which chain does the endpoint say it is", () => {
  /** `chainReply` answers eth_chainId: a hex id, "hang" to never answer, or "error" for a JSON-RPC error. */
  const serve = async (chainReply: string) => {
    let chainIdCalls = 0;
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const r = JSON.parse(b) as { id: number; method: string };
        if (r.method === "eth_chainId") {
          chainIdCalls++;
          if (chainReply === "hang") return; // never answers
          if (chainReply === "error") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "method not available" } }));
            return;
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? chainReply : "0x1" }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, calls: () => chainIdCalls, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
  };
  afterEach(() => __forgetEndpointChainsForTests());

  it("returns what the endpoint says — whatever chain the CLIENT was built for", async () => {
    const baseEndpoint = await serve("0x2105");
    try {
      // an Arbitrum client on a Base endpoint: the endpoint's answer, not the client's assumption
      expect(await endpointChainId(makePublicClient(42161, baseEndpoint.url), baseEndpoint.url)).toBe(8453);
    } finally {
      await baseEndpoint.close();
    }
  });

  it("an endpoint that answers with an error did not SAY — undefined, never a match and never a mismatch", async () => {
    const mute = await serve("error");
    try {
      expect(await endpointChainId(makePublicClient(42161, mute.url), mute.url)).toBeUndefined();
    } finally {
      await mute.close();
    }
  });

  it("🔴 is bounded: an endpoint that never answers eth_chainId costs the probe's own deadline, not the transport's 10 s", async () => {
    const slow = await serve("hang");
    try {
      const t0 = Date.now();
      expect(await endpointChainId(makePublicClient(42161, slow.url), slow.url, 300)).toBeUndefined();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2_000); // the transport deadline is RPC_TIMEOUT_MS
      expect(RPC_TIMEOUT_MS).toBeGreaterThan(2_000); // …which is what makes the line above a bound
    } finally {
      await slow.close();
    }
  });

  it("asks each endpoint ONCE per process — and does not remember a non-answer", async () => {
    const arb = await serve("0xa4b1");
    const mute = await serve("error");
    try {
      const c = makePublicClient(42161, arb.url);
      expect(await endpointChainId(c, arb.url)).toBe(42161);
      expect(await endpointChainId(c, arb.url)).toBe(42161);
      expect(arb.calls()).toBe(1);
      const m = makePublicClient(42161, mute.url);
      await endpointChainId(m, mute.url);
      await endpointChainId(m, mute.url);
      expect(mute.calls()).toBe(2); // a failure is asked again next time
    } finally {
      await arb.close();
      await mute.close();
    }
  });
});

describe("firstEndpointOnWrongChain — which configured endpoint is on another chain", () => {
  afterEach(() => __forgetEndpointChainsForTests());
  /** A stand-in client that says it is `id` (or throws), and counts how often it was asked. */
  const fake = (id: number | "throws") => {
    const c = { asked: 0, getChainId: async () => { c.asked++; if (id === "throws") throw new Error("no answer"); return id; } };
    return c;
  };
  it("names the first endpoint that answers for another chain, by its variable — and skips ones that match or do not say", async () => {
    const ok = fake(42161), mute = fake("throws"), wrong = fake(8453);
    const found = await firstEndpointOnWrongChain(42161, [
      { client: ok as never, url: "https://a.invalid/1", source: "TREASURY_RPC_ARBITRUM" },
      { client: mute as never, url: "https://a.invalid/2", source: "TREASURY_LOGS_RPC_ARBITRUM" },
      { client: wrong as never, url: "https://a.invalid/3", source: "TREASURY_LOGS_FALLBACK" },
    ]);
    expect(found).toEqual({ source: "TREASURY_LOGS_FALLBACK", answersFor: 8453 });
    expect(await firstEndpointOnWrongChain(42161, [{ client: ok as never, url: "https://a.invalid/1", source: "TREASURY_RPC_ARBITRUM" }])).toBeUndefined();
  });
  it("never asks a chain's own public endpoint — it is this client's constant, and the question is a third-party request with a known answer", async () => {
    const pub = fake(8453); // would be reported as wrong if it were asked
    expect(await firstEndpointOnWrongChain(42161, [{ client: pub as never, url: PUBLIC_RPC[42161], source: "public default" }])).toBeUndefined();
    expect(pub.asked).toBe(0);
    // the control: the same stand-in under any other URL IS asked, and is reported
    expect(await firstEndpointOnWrongChain(42161, [{ client: pub as never, url: "https://not-the-public-one.invalid", source: "X" }])).toEqual({ source: "X", answersFor: 8453 });
    expect(pub.asked).toBe(1);
  });
});

describe("logsRpcSourceForEnv — the NAME of the variable the event scan reads through", () => {
  it("the chain's logs variable when it resolves, otherwise whatever supplied the general RPC", () => {
    clearAll();
    expect(logsRpcSourceForEnv(42161)).toEqual({ source: "public default", configured: false });
    process.env.TREASURY_RPC_ARBITRUM = "https://arb.example.invalid/v2/ARBKEY1234";
    expect(logsRpcSourceForEnv(42161)).toEqual({ source: "TREASURY_RPC_ARBITRUM", configured: true });
    process.env.TREASURY_LOGS_RPC_ARBITRUM = "https://arblogs.example.invalid/v2/ARBKEY5678";
    expect(logsRpcSourceForEnv(42161)).toEqual({ source: "TREASURY_LOGS_RPC_ARBITRUM", configured: true });
    expect(logsRpcSourceForEnv(8453)).toEqual({ source: "public default", configured: false }); // Base is untouched by Arbitrum's
  });
});

describe("resolvedRpcSecrets — a chain's own name in the URL is not a secret", () => {
  // Providers put the chain in the URL. A path segment or first host label of 8+ characters is
  // registered as a secret, and "arbitrum" is exactly 8: with such a URL every refusal naming the
  // chain read `chains with a vault: base, <redacted>` (measured in review, three provider shapes).
  for (const url of ["https://rpc.provider.invalid/arbitrum/KEYabcdef123456", "https://arbitrum.gateway.provider.invalid/KEYabcdef123456", "https://ARBITRUM.provider.invalid/v1/KEYabcdef123456"]) {
    it(`${url.replace("KEYabcdef123456", "<key>")}: the key is registered, the chain name is not`, () => {
      clearAll();
      process.env.TREASURY_RPC_ARBITRUM = url;
      const s = resolvedRpcSecrets();
      expect(s).toContain("KEYabcdef123456"); // the control: the redactor still has the real secret
      expect(s.map((x) => x.toLowerCase())).not.toContain("arbitrum");
    });
  }
  it("a longer segment that merely CONTAINS the chain name is still registered", () => {
    clearAll();
    process.env.TREASURY_RPC_ARBITRUM = "https://rpc.provider.invalid/arbitrum-KEYabcdef123456";
    expect(resolvedRpcSecrets()).toContain("arbitrum-KEYabcdef123456");
  });
});
