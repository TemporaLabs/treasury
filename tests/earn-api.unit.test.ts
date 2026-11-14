/**
 * The earn reads on an EVM chain — `earn vaults`, `earn terms`, `earn status`, `earn quote` and `earn balance` — against a
 * stand-in for the Tempora API's MCP endpoint and a stand-in wallet: no network, no browser. Each test keeps its own
 * temporary connect directory, with a connected wallet and a kept owner token, so no sign-in is asked for unless a test
 * asks for one. `fetch` itself is replaced by one that records and refuses, so a request that went anywhere but the
 * stand-ins fails the test that made it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, getAddress, sha256, stringToBytes, type Address } from "viem";
import { erc4626Abi } from "../src/abi/erc4626.js";
import type { Client, Product } from "@temporalabs/client";
import type { McpClient } from "@temporalabs/client/mcp";
import { buildCommands } from "../src/earn/commands.js";
import { mcpUrl } from "../src/earn/api.js";
import { tokenKeyFor } from "../src/invest/api.js";
import type { OwnerWallet } from "../src/invest/flow.js";
import { readOwnerToken, writeOwnerToken } from "../src/connect/owner-tokens.js";
import { writeSession } from "../src/connect/session.js";
import { EARN } from "../src/config/earn.js";
import { DISCLOSURES } from "../src/disclosures.js";
import { getVault, listSolanaVaults } from "../src/registry.js";

const OWNER = getAddress("0x52908400098527886e0f7030069857d2e4169ee7");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const HOST = "api.staging.example";
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The vaults are named by public contract addresses, as treasury names them: Base's and Arbitrum One's defaults, a
 * second Base vault, and a public vault on Ethereum that the registry has no ticker for. Every other fact a vault has is
 * the API's word; the asset is a placeholder.
 */
const BASE_VAULT = EARN.defaultVaultAddressByChain.base;
const DEMO_VAULT = getVault("tlCashPlusUSDC2").address;
const ARB_VAULT = EARN.defaultVaultAddressByChain.arbitrum;
const OTHER_VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";
const VAULT = BASE_VAULT;
const ASSET = `0x${"22".repeat(20)}`;
/** Product ids as opaque as the API's own: sent back to it, never typed by a caller and never shown. */
const BASE_ID = "vault-base-1";
const DEMO_ID = "vault-base-2";
const ARB_ID = "vault-arbitrum-1";
const OTHER_ID = "vault-ethereum-1";
const PORTFOLIO_ID = "portfolio-1";
const PRODUCT_IDS = [BASE_ID, DEMO_ID, ARB_ID, OTHER_ID, PORTFOLIO_ID];
const TERMS = "Cash Plus terms.\nDeposit only what you can lose.\tTabs and accents: déjà vu.";
const WARNING = "TEST VAULT: deposit only an amount you are prepared to lose.";

function vault(id: string, chainId: number, vaultAddress: string, o: Partial<Product> = {}): Product {
  const chain = `eip155:${chainId}`;
  return {
    id,
    kind: "vault",
    name: `Cash Plus ${vaultAddress.slice(2, 6)}`,
    status: "live",
    featured: false,
    thesis: "",
    risk: "conservative",
    previousIds: [],
    chains: [chain],
    tokens: ["USDC"],
    defaults: { chain, token: "USDC" },
    minimum: null,
    gates: ["vault-live", "vault-terms"],
    steps: { deposit: ["approve", "deposit"], withdraw: ["withdraw"] },
    amountForms: { deposit: ["assets"], withdraw: ["assets", "shares", "all"] },
    rebalance: null,
    terms: { swapFeePct: null, platformFeeConfirmed: false },
    limits: null,
    sizing: null,
    members: [],
    sectorWeights: null,
    methodology: { version: null, month: null },
    stats: { netApy30d: null, tvlUsd: null, subscribers: null, inception: null },
    vault: { standard: "erc4626", chain, vaultAddress, assetAddress: ASSET, assetDecimals: 6, shareDecimals: 18 },
    vaultFees: { performance: "0.1", management: "0", asOf: null, block: null },
    vaultTerms: { text: TERMS, version: "2026-11-01", sha256: sha256(stringToBytes(TERMS)) },
    vaultLinks: { explorer: `https://explorer.example/address/${vaultAddress}`, venue: null },
    warnings: [WARNING],
    recordVersion: 1,
    ...o,
  } as Product;
}

/**
 * What the stand-in API lists: Base's default and a second Base vault, Arbitrum's default paused, a vault on Ethereum
 * that is not Ethereum's default, and a portfolio, which no earn command may show. Nothing on Robinhood Chain or Monad.
 */
const LISTED: Product[] = [
  vault(BASE_ID, 8453, BASE_VAULT),
  vault(DEMO_ID, 8453, DEMO_VAULT),
  vault(ARB_ID, 42161, ARB_VAULT, { status: "paused" }),
  vault(OTHER_ID, 1, OTHER_VAULT),
  { ...vault(PORTFOLIO_ID, 56, BASE_VAULT), kind: "portfolio", vault: undefined } as Product,
];

type Log = string[];
const ok = (body: unknown) => ({ ok: true, status: 200, body });
const refused = (code: string, message: string) => ({ ok: false, status: 400, error: { code, message, outcome: "refused" } });

/**
 * A stand-in MCP client: answers each tool from the test's own table (`products` from `LISTED` unless replaced), logs
 * every call with the owner token it carried, and refuses a token it does not know.
 */
function mcp(log: Log, handlers: Partial<Record<keyof McpClient, (input: any) => unknown>> = {}, tokens = ["tok"]): McpClient {
  return new Proxy({} as McpClient, {
    get: (_t, name: string) => async (input: any, opts?: { ownerToken?: string }) => {
      log.push(`mcp:${name}${opts?.ownerToken ? `@${opts.ownerToken}` : ""}`);
      if (opts?.ownerToken !== undefined && !tokens.includes(opts.ownerToken)) {
        return { ok: false, status: 401, error: { code: "wallet_proof_required", message: "Sign in again.", outcome: "failed" } };
      }
      const h = handlers[name as keyof McpClient] ?? (name === "products" ? () => ({ products: LISTED }) : undefined);
      if (!h) throw new Error(`unexpected call ${name}`);
      const v = h(input) as any;
      return v && v.ok === false ? v : ok(v);
    },
  });
}

