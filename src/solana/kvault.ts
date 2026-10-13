/**
 * The depositor's side of a Kamino vault: the PDAs a deposit or withdrawal names, the two instructions
 * (`deposit`, `withdraw`), the token-account instruction a first deposit needs, and an UNSIGNED transaction.
 *
 * 🔴 HAND-WRITTEN, PINNED TO THE VENDOR'S BYTES. Each builder must produce exactly the data bytes and the
 * account metas (address, role, order) Kamino's own SDK produces for the same inputs:
 * `tests/solana-kvault.unit.test.ts` asserts byte equality against `vendor/kamino/instruction-fixtures.json`,
 * written by Kamino's SDK (`vendor/kamino/generate-fixtures.mjs`, version in `vendor/kamino/PINNED`).
 *
 * Nothing here signs or sends. The signer slot is an ADDRESS: the operator's wallet signs.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  KLEND_PROGRAM_ID,
  KVAULT_PROGRAM_ID,
  MAX_COMPUTE_UNITS,
  SEEDS,
  SPL_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_ID,
} from "./constants.js";

/** `sha256("global:<name>")[0..8]`, per instruction. */
export const DISCRIMINATORS = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;

const encoder = getAddressEncoder();
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const ro = (a: string): AccountMeta => ({ address: address(a), role: AccountRole.READONLY });
const rw = (a: string): AccountMeta => ({ address: address(a), role: AccountRole.WRITABLE });
const signer = (a: string, writable: boolean): AccountMeta => ({
  address: address(a),
  role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
});

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${v} does not fit a u64`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function concat(...parts: (readonly number[] | Uint8Array)[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/* ─────────────────────────────── PDAs ─────────────────────────────── */

/** A seed: a literal string (UTF-8) or an address (its 32 bytes). */
type Seed = { readonly text: string } | string;

async function pda(program: string, seeds: readonly Seed[]): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: seeds.map((s) => (typeof s === "string" ? encoder.encode(address(s)) : utf8(s.text))),
  });
  return found;
}

/** Every PDA a vault owns, from its vault-state address alone. */
export async function vaultPdas(vaultState: string): Promise<{ tokenVault: Address; baseVaultAuthority: Address; sharesMint: Address }> {
  const [tokenVault, baseVaultAuthority, sharesMint] = await Promise.all([
    pda(KVAULT_PROGRAM_ID, [{ text: SEEDS.tokenVault }, vaultState]),
    pda(KVAULT_PROGRAM_ID, [{ text: SEEDS.baseVaultAuthority }, vaultState]),
    pda(KVAULT_PROGRAM_ID, [{ text: SEEDS.shares }, vaultState]),
  ]);
  return { tokenVault, baseVaultAuthority, sharesMint };
}

/** The vault's ctoken account for one reserve. */
export const ctokenVaultPda = (vaultState: string, reserve: string): Promise<Address> =>
  pda(KVAULT_PROGRAM_ID, [{ text: SEEDS.ctokenVault }, vaultState, reserve]);
export const kvaultGlobalConfigPda = (): Promise<Address> => pda(KVAULT_PROGRAM_ID, [{ text: SEEDS.globalConfig }]);
/** Anchor's event-CPI authority for the vault program: `deposit` and `withdraw` name it. */
export const kvaultEventAuthorityPda = (): Promise<Address> => pda(KVAULT_PROGRAM_ID, [{ text: SEEDS.eventAuthority }]);
/** The lending program's authority for one market. */
export const lendingMarketAuthorityPda = (lendingMarket: string): Promise<Address> =>
  pda(KLEND_PROGRAM_ID, [{ text: SEEDS.lendingMarketAuthority }, lendingMarket]);

/** The owner's associated token account for `mint` (SPL Token). */
export async function associatedTokenAccount(owner: string, mint: string): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ID),
    seeds: [encoder.encode(address(owner)), encoder.encode(address(SPL_TOKEN_PROGRAM_ID)), encoder.encode(address(mint))],
  });
  return found;
}

/* ─────────────────────────── instructions ─────────────────────────── */

/** A reserve and its market, as every deposit and withdrawal lists them for the program to refresh. */
export interface VaultReserve {
  readonly reserve: string;
  readonly lendingMarket: string;
}

/** What a withdrawal from one reserve needs to know about it (all read on chain). */
export interface ReserveAccounts extends VaultReserve {
  readonly liquiditySupplyVault: string;
  readonly collateralMint: string;
}

/** The accounts both depositor instructions share, all derived from or read off the vault. */
export interface VaultAccounts {
  readonly vaultState: string;
  readonly tokenVault: string;
  readonly tokenMint: string;
  readonly baseVaultAuthority: string;
  readonly sharesMint: string;
  readonly vaultReserves: readonly VaultReserve[];
}

/**
 * `deposit(max_amount)`: the USER's tokens in, shares out to the user's own share account. The program
 * refreshes every vault reserve first, which is why each reserve and its market follow the fixed accounts.
 * There is no receiver: the shares can only land in the signer's own account.
 */
export async function depositIx(p: VaultAccounts & { user: string; userTokenAta: string; userSharesAta: string; maxAmount: bigint }): Promise<Instruction> {
  return {
    programAddress: address(KVAULT_PROGRAM_ID),
    accounts: [
      signer(p.user, true),
      rw(p.vaultState),
      rw(p.tokenVault),
      ro(p.tokenMint),
      ro(p.baseVaultAuthority),
      rw(p.sharesMint),
      rw(p.userTokenAta),
      rw(p.userSharesAta),
      ro(KLEND_PROGRAM_ID),
      ro(SPL_TOKEN_PROGRAM_ID),
      ro(SPL_TOKEN_PROGRAM_ID),
      ro(await kvaultEventAuthorityPda()),
      ro(KVAULT_PROGRAM_ID),
      ...p.vaultReserves.map((r) => rw(r.reserve)),
      ...p.vaultReserves.map((r) => ro(r.lendingMarket)),
    ],
    data: concat(DISCRIMINATORS.deposit, u64le(p.maxAmount)),
  };
}

/**
 * `withdraw(shares_amount)`: the user burns shares for the vault's token, paid from the vault's idle balance
 * first and then from `reserve`. One reserve per instruction; a withdrawal larger than idle plus what one
 * reserve can release takes one instruction per reserve. Paid to the signer's own token account only.
 */
export async function withdrawIx(
  p: VaultAccounts & { user: string; userTokenAta: string; userSharesAta: string; sharesAmount: bigint; reserve: ReserveAccounts },
): Promise<Instruction> {
  const [ctokenVault, lma, eventAuthority, globalConfig] = await Promise.all([
    ctokenVaultPda(p.vaultState, p.reserve.reserve),
    lendingMarketAuthorityPda(p.reserve.lendingMarket),
    kvaultEventAuthorityPda(),
    kvaultGlobalConfigPda(),
  ]);
  return {
    programAddress: address(KVAULT_PROGRAM_ID),
    accounts: [
      // withdrawFromAvailable
      signer(p.user, false),
      rw(p.vaultState),
      ro(globalConfig),
      rw(p.tokenVault),
      ro(p.baseVaultAuthority),
      rw(p.userTokenAta),
      rw(p.tokenMint),
      rw(p.userSharesAta),
      rw(p.sharesMint),
      ro(SPL_TOKEN_PROGRAM_ID),
      ro(SPL_TOKEN_PROGRAM_ID),
      ro(KLEND_PROGRAM_ID),
      ro(eventAuthority),
      ro(KVAULT_PROGRAM_ID),
      // withdrawFromReserveAccounts
      rw(p.vaultState),
      rw(p.reserve.reserve),
      rw(ctokenVault),
      ro(p.reserve.lendingMarket),
      ro(lma),
      rw(p.reserve.liquiditySupplyVault),
      rw(p.reserve.collateralMint),
      ro(SPL_TOKEN_PROGRAM_ID),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(eventAuthority),
      ro(KVAULT_PROGRAM_ID),
      ...p.vaultReserves.map((r) => rw(r.reserve)),
      ...p.vaultReserves.map((r) => ro(r.lendingMarket)),
    ],
    data: concat(DISCRIMINATORS.withdraw, u64le(p.sharesAmount)),
  };
}

/**
 * The Associated Token Account program's `CreateIdempotent` (instruction 1): creates `owner`'s token account for
 * `mint` if it does not exist, and does nothing if it does. The payer is the owner, who pays its rent (about
 * 0.002 SOL, returned if the account is ever closed). A first deposit needs it for the share account.
 */
export async function createAtaIdempotentIx(owner: string, mint: string): Promise<Instruction> {
  return {
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ID),
    accounts: [
      signer(owner, true),
      rw(await associatedTokenAccount(owner, mint)),
      ro(owner),
      ro(mint),
      ro(SYSTEM_PROGRAM_ID),
      ro(SPL_TOKEN_PROGRAM_ID),
    ],
    data: Uint8Array.from([1]),
  };
}

/**
 * `SetComputeUnitLimit(units)` (Compute Budget instruction 2, a u32). A deposit or withdrawal refreshes every
 * vault reserve inside the program, which can exceed the default 200,000 units.
 */
export function setComputeUnitLimitIx(units: number): Instruction {
  if (!Number.isInteger(units) || units <= 0 || units > MAX_COMPUTE_UNITS) {
    throw new Error(`compute unit limit must be an integer in (0, ${MAX_COMPUTE_UNITS}], got ${units}`);
  }
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ID), data };
}

/** A recent blockhash and the block height after which a transaction naming it can no longer land. */
export interface Lifetime {
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

/**
 * A legacy transaction, UNSIGNED (every signature slot zero), as base64 wire bytes. The fee payer is the
 * signer; a wallet adds the signature. It lands only before `lifetime.lastValidBlockHeight`, about a minute
 * after the blockhash was read.
 */
export function compileUnsigned(instructions: readonly Instruction[], feePayer: string, lifetime: Lifetime): { base64: string; bytes: number } {
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash as Blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const base64 = getBase64EncodedWireTransaction(compileTransaction(message));
  return { base64, bytes: Buffer.from(base64, "base64").length };
}
