/**
 * Agent Treasury — the command line. `treasury earn <command> [--flag value …]`, one JSON document on
 * stdout per run.
 *
 * Headless on purpose: an agent with a shell runs this with `node` and reads the JSON, and nothing
 * stays running between calls. The commands themselves live in `earn/commands.ts`; this file only
 * turns argv into their arguments, validates them against each command's own schema, and prints.
 *
 *   treasury earn --help                 every command, its flags and its description, as JSON
 *   treasury earn quote --direction deposit --account 0x… --amount_usdc 25 --chain base
 *   treasury --version
 *
 * Flags are the command's argument names. `--amount-usdc` is accepted for `--amount_usdc`, and
 * `prepare-deposit` for `prepare_deposit`, because both spellings get typed.
 *
 * Exit status: 0 with the result on stdout; 1 with `{ "error": … }` on stderr. A refusal from a
 * command (a vault on another chain, an unknown flag, a malformed address) is an error, never a
 * result, so a caller cannot read a refusal as an answer.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { buildCommands, type Command } from "./earn/commands.js";
import { redactEndpoints } from "./redact.js";
import { PACKAGE_VERSION } from "./version.js";

/** The skills this CLI carries. Each is a word on the command line and the prefix of its commands' names. */
const SKILLS = ["earn"] as const;

type Kind = "string" | "number" | "boolean";

/** The JSON type a flag's schema finally checks, looking through `optional`, `default` and refine/transform pipes. */
function kindOf(schema: z.ZodType): Kind {
  let s: z.ZodType = schema;
  for (;;) {
    const def = (s as unknown as { def: { type: string; innerType?: z.ZodType; in?: z.ZodType } }).def;
    if ((def.type === "optional" || def.type === "default" || def.type === "nullable") && def.innerType) s = def.innerType;
    else if (def.type === "pipe" && def.in) s = def.in;
    else return def.type === "number" ? "number" : def.type === "boolean" ? "boolean" : "string";
  }
}

const isOptional = (schema: z.ZodType): boolean => schema.safeParse(undefined).success;

/** What `--help` prints for one command. */
function describe(skill: string, name: string, c: Command) {
  return {
    command: `${skill} ${name.slice(skill.length + 1)}`,
    tool: name,
    title: c.title,
    description: c.description,
    flags: Object.entries(c.inputSchema.shape).map(([flag, schema]) => ({
      flag: `--${flag}`,
      type: kindOf(schema as z.ZodType),
      required: !isOptional(schema as z.ZodType),
      ...((schema as z.ZodType).description ? { description: (schema as z.ZodType).description } : {}),
    })),
  };
}

class UsageError extends Error {}

