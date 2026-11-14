# Open Agent Treasury (OAT)

**The open-source treasury management system for AI agents.** Built by Tempora Labs. Apache-2.0.
Current release: **v0.1.4** (November 2026).

Open Agent Treasury gives an AI agent a safe way to manage on-chain capital. The agent reads the
vaults through the Tempora API (on Solana, from the chain itself), works out what it wants to do, and hands back
unsigned transactions, each checked before a wallet sees it. A human, or
the agent's own signer, reviews and signs them. OAT never holds a private key and never signs: a
transaction goes out only from the operator's own wallet, after they approve it there. Treasury itself
sends no telemetry; the optional sign-in page loads Privy, whose script sends its own analytics.

## The first skill: Earn

Earn puts idle USDC to work in vaults curated by Tempora Labs on Base, Arbitrum One, Ethereum, Monad and Solana, and idle USDG on Robinhood Chain. With it, an agent can:

- **Inspect vaults:** assets, fees, deposit access, and links to verify each contract independently.
- **Prepare a deposit:** review the vault's terms, check access, then prepare unsigned steps.
- **Track a position:** its value, and what can be withdrawn now.
- **Prepare a withdrawal:** check what is withdrawable right now, then prepare unsigned steps.

Earn takes the vault's own asset in and pays it out: USDC on Base, Arbitrum One, Ethereum, Monad and Solana,
USDG on Robinhood Chain. It runs as a command line: nine `earn` commands, READ commands that
return facts about a vault and a position, PREPARE commands that return unsigned steps, and SUBMIT and REQUEST
commands that hand a sent step's hash back and read where a request stands; and six `connect` commands that hand
steps to the operator's own wallet for approval. CI asserts both command lists on every build, so a signing command
cannot slip in.

## The default vault

Earn deposits into **Tempora Labs Cash Plus USDC (Test 2B)** by default, a Morpho Vault V2 on Base
that any account can deposit into. Arbitrum One, Robinhood Chain, Ethereum, Monad and Solana each have their own default, and
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

**Requires Node.js 22 or later.** The EVM chains need no RPC of your own: the commands reach the Tempora API. For
the vault on Solana, set a keyed `TREASURY_RPC_SOLANA`; the public endpoint rate-limits quickly.

### Claude Code

```bash
claude plugin marketplace add TemporaLabs/treasury@v0.1.4
claude plugin install treasury@treasury
```

Start a new Claude Code session so the Earn skill loads. The plugin ships from the `plugin/` folder of the main
repository as of v0.1.1. If you installed from the earlier `treasury-plugin` repository, run
`claude plugin marketplace remove treasury` first, then the two lines above.

### Any agent with a shell

```bash
npm install --save-exact @temporalabs/treasury@0.1.4
npx --no-install treasury earn --help
```

Each command prints one JSON document. The same package works as a TypeScript/JavaScript library.

### Try it

Ask your agent:

> Show me the available vaults and their risks. Then prepare a 25 USDC deposit into the default vault.

With a browser on the machine, you sign in once with `treasury connect`. For each deposit the agent
first shows you a fixed confirmation text, and only on your yes opens a page where you confirm each
step in your own wallet. Otherwise it returns unsigned steps for your signer. Preparing a deposit moves
no money. Later:

> What is my position worth, and how much can I withdraw now?

## For agents reading this

- Every tool that takes a vault takes it as `earn vaults` lists it: on the EVM chains its contract address (`vault`)
  or its `ticker` (`tlCashPlusUSDC2B` is the default on Base), on Solana its ticker. On the EVM chains `account` is
  the connected wallet; another is refused.
- Amounts are decimal strings in the vault's asset (USDC; USDG on Robinhood Chain). Shares are exact strings and never cross the boundary as numbers.
- `earn_vaults` returns the `warnings` for each vault. Show them to the operator before any deposit, with the terms from
  `earn_terms`, whose `sha256` a deposit on an EVM chain is prepared against.
- A deposit is two steps, `approve` then `deposit`, with signer rules attached (on Solana, one transaction). Send the
  first, hand its hash to `earn_submit`, and read the request with `earn_request` until the second is `ready`.
- Whether a balance is surplus is the operator's decision. A balance in the wallet is not
  permission to deposit it.

## Security

- **No keys, no custody:** the operator's wallet holds the position. Only its signer can move funds.
- **The Tempora API on the EVM chains:** `earn` and `connect` call the Tempora API and nothing else there. A deposit
  reaches the vault the API lists; Treasury holds no contract address for these vaults, and checks every step against
  the API's own record of the vault before the wallet sees it (a wrong step is caught; a wrong record is not). Smart
  Growth portfolios (`invest`) go through the same API, with every step checked too.
- **Direct RPC on Solana:** no Tempora Labs service in the request path for the vault on Solana, and no telemetry from
  Treasury itself. Keyed RPC URLs are redacted from every output.
- **Verifiable builds:** CI checks the committed bundle, and each npm release carries provenance.
- Vulnerabilities go through private reporting, not public issues.

## New in v0.1.4

One acknowledgement for a plan of several deposits and withdrawals, across vaults and chains, and
one signing page that walks the whole plan in the operator's wallet, Solana legs included. On Solana, a landed withdrawal is checked for what it paid, and
`earn balance` no longer reports a capped exit as a full one.

## New in v0.1.3

Three more chains: Ethereum and Monad, each with a Morpho vault over USDC, and Solana, with a Kamino
vault over USDC and a Solana wallet through `treasury connect`. The registry and the version are built
into the CLI, and `treasury --help` points agents without the plugin to `llms.txt`, a guide generated
from the Earn skill.

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
- Release notes: https://github.com/TemporaLabs/treasury/releases/tag/v0.1.4
- Docs: tools, configuration, risks, security model: https://github.com/TemporaLabs/treasury/tree/main/docs
- Licence: Apache-2.0. Forks must not claim to be the official distribution.
