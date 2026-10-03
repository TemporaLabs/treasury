/**
 * Agent Treasury — the command line. `treasury earn <command> [--flag value …]`; every command prints
 * one JSON document on stdout (`--version` prints the bare version).
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
 * Exit status: 0 with the result on stdout; 1 with `{ "error": … }` on stderr when the command could not
 * run as asked (a vault on another chain, an unknown or repeated flag, a malformed address, an
 * unreachable RPC on a read that needs it) — never a result, so a caller cannot read it as an answer. A
 * VERDICT is a result: `earn status` reporting `WHITELIST_GATED` or `rpc: "wrong_chain"` exits 0, and
 * its fields say what it found. A switch (`--all`) takes no value.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { buildCommands, type Command } from "./earn/commands.js";
import { resolvedRpcSecrets } from "./client.js";
import { redactEndpoints, registerSecretSource } from "./redact.js";
import { PACKAGE_VERSION } from "./version.js";

/**
 * The skills this CLI carries: a word on the command line, and the commands it opens. A command's name
 * starts with its skill's word (`earn_quote`), and only that skill's builder is ever consulted for it.
 */
const SKILLS: Record<string, () => Record<string, Command>> = { earn: buildCommands };

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

/** The constraints `--help` repeats from each flag's JSON Schema, so a caller sees what the schema will refuse. */
const SCHEMA_KEYS = ["description", "enum", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;

/** What `--help` prints for one command. */
function describe(skill: string, name: string, c: Command) {
  // The JSON Schema carries what the zod objects hide behind wrappers: a description set before
  // `.optional()`, an enum, a pattern, a range. Read in INPUT mode, so a transform describes what it accepts.
  // `unrepresentable: "any"`: a type JSON Schema cannot express must not take `--help` down with it.
  const props = ((z.toJSONSchema(c.inputSchema, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, Record<string, unknown>> }).properties ?? {});
  return {
    command: `${skill} ${name.slice(skill.length + 1)}`,
    tool: name,
    title: c.title,
    description: c.description,
    flags: Object.entries(c.inputSchema.shape).map(([flag, schema]) => {
      const kind = kindOf(schema as z.ZodType);
      const js = props[flag] ?? {};
      return {
        flag: `--${flag}`,
        type: kind,
        required: !isOptional(schema as z.ZodType),
        ...(kind === "boolean" ? { takesValue: false } : {}),
        ...Object.fromEntries(SCHEMA_KEYS.filter((k) => js[k] !== undefined).map((k) => [k, js[k]])),
      };
    }),
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
  const switches = Object.keys(shape).filter((n) => kindOf(shape[n]!) === "boolean");
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; options: typeof options; strict: true; allowPositionals: false; tokens: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true });
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).replace(/\.+$/, "");
    const hint = switches.length ? ` ${switches.map((n) => `--${n}`).join(", ")} ${switches.length === 1 ? "is a switch" : "are switches"}: give it for true, leave it out for false.` : "";
    const help = argv.includes("--help") || argv.includes("-h") ? " For help, put --help right after the command." : "";
    throw new UsageError(`${why}. Flags for this command: ${Object.keys(shape).map((f) => `--${f}`).join(", ") || "none"}.${hint}${help}`);
  }
  // 🔴 Repeats are read from the TOKENS, not from `values`. `parseArgs` keeps only the LAST value of a
  // repeated option and keys `values` by spelling, so `--receiver A --receiver B` would otherwise
  // arrive as `receiver: B` with nothing to say A was ever typed — a different call than the one read.
  const seen = new Set<string>();
  for (const t of parsed.tokens ?? []) {
    if (t.kind !== "option") continue;
    const name = canonical[t.name]!;
    if (seen.has(name)) throw new UsageError(`--${name} was given twice`);
    seen.add(name);
  }
  const args: Record<string, unknown> = {};
  for (const [spelling, raw] of Object.entries(parsed.values as Record<string, string | boolean | undefined>)) {
    if (raw === undefined) continue;
    const name = canonical[spelling]!;
    const kind = kindOf(shape[name]!);
    if (kind === "number") {
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new UsageError(`--${name} takes a whole number, got ${JSON.stringify(raw)}`);
      args[name] = Number(raw);
    } else {
      args[name] = raw;
    }
  }
  const checked = c.inputSchema.strict().safeParse(args);
  if (!checked.success) {
    throw new UsageError(checked.error.issues.map((i) => `--${i.path.join(".") || "?"}: ${i.message}`).join("; "));
  }
  return checked.data as Record<string, unknown>;
}

