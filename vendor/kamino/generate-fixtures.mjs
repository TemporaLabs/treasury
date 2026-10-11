// Writes vendor/kamino/{instruction,decode}-fixtures.json with KAMINO'S OWN SDK, so this repository's
// hand-written instruction builders and account decoders (src/solana/) are pinned to bytes the vendor
// produced rather than to bytes this repository produced.
//
// Kamino's SDK is NOT a dependency of this package (it is hundreds of megabytes). Run this from a scratch
// directory that has it installed, at the version pinned in vendor/kamino/PINNED:
//
//   mkdir /tmp/klend && cd /tmp/klend && npm init -y && npm install @kamino-finance/klend-sdk@<PINNED>
//   cp <repo>/vendor/kamino/generate-fixtures.mjs . && \
//     node generate-fixtures.mjs <repo>/tests/fixtures/solana/vault-snapshot.json <repo>/vendor/kamino
//
// It reads no chain and sends nothing: the snapshot is a committed file, and every other input is a fixed
// synthetic 32-byte value (bytes [n]*32), never a key.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { address, getAddressDecoder, createNoopSigner as noopSigner } from "@solana/kit";
import BN from "bn.js";
import { VaultState, Reserve, deposit, withdraw, getEventAuthorityPda, getCTokenVaultPda, getKvaultGlobalConfigPda, lendingMarketAuthPda } from "@kamino-finance/klend-sdk";
import { getCreateAssociatedTokenIdempotentInstruction, findAssociatedTokenPda } from "@solana-program/token";

const [snapshotPath, outDir] = process.argv.slice(2);
if (!snapshotPath || !outDir) throw new Error("usage: node generate-fixtures.mjs <snapshot.json> <outDir>");

const KVAULT = address("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const KLEND = address("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = address("11111111111111111111111111111111");
const IXS = address("Sysvar1nstructions1111111111111111111111111");
const synthetic = (n) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : BN.isBN(v) ? v.toString() : v);

const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
const bytes = (a) => Buffer.from(snap.accounts[a].data, "base64");
const vault = VaultState.decode(bytes(snap.vault));
const allocs = vault.vaultAllocationStrategy.filter((s) => s.reserve !== SYSTEM);

/* ── decode fixtures: what the vendor's decoder reads from the committed bytes ── */
const decode = {
  _comment: [
    "Kamino's own SDK (version in PINNED) decoding the bytes of tests/fixtures/solana/vault-snapshot.json.",
    "This repository's hand-declared offsets must read the same values from the same bytes.",
  ],
  vault: snap.vault,
  vaultState: {
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
    name: Buffer.from(vault.name).toString("utf8").replace(/\0+$/, ""),
    allocations: allocs.map((a) => ({ reserve: a.reserve, ctokenVault: a.ctokenVault, ctokenAllocation: a.ctokenAllocation.toString(), targetAllocationWeight: a.targetAllocationWeight.toString() })),
  },
  reserves: Object.fromEntries(
    allocs.map((a) => {
      const r = Reserve.decode(bytes(a.reserve));
      return [
        a.reserve,
        {
          lendingMarket: r.lendingMarket,
          liquidityMint: r.liquidity.mintPubkey,
          liquiditySupplyVault: r.liquidity.supplyVault,
          totalAvailableAmount: r.liquidity.totalAvailableAmount.toString(),
          borrowedAmountSf: r.liquidity.borrowedAmountSf.toString(),
          collateralMint: r.collateral.mintPubkey,
          collateralMintTotalSupply: r.collateral.mintTotalSupply.toString(),
        },
      ];
    }),
  ),
};

/* ── instruction fixtures: the vendor's own builders, synthetic users ── */
const user = noopSigner(synthetic(201));
const vaultReserves = allocs.map((a) => ({ address: a.reserve, role: 1 }));
const vaultMarkets = allocs.map((a) => ({ address: Reserve.decode(bytes(a.reserve)).lendingMarket, role: 0 }));
const remaining = [...vaultReserves, ...vaultMarkets];
const eventAuthority = await getEventAuthorityPda(KVAULT);
const [userTokenAta] = await findAssociatedTokenPda({ owner: user.address, mint: vault.tokenMint, tokenProgram: TOKEN });
const [userSharesAta] = await findAssociatedTokenPda({ owner: user.address, mint: vault.sharesMint, tokenProgram: TOKEN });
const out = (ix) => ({ programAddress: ix.programAddress, accounts: ix.accounts.map((m) => ({ address: m.address, role: m.role })), data: Buffer.from(ix.data).toString("hex") });

const dep = deposit(
  { maxAmount: new BN("1234567") },
  { user, vaultState: address(snap.vault), tokenVault: vault.tokenVault, tokenMint: vault.tokenMint, baseVaultAuthority: vault.baseVaultAuthority, sharesMint: vault.sharesMint, userTokenAta, userSharesAta, klendProgram: KLEND, tokenProgram: TOKEN, sharesTokenProgram: TOKEN, eventAuthority, program: KVAULT },
  remaining,
  KVAULT,
);
const r0 = allocs[0].reserve;
const r0s = Reserve.decode(bytes(r0));
const wd = withdraw(
  { sharesAmount: new BN("7654321") },
  {
    withdrawFromAvailable: { user, vaultState: address(snap.vault), globalConfig: await getKvaultGlobalConfigPda(KVAULT), tokenVault: vault.tokenVault, baseVaultAuthority: vault.baseVaultAuthority, userTokenAta, tokenMint: vault.tokenMint, userSharesAta, sharesMint: vault.sharesMint, tokenProgram: TOKEN, sharesTokenProgram: TOKEN, klendProgram: KLEND, eventAuthority, program: KVAULT },
    withdrawFromReserveAccounts: { vaultState: address(snap.vault), reserve: r0, ctokenVault: await getCTokenVaultPda(address(snap.vault), r0, KVAULT), lendingMarket: r0s.lendingMarket, lendingMarketAuthority: (await lendingMarketAuthPda(r0s.lendingMarket, KLEND))[0], reserveLiquiditySupply: r0s.liquidity.supplyVault, reserveCollateralMint: r0s.collateral.mintPubkey, reserveCollateralTokenProgram: TOKEN, instructionSysvarAccount: IXS },
    eventAuthority,
    program: KVAULT,
  },
  remaining,
  KVAULT,
);
const ata = getCreateAssociatedTokenIdempotentInstruction({ payer: user, ata: userSharesAta, owner: user.address, mint: vault.sharesMint, tokenProgram: TOKEN });

const instructions = {
  _comment: ["Kamino's own SDK (version in PINNED) building a depositor's instructions for the vault in the snapshot, for a synthetic user (bytes [201]*32)."],
  user: user.address,
  vault: snap.vault,
  deposit: { maxAmount: "1234567", ix: out(dep) },
  withdraw: { sharesAmount: "7654321", reserve: r0, ix: out(wd) },
  createSharesAta: { ix: out(ata) },
};

writeFileSync(join(outDir, "decode-fixtures.json"), JSON.stringify(decode, big, 2) + "\n");
writeFileSync(join(outDir, "instruction-fixtures.json"), JSON.stringify(instructions, big, 2) + "\n");
console.log("wrote", join(outDir, "decode-fixtures.json"), join(outDir, "instruction-fixtures.json"));
