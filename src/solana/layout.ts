/**
 * Decoders for the two accounts this client reads on Solana: the kVault `VaultState` and the lending
 * program's `Reserve`.
 *
 * 🔴 HAND-DECLARED OFFSETS, PINNED TO KAMINO'S OWN SDK. `tests/solana-kvault.unit.test.ts` decodes a real
 * mainnet snapshot (`tests/fixtures/solana/vault-snapshot.json`) and compares every field with what
 * Kamino's SDK decoded from the same bytes (`vendor/kamino/decode-fixtures.json`, version in
 * `vendor/kamino/PINNED`). The discriminator and the exact account length are checked on every decode, so a
 * different account type, or a resized one, is refused rather than read as garbage. Kamino's SDK is not a
 * dependency at runtime.
 *
 * Amounts are bigint base units. `*Sf` fields are the lending program's scaled fractions: value × 2^60.
 */
import { getAddressDecoder } from "@solana/kit";
import { DEFAULT_PUBKEY, MAX_RESERVES, RESERVE_SIZE, VAULT_STATE_SIZE } from "./constants.js";

/** klend's fixed-point scale: a `*_sf` field is value × 2^60. */
export const SF_ONE = 1n << 60n;

/** `sha256("account:VaultState")[0..8]` — Anchor's account discriminator. */
export const VAULT_STATE_DISCRIMINATOR = Uint8Array.from([228, 196, 82, 165, 98, 210, 235, 152]);
/** `sha256("account:Reserve")[0..8]`. */
export const RESERVE_DISCRIMINATOR = Uint8Array.from([43, 242, 204, 202, 26, 247, 59, 127]);

/** Byte offsets INTO THE ACCOUNT DATA (the 8-byte discriminator included). */
export const VAULT_STATE_OFFSETS = {
  vaultAdminAuthority: 8,
  baseVaultAuthority: 40,
  tokenMint: 80,
  tokenMintDecimals: 112,
  tokenVault: 120,
  tokenProgram: 152,
  sharesMint: 184,
  sharesMintDecimals: 216,
  tokenAvailable: 224,
  sharesIssued: 232,
  unallocatedWeight: 248,
  performanceFeeBps: 256,
  managementFeeBps: 264,
  pendingFeesSf: 296,
  allocations: 312,
  minInvestAmount: 58_424,
  minInvestDelaySlots: 58_432,
  pendingAdmin: 58_448,
  name: 58_528,
  unallocatedTokensCap: 58_640,
  allocationAdmin: 58_648,
  allowAllocationsInWhitelistedReservesOnly: 58_728,
  allowInvestInWhitelistedReservesOnly: 58_729,
  depositCap: 58_736,
  permissioningAuthority: 58_840,
} as const;

/** One `VaultAllocation` slot: its size, and each field's offset WITHIN the slot. */
export const ALLOCATION_SLOT = {
  size: 2_160,
  reserve: 0,
  ctokenVault: 32,
  targetAllocationWeight: 64,
  tokenAllocationCap: 72,
  ctokenAllocationCap: 88,
  ctokenAllocation: 1_104,
  lastInvestSlot: 1_112,
} as const;

export const RESERVE_OFFSETS = {
  lastUpdateSlot: 16,
  lendingMarket: 32,
  liquidityMint: 128,
  liquiditySupplyVault: 160,
  totalAvailableAmount: 224,
  borrowedAmountSf: 232,
  liquidityMintDecimals: 272,
  accumulatedProtocolFeesSf: 344,
  accumulatedReferrerFeesSf: 360,
  pendingReferrerFeesSf: 376,
  collateralMint: 2_560,
  collateralMintTotalSupply: 2_592,
  depositLimit: 5_016,
} as const;

export interface VaultAllocation {
  readonly reserve: string;
  readonly ctokenVault: string;
  readonly targetAllocationWeight: bigint;
  readonly tokenAllocationCap: bigint;
  readonly ctokenAllocationCap: bigint;
  readonly ctokenAllocation: bigint;
  readonly lastInvestSlot: bigint;
}

export interface VaultStateView {
  readonly vaultAdminAuthority: string;
  readonly baseVaultAuthority: string;
  readonly tokenMint: string;
  readonly tokenMintDecimals: bigint;
  readonly tokenVault: string;
  readonly tokenProgram: string;
  readonly sharesMint: string;
  readonly sharesMintDecimals: bigint;
  readonly tokenAvailable: bigint;
  readonly sharesIssued: bigint;
  readonly unallocatedWeight: bigint;
  readonly performanceFeeBps: bigint;
  readonly managementFeeBps: bigint;
  readonly pendingFeesSf: bigint;
  /** Occupied slots only, in slot order (an empty slot's reserve is the default key). */
  readonly allocations: readonly VaultAllocation[];
  readonly minInvestAmount: bigint;
  readonly minInvestDelaySlots: bigint;
  readonly pendingAdmin: string;
  readonly name: string;
  readonly unallocatedTokensCap: bigint;
  readonly allocationAdmin: string;
  readonly allowAllocationsInWhitelistedReservesOnly: number;
  readonly allowInvestInWhitelistedReservesOnly: number;
  readonly depositCap: bigint;
  readonly permissioningAuthority: string;
}