/** Runs one invocation. Returns what to print and the exit status; never calls `process.exit` itself, so tests can drive it. */
export async function run(argv: string[]): Promise<{ stdout?: string; stderr?: string; code: 0 | 1 }> {
  // Registered before anything can be printed: a usage error echoes what was typed, and what was typed
  // can be a keyed RPC URL. Every error below goes through `redactEndpoints`, so none can print it.
  registerSecretSource(resolvedRpcSecrets);
  const fail = (message: string) => ({ stderr: JSON.stringify({ error: redactEndpoints(message) }, null, 2), code: 1 as const });
  const [first, second, ...rest] = argv;
  if (first === "--version" || first === "-v") return { stdout: PACKAGE_VERSION, code: 0 };
  if (first === undefined || first === "--help" || first === "-h") {
    return { stdout: JSON.stringify({ usage: "treasury <skill> <command> [--flag value …]", version: PACKAGE_VERSION, skills: Object.keys(SKILLS) }, null, 2), code: 0 };
  }
  const build = Object.hasOwn(SKILLS, first) ? SKILLS[first] : undefined;
  if (!build) return fail(`unknown skill ${JSON.stringify(first)}; this CLI carries: ${Object.keys(SKILLS).join(", ")}`);
  const skill = first;

  let commands: Record<string, Command>;
  try {
    commands = build();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const mine = Object.entries(commands).filter(([name]) => name.startsWith(`${skill}_`));
  if (second === undefined || second === "--help" || second === "-h") {
    return { stdout: JSON.stringify({ usage: `treasury ${skill} <command> [--flag value …]`, version: PACKAGE_VERSION, commands: mine.map(([n, c]) => describe(skill, n, c)) }, null, 2), code: 0 };
  }
  const name = `${skill}_${second.replaceAll("-", "_")}`;
  // Own keys only: `commands` is a plain object, so `earn constructor` must not reach anything inherited.
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) {
    return fail(`unknown command ${JSON.stringify(`${skill} ${second}`)}; commands: ${mine.map(([n]) => n.slice(skill.length + 1)).join(", ")}`);
  }
  // Help only when asked for in place of the flags — `--receiver --help` is a missing value, not a request for help.
  if (rest[0] === "--help" || rest[0] === "-h") return { stdout: JSON.stringify(describe(skill, name, command), null, 2), code: 0 };

  let args: Record<string, unknown>;
  try {
    args = parseFlags(command, rest);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  try {
    return { stdout: await command.handler(args as never), code: 0 };
  } catch (e) {
    // The handlers already mask endpoints (`guarded`); `fail` masks again so nothing printed by this
    // file can carry a keyed RPC URL, whatever a future handler forgets.
    return fail(e instanceof Error ? e.message : String(e));
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
      // Exit as soon as the answer is written. A read that lost a race (the chain-id probe beside a
      // slow endpoint) can leave a request timer running for seconds after the answer exists, and
      // the agent's shell call would wait it out. The callbacks wait for each stream to flush first.
      const out = stdout === undefined ? Promise.resolve() : new Promise<void>((done) => process.stdout.write(`${stdout}\n`, () => done()));
      const err = stderr === undefined ? Promise.resolve() : new Promise<void>((done) => process.stderr.write(`${stderr}\n`, () => done()));
      void Promise.all([out, err]).then(() => process.exit(code));
    },
    (e: unknown) => {
      // Defence-in-depth: `run` catches everything it calls, so this is reached only by a defect in
      // `run` itself. Masked anyway, so that stays true if `run` ever grows.
      process.stderr.write(`${JSON.stringify({ error: redactEndpoints(String(e)) })}\n`, () => process.exit(1));
    },
  );
}
