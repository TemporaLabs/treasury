import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The bundle starts the MCP server only when it IS the file Node was asked to run — decided by
 * resolved-path identity, never by the invoked name (see `isEntryPoint` in `src/mcp/server.ts`).
 *
 * Each case runs `node <path>` against the COMMITTED `dist/mcp-server.mjs` (what npm and the plugin
 * ship), sends an `initialize` request on stdin, and reads whether anything answers. "Answers" is
 * the instrument: the row that must start proves it fires, so the rows that must stay silent are
 * measured, not assumed. Measured on the 0.1.0 bundle, before the fix, the rows read the other way
 * round wherever the invoked NAME rather than the file decided.
 */

const BUNDLE = resolve(__dirname, "../dist/mcp-server.mjs");
const VERSION = (JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string }).version;
const INITIALIZE =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }) + "\n";

/** Run `node [...flags] <entry>`, write one initialize request (then `more`, if given), return what came back. */
function firstReply(entry: string, flags: string[] = [], more = ""): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const p = spawn("node", [...flags, entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 8_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    p.stdin.write(INITIALIZE + more);
    // A started server answers, then waits for more; a module that never started exits on its own.
    // Either way, closing stdin after the answer (or a short grace period) lets the process end.
    setTimeout(() => p.stdin.end(), 1_500);
  });
}

function serverInfo(stdout: string): { name: string; version: string } | undefined {
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return undefined;
  return (JSON.parse(line) as { result?: { serverInfo?: { name: string; version: string } } }).result?.serverInfo;
}

describe("the bundle starts the server only when it is the entry file", () => {
  let dir: string;
  let bin: string; // an extensionless symlink named like npm's bin, pointing at the bundle
  let importer: string; // a script named *server.mjs that imports the bundle without being it

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "treasury-entry-"));
    bin = join(dir, "treasury-mcp");
    symlinkSync(BUNDLE, bin);
    importer = join(dir, "importer-server.mjs");
    writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(BUNDLE).href)};\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("control: run by its real path (the plugin's launch path) it answers initialize", async () => {
    const r = await firstReply(BUNDLE);
    expect(serverInfo(r.stdout)?.name).toBe("treasury");
    expect(r.stderr).toBe("");
  });

  it("run through an extensionless symlink named `treasury-mcp` — npm's bin shape — it answers initialize", async () => {
    const r = await firstReply(bin);
    expect(serverInfo(r.stdout)?.name).toBe("treasury");
    expect(r.stderr).toBe("");
  });

  it("run through that symlink with `--preserve-symlinks-main`, it still reads its OWN package.json and registry", async () => {
    // With the flag, import.meta.url is the symlink's path, not the bundle's. The package.json and
    // registry beside the bundle must still be the ones read: resolved from the symlink instead,
    // `../package.json` is a file in whatever directory holds the link (a consumer's node_modules/).
    const vaults =
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "earn_vaults", arguments: {} } }) + "\n";
    const r = await firstReply(bin, ["--preserve-symlinks-main"], vaults);
    expect(r.stderr).toBe("");
    expect(serverInfo(r.stdout)).toEqual({ name: "treasury", version: VERSION });
    // earn_vaults reads the registry: an answer without isError means ../registry/vaults.json was found
    const reply = r.stdout.split("\n").filter((l) => l.includes('"id":2')).map((l) => JSON.parse(l) as { result?: { isError?: boolean } })[0];
    expect(reply?.result).toBeDefined();
    expect(reply?.result?.isError).not.toBe(true);
  });

  it("imported by an unrelated script named `*server.mjs`, it does NOT start: no reply, clean exit", async () => {
    const r = await firstReply(importer);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it("preloaded with `--import` ahead of another entry named `*server.mjs`, it does NOT start", async () => {
    // import.meta.url is the bundle, process.argv[1] is the other entry: the guard reads "not me".
    // The name-based guard this replaced started the server here whenever the OTHER entry's name
    // ended in `server.mjs` — which is the entry's name, not the bundle's.
    const other = join(dir, "other-server.mjs");
    writeFileSync(other, "");
    const r = await firstReply(other, ["--import", pathToFileURL(BUNDLE).href]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});

/**
 * The server builds its tool schemas from the registry (the `chain` argument lists the chains that
 * have a vault). A registry that does not parse must not stop it from STARTING: a host shows a
 * server that died at launch as a closed connection with no reason, while a server that starts can
 * say which registry rule was broken. Run against a copy of the committed bundle beside a registry
 * that breaks the one-default-per-chain rule.
 */
describe("a registry that does not parse is reported by the tools, not by the server failing to start", () => {
  let dir: string;
  const layout = (registry: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), "treasury-badreg-"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "registry"));
    copyFileSync(BUNDLE, join(root, "dist/mcp-server.mjs"));
    copyFileSync(resolve(__dirname, "../package.json"), join(root, "package.json"));
    writeFileSync(join(root, "registry/vaults.json"), JSON.stringify(registry));
    return root;
  };
  const shipped = () => JSON.parse(readFileSync(resolve(__dirname, "../registry/vaults.json"), "utf8")) as { vaults: { chainId: number; isDefault: boolean }[] };
  const call =
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "earn_vaults", arguments: {} } }) + "\n";
  const reply = (stdout: string, id: number) =>
    stdout.split("\n").filter((l) => l.includes(`"id":${id}`)).map((l) => JSON.parse(l) as { result?: { isError?: boolean; tools?: unknown[]; content?: { text: string }[] } })[0];

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("control: the same layout with the SHIPPED registry starts and lists the vaults", async () => {
    const root = layout(shipped());
    try {
      const r = await firstReply(join(root, "dist/mcp-server.mjs"), [], call);
      expect(serverInfo(r.stdout)?.name).toBe("treasury");
      expect(reply(r.stdout, 3)?.result?.isError).not.toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no vault on the default chain: the schema alone accepts it, so the LOAD refuses it and names the cause", async () => {
    // One default per chain that HAS a vault is all the schema can hold. An Arbitrum-only registry
    // passes it — and then the discovery call would fail with an error about a chain nobody asked for.
    const arbOnly = shipped();
    arbOnly.vaults = arbOnly.vaults.filter((v) => v.chainId === 42161);
    expect(arbOnly.vaults.length, "premise: the shipped registry has a vault on a second chain").toBeGreaterThan(0);
    const root = layout(arbOnly);
    try {
      const r = await firstReply(join(root, "dist/mcp-server.mjs"), [], call);
      expect(serverInfo(r.stdout)?.name, `the server did not start: ${r.stderr}`).toBe("treasury");
      const vaults = reply(r.stdout, 3);
      expect(vaults?.result?.isError).toBe(true);
      expect(vaults?.result?.content?.[0]?.text).toMatch(/the registry has no vault on Base, which config\/earn\.ts names as the default chain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("two defaults on one chain: the server still starts and lists its tools, and the tool names the broken rule", async () => {
    const bad = shipped();
    for (const v of bad.vaults) if (v.chainId === 8453) v.isDefault = true; // two Base defaults
    dir = layout(bad);
    const r = await firstReply(join(dir, "dist/mcp-server.mjs"), [], call);
    expect(serverInfo(r.stdout)?.name, `the server did not start: ${r.stderr}`).toBe("treasury");
    expect(reply(r.stdout, 2)?.result?.tools).toHaveLength(8);
    const vaults = reply(r.stdout, 3);
    expect(vaults?.result?.isError).toBe(true);
    expect(vaults?.result?.content?.[0]?.text).toMatch(/exactly one vault per chain must be isDefault; chain 8453 has [23]/);
  });
});
