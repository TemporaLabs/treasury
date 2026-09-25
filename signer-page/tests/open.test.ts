import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { resolve } from "node:path";
import type { Address } from "viem";
import { buildDeposit, buildWithdraw } from "../../src/build.js";
import { loadRegistry, getVault } from "../../src/registry.js";
import { decodePayload, validatePayload } from "../validate.mjs";

const OPENER = resolve(import.meta.dirname, "..", "open.mjs");
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const vault = getVault("tlCashPlusUSDC2");
const envelope = (over: Record<string, unknown> = {}) => ({
  requires_signature: true,
  status: "unsigned",
  signer_rules: ["prose the opener does not use"],
  calls: buildDeposit(vault, { assetsHuman: "25", receiver: ACCOUNT, account: ACCOUNT }),
  ...over,
});

const run = (input: unknown, extra: string[] = ["--account", ACCOUNT]) =>
  spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "1", ...extra], { input: JSON.stringify(input), encoding: "utf8", timeout: 10_000 });

let child: ChildProcess | undefined;
afterEach(() => { child?.kill(); child = undefined; });

/** Start the opener for real and wait for the URL it prints. */
function serve(input: unknown): Promise<{ url: URL }> {
  return new Promise((ok, no) => {
    child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "1", "--account", ACCOUNT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok({ url: new URL(m[1]!) }); });
    child.on("exit", (code) => no(new Error(`opener exited ${code} before serving`)));
    child.stdin!.end(JSON.stringify(input));
  });
}

const get = (url: URL, opts: { method?: string; host?: string; path?: string } = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, no) => {
    const req = http.request({ host: "127.0.0.1", port: url.port, path: opts.path ?? "/", method: opts.method ?? "GET", headers: { host: opts.host ?? url.host } }, (res) => {
      let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", no); req.end();
  });

describe("open.mjs refuses before it serves", () => {
  it("a poisoned envelope gets no URL and no server", () => {
    const bad = envelope({ calls: envelope().calls.map((c, i) => (i === 1 ? { ...c, to: "0x3333333333333333333333333333333333333333" } : c)) });
    const r = run(bad);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to open/);
    expect(r.stdout).toBe("");
  });

  it("a receiver that is not the --account is refused", () => {
    const r = run(envelope(), ["--account", "0x2222222222222222222222222222222222222222"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/receiver .* is not the connected account/);
  });

  it.each([
    ["an envelope that is not marked unsigned", { status: "submitted" }],
    ["an envelope that does not require a signature", { requires_signature: false }],
  ])("%s", (_n, over) => {
    const r = run(envelope(over));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not an unsigned envelope/);
  });

  it("input that is not JSON", () => {
    const r = spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--account", ACCOUNT], { input: "cast send 0x…", encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not JSON/);
  });

  it("a bad --port is a usage error (a missing --account is not: that means follow the connected wallet)", () => {
    expect(spawnSync(process.execPath, [OPENER, "--no-open", "--port", "nope"], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 10_000 }).status).toBe(2);
  });

  it("accepts the library's bare array as well as the envelope", async () => {
    const { url } = await serve(envelope().calls);
    expect((await get(url)).status).toBe(200);
  });
});

describe("open.mjs serves the page and nothing else", () => {
  it("the URL's fragment is the validated, slimmed payload", async () => {
    const { url } = await serve(envelope());
    const p = decodePayload(url.hash.slice(1));
    expect(p.account).toBe(ACCOUNT);
    expect(p.calls).toHaveLength(2);
    expect(Object.keys(p.calls[0]).sort()).toEqual(["chainId", "data", "description", "to", "value"]);
    expect(() => validatePayload(p, loadRegistry())).not.toThrow();
  });

  it("serves the four files, byte for byte, with a policy that closes the way out", async () => {
    const { url } = await serve(envelope());
    for (const [path, file] of [["/", "index.html"], ["/app.mjs", "app.mjs"], ["/validate.mjs", "validate.mjs"]] as const) {
      const r = await get(url, { path });
      expect(r.status).toBe(200);
      expect(r.body).toBe(readFileSync(resolve(OPENER, "..", file), "utf8"));
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      const csp = String(r.headers["content-security-policy"]);
      expect(csp).toMatch(/default-src 'none'/); //        everything not named is closed
      expect(csp).toMatch(/script-src 'self'/); //         and the page's own script is named: without it `default-src` blocks the page
      expect(csp).toMatch(/connect-src 'self'/); //        nothing the page holds can be sent anywhere but home
      expect(csp).toMatch(/frame-ancestors 'none'/);
    }
    const reg = await get(url, { path: "/registry.json" });
    expect(JSON.parse(reg.body)).toEqual(JSON.parse(readFileSync(resolve(OPENER, "..", "..", "registry", "vaults.json"), "utf8")));
  });

  it("does not serve the envelope, and does not answer anything but GET", async () => {
    const { url } = await serve(envelope());
    expect((await get(url, { path: "/envelope.json" })).status).toBe(404);
    expect((await get(url, { path: "/../package.json" })).status).toBe(404);
    expect((await get(url, { method: "POST" })).status).toBe(405);
  });

  it("refuses a request whose Host is not loopback (DNS rebinding)", async () => {
    const { url } = await serve(envelope());
    expect((await get(url, { host: "attacker.example" })).status).toBe(403);
    expect((await get(url, { host: `attacker.example:${url.port}` })).status).toBe(403);
    expect((await get(url, { host: `localhost:${url.port}` })).status).toBe(200);
  });
});