/** A stand-in HTTP client: the sign-in only. Any other call is a failure. */
function http(log: Log, o: { message?: string; token?: string } = {}): Client {
  return new Proxy({} as Client, {
    get: (_t, name: string) => async (input: any) => {
      log.push(`http:${name}`);
      if (name === "sign_in_challenge") return ok({ message: o.message ?? challenge(), nonce: "n", expiresAt: iso(NOW + 300_000) });
      if (name === "sign_in_verify") return ok({ token: o.token ?? "tok-new", tokenType: "Bearer", expiresAt: iso(NOW + 12 * 3_600_000), audience: input.body.audience });
      throw new Error(`unexpected HTTP call ${name}`);
    },
  });
}
const challenge = () =>
  ["Tempora sign-in", `Host: ${HOST}`, "Client: treasury-cli", `Owner: ${OWNER}`, "Nonce: 0123456789abcdef0123456789abcdef", `Issued: ${iso(NOW)}   Expires: ${iso(NOW + 300_000)}`].join("\n");

/** A stand-in wallet: it can sign in, and logs it; nothing else is ever asked of it by these reads. */
function wallet(log: Log): OwnerWallet {
  return {
    signIn: async () => {
      log.push("wallet:sign-in");
      return `0x${"5".repeat(130)}`;
    },
    ask: async () => {
      throw new Error("a read asked the wallet to sign or send");
    },
    finish: async (o) => void log.push(`wallet:finish:${o.ok}`),
    url: () => undefined,
  };
}

const commands = (log: Log, m: McpClient, c: Client = http(log)) => buildCommands({ mcp: m, client: c, wallet: () => wallet(log), now: () => NOW });
const run = async (log: Log, m: McpClient, name: string, args: Record<string, unknown>) => JSON.parse(await commands(log, m)[name]!.handler(args as never));
const fails = (log: Log, m: McpClient, name: string, args: Record<string, unknown>) => commands(log, m)[name]!.handler(args as never);

let home: string;
let fetched: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "treasury-earn-api-"));
  process.env["TREASURY_CONNECT_HOME"] = home;
  process.env["TREASURY_API_URL"] = `https://${HOST}`;
  writeSession({ account: OWNER, walletType: "external", connectedAtIso: iso(NOW) });
  writeOwnerToken(tokenKeyFor(OWNER), { token: "tok", expiresAtIso: iso(NOW + 3_600_000) }, NOW);
  fetched = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    fetched.push(String(url));
    throw new Error(`a request left the stand-ins: ${String(url)}`);
  });
});
afterEach(() => {
  // Nothing in any test here reached the network: every answer came from a stand-in.
  expect(fetched).toEqual([]);
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  delete process.env["TREASURY_CONNECT_HOME"];
  delete process.env["TREASURY_API_URL"];
});

describe("the MCP endpoint", () => {
  it("is /mcp on the API's host, which TREASURY_API_URL moves", () => {
    expect(mcpUrl()).toBe(`https://${HOST}/mcp`);
    delete process.env["TREASURY_API_URL"];
    expect(mcpUrl()).toBe("https://api.temporalabs.com/mcp");
  });
});

describe("earn vaults", () => {
  it("lists the API's vaults only, each by its contract address, ticker and name, with its status, chain, decimals, terms version, warnings and links; never a portfolio", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log), "earn_vaults", {});
    expect(log).toEqual(["mcp:products"]);
    const evm = out.vaults.filter((v: { chainId: number | null }) => v.chainId !== null);
    expect(evm.map((v: { vault: string; ticker: string | null }) => [v.vault, v.ticker])).toEqual([
      [BASE_VAULT, "tlCashPlusUSDC2B"],
      [DEMO_VAULT, "tlCashPlusUSDC2"],
      [ARB_VAULT, "tlCashPlusUSDC2C"],
      [OTHER_VAULT, null], // a vault the registry has no ticker for is named by its address alone
    ]);
    expect(evm[0]).toMatchObject({
      vault: BASE_VAULT,
      ticker: "tlCashPlusUSDC2B",
      name: `Cash Plus ${BASE_VAULT.slice(2, 6)}`,
      status: "live",
      depositsOpen: true,
      isDefault: true,
      chain: "base",
      chainId: 8453,
      caip2: "eip155:8453",
      assetDecimals: 6,
      shareDecimals: 18,
      termsVersion: "2026-11-01",
      warnings: [WARNING],
      links: { explorer: `https://explorer.example/address/${BASE_VAULT}`, venue: null },
    });
    // paused takes withdrawals only
    expect(evm[2]).toMatchObject({ vault: ARB_VAULT, status: "paused", depositsOpen: false, chain: "arbitrum", chainId: 42161 });
    const depositable = out.depositable.map((v: { vault: string }) => v.vault);
    expect(depositable).toEqual(expect.arrayContaining([BASE_VAULT, DEMO_VAULT, OTHER_VAULT]));
    expect(depositable).not.toContain(ARB_VAULT);
  });

  it("shows no product id anywhere: not as a field, not as a value", async () => {
    const log: Log = [];
    const raw = await commands(log, mcp(log))["earn_vaults"]!.handler({} as never);
    for (const id of PRODUCT_IDS) expect(raw).not.toContain(id);
    const out = JSON.parse(raw);
    for (const row of out.vaults) expect(row).not.toHaveProperty("id");
  });

  it("names each chain's default only when the API lists it, the default chain first; a chain with no listed vault is not offered", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log), "earn_vaults", {});
    const evm = out.chains.filter((c: { chain: string }) => c.chain !== "solana");
    expect(evm.map((c: { chain: string; chainId: number; default: { vault: string } | null }) => [c.chain, c.chainId, c.default?.vault ?? null])).toEqual([
      ["base", 8453, BASE_VAULT],
      ["arbitrum", 42161, ARB_VAULT],
      ["ethereum", 1, null], // a vault is listed there, but not Ethereum's default
    ]);
    expect(out.defaultChain).toBe("base");
    expect(out.default).toEqual({ vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", name: `Cash Plus ${BASE_VAULT.slice(2, 6)}` });
    expect(evm[1].depositable).toEqual([]); // the paused default takes no deposit
  });

  it("keeps the Solana vault from the registry, by its ticker under the same `vault` field the other rows use", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log), "earn_vaults", {});
    const sol = listSolanaVaults()[0]!;
    expect(out.chains.at(-1)).toMatchObject({ chain: "solana", chainId: null, default: { vault: sol.symbol, ticker: sol.symbol, name: sol.name } });
    expect(out.vaults.find((v: { vault: string }) => v.vault === sol.symbol)).toMatchObject({ ticker: sol.symbol, symbol: sol.symbol, chain: "solana", chainId: null });
  });

  it("a list the API could not give is an error, never an empty list", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log, { products: () => refused("upstream_unavailable", "try later") }), "earn_vaults", {})).rejects.toThrow(/vault list could not be read.*upstream_unavailable/);
  });
});

