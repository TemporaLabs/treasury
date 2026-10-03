# Open Agent Treasury

**The open-source treasury management system (TMS) for AI agents.** Built by Tempora Labs and contributors.

[![ci](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml)
[![DCO](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml/badge.svg)](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml)

<p align="center">
  <img src="docs/assets/oat-mascot.svg" alt="Open Agent Treasury mascot: a blue pirate robot holding a purple treasure chest" width="320" height="320">
</p>


Open Agent Treasury (OAT) helps agents manage on-chain capital. Its first skill, **Earn**, lets
agents inspect Tempora-curated vaults on Base and Arbitrum One, track USDC positions, and prepare deposits and
withdrawals. It ships as an agent plugin, a command-line program, and a TypeScript/JavaScript library.

**OAT prepares transactions. Your signer executes them.** It never holds private keys or signs.
A transaction goes out only from your own wallet, after you approve it there. You decide how much capital an agent may put to work.

> **Experimental — pre-1.0. Real funds, real risk.** Returns are variable, capital is at risk,
> and withdrawals depend on available liquidity. Review every transaction before signing and
> read the [risks](docs/risks.md) before depositing.

## What you can do

- **Inspect vaults:** check assets, fees, and deposit access.
- **Prepare a deposit:** review terms and simulate access before building unsigned calls.
- **Track a position:** see its value, deposits, and earnings from on-chain records.
- **Prepare a withdrawal:** check how much is withdrawable now and build unsigned calls.

Earn currently supports **USDC in, USDC out** through Tempora's ERC-4626 vaults on Base and
Arbitrum One. Base is the default; the agent asks which chain when you have not said, and the USDC
has to be on that chain already.
See the [eight `earn` commands](docs/tools.md) for inputs, outputs, and limits.

## Quick start

**Requires Node.js 22+ on your `PATH`.** Use a keyed RPC for each chain you use; the public fallbacks rate-limit quickly.

### Claude Code

```bash
export TREASURY_RPC_BASE=https://...      # replace with your Base RPC URL
export TREASURY_RPC_ARBITRUM=https://...  # only if you will use a vault on Arbitrum One
claude plugin marketplace add TemporaLabs/treasury@v0.1.1
claude plugin install treasury@treasury
```

Start a new Claude Code session after installing so the Earn skill loads. Keep the `TemporaLabs/treasury@v0.1.1` ref
explicit so the install stays on a release rather than tracking the default branch. Upgrading an
earlier install? Run `claude plugin marketplace remove treasury` first, then the two `claude plugin` lines above
([details](docs/install.md#upgrading-an-earlier-install)).

The plugin is the [`plugin/`](plugin/) folder of this repository: its manifests, the Earn skill, and a
copy of this repository's own CLI bundle, made in the same commit. The skill runs it with `node`, one
command at a time; nothing stays running.

### Any agent with a shell

```bash
npm install @temporalabs/treasury@0.1.1
npx --no-install treasury earn --help     # every command and flag, as JSON
```

Each command prints one JSON document; a refusal exits 1 with `{ "error": … }` on stderr.
For library usage, other hosts, and troubleshooting, see [installation](docs/install.md).

### Try it

Ask your agent:

> Show me the available vaults and their risks. Then prepare a 25 USDC deposit into the default vault.

OAT returns unsigned calls for your signer to review and execute. Preparing a deposit moves no money.
Later, ask: **“What is my position worth, and how much can I withdraw now?”**

## Vaults

The default, **Cash Plus USDC (Test 2B)**, is on Base, uses Morpho Vault V2 and is open to any account. Its cash-like leg is a savings-rate token, not a lending vault. Morpho's own app has no page for it, so verify it on [BaseScan](https://basescan.org/address/0x91BcEbA5feCB9E92d80F1845B55cC56621E9352F).

**Cash Plus USDC (Test 2)**, also on Base, is the demo vault: open to any account, and chosen by naming it. Its [Morpho page](https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf/tempora-labs-cash-plus-usdc-test-2#overview) gives a visual overview.

**Cash Plus USDC (Test 2A)**, also on Base, uses IPOR Fusion and requires whitelist access.

**Cash Plus USDC (Test 2C)** is the default on Arbitrum One: Morpho Vault V2 over native USDC, open to
any account. Ask for it by chain ("deposit on Arbitrum") or by name.

All three are experimental vaults using real USDC, not bank savings accounts. None currently has a
lock-up, but liquidity can limit withdrawals.

Tempora Labs curates these vaults and can set fees. OAT offers Tempora's vaults; it does not compare
them against the market or promise the best yield. It reports your position's value and earnings,
not a quoted APY.

See [vault details](docs/vaults.md) for addresses, access rules, fees, and dated measurements.

## Security

- **No keys or custody:** your wallet holds the position; only your signer can move funds.
- **Direct RPC access:** no Tempora service in the request path and no telemetry. Keyed RPC URLs are redacted.
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
The licence does not grant rights to Tempora's names or marks; forks must not claim to be the
official distribution. Tempora's fund-operations infrastructure is separate from this repository.
See [licensing](docs/licensing.md) for details.