describe("open.mjs with no --account (follow the connected wallet)", () => {
  const followRun = (input: unknown) => run(input, []);

  it("accepts a valid envelope, says whose wallet it will use, and carries the follow flag in the address", () => {
    const child2 = spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "0.01"], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 10_000 });
    expect(child2.status).toBe(0);
    expect(child2.stdout).toMatch(/whichever wallet you connect/);
    const url = child2.stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/)![1]!;
    const sent = decodePayload(new URL(url).hash.slice(1));
    expect(sent.follow).toBe(true);
    expect(sent.calls).toHaveLength(2);
  }, 20_000);

  it("still refuses a poisoned envelope before any URL exists", () => {
    const bad = envelope({ calls: envelope().calls.map((c, i) => (i === 1 ? { ...c, to: "0x3333333333333333333333333333333333333333" } : c)) });
    const r = followRun(bad);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to open/);
    expect(r.stdout).toBe("");
  });

  it("refuses a redeem, which is one account's exact share balance", () => {
    const redeem = buildWithdraw(vault, { all: true, sharesExact: "12.5", receiver: ACCOUNT, owner: ACCOUNT });
    const r = followRun(envelope({ calls: redeem }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot follow the connected wallet/);
  });
});


describe("open.mjs --then (a withdraw that follows the deposit on the same page)", () => {
  const dir = mkdtempSync(join(tmpdir(), "treasury-then-"));
  const thenFile = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f; };
  const withdrawEnv = (over: Record<string, unknown> = {}) => ({ requires_signature: true, status: "unsigned", calls: buildWithdraw(vault, { assetsHuman: "10", receiver: ACCOUNT, owner: ACCOUNT }), ...over });

  it("carries the follow-up in the address, and says nothing is asked for it yet", () => {
    const f = thenFile("ok.json", withdrawEnv());
    const r = spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "0.01", "--then", f], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
    const sent = decodePayload(new URL(r.stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/)![1]!).hash.slice(1));
    expect(sent.calls).toHaveLength(2);
    expect(sent.then).toHaveLength(1);
  }, 20_000);

  it("works with --account too", () => {
    const f = thenFile("ok2.json", withdrawEnv());
    const r = spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "0.01", "--account", ACCOUNT, "--then", f], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
  }, 20_000);

  it.each([
    ["more than the deposit puts in", () => withdrawEnv({ calls: buildWithdraw(vault, { assetsHuman: "500", receiver: ACCOUNT, owner: ACCOUNT }) }), /more than the deposit/],
    ["a different account than the deposit", () => withdrawEnv({ calls: buildWithdraw(vault, { assetsHuman: "1", receiver: "0x2222222222222222222222222222222222222222" as Address, owner: "0x2222222222222222222222222222222222222222" as Address }) }), /different account/],
    ["a redeem", () => withdrawEnv({ calls: buildWithdraw(vault, { all: true, sharesExact: "1", receiver: ACCOUNT, owner: ACCOUNT }) }), /cannot follow|must be a withdraw/],
    ["something that is not an unsigned envelope", () => ({ calls: [] }), /not an unsigned envelope/],
  ])("refuses a follow-up that is %s, before any URL exists", (_n, make, why) => {
    const f = thenFile("bad.json", make());
    const r = spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "1", "--then", f], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to open/);
    expect(r.stderr).toMatch(why);
    expect(r.stdout).toBe("");
  });
});


describe("open.mjs --manual (no envelope; the operator types the amounts on the page)", () => {
  const manualRun = (extra: string[] = []) =>
    spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "0.01", "--manual", ...extra], { input: "", encoding: "utf8", timeout: 10_000 });

  it("needs no envelope, and puts only the vault in the address", () => {
    const r = manualRun();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/manual mode for tlCashPlusUSDC2/);
    const sent = decodePayload(new URL(r.stdout.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/)![1]!).hash.slice(1));
    expect(sent).toEqual({ manual: true, vault: "tlCashPlusUSDC2" });
  }, 20_000);

  it("takes --vault, but only a vault the registry lists on Base", () => {
    expect(manualRun(["--vault", "tlCashPlusUSDC2A"]).status).toBe(0);
    const r = manualRun(["--vault", "not-a-vault"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/registry has no Base vault named not-a-vault/);
    expect(r.stdout).toBe("");
  });

  it("refuses to be mixed with an envelope, and --vault means nothing without --manual", () => {
    expect(manualRun(["--account", ACCOUNT]).status).toBe(2);
    expect(manualRun(["--file", "x.json"]).status).toBe(2);
    expect(spawnSync(process.execPath, [OPENER, "--no-open", "--vault", "tlCashPlusUSDC2"], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 10_000 }).status).toBe(2);
  });
});
