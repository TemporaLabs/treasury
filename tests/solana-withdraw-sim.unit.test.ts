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
import { readVault, withdrawInstructions } from "../src/solana/vault.js";
import { DISCRIMINATORS } from "../src/solana/kvault.js";
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

/** What the next simulation reports: the shares it burns and the USDC it pays, or the program's error. */
let simulated: { burns: bigint; pays: bigint; err?: unknown };
/** Results for the next simulations, in order, before `simulated` applies again. */
let then: (typeof simulated)[] = [];
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
    send: async () => {
      const s = then.shift() ?? simulated;
      return {
        context: { slot: BigInt(fx.slot) },
        value: {
          err: s.err ?? null,
          logs: [],
          unitsConsumed: 100_000n,
          accounts: cfg.accounts.addresses.map((a) => ({ data: String(a) === sharesAta ? tokenAccount(HELD - s.burns) : tokenAccount(s.pays) })),
        },
      };
    },
  }),
};

vi.mock("../src/solana/rpc.js", async (load) => ({ ...(await load<typeof import("../src/solana/rpc.js")>()), makeSolanaRpc: () => rpc }));
const { solanaBalance, solanaPrepareWithdraw, solanaQuoteWithdraw } = await import("../src/earn/solana.js");
const { buildForIntent } = await import("../src/connect/solana.js");

/** The shares `amountHuman` USDC needs at the snapshot, as the commands compute it. */
async function sharesFor(amountHuman: string): Promise<bigint> {
  const v = await readVault(rpc as unknown as SolanaRpc, vault);
  const amount = BigInt(Math.round(Number(amountHuman) * 1e6));
  return (amount * v.state.sharesIssued + v.holdings.netAum - 1n) / v.holdings.netAum;
}

/** The withdraw instructions a withdrawal of `shares` is split into at the snapshot. */
async function legsFor(shares: bigint): Promise<bigint> {
  const v = await readVault(rpc as unknown as SolanaRpc, vault);
  const ixs = await withdrawInstructions(v, ACCOUNT, shares);
  return BigInt(ixs.filter((ix) => ix.data !== undefined && DISCRIMINATORS.withdraw.every((x, i) => ix.data![i] === x)).length);
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

  it("earn prepare_withdraw by amount: one share unit short per withdraw instruction is rounding; one more is a capped leg", async () => {
    const shares = await sharesFor("5");
    const legs = await legsFor(shares);
    expect(legs).toBeGreaterThan(0n);
    simulated = { burns: shares - legs, pays: 5_000_000n };
    const env = (await solanaPrepareWithdraw(vault, ACCOUNT, ACCOUNT, { amountHuman: "5" })) as { kind: string };
    expect(env.kind).toBe("withdraw");
    simulated = { burns: shares - legs - 1n, pays: 5_000_000n };
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
    // The operator decides whether to try a smaller amount; the note does not pick one.
    expect(capped.note).toMatch(/Ask the operator whether to withdraw a smaller amount/);
  });

  it("earn balance: a full exit is reported only when every share burns; a capped one reports only what a simulated smaller withdrawal pays", async () => {
    const legs = await legsFor(HELD);
    simulated = { burns: HELD - legs, pays: 51_000_000n };
    const full = (await solanaBalance(vault, ACCOUNT)) as { exit: { exitableNow: string; measuredAs: string } };
    expect(full.exit.measuredAs).toBe("a simulated full withdrawal");
    expect(full.exit.exitableNow).toBe("51 USDC");

    type Exit = { exit: { exitableNow: string; measuredAs: string; note: string } };
    // Capped: 25 of the 50 shares burn. A withdrawal of those 25 alone is then simulated; it burns them all.
    then = [{ burns: HELD / 2n, pays: 25_500_000n }, { burns: HELD / 2n, pays: 25_400_000n }];
    const part = (await solanaBalance(vault, ACCOUNT)) as Exit;
    expect(then).toEqual([]);
    expect(part.exit.measuredAs).toBe("a simulated partial withdrawal");
    expect(part.exit.exitableNow).toBe("25.4 USDC");
    expect(part.exit.note).toMatch(/a full withdrawal cannot be prepared now: .*burns 25 of the 50 shares asked for/);

    // Capped, and the withdrawal of the 25 shares caps too: nothing is reported as withdrawable.
    then = [{ burns: HELD / 2n, pays: 25_500_000n }, { burns: HELD / 4n, pays: 12_750_000n }];
    const capped = (await solanaBalance(vault, ACCOUNT)) as Exit;
    expect(capped.exit.measuredAs).toBe("a capped withdrawal");
    expect(capped.exit.exitableNow).toBe("unknown");
    expect(capped.exit.note).toMatch(/A smaller withdrawal was not found to fit/);
  });

  it("connect withdraw: the transaction for the acknowledged shares is refused before any page opens when a leg is capped", async () => {
    const intent = { kind: "withdraw" as const, vault, raw: 10_000_000n };
    simulated = { burns: 10_000_000n, pays: 10_200_000n };
    const built = await buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT);
    expect(built.wire.length).toBeGreaterThan(0);

    const legs = await legsFor(intent.raw);
    simulated = { burns: intent.raw - legs, pays: 10_199_999n };
    expect((await buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).wire.length).toBeGreaterThan(0);
    simulated = { burns: intent.raw - legs - 1n, pays: 10_199_998n };
    await expect(buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).rejects.toThrow(/refused: .*partial withdrawal/);
  });

  it("connect deposit: built when the simulation succeeds, refused when it fails, with no share check", async () => {
    const intent = { kind: "deposit" as const, vault, raw: 1_000_000n };
    simulated = { burns: 0n, pays: 0n };
    expect((await buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).wire.length).toBeGreaterThan(0);
    simulated = { burns: 0n, pays: 0n, err: { InstructionError: [2, { Custom: 1 }] } };
    await expect(buildForIntent(rpc as unknown as SolanaRpc, intent, ACCOUNT)).rejects.toThrow(/the simulated deposit fails/);
  });
});
