/**
 * CHAIN-ONLY RECONCILIATION IS THE ONLY REGISTRY MECHANISM.
 *
 * `scripts/registry-check.ts` is what decides whether a registry row is true. This runs it for
 * real, as CI does, against a LOCAL mock JSON-RPC — no network, no fund repo, no commit pin — and
 * asserts three things the prose cannot:
 *
 *   1. it reaches ONE host (the mock) and calls only chain methods: eth_blockNumber, eth_getCode, eth_call;
 *   2. when the chain agrees with the rows it exits 0;
 *   3. when the chain DISAGREES with one row — one byte of one symbol — it exits non-zero and names
 *      that row. That is the whole property: the chain is the authority, the file is the claim.
 *
 * If a future change made the script consult anything but the chain (a registry service, a fund
 * clone, a pinned manifest), case 3 would still pass while case 1 caught the extra reach — and a
 * script that stopped asking the chain at all would pass case 1 and fail case 3.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../src/registry.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reg = loadRegistry();

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const encUint = (n: number | bigint) => "0x" + word(n.toString(16));
const encAddr = (a: string) => "0x" + word(a.toLowerCase().replace(/^0x/, ""));
const encString = (s: string) => {
  const bytes = Buffer.from(s, "utf8").toString("hex");
  return "0x" + word("20") + word(bytes.length ? (bytes.length / 2).toString(16) : "0") + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
};
const SEL = { decimals: "0x313ce567", symbol: "0x95d89b41", name: "0x06fdde03", asset: "0x38d52e0f" } as const;

/**
 * A mock chain. `corrupt` lets one row's symbol disagree, which is the discriminating case.
 * `rateLimit` makes the TRANSPORT fail for one selector — HTTP 429, the way a public endpoint
 * refuses under load — which must read as "not checked" and never as a disagreement.
 */
function startMock(corrupt?: { address: string; symbol: string }, corruptDeployment?: { address: string }, rateLimit?: { selector: string }): Promise<{ url: string; methods: Set<string>; perAddress: Map<string, Set<string>>; askedOn: Map<string, Set<number>>; close: () => Promise<void>; server: Server }> {
  const methods = new Set<string>();
  /** address → the chain endpoints it was asked through. A row must be read on its own chain only. */
  const askedOn = new Map<string, Set<number>>();
  /** address → the selectors it was actually asked about. A reconciler that checks only the first
   *  row passes a verdict assertion and fails this one. */
  const perAddress = new Map<string, Set<string>>();
  const rows = new Map(reg.vaults.map((v) => [v.address.toLowerCase(), v]));
  // ONE host plays every chain: the path says which (`/chain/42161`), so "it reached one host" stays
  // a checkable property while each row is still served by an endpoint that answers for its chain.
  const handle = (req: { method: string; params?: unknown[]; id: unknown }, servedChain: number) => {
    methods.add(req.method);
    const id = req.id;
    if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id, result: encUint(600_000_000) };
    if (req.method === "eth_chainId") return { jsonrpc: "2.0", id, result: encUint(servedChain) };
    if (req.method === "eth_getCode") {
      const who = String((req.params?.[0] as string) ?? "").toLowerCase();
      perAddress.set(who, (perAddress.get(who) ?? new Set()).add("getCode"));
      askedOn.set(who, (askedOn.get(who) ?? new Set()).add(servedChain));
      // A chain that agrees about deployment: code exists at the row's deployedAtBlock and at every
      // later block, and does NOT exist before it. `latest` (no block, or the string) is "later".
      const at = req.params?.[1];
      const row = reg.vaults.find((v) => v.address.toLowerCase() === who);
      if (typeof at === "string" && at.startsWith("0x") && row?.deployedAtBlock !== undefined) {
        const asked = BigInt(at);
        const deployed = BigInt(row.deployedAtBlock) - (corruptDeployment?.address.toLowerCase() === who ? 1n : 0n);
        return { jsonrpc: "2.0", id, result: asked >= deployed ? "0x60806040" : "0x" };
      }
      return { jsonrpc: "2.0", id, result: "0x60806040" };
    }
    if (req.method === "eth_call") {
      const call = (req.params?.[0] ?? {}) as { to?: string; data?: string };
      const row = rows.get(String(call.to).toLowerCase());
      if (!row) return { jsonrpc: "2.0", id, error: { code: -32000, message: "unknown address" } };
      const sel = String(call.data).slice(0, 10);
      const who = String(call.to).toLowerCase();
      perAddress.set(who, (perAddress.get(who) ?? new Set()).add(sel));
      askedOn.set(who, (askedOn.get(who) ?? new Set()).add(servedChain));
      if (sel === SEL.decimals) return { jsonrpc: "2.0", id, result: encUint(row.shareDecimals) };
      if (sel === SEL.symbol) {
        const sym = corrupt && corrupt.address.toLowerCase() === row.address.toLowerCase() ? corrupt.symbol : row.symbol;
        return { jsonrpc: "2.0", id, result: encString(sym) };
      }
      if (sel === SEL.name) return { jsonrpc: "2.0", id, result: encString(row.name) };
      if (sel === SEL.asset) {
        if (row.chassis === "enzyme") return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } };
        return { jsonrpc: "2.0", id, result: encAddr(row.asset.address) };
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected selector ${sel}` } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method ${req.method} is not a chain read` } };
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      // The endpoint refuses, at the HTTP layer — not the contract. This is what a public RPC does
      // under load, and the whole point of the test below is that it must not be read as bad data.
      if (rateLimit && JSON.stringify(parsed).includes(rateLimit.selector)) {
        res.writeHead(429, { "content-type": "text/plain" });
        res.end("Too Many Requests");
        return;
      }
      const servedChain = Number(/\/chain\/(\d+)/.exec(req.url ?? "")?.[1] ?? 8453);
      const out = Array.isArray(parsed) ? parsed.map((p) => handle(p, servedChain)) : handle(parsed, servedChain);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      ok({
        url: `http://127.0.0.1:${port}`,
        methods,
        perAddress,
        askedOn,
        server,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    }),
  );
}

