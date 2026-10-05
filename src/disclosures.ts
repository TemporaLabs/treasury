/**
 * The disclosures a distribution surface presents before a depositor's first deposit.
 * An agent skill IS a distribution surface, so `earn_terms` returns these verbatim and the
 * skill instructs the agent to show them and get an explicit acknowledgement before building a
 * first deposit. They are written for the vaults this registry actually offers — Tempora test
 * vaults on ERC-4626 chassis, on Base, Arbitrum One and Robinhood Chain — and say what is true of
 * those, not of a fund that has not launched. Change them when the offering changes, and nowhere else.
 */
export const DISCLOSURES = {
  source: "Agent Treasury — pre-deposit disclosures, 2026-09-15",
  presentBefore: "the depositor's first deposit, on every distribution surface",
  items: [
    "EVERY VAULT THIS CLIENT OFFERS TODAY IS A TEST VAULT — unproven, and named as such on-chain. They exist to exercise the product, not to hold savings. Deposit only an amount you are fully prepared to lose entirely, and do not move significant funds into one.",
    "This is a smart-contract vault, not a bank deposit. No deposit insurance of any kind applies.",
    "The share token's value is a function of the vault's underlying holdings and is not guaranteed. It can go down.",
    "The vault holds positions in third-party protocols, each of which carries smart-contract, custody, and mechanism risk that Tempora does not control.",
    "Any yield figure is a measurement over a past window, not a promise. Historical performance is not indicative of future results.",
    "A withdrawal is served from the vault's liquid balance and then by unwinding its positions. In stressed conditions part of a position may not be withdrawable immediately; earn_balance reports what is exitable now, simulated at the current block.",
    "Deposits into a whitelist-gated vault are accepted only from accounts the fund has admitted. Withdrawals are public: an account that holds shares can always leave.",
    "The vault's current holdings, weights and fees are on-chain and publicly readable at the vault's address.",
    "Each default vault, and the demo vault, is a Tempora-curated destination. Tempora can set fees on it as curator (a management fee and a performance fee, both readable on-chain; check them before depositing). This client offers it because it is Tempora's, not because it is the best-yielding vault available.",
  ],
  clientNotes: [
    "This client never signs, sends, or moves funds. Every transaction is signed by the operator's own wallet (through `connect`) or the operator's own signer, and the operator is responsible for what it signs.",
    "Geography: the operator is responsible for the depositor's eligibility in its own jurisdiction. This client has no geographic signal and makes no representation about eligibility.",
  ],
  /**
   * The same points in plain words, for the acknowledgement an operator reads before every signing
   * page (`connect/ack.ts`). A person has to read this each time, so it is short; `items` and
   * `clientNotes` above stay the full text, which `earn_terms` returns. Keep the two in step: a
   * point added above needs its plain sentence here. The first item above (every vault is a test
   * vault; deposit only what you can lose) has none: the acknowledgement prints the vault's own
   * `warning` from the registry, which says it, and `registry.test.ts` holds every row to that.
   */
  plain: {
    deposit: [
      "This is not a bank deposit, and there is no deposit insurance.",
      "The value of your shares is not guaranteed. It can go down.",
      "Your money goes into third-party protocols that Tempora does not control. They can fail.",
      "Any yield you see is past performance, not a promise.",
      "You can withdraw, but in stressed markets part of your money may not come out right away.",
      "Tempora runs this vault and can charge fees on it. It is offered because it is Tempora's, not because it pays the most. Its holdings and fees are public on-chain.",
    ],
    /** Added before a deposit into a vault whose registry row is not open to every account. */
    gatedDeposit: "This vault only accepts deposits from accounts Tempora has admitted. If yours is not one, the deposit will fail.",
    always: [
      "This software never signs or moves your money. You approve every transaction in your own wallet, and you are responsible for what you approve.",
      "You are responsible for being allowed to use this where you live.",
    ],
    fullTerms: "Ask your agent for the full terms at any time.",
  },
} as const;