describe("which vault a call is about", () => {
  const status = (log: Log, args: Record<string, unknown>, m: McpClient = mcp(log)) => run(log, m, "earn_status", args);
  const refusal = (log: Log, args: Record<string, unknown>, m: McpClient = mcp(log)) =>
    fails(log, m, "earn_status", args).then(
      () => "no error",
      (e: Error) => e.message,
    );
  const listing = (products: Product[]) => mcp([], { products: () => ({ products }) });

  it("neither vault nor chain → the default chain's default; a chain alone → that chain's; a vault by its address", async () => {
    const log: Log = [];
    expect(await status(log, {})).toMatchObject({ vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", chain: "base" });
    expect(await status(log, { chain: "arbitrum" })).toMatchObject({ vault: ARB_VAULT, ticker: "tlCashPlusUSDC2C", chain: "arbitrum", chainId: 42161, status: "paused", depositsOpen: false });
    expect(await status(log, { vault: OTHER_VAULT })).toMatchObject({ vault: OTHER_VAULT, ticker: null, chain: "ethereum", chainId: 1 });
  });

  it("an address is matched in any case", async () => {
    const log: Log = [];
    const mixed = [...OTHER_VAULT.slice(2)].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join("");
    for (const typed of [OTHER_VAULT.toLowerCase(), `0x${OTHER_VAULT.slice(2).toUpperCase()}`, `0x${mixed}`]) {
      expect(await status(log, { vault: typed })).toMatchObject({ vault: OTHER_VAULT, chain: "ethereum", chainId: 1 });
    }
    expect(await status(log, { vault: BASE_VAULT.toLowerCase(), chain: "base" })).toMatchObject({ vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B" });
  });

  it("a ticker is turned into its address through the registry, and that address picks the API's row", async () => {
    const log: Log = [];
    expect(await status(log, { vault: "tlCashPlusUSDC2" })).toMatchObject({ vault: DEMO_VAULT, ticker: "tlCashPlusUSDC2", chain: "base", chainId: 8453 });
    expect(await status(log, { vault: "tlCashPlusUSDC2C", chain: "arbitrum" })).toMatchObject({ vault: ARB_VAULT, ticker: "tlCashPlusUSDC2C", chain: "arbitrum" });
  });

  it("a chain whose default the API does not list is refused, never served by another vault on it", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_status", { chain: "ethereum" })).rejects.toThrow(
      new RegExp(`default vault on ethereum \\(${EARN.defaultVaultAddressByChain.ethereum}\\) is not listed by the Tempora API`),
    );
    await expect(fails(log, mcp(log), "earn_status", { chain: "robinhood" })).rejects.toThrow(/default vault on robinhood .* not listed/);
  });

  it("an address no listed vault has is refused, naming the vaults the API lists by ticker or address", async () => {
    const log: Log = [];
    const unknown = `0x${"ab".repeat(20)}`;
    const err = await refusal(log, { vault: unknown });
    expect(err).toMatch(new RegExp(`no vault the Tempora API lists has the address ${unknown}`));
    expect(err).toContain(`tlCashPlusUSDC2B (base), tlCashPlusUSDC2 (base), tlCashPlusUSDC2C (arbitrum), ${OTHER_VAULT} (ethereum)`);
    expect(await refusal(log, { vault: unknown, chain: "base" })).toMatch(/the vaults the Tempora API lists on base: tlCashPlusUSDC2B, tlCashPlusUSDC2$/);
    // A ticker the registry has, for a vault the API does not list: refused the same way, by its address.
    expect(await refusal(log, { vault: "tlCashPlusUSDC2E" })).toMatch(new RegExp(`no vault the Tempora API lists has the address ${getVault("tlCashPlusUSDC2E").address}`));
    for (const id of PRODUCT_IDS) expect(err).not.toContain(id);
  });

  it("the API's product id is not taken as a vault, and a value that is neither an address nor a ticker is refused", async () => {
    const log: Log = [];
    for (const typed of [BASE_ID, OTHER_ID, "tlCashPlusUSDC2X", "0x1234"]) {
      const err = await refusal(log, { vault: typed });
      expect(err).toMatch(/`--vault` takes a vault's contract address \(0x…\) or its ticker, and the value given is neither/);
      for (const id of PRODUCT_IDS) expect(err).not.toContain(id);
    }
  });

  it("an address more than one listed vault has is refused, with or without a chain", async () => {
    const log: Log = [];
    const twiceOnBase = listing([vault(BASE_ID, 8453, BASE_VAULT), vault("vault-base-9", 8453, BASE_VAULT.toLowerCase())]);
    for (const args of [{ vault: BASE_VAULT }, { vault: "tlCashPlusUSDC2B", chain: "base" }, {}]) {
      const err = await refusal(log, args, twiceOnBase);
      expect(err).toMatch(/lists more than one vault at 0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F/);
      expect(err).not.toContain("vault-base-");
    }
    // The same address on two chains: ambiguous until the chain is named, and then it is the one on that chain.
    const onTwoChains = listing([vault(BASE_ID, 8453, BASE_VAULT), vault(ARB_ID, 42161, BASE_VAULT)]);
    expect(await refusal(log, { vault: BASE_VAULT }, onTwoChains)).toMatch(/lists more than one vault at 0x91Bc.*Name its chain with `chain`/);
    expect(await status(log, { vault: BASE_VAULT, chain: "arbitrum" }, onTwoChains)).toMatchObject({ vault: BASE_VAULT, chain: "arbitrum", ticker: null });
  });

  it("an unknown chain, and a vault named with another chain, are refused", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_status", { chain: "optimism" })).rejects.toThrow(/unknown chain "optimism"; chains with a vault: base, arbitrum, robinhood, ethereum, monad, solana/);
    const asked = log.length;
    await expect(fails(log, mcp(log), "earn_terms", { chain: "optimism" })).rejects.toThrow(/unknown chain "optimism"/);
    await expect(fails(log, mcp(log), "earn_quote", { chain: "optimism", direction: "withdraw" })).rejects.toThrow(/unknown chain "optimism"/);
    expect(log.length, "an unknown chain is refused before anything is asked").toBe(asked);
    await expect(fails(log, mcp(log), "earn_status", { vault: BASE_VAULT, chain: "arbitrum" })).rejects.toThrow(
      new RegExp(`"${BASE_VAULT}" is on base, not arbitrum.*pick a vault on arbitrum \\(tlCashPlusUSDC2C\\)`),
    );
    await expect(fails(log, mcp(log), "earn_status", { vault: "tlCashPlusUSDC2C", chain: "base" })).rejects.toThrow(/"tlCashPlusUSDC2C" is on arbitrum, not base.*pick a vault on base \(tlCashPlusUSDC2B, tlCashPlusUSDC2\)/);
  });

  it("a Solana ticker, or chain solana, stays on the local path and asks the API nothing", async () => {
    const log: Log = [];
    const sol = listSolanaVaults()[0]!.symbol;
    expect(await run(log, mcp(log), "earn_terms", { chain: "solana" })).toEqual(JSON.parse(JSON.stringify(DISCLOSURES)));
    expect(await run(log, mcp(log), "earn_terms", { vault: sol })).toEqual(JSON.parse(JSON.stringify(DISCLOSURES)));
    await expect(fails(log, mcp(log), "earn_balance", { vault: sol, chain: "base" })).rejects.toThrow(/is on solana, not base/);
    await expect(fails(log, mcp(log), "earn_balance", { vault: BASE_VAULT, chain: "solana" })).rejects.toThrow(/is not on solana/);
    await expect(fails(log, mcp(log), "earn_balance", { chain: "solana" })).rejects.toThrow(/--account is required for a vault on Solana/);
    expect(log).toEqual([]);
  });
});

describe("earn terms", () => {
  it("returns the vault's terms with their version and sha256, hashed here over the text's UTF-8 bytes", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log), "earn_terms", {});
    expect(out.terms).toEqual({ text: TERMS, version: "2026-11-01", sha256: sha256(stringToBytes(TERMS)) });
    expect(out).toMatchObject({ vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", chain: "base", chainId: 8453 });
    expect(out.disclosures).toEqual(JSON.parse(JSON.stringify(DISCLOSURES)));
    expect(log).toEqual(["mcp:products"]); // public: no sign-in, no owner call
  });

  it("an upper-case sha256 that matches is taken, and given back in the form computed here", async () => {
    const log: Log = [];
    const upper = `0x${sha256(stringToBytes(TERMS)).slice(2).toUpperCase()}`;
    const out = await run(log, mcp(log, { products: () => ({ products: [vault(BASE_ID, 8453, BASE_VAULT, { vaultTerms: { text: TERMS, version: "v", sha256: upper } })] }) }), "earn_terms", {});
    expect(out.terms.sha256).toBe(sha256(stringToBytes(TERMS)));
  });

  it("refuses terms whose text does not hash to the sha256 sent with them, and terms the API does not list", async () => {
    const log: Log = [];
    const tampered = vault(BASE_ID, 8453, BASE_VAULT, { vaultTerms: { text: `${TERMS} `, version: "2026-11-01", sha256: sha256(stringToBytes(TERMS)) } });
    await expect(fails(log, mcp(log, { products: () => ({ products: [tampered] }) }), "earn_terms", {})).rejects.toThrow(/do not match their own sha256/);
    const none = vault(BASE_ID, 8453, BASE_VAULT, { vaultTerms: undefined });
    await expect(fails(log, mcp(log, { products: () => ({ products: [none] }) }), "earn_terms", {})).rejects.toThrow(/lists no terms/);
  });
});

describe("earn status", () => {
  it("no account: the API's reachability and the vault the call resolves to, with no sign-in", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log), "earn_status", {});
    expect(out).toMatchObject({ mode: "health", apiStatus: "ok", api: `https://${HOST}`, vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", chain: "base", chainId: 8453 });
    expect(out.requested).toBeUndefined();
    expect(log).toEqual(["mcp:products"]);
  });

  it("an API that cannot be reached is a verdict, not a throw", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log, { products: () => refused("network_error", "no answer") }), "earn_status", { vault: "tlCashPlusUSDC2B" });
    expect(out).toMatchObject({ mode: "health", apiStatus: "unreachable", requested: "preflight", missing: ["account"] });
    expect(out.reason).toMatch(/network_error/);
    expect(out.setup_required).toBeUndefined(); // no RPC was read, so no RPC setup sentence
  });

  it("with the connected wallet: standing, gates verbatim with their reasons, the wallet's balance and allowance, and the warnings", async () => {
    const log: Log = [];
    const gates = [
      { id: "vault-live", status: "pass" },
      { id: "allowlist", status: "fail", code: "not_admitted", reason: "AccessManagedUnauthorized(0x52908400098527886e0f7030069857d2e4169ee7)" },
    ];
    const reading = { assetId: `eip155:8453/erc20:${ASSET}`, decimals: 6, block: "123", balance: "25000000", allowance: null, asOf: iso(NOW) };
    const account = (i: { path: { product: string } }) => {
      log.push(`product:${i.path.product}`);
      return { product: i.path.product, owner: OWNER, standing: { state: "registered", code: "ok", reason: "Registered." }, gates, account: { enrolled: false, wallet: reading }, alerts: [] };
    };
    const out = await run(log, mcp(log, { account }), "earn_status", { account: OWNER.toLowerCase() });
    expect(log).toEqual(["mcp:products", "mcp:account@tok", `product:${BASE_ID}`, "wallet:finish:true"]);
    expect(out).toMatchObject({ mode: "preflight", account: OWNER, vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", chain: "base", standing: { state: "registered" }, wallet: reading });
    expect(out.gates).toEqual(gates);
    expect(out.warnings).toEqual([WARNING]);
    expect(out.deposit).toBeUndefined();
  });

  it("with an amount, also whether the vault would take that deposit, quoted in the vault's own decimals", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const account = () => ({ product: BASE_ID, owner: OWNER, standing: { state: "registered", code: "", reason: "" }, gates: [], account: { enrolled: false }, alerts: [] });
    const quote = (i: { body: unknown }) => (bodies.push(i.body), { product: BASE_ID, action: "deposit", chain: "eip155:8453", block: "7", asOf: iso(NOW), assetId: "x", deposit: { amount: {}, expectedShares: null, sharePrice: null, check: { state: "not_admitted", reason: "not on the allowlist" } } });
    const out = await run(log, mcp(log, { account, quote }), "earn_status", { account: OWNER, amount_usdc: "25.5" });
    expect(bodies).toEqual([{ product: BASE_ID, action: "deposit", amount: { kind: "assets", assetId: `eip155:8453/erc20:${ASSET}`, raw: "25500000" } }]);
    expect(out.deposit).toEqual({ amount: { raw: "25500000", decimals: 6, amount: "25.5" }, check: { state: "not_admitted", reason: "not on the allowlist" }, block: "7", asOf: iso(NOW) });
    expect(out.wallet).toBeNull(); // not read: reported as such, never as 0
  });

  it("an account that is not the connected wallet is refused before anything is asked", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_status", { account: STRANGER })).rejects.toThrow(/is not the connected wallet/);
    expect(log).toEqual([]);
  });

  it("refuses with no connected wallet, as invest does", async () => {
    rmSync(join(home, "connect-session.json"));
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_status", { account: OWNER })).rejects.toThrow(/no wallet is connected — run `treasury connect wallet` first/);
    await expect(fails(log, mcp(log), "earn_balance", {})).rejects.toThrow(/no wallet is connected/);
    expect(log).toEqual([]);
  });
});

