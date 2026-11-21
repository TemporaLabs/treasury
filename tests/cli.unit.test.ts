import { describe, it, expect, afterEach, vi } from "vitest";
import { run } from "../src/cli.js";
import { buildCommands } from "../src/earn/commands.js";

/**
 * The command line is the only way the plugin reaches the earn commands, so its parsing is part of
 * the contract: a flag it drops, renames or coerces wrongly reaches a handler as a different call.
 * Every case here is offline: `earn terms --chain solana` reads only the registry, and every refusal
 * is decided before any RPC or API is touched (and the test setup points the API at a closed local port).
 */

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const error = (r: { stderr?: string }) => (JSON.parse(r.stderr ?? "{}") as { error?: string }).error ?? "";

describe("help and version", () => {
  it("--version prints the package version and nothing else", async () => {
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("`earn --help` lists one entry per command, keyed by its tool name, with its flags", async () => {
    const r = await run(["earn", "--help"]);
    expect(r.code).toBe(0);
    const help = JSON.parse(r.stdout!) as { commands: { command: string; tool: string; flags: { flag: string; required: boolean; type: string }[] }[] };
    // DERIVED from the commands, not written down: a ninth command must appear here the moment it exists.
    expect(help.commands.map((c) => c.tool).sort()).toEqual(Object.keys(buildCommands()).sort());
    const quote = help.commands.find((c) => c.tool === "earn_quote")!;
    expect(quote.command).toBe("earn quote");
    expect(quote.flags.find((f) => f.flag === "--direction")).toMatchObject({ required: true, type: "string" });
    expect(quote.flags.find((f) => f.flag === "--vault")).toMatchObject({ required: false });
    const balance = help.commands.find((c) => c.tool === "earn_balance")!;
    expect(balance.flags.find((f) => f.flag === "--account")).toMatchObject({ required: false, type: "string" });
    const withdraw = help.commands.find((c) => c.tool === "earn_prepare_withdraw")!;
    expect(withdraw.flags.find((f) => f.flag === "--all")).toMatchObject({ type: "boolean" });
  });
});

describe("the surface: three skills, a fixed set of commands, nothing that signs", () => {
  it("`treasury --help` lists exactly these skills — another is a reviewed change, not a quiet addition", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout!) as { skills: string[] }).skills).toEqual(["earn", "connect", "invest"]);
  });

  it("help repeats what each flag's schema will refuse: descriptions behind `.optional()`, enums, patterns, ranges, switches", async () => {
    const help = JSON.parse((await run(["earn", "--help"])).stdout!) as { commands: { tool: string; flags: Record<string, unknown>[] }[] };
    const flag = (tool: string, f: string) => help.commands.find((c) => c.tool === tool)!.flags.find((x) => x["flag"] === f)!;
    expect(flag("earn_status", "--account")["description"]).toMatch(/whose shares these are/);
    expect(flag("earn_quote", "--direction")["enum"]).toEqual(["deposit", "withdraw"]);
    expect(flag("earn_quote", "--amount_usdc")["pattern"]).toBeDefined();
    const connect = JSON.parse((await run(["connect", "--help"])).stdout!) as { commands: { tool: string; flags: Record<string, unknown>[] }[] };
    expect(connect.commands.find((c) => c.tool === "connect_deposit")!.flags.find((x) => x["flag"] === "--leg")!["exclusiveMinimum"]).toBe(0);
    expect(flag("earn_prepare_withdraw", "--all")).toMatchObject({ type: "boolean", takesValue: false });
  });
});

