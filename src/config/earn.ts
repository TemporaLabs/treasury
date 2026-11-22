/**
 * The earn wiring — THE place to point the skill at a vault. Shipped code names no vault ticker
 * as a literal.
 *
 * Two knobs, deliberately separate, because they can legitimately differ:
 *
 *   `defaultChain`        the chain the tools use when the caller names neither a chain nor a vault.
 *   `defaultVaultByChain` the registry ticker of each chain's default vault; the commands pick that
 *                         vault among those the Tempora API lists by `defaultVaultAddressByChain`.
 *                         Each registry row must also be `isDefault` — `defaultVault()` refuses a
 *                         config/registry disagreement.
 *
 * Addresses live in the registry (`registry/vaults.json`, schema-validated, block-stamped) — a
 * ticker here resolves through it. `defaultVaultAddressByChain` copies the default tickers' registry
 * addresses, and a unit test holds the two equal.
 *
 * 🔴 NO DEPOSITOR ADDRESS IS CONFIGURED HERE, and that is a rule rather than an omission. Who may
 * deposit into a gated vault is the fund's to hold and the Tempora API's to check per account;
 * writing a member's address into this file would publish who the fund has onboarded. An address is
 * never a key either way (CONTRIBUTING.md, the first rule).
 */

import type { ChainKey } from "../client.js";

/** A vault's ERC-20 ticker — resolved via `getVault`, so a typo fails at load, not at a call site. */
export type VaultSymbol = string;

export const EARN = {
  /** The chain used when a caller names neither a chain nor a vault. */
  defaultChain: "base" satisfies ChainKey,

  /**
   * The default vault on each chain, by chain key.
   *
   * `base`: Tempora Labs Cash Plus USDC (Test 2B) — a Morpho Vault V2, the Tempora Labs vault this client
   * offers when nothing is named. Tempora Labs Cash Plus USDC (Test 2), also on Base, is the DEMO
   * vault: listed and open, selected by naming it. Deposits are OPEN to any account (measured by a simulated
   * stranger deposit). The whitelist-gated sibling, Cash Plus USDC (Test 2A), stays in the registry as
   * `tlCashPlusUSDC2A`; the Tempora API decides per account who may deposit.
   *
   * `arbitrum`: Tempora Labs Cash Plus USDC (Test 2C) — a Morpho Vault V2 on Arbitrum One, open to
   * any account by the same measurement.
   *
   * `robinhood`: Tempora Labs Cash Plus USDG (Test 2D) — a Morpho Vault V2 on Robinhood Chain over
   * USDG, the first vault whose asset is not USDC. Open to any account by the same measurement.
   *
   * `ethereum`: Tempora Labs Cash Plus USDC (Test 2E) — a Morpho Vault V2 on Ethereum, open to any
   * account by the same measurement. Gas there costs far more than on the other chains.
   *
   * `monad`: Tempora Labs Cash Plus USDC (Test 2F) — a Morpho Vault V2 on Monad, open to any account
   * by the same measurement.
   *
   * `Record<ChainKey, …>`: a chain added to `CHAIN_INFO` without a default here does not compile.
   */
  defaultVaultByChain: {
    base: "tlCashPlusUSDC2B",
    arbitrum: "tlCashPlusUSDC2C",
    robinhood: "tlCashPlusUSDG2D",
    ethereum: "tlCashPlusUSDC2E",
    monad: "tlCashPlusUSDC2F",
  } satisfies Record<ChainKey, VaultSymbol>,

  /**
   * The default vault on each chain by its contract address: the registry's address for that chain's ticker in
   * `defaultVaultByChain` (a unit test holds the two maps equal). The address only PICKS the vault among those the
   * Tempora API lists on that chain; the API supplies everything else about it (its asset, decimals, status, terms and
   * warnings) on every call. A default the API does not list is refused, never replaced by another vault.
   *
   * `Record<ChainKey, …>`: a chain added to `CHAIN_INFO` without a default here does not compile.
   */
  defaultVaultAddressByChain: {
    base: "0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F",
    arbitrum: "0x4057a63953142Ac2b3E5dB1954Fc14d578662587",
    robinhood: "0x758f00731943aA88e8C7fB709e0B727903B4F833",
    ethereum: "0x2AA9B1F12bbFE1E01dcb4DD52E6836d68416e3B6",
    monad: "0x163295A4d4381745A205DC5E9A436a3f51791593",
  } satisfies Record<ChainKey, `0x${string}`>,

  /** How often `connect` reads a vault request again while a step settles. */
  requestPollMs: 3_000,

  /** Fixtures the unit tiers share. */
  fixtures: {
    /** An address that has never touched any vault — the negative control for access checks. */
    stranger: "0x000000000000000000000000000000000000dEaD" as const,
  },
} as const;