describe("earn quote", () => {
  const depositQuote = { product: BASE_ID, action: "deposit", chain: "eip155:8453", block: "100", asOf: iso(NOW), assetId: `eip155:8453/erc20:${ASSET}` };

  it("deposit: the API's quote for exactly the amount asked, tagged deposit, with the warnings", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const d = { amount: {}, expectedShares: { raw: "24750000000000000000", decimals: 18 }, sharePrice: { shares: { raw: "1000000000000000000", decimals: 18 }, assets: "1010101" }, check: { state: "open", reason: null } };
    const out = await run(log, mcp(log, { quote: (i) => (bodies.push(i.body), { ...depositQuote, deposit: d }) }), "earn_quote", { direction: "deposit", amount_usdc: "25", chain: "base" });
    expect(bodies).toEqual([{ product: BASE_ID, action: "deposit", amount: { kind: "assets", assetId: `eip155:8453/erc20:${ASSET}`, raw: "25000000" } }]);
    expect(out).toMatchObject({ direction: "deposit", vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", chain: "base", account: OWNER, expectedShares: d.expectedShares, sharePrice: d.sharePrice, check: d.check, block: "100" });
    expect(out.warnings).toEqual([WARNING]);
    expect(out.position).toBeUndefined();
    expect(log).toEqual(["mcp:products", "mcp:quote@tok", "wallet:finish:true"]);
  });

  it("withdraw: the position and what can be withdrawn now, tagged withdraw, with no deposit warning", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const w = { position: { shares: { raw: "5000000000000000000", decimals: 18 }, assets: { raw: "5100000", decimals: 6 } }, withdrawable: { state: "partial", assets: "1500000", within: "5100000", reason: "liquidity" } };
    const out = await run(log, mcp(log, { quote: (i) => (bodies.push(i.body), { ...depositQuote, action: "withdraw", withdraw: w }) }), "earn_quote", { direction: "withdraw" });
    expect(bodies).toEqual([{ product: BASE_ID, action: "withdraw" }]);
    expect(out).toMatchObject({ direction: "withdraw", vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", position: w.position, withdrawable: w.withdrawable });
    expect(out.expectedShares).toBeUndefined();
    expect(out.warnings).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });

  it("an answer for the other side is refused, never relabelled", async () => {
    const log: Log = [];
    const w = { position: { shares: { raw: "1", decimals: 18 }, assets: null }, withdrawable: { state: "unknown", assets: null, within: null, reason: null } };
    await expect(fails(log, mcp(log, { quote: () => ({ ...depositQuote, action: "withdraw", withdraw: w }) }), "earn_quote", { direction: "deposit", amount_usdc: "1" })).rejects.toThrow(/without a deposit/);
  });

  it("amounts: exact in the vault's decimals, never rounded; zero, too many places, or no amount for a deposit are refused before the quote", async () => {
    const log: Log = [];
    const q = () => ({ ...depositQuote, deposit: { amount: {}, expectedShares: null, sharePrice: null, check: { state: "open", reason: null } } });
    const out = await run(log, mcp(log, { quote: q }), "earn_quote", { direction: "deposit", amount_usdc: "0.000001" });
    expect(out.amount).toEqual({ raw: "1", decimals: 6, amount: "0.000001" });
    log.length = 0;
    await expect(fails(log, mcp(log, { quote: q }), "earn_quote", { direction: "deposit", amount_usdc: "1.0000001" })).rejects.toThrow(/7 fractional digits but the token has 6 decimals/);
    await expect(fails(log, mcp(log, { quote: q }), "earn_quote", { direction: "deposit", amount_usdc: "0" })).rejects.toThrow(/must be positive/);
    expect(log.filter((l) => l.startsWith("mcp:quote"))).toEqual([]);
    await expect(fails(log, mcp(log, { quote: q }), "earn_quote", { direction: "deposit" })).rejects.toThrow(/--amount_usdc is required for a deposit quote/);
  });

  it("a refusal from the API names its code and what it said", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log, { quote: () => refused("gate_failed", "the vault is paused") }), "earn_quote", { direction: "deposit", amount_usdc: "1" })).rejects.toThrow(
      /could not be quoted: gate_failed: the vault is paused/,
    );
    expect(log.at(-1)).toBe("wallet:finish:false");
  });
});

