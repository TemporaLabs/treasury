import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/cli.js";
import { GUIDE_URL } from "../src/guide.js";
import { EDITS, expectedGuide, isCurrent, skillBody as generatedSkillBody } from "../scripts/llms-txt.js";

/**
 * `llms.txt` is the guide an agent without the plugin is pointed to by `--help`. It is generated, so the
 * tests pin the three ways it can go wrong: it drifts from its sources, `--help` stops naming it, or it says
 * something the skill does not. (What the repository may not publish is checked by its own scan of every file,
 * this one included.)
 */

const pkgRoot = resolve(__dirname, "..");
const BUNDLE = join(pkgRoot, "dist/treasury.mjs");
// Compared on `\n`: a Windows checkout (`core.autocrlf`) has `\r\n` line ends, which the generator also normalises.
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const GUIDE = lf(readFileSync(join(pkgRoot, "llms.txt"), "utf8"));
const SKILL = lf(readFileSync(join(pkgRoot, "plugin/skills/earn/SKILL.md"), "utf8"));

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const bundle = (cwd: string, args: string[]) => spawnSync("node", args, { cwd, encoding: "utf8" });

describe("llms.txt is what the skill and the commands produce", () => {
  it("the committed file equals the generated one (run `npm run build` to refresh it)", async () => {
    expect(GUIDE).toBe(await expectedGuide());
  });

  it("it carries the skill's rules and every command of both skills", async () => {
    // The skill's body, with only the launch line rewritten: pick lines from three different sections.
    for (const line of ["## Choosing the chain", "## Opening an account and depositing", "## What this skill will not do"]) expect(GUIDE).toContain(line);
    for (const skill of ["earn", "connect"]) {
      const help = JSON.parse((await run([skill, "--help"])).stdout!) as { commands: { command: string }[] };
      expect(help.commands.length).toBeGreaterThan(4);
      for (const c of help.commands) expect(GUIDE, `${c.command} is missing from the reference`).toContain(`## treasury ${c.command}`);
    }
  });

  it("it adds no rule of its own: undoing the script's few rewrites gives back the skill's body exactly", () => {
    let body = GUIDE.slice(GUIDE.indexOf("# The earn skill") + "# The earn skill".length, GUIDE.indexOf("# Command reference")).trim();
    for (const [from, to] of EDITS) {
      expect(body.split(to).length - 1, `the rewrite to ${JSON.stringify(to.slice(0, 40))} is not in the guide exactly once`).toBe(1);
      body = body.replace(to, () => from);
    }
    const skillBody = SKILL.slice(SKILL.indexOf("\n---\n", 4) + 5).trim();
    expect(body).toBe(skillBody);
  });

  it("the same skill checked out with \\r\\n line ends (Windows, core.autocrlf) gives the same guide text", () => {
    // Run on every OS: the CRLF copy is made here, so this does not depend on how the runner checked out.
    const crlf = SKILL.replace(/\n/g, "\r\n");
    expect(crlf.startsWith("---\r\n")).toBe(true);
    expect(generatedSkillBody(crlf)).toBe(generatedSkillBody(SKILL));
  });

  it("the check reads a \\r\\n checkout of llms.txt as current, and a changed one as stale", async () => {
    const want = await expectedGuide();
    expect(isCurrent(GUIDE.replace(/\n/g, "\r\n"), want)).toBe(true);
    expect(isCurrent(`${GUIDE}x`, want)).toBe(false);
  });

  it("it points at this version: the URL is the release tag's copy, and npx runs the same version", () => {
    const version = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string }).version;
    expect(GUIDE_URL).toBe(`https://raw.githubusercontent.com/TemporaLabs/treasury/v${version}/llms.txt`);
    expect(GUIDE).toContain(GUIDE_URL);
    expect(GUIDE).toContain(`npx @temporalabs/treasury@${version} `);
    expect(GUIDE).not.toMatch(/npx @temporalabs\/treasury[^@]/);
  });

  it("it is for an agent without the plugin: no launch line that only the plugin can run", () => {
    expect(GUIDE).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(GUIDE).toContain("treasury earn <command> --flag value");
  });
});

describe("--help names the guide", () => {
  it("at the top level and on each skill's command list", async () => {
    const top = JSON.parse((await run(["--help"])).stdout!) as { guide: { read_first: string; url: string } };
    expect(top.guide.url).toBe(GUIDE_URL);
    expect(top.guide.read_first).toMatch(/^Read the guide before you run any command/);
    for (const skill of ["earn", "connect"]) {
      const help = JSON.parse((await run([skill, "--help"])).stdout!) as { guide: { url: string } };
      expect(help.guide.url, `${skill} --help`).toBe(GUIDE_URL);
    }
  });

  it("the committed bundle names the file beside it when it exists, and only the URL when it does not", () => {
    const inPlace = JSON.parse(bundle(pkgRoot, [BUNDLE, "--help"]).stdout) as { guide: { file?: string; url: string } };
    expect(inPlace.guide.file).toBe(join(pkgRoot, "llms.txt"));
    // Alone in a bare folder there is no llms.txt beside it: the pointer must not name a file that is not there.
    const root = mkdtempSync(join(tmpdir(), "treasury-guide-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    copyFileSync(BUNDLE, join(root, "dist/treasury.mjs"));
    const alone = JSON.parse(bundle(root, [join(root, "dist/treasury.mjs"), "earn", "--help"]).stdout) as { guide: { file?: string; url: string } };
    expect(alone.guide.file).toBeUndefined();
    expect(alone.guide.url).toBe(GUIDE_URL);
  });

  it("the plugin's copy carries no pointer: its Earn skill is the guide and is already loaded", () => {
    const plugin = join(pkgRoot, "plugin/dist/treasury.mjs");
    for (const args of [["--help"], ["earn", "--help"], ["connect", "--help"]]) {
      const doc = JSON.parse(bundle(pkgRoot, [plugin, ...args]).stdout) as Record<string, unknown>;
      expect(doc, `plugin ${args.join(" ")}`).not.toHaveProperty("guide");
      expect(doc).toHaveProperty("version");
    }
    // The rule is the plugin folder's own manifest beside the CLI's parent, for either host.
    for (const host of [".claude-plugin", ".codex-plugin"]) {
      const root = mkdtempSync(join(tmpdir(), "treasury-guide-plugin-"));
      roots.push(root);
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, host));
      writeFileSync(join(root, host, "plugin.json"), "{}");
      copyFileSync(BUNDLE, join(root, "dist/treasury.mjs"));
      expect(JSON.parse(bundle(root, [join(root, "dist/treasury.mjs"), "--help"]).stdout), host).not.toHaveProperty("guide");
    }
  });
});
