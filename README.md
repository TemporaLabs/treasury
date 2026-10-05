# Open Agent Treasury

**The open-source treasury management system (TMS) for AI agents.** Built by Tempora Labs and contributors.

[![ci](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml)
[![DCO](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml/badge.svg)](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml)

<p align="center">
  <img src="docs/assets/oat-mascot.svg" alt="Open Agent Treasury mascot: a blue pirate robot holding a purple treasure chest" width="320" height="320">
</p>


Open Agent Treasury (OAT) helps agents manage on-chain capital. Its first skill, **Earn**, lets
agents inspect vaults curated by Tempora Labs on Base, Arbitrum One and Robinhood Chain, track positions, and prepare deposits and
withdrawals. It ships as an agent plugin, a command-line program, and a TypeScript/JavaScript library.

**OAT prepares transactions. Your wallet executes them.** It never holds private keys or signs: with
`treasury connect` your agent opens a page where you connect your own wallet — a browser wallet, or
an email or social login — and confirm each transaction; or it hands you unsigned calls for any signer.
A transaction goes out only from your own wallet, after you approve it there. You decide how much capital an agent may put to work.

> **Experimental — pre-1.0. Real funds, real risk.** Returns are variable, capital is at risk,
> and withdrawals depend on available liquidity. Review every transaction before signing and
> read the [risks](docs/risks.md) before depositing.

## What you can do

- **Inspect vaults:** check assets, fees, and deposit access.
- **Prepare a deposit:** review terms and simulate access before building unsigned calls.
- **Track a position:** see its value, deposits, and earnings from on-chain records.
- **Prepare a withdrawal:** check how much is withdrawable now and build unsigned calls.

Earn currently supports **USDC in, USDC out** through Tempora Labs' ERC-4626 vaults on Base and
Arbitrum One, and **USDG in, USDG out** on Robinhood Chain. Base is the default chain, and Test 2B its
default vault; the agent asks which chain when you have not said, and the funds have to be on that
chain already. See [Vaults](#vaults).
See the [command reference](docs/tools.md), the eight `earn` commands and the five `connect` commands, for inputs, outputs, and limits.

## Quick start

**Requires Node.js 22+ on your `PATH`.** Use a keyed RPC for each chain you use; the public fallbacks rate-limit quickly.

### Claude Code

```bash
export TREASURY_RPC_BASE=https://...      # replace with your Base RPC URL
export TREASURY_RPC_ARBITRUM=https://...  # only if you will use a vault on Arbitrum One
export TREASURY_RPC_ROBINHOOD=https://... # only if you will use a vault on Robinhood Chain
claude plugin marketplace add TemporaLabs/treasury@v0.1.2
claude plugin install treasury@treasury
```

Start a new Claude Code session after installing so the Earn skill loads. Keep the `TemporaLabs/treasury@v0.1.2` ref
explicit so the install stays on a release rather than tracking the default branch. Upgrading an
earlier install? Run `claude plugin marketplace remove treasury` first, then the two `claude plugin` lines above
([details](docs/install.md#upgrading-an-earlier-install)).

The plugin is the [`plugin/`](plugin/) folder of this repository: its manifests, the Earn skill, and a
copy of this repository's own CLI bundle and the page `treasury connect` serves, made in the same commit. The skill runs it with `node`, one
command at a time; nothing stays running.

### Any agent with a shell

```bash
npm install --save-exact @temporalabs/treasury@0.1.2
npx --no-install treasury earn --help     # every command and flag, as JSON
```

Each command prints one JSON document; a refusal exits 1 with `{ "error": … }` on stderr.
For library usage, other hosts, and troubleshooting, see [installation](docs/install.md).

### Try it

Ask your agent:

> Show me the available vaults and their risks. Then prepare a 25 USDC deposit into the default vault.

To try the demo vault or another chain, name it: *“…into the demo vault”*, or *“…on Arbitrum”*.

With a browser on the machine, you sign in once with `treasury connect`. For each deposit the agent first
shows you a fixed confirmation text, and only on your yes opens a page where you confirm each call in your
own wallet. Otherwise OAT returns unsigned calls for your signer. Preparing a deposit moves no money.
Later, ask: **“What is my position worth, and how much can I withdraw now?”**

## Vaults

A command that names no vault or chain uses **Cash Plus USDC (Test 2B)** on Base; the agent still asks
which chain first when you have not said. There are other options, and a demo.

| | vault | chain | choose it by |
|---|---|---|---|
| **Default** | **Cash Plus USDC (Test 2B)** | Base | naming nothing, or `--chain base` |
| **Demo** | **Cash Plus USDC (Test 2)** | Base | `--vault tlCashPlusUSDC2` |
| Option | **Cash Plus USDC (Test 2C)** | Arbitrum One | `--chain arbitrum` |
| Option | **Cash Plus USDG (Test 2D)** | Robinhood Chain | `--chain robinhood` |
| Option | **Cash Plus USDC (Test 2A)** | Base | `--vault tlCashPlusUSDC2A` (whitelist only) |

- **Test 2B, the default.** A Morpho Vault V2 on Base, open to any account. Its first position is a
  savings-rate token rather than a lending vault, and its other two positions differ from Test 2's too
  ([how](docs/vaults.md#offered-today)). [BaseScan](https://basescan.org/address/0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F);
  Morpho's own app has no page for it.
- **Test 2, the demo.** The same kind of vault, and the one to show people: it has a page on Morpho's
  app, [here](https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf/tempora-labs-cash-plus-usdc-test-2#overview).
  Its three positions are different vaults from Test 2B's, and the first is a lending vault. Open to any
  account, but an agent uses it only when it is named.
- **Test 2C, Arbitrum One.** A Morpho Vault V2 over native USDC, open to any account.
  [Arbiscan](https://arbiscan.io/address/0x4057a63953142Ac2b3E5dB1954Fc14d578662587). The USDC has to
  be on Arbitrum already; OAT does not bridge.
- **Test 2D, Robinhood Chain.** A Morpho Vault V2 over **USDG**, not USDC, open to any account.
  [Blockscout](https://robinhoodchain.blockscout.com/address/0x758f00731943aA88e8C7fB709e0B727903B4F833).
  The USDG has to be on Robinhood Chain already.
- **Test 2A.** IPOR Fusion, listed so an admitted account can read and exit its position.

When you have not said which chain, the agent shows these and asks before it prepares a deposit.

All of them are experimental vaults using real funds (USDC, or USDG on Robinhood Chain), not bank savings accounts. None currently has a
lock-up, but liquidity can limit withdrawals.

Tempora Labs curates these vaults and can set fees. OAT offers Tempora Labs' vaults; it does not compare
them against the market or promise the best yield. It reports your position's value and earnings,
not a quoted APY.

See [vault details](docs/vaults.md) for addresses, access rules, fees, and dated measurements.

## Security

- **No keys or custody:** your wallet holds the position; Treasury never holds a key. With an email or social login, that wallet's keys are managed by Privy; see [risks](docs/risks.md).
- **Direct RPC access:** the `earn` commands talk only to the chain's RPC (yours, or the chain's public endpoint when none is set or a history scan needs it; see [configuration](docs/configuration.md)), with no Tempora Labs service in the request path and no telemetry. Keyed RPC URLs are redacted.
- **Sign-in through Privy:** `treasury connect` signs you in through [Privy](https://privy.io), using Tempora Labs' Privy app unless you set `PRIVY_APP_ID`. Privy, and Tempora Labs as that app's owner, see your login and wallet address, and Privy's script on the page sends its own analytics. The page also loads Cloudflare's bot check (challenges.cloudflare.com) for Privy's sign-in.
- **Verifiable builds:** CI checks the committed bundle; [verify its provenance](docs/runbooks/verify_the_bundle.md).
- **Private vulnerability reporting:** follow [SECURITY.md](SECURITY.md), not a public issue.

## Documentation

- [Command reference](docs/tools.md) · [Configuration](docs/configuration.md)
- [Risks](docs/risks.md) · [Security model](docs/security-model.md)
- [Signing and sending](docs/runbooks/sign_and_send.md) · [All docs](docs/README.md) · [Changelog](CHANGELOG.md)

## Contributing

Feedback and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development,
testing, and contribution guidelines. Every commit needs a `Signed-off-by` trailer (`git commit -s`)
certifying the [Developer Certificate of Origin](DCO.md).

## Licence

[Apache-2.0](LICENSE). Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing.
The licence does not grant rights to Tempora Labs' names or marks ("Tempora", "Tempora Labs" and "Agent Treasury", as NOTICE lists them); forks must not claim to be the
official distribution. Tempora Labs' fund-operations infrastructure is separate from this repository.
See [licensing](docs/licensing.md) for details.