/**
 * `earn quote` routes `direction` to the RIGHT side, and says so truthfully. Swapping the two branches once left the type
 * check clean and every test passing, byte-identical. The tag is emitted inside each branch, so tag and body cannot
 * disagree; a swapped route is then wrong about the REQUEST, which is what asserting the action the API was asked for
 * against the tag that came back catches. Both are needed: the body catches the body, the action catches the route.
 */
describe("earn quote — direction routes to the matching side", () => {
  const answer = (i: { body: { action: string } }) =>
    i.body.action === "deposit"
      ? { product: BASE_ID, action: "deposit", chain: "eip155:8453", block: "1", asOf: iso(NOW), assetId: "x", deposit: { amount: {}, expectedShares: { raw: "1", decimals: 18 }, sharePrice: null, check: { state: "open", reason: null } } }
      : { product: BASE_ID, action: "withdraw", chain: "eip155:8453", block: "1", asOf: iso(NOW), assetId: "x", withdraw: { position: { shares: { raw: "2", decimals: 18 }, assets: null }, withdrawable: { state: "all", assets: "2", within: null, reason: null } } };

  for (const direction of ["deposit", "withdraw"] as const) {
    it(`direction "${direction}" asks the API for a ${direction} quote, returns only that side's fields, and is tagged ${direction}`, async () => {
      const log: Log = [];
      const asked: string[] = [];
      const out = await run(log, mcp(log, { quote: (i) => (asked.push(i.body.action), answer(i)) }), "earn_quote", { direction, amount_usdc: "1" });
      expect(asked).toEqual([direction]); // route: what was asked
      expect(out.direction).toBe(direction); // tag: what was returned
      if (direction === "deposit") {
        expect(out.expectedShares).toEqual({ raw: "1", decimals: 18 });
        expect(out.position).toBeUndefined();
      } else {
        expect(out.position.shares.raw).toBe("2");
        expect(out.expectedShares).toBeUndefined();
      }
    });
  }
});

