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
  its own smart-contract, custody and mechanism risk that Tempora Labs does not control. Some of
  the underlying positions lend against stablecoins whose oracle assumes par, so the oracle cannot see a
  depeg. Each vault's loss model treats that differently, and Treasury does not model it. Which positions
  a vault holds is in [`vaults.md`](vaults.md); read the markets behind them on-chain before a first deposit.
- **Liquidity.** A withdrawal is served from the vault's liquid balance and then by unwinding its
  positions. Under stress, part of a position may not be withdrawable immediately. `earn_balance`
  reports what can be withdrawn now, measured by simulating withdrawals (on the EVM chains the Tempora API's
  `withdrawable`, a floor; on Solana `exit.exitableNow`) — trust that, not `maxWithdraw()`.
- **Access.** A whitelist-gated vault admits deposits only from accounts the fund has admitted.
  Withdrawals are public. Admission can be granted and, in principle, revoked, by the fund.
- **Fees.** A vault's curator can set a management fee and a performance fee; both are readable
  on-chain. None of the listed Morpho vaults sets one today, and their fee timelocks are 0, so the
  curator can introduce a fee without notice; read both fees before depositing. Each vault's row in
  [`vaults.md`](vaults.md) carries the block it was measured at.
- **Every vault here, the defaults and the demo, belongs to Tempora Labs.** It is offered because Tempora Labs curates it, and can set fees on it, not
  because it is the best-yielding vault available.

## The client

- **It prepares; it does not sign.** Nothing has happened until your signer's or your wallet's
  transactions confirm. If a tool result and the chain disagree, the chain is right.
- **A quote is a simulation at one block.** State can change between the quote and the signed
  transaction. The request decides; send a step only when it is `ready`.
- **A step is for one chain.** The envelope names the chain and its `chainId`. Send it on that chain only, with the vault's asset (USDC; USDG on Robinhood Chain) already
  there: Treasury does not bridge. A transaction sent on a different chain, to an address with no
  contract there, is mined and does nothing — the deposit did not happen and the gas is spent. Check your signer's network first.
- **On Solana, a prepared transaction expires** about a minute after it was built (it names a recent
  blockhash). Sign it then or prepare it again; `connect` builds it when you press Confirm. A wallet can
  report a transaction as expired that in fact landed: check the account before preparing another.
- **On Solana, each withdraw instruction keeps up to 0.001 USDC in the vault**, a charge Kamino sets for
  every vault on its program and can change at any time without notice. A withdrawal split across two
  reserves is two instructions and can pay it twice; one worth 0.001 USDC or less is refused.
- **On Solana, Kamino can stop deposits and exits.** Its program can require a co-signer on every deposit
  and every withdrawal of a vault; set by Kamino's global admin, with no delay, that stops exits until it
  co-signs. Unset today; Treasury refuses to build while one is set.
- **On Solana, the terms can change with no notice.** The vault admin can set fees and the vault's own
  withdrawal penalty, and the vault admin or Kamino's global admin can set a per-reserve crank fee on
  deposits and minimum amounts, each taking effect in the transaction that makes it (all 0 today). Kamino's
  programs are upgradeable by Kamino. Read the vault's state before a deposit.
- **Gas on Ethereum is far higher than on the other chains.** The approve, the deposit and the later
  withdrawal each pay Ethereum gas in ETH, which can be a large share of a small deposit. The other
  chains here cost a small fraction of that per transaction.
- **On the EVM chains, money goes only to the connected wallet.** Every step is checked to pay the shares, or the
  withdrawn asset, to the connected account and no other. A receiver of your choosing is not offered there; on Solana
  the receiver must be the account itself.
- **On the EVM chains, the Tempora API is part of the trust chain.** It lists the vaults, and a deposit reaches the
  vault it lists: Treasury holds no contract address for these vaults. Treasury checks every step against the API's
  own record of the vault, which catches a wrong step but not a wrong record. Positions, quotes, gates and how a step
  landed are the API's reading. Earnings since your first deposit (basis and yield) are not available through it.
- **On Solana, your RPC is part of the trust chain.** Treasury believes what the RPC returns. Use a provider you
  trust.
- **An email or social login gives a Privy embedded wallet.** `treasury connect` offers it beside
  browser wallets. Its keys are managed by Privy for that Privy app, not by you or by Treasury, and a
  different `PRIVY_APP_ID` gives a different wallet for the same login. Anyone who controls that email
  or social account can sign in and approve transactions. Export and recovery go through Privy, not
  this page. The wallet starts empty and needs the vault's asset (USDC, or USDG on Robinhood Chain)
  and the chain's gas token. Use a browser wallet for amounts you would not trust to an email account.
- **Your signer is the whole security model.** Treasury is designed so that a compromised or
  misbehaving agent can at most *propose* a transaction. What actually executes is whatever your
  signer approves. Configure it to show destination, amount and calldata, and to refuse anything it
  does not recognise.

## Smart Growth portfolios (`treasury invest`)

- **A Tempora Labs service is in the path**, as for the vaults on the EVM chains. The Tempora API prepares every deposit and withdrawal and records
  each step. Treasury checks every step before your wallet sees it, but the positions, balances and request states
  it shows are the API's reading.
- **An outside provider holds the portfolio.** Your USDT goes to a smart account the provider opens for you; the
  provider runs the portfolio and the withdrawals. The address of that account comes from the API, and only the
  provider can confirm it.
- **The enrolment signature cannot be read.** It is a 32-byte code from the provider. Sign it only for a deposit
  you started just now, in your own terminal.
- **A transfer sent once is never sent again by Treasury.** If a command stops after a transfer was sent, read the
  request (`invest request`) before anything else. The same holds for a vault step on an EVM chain: read it with
  `earn request`.

## What Treasury will not do

It will not sign, hold a key, hold funds, send anything you have not approved in your own wallet,
route to a vault outside the Tempora API's listing (on Solana, outside its registry), send a step the API put up again
after it was sent, retry a gated deposit, or present a partial history as a measurement. If a build of "Treasury" does any of
these, it is not the official distribution.
