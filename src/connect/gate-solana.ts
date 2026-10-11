/**
 * The Solana gate: what the confirm page may hand a connected Solana wallet. The counterpart of `gate.ts`.
 *
 * It reads the transaction's own BYTES — the wire transaction the wallet will be given — and admits it only if
 * every instruction in it is one of these, each for the connected account and a registry vault:
 *
 *   ComputeBudget SetComputeUnitLimit           nothing else from that program (no fee price, no heap)
 *   Associated Token Account CreateIdempotent   payer and owner the connected account; mint the vault's
 *                                               share mint or its token mint
 *   Kamino vault `deposit`                      exactly one, signer the connected account, vault a registry vault,
 *                                               paying from and into the account's own token accounts
 *   Kamino vault `withdraw`                     one or more, the same checks
 *
 * The fee payer and the only signer must be the connected account. Anything else — another program, a
 * transfer, a second signer, a deposit and a withdrawal together, a vault not in the registry — is refused
 * before any page opens. It checks the bytes, not the builder that made them: a builder bug, or a transaction
 * from anywhere else, meets the same refusal.
 */
import {
  AccountRole,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
} from "@solana/kit";
import { listSolanaVaults } from "../registry.js";
import type { SolanaVaultEntry } from "../registry-schema.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, KVAULT_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../solana/constants.js";
import { associatedTokenAccount, DISCRIMINATORS } from "../solana/kvault.js";

export interface AdmittedSolana {
  kind: "deposit" | "withdraw";
  vault: SolanaVaultEntry;
  /** A deposit's base units of the asset, or the shares a withdrawal burns (summed over its legs). */
  amount: bigint;
}

const same = (a: readonly number[], b: Uint8Array) => a.length <= b.length && a.every((x, i) => b[i] === x);
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const isSigner = (role: AccountRole) => role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;

export async function admitSolana(wireBase64: string, account: string): Promise<AdmittedSolana> {
  const refuse = (why: string): never => {
    throw new Error(`refused: ${why}`);
  };
  let ixs: readonly Instruction[];
  let feePayer: string;
  let signers: number;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    signers = compiled.header.numSignerAccounts;
    if ("addressTableLookups" in compiled && (compiled.addressTableLookups?.length ?? 0) > 0) refuse("the transaction loads accounts from a lookup table, which this gate cannot read");
    const message = decompileTransactionMessage(compiled);
    feePayer = message.feePayer.address;
    ixs = message.instructions;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("refused:")) throw e;
    return refuse(`the transaction does not decode (${e instanceof Error ? e.message : String(e)})`);
  }
  if (feePayer !== account) refuse(`the fee payer is ${feePayer}, not the connected account ${account}`);
  if (signers !== 1) refuse(`the transaction needs ${signers} signers; only the connected account may sign`);

  let kind: "deposit" | "withdraw" | undefined;
  let vault: SolanaVaultEntry | undefined;
  let amount = 0n;
  const ataMints = new Set<string>();
  for (const [i, ix] of ixs.entries()) {
    const at = `instruction ${i + 1}`;
    const data = Uint8Array.from(ix.data ?? []);
    const accts = ix.accounts ?? [];
    for (const a of accts) if (isSigner(a.role) && a.address !== account) refuse(`${at} asks ${a.address} to sign, not the connected account`);
    switch (ix.programAddress) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        if (data.length !== 5 || data[0] !== 2) refuse(`${at}: only a compute-unit limit is allowed from the Compute Budget program`);
        break;
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        if (data.length !== 1 || data[0] !== 1) refuse(`${at}: only an idempotent token-account creation is allowed`);
        const [payer, ata, owner, mint, system, token] = accts.map((a) => a.address);
        if (payer !== account || owner !== account) refuse(`${at} creates a token account for ${owner}, paid by ${payer}; only the connected account's own`);
        if (system !== SYSTEM_PROGRAM_ID || token !== SPL_TOKEN_PROGRAM_ID) refuse(`${at} names an unexpected program`);
        if (ata !== (await associatedTokenAccount(account, mint!))) refuse(`${at} names a token account that is not the connected account's for ${mint}`);
        ataMints.add(mint!);
        break;
      }
      case KVAULT_PROGRAM_ID: {
        const isDeposit = same(DISCRIMINATORS.deposit, data);
        const isWithdraw = same(DISCRIMINATORS.withdraw, data);
        if (!isDeposit && !isWithdraw) refuse(`${at} is a Kamino vault instruction other than deposit or withdraw`);
        if (data.length !== 16) refuse(`${at} carries ${data.length} bytes of data, not 16`);
        const k = isDeposit ? "deposit" : "withdraw";
        if (kind !== undefined && kind !== k) refuse("a deposit and a withdrawal in one transaction");
        if (k === "deposit" && kind === "deposit") refuse("two deposits in one transaction");
        kind = k;
        const user = accts[0]?.address;
        const state = accts[1]?.address;
        if (user !== account) refuse(`${at} acts for ${user}, not the connected account ${account}`);
        const v = listSolanaVaults().find((x) => x.address === state);
        if (!v) refuse(`${at} names ${state}, which is not a vault in the registry`);
        if (vault && vault.address !== v!.address) refuse("two different vaults in one transaction");
        vault = v!;
        const [tokenAta, sharesAta] = await Promise.all([associatedTokenAccount(account, v!.asset.address), associatedTokenAccount(account, v!.sharesMint)]);
        // The fixed account positions, as `src/solana/kvault.ts` builds them and Kamino's SDK does.
        const userToken = accts[isDeposit ? 6 : 5]?.address;
        const userShares = accts[isDeposit ? 7 : 7]?.address;
        const mint = accts[isDeposit ? 3 : 6]?.address;
        const sharesMint = accts[isDeposit ? 5 : 8]?.address;
        if (mint !== v!.asset.address || sharesMint !== v!.sharesMint) refuse(`${at} names a token or share mint that is not the vault's`);
        if (userToken !== tokenAta) refuse(`${at} ${isDeposit ? "takes from" : "pays into"} ${userToken}, not the connected account's own ${v!.asset.symbol} account`);
        if (userShares !== sharesAta) refuse(`${at} names ${userShares} as the share account, not the connected account's own`);
        const n = u64(data, 8);
        if (n === 0n) refuse(`${at} moves 0`);
        amount += n;
        break;
      }
      default:
        refuse(`${at} calls ${ix.programAddress}, which is not one this page may send`);
    }
  }
  if (!kind || !vault) return refuse("the transaction contains no deposit or withdrawal");
  for (const m of ataMints) if (m !== vault.sharesMint && m !== vault.asset.address) refuse(`a token account is created for ${m}, which is not this vault's`);
  return { kind, vault, amount };
}