const exec = promisify(execFile);

/**
 * ⚠️ ASYNC on purpose. `spawnSync` blocks this process's event loop, so the in-process mock server
 * can never answer and every call "reverts" — a green-looking harness measuring nothing.
 */
const run = async (rpc: string, arbitrumServes = 42161): Promise<{ status: number; out: string }> => {
  try {
    const { stdout, stderr } = await exec("npx", ["tsx", "scripts/registry-check.ts"], {
      cwd: pkgRoot,
      timeout: 120_000,
      // Only the RPCs are supplied — one per chain, each a path on the one mock host. No fund
      // variables exist in this environment, and the ones that used to matter are set to values that
      // would break the script if it still read them. `arbitrumServes` lets one test hand the
      // Arbitrum variable an endpoint that answers for a different chain.
      env: {
        ...process.env,
        TREASURY_RPC_BASE: `${rpc}/chain/8453`,
        BASE_RPC_URL: `${rpc}/chain/8453`,
        TREASURY_RPC_ARBITRUM: `${rpc}/chain/${arbitrumServes}`,
        ARBITRUM_RPC_URL: `${rpc}/chain/${arbitrumServes}`,
        FUND_REPO: "/nonexistent",
        FUND_RPC_BASE: "not-a-url",
      },
    });
    return { status: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { status: err.code ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
};

const mocks: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of mocks) await c(); });

