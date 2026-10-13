/**
 * Two checks the Solana money paths make that no other test reached:
 * - the connect flow refuses a built transaction whose amount is not the one the operator acknowledged;
 * - a withdrawal by amount burns the shares worth AT LEAST that amount (rounded up), which only shows on a
 *   vault whose share price is not exactly 1, as the snapshot's is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { SOLANA_INFO } from "../src/client.js";
import { listSolanaVaults } from "../src/registry.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as { slot: number; vault: string; accounts: Record<string, { data: string }> };
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const vault = listSolanaVaults()[0]!;

/** The vault state's sharesIssued (u64 at 232); the snapshot's equals its assets, a price of exactly 1. */
let sharesIssued: bigint | undefined;
const vaultData = () => {
  const b = Buffer.from(fx.accounts[fx.vault]!.data, "base64");
  if (sharesIssued !== undefined) b.writeBigUInt64LE(sharesIssued, 232);
  return [b.toString("base64"), "base64"];
};
const tokenAccount = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return [b.toString("base64"), "base64"];
};
const rpc = {
  getAccountInfo: (a: string) => ({
    send: async () => {
      const k = String(a);
      const data = k === fx.vault ? vaultData() : fx.accounts[k] ? [fx.accounts[k]!.data, "base64"] : tokenAccount(100_000_000n);
      return { value: { data }, context: { slot: BigInt(fx.slot) } };
    },
  }),
  getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: [fx.accounts[String(k)]!.data, "base64"] })), context: { slot: BigInt(fx.slot) } }) }),
  getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1150n } }) }),
  getBlockHeight: () => ({ send: async () => 1000n }),
  simulateTransaction: (_tx: string, cfg: { accounts: { addresses: string[] } }) => ({
    send: async () => ({ context: { slot: BigInt(fx.slot) }, value: { err: null, logs: [], unitsConsumed: 100_000n, accounts: cfg.accounts.addresses.map(() => ({ data: tokenAccount(100_000_000n) })) } }),
  }),
};

/** When set, the deposit is built for this many base units more than asked: a builder that drifted. */
let drift = 0n;
vi.mock("../src/solana/rpc.js", async (load) => ({ ...(await load<typeof import("../src/solana/rpc.js")>()), makeSolanaRpc: () => rpc }));
vi.mock("../src/solana/vault.js", async (load) => {
  const actual = await load<typeof import("../src/solana/vault.js")>();
  return { ...actual, depositInstructions: (v: Parameters<typeof actual.depositInstructions>[0], user: string, amount: bigint) => actual.depositInstructions(v, user, amount + drift) };
});
const { buildForIntent } = await import("../src/connect/solana.js");
const { solanaQuoteWithdraw } = await import("../src/earn/solana.js");

beforeEach(() => {
  for (const k of SOLANA_INFO.rpcEnv) delete process.env[k];
  drift = 0n;
  sharesIssued = undefined;
});

describe("buildForIntent", () => {
  it("builds the acknowledged deposit, and refuses a transaction built for a different amount", async () => {
    const intent = { kind: "deposit" as const, vault, raw: 1_000_000n };
    expect((await buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).wire.length).toBeGreaterThan(0);
    drift = 1n;
    await expect(buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).rejects.toThrow(/refused: the transaction built \(deposit 1000001 .*is not the one acknowledged \(deposit 1000000/);
  });
});

describe("a withdrawal by amount", () => {
  it("burns the shares worth at least the amount: rounded up, not down", async () => {
    // 15,001,000 base units of assets over 15,000,000 shares: 5 USDC is 4,999,666.67 shares, so 4,999,667.
    sharesIssued = 15_000_000n;
    const q = (await solanaQuoteWithdraw(vault, ACCOUNT, "5")) as { sharesToBurn: string };
    expect(q.sharesToBurn).toBe(`4.999667 ${vault.symbol}`);
  });
});
