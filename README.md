# Open Agent Treasury

**The open-source treasury management system (TMS) for AI agents.** Built by Tempora Labs and contributors.

[![ci](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/treasury/actions/workflows/ci.yml)
[![DCO](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml/badge.svg)](https://github.com/TemporaLabs/treasury/actions/workflows/dco.yml)

<p align="center">
  <img src="docs/assets/oat-mascot.svg" alt="Open Agent Treasury mascot: a blue pirate robot holding a purple treasure chest" width="320" height="320">
</p>


Open Agent Treasury (OAT) helps agents manage on-chain capital. Its first skill, **Earn**, lets
agents inspect Tempora-curated vaults on Base, track USDC positions, and prepare deposits and
withdrawals. It ships as an agent plugin, an MCP server, and a TypeScript/JavaScript library.

**OAT prepares transactions. Your signer executes them.** It never holds private keys, signs,
or sends transactions. You decide how much capital an agent may put to work.

> **Experimental — pre-1.0. Real funds, real risk.** Returns are variable, capital is at risk,
> and withdrawals depend on available liquidity. Review every transaction before signing and
> read the [risks](docs/risks.md) before depositing.

## What you can do

- **Inspect vaults:** check assets, fees, and deposit access.
- **Prepare a deposit:** review terms and simulate access before building unsigned calls.
- **Track a position:** see its value, deposits, and earnings from on-chain records.
- **Prepare a withdrawal:** check how much is withdrawable now and build unsigned calls.

Earn currently supports **USDC in, USDC out** through Tempora's ERC-4626 vaults on Base.
See the [eight `earn_*` tools](docs/tools.md) for inputs, outputs, and limits.

## Quick start

**Requires Node.js 22+ on your `PATH`.** Use a keyed Base RPC; the public fallback rate-limits quickly.

### Claude Code

```bash
export TREASURY_RPC_BASE=https://...  # replace with your Base RPC URL
claude plugin marketplace add TemporaLabs/treasury-plugin@v0.1.0
claude plugin install treasury@treasury
```

Restart your Claude Code session after installing so the MCP tools connect. Before a release is
tagged, use `@release/v0.1.0` instead of `@v0.1.0`. Keep the ref explicit to avoid tracking the
plugin repository's default branch.

### Other MCP hosts

```bash
npm install @temporalabs/treasury@0.1.0
```

Add the server to your host's MCP configuration, replacing the path and RPC URL:

```json
{
  "mcpServers": {
    "treasury": {
      "command": "node",
      "args": ["<absolute-project-path>/node_modules/@temporalabs/treasury/dist/mcp-server.mjs"],
      "env": { "TREASURY_RPC_BASE": "https://..." }
    }
  }
}
```

In v0.1.0, run the bundle by path as shown; the `treasury-mcp` shortcut does not start the server.
For library usage, host setup, and troubleshooting, see [installation](docs/install.md).

### Try it

Ask your agent:

> Show me the available vaults and their risks. Then prepare a 25 USDC deposit into the default vault.

OAT returns unsigned calls for your signer to review and execute. Preparing a deposit moves no money.
Later, ask: **“What is my position worth, and how much can I withdraw now?”**

## Vaults

The default, **Cash Plus USDC (Test 2)**, uses Morpho Vault V2 and is open to any account.

Explore the default vault in the [Morpho dashboard](https://app.morpho.org/base/vault/0x040fCA12673778FEED5DA7b2ccFbbAb0cc0134Cf/tempora-labs-cash-plus-usdc-test-2#overview) for a visual overview.

**Cash Plus USDC (Test 2A)** uses IPOR Fusion and requires whitelist access. Both are experimental
vaults using real USDC, not bank savings accounts. Neither currently has a lock-up, but liquidity
can limit withdrawals.

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

- [Tool reference](docs/tools.md) · [Configuration](docs/configuration.md)
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