export interface ReserveView {
  readonly lastUpdateSlot: bigint;
  readonly lendingMarket: string;
  readonly liquidityMint: string;
  readonly liquiditySupplyVault: string;
  readonly totalAvailableAmount: bigint;
  readonly borrowedAmountSf: bigint;
  readonly liquidityMintDecimals: bigint;
  readonly accumulatedProtocolFeesSf: bigint;
  readonly accumulatedReferrerFeesSf: bigint;
  readonly pendingReferrerFeesSf: bigint;
  readonly collateralMint: string;
  readonly collateralMintTotalSupply: bigint;
  readonly depositLimit: bigint;
}

const addressDecoder = getAddressDecoder();

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
const u64 = (d: Uint8Array, o: number): bigint => view(d).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number): bigint => u64(d, o) | (u64(d, o + 8) << 64n);
const pubkey = (d: Uint8Array, o: number): string => addressDecoder.decode(d.subarray(o, o + 32));

/** Refuse anything that is not exactly the account this decoder was written for. */
function assertAccount(data: Uint8Array, size: number, disc: Uint8Array, what: string): void {
  if (data.length !== size) {
    throw new Error(`kamino: ${what} is ${data.length} bytes, expected ${size} (a different program version or account type)`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) throw new Error(`kamino: ${what} discriminator mismatch — not a ${what} account`);
  }
}

export function decodeVaultState(data: Uint8Array): VaultStateView {
  assertAccount(data, VAULT_STATE_SIZE, VAULT_STATE_DISCRIMINATOR, "VaultState");
  const o = VAULT_STATE_OFFSETS;
  const allocations: VaultAllocation[] = [];
  for (let i = 0; i < MAX_RESERVES; i++) {
    const base = o.allocations + i * ALLOCATION_SLOT.size;
    const reserve = pubkey(data, base + ALLOCATION_SLOT.reserve);
    if (reserve === DEFAULT_PUBKEY) continue;
    allocations.push({
      reserve,
      ctokenVault: pubkey(data, base + ALLOCATION_SLOT.ctokenVault),
      targetAllocationWeight: u64(data, base + ALLOCATION_SLOT.targetAllocationWeight),
      tokenAllocationCap: u64(data, base + ALLOCATION_SLOT.tokenAllocationCap),
      ctokenAllocationCap: u64(data, base + ALLOCATION_SLOT.ctokenAllocationCap),
      ctokenAllocation: u64(data, base + ALLOCATION_SLOT.ctokenAllocation),
      lastInvestSlot: u64(data, base + ALLOCATION_SLOT.lastInvestSlot),
    });
  }
  const nameBytes = data.subarray(o.name, o.name + 40);
  const nul = nameBytes.indexOf(0);
  return {
    vaultAdminAuthority: pubkey(data, o.vaultAdminAuthority),
    baseVaultAuthority: pubkey(data, o.baseVaultAuthority),
    tokenMint: pubkey(data, o.tokenMint),
    tokenMintDecimals: u64(data, o.tokenMintDecimals),
    tokenVault: pubkey(data, o.tokenVault),
    tokenProgram: pubkey(data, o.tokenProgram),
    sharesMint: pubkey(data, o.sharesMint),
    sharesMintDecimals: u64(data, o.sharesMintDecimals),
    tokenAvailable: u64(data, o.tokenAvailable),
    sharesIssued: u64(data, o.sharesIssued),
    unallocatedWeight: u64(data, o.unallocatedWeight),
    performanceFeeBps: u64(data, o.performanceFeeBps),
    managementFeeBps: u64(data, o.managementFeeBps),
    pendingFeesSf: u128(data, o.pendingFeesSf),
    allocations,
    minInvestAmount: u64(data, o.minInvestAmount),
    minInvestDelaySlots: u64(data, o.minInvestDelaySlots),
    pendingAdmin: pubkey(data, o.pendingAdmin),
    name: new TextDecoder().decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul)),
    unallocatedTokensCap: u64(data, o.unallocatedTokensCap),
    allocationAdmin: pubkey(data, o.allocationAdmin),
    allowAllocationsInWhitelistedReservesOnly: data[o.allowAllocationsInWhitelistedReservesOnly]!,
    allowInvestInWhitelistedReservesOnly: data[o.allowInvestInWhitelistedReservesOnly]!,
    depositCap: u64(data, o.depositCap),
    permissioningAuthority: pubkey(data, o.permissioningAuthority),
  };
}

