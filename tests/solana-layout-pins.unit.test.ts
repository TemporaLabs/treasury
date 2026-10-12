/**
 * Pins the Solana decoders' offsets and constants with values the recorded snapshot cannot provide. Its vault
 * holds no ctokens and owes no fees, so a field read from the wrong offset still decodes as 0 and agrees with
 * Kamino's SDK. Here each field gets a distinct value written at Kamino's offset, given as a literal (not
 * read back from src/solana/layout.ts), and the decoder must return exactly that value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getAddressEncoder } from "@solana/kit";
import { ctokensToLiquidity, decodeReserve, decodeVaultState, SF_ONE, totalSupplySf, type ReserveView } from "../src/solana/layout.js";
import { MAINNET_GENESIS_HASH } from "../src/solana/constants.js";
import { solanaCluster, type SolanaRpc } from "../src/solana/rpc.js";
import { readVault, tokenBalance } from "../src/solana/vault.js";
import { listSolanaVaults } from "../src/registry.js";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/solana/vault-snapshot.json", import.meta.url), "utf8")) as { slot: number; vault: string; accounts: Record<string, { data: string }> };
const bytes = (a: string) => Buffer.from(SNAP.accounts[a]!.data, "base64");
const SOME_KEY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const vault0 = decodeVaultState(new Uint8Array(bytes(SNAP.vault)));
const reserve0 = vault0.allocations[0]!.reserve;
const u128 = (b: Buffer, off: number, v: bigint) => {
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), off);
  b.writeBigUInt64LE(v >> 64n, off + 8);
};

describe("decoder offsets, against values the snapshot does not hold", () => {
  it("VaultState: tokenAvailable at 224, the first allocation's ctokenAllocation at 312 + 1104, permissioningAuthority at 58840", () => {
    const b = bytes(SNAP.vault);
    b.writeBigUInt64LE(111_111n, 224);
    b.writeBigUInt64LE(222_222n, 312 + 1_104);
    b.set(getAddressEncoder().encode(SOME_KEY as never), 58_840);
    const v = decodeVaultState(new Uint8Array(b));
    expect(v.tokenAvailable).toBe(111_111n);
    expect(v.allocations[0]!.ctokenAllocation).toBe(222_222n);
    expect(v.permissioningAuthority).toBe(SOME_KEY);
  });

  it("Reserve: accumulatedProtocolFeesSf at 344 and pendingReferrerFeesSf at 376, both u128", () => {
    const b = bytes(reserve0);
    u128(b, 344, (3n << 64n) + 5n);
    u128(b, 376, (7n << 64n) + 11n);
    const r = decodeReserve(new Uint8Array(b));
    expect(r.accumulatedProtocolFeesSf).toBe((3n << 64n) + 5n);
    expect(r.pendingReferrerFeesSf).toBe((7n << 64n) + 11n);
  });

  it("an SPL token account's amount is the u64 at 64, and nothing beside it", async () => {
    const acct = Buffer.alloc(165);
    acct.writeBigUInt64LE(777n, 56);
    acct.writeBigUInt64LE(123_456n, 64);
    acct.writeBigUInt64LE(999n, 72);
    const rpc = { getAccountInfo: () => ({ send: async () => ({ value: { data: [acct.toString("base64"), "base64"] } }) }) } as unknown as SolanaRpc;
    expect(await tokenBalance(rpc, SOME_KEY)).toEqual({ exists: true, amount: 123_456n });
  });
});

describe("the arithmetic on klend's scaled fractions", () => {
  // A reserve with every term of the supply distinct, scaled by 2^60 written out (not SF_ONE).
  const S = 2n ** 60n;
  const reserve = {
    totalAvailableAmount: 1_000n,
    borrowedAmountSf: 500n * S,
    accumulatedProtocolFeesSf: 10n * S,
    accumulatedReferrerFeesSf: 20n * S,
    pendingReferrerFeesSf: 30n * S,
    collateralMintTotalSupply: 880n,
  } as ReserveView;

  it("SF_ONE is 2^60", () => {
    expect(SF_ONE).toBe(1_152_921_504_606_846_976n);
  });

  it("total supply is available + borrowed − every fee bucket, pending referrer fees included", () => {
    expect(totalSupplySf(reserve)).toBe((1_000n + 500n - 10n - 20n - 30n) * S);
  });

  it("ctokens convert at total supply / ctoken supply, floored", () => {
    expect(ctokensToLiquidity(440n, reserve)).toBe(720n); // 440 × 1440 / 880
    expect(ctokensToLiquidity(1n, reserve)).toBe(1n); // 1440 / 880, floored
    expect(ctokensToLiquidity(1n, { ...reserve, collateralMintTotalSupply: 0n })).toBe(0n);
  });
});

describe("which cluster, and which vault", () => {
  const genesis = (hash: string) => ({ getGenesisHash: () => ({ send: async () => hash }) }) as unknown as SolanaRpc;

  it("mainnet's genesis hash, and an endpoint is mainnet only when it reports exactly that", async () => {
    expect(MAINNET_GENESIS_HASH).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    expect(await solanaCluster(genesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"))).toBe("mainnet");
    expect(await solanaCluster(genesis("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"))).toBe("other"); // devnet
  });

  it("readVault refuses a registry row whose share mint is not the vault's", async () => {
    const rpc = {
      getAccountInfo: (a: string) => ({ send: async () => ({ value: SNAP.accounts[String(a)] ? { data: [SNAP.accounts[String(a)]!.data, "base64"] } : null, context: { slot: BigInt(SNAP.slot) } }) }),
      getMultipleAccounts: (ks: string[]) => ({ send: async () => ({ value: ks.map((k) => ({ data: [SNAP.accounts[String(k)]!.data, "base64"] })), context: { slot: BigInt(SNAP.slot) } }) }),
    } as unknown as SolanaRpc;
    const row = listSolanaVaults()[0]!;
    await expect(readVault(rpc, row)).resolves.toBeDefined();
    await expect(readVault(rpc, { ...row, sharesMint: SOME_KEY })).rejects.toThrow(/disagrees with the chain: sharesMint/);
  });
});
