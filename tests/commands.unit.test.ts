/**
 * Unit — the command surface itself. A tool rename and the `account` normalisation
 * touch only this boundary, and the boundary is exactly the layer no existing test covered: the
 * library tests call `buildWithdraw`/`getPosition` directly and never go through a handler.
 *
 * These assert the CONTRACT, not the mechanism: the exact tool set, the exact input properties
 * (so a leftover `depositor` is a failure rather than a tolerated extra key), the unsigned
 * envelope's shape, `direction` echoed on the output, and `earn_status`'s three modes.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import type { McpClient } from "@temporalabs/client/mcp";
import { buildCommands } from "../src/earn/commands.js";
import { EARN } from "../src/config/earn.js";
import { readFileSync } from "node:fs";
import { useFixtureRegistry, useShippedRegistry } from "./fixtures/registry.js";

// The unit tiers exercise code paths (18-decimal shares, an open vault) that the shipped
// registry does not offer; `fixtures/registry.ts` explains why they are synthetic.
beforeAll(() => useFixtureRegistry());
afterAll(() => useShippedRegistry());

type Handler = (a: unknown, extra: unknown) => Promise<string>;
type Registered = Record<string, { handler: Handler; inputSchema?: { shape?: Record<string, unknown> } }>;

const tools = () => (buildCommands() as unknown as Registered);
const payload = (r: string) => JSON.parse(r);

const ACCOUNT = EARN.fixtures.stranger;
const RECEIVER = "0x1111111111111111111111111111111111111111" as const;
const OWNER = "0x2222222222222222222222222222222222222222" as const;

const NINE = [
  "earn_balance",
  "earn_prepare_deposit",
  "earn_prepare_withdraw",
  "earn_quote",
  "earn_request",
  "earn_status",
  "earn_submit",
  "earn_terms",
  "earn_vaults",
];

describe("tool surface", () => {
  it("registers EXACTLY these nine names — no more, no fewer, none renamed", () => {
    expect(Object.keys(tools()).sort()).toEqual(NINE);
  });

  it("exposes no signing or sending tool", () => {
    for (const n of Object.keys(tools())) expect(n).not.toMatch(/sign|send|transfer/i);
  });

  it("every address argument is `account` — no depositor, owner or principal survives", () => {
    const t = tools();
    const props = (n: string) => Object.keys(t[n]!.inputSchema?.shape ?? {}).sort();
    // exact property sets, so a leftover old name fails instead of passing as an extra key
    // every tool that takes `vault` takes `chain` beside it — and the three that take no vault do not
    expect(props("earn_quote")).toEqual(["account", "amount_usdc", "chain", "direction", "vault"]);
    expect(props("earn_status")).toEqual(["account", "amount_usdc", "chain", "vault"]);
    expect(props("earn_balance")).toEqual(["account", "chain", "vault"]);
    // `receiver` is taken on Solana only (refused for an EVM vault), and stays distinct from `account` there
    expect(props("earn_prepare_deposit")).toEqual(["account", "amount_usdc", "chain", "receiver", "terms_sha256", "vault"]);
    expect(props("earn_prepare_withdraw")).toEqual(["account", "all", "amount_usdc", "chain", "receiver", "shares_exact", "vault"]);
    for (const n of Object.keys(t)) expect(props(n).includes("chain"), `${n}: chain and vault travel together`).toBe(props(n).includes("vault"));
    expect(props("earn_vaults")).toEqual([]);
    expect(props("earn_terms")).toEqual(["chain", "vault"]);
    expect(props("earn_submit")).toEqual(["block", "from", "nonce", "request_id", "step_id", "tx_hash"]);
    expect(props("earn_request")).toEqual(["cancel", "request_id", "tx_hash"]);
    const all = Object.keys(t).flatMap(props);
    expect(all).not.toContain("depositor");
    expect(all).not.toContain("principal");
    expect(all).not.toContain("owner");
  });
});

// A prepared step's chain and contracts are the Tempora API's, checked by `checkSteps` against the vault it lists:
// `tests/earn-api.unit.test.ts`. What stays here is what the descriptions tell an agent about choosing a chain.
describe("the descriptions tell an agent to ask which chain", () => {
  it("the tool descriptions tell the agent to ask which chain, where it decides to prepare a deposit", () => {
    const d = (n: string) => (tools()[n] as unknown as { description: string }).description;
    expect(d("earn_vaults")).toMatch(/`chains`.*ASK before preparing a deposit/s);
    expect(d("earn_prepare_deposit")).toMatch(/if they have not chosen one, ask before calling this/);
    const chainProp = (tools()["earn_prepare_deposit"]!.inputSchema!.shape!["chain"] as { description?: string }).description ?? "";
    expect(chainProp).toMatch(/"base" or "arbitrum"/);
    expect(chainProp).toMatch(/ASK them before preparing a deposit/);
  });
});

/**
 * The warning has to reach the caller AT THE POINT OF USE, not only at discovery — and it has to
 * KEEP reaching it.
 *
 * It shipped on `earn_vaults` alone, a discovery call, while its own text says to show it before
 * preparing a deposit. The repair put it on three money-committing responses; two of those three
 * were then unguarded, and deleting the field from them left the whole suite green. A test per call
 * site would only guard the sites someone remembered to write one for — the same defect one level
 * up — so the attachment is a single helper in the source and the first test below pins it there.
 */