export function decodeReserve(data: Uint8Array): ReserveView {
  assertAccount(data, RESERVE_SIZE, RESERVE_DISCRIMINATOR, "Reserve");
  const o = RESERVE_OFFSETS;
  return {
    lastUpdateSlot: u64(data, o.lastUpdateSlot),
    lendingMarket: pubkey(data, o.lendingMarket),
    liquidityMint: pubkey(data, o.liquidityMint),
    liquiditySupplyVault: pubkey(data, o.liquiditySupplyVault),
    totalAvailableAmount: u64(data, o.totalAvailableAmount),
    borrowedAmountSf: u128(data, o.borrowedAmountSf),
    liquidityMintDecimals: u64(data, o.liquidityMintDecimals),
    accumulatedProtocolFeesSf: u128(data, o.accumulatedProtocolFeesSf),
    accumulatedReferrerFeesSf: u128(data, o.accumulatedReferrerFeesSf),
    pendingReferrerFeesSf: u128(data, o.pendingReferrerFeesSf),
    collateralMint: pubkey(data, o.collateralMint),
    collateralMintTotalSupply: u64(data, o.collateralMintTotalSupply),
    depositLimit: u64(data, o.depositLimit),
  };
}

/**
 * A reserve's total supply in liquidity units, scaled by 2^60: available + borrowed − every fee bucket.
 * klend-sdk's `Reserve.getTotalSupplySf()`, the numerator of the collateral exchange rate.
 */
export function totalSupplySf(r: ReserveView): bigint {
  return (
    r.totalAvailableAmount * SF_ONE +
    r.borrowedAmountSf -
    r.accumulatedProtocolFeesSf -
    r.accumulatedReferrerFeesSf -
    r.pendingReferrerFeesSf
  );
}

/**
 * What `ctokens` of this reserve are worth in liquidity base units, at the reserve's STORED state
 * (floored): ctokens × totalSupply / ctokenSupply. A reserve accrues interest only when refreshed, so this
 * lags the true value by the interest since `lastUpdateSlot` — conservative, and what klend-sdk's
 * `getCollateralExchangeRate()` (the "stale" rate) also reports.
 */
export function ctokensToLiquidity(ctokens: bigint, r: ReserveView): bigint {
  if (r.collateralMintTotalSupply === 0n) return 0n;
  return (ctokens * totalSupplySf(r)) / (r.collateralMintTotalSupply * SF_ONE);
}

/**
 * A reserve's share price — liquidity per ctoken — as an 18-decimal fixed-point bigint. `0n` for a reserve
 * with no ctokens.
 */
export function reserveSharePrice1e18(r: ReserveView): bigint {
  if (r.collateralMintTotalSupply === 0n) return 0n;
  return (totalSupplySf(r) * 10n ** 18n) / (r.collateralMintTotalSupply * SF_ONE);
}

/** What the vault holds, by reserve and in total: kvault's own AUM rule, at stored reserve state. */
export interface VaultHoldings {
  readonly idle: bigint;
  readonly byReserve: ReadonlyMap<string, bigint>;
  /** idle + Σ reserves, BEFORE pending fees (klend-sdk's `totalAUMIncludingFees`). */
  readonly aumIncludingFees: bigint;
  /** Pending fees, floored to base units. */
  readonly pendingFees: bigint;
  /** What the depositors own: AUM − pending fees. */
  readonly netAum: bigint;
}

export function vaultHoldings(vault: VaultStateView, reserves: ReadonlyMap<string, ReserveView>): VaultHoldings {
  const byReserve = new Map<string, bigint>();
  let invested = 0n;
  for (const a of vault.allocations) {
    const r = reserves.get(a.reserve);
    if (r === undefined) {
      // A missing reserve would silently drop its share of the AUM: refuse instead.
      throw new Error(`kamino: the vault allocates to reserve ${a.reserve}, which was not read`);
    }
    const v = ctokensToLiquidity(a.ctokenAllocation, r);
    byReserve.set(a.reserve, v);
    invested += v;
  }
  const aumIncludingFees = vault.tokenAvailable + invested;
  const pendingFees = vault.pendingFeesSf / SF_ONE;
  return { idle: vault.tokenAvailable, byReserve, aumIncludingFees, pendingFees, netAum: aumIncludingFees - pendingFees };
}
