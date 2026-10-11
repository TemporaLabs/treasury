/**
 * The earn commands with a Solana vault in the shipped registry — what is decided before any RPC is read:
 * listing, resolution, and the refusals. The reads themselves are the live tier's (`live.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { buildCommands } from "../src/earn/commands.js";
import { listSolanaVaults } from "../src/registry.js";

type Handler = (a: unknown, extra: unknown) => Promise<string>;
const tools = () => buildCommands() as unknown as Record<string, { handler: Handler }>;
const run = async (name: string, args: Record<string, unknown>) => JSON.parse(await tools()[name]!.handler(args, {}));

const SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOL2 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const EVM = "0x1111111111111111111111111111111111111111";

describe("earn on Solana: listing and resolution", () => {
  it("earn_vaults lists Solana as a chain with its default, and the vault with a Solscan link and no chain id", async () => {
    const out = await run("earn_vaults", {});
    const v = listSolanaVaults()[0]!;
    expect(out.chains.at(-1)).toEqual({ chain: "solana", chainId: null, name: "Solana", default: v.symbol, defaultAccess: "open", depositable: [v.symbol] });
    expect(out.depositable).toContain(v.symbol);
    const row = out.vaults.find((x: { symbol: string }) => x.symbol === v.symbol);
    expect(row).toMatchObject({ chain: "solana", chainId: null, address: v.address, chassis: "kamino-vault", sharesMint: v.sharesMint, links: { explorer: `https://solscan.io/account/${v.address}` } });
    expect(row.warning).toMatch(/TEST VAULT/);
    // Base stays the default chain.
    expect(out.defaultChain).toBe("base");
  });

  it("an unknown chain names every chain with a vault, Solana included", async () => {
    await expect(run("earn_balance", { chain: "optimism", account: EVM })).rejects.toThrow(/chains with a vault: base, arbitrum, robinhood, ethereum, monad, solana/);
  });

  it("a Solana vault named with an EVM chain, and an EVM vault named with chain solana, are refused both ways", async () => {
    const v = listSolanaVaults()[0]!.symbol;
    await expect(run("earn_balance", { vault: v, chain: "base", account: SOL })).rejects.toThrow(/is on solana, not base/);
    await expect(run("earn_balance", { vault: "tlCashPlusUSDC2B", chain: "solana", account: SOL })).rejects.toThrow(/is on base, not solana/);
  });
});

describe("earn on Solana: refusals made before any read", () => {
  it("an EVM address for a vault on Solana, and a Solana address for a vault on an EVM chain", async () => {
    await expect(run("earn_balance", { chain: "solana", account: EVM })).rejects.toThrow(/must be a Solana address/);
    await expect(run("earn_balance", { chain: "base", account: SOL })).rejects.toThrow(/must be an EVM address/);
  });

  it("a receiver that is not the account: shares and withdrawals go only to the account on Solana", async () => {
    await expect(run("earn_prepare_deposit", { chain: "solana", account: SOL, receiver: SOL2, amount_usdc: "1" })).rejects.toThrow(/receiver must be the account itself/);
    await expect(run("earn_prepare_withdraw", { chain: "solana", account: SOL, receiver: SOL2, amount_usdc: "1" })).rejects.toThrow(/receiver must be the account itself/);
  });

  it("--all without --shares_exact is refused on Solana as on EVM", async () => {
    await expect(run("earn_prepare_withdraw", { chain: "solana", account: SOL, receiver: SOL, all: true })).rejects.toThrow(/--all requires --shares_exact/);
  });
});