/** argv after the command word → the command's arguments, checked against its own schema. */
function parseFlags(c: Command, argv: string[]): Record<string, unknown> {
  const shape = c.inputSchema.shape as Record<string, z.ZodType>;
  const options: Record<string, { type: "string" | "boolean" }> = {};
  const canonical: Record<string, string> = {};
  for (const [name, schema] of Object.entries(shape)) {
    const type = kindOf(schema) === "boolean" ? "boolean" : "string";
    for (const spelling of new Set([name, name.replaceAll("_", "-")])) {
      options[spelling] = { type };
      canonical[spelling] = name;
    }
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false }) as { values: Record<string, string | boolean | undefined> });
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}. Flags for this command: ${Object.keys(shape).map((f) => `--${f}`).join(", ") || "none"}`);
  }
  const args: Record<string, unknown> = {};
  for (const [spelling, raw] of Object.entries(values)) {
    if (raw === undefined) continue;
    const name = canonical[spelling]!;
    if (name in args) throw new UsageError(`--${name} was given twice`);
    const kind = kindOf(shape[name]!);
    if (kind === "number") {
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new UsageError(`--${name} takes a whole number, got ${JSON.stringify(raw)}`);
      args[name] = Number(raw);
    } else {
      args[name] = raw;
    }
  }
  const parsed = c.inputSchema.strict().safeParse(args);
  if (!parsed.success) {
    throw new UsageError(parsed.error.issues.map((i) => `--${i.path.join(".") || "?"}: ${i.message}`).join("; "));
  }
  return parsed.data as Record<string, unknown>;
}

/** Runs one invocation. Returns what to print and the exit status; never calls `process.exit` itself, so tests can drive it. */
export async function run(argv: string[]): Promise<{ stdout?: string; stderr?: string; code: 0 | 1 }> {
  const fail = (message: string) => ({ stderr: JSON.stringify({ error: message }, null, 2), code: 1 as const });
  const [first, second, ...rest] = argv;
  if (first === "--version" || first === "-v") return { stdout: PACKAGE_VERSION, code: 0 };
  if (first === undefined || first === "--help" || first === "-h") {
    return { stdout: JSON.stringify({ usage: "treasury <skill> <command> [--flag value …]", version: PACKAGE_VERSION, skills: [...SKILLS] }, null, 2), code: 0 };
  }
  const skill = SKILLS.find((s) => s === first);
  if (!skill) return fail(`unknown skill ${JSON.stringify(first)}; this CLI carries: ${SKILLS.join(", ")}`);

  let commands: Record<string, Command>;
  try {
    commands = buildCommands();
  } catch (e) {
    return fail(redactEndpoints(e instanceof Error ? e.message : String(e)));
  }
  const mine = Object.entries(commands).filter(([name]) => name.startsWith(`${skill}_`));
  if (second === undefined || second === "--help" || second === "-h") {
    return { stdout: JSON.stringify({ usage: `treasury ${skill} <command> [--flag value …]`, version: PACKAGE_VERSION, commands: mine.map(([n, c]) => describe(skill, n, c)) }, null, 2), code: 0 };
  }
  const name = `${skill}_${second.replaceAll("-", "_")}`;
  const command = commands[name];
  if (!command || !name.startsWith(`${skill}_`)) {
    return fail(`unknown command ${JSON.stringify(`${skill} ${second}`)}; commands: ${mine.map(([n]) => n.slice(skill.length + 1)).join(", ")}`);
  }
  if (rest.includes("--help") || rest.includes("-h")) return { stdout: JSON.stringify(describe(skill, name, command), null, 2), code: 0 };

  let args: Record<string, unknown>;
  try {
    args = parseFlags(command, rest);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  try {
    return { stdout: await command.handler(args as never), code: 0 };
  } catch (e) {
    // The handlers already mask endpoints (`guarded`); masked again here so nothing printed by this
    // file can carry a keyed RPC URL, whatever a future handler forgets.
    return fail(redactEndpoints(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * True only when THIS module is the file Node was asked to run. The comparison is by resolved path,
 * not by name: an earlier guard tested `process.argv[1]` against a filename pattern, which is the
 * basename of whatever was invoked — so the published bin (a symlink npm makes) never matched and
 * exited silently (#22), while any unrelated script with a matching name that merely imported this
 * module matched and ran. Node resolves the main module's symlink before evaluating it, so
 * `import.meta.url` is already the real path and the two sides agree for a bin. Anything
 * unresolvable is treated as "not the entry point": the module loads and does nothing.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2)).then(
    ({ stdout, stderr, code }) => {
      if (stdout !== undefined) process.stdout.write(`${stdout}\n`);
      if (stderr !== undefined) process.stderr.write(`${stderr}\n`);
      process.exitCode = code;
    },
    (e: unknown) => {
      // Defence-in-depth: `run` catches everything it calls, so this is reached only by a defect in
      // `run` itself. Masked anyway, so that stays true if `run` ever grows.
      process.stderr.write(`${JSON.stringify({ error: redactEndpoints(String(e)) })}\n`);
      process.exitCode = 1;
    },
  );
}
