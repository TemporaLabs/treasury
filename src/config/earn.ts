/**
 * The earn wiring — THE place to point the skill at a vault. Shipped code names no vault ticker
 * as a literal; the tiers read the library's default and the round-trip target
 * from here (the fork and live tiers also name the gated sibling directly, for the access pair).
 *
 * Three knobs, deliberately separate, because they can legitimately differ:
 *
 *   `defaultChain`        the chain the tools use when the caller names neither a chain nor a vault.
 *   `defaultVaultByChain` what the library uses on each chain when the caller names no vault (the
 *                         commands pick it by `defaultVaultAddressByChain` on the EVM chains). Each
 *                         registry row must also be `isDefault` — `defaultVault()` refuses a
 *                         config/registry disagreement — and the schema allows a WHITELIST_GATED
 *                         default, because the pre-flight re-measures access live on every call and
 *                         refuses a non-member before anything is built.
 *   `roundTripVault`      the vault the tiers take as the round-trip target. The Base default today. (The fork
 *                         tier round-trips every depositable vault on each chain, from the registry.)
 *
 * Addresses live in the registry (`registry/vaults.json`, schema-validated, block-stamped) — a
 * ticker here resolves through it. `defaultVaultAddressByChain` copies the default tickers' registry
 * addresses, and a unit test holds the two equal.
 *
 * 🔴 NO DEPOSITOR ADDRESS IS CONFIGURED HERE, and that is a rule rather than an omission. A gated
 * vault's whitelist is the fund's to hold, and its members are readable from the chain: the fork
 * tier discovers one from the vault's own AccessManager (`tests/access.ts`) and impersonates it.
 * Writing a member's address into this file would publish who the fund has onboarded, and would go
 * stale the moment the whitelist changes. An address is never a key either way (CONTRIBUTING.md, the first rule).
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
   * vault: listed and open, selected by naming it. Deposits are OPEN to any account (measured by a simulated stranger
   * deposit; `earn_vaults` reports `defaultAccess: "open"`). The whitelist-gated sibling, Cash Plus
   * USDC (Test 2A), stays listed as `tlCashPlusUSDC2A` and is refused per account by the pre-flight.
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

  /** The round-trip target. The same vault as the default; open, so the fork tier deposits from the whale directly. */
  roundTripVault: "tlCashPlusUSDC2B" satisfies VaultSymbol,

  /** USDC, as a decimal string — the amount the tiers prepare by default. Never a float. */
  roundTripAmountUsdc: "0.05",

  /** Fixtures the fork and live tiers share. */
  fixtures: {
    /** An address that has never touched any vault — the negative control for access checks. */
    stranger: "0x000000000000000000000000000000000000dEaD" as const,
    /** Morpho Blue on Base — held ~2.1e14 USDC base units when probed 2026-09-11. Impersonated on the fork, never keyed. */
    usdcWhale: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const,
    /** Aave V3's aArbUSDCn token on Arbitrum One — held ~1.7e13 native-USDC base units when probed 2026-10-02. Impersonated on the fork, never keyed. */
    usdcWhaleArbitrum: "0x724dc807b04555b71ed48a6896b6F41593b8C637" as const,
    /** Morpho Blue on Ethereum — held ~1.2e14 USDC base units when probed 2026-10-11. Impersonated on the fork, never keyed. */
    usdcWhaleEthereum: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const,
    /** The largest USDC holder among recent transfers on Monad — ~1.3e13 base units when probed 2026-10-11. Impersonated on the fork, never keyed. */
    usdcWhaleMonad: "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e" as const,
    /** The largest USDG holder among recent transfers on Robinhood Chain — ~1.0e14 base units when probed 2026-10-11. Impersonated on the fork, never keyed. */
    usdgWhaleRobinhood: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d" as const,
    /** USDC the fork round trip deposits, and what it seeds a discovered depositor with beforehand. */
    forkDepositUsdc: "100",
    forkSeedUsdc: "1000",
  },
} as const;
