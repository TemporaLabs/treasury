# Open Agent Treasury (OAT)

**The open-source treasury management system for AI agents.** Built by Tempora Labs. Apache-2.0.
Current release: **v0.1.1** (29 September 2026).

Open Agent Treasury gives an AI agent a safe way to manage on-chain capital. The agent reads the
chain directly, works out what it wants to do, and hands back unsigned transactions. A human, or
the agent's own signer, reviews and signs them. OAT never holds a private key and never signs: a
transaction goes out only from the operator's own wallet, after they approve it there. Treasury itself
sends no telemetry; the optional sign-in page loads Privy, whose script sends its own analytics.

## The first skill: Earn

Earn puts idle USDC to work in Tempora-curated vaults on Base and Arbitrum One. With it, an agent can:

- **Inspect vaults:** assets, fees, deposit access, and links to verify each contract independently.
- **Prepare a deposit:** review the terms, simulate access, then build unsigned calls.
- **Track a position:** its value, deposits and earnings, read from on-chain records.
- **Prepare a withdrawal:** check what is withdrawable right now, then build unsigned calls.

Earn is USDC in, USDC out. It runs as a command line: eight `earn` commands, READ commands that
return facts from the chain and PREPARE commands that return unsigned calls, and five `connect`
commands that hand calls to the operator's own wallet for approval. CI asserts both command lists on
every build, so a signing command cannot slip in.

## The default vault

Earn deposits into **Tempora Labs Cash Plus USDC (Test 2)** by default, a Morpho Vault V2 on Base
that any account can deposit into. Over the last seven days it has earned about **4.4% APY**,
measured from its on-chain share price; Morpho's dashboard shows 4.3%.

Vault page: https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf

The vault is small by design: it is a test vault, seeded with a few dollars so the product can be
exercised end to end with real USDC. Tempora is adding to it as testing continues, and its size will
grow from here. Check the vault page for the current total.

> **Both the software and the vault are in testing.** Real USDC, real risk, pre-1.0. Returns are
> variable, and withdrawals depend on available liquidity. Review every transaction before signing
> and keep deposits small. OAT reports what your position is worth and what it earned; it does not
> promise a yield.

## Install the skill

**Requires Node.js 22 or later.** Use a keyed Base RPC: the public endpoint rate-limits quickly.

### Claude Code

```bash
export TREASURY_RPC_BASE=https://...   # your Base RPC URL
claude plugin marketplace add TemporaLabs/treasury@v0.1.1
claude plugin install treasury@treasury
```

Run `/reload-plugins` (or start a new session) so the Earn skill loads. The plugin ships from the `plugin/` folder of the main
repository as of v0.1.1. If you installed from the earlier `treasury-plugin` repository, run
`claude plugin marketplace remove treasury` first, then the two lines above.

### Any agent with a shell

```bash
npm install --save-exact @temporalabs/treasury@0.1.1
npx --no-install treasury earn --help
```

Each command prints one JSON document. The same package works as a TypeScript/JavaScript library.

### Try it

Ask your agent:

> Show me the available vaults and their risks. Then prepare a 25 USDC deposit into the default vault.

With a browser on the machine, the agent opens a page where you confirm each call in your own wallet; otherwise it returns unsigned calls for your signer. Preparing a deposit moves no money. Later:

> What is my position worth, and how much can I withdraw now?

## For agents reading this

- Every tool that takes a vault takes its ERC-20 ticker (`tlCashPlusUSDC2B` is the default on Base); every
  tool that takes an address takes it as `account`.
- Amounts are decimal USDC strings. Shares are exact strings and never cross the boundary as numbers.
- `earn_vaults` returns a `warning` for each vault. Show it to the operator before any deposit.
- A deposit is two calls, `approve` then `deposit`, returned in order with signer rules attached.
- Whether a balance is surplus is the operator's decision. A balance in the wallet is not
  permission to deposit it.

## Security

- **No keys, no custody:** the operator's wallet holds the position. Only its signer can move funds.
- **Direct RPC:** no Tempora service in the request path, and no telemetry from Treasury itself. Keyed RPC URLs are redacted
  from every output.
- **Verifiable builds:** CI checks the committed bundle, and each npm release carries provenance.
- Vulnerabilities go through private reporting, not public issues.

## What is next

The v0.1.2 cycle adds `treasury connect`, which hands each transaction to the operator's own
wallet (a browser wallet, or an email or social login) for approval in the browser, with no
copy-paste, and deposits on Arbitrum One beside Base. More yield configurations across the
risk/return spectrum are coming.

## Links

- Source: https://github.com/TemporaLabs/treasury
- Plugin and the Earn skill: https://github.com/TemporaLabs/treasury/tree/main/plugin
- npm: https://www.npmjs.com/package/@temporalabs/treasury
- Release notes: https://github.com/TemporaLabs/treasury/releases/tag/v0.1.1
- Docs: tools, configuration, risks, security model: https://github.com/TemporaLabs/treasury/tree/main/docs
- Licence: Apache-2.0. Forks must not claim to be the official distribution.
