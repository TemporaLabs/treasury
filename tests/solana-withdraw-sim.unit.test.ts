/**
 * A Solana withdrawal is simulated before it is handed over, and the simulation must burn every share asked
 * for. Kamino's program caps a withdraw leg it cannot pay in full instead of failing it, so a simulation that
 * succeeds can still describe a partial withdrawal: the quote, the prepared transaction and the connect flow
 * must all refuse it rather than hand it to a signer.
 *
 * The vault and its reserves are the recorded mainnet snapshot; the account's token balances and what the
 * simulation reports are set by each test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SOLANA_INFO } from "../src/client.js";
import { listSolanaVaults } from "../src/registry.js";
import { associatedTokenAccount } from "../src/solana/kvault.js";
import { readVault } from "../src/solana/vault.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as {
  slot: number;
  accounts: Record<string, { data: string }>;
};
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const HELD = 50_000_000n; // the account's shares before the withdrawal
const vault = listSolanaVaults()[0]!;

/** An SPL token account holding `amount`: only the u64 at offset 64 is read. */
const tokenAccount = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return [b.toString("base64"), "base64"];
};

/** What the next simulation reports: the shares it burns and the USDC it pays. */
let simulated: { burns: bigint; pays: bigint };
let sharesAta = "";
let tokenAta = "";

const rpc = {
  getAccountInfo: (a: string) => ({
    send: async () => {
      const k = String(a);
      const data = fx.accounts[k] ? [fx.accounts[k]!.data, "base64"] : k === sharesAta ? tokenAccount(HELD) : k === tokenAta ? tokenAccount(0n) : undefined;
      return { value: data ? { data } : null, context: { slot: BigInt(fx.slot) } };
    },
  }),
  getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: [fx.accounts[String(k)]!.data, "base64"] })), context: { slot: BigInt(fx.slot) } }) }),
  getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1150n } }) }),
  getBlockHeight: () => ({ send: async () => 1000n }),
  simulateTransaction: (_tx: string, cfg: { accounts: { addresses: string[] } }) => ({
    send: async () => ({
      context: { slot: BigInt(fx.slot) },
      value: {
        err: null,
        logs: [],
        unitsConsumed: 100_000n,
        accounts: cfg.accounts.addresses.map((a) => ({ data: String(a) === sharesAta ? tokenAccount(HELD - simulated.burns) : tokenAccount(simulated.pays) })),
      },
    }),
  }),
};

vi.mock("../src/solana/rpc.js", async (load) => ({ ...(await load<typeof import("../src/solana/rpc.js")>()), makeSolanaRpc: () => rpc }));
const { solanaPrepareWithdraw, solanaQuoteWithdraw } = await import("../src/earn/solana.js");
const { buildForIntent } = await import("../src/connect/solana.js");

/** The shares `amountHuman` USDC needs at the snapshot, as the commands compute it. */
async function sharesFor(amountHuman: string): Promise<bigint> {
  const v = await readVault(rpc as unknown as SolanaRpc, vault);
  const amount = BigInt(Math.round(Number(amountHuman) * 1e6));
  return (amount * v.state.sharesIssued + v.holdings.netAum - 1n) / v.holdings.netAum;
}

beforeEach(async () => {
  for (const k of SOLANA_INFO.rpcEnv) delete process.env[k];
  sharesAta = await associatedTokenAccount(ACCOUNT, vault.sharesMint);
  tokenAta = await associatedTokenAccount(ACCOUNT, vault.asset.address);
});

describe("a Solana withdrawal whose simulation burns fewer shares than asked for is refused", () => {
  it("earn prepare_withdraw: prepared when every share burns, refused when a leg is capped", async () => {
    simulated = { burns: 10_000_000n, pays: 10_200_000n };
    const env = (await solanaPrepareWithdraw(vault, ACCOUNT, ACCOUNT, { sharesExact: "10" })) as { kind: string; transaction: { wire: string } };
    expect(env.kind).toBe("withdraw");
    expect(env.transaction.wire.length).toBeGreaterThan(0);

    simulated = { burns: 9_000_000n, pays: 9_180_000n };
    await expect(solanaPrepareWithdraw(vault, ACCOUNT, ACCOUNT, { sharesExact: "10" })).rejects.toThrow(/not prepared: .*burns 9 of the 10 shares asked for.*partial withdrawal/);
  });

  it("earn prepare_withdraw by amount: refused when the simulation burns one share unit short", async () => {
    const shares = await sharesFor("5");
    simulated = { burns: shares - 1n, pays: 5_000_000n };
    await expect(solanaPrepareWithdraw(vault, ACCOUNT, ACCOUNT, { amountHuman: "5" })).rejects.toThrow(/partial withdrawal/);
  });

  it("earn quote --direction withdraw: canWithdraw is false, with the reason, when a leg is capped", async () => {
    const shares = await sharesFor("5");
    simulated = { burns: shares, pays: 5_000_000n };
    const full = (await solanaQuoteWithdraw(vault, ACCOUNT, "5")) as { canWithdraw: boolean; receives?: string };
    expect(full.canWithdraw).toBe(true);
    expect(full.receives).toBe("5 USDC");

    simulated = { burns: shares / 2n, pays: 2_500_000n };
    const capped = (await solanaQuoteWithdraw(vault, ACCOUNT, "5")) as { canWithdraw: boolean; note: string; receives?: string };
    expect(capped.canWithdraw).toBe(false);
    expect(capped.receives).toBeUndefined();
    expect(capped.note).toMatch(/partial withdrawal/);
  });

  it("connect withdraw: the transaction for the acknowledged shares is refused before any page opens when a leg is capped", async () => {
    const intent = { kind: "withdraw" as const, vault, raw: 10_000_000n };
    simulated = { burns: 10_000_000n, pays: 10_200_000n };
    const built = await buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT);
    expect(built.wire.length).toBeGreaterThan(0);

    simulated = { burns: 9_999_999n, pays: 10_199_999n };
    await expect(buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).rejects.toThrow(/refused: .*partial withdrawal/);
  });
});
