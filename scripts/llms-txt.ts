/**
 * llms.txt, generated from the earn skill and the CLI's own command descriptions.
 *
 *   npx tsx scripts/llms-txt.ts --write   # regenerate (run by `npm run build`)
 *   npx tsx scripts/llms-txt.ts           # exit 1 if the committed file is stale
 *
 * The guide is for an agent that runs `treasury` without the plugin. It must say what the skill says and
 * add no rule of its own, so it is built, never edited: the body of `plugin/skills/earn/SKILL.md`, then every
 * command with its flags exactly as `treasury <skill> --help` prints them. The only changes made to the skill's
 * text swap the plugin's launch line for the plain command and drop the sentences that are about the plugin's
 * permission prompt; each is an exact match, so a rewording of the skill stops this script until it is looked at.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../src/cli.js";
import { GUIDE_URL } from "../src/guide.js";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(pkgDir, "plugin/skills/earn/SKILL.md");
const OUT = resolve(pkgDir, "llms.txt");

const LAUNCH = 'node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs"';

/** [exact text in the skill, replacement]. Every one must match exactly once. */
export const EDITS: [string, string][] = [
  // The plugin's launch line becomes the command an installed package puts on PATH.
  [`${LAUNCH} earn <command> --flag value …\n${LAUNCH} connect <command> --flag value …`, "treasury earn <command> --flag value …\ntreasury connect <command> --flag value …"],
  [`${LAUNCH} connect deposit`, "treasury connect deposit"],
  ["The\nbundled `treasury` CLI gives you", "The\n`treasury` CLI gives you"],
  // The plugin pre-approves one exact command shape; outside the plugin there is no such prompt to avoid.
  [
    "Run exactly that, one plain command per shell call — no `cd`, no variables, no `&&` or `;` chains. That\nform is pre-approved; anything wrapped around it asks the operator for permission instead. When unsure of\na command's flags,",
    "Run one plain command per shell call. When unsure of\na command's flags,",
  ],
];

interface Flag { flag: string; type: string; required: boolean; takesValue?: boolean; [k: string]: unknown }
interface Cmd { command: string; title: string; description: string; flags: Flag[] }

/** A checkout with `core.autocrlf` (Windows) has `\r\n` line ends; every comparison here is on `\n`. */
const lf = (s: string): string => s.replace(/\r\n/g, "\n");

export function skillBody(raw: string = readFileSync(SKILL, "utf8")): string {
  let text = lf(raw);
  const end = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || end < 0) throw new Error("plugin/skills/earn/SKILL.md has no frontmatter to strip");
  text = text.slice(end + 5).replace(/^\n+/, "");
  for (const [from, to] of EDITS) {
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`the skill no longer contains exactly one copy of the text this script rewrites (${n} found): ${JSON.stringify(from.slice(0, 70))}. Update scripts/llms-txt.ts to match the skill.`);
    text = text.replace(from, () => to);
  }
  if (text.includes("CLAUDE_PLUGIN_ROOT")) throw new Error("the skill still names CLAUDE_PLUGIN_ROOT after the rewrites: add the missing edit to scripts/llms-txt.ts");
  return text.trimEnd();
}

async function commands(skill: string): Promise<Cmd[]> {
  const r = await run([skill, "--help"]);
  if (r.code !== 0 || !r.stdout) throw new Error(`treasury ${skill} --help failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { commands: Cmd[] }).commands;
}

function flagLine(f: Flag): string {
  const { flag, type, required, takesValue, ...rest } = f;
  const extra = Object.entries(rest).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `- \`${flag}\` (${type === "boolean" || takesValue === false ? "a switch, no value" : type}${required ? ", required" : ", optional"}${extra.length ? `; ${extra.join("; ")}` : ""})`;
}

export async function expectedGuide(): Promise<string> {
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as { description: string };
  const out: string[] = [
    "# Treasury",
    "",
    `> ${pkg.description}`,
    "",
    "This file is generated from the earn skill and from the command descriptions `treasury --help` prints; it is not edited by hand.",
    `Its stable address is ${GUIDE_URL}.`,
    "Run commands as `treasury <skill> <command> [--flag value …]` (`npx @temporalabs/treasury …` runs the same CLI without installing it). Each prints one JSON document.",
    "",
    "# The earn skill",
    "",
    skillBody(),
    "",
    "# Command reference",
    "",
    "Every command and flag, as `treasury earn --help` and `treasury connect --help` print them.",
  ];
  for (const skill of ["earn", "connect"]) {
    for (const c of await commands(skill)) {
      out.push("", `## treasury ${c.command}`, "", `**${c.title}.** ${c.description}`, "", ...(c.flags.length ? ["Flags:", ...c.flags.map(flagLine)] : ["No flags."]));
    }
  }
  return `${out.join("\n")}\n`;
}

async function main(): Promise<void> {
  const want = await expectedGuide();
  if (process.argv.includes("--write")) {
    writeFileSync(OUT, want);
    console.log("✓ llms.txt written");
    return;
  }
  let have = "";
  try {
    have = lf(readFileSync(OUT, "utf8"));
  } catch {
    /* missing is stale */
  }
  if (have !== want) {
    console.log("✗ llms.txt is stale: run npx tsx scripts/llms-txt.ts --write");
    process.exit(1);
  }
  console.log("✓ llms.txt matches the skill and the command descriptions");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
