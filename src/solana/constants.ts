/**
 * Solana constants: the programs a Kamino vault deposit or withdrawal names, and the cluster.
 *
 * Every program id below was read on Solana mainnet-beta. Both Kamino programs are UPGRADEABLE by their
 * upgrade authority, so a later upgrade can change any behaviour this client relies on. The decoders in
 * `layout.ts` refuse an account of the wrong size or type rather than read it, which is the one change this
 * client can notice; anything else is a disclosure, not a check.
 */

/** Kamino's vault program (a curated single-asset vault over Kamino lending reserves). */
export const KVAULT_PROGRAM_ID = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" as const;
/** Kamino's lending program, where the vault's reserves live. */
export const KLEND_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD" as const;
/** SPL Token: the program that owns USDC and the vault's share mint. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const;
/** The Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as const;
/** The System Program. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as const;
/** The instructions sysvar, which a kVault withdrawal from a reserve names. */
export const SYSVAR_INSTRUCTIONS_ID = "Sysvar1nstructions1111111111111111111111111" as const;
/** The Compute Budget program. */
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111" as const;

/** The all-zero key: an empty allocation slot's reserve. */
export const DEFAULT_PUBKEY = SYSTEM_PROGRAM_ID;

/**
 * Solana mainnet-beta's genesis hash. An RPC endpoint is on mainnet exactly when `getGenesisHash` returns this:
 * the Solana counterpart of an EVM endpoint's `eth_chainId`.
 */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" as const;

/** PDA seeds, as Kamino's vault program spells them. */
export const SEEDS = {
  tokenVault: "token_vault",
  ctokenVault: "ctoken_vault",
  baseVaultAuthority: "authority",
  shares: "shares",
  globalConfig: "global_config",
  eventAuthority: "__event_authority",
  /** The lending program's market authority. */
  lendingMarketAuthority: "lma",
} as const;

/** Account sizes INCLUDING the 8-byte Anchor discriminator, from Kamino's IDL and measured on chain. */
export const VAULT_STATE_SIZE = 62_552;
export const RESERVE_SIZE = 8_624;
/** A vault has this many allocation slots; an empty slot's `reserve` is the default key. */
export const MAX_RESERVES = 25;

/** Solana's packet limit for one serialized transaction. */
export const MAX_TRANSACTION_BYTES = 1232;
/** The most compute one transaction may request. */
export const MAX_COMPUTE_UNITS = 1_400_000;