describe("registry-check reconciles against the CHAIN and nothing else", () => {
  it("agreeing chain → exit 0, and the ONLY calls made are chain reads on the one host it was given", async () => {
    const mock = await startMock();
    mocks.push(mock.close);
    const r = await run(mock.url);
    expect(r.out, "registry-check must pass against a chain that agrees").toContain("registry agrees with the chain");
    expect(r.status).toBe(0);
    // The method set is the instrument: an extra reach (a registry service, an operator endpoint)
    // would show up here even if the verdict were unchanged.
    // `eth_chainId` is in the set because the script proves each endpoint is on its chain before
    // reading any row through it.
    expect([...mock.methods].sort()).toEqual(["eth_blockNumber", "eth_call", "eth_chainId", "eth_getCode"]);
    // Each row was read on ITS chain and on no other: a reconciler that read an Arbitrum row
    // through the Base endpoint would report "no contract" about a vault that exists.
    expect(new Set(reg.vaults.map((v) => v.chainId)).size, "premise: the registry spans more than one chain").toBeGreaterThan(1);
    for (const v of reg.vaults) expect([...(mock.askedOn.get(v.address.toLowerCase()) ?? [])], `${v.symbol} must be read on chain ${v.chainId} only`).toEqual([v.chainId]);
    // and it ASKED THE CHAIN about every row. Printing an identifier is not interrogating an address:
    // a reconciler that read row one and trusted the rest would pass a verdict assertion and fail
    // this one. Enzyme is asked decimals()/symbol() but not asset() — that is the row's own rule.
    expect(r.out).toContain(`${reg.vaults.length} rows`);
    for (const v of reg.vaults) {
      const asked = mock.perAddress.get(v.address.toLowerCase()) ?? new Set<string>();
      const want = v.chassis === "enzyme" ? ["getCode", SEL.decimals, SEL.symbol, SEL.name] : ["getCode", SEL.decimals, SEL.symbol, SEL.name, SEL.asset];
      expect([...asked].sort(), `${v.symbol} (${v.address}) was not fully interrogated`).toEqual([...want].sort());
    }
  }, 180_000);

  it("one row disagreeing with the chain → exit 1, naming that row (the chain wins, never the file)", async () => {
    // The LAST non-Enzyme row, deliberately: corrupting the first would also pass against a
    // reconciler that checked only row one.
    const nonEnzyme = reg.vaults.filter((v) => v.chassis !== "enzyme");
    const target = nonEnzyme[nonEnzyme.length - 1]!;
    // The row checked is the LAST one, so a script that stopped after row 0 would miss it. With a
    // single-vault registry that IS row 0 and this arm proves only that a disagreement is caught;
    // the "asked the chain about every row" test above is what carries the all-rows property.
    expect(reg.vaults.indexOf(target)).toBe(reg.vaults.length - 1);
    const mock = await startMock({ address: target.address, symbol: "WRONG-SYM" });
    mocks.push(mock.close);
    const r = await run(mock.url);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(new RegExp(`${target.address}: registry symbol`));
    expect(r.out).toContain("the chain is right; fix the row");
  }, 180_000);

  it("the ENDPOINT refuses (429) → 'not checked', never a disagreement, and the URL is not echoed", async () => {
    // 🔴 The defect this exists for: a bare `catch` around each read attributed EVERY failure to the
    // contract, so a rate-limited endpoint made the script print "N disagreement(s) — the chain is
    // right; fix the row" about a registry that was correct. Measured on the real public endpoint:
    // three runs of an unchanged registry gave 1, 6 and 6 "disagreements"; a keyed endpoint gave 0.
    const mock = await startMock(undefined, undefined, { selector: SEL.asset });
    mocks.push(mock.close);
    const r = await run(mock.url);
    expect(r.status, "an unchecked row is not a pass").toBe(1);
    expect(r.out, "a transport failure must be named as one").toContain("NOT CHECKED");
    expect(r.out, "and must not be reported as bad data").not.toContain("the chain is right; fix the row");
    expect(r.out, "no row disagreed, because none of them did").not.toMatch(/^✗/m);
    // The endpoint is a secret when it carries a key. viem puts the request URL in its message.
    expect(r.out, "the endpoint must never be echoed on an error path").not.toContain(mock.url);
  }, 180_000);

  it("an endpoint that answers for the WRONG chain → that chain's rows are 'not checked', never 'no contract'", async () => {
    // The Arbitrum variable holds an endpoint that says it is Base. Read through it, every Arbitrum
    // row's address has no code — which would print "no contract at …" and "the chain is right; fix
    // the row" about rows that are correct. The script must refuse to read them there at all.
    const mock = await startMock();
    mocks.push(mock.close);
    const r = await run(mock.url, 8453);
    expect(r.status, "unchecked rows are not a pass").toBe(1);
    const arbRows = reg.vaults.filter((v) => v.chainId === 42161);
    expect(arbRows.length).toBeGreaterThan(0);
    for (const v of arbRows) {
      expect(r.out).toMatch(new RegExp(`\\? ${v.symbol}: every check — NOT CHECKED: the endpoint in TREASURY_RPC_ARBITRUM answers for chain 8453, not Arbitrum One \\(42161\\)`));
      expect(mock.askedOn.get(v.address.toLowerCase()), `${v.symbol} must not be read through a Base endpoint`).toBeUndefined();
    }
    expect(r.out, "a misconfigured endpoint is not bad data").not.toContain("the chain is right; fix the row");
    expect(r.out).not.toMatch(/^✗/m);
    // the Base rows were still checked, on Base
    for (const v of reg.vaults.filter((x) => x.chainId === 8453)) expect(r.out).toContain(`✓ ${v.symbol}: symbol() = ${v.symbol}`);
    expect(r.out).not.toContain(mock.url);
  }, 180_000);

  it("eth_getCode refused by the ENDPOINT → 'not checked', and the URL is not echoed", async () => {
    // getCode is the first read of every row and was the one read with no handler: a transport
    // failure there escaped as an uncaught error that printed the endpoint's full URL.
    const mock = await startMock(undefined, undefined, { selector: "eth_getCode" });
    mocks.push(mock.close);
    const r = await run(mock.url);
    expect(r.status).toBe(1);
    expect(r.out).toContain("NOT CHECKED");
    expect(r.out).not.toContain("the chain is right; fix the row");
    expect(r.out).not.toMatch(/^✗/m);
    expect(r.out, "the endpoint must never be echoed on an error path").not.toContain(mock.url);
    expect(r.out).not.toMatch(/HttpRequestError|at async|node:internal/); // a handled failure, not a crash
  }, 180_000);

  it("a deployedAtBlock that is one block LATE → exit 1, naming that row", async () => {
    // The field `earn_balance` scans from. One block late silently drops a first deposit, and no
    // other check in this script would notice: symbol, decimals and asset all still agree.
    const nonEnzyme = reg.vaults.filter((v) => v.chassis !== "enzyme" && v.deployedAtBlock !== undefined);
    const target = nonEnzyme[nonEnzyme.length - 1]!;
    const mock = await startMock(undefined, { address: target.address });
    mocks.push(mock.close);
    const r = await run(mock.url);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(new RegExp(`${target.symbol}: deployedAtBlock \\d+ is LATE`));
    expect(r.out).toContain("the chain is right; fix the row");
  }, 180_000);
});