describe("earn balance", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    product: BASE_ID,
    kind: "vault",
    stage: "invested",
    smartAccount: null,
    value: { usd: 5.1, state: "read", asOf: iso(NOW) },
    shares: { raw: "5000000000000000001", decimals: 18 },
    withdrawable: { block: "100", basis: "floor", withdrawable: { state: "all", assets: "5100000", within: null, reason: null } },
    ...o,
  });

  it("the vault's row from the positions: exact shares, value, the withdrawable floor and the stage; basis and yield not available", async () => {
    const log: Log = [];
    const positions = () => ({ positions: [{ product: PORTFOLIO_ID, kind: "portfolio" }, row(), row({ product: DEMO_ID })] });
    const out = await run(log, mcp(log, { positions }), "earn_balance", {});
    expect(out).toMatchObject({ vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", chain: "base", chainId: 8453, account: OWNER, stage: "invested" });
    expect(out.shares).toEqual({ raw: "5000000000000000001", decimals: 18 });
    expect(out.sharesExact).toBe("5.000000000000000001"); // every digit, never rounded
    expect(out.value).toEqual({ usd: 5.1, state: "read", asOf: iso(NOW) });
    expect(out.withdrawable).toEqual(row().withdrawable);
    expect([out.basis, out.yield]).toEqual(["not available", "not available"]);
    expect(log).toEqual(["mcp:products", "mcp:positions@tok", "wallet:finish:true"]);
  });

  it("a share balance the API could not read is `unknown`, never 0", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log, { positions: () => ({ positions: [row({ stage: "unknown", shares: undefined, withdrawable: undefined })] }) }), "earn_balance", {});
    expect(out.stage).toBe("unknown");
    expect(out.shares).toBe("unknown");
    expect(out.sharesExact).toBe("unknown");
    expect(out.withdrawable).toBe("unknown");
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
  });

  it("no row for this vault is said in so many words, not as a zero balance", async () => {
    const log: Log = [];
    const out = await run(log, mcp(log, { positions: () => ({ positions: [] }) }), "earn_balance", { chain: "arbitrum" });
    expect(out).toMatchObject({ vault: ARB_VAULT, ticker: "tlCashPlusUSDC2C", position: "none" });
    expect(out.shares).toBeUndefined();
  });

  it("the old scan flags are gone", () => {
    const shape = Object.keys((buildCommands()["earn_balance"]!.inputSchema as { shape: object }).shape).sort();
    expect(shape).toEqual(["account", "chain", "vault"]);
  });
});

describe("the sign-in", () => {
  it("a kept token is used as it is: no page opens and the wallet signs nothing", async () => {
    const log: Log = [];
    await run(log, mcp(log, { positions: () => ({ positions: [] }) }), "earn_balance", {});
    expect(log).not.toContain("wallet:sign-in");
    expect(log.filter((l) => l.startsWith("http:"))).toEqual([]);
  });

  it("with none kept, signs in once for both of the API's doors, keeps the token, and passes it per call", async () => {
    rmSync(join(home, "owner-tokens.json"), { force: true });
    const log: Log = [];
    const audiences: unknown[] = [];
    const c = new Proxy(http(log), {
      get: (t, name: string) => async (input: any) => {
        if (name === "sign_in_verify") audiences.push(input.body.audience);
        return (t as any)[name](input);
      },
    });
    const m = mcp(log, { positions: () => ({ positions: [] }) }, ["tok-new"]);
    const out = JSON.parse(await buildCommands({ mcp: m, client: c, wallet: () => wallet(log), now: () => NOW })["earn_balance"]!.handler({} as never));
    expect(out.position).toBe("none");
    expect(log).toEqual(["mcp:products", "http:sign_in_challenge", "wallet:sign-in", "http:sign_in_verify", "mcp:positions@tok-new", "wallet:finish:true"]);
    expect(audiences).toEqual(["both"]);
    expect(readOwnerToken(tokenKeyFor(OWNER), NOW)).toBe("tok-new");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The prepare commands, `earn submit` and `earn request`: steps from the stand-in API, each checked before it is shown.
// ---------------------------------------------------------------------------------------------------------------------

const TX = `0x${"7".repeat(64)}`;
const TERMS_SHA = sha256(stringToBytes(TERMS));
const RAW_25 = 25_000_000n;
const SHARES = 5_000_000_000_000_000_001n;

const approveData = (spender: Address, raw: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, raw] });
const depositData = (raw: bigint, receiver: Address) => encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [raw, receiver] });
const withdrawData = (fn: "withdraw" | "redeem", raw: bigint, receiver: Address, owner: Address) => encodeFunctionData({ abi: erc4626Abi, functionName: fn, args: [raw, receiver, owner] });

const sendStep = (stepId: string, purpose: string, to: string, data: string, o: Record<string, unknown> = {}) => ({
  stepId,
  chainId: "eip155:8453",
  state: "ready",
  checks: [],
  kind: "send_transaction",
  purpose,
  payload: { generation: 1, expiresAt: iso(NOW + 600_000), to, data, value: "0" },
  ...o,
});
const waitingStep = (stepId: string, after: string) => ({ stepId, chainId: "eip155:8453", state: "waiting", after, checks: [], kind: "send_transaction", purpose: "deposit" });
const approveStep = (spender: Address = getAddress(VAULT), raw = RAW_25) => sendStep("s1", "approve", ASSET, approveData(spender, raw));
const depositStep = (receiver: Address = OWNER, raw = RAW_25, o: Record<string, unknown> = {}) => sendStep("s2", "deposit", VAULT, depositData(raw, receiver), o);
const ASSETS_25 = { kind: "assets", assetId: `eip155:8453/erc20:${ASSET}`, raw: RAW_25.toString() };

function req(o: Record<string, unknown> & { steps: unknown[] }) {
  return { requestId: "req_1", action: "deposit", state: "requires_action", chose: { product: BASE_ID, amount: ASSETS_25 }, expiresAt: iso(NOW + 3_600_000), ...o };
}

