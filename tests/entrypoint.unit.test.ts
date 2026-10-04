import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The bundle runs the CLI only when it IS the file Node was asked to run — decided by resolved-path
 * identity, never by the invoked name (see `isEntryPoint` in `src/cli.ts`).
 *
 * Each case runs `node <path> [args]` against the COMMITTED `dist/treasury.mjs` (what npm and the
 * plugin ship) and reads whether anything answered. "Answers" is the instrument: the row that must
 * run proves it fires, so the rows that must stay silent are measured, not assumed. Measured on the
 * 0.1.0 bundle, before the fix, the rows read the other way round wherever the invoked NAME rather
 * than the file decided.
 */

const BUNDLE = resolve(__dirname, "../dist/treasury.mjs");
const VERSION = (JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string }).version;

/** Run `node [...flags] <entry> [...args]` to completion and return what came back. */
function run(entry: string, args: string[] = [], flags: string[] = []): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const p = spawn("node", [...flags, entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
  });
}

describe("the bundle runs the CLI only when it is the entry file", () => {
  let dir: string;
  let bin: string; // an extensionless symlink named like npm's bin, pointing at the bundle
  let importer: string; // a script that imports the bundle without being it

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "treasury-entry-"));
    bin = join(dir, "treasury");
    symlinkSync(BUNDLE, bin);
    importer = join(dir, "importer.mjs");
    writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(BUNDLE).href)};\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("control: run by its real path (the plugin's launch path) it answers --version", async () => {
    const r = await run(BUNDLE, ["--version"]);
    expect(r.stdout.trim()).toBe(VERSION);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it("run through an extensionless symlink named `treasury` — npm's bin shape — it answers --version", async () => {
    const r = await run(bin, ["--version"]);
    expect(r.stdout.trim()).toBe(VERSION);
    expect(r.stderr).toBe("");
  });

  it("run through that symlink with `--preserve-symlinks-main`, it still reads its OWN package.json and registry", async () => {
    // With the flag, import.meta.url is the symlink's path, not the bundle's. The package.json and
    // registry beside the bundle must still be the ones read: resolved from the symlink instead,
    // `../package.json` is a file in whatever directory holds the link (a consumer's node_modules/).
    const version = await run(bin, ["--version"], ["--preserve-symlinks-main"]);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toBe(VERSION);
    // `earn vaults` reads the registry: exit 0 with a vault list means ../registry/vaults.json was found
    const vaults = await run(bin, ["earn", "vaults"], ["--preserve-symlinks-main"]);
    expect(vaults.stderr).toBe("");
    expect(vaults.code).toBe(0);
    expect((JSON.parse(vaults.stdout) as { vaults: unknown[] }).vaults.length).toBeGreaterThan(0);
  });

  it("imported by an unrelated script, it does NOT run: no output, clean exit", async () => {
    const r = await run(importer, ["--version"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it("preloaded with `--import` ahead of another entry, it does NOT run", async () => {
    // import.meta.url is the bundle, process.argv[1] is the other entry: the guard reads "not me".
    const other = join(dir, "other.mjs");
    writeFileSync(other, "");
    const r = await run(other, ["--version"], ["--import", pathToFileURL(BUNDLE).href]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});

/**
 * The commands build their schemas from the registry (the `chain` flag lists the chains that have a
 * vault). A registry that does not parse must not stop the CLI from answering `--help`: a CLI that
 * dies before printing anything leaves an agent nothing to report, while one that runs can say which
 * registry rule was broken. Run against a copy of the committed bundle beside a registry that breaks
 * the one-default-per-chain rule.
 */
describe("a registry that does not parse is reported by the commands, not by the CLI failing to start", () => {
  let dir: string;
  const layout = (registry: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), "treasury-badreg-"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "registry"));
    copyFileSync(BUNDLE, join(root, "dist/treasury.mjs"));
    copyFileSync(resolve(__dirname, "../package.json"), join(root, "package.json"));
    writeFileSync(join(root, "registry/vaults.json"), JSON.stringify(registry));
    return root;
  };
  const shipped = () => JSON.parse(readFileSync(resolve(__dirname, "../registry/vaults.json"), "utf8")) as { vaults: { chainId: number; isDefault: boolean }[] };

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("control: the same layout with the SHIPPED registry lists the vaults", async () => {
    const root = layout(shipped());
    try {
      const r = await run(join(root, "dist/treasury.mjs"), ["earn", "vaults"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
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
      const r = await run(join(root, "dist/treasury.mjs"), ["earn", "vaults"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect((JSON.parse(r.stderr) as { error: string }).error).toMatch(/the registry has no vault on Base, which config\/earn\.ts names as the default chain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("two defaults on one chain: the CLI still lists its commands, and the command names the broken rule", async () => {
    const bad = shipped();
    for (const v of bad.vaults) if (v.chainId === 8453) v.isDefault = true; // two Base defaults
    dir = layout(bad);
    const help = await run(join(dir, "dist/treasury.mjs"), ["earn", "--help"]);
    expect(help.code, `the CLI did not answer --help: ${help.stderr}`).toBe(0);
    expect((JSON.parse(help.stdout) as { commands: unknown[] }).commands).toHaveLength(8);
    const r = await run(join(dir, "dist/treasury.mjs"), ["earn", "vaults"]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: string }).error).toMatch(/exactly one vault per chain must be isDefault; chain 8453 has [23]/);
  });
});
