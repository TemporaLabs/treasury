/**
 * The pointer from `treasury --help` to the guide, `llms.txt`.
 *
 * An agent that runs the CLI without the plugin never sees the rules in the earn skill (ask which chain,
 * show the full terms before a first deposit, post the acknowledgement word for word). A guide that is
 * only in the package or the README is not found: measured on 0.1.2, agents read it 0 times in 9 when it
 * was merely there and 9 times in 9 when `--help` named it. So `--help` names it, here, on the top level
 * and on each skill's command list.
 *
 * Not from the plugin: its Earn skill is the same text and is already loaded, and a pointer there would send
 * every plugin user to re-read it. The plugin folder is recognised by the manifest that sits at its root.
 *
 * `llms.txt` is generated from the skill and the command descriptions by `scripts/llms-txt.ts`, and CI
 * fails when the committed file differs.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The stable public copy: the file on the default branch. */
export const GUIDE_URL = "https://raw.githubusercontent.com/TemporaLabs/treasury/main/llms.txt";

/** The folder above this module: the package root for dist/treasury.mjs, plugin/ for the plugin's copy. */
function root(): string | undefined {
  try {
    return resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..");
  } catch {
    return undefined;
  }
}

/**
 * The `guide` field of the top-level and per-skill `--help`; undefined when this is the plugin's copy.
 * Only the existence of `llms.txt` beside the CLI is checked, to name its path; nothing in the CLI reads it.
 */
export function guidePointer(): { read_first: string; file?: string; url: string } | undefined {
  const base = root();
  if (base !== undefined && (existsSync(resolve(base, ".claude-plugin/plugin.json")) || existsSync(resolve(base, ".codex-plugin/plugin.json")))) return undefined;
  const file = base !== undefined && existsSync(resolve(base, "llms.txt")) ? resolve(base, "llms.txt") : undefined;
  return {
    read_first: `Read the guide before you run any command: it carries the rules for using treasury safely (which questions to ask the operator, what to show before a first deposit, what to post word for word). ${file ? `It is the file at "file" below, or at "url".` : `It is at "url".`}`,
    ...(file ? { file } : {}),
    url: GUIDE_URL,
  };
}
