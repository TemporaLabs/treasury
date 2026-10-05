# Open Agent Treasury (OAT)

**The open-source treasury management system for AI agents.** Built by Tempora Labs. Apache-2.0.
Current release: **v0.1.2** (October 2026).

Open Agent Treasury gives an AI agent a safe way to manage on-chain capital. The agent reads the
chain directly, works out what it wants to do, and hands back unsigned transactions. A human, or
the agent's own signer, reviews and signs them. OAT never holds a private key and never signs: a
transaction goes out only from the operator's own wallet, after they approve it there. Treasury itself
sends no telemetry; the optional sign-in page loads Privy, whose script sends its own analytics.

## The first skill: Earn

Earn puts idle USDC to work in vaults curated by Tempora Labs on Base and Arbitrum One, and idle USDG on Robinhood Chain. With it, an agent can:

- **Inspect vaults:** assets, fees, deposit access, and links to verify each contract independently.
- **Prepare a deposit:** review the terms, simulate access, then build unsigned calls.
- **Track a position:** its value, deposits and earnings, read from on-chain records.
- **Prepare a withdrawal:** check what is withdrawable right now, then build unsigned calls.

Earn takes the vault's own asset in and pays it out: USDC on Base and Arbitrum One, USDG on Robinhood
Chain. It runs as a command line: eight `earn` commands, READ commands that
return facts from the chain and PREPARE commands that return unsigned calls, and five `connect`
commands that hand calls to the operator's own wallet for approval. CI asserts both command lists on
every build, so a signing command cannot slip in.

## The default vault

Earn deposits into **Tempora Labs Cash Plus USDC (Test 2B)** by default, a Morpho Vault V2 on Base
that any account can deposit into. Arbitrum One and Robinhood Chain each have their own default, and
the agent asks which chain when the operator has not said.

Vault: https://basescan.org/address/0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F

**Tempora Labs Cash Plus USDC (Test 2)** is the demo vault: the one Morpho's app lists, used only when
it is named. Vault page: https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf

These are test vaults, there to exercise the product end to end with real funds. Check a vault's
page for its current total.

> **Both the software and the vaults are in testing.** Real funds, real risk, pre-1.0. Returns are
> variable, and withdrawals depend on available liquidity. Review every transaction before signing
> and keep deposits small. OAT reports what your position is worth and what it earned; it does not
> promise a yield.

## Install the skill

**Requires Node.js 22 or later.** Use a keyed Base RPC: the public endpoint rate-limits quickly.

### Claude Code

```bash
export TREASURY_RPC_BASE=https://...   # your Base RPC URL
claude plugin marketplace add TemporaLabs/treasury@v0.1.2
claude plugin install treasury@treasury
```

Run `/reload-plugins` (or start a new session) so the Earn skill loads. The plugin ships from the `plugin/` folder of the main
repository as of v0.1.1. If you installed from the earlier `treasury-plugin` repository, run
`claude plugin marketplace remove treasury` first, then the two lines above.

### Any agent with a shell

```bash
npm install --save-exact @temporalabs/treasury@0.1.2
npx --no-install treasury earn --help
```

Each command prints one JSON document. The same package works as a TypeScript/JavaScript library.

### Try it

Ask your agent:

> Show me the available vaults and their risks. Then prepare a 25 USDC deposit into the default vault.

With a browser on the machine, you sign in once with `treasury connect`. For each deposit the agent
first shows you a fixed confirmation text, and only on your yes opens a page where you confirm each
call in your own wallet. Otherwise it returns unsigned calls for your signer. Preparing a deposit moves
no money. Later:

> What is my position worth, and how much can I withdraw now?

## For agents reading this

- Every tool that takes a vault takes its ERC-20 ticker (`tlCashPlusUSDC2B` is the default on Base); every
  tool that takes an address takes it as `account`.
- Amounts are decimal strings in the vault's asset (USDC; USDG on Robinhood Chain). Shares are exact strings and never cross the boundary as numbers.
- `earn_vaults` returns a `warning` for each vault. Show it to the operator before any deposit.
- A deposit is two calls, `approve` then `deposit`, returned in order with signer rules attached.
- Whether a balance is surplus is the operator's decision. A balance in the wallet is not
  permission to deposit it.

## Security

- **No keys, no custody:** the operator's wallet holds the position. Only its signer can move funds.
- **Direct RPC:** no Tempora Labs service in the request path, and no telemetry from Treasury itself. Keyed RPC URLs are redacted
  from every output.
- **Verifiable builds:** CI checks the committed bundle, and each npm release carries provenance.
- Vulnerabilities go through private reporting, not public issues.

## New in v0.1.2

`treasury connect` hands each transaction to the operator's own wallet (a browser wallet, or an
email or social login) for approval in the browser, with no copy-paste, after the operator answers a
fixed acknowledgement. Deposits work on Arbitrum One and Robinhood Chain beside Base.

## What is next

More yield configurations across the risk/return spectrum.

## Links

- Source: https://github.com/TemporaLabs/treasury
- Plugin and the Earn skill: https://github.com/TemporaLabs/treasury/tree/main/plugin
- npm: https://www.npmjs.com/package/@temporalabs/treasury
- Release notes: https://github.com/TemporaLabs/treasury/releases/tag/v0.1.2
- Docs: tools, configuration, risks, security model: https://github.com/TemporaLabs/treasury/tree/main/docs
- Licence: Apache-2.0. Forks must not claim to be the official distribution.
