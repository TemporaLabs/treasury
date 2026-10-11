import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";

/**
 * The registry and the version are inlined into whatever bundles this package, so a bundle needs no file beside
 * it, and a file that happens to sit beside it is never read. Two bundles are checked: the committed CLI copied
 * to a bare folder, and a consumer's own bundle of `dist/index.js` (the library entry, which `tsc -b` emits
 * and `npm test` builds first).
 */

const pkgRoot = resolve(__dirname, "..");
const BUNDLE = join(pkgRoot, "dist/treasury.mjs");
const shipped = JSON.parse(readFileSync(join(pkgRoot, "registry/vaults.json"), "utf8")) as { vaults: { symbol: string }[] };
const VERSION = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string }).version;
/** A registry and a manifest that must never be read: the right shape, different content. */
const DECOY_REGISTRY = JSON.stringify({ vaults: [] });
const DECOY_MANIFEST = JSON.stringify({ name: "decoy", version: "9.9.9" });

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "treasury-embedded-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function node(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((done) => {
    const p = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, stderr, code });
    });
  });
}

describe("the registry and the version are inside the bundle", () => {
  /** What `earn vaults` prints from the committed bundle run in place: the baseline the copies are compared with. */
  const reference = async (): Promise<string> => (await node([BUNDLE, "earn", "vaults"])).stdout;

  it("the committed CLI embeds the version and nothing else from package.json", () => {
    // Anything else from the manifest would tie the committed bundle to edits that do not change the CLI: a
    // dev-dependency bump would make dist/treasury.mjs stale, and CI's bundle check would fail on it.
    const text = readFileSync(BUNDLE, "utf8");
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string; scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(text).toContain(JSON.stringify(manifest.version));
    expect(text).not.toMatch(/\bdevDependencies\b/);
    for (const script of Object.values(manifest.scripts)) expect(text, `a package.json script is in the bundle: ${script}`).not.toContain(script);
  });

  it("the committed CLI, alone in a folder, reports its own version and the shipped registry", async () => {
    const root = scratch();
    copyFileSync(BUNDLE, join(root, "treasury.mjs"));
    const v = await node([join(root, "treasury.mjs"), "--version"]);
    expect({ out: v.stdout.trim(), err: v.stderr, code: v.code }).toEqual({ out: VERSION, err: "", code: 0 });
    const vaults = await node([join(root, "treasury.mjs"), "earn", "vaults"]);
    expect(vaults.code, vaults.stderr).toBe(0);
    expect((JSON.parse(vaults.stdout) as { vaults: unknown[] }).vaults.length).toBeGreaterThan(0);
    expect(vaults.stdout).toBe(await reference());
  });

  it("the same CLI ignores a registry and a package.json beside it (and beside its parent)", async () => {
    const root = scratch();
    mkdirSync(join(root, "dist"));
    copyFileSync(BUNDLE, join(root, "dist/treasury.mjs"));
    for (const dir of [root, join(root, "dist")]) {
      mkdirSync(join(dir, "registry"), { recursive: true });
      writeFileSync(join(dir, "registry/vaults.json"), DECOY_REGISTRY);
      writeFileSync(join(dir, "package.json"), DECOY_MANIFEST);
    }
    const v = await node([join(root, "dist/treasury.mjs"), "--version"]);
    expect(v.stdout.trim()).toBe(VERSION);
    const vaults = await node([join(root, "dist/treasury.mjs"), "earn", "vaults"]);
    expect(vaults.code, vaults.stderr).toBe(0);
    expect((JSON.parse(vaults.stdout) as { vaults: unknown[] }).vaults.length).toBeGreaterThan(0);
    expect(vaults.stdout).toBe(await reference());
  });

  it("a consumer's bundle of dist/index.js lists the shipped registry with no file beside it, and ignores a decoy", async () => {
    expect(existsSync(join(pkgRoot, "dist/index.js")), "dist/index.js is missing: run `npm test` (it runs `tsc -b` first), not bare vitest").toBe(true);
    const root = scratch();
    const consumer = join(root, "consumer");
    mkdirSync(join(consumer, "registry"), { recursive: true });
    writeFileSync(join(consumer, "registry/vaults.json"), DECOY_REGISTRY);
    writeFileSync(join(consumer, "package.json"), DECOY_MANIFEST);
    writeFileSync(join(root, "entry.mjs"), `import { listVaults } from ${JSON.stringify(join(pkgRoot, "dist/index.js"))};\nconsole.log(JSON.stringify(listVaults().map((v) => v.symbol)));\n`);
    await build({
      config: false,
      entry: { bundle: join(root, "entry.mjs") },
      outDir: consumer,
      format: ["esm"],
      outExtension: () => ({ js: ".mjs" }),
      platform: "node",
      target: "node22",
      noExternal: [/.*/],
      silent: true,
    });
    const r = await node([join(consumer, "bundle.mjs")]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(shipped.vaults.map((v) => v.symbol));
  }, 60_000);
});
