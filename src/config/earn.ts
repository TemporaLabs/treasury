/**
 * The earn wiring — THE place to point the skill at a vault. Shipped code names no vault ticker
 * as a literal; `scripts/roundtrip.ts` and the tiers read the default and the round-trip target
 * from here (the fork and live tiers also name the gated sibling directly, for the access pair).
 *
 * Two knobs, deliberately separate, because they can legitimately differ:
 *
 *   `defaultVault`   what the tools use when the caller names none. The registry row must also be
 *                    `isDefault` — `defaultVault()` refuses a config/registry disagreement — and the
 *                    schema allows a WHITELIST_GATED default, because the pre-flight re-measures
 *                    access live on every call and refuses a non-member before anything is built.
 *   `roundTripVault` what the deposit → redeem tiers exercise. The same vault today.
 *
 * Addresses live in the registry (`registry/vaults.json`, schema-validated, block-stamped) — a
 * ticker here resolves through it.
 *
 * 🔴 NO DEPOSITOR ADDRESS IS CONFIGURED HERE, and that is a rule rather than an omission. A gated
 * vault's whitelist is the fund's to hold, and its members are readable from the chain: the fork
 * tier discovers one from the vault's own AccessManager (`tests/access.ts`) and impersonates it.
 * Writing a member's address into this file would publish who the fund has onboarded, and would go
 * stale the moment the whitelist changes. An address is never a key either way (CONTRIBUTING.md, the first rule).
 */

/** A vault's ERC-20 ticker — resolved via `getVault`, so a typo fails at load, not at a call site. */
export type VaultSymbol = string;

export const EARN = {
  /**
   * Tempora Labs Cash Plus USDC (Test 2B), Base — a Morpho Vault V2, the Tempora vault this client
   * offers by default. Deposits are OPEN to any account (measured by a simulated stranger deposit;
   * `earn_vaults` reports `defaultAccess: "open"`). Its cash-like leg is a savings-rate instrument
   * rather than a lending position (`docs/vaults.md`), unlike the prior default, Test 2. The
   * whitelist-gated sibling, Cash Plus USDC (Test 2A), stays listed as `tlCashPlusUSDC2A` and is
   * refused per account by the pre-flight.
   */
  defaultVault: "tlCashPlusUSDC2B" satisfies VaultSymbol,

  /** The round-trip target. The same vault as the default; open, so the fork tier deposits from the whale directly. */
  roundTripVault: "tlCashPlusUSDC2B" satisfies VaultSymbol,

  /** USDC, as a decimal string — the amount `scripts/roundtrip.ts` prepares by default. Never a float. */
  roundTripAmountUsdc: "0.05",

  /** Fixtures the fork and live tiers share. */
  fixtures: {
    /** An address that has never touched any vault — the negative control for access checks. */
    stranger: "0x000000000000000000000000000000000000dEaD" as const,
    /** Morpho Blue on Base — held ~2.1e14 USDC base units when probed 2026-09-11. Impersonated on the fork, never keyed. */
    usdcWhale: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const,
    /** USDC the fork round trip deposits, and what it seeds a discovered depositor with beforehand. */
    forkDepositUsdc: "100",
    forkSeedUsdc: "1000",
  },
} as const;