describe("refusals are errors with exit 1, never results", () => {
  it("an unknown skill", async () => {
    const r = await run(["savings", "vaults"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBeUndefined();
    expect(error(r)).toMatch(/unknown skill "savings"/);
  });

  it("an unknown command names the real ones", async () => {
    const r = await run(["earn", "transfer"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/unknown command "earn transfer".*vaults/);
  });

  it("an unknown flag is refused, not ignored — a dropped flag would be a different call", async () => {
    const r = await run(["earn", "prepare_deposit", "--account", ACCOUNT, "--receiver", ACCOUNT, "--amount_usdc", "1", "--reciever", ACCOUNT]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/Unknown option '--reciever'/);
  });

  it("a missing required flag names it", async () => {
    const r = await run(["earn", "submit", "--request_id", "req_1", "--step_id", "s1"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/--tx_hash/);
  });

  it("a flag given twice is refused rather than silently taking one — in the SAME spelling and across spellings", async () => {
    // The same spelling is the dangerous case: `--receiver A --receiver B` would otherwise build a call
    // that pays B while the operator read A first.
    const same = await run(["earn", "prepare_deposit", "--account", ACCOUNT, "--receiver", ACCOUNT, "--receiver", OTHER, "--amount_usdc", "1"]);
    expect(same.code).toBe(1);
    expect(same.stdout).toBeUndefined();
    expect(error(same)).toMatch(/--receiver was given twice/);
    const mixed = await run(["earn", "prepare_deposit", "--account", ACCOUNT, "--receiver", ACCOUNT, "--amount_usdc", "1", "--amount-usdc", "2"]);
    expect(mixed.code).toBe(1);
    expect(error(mixed)).toMatch(/--amount_usdc was given twice/);
    const flag = await run(["earn", "prepare_withdraw", "--account", ACCOUNT, "--receiver", ACCOUNT, "--all", "--all", "--shares_exact", "5"]);
    expect(flag.code).toBe(1);
    expect(error(flag)).toMatch(/--all was given twice/);
  });

  it("the command's own schema still decides: a malformed address and an off-list direction", async () => {
    const bad = await run(["earn", "prepare_deposit", "--account", "0x123", "--receiver", ACCOUNT, "--amount_usdc", "1"]);
    expect(bad.code).toBe(1);
    expect(error(bad)).toMatch(/--account: must be an EVM address/);
    const side = await run(["earn", "quote", "--direction", "sideways", "--account", ACCOUNT, "--amount_usdc", "1"]);
    expect(side.code).toBe(1);
    expect(error(side)).toMatch(/--direction/);
  });

  it("a number flag that is not a whole number", async () => {
    const r = await run(["connect", "deposit", "--amount_usdc", "1", "--receiver", ACCOUNT, "--leg", "1e9"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/--leg takes a whole number/);
  });

  it("a number flag reaches the schema AS A NUMBER: an out-of-range value is refused for its range, not its type", async () => {
    // `leg` is above zero. Refused for being too small proves "0" became 0; refused as "expected number,
    // received string" would mean the coercion was skipped. Decided before anything is opened or read.
    const r = await run(["connect", "deposit", "--amount_usdc", "1", "--receiver", ACCOUNT, "--leg", "0"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/--leg: Too small/);
    expect(error(r)).not.toMatch(/received string/);
  });

  it("a switch given a value says it is a switch", async () => {
    const r = await run(["earn", "prepare_withdraw", "--account", ACCOUNT, "--receiver", ACCOUNT, "--all", "true", "--shares_exact", "5"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/--all is a switch: give it for true, leave it out for false/);
    expect(error(r)).not.toMatch(/\.\./);
  });

  it("a withdrawal given both an amount and --all, or --shares_exact without --all, is refused rather than half-read", async () => {
    const both = await run(["earn", "prepare_withdraw", "--account", ACCOUNT, "--all", "--shares_exact", "5", "--amount_usdc", "1"]);
    expect(both.code).toBe(1);
    expect(error(both)).toMatch(/give exactly one of --amount_usdc, --all or --shares_exact, not --amount_usdc and --all and --shares_exact/);
    const stray = await run(["earn", "prepare_withdraw", "--account", ACCOUNT, "--amount_usdc", "1", "--shares_exact", "3"]);
    expect(stray.code).toBe(1);
    expect(error(stray)).toMatch(/not --amount_usdc and --shares_exact/);
  });

  it("`--help` after the flags is refused, and the error says where help goes", async () => {
    const r = await run(["earn", "quote", "--direction", "deposit", "--help"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/put --help right after the command/);
  });

  it("`--help` in a flag's value position is a missing value, not a request for help", async () => {
    const r = await run(["earn", "prepare_deposit", "--account", ACCOUNT, "--amount_usdc", "1", "--receiver", "--help"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBeUndefined();
  });

  it("a handler's refusal (a chain it does not know) reaches stderr with exit 1", async () => {
    const r = await run(["earn", "prepare_deposit", "--chain", "optimism", "--account", ACCOUNT, "--amount_usdc", "1"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBeUndefined();
    expect(error(r)).toMatch(/unknown chain "optimism"/);
  });
});

describe("a valid call reaches the handler as the same call", () => {
  it("both spellings of a command and a flag reach the handler as the same call", async () => {
    // Offline: with no wallet connected, the handler answers both with the same refusal, after the schema took every
    // flag in both spellings. (The envelope a prepare command returns is the Tempora API's request, asserted against a
    // stand-in in tests/earn-api.unit.test.ts.)
    const sha = `0x${"ab".repeat(32)}`;
    const a = await run(["earn", "prepare_deposit", "--account", ACCOUNT, "--amount_usdc", "1", "--terms_sha256", sha]);
    const b = await run(["earn", "prepare-deposit", "--account", ACCOUNT, "--amount-usdc", "1", "--terms-sha256", sha]);
    expect(a.code).toBe(1);
    expect(error(a)).toMatch(/no wallet is connected/);
    expect(b).toEqual(a);
  });

  it("a boolean flag takes no value: `--all` reaches the handler as true", async () => {
    // Read as true, it is a second withdrawal form beside --shares_exact, and the handler names both.
    const r = await run(["earn", "prepare_withdraw", "--account", ACCOUNT, "--all", "--shares_exact", "5"]);
    expect(r.code).toBe(1);
    expect(error(r)).toMatch(/not --all and --shares_exact/);
  });

  it("the CLI prints exactly what the command returns — no wrapper around the JSON", async () => {
    const viaCli = await run(["earn", "terms", "--chain", "solana"]);
    const direct = await (buildCommands()["earn_terms"]!.handler as (a: object) => Promise<string>)({ chain: "solana" });
    expect(viaCli.stdout).toBe(direct);
  });
});

describe("nothing this file prints carries a keyed RPC URL — usage errors included", () => {
  const KEY = "SECRETKEYabc123def456";
  const URL_WITH_KEY = `https://base-mainnet.example-provider.io/v2/${KEY}`;
  afterEach(() => {
    delete process.env["TREASURY_RPC_BASE"];
  });

  it("the key is masked wherever the typed text is echoed back", async () => {
    process.env["TREASURY_RPC_BASE"] = URL_WITH_KEY;
    const cases = [
      [URL_WITH_KEY], // as the skill
      ["earn", URL_WITH_KEY], // as the command
      ["earn", "balance", "--account", ACCOUNT, `--${URL_WITH_KEY}`], // as an unknown flag
      ["connect", "deposit", "--leg", URL_WITH_KEY], // as a number flag's value
      // The bare key, with no URL around it for a shape rule to match: only the configured value,
      // registered before anything prints, can mask this one.
      ["connect", "deposit", "--leg", KEY],
      [KEY],
    ];
    for (const argv of cases) {
      // A FRESH module per case, as each real run is a fresh process: secrets registered by an earlier
      // test (any `buildCommands()` call registers them) must not be what masks this one.
      vi.resetModules();
      const { run: freshRun } = await import("../src/cli.js");
      const r = await freshRun(argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.stderr, argv.join(" ")).not.toContain(KEY);
    }
  });
});