describe("earn prepare_deposit", () => {
  const args = { amount_usdc: "25", terms_sha256: TERMS_SHA };

  it("starts the deposit for exactly the amount and the terms read now, and returns the checked steps in order, unsigned", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const deposit = (i: { body: unknown }) => (bodies.push(i.body), req({ steps: [approveStep(), waitingStep("s2", "s1")] }));
    const out = await run(log, mcp(log, { deposit }), "earn_prepare_deposit", args);
    expect(log).toEqual(["mcp:products", "mcp:deposit@tok", "wallet:finish:true"]);
    expect(bodies).toEqual([{ product: BASE_ID, amount: ASSETS_25, vaultTerms: { version: "2026-11-01", sha256: TERMS_SHA } }]);
    expect(out).toMatchObject({ requires_signature: true, status: "unsigned", chain: "base", chainId: 8453, vault: BASE_VAULT, ticker: "tlCashPlusUSDC2B", account: OWNER, requestId: "req_1" });
    expect(out.warnings).toEqual([WARNING]);
    const keys = Object.keys(out);
    expect(keys.indexOf("chain")).toBeLessThan(keys.indexOf("steps"));
    expect(keys.indexOf("warnings")).toBeLessThan(keys.indexOf("next_step"));
    expect(out.steps.map((s: { stepId: string; state: string }) => [s.stepId, s.state])).toEqual([["s1", "ready"], ["s2", "waiting"]]);
    expect(out.steps[0]).toMatchObject({ to: ASSET, data: approveData(getAddress(VAULT), RAW_25), value: "0" });
    expect(out.steps[0].description).toMatch(/approve the vault .* to take 25 of the vault's asset/);
    expect(out.steps[0]).toMatchObject({ function: "approve(address spender, uint256 value)", args: { spender: getAddress(VAULT), value: RAW_25.toString() } });
    expect(out.steps[1]).toMatchObject({ after: "s1" });
    expect(out.steps[1].to).toBeUndefined(); // nothing to send until s1 is submitted
    expect(out.next_step).toMatch(/Send step s1, and only it, from the connected wallet .* on Base \(chainId 8453\)/);
    expect(out.next_step).toContain("treasury earn submit --request_id req_1 --step_id s1");
    expect(out.next_step).toMatch(/Step s2 is prepared after that: read the request with `treasury earn request --request_id req_1`/);
    expect(out.next_step).toMatch(/Nothing has been submitted; no funds have moved\./);
    const rules = (out.signer_rules as string[]).join("\n");
    expect(rules).toMatch(/chainId/);
    expect(rules).toMatch(/eth_getTransactionCount\(account, "pending"\)/);
    expect(rules).toMatch(/receipt/);
    expect(rules).toMatch(/nonce on a DIFFERENT provider before re-sending/);
    expect(rules).not.toMatch(/receiver/);
  });

  it("terms that changed since the operator read them are refused before the deposit is asked for; no sha256 is refused before anything", async () => {
    const log: Log = [];
    const other = `0x${"ab".repeat(32)}`;
    await expect(fails(log, mcp(log, { deposit: () => req({ steps: [] }) }), "earn_prepare_deposit", { ...args, terms_sha256: other })).rejects.toThrow(/the terms of .* changed since the operator read them .*Show them again/);
    expect(log).toEqual(["mcp:products", "wallet:finish:false"]);
    log.length = 0;
    await expect(fails(log, mcp(log), "earn_prepare_deposit", { amount_usdc: "25" })).rejects.toThrow(/--terms_sha256 is required/);
    expect(log).toEqual([]);
  });

  it.each([
    ["an approval naming another spender", () => [approveStep(STRANGER), waitingStep("s2", "s1")], /step 1 of 2\): the approval names a spender other than the vault/],
    ["an approval for more than the deposit", () => [approveStep(getAddress(VAULT), RAW_25 + 1n), waitingStep("s2", "s1")], /step 1 of 2\): the approval's amount is not exactly the deposit's/],
    ["a deposit paying the shares to another account", () => [approveStep(), depositStep(STRANGER)], /step 2 of 2\): the deposit's receiver is not the owner/],
  ])("%s is refused, and nothing is returned to sign", async (_n, steps, why) => {
    const log: Log = [];
    const err = await fails(log, mcp(log, { deposit: () => req({ steps: steps() }) }), "earn_prepare_deposit", args).then(
      (v) => `returned: ${v}`,
      (e: Error) => e.message,
    );
    expect(err).toMatch(why);
    expect(err).toMatch(/Nothing from request req_1 is handed out to sign; cancel it with `treasury earn request --request_id req_1 --cancel`/);
  });

  it("a receiver on an EVM vault, and an account that is not the connected wallet, are refused before anything is asked", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_prepare_deposit", { ...args, receiver: OWNER })).rejects.toThrow(/--receiver is taken only for a vault on Solana/);
    await expect(fails(log, mcp(log), "earn_prepare_deposit", { ...args, account: STRANGER })).rejects.toThrow(/is not the connected wallet/);
    expect(log).toEqual([]);
  });
});

describe("earn prepare_withdraw", () => {
  const withdrawReq = (step: unknown, amount: unknown) => req({ action: "withdraw", chose: { product: BASE_ID, amount }, steps: [step] });

  it.each([
    ["--amount_usdc", { amount_usdc: "1.5" }, { kind: "assets", assetId: `eip155:8453/erc20:${ASSET}`, raw: "1500000" }, () => sendStep("s1", "withdraw", VAULT, withdrawData("withdraw", 1_500_000n, OWNER, OWNER)), /withdraw 1\.5 of the asset/],
    ["--all", { all: true }, { kind: "all" }, () => sendStep("s1", "redeem", VAULT, withdrawData("redeem", SHARES, OWNER, OWNER)), /redeem 5\.000000000000000001 shares/],
    ["--shares_exact", { shares_exact: "5.000000000000000001" }, { kind: "shares", raw: SHARES.toString() }, () => sendStep("s1", "redeem", VAULT, withdrawData("redeem", SHARES, OWNER, OWNER)), /redeem 5\.000000000000000001 shares/],
  ])("%s: the API is asked for exactly that form, and the checked step comes back with no deposit warning", async (_n, a, amount, step, said) => {
    const log: Log = [];
    const bodies: unknown[] = [];
    const out = await run(log, mcp(log, { withdraw: (i) => (bodies.push(i.body), withdrawReq(step(), amount)) }), "earn_prepare_withdraw", a);
    expect(bodies).toEqual([{ product: BASE_ID, amount }]);
    expect(out).toMatchObject({ requires_signature: true, status: "unsigned", chain: "base", requestId: "req_1" });
    expect(out.steps[0]).toMatchObject({ stepId: "s1", to: VAULT, value: "0" });
    expect(out.steps[0].description).toMatch(said);
    expect(out.warnings).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });

  it("a withdrawal paid to another account, or of another amount than asked, is refused", async () => {
    const log: Log = [];
    const assets = { kind: "assets", assetId: `eip155:8453/erc20:${ASSET}`, raw: "1500000" };
    await expect(fails(log, mcp(log, { withdraw: () => withdrawReq(sendStep("s1", "withdraw", VAULT, withdrawData("withdraw", 1_500_000n, STRANGER, OWNER)), assets) }), "earn_prepare_withdraw", { amount_usdc: "1.5" })).rejects.toThrow(/withdraw's receiver is not the owner/);
    await expect(fails(log, mcp(log, { withdraw: () => withdrawReq(sendStep("s1", "withdraw", VAULT, withdrawData("withdraw", 1_500_001n, OWNER, OWNER)), assets) }), "earn_prepare_withdraw", { amount_usdc: "1.5" })).rejects.toThrow(/not exactly the one asked for/);
  });

  it("exactly one form: none, or two, are refused before anything is asked; so is a receiver", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_prepare_withdraw", {})).rejects.toThrow(/give exactly one of --amount_usdc, --all or --shares_exact/);
    await expect(fails(log, mcp(log), "earn_prepare_withdraw", { all: true, shares_exact: "1" })).rejects.toThrow(/not --all and --shares_exact/);
    await expect(fails(log, mcp(log), "earn_prepare_withdraw", { amount_usdc: "1", all: true })).rejects.toThrow(/not --amount_usdc and --all/);
    await expect(fails(log, mcp(log), "earn_prepare_withdraw", { all: true, receiver: OWNER })).rejects.toThrow(/--receiver is taken only for a vault on Solana/);
    expect(log).toEqual([]);
  });
});

