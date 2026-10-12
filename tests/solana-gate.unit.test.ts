/**
 * The Solana gate (`src/connect/gate-solana.ts`) against transactions built the way the confirm flow builds
 * them, from the committed mainnet snapshot, and against each way such a transaction could be altered.
 * Offline: no RPC. The blockhash is a fixed value; the gate never reads it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AccountRole, address, getAddressDecoder, type Instruction } from "@solana/kit";
import { admitSolana } from "../src/connect/gate-solana.js";
import { decodeReserve, decodeVaultState, vaultHoldings } from "../src/solana/layout.js";
import { compileUnsigned, createAtaIdempotentIx, setComputeUnitLimitIx } from "../src/solana/kvault.js";
import { depositInstructions, withdrawInstructions, type VaultRead } from "../src/solana/vault.js";
import { listSolanaVaults } from "../src/registry.js";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8"));
const bytes = (a: string) => new Uint8Array(Buffer.from(SNAP.accounts[a].data, "base64"));
const entry = listSolanaVaults().find((v) => v.address === SNAP.vault)!;
const state = decodeVaultState(bytes(SNAP.vault));
const reserves = new Map(state.allocations.map((a) => [a.reserve, decodeReserve(bytes(a.reserve))]));
const read: VaultRead = {
  entry,
  state,
  reserves,
  holdings: vaultHoldings(state, reserves),
  accounts: {
    vaultState: SNAP.vault,
    tokenVault: state.tokenVault,
    tokenMint: state.tokenMint,
    baseVaultAuthority: state.baseVaultAuthority,
    sharesMint: state.sharesMint,
    vaultReserves: state.allocations.map((a) => ({ reserve: a.reserve, lendingMarket: reserves.get(a.reserve)!.lendingMarket })),
  },
  slot: BigInt(SNAP.slot),
};

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const ACCOUNT = key(201);
const OTHER = key(202);
const LIFE = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n };
const wire = (ixs: readonly Instruction[], payer: string = ACCOUNT) => compileUnsigned(ixs, payer, LIFE).base64;

describe("the Solana gate admits what the confirm flow builds", () => {
  it("control: the vault in the snapshot is the registry's Solana vault", () => {
    expect(entry?.symbol).toBe("tlCashPlusUSDC2G");
  });

  it("a deposit: the share account, then one deposit, for the connected account", async () => {
    const a = await admitSolana(wire(await depositInstructions(read, ACCOUNT, 2_000_000n)), ACCOUNT);
    expect(a).toMatchObject({ kind: "deposit", amount: 2_000_000n });
    expect(a.vault.address).toBe(SNAP.vault);
  });

  it("a withdrawal: its legs' shares are summed", async () => {
    const shares = read.state.sharesIssued; // everything: needs more than idle, so more than one leg when reserves hold some
    const a = await admitSolana(wire(await withdrawInstructions(read, ACCOUNT, shares)), ACCOUNT);
    expect(a).toMatchObject({ kind: "withdraw", amount: shares });
  });
});

describe("a vault that requires a co-signer", () => {
  it("is refused at build time, for a deposit and for a withdrawal: this client builds single-signer transactions", async () => {
    const cosigned: VaultRead = { ...read, state: { ...read.state, permissioningAuthority: key(90) } };
    await expect(depositInstructions(cosigned, ACCOUNT, 1_000_000n)).rejects.toThrow(/requires a co-signer/);
    await expect(withdrawInstructions(cosigned, ACCOUNT, 1_000_000n)).rejects.toThrow(/requires a co-signer/);
  });
});

describe("the Solana gate refuses", () => {
  const deposit = () => depositInstructions(read, ACCOUNT, 1_000_000n);
  const refused = async (ixs: Instruction[], why: RegExp, payer?: string) => expect(admitSolana(wire(ixs, payer), ACCOUNT)).rejects.toThrow(why);

  it("a fee payer other than the connected account", async () => {
    await refused(await depositInstructions(read, OTHER, 1_000_000n), /fee payer/, OTHER);
  });

  it("a deposit that acts for another account inside a transaction the connected account pays for", async () => {
    await refused([setComputeUnitLimitIx(400_000), ...(await depositInstructions(read, OTHER, 1_000_000n)).slice(1)], /signers|sign/);
  });

  it("any other program — a SOL transfer appended to a real deposit", async () => {
    const transfer: Instruction = {
      programAddress: address("11111111111111111111111111111111"),
      accounts: [
        { address: address(ACCOUNT), role: AccountRole.WRITABLE_SIGNER },
        { address: address(OTHER), role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([2, 0, 0, 0, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]),
    };
    await refused([...(await deposit()), transfer], /calls 11111111111111111111111111111111/);
  });

  it("a compute-unit PRICE (a priority fee the operator did not agree to)", async () => {
    const price: Instruction = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) };
    await refused([price, ...(await deposit())], /only a compute-unit limit/);
  });

  it("a token account created for someone else", async () => {
    const [cu, , dep] = await deposit();
    await refused([cu!, await createAtaIdempotentIx(OTHER, state.sharesMint), dep!], /sign|token account/);
  });

  it("a vault that is not in the registry", async () => {
    const [cu, ata, dep] = await deposit();
    const forged = { ...dep!, accounts: dep!.accounts!.map((m, i) => (i === 1 ? { ...m, address: address(key(77)) } : m)) };
    await refused([cu!, ata!, forged], /not a vault in the registry/);
  });

  it("a deposit paying from a token account that is not the connected account's own", async () => {
    const [cu, ata, dep] = await deposit();
    const forged = { ...dep!, accounts: dep!.accounts!.map((m, i) => (i === 6 ? { ...m, address: address(key(78)) } : m)) };
    await refused([cu!, ata!, forged], /not the connected account's own/);
  });

  it("a token vault or vault authority that is not the vault's own PDA", async () => {
    const [cu, ata, dep] = await deposit();
    for (const i of [2, 4]) {
      const forged = { ...dep!, accounts: dep!.accounts!.map((m, j) => (j === i ? { ...m, address: address(key(79)) } : m)) };
      await refused([cu!, ata!, forged], /token vault or vault authority/);
    }
  });

  it("a withdrawal whose second vault state is not the vault", async () => {
    const w = await withdrawInstructions(read, ACCOUNT, 1_000_000n);
    const leg = w[2]!;
    const forged = { ...leg, accounts: leg.accounts!.map((m, j) => (j === 14 ? { ...m, address: address(key(80)) } : m)) };
    await refused([w[0]!, w[1]!, forged], /second vault state/);
  });

  it("a deposit and a withdrawal together, and two deposits", async () => {
    const w = await withdrawInstructions(read, ACCOUNT, 1_000_000n);
    await refused([...(await deposit()), w[2]!], /a deposit and a withdrawal/);
    const d = await deposit();
    await refused([...d, d[2]!], /two deposits/);
  });

  const swap = (ix: Instruction, at: number, to: string): Instruction => ({ ...ix, accounts: ix.accounts!.map((m, i) => (i === at ? { ...m, address: address(to) } : m)) });

  it("a withdrawal paying into a token account that is not the connected account's own", async () => {
    const [cu, ata, leg] = await withdrawInstructions(read, ACCOUNT, 1_000_000n);
    await refused([cu!, ata!, swap(leg!, 5, key(81))], /pays into .* not the connected account's own/);
  });

  it("a share account that is not the connected account's own, on a deposit and on a withdrawal", async () => {
    const [cu, ata, dep] = await deposit();
    await refused([cu!, ata!, swap(dep!, 7, key(82))], /as the share account/);
    const [wcu, wata, leg] = await withdrawInstructions(read, ACCOUNT, 1_000_000n);
    await refused([wcu!, wata!, swap(leg!, 7, key(82))], /as the share account/);
  });

  it("a token or share mint that is not the vault's", async () => {
    const [cu, ata, dep] = await deposit();
    await refused([cu!, ata!, swap(dep!, 3, key(83))], /token or share mint/);
    await refused([cu!, ata!, swap(dep!, 5, key(83))], /token or share mint/);
    const [wcu, wata, leg] = await withdrawInstructions(read, ACCOUNT, 1_000_000n);
    await refused([wcu!, wata!, swap(leg!, 6, key(83))], /token or share mint/);
    await refused([wcu!, wata!, swap(leg!, 8, key(83))], /token or share mint/);
  });

  it("a token account the connected account pays for but someone else owns", async () => {
    const [cu, ata, dep] = await deposit();
    await refused([cu!, swap(ata!, 2, OTHER), dep!], /creates a token account for/);
  });

  it("a token-account creation naming another program", async () => {
    const [cu, ata, dep] = await deposit();
    await refused([cu!, swap(ata!, 4, key(84)), dep!], /unexpected program/);
    await refused([cu!, swap(ata!, 5, key(84)), dep!], /unexpected program/);
  });

  it("the connected account's own token account, but for a mint that is not this vault's", async () => {
    const [cu, ata, dep] = await deposit();
    await refused([cu!, ata!, await createAtaIdempotentIx(ACCOUNT, key(85)), dep!], /created for .* not this vault's/);
  });

  it("a zero amount", async () => {
    await refused(await depositInstructions(read, ACCOUNT, 0n), /moves 0/);
  });

  it("bytes that are not a transaction", async () => {
    await expect(admitSolana("AAAA", ACCOUNT)).rejects.toThrow(/does not decode/);
  });
});
