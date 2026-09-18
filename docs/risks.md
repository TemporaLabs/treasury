# Risks — read before a first deposit

Treasury moves real money into real smart contracts. This page says what can go wrong, plainly. The
`earn_terms` tool returns the same substance to an agent, and the skill requires the agent to show
it to the operator and get an acknowledgement before a first deposit.

**This is not financial, legal or tax advice.** Nothing here or in the software is an offer or a
recommendation. You are responsible for deciding whether depositing is appropriate for you, and for
your eligibility in your jurisdiction.

## Experimental software

Treasury is pre-1.0. Tool names, schemas and behaviour may change between versions. It has tests,
CI, a reproducible bundle and a boundary that is enforced in code — and it has not been audited by a
third party. Review every transaction your signer is asked to sign.

## The vault

- **Not a bank deposit.** A vault is a smart contract. No deposit insurance of any kind applies.
- **The value can go down.** A share's value is a function of the vault's holdings and is not
  guaranteed. Yield figures are measurements of the past, labelled by their source, never a promise.
- **Third-party protocol risk.** The vault holds positions in other protocols' contracts, each with
  its own smart-contract, custody and mechanism risk that Tempora does not control. One of the
  default's positions lends against a stablecoin whose Morpho oracle is fixed at par; a depeg is not
  priced by the fund's loss model. Read the vault's positions on-chain before a first deposit.
- **Liquidity.** A withdrawal is served from the vault's liquid balance and then by unwinding its
  positions. Under stress, part of a position may not be withdrawable immediately. `earn_balance`
  reports `exit.exitableNow`, measured by simulating the withdrawal — trust that, not `maxWithdraw()`.
- **Access.** A whitelist-gated vault admits deposits only from accounts the fund has admitted.
  Withdrawals are public. Admission can be granted and, in principle, revoked, by the fund.
- **Fees.** A vault's curator can set a management fee and a performance fee; both are readable
  on-chain. The default sets none today (measured at block 51,372,415). Its fee timelocks are 0
  (measured at block 51,404,161), so the curator can introduce a fee without notice; read both fees
  before depositing.
- **The default is Tempora's.** It is offered because Tempora curates it, and can set fees on it, not
  because it is the best-yielding vault available.

## The client

- **It prepares; it does not execute.** Nothing has happened until your signer's transactions
  confirm. If a tool result and the chain disagree, the chain is right.
- **A quote is a simulation at one block.** State can change between the quote and the signed
  transaction. The builders carry a gas buffer for exactly this; the `precondition` on a call says what
  must still be true when it is sent.
- **Two addresses, two meanings.** `account` is whose shares; `receiver` is where the money lands.
  They are usually the same. The tool will not assume it, and neither should you — a transposed
  receiver sends USDC to the wrong place, irreversibly.
- **Your RPC is part of the trust chain.** Treasury believes what the RPC returns. Use a provider you
  trust, and prefer one whose `eth_getLogs` window lets `earn_balance` read the whole history.
- **Your signer is the whole security model.** Treasury is designed so that a compromised or
  misbehaving agent can at most *propose* a transaction. What actually executes is whatever your
  signer approves. Configure it to show destination, amount and calldata, and to refuse anything it
  does not recognise.

## What Treasury will not do

It will not sign, send, transfer, hold a key, hold funds, route to a vault outside its registry, retry
a gated deposit, or present a partial history as a measurement. If a build of "Treasury" does any of
these, it is not the official distribution.