describe("the test-vault warning travels with money-committing responses, and only those", () => {
  /**
   * The structural one. `commitsMoney` is the only thing that may write a `warning` field onto a
   * response, `earn_vaults`'s per-row listing aside — so a fourth money-committing tool either goes
   * through the chokepoint and is disclosed for free, or hand-rolls the field and fails here.
   */
  it("only the chokepoint and the vault listing write a warning field", () => {
    // `warnings` is the API's list for a vault it serves, `warning` the registry's sentence for one it does not:
    // the same disclosure, through the same chokepoint.
    const src = readFileSync(new URL("../src/earn/commands.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const writers = src.split("\n").filter((l) => /\bwarnings?:/.test(l)).map((l) => l.trim());
    expect(writers).toEqual([
      "const commitsMoney = (vault: Pick<VaultEntry, \"warning\"> | Pick<Product, \"warnings\">) => (\"warnings\" in vault ? { warnings: vault.warnings } : { warning: vault.warning });",
      "warnings: p.warnings,",
    ]);
  });

  it("the Solana handlers write no warning field of their own beyond the vault listing: theirs goes through the same chokepoint", () => {
    const src = readFileSync(new URL("../src/earn/solana.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src.split("\n").filter((l) => /\bwarning:/.test(l)).map((l) => l.trim())).toEqual(["warning: v.warning,"]);
  });

  // `earn_status` with an account, `earn_quote` on the deposit side and `earn_prepare_deposit` (before `next_step`)
  // carry it too, and a withdrawal quote or envelope does not: they go through the Tempora API now, and
  // `tests/earn-api.unit.test.ts` asserts each against its stand-in.
});

describe("earn_status", () => {
  // No unit test may touch the real network: health here reads a stand-in for the Tempora API that cannot be reached,
  // so the health path exercises its FAILURE branch. `tests/earn-api.unit.test.ts` has the rest.
  const unreachable = new Proxy({} as McpClient, {
    get: () => async () => ({ ok: false, status: 0, error: { code: "network_error", message: "no answer", outcome: "failed" } }),
  });
  const health = async (args: Record<string, unknown>) =>
    payload(await (buildCommands({ mcp: unreachable }) as unknown as Registered)["earn_status"]!.handler(args, {}));

  it("no arguments → mode health, and an API that cannot be reached is a verdict, not a throw", async () => {
    const out = await health({});
    expect(out.mode).toBe("health");
    expect(out.requested).toBeUndefined();
    expect(out.apiStatus).toBe("unreachable");
  });

  it("health reports the version from package.json — the declared version follows the branch, and a literal cannot", async () => {
    const declared = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    const out = await health({});
    expect(out.version).toBe(declared);
    // The literal this replaces: server.ts once carried a hard-coded version that lagged package.json
    // by two releases. Proving the MECHANISM, not a value: the sources carry no semver literal at all —
    // a `not.toBe("0.1.0")` tripwire became unsatisfiable the day 0.1.0 was the declared version.
    const src = ["../src/version.ts", "../src/earn/commands.ts", "../src/cli.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    for (const s of src) expect(s).not.toMatch(/"\d+\.\d+\.\d+"/);
  });

  it("a vault but no account → health carrying the gap as STRUCTURE, not prose", async () => {
    const out = await health({ vault: "tlCashPlusUSDC2B" });
    expect(out.mode).toBe("health");
    expect(out.requested).toBe("preflight");
    expect(out.missing).toEqual(["account"]);
  });
});

describe("a refusal that names a chain keeps the chain's name", () => {
  afterEach(() => {
    delete process.env["TREASURY_RPC_ARBITRUM"];
  });

  it("a chain's own name in the RPC URL is not masked out of a refusal that names the chain", async () => {
    // Providers put the chain in the path or the host. The redactor registers long URL segments as
    // secrets; "arbitrum" is 8 characters, and the refusal read `is on base, not <redacted>`.
    process.env["TREASURY_RPC_ARBITRUM"] = "http://127.0.0.1:9/arbitrum/KEYabcdef123456";
    const vault = (id: string, chainId: number, vaultAddress: string) => ({ id, kind: "vault", name: id, status: "live", warnings: [], vault: { standard: "erc4626", chain: `eip155:${chainId}`, vaultAddress, assetAddress: OWNER, assetDecimals: 6, shareDecimals: 18 } });
    const listed = new Proxy({} as McpClient, {
      get: () => async () => ({ ok: true, status: 200, body: { products: [vault("vault-base-1", 8453, EARN.defaultVaultAddressByChain.base), vault("vault-arbitrum-1", 42161, EARN.defaultVaultAddressByChain.arbitrum)] } }),
    });
    const t = buildCommands({ mcp: listed }) as unknown as Registered; // buildCommands registers the secrets
    const err = await t["earn_status"]!
      .handler({ vault: "tlCashPlusUSDC2B", chain: "arbitrum" }, {})
      .then(() => "no error", (e: Error) => e.message);
    expect(err).toMatch(/is on base, not arbitrum/);
    expect(err).toMatch(/pick a vault on arbitrum \(tlCashPlusUSDC2C\)/);
    expect(err).not.toMatch(/<redacted>/);
    const unknown = await t["earn_status"]!
      .handler({ chain: "solana" }, {})
      .then(() => "no error", (e: Error) => e.message);
    expect(unknown).toMatch(/chains with a vault: base, arbitrum/);
  });
});

describe("earn_quote", () => {
  it("direction is required — a call without it is rejected, there is no default side", () => {
    const shape = tools()["earn_quote"]!.inputSchema?.shape ?? {};
    const direction = shape["direction"] as { safeParse: (v: unknown) => { success: boolean } };
    expect(direction.safeParse(undefined).success).toBe(false);
    expect(direction.safeParse("deposit").success).toBe(true);
    expect(direction.safeParse("withdraw").success).toBe(true);
    expect(direction.safeParse("sideways").success).toBe(false);
  });
});

export { ACCOUNT };

/**
 * A new response field an agent is expected to SURFACE has to be named in the tool's own
 * description, not only in `docs/tools.md`.
 *
 * The discriminator, which is the part worth keeping: **does an agent learn this field exists
 * without reading a file it never reads?** `docs/tools.md` is the human integrator's document; the
 * description is what reaches the model before it decides what to tell an operator. A field that
 * exists, is populated, is documented for humans and is never mentioned to the agent is
 * indistinguishable from one that was never added — which is the same shape as the vault warning
 * shipping on a discovery call nobody was required to make.
 */
describe("a response field an agent must surface is named in its tool's own description", () => {
  // What can be withdrawn now is not what a position is worth: the API finds it by simulating withdrawals, and an agent
  // that reads only the value can tell an operator a position is fully withdrawable when it is not.
  for (const name of ["earn_quote", "earn_balance"]) {
    it(`${name}'s description names \`withdrawable\`, and says it is found by simulating withdrawals`, () => {
      const d = (tools()[name] as unknown as { description: string }).description;
      expect(d, "the description must exist at all").toBeTypeOf("string");
      expect(d).toContain("withdrawable");
      expect(d).toMatch(/simulating withdrawals/);
    });
  }

  it("earn_balance's description names `sharesExact`, and says an unread balance is `unknown`, never 0", () => {
    const d = (tools()["earn_balance"] as unknown as { description: string }).description;
    expect(d).toContain("sharesExact");
    expect(d).toMatch(/`unknown`, never as 0/);
  });

  it("both prepare descriptions say nothing is submitted, and that a sent step's hash goes to `earn submit`", () => {
    for (const name of ["earn_prepare_deposit", "earn_prepare_withdraw"]) {
      const d = (tools()[name] as unknown as { description: string }).description;
      expect(d).toMatch(/NOTHING IS SUBMITTED/);
      expect(d).toContain("`earn submit`");
    }
  });

  it("earn_status's description says the gates' reasons are given verbatim", () => {
    expect((tools()["earn_status"] as unknown as { description: string }).description).toMatch(/`reason` VERBATIM/);
  });
});