describe("earn submit", () => {
  const landed = () => req({ steps: [approveStep(), depositStep(OWNER)].map((s, i) => (i === 0 ? { ...s, state: "landed", verification: { hash: TX } } : s)) });

  it("hands the hash to the API with no wallet view, and answers with the request: the next step checked and ready", async () => {
    const log: Log = [];
    const calls: { path: unknown; body: unknown }[] = [];
    const out = await run(log, mcp(log, { submit: (i) => (calls.push(i), landed()) }), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX });
    expect(calls).toEqual([{ path: { requestId: "req_1", stepId: "s1" }, body: { kind: "transaction", txHash: TX, wallet: null } }]);
    expect(log).toEqual(["mcp:products", "mcp:submit@tok", "wallet:finish:true"]);
    expect(out).toMatchObject({ requestId: "req_1", checked: true, chain: "base" });
    expect(out.steps[0]).toMatchObject({ stepId: "s1", state: "landed", verification: { hash: TX } });
    expect(out.steps[1]).toMatchObject({ stepId: "s2", state: "ready", to: VAULT, data: depositData(RAW_25, OWNER) });
    expect(out.next_step).toMatch(/Send step s2/);
    expect(out.warnings).toEqual([WARNING]); // a deposit step ready to send carries them
  });

  it("with --nonce and --from (the connected wallet, checksummed) and --block, the wallet's view goes too", async () => {
    const log: Log = [];
    const bodies: unknown[] = [];
    await run(log, mcp(log, { submit: (i) => (bodies.push(i.body), landed()) }), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX, nonce: "7", from: OWNER.toLowerCase(), block: "123" });
    expect(bodies).toEqual([{ kind: "transaction", txHash: TX, wallet: { nonce: "7", from: OWNER, blockNumber: "123" } }]);
    bodies.length = 0;
    await run(log, mcp(log, { submit: (i) => (bodies.push(i.body), landed()) }), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX, nonce: "7", from: OWNER });
    expect(bodies).toEqual([{ kind: "transaction", txHash: TX, wallet: { nonce: "7", from: OWNER, blockNumber: null } }]);
  });

  it("refuses --from that is not the connected wallet, and half a wallet view, before anything is asked", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX, nonce: "7", from: STRANGER })).rejects.toThrow(/--from .* is not the connected wallet/);
    await expect(fails(log, mcp(log), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX, nonce: "7" })).rejects.toThrow(/give --nonce and --from together/);
    await expect(fails(log, mcp(log), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX, block: "1" })).rejects.toThrow(/--block goes with --nonce and --from/);
    expect(log).toEqual([]);
  });

  it("a refusal names its code and says not to send the transaction again", async () => {
    const log: Log = [];
    await expect(fails(log, mcp(log, { submit: () => refused("transfer_mismatch", "the transaction is not this step") }), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX })).rejects.toThrow(
      /transfer_mismatch: the transaction is not this step.*Do not send the transaction again: read the request with `treasury earn request --request_id req_1`/s,
    );
  });

  it("a next step that fails the check is refused, saying the hash was recorded", async () => {
    const log: Log = [];
    const bad = req({ steps: [{ ...approveStep(), state: "landed" }, depositStep(STRANGER)] });
    await expect(fails(log, mcp(log, { submit: () => bad }), "earn_submit", { request_id: "req_1", step_id: "s1", tx_hash: TX })).rejects.toThrow(
      /The API recorded transaction 0x7+ for step s1\. refused \(step 2 of 2\): the deposit's receiver is not the owner/,
    );
  });
});

describe("earn request", () => {
  it("reads by id, by transaction hash, and cancels by id; exactly one of id or hash", async () => {
    const log: Log = [];
    const seen: string[] = [];
    const m = mcp(log, {
      status: (i) => (seen.push(`status:${i.path.requestId}`), req({ steps: [approveStep(), waitingStep("s2", "s1")] })),
      status_lookup: (i) => (seen.push(`lookup:${i.query.txHash}`), req({ steps: [approveStep(), waitingStep("s2", "s1")] })),
      cancel: (i) => (seen.push(`cancel:${i.path.requestId}`), req({ state: "cancelled", steps: [approveStep(), waitingStep("s2", "s1")] })),
    });
    const byId = await run(log, m, "earn_request", { request_id: "req_1" });
    expect(byId).toMatchObject({ requestId: "req_1", checked: true, state: "requires_action" });
    expect(byId.steps[0].to).toBe(ASSET);
    expect((await run(log, m, "earn_request", { tx_hash: TX })).requestId).toBe("req_1");
    const cancelled = await run(log, m, "earn_request", { request_id: "req_1", cancel: true });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.next_step).toMatch(/is cancelled: there is nothing more to send/);
    expect(seen).toEqual(["status:req_1", `lookup:${TX}`, "cancel:req_1"]);
    await expect(fails(log, m, "earn_request", {})).rejects.toThrow(/exactly one/);
    await expect(fails(log, m, "earn_request", { request_id: "req_1", tx_hash: TX })).rejects.toThrow(/exactly one/);
    await expect(fails(log, m, "earn_request", { tx_hash: TX, cancel: true })).rejects.toThrow(/--cancel needs --request_id/);
  });

  it("a request for anything but a listed vault is shown with its states only, never with anything to send", async () => {
    const log: Log = [];
    // Steps and an amount that WOULD pass the check for the Base vault: only the product it names keeps them unshown.
    const portfolio = { ...req({ steps: [approveStep(), waitingStep("s2", "s1")] }), chose: { product: PORTFOLIO_ID, amount: ASSETS_25 } };
    const out = await run(log, mcp(log, { status: () => portfolio }), "earn_request", { request_id: "req_1" });
    expect(out.checked).toBe(false);
    expect(out.vault).toBeNull();
    expect(JSON.stringify(out)).not.toContain(PORTFOLIO_ID); // the API's product id is never shown
    expect(out.steps[0]).toMatchObject({ stepId: "s1", state: "ready" });
    expect(out.steps[0].to).toBeUndefined();
    expect(out.steps[0].data).toBeUndefined();
  });
});

describe("the command set", () => {
  it("earn_claim is gone; earn_submit and earn_request are there", () => {
    const names = Object.keys(buildCommands());
    expect(names).not.toContain("earn_claim");
    expect(names).toEqual(expect.arrayContaining(["earn_submit", "earn_request"]));
  });
});
