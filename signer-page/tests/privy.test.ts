import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodePayload } from "../validate.mjs";

/**
 * Privy is an opt-in mode: the opener is given --privy-app-id, the page loads one extra script, and the
 * policy widens to Privy's own servers. These tests pin that it stays opt-in, that the widening is exactly
 * what is listed, and that the one file we write for it (privy/entry.jsx) cannot do more than the page's
 * fixed list of wallet methods. They use a stub bundle: the real one is 5 MB of Privy's SDK, built on
 * demand, and a real login needs an email code, which no automated test can read.
 */
const dir = resolve(import.meta.dirname, "..");
const OPENER = join(dir, "open.mjs");
const APP_ID = "cmubfegl2028d0ci3n0f2u6z5"; // the public app id used in development; an id, not a secret
const stub = join(mkdtempSync(join(tmpdir(), "treasury-privy-")), "privy-provider.js");
writeFileSync(stub, "export async function connectPrivy() { throw new Error('stub'); }\n");

const DEFAULT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";

let child: ChildProcess | undefined;
afterEach(() => { child?.kill(); child = undefined; });

const run = (extra: string[]) =>
  spawnSync(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "0.01", "--manual", ...extra], { input: "", encoding: "utf8", timeout: 10_000 });

function serve(extra: string[]): Promise<URL> {
  return new Promise((ok, no) => {
    child = spawn(process.execPath, [OPENER, "--no-open", "--port", "0", "--minutes", "1", "--manual", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/#\S+)/); if (m) ok(new URL(m[1]!)); });
    child.on("exit", (c) => no(new Error(`opener exited ${c}`)));
  });
}
const get = (url: URL, path: string) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, no) => {
    http.get({ host: "127.0.0.1", port: url.port, path, headers: { host: url.host } }, (res) => {
      let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", no);
  });

describe("open.mjs --privy-app-id", () => {
  it("is opt-in: without the flag there is no Privy script, no Privy policy, and no app id in the address", async () => {
    const url = await serve([]);
    expect((await get(url, "/privy-provider.js")).status).toBe(404);
    const page = await get(url, "/");
    expect(page.headers["content-security-policy"]).toBe(DEFAULT_CSP); // byte for byte what it was before Privy existed
    expect(decodePayload(url.hash.slice(1))).toEqual({ manual: true, vault: "tlCashPlusUSDC2" });
  }, 20_000);

  it("with the flag it serves the bundle, puts the id in the address, and widens the policy to Privy and nothing else", async () => {
    const url = await serve(["--privy-app-id", APP_ID, "--privy-bundle", stub]);
    expect(decodePayload(url.hash.slice(1))).toMatchObject({ manual: true, privyAppId: APP_ID });
    const js = await get(url, "/privy-provider.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.body).toContain("connectPrivy");

    const csp = String((await get(url, "/")).headers["content-security-policy"]);
    const directive = (name: string) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) ?? "").split(/\s+/).slice(1);
    expect(directive("connect-src").sort()).toEqual(["'self'", "https://*.privy.io", "https://auth.privy.io", "https://mainnet.base.org"].sort());
    expect(directive("frame-src").sort()).toEqual(["https://*.privy.io", "https://auth.privy.io"].sort());
    expect(directive("script-src")).toEqual(["'self'", "'unsafe-inline'"]); // no eval, no remote script
    expect(directive("default-src")).toEqual(["'none'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]); //             still cannot be embedded
    expect(directive("form-action")).toEqual(["'none'"]);
    expect(directive("img-src").sort()).toEqual(["data:", "https://*.privy.io"]);
    expect(directive("font-src")).toEqual(["data:"]);
    const sources = csp.split(";").flatMap((d) => d.trim().split(/\s+/).slice(1));
    expect(sources).not.toContain("*"); //           no bare wildcard anywhere
    expect(sources).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/walletconnect/i);
  }, 20_000);

  it("refuses to start when the bundle is not built, and says how to build it", () => {
    const r = run(["--privy-app-id", APP_ID, "--privy-bundle", join(tmpdir(), "does-not-exist.js")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Privy bundle is not built/);
    expect(r.stderr).toMatch(/npm --prefix signer-page\/privy ci/);
    expect(r.stdout).toBe("");
  });

  it.each([["UPPER-and-dashes"], ["short"], ["has space in it"], ["<script>"]])("refuses %j as an app id", (id) => {
    const r = run(["--privy-app-id", id, "--privy-bundle", stub]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });

  it("--privy-bundle means nothing without --privy-app-id", () => {
    expect(run(["--privy-bundle", stub]).status).toBe(2);
  });
});

describe("the Privy bridge source (privy/entry.jsx) can do no more than the page's fixed wallet methods", () => {
  const src = readFileSync(join(dir, "privy", "entry.jsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const READS = ["eth_chainId", "eth_accounts", "eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBalance"];
  const WRITES = ["eth_requestAccounts", "wallet_switchEthereumChain", "eth_sendTransaction"];

  it("forwards exactly the methods the page is allowed to call, and refuses the rest", () => {
    const listed = [...code.match(/new Set\(\[([\s\S]*?)\]\)/)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect([...listed].sort()).toEqual([...READS, ...WRITES].sort());
    expect(code).toMatch(/if \(!ALLOWED\.has\(method\)\) throw/); // checked before anything is forwarded
  });

  it("never signs a message, exports or reads a key, or stores anything itself", () => {
    expect(code).not.toMatch(/signMessage|signTypedData|signTransaction|personal_sign|eth_sign\b|signRawHash|exportWallet|useExportWallet|privateKey|private_key|mnemonic|seed ?phrase|localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/i);
  });

  it("asks for email login only, on Base only", () => {
    expect(code).toMatch(/loginMethods: \["email"\]/);
    expect(code).toMatch(/supportedChains: \[base\]/);
  });

  it("the build workspace keeps its dependencies out of the core package and pinned exactly", () => {
    const pkg = JSON.parse(readFileSync(join(dir, "privy", "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const [name, version] of Object.entries(pkg.devDependencies as Record<string, string>)) expect({ name, exact: /^\d+\.\d+\.\d+$/.test(version) }).toEqual({ name, exact: true });
    const root = JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf8"));
    expect(JSON.stringify(root.dependencies) + JSON.stringify(root.devDependencies)).not.toMatch(/privy|react/i);
    expect(root.workspaces).toBeUndefined();
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^vendor\/$/m); // the 5 MB bundle is built, never committed
  });

  it("the page loads the bundle from its own origin, only when told to, and nothing else dynamically", () => {
    const app = readFileSync(join(dir, "app.mjs"), "utf8").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect([...app.matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"./privy-provider.js"']);
    expect(app).toMatch(/payload\.privyAppId !== undefined/);
  });
});
