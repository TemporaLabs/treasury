/**
 * The Solana deposit pre-flight's verdicts, and the withdrawal's split across reserves, against the recorded
 * mainnet snapshot with the vault state patched where a test needs a different one.
 *
 * `canDeposit` is a yes only when the simulation reached the vault and the vault did not refuse: a
 * simulation that stopped at the fee never got there, and a deposit over the cap is refused there once it is
 * funded. A co-signer refuses every deposit this client builds, and says so in full.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getAddressEncoder } from "@solana/kit";
import { listSolanaVaults } from "../src/registry.js";
import { associatedTokenAccount } from "../src/solana/kvault.js";
import { preflightDepositSolana, readVault, withdrawInstructions, type VaultRead } from "../src/solana/vault.js";
import { DISCRIMINATORS } from "../src/solana/kvault.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as { slot: number; vault: string; accounts: Record<string, { data: string }> };
const ACCOUNT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const CO_SIGNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // any address but the default one
const vault = listSolanaVaults()[0]!;

const tokenAccount = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return [b.toString("base64"), "base64"];
};

/**
 * A mock RPC over the snapshot. `patch` rewrites the vault state's bytes (offsets into the account data);
 * `sim` is what the deposit simulation reports.
 */
function mockRpc(opts: { patch?: (b: Buffer) => void; usdc?: bigint; sim: { err: unknown; logs?: string[] } }) {
  const vaultBytes = Buffer.from(fx.accounts[fx.vault]!.data, "base64");
  opts.patch?.(vaultBytes);
  let tokenAta = "";
  const ready = associatedTokenAccount(ACCOUNT, vault.asset.address).then((a) => (tokenAta = a));
  return ready.then(
    () =>
      ({
        getAccountInfo: (a: string) => ({
          send: async () => {
            const k = String(a);
            const data = k === fx.vault ? [vaultBytes.toString("base64"), "base64"] : fx.accounts[k] ? [fx.accounts[k]!.data, "base64"] : k === tokenAta && opts.usdc !== undefined ? tokenAccount(opts.usdc) : undefined;
            return { value: data ? { data } : null, context: { slot: BigInt(fx.slot) } };
          },
        }),
        getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: [fx.accounts[String(k)]!.data, "base64"] })), context: { slot: BigInt(fx.slot) } }) }),
        simulateTransaction: (_tx: string, cfg: { accounts: { addresses: string[] } }) => ({
          send: async () => ({
            context: { slot: BigInt(fx.slot) },
            value: { err: opts.sim.err, logs: opts.sim.logs ?? [], unitsConsumed: 100_000n, accounts: cfg.accounts.addresses.map(() => (opts.sim.err === null ? { data: tokenAccount(999_000n) } : null)) },
          }),
        }),
      }) as unknown as SolanaRpc,
  );
}

const pubkeyAt = (b: Buffer, offset: number, a: string) => b.set(getAddressEncoder().encode(a as never), offset);
// VaultState offsets, as Kamino lays the account out (see src/solana/layout.ts): permissioningAuthority, depositCap.
const PERMISSIONING_AUTHORITY = 58_840;
const DEPOSIT_CAP = 58_736;

