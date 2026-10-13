/**
 * The Solana builders and decoders against Kamino's OWN SDK.
 *
 * `vendor/kamino/instruction-fixtures.json` and `decode-fixtures.json` were written by Kamino's SDK
 * (`vendor/kamino/generate-fixtures.mjs`, version in `vendor/kamino/PINNED`) from the committed mainnet
 * snapshot `tests/fixtures/solana/vault-snapshot.json`. Every byte and every account meta (address, role,
 * order) built here must equal what that SDK built; every decoded field must equal what it decoded.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createAtaIdempotentIx, depositIx, withdrawIx, associatedTokenAccount, vaultPdas, DISCRIMINATORS, setComputeUnitLimitIx, type VaultAccounts } from "../src/solana/kvault.js";
import { decodeReserve, decodeVaultState, vaultHoldings } from "../src/solana/layout.js";
import { createHash } from "node:crypto";

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const IX = json("../vendor/kamino/instruction-fixtures.json");
const DEC = json("../vendor/kamino/decode-fixtures.json");
const SNAP = json("./fixtures/solana/vault-snapshot.json");
const bytes = (a: string) => new Uint8Array(Buffer.from(SNAP.accounts[a].data, "base64"));
const shape = (ix: { programAddress: string; accounts?: readonly { address: string; role: number }[]; data?: Uint8Array | ArrayLike<number> }) => ({
  programAddress: ix.programAddress,
  accounts: (ix.accounts ?? []).map((m) => ({ address: m.address, role: m.role })),
  data: Buffer.from(ix.data as Uint8Array).toString("hex"),
});

const vault = decodeVaultState(bytes(SNAP.vault));
const reserves = new Map(vault.allocations.map((a) => [a.reserve, decodeReserve(bytes(a.reserve))]));
const vaultReserves = vault.allocations.map((a) => ({ reserve: a.reserve, lendingMarket: reserves.get(a.reserve)!.lendingMarket }));

async function accounts(user: string) {
  const common: VaultAccounts = {
    vaultState: SNAP.vault,
    tokenVault: vault.tokenVault,
    tokenMint: vault.tokenMint,
    baseVaultAuthority: vault.baseVaultAuthority,
    sharesMint: vault.sharesMint,
    vaultReserves,
  };
  return {
    common,
    userTokenAta: await associatedTokenAccount(user, vault.tokenMint),
    userSharesAta: await associatedTokenAccount(user, vault.sharesMint),
  };
}

describe("instructions — byte for byte what Kamino's SDK builds", () => {
  it("deposit(max_amount)", async () => {
    const a = await accounts(IX.user);
    const ix = await depositIx({ ...a.common, user: IX.user, userTokenAta: a.userTokenAta, userSharesAta: a.userSharesAta, maxAmount: BigInt(IX.deposit.maxAmount) });
    expect(shape(ix)).toEqual(IX.deposit.ix);
  });

  it("withdraw(shares_amount) from one reserve", async () => {
    const a = await accounts(IX.user);
    const r = reserves.get(IX.withdraw.reserve)!;
    const ix = await withdrawIx({
      ...a.common,
      user: IX.user,
      userTokenAta: a.userTokenAta,
      userSharesAta: a.userSharesAta,
      sharesAmount: BigInt(IX.withdraw.sharesAmount),
      reserve: { reserve: IX.withdraw.reserve, lendingMarket: r.lendingMarket, liquiditySupplyVault: r.liquiditySupplyVault, collateralMint: r.collateralMint },
    });
    expect(shape(ix)).toEqual(IX.withdraw.ix);
  });

  it("the share account a first deposit creates, idempotently", async () => {
    expect(shape(await createAtaIdempotentIx(IX.user, vault.sharesMint))).toEqual(IX.createSharesAta.ix);
  });

  it("the discriminators are Anchor's: sha256('global:<name>')[0..8]", () => {
    for (const [name, disc] of Object.entries(DISCRIMINATORS)) {
      expect([...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)], name).toEqual(disc);
    }
  });

  it("the vault's PDAs derive from its address alone, and agree with what the vault stores", async () => {
    const p = await vaultPdas(SNAP.vault);
    expect(p).toEqual({ tokenVault: vault.tokenVault, baseVaultAuthority: vault.baseVaultAuthority, sharesMint: vault.sharesMint });
  });

  it("a compute-unit limit outside (0, 1,400,000] is refused", () => {
    expect(() => setComputeUnitLimitIx(0)).toThrow(/compute unit limit/);
    expect(() => setComputeUnitLimitIx(1_400_001)).toThrow(/compute unit limit/);
    expect(Buffer.from(setComputeUnitLimitIx(400_000).data!).toString("hex")).toBe("02801a0600");
  });
});

describe("decoders — every field Kamino's SDK read from the same bytes", () => {
  it("VaultState", () => {
    const d = DEC.vaultState;
    expect({
      tokenMint: vault.tokenMint,
      tokenMintDecimals: vault.tokenMintDecimals.toString(),
      tokenVault: vault.tokenVault,
      baseVaultAuthority: vault.baseVaultAuthority,
      sharesMint: vault.sharesMint,
      sharesMintDecimals: vault.sharesMintDecimals.toString(),
      tokenAvailable: vault.tokenAvailable.toString(),
      sharesIssued: vault.sharesIssued.toString(),
      performanceFeeBps: vault.performanceFeeBps.toString(),
      managementFeeBps: vault.managementFeeBps.toString(),
      pendingFeesSf: vault.pendingFeesSf.toString(),
      depositCap: vault.depositCap.toString(),
      permissioningAuthority: vault.permissioningAuthority,
      name: vault.name,
      allocations: vault.allocations.map((a) => ({ reserve: a.reserve, ctokenVault: a.ctokenVault, ctokenAllocation: a.ctokenAllocation.toString(), targetAllocationWeight: a.targetAllocationWeight.toString() })),
    }).toEqual(d);
  });

  it("Reserve, for every reserve the vault allocates to", () => {
    expect(Object.keys(DEC.reserves).sort()).toEqual([...reserves.keys()].sort());
    for (const [addr, r] of reserves) {
      expect(
        {
          lendingMarket: r.lendingMarket,
          liquidityMint: r.liquidityMint,
          liquiditySupplyVault: r.liquiditySupplyVault,
          totalAvailableAmount: r.totalAvailableAmount.toString(),
          borrowedAmountSf: r.borrowedAmountSf.toString(),
          collateralMint: r.collateralMint,
          collateralMintTotalSupply: r.collateralMintTotalSupply.toString(),
        },
        addr,
      ).toEqual(DEC.reserves[addr]);
    }
  });

  it("refuses an account of the wrong size or type instead of reading it", () => {
    const v = bytes(SNAP.vault);
    expect(() => decodeVaultState(v.subarray(0, v.length - 1))).toThrow(/expected 62552/);
    const wrong = Uint8Array.from(v);
    wrong[0] = wrong[0]! ^ 0xff;
    expect(() => decodeVaultState(wrong)).toThrow(/discriminator/);
    expect(() => decodeReserve(v)).toThrow(/expected 8624/);
  });

  it("holdings: idle plus every reserve's position, and a reserve that was not read is refused", () => {
    const h = vaultHoldings(vault, reserves);
    expect(h.idle).toBe(vault.tokenAvailable);
    expect(h.netAum).toBe(h.aumIncludingFees - h.pendingFees);
    expect(() => vaultHoldings(vault, new Map())).toThrow(/was not read/);
  });
});
