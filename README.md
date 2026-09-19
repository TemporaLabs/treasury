# Open Agent Treasury

**The open-sourced treasury management system (TMS) for AI agents.** By Tempora Labs.

[![ci](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml)
[![DCO](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml/badge.svg)](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml)

Open Agent Treasury (OAT) gives an agent the tools to manage on-chain capital, starting with earning yield on
idle USDC. Its first skill, **Earn**, lets an agent inspect Tempora-curated vaults on Base, check
what a position is worth and how much of it is withdrawable now, and prepare deposits and
withdrawals. The agent's own wallet stays the account and the agent's own signer stays the only
thing that can move money — OAT prepares unsigned transactions; it never signs.

A [treasury management system](https://treasury.ripple.com/posts/what-is-treasury-management-system)
is the software a finance team runs to centralise cash, investments, payments and reporting. OAT is
that system with an AI agent as the treasurer and digital assets as the balance sheet — starting
with the investment function.

> **Experimental — pre-1.0.** Behaviour may change between versions. Review every transaction before
> signing it, and read [`docs/risks.md`](docs/risks.md) before a first deposit.

## Why

Agents are starting to hold real balances — budgets, revenue, working capital — and most of it sits
idle in a wallet. Treasury management is the discipline of knowing what money is available,
deciding what must stay available, controlling how it moves, and putting genuine surplus to work
within a risk budget. OAT gives an agent that discipline as tools, with the rule a
treasurer works under built in: it can measure, decide and prepare, and only the owner's signer can
execute.

## The first skill: Earn

OAT ships one skill today, **`earn`** — put idle USDC to work in a Tempora vault and
manage the position.

- **Deposit.** Idle USDC goes into a Tempora vault. Before anything is built, the skill shows the
  terms once and checks, by simulating the deposit, that this account is actually allowed in.
- **Hold.** The position earns the vault's variable yield. The skill reports what it is worth, what
  went in and what it has earned, read from the vault's own on-chain records — never a guess.
- **Withdraw.** Some or all, subject to the vault's available liquidity. No vault offered today has a
  lock-up or queues withdrawals: a withdrawal settles in the same transaction, and the skill
  measures what can be withdrawn *right now* before you sign.

What amount is surplus is the operator's call, not the skill's: a balance in a wallet is not
permission to invest it. Everything is USDC in, USDC out, and every action comes back as
**unsigned** transactions for the agent's own signer:

```
   agent ──▶ OAT ──▶ { requires_signature: true, status: "unsigned", calls: [...] }
                                         │
                     your signer — a wallet, a policy engine, a token-bound account
                                         │
                                       Base
```

OAT cannot sign, send or transfer, and there is no tool that would let it. A test fails
the build if anything in this package reads a private key.

## Where the money goes

A Tempora vault is an ERC-4626 vault on Base, curated by Tempora Labs, that lends USDC into
on-chain lending markets. **Cash Plus USDC** is the offering: stablecoin only, no lock-up, yield
from lending, positions readable on-chain by anyone. These are experimental, yield-bearing vault
positions, not bank savings accounts: returns are variable, capital is at risk, and a withdrawal
depends on the liquidity available when it is made.

| vault | chassis | deposits | address |
|---|---|---|---|
| **Cash Plus USDC (Test 2)** — the default | Morpho Vault V2 | open to any account | [`0x040fCA…134Cf`](https://basescan.org/address/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf) |
| Cash Plus USDC (Test 2A) | IPOR Fusion | whitelist-gated | [`0x1516D2…299ef`](https://basescan.org/address/0x1516D2c082b9cc9af852B1Ebc828f168F27299ef) |

**The default is Cash Plus USDC (Test 2).** It lends through Morpho on Base, keeps a liquid balance
for withdrawals, and any account can deposit. "Test" is in the name on purpose: these are the
test-series vaults — real contracts, real USDC, real positions — operated by Tempora while the
product is proven. The full detail, with the block each fact was measured at, is in
[`docs/vaults.md`](docs/vaults.md).

**Liquidity.** No vault offered today has a lock-up. A withdrawal is paid from the
vault's liquid balance and then by unwinding positions in the same transaction; under stress part
of a position may take longer, and the skill measures what is exitable now rather than promising.

**Yield.** A floating USDC lending rate — what the vault's positions earn, less any vault fee. The
default charged no fee and was earning **4.4% net APY** (30-day average 4.4%) when measured on
2026-09-17 through Morpho's public API — by a human, not by this client, which quotes no rate at
all. The skill reports the share price and what your own position has earned, from the vault's
events. The live rate is
on-chain, and a yield is always a measurement of the past, not a promise.

**Fees and interest.** The default is a Tempora-curated destination. Its fees are readable on-chain
— none was set at the last measurement — and Tempora can set them as curator. OAT offers it
because it is Tempora's, not because it is the best-yielding vault available.

## An example

```
you     Put 25 USDC to work.

agent   Cash Plus USDC (Test 2) is open to this account. 25 USDC buys <shares> at today's
        share price. Two transactions to sign, in order:
        { requires_signature: true, status: "unsigned",
          calls: [ approve(USDC → vault, 25 USDC), deposit(25 USDC, account) ] }

you     Sign them — or don't. Nothing has happened yet.

        …later…

you     What is it worth, and how much can I take out today?

agent   25.09 USDC; 25.09 withdrawable now. Put in 25.00, earned 0.09.
```

## Install

**Claude Code** — pin to a release tag; a tag is immutable, so the install cannot drift:

```bash
claude plugin marketplace add TemporaLabs/treasury-plugin@v0.1.0
claude plugin install treasury@treasury
export TREASURY_RPC_BASE=https://...   # a keyed Base RPC; unset = the public RPC, which rate-limits quickly
```

Before a release is tagged, pin its release branch instead —
`claude plugin marketplace add TemporaLabs/treasury-plugin@release/v0.1.0`. Dropping the `@<ref>`
suffix tracks the plugin repository's default branch.

The plugin is packaged in [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin)
from this repository's releases.

**npm** — the same server, and the library, for any other MCP host or for your own code:

```bash
npm install @temporalabs/treasury@0.1.0
```

Point your MCP host at `node_modules/@temporalabs/treasury/dist/mcp-server.mjs` — the same attested
bundle the plugin carries. Details, including the library entry points —
[`docs/install.md`](docs/install.md).

## Security

- **No keys, no custody.** Funds move only in transactions your signer approves, from your account.
- **No telemetry.** The server calls the RPC you configure and nothing else — no analytics, no
  yield API, no vendor. A keyed RPC URL is treated as a secret and never repeated in output.
- **A verifiable bundle.** The server is rebuilt in CI and must match byte-for-byte; every build
  carries a provenance attestation you can check —
  [`docs/runbooks/verify_the_bundle.md`](docs/runbooks/verify_the_bundle.md).
- **Found a vulnerability?** [`SECURITY.md`](SECURITY.md) — privately, never as a public issue.

## Documentation

[`docs/`](docs/README.md) — install, the tools under the skill, the vaults, the risks,
configuration, the security model, and a runbook for signing and sending.
Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Pull requests are welcome. Commits carry a `Signed-off-by` trailer (`git commit -s`) certifying the
[Developer Certificate of Origin](DCO.md). How to build, test and what a change must keep true:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

OAT is open source under the [Apache License, Version 2.0](LICENSE). Use it, modify it,
redistribute it — inside commercial agents, wallets and hosted services — keeping [`LICENSE`](LICENSE)
and [`NOTICE`](NOTICE). The Tempora names and marks are not licensed (section 6): a fork may say it is based on
OAT; it may not present itself as the official distribution. Tempora's fund-operations infrastructure is separate and is not
part of this repository. More: [`docs/licensing.md`](docs/licensing.md).