describe("preflightDepositSolana", () => {
  it("OPEN_READY with canDeposit when the simulated deposit succeeds", async () => {
    const r = await preflightDepositSolana(await mockRpc({ usdc: 5_000_000n, sim: { err: null } }), vault, ACCOUNT, "1");
    expect(r.status).toBe("OPEN_READY");
    expect(r.canDeposit).toBe(true);
  });

  it("NEEDS_FUNDS with canDeposit when the deposit reached the account's own USDC: the vault did not refuse it", async () => {
    const r = await preflightDepositSolana(await mockRpc({ sim: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] } }), vault, ACCOUNT, "1");
    expect(r.status).toBe("NEEDS_FUNDS");
    expect(r.canDeposit).toBe(true);
  });

  it("NEEDS_FUNDS WITHOUT canDeposit when the simulation stopped at the fee: it never reached the vault", async () => {
    const r = await preflightDepositSolana(await mockRpc({ sim: { err: "AccountNotFound" } }), vault, ACCOUNT, "1");
    expect(r.status).toBe("NEEDS_FUNDS");
    expect(r.canDeposit).toBe(false);
    expect(r.findings.at(-1)).toMatch(/holds no SOL.*not checked/);
  });

  it("no canDeposit for a deposit over the vault's cap, even where the simulation stopped at the account's USDC", async () => {
    const rpc = await mockRpc({ patch: (b) => b.writeBigUInt64LE(1n, DEPOSIT_CAP), sim: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] } });
    const r = await preflightDepositSolana(rpc, vault, ACCOUNT, "1");
    expect(r.status).toBe("NEEDS_FUNDS");
    expect(r.canDeposit).toBe(false);
    expect(r.findings.join("\n")).toMatch(/deposit cap/);
  });

  it("a co-signer is REVERTED_OTHER, with the whole reason, not an unresolved transport failure", async () => {
    const rpc = await mockRpc({ patch: (b) => pubkeyAt(b, PERMISSIONING_AUTHORITY, CO_SIGNER), sim: { err: null } });
    const r = await preflightDepositSolana(rpc, vault, ACCOUNT, "1");
    expect(r.status).toBe("REVERTED_OTHER");
    expect(r.canDeposit).toBe(false);
    // the full sentence, not one cut at a length limit
    expect(r.findings.at(-1)).toBe(`${vault.symbol} now requires a co-signer (permissioning authority ${CO_SIGNER}) for every deposit and withdrawal, and this client builds single-signer transactions only.`);
  });
});

/** The reserve each withdraw instruction names (account 15: `withdrawFromReserveAccounts.reserve`). */
const legReserves = (ixs: Awaited<ReturnType<typeof withdrawInstructions>>) =>
  ixs.filter((ix) => ix.data !== undefined && DISCRIMINATORS.withdraw.every((x, i) => ix.data![i] === x)).map((ix) => String(ix.accounts![15]!.address));
const legShares = (ixs: Awaited<ReturnType<typeof withdrawInstructions>>) =>
  ixs.filter((ix) => ix.data !== undefined && DISCRIMINATORS.withdraw.every((x, i) => ix.data![i] === x)).map((ix) => Buffer.from(ix.data!).readBigUInt64LE(8));

describe("withdrawInstructions: the split across reserves", () => {
  it("one leg when the vault can pay it all at once: idle covers it", async () => {
    const v = await readVault(await mockRpc({ sim: { err: null } }), vault);
    expect(v.holdings.idle).toBeGreaterThan(10_000_000n);
    const ixs = await withdrawInstructions(v, ACCOUNT, 10_000_000n);
    expect(legShares(ixs)).toEqual([10_000_000n]);
    expect(legReserves(ixs)).toHaveLength(1);
  });

  it("the last reserve in order takes the rest, so no reserve gets two legs when an earlier one can release nothing", async () => {
    const read = await readVault(await mockRpc({ sim: { err: null } }), vault);
    const [r1, r2] = read.state.allocations.map((a) => a.reserve) as [string, string];
    const r3 = fx.vault; // any valid address: a third reserve, a copy of r2's view
    const reserves = new Map(read.reserves);
    reserves.set(r1, { ...reserves.get(r1)!, totalAvailableAmount: 10n ** 15n });
    reserves.set(r2, { ...reserves.get(r2)!, totalAvailableAmount: 0n });
    reserves.set(r3, { ...reserves.get(r2)!, totalAvailableAmount: 0n });
    const v: VaultRead = {
      ...read,
      state: { ...read.state, sharesIssued: 60_000_000n, allocations: [...read.state.allocations, { ...read.state.allocations[1]!, reserve: r3 }] },
      reserves,
      holdings: { idle: 0n, byReserve: new Map([[r1, 60_000_000n], [r2, 0n], [r3, 0n]]), aumIncludingFees: 60_000_000n, pendingFees: 0n, netAum: 60_000_000n },
      accounts: { ...read.accounts, vaultReserves: [...read.accounts.vaultReserves, { reserve: r3, lendingMarket: reserves.get(r2)!.lendingMarket }] },
    };
    const ixs = await withdrawInstructions(v, ACCOUNT, 120_000_000n);
    expect(legReserves(ixs)).toEqual([r1, r3]);
    expect(legShares(ixs)).toEqual([60_000_000n, 60_000_000n]);
  });
});
