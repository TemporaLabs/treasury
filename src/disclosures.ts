/**
 * The disclosures a distribution surface presents before a depositor's first deposit.
 * An agent skill IS a distribution surface, so `earn_terms` returns these verbatim and the
 * skill instructs the agent to show them and get an explicit acknowledgement before building a
 * first deposit. They are written for the vaults this registry actually offers — Tempora test
 * vaults on ERC-4626 chassis on Base — and say what is true of those, not of a fund that has not
 * launched. Change them when the offering changes, and nowhere else.
 */
export const DISCLOSURES = {
  source: "Agent Treasury — pre-deposit disclosures, 2026-09-15",
  presentBefore: "the depositor's first deposit, on every distribution surface",
  items: [
    "This is a smart-contract vault, not a bank deposit. No deposit insurance of any kind applies.",
    "The share token's value is a function of the vault's underlying holdings and is not guaranteed. It can go down.",
    "The vault holds positions in third-party protocols, each of which carries smart-contract, custody, and mechanism risk that Tempora does not control.",
    "Any yield figure is a measurement over a past window, not a promise. Historical performance is not indicative of future results.",
    "A withdrawal is served from the vault's liquid balance and then by unwinding its positions. In stressed conditions part of a position may not be withdrawable immediately; earn_balance reports what is exitable now, simulated at the current block.",
    "Deposits into a whitelist-gated vault are accepted only from accounts the fund has admitted. Withdrawals are public: an account that holds shares can always leave.",
    "The vault's current holdings, weights and fees are on-chain and publicly readable at the vault's address.",
    "The default vault is a Tempora-curated destination. Tempora can set fees on it as curator (a management fee and a performance fee, both readable on-chain; check them before depositing). This client offers it because it is Tempora's, not because it is the best-yielding vault available.",
  ],
  clientNotes: [
    "This client prepares unsigned calls only. It cannot sign, send, or move funds; the operator's own signer does that, and the operator is responsible for what it signs.",
    "Geography: the operator is responsible for the depositor's eligibility in its own jurisdiction. This client has no geographic signal and makes no representation about eligibility.",
  ],
} as const;
