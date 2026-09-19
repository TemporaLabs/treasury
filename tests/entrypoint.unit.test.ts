import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const INITIALIZE =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }) + "\n";

/** Run `node [...flags] <entry>`, write one initialize request, return what came back. */
function firstReply(entry: string, flags: string[] = []): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
    p.stdin.write(INITIALIZE);
    // A started server answers, then waits for more; a module that never started exits on its own.
    // Either way, closing stdin after the answer (or a short grace period) lets the process end.
    setTimeout(() => p.stdin.end(), 1_500);
  });
}

function serverInfo(stdout: string): { name: string } | undefined {
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return undefined;
  return (JSON.parse(line) as { result?: { serverInfo?: { name: string } } }).result?.serverInfo;
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
