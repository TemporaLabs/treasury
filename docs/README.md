# Agent Treasury — documentation

Treasury is the depositor-side client for Tempora Labs' vaults: libraries and an agent skill that let an
agent (or any program holding its own signer) open an Earn position in a Tempora Labs vault, read what it
is worth, and prepare — never sign — the transactions to deposit and withdraw. The vaults are ERC-4626
contracts on Base, Arbitrum One, Robinhood Chain, Ethereum and Monad, reached through the Tempora API, and a Kamino
vault on Solana, read from its own chain. The same CLI reaches Smart Growth portfolios through the Tempora API
(`treasury invest`).

Every document here is written to be read by an agent as well as a person: plain Markdown, one
subject per file, facts stated with the block or date they were measured at.

## Start here

| document | what it answers |
|---|---|
| [`install.md`](install.md) | how to install the plugin in Claude Code, or run the CLI under any agent runtime |
| [`tools.md`](tools.md) | the `earn`, `connect` and `invest` commands: inputs, outputs, and what each one refuses |
| [`vaults.md`](vaults.md) | the vaults offered, their addresses, access rules, fees and how access is granted |
| [`risks.md`](risks.md) | what can go wrong with your money, stated before you deposit |
| [`configuration.md`](configuration.md) | environment variables: the Tempora API's address, RPC choice, and the `treasury connect` settings |
| [`blurb.md`](blurb.md) | a one-page introduction to OAT and the Earn skill, written for publication and for agents that read it |

## How it works

| document | what it answers |
|---|---|
| [`security-model.md`](security-model.md) | why Treasury prepares calls or hands them to your own wallet but never signs, how the boundary is enforced in code and CI, and what the redaction guarantees |
| [`runbooks/sign_and_send.md`](runbooks/sign_and_send.md) | one working way to sign and send the prepared calls from a process that holds a key, with the three failure modes met doing it |
| [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md) | how to check that the bundle you installed is the one CI built from the commit it claims |
| [`licensing.md`](licensing.md) | why Apache-2.0, what the licence does and does not grant, and what keeps the official distribution official |
| [`release-process.md`](release-process.md) | how a release ships, why the npm publish happens on every one, and why the plugin needs no registry |
| [`design-embed-registry-and-version.md`](design-embed-registry-and-version.md) | embed the registry and the version at build time so a re-bundled library does not read the consumer's files (implemented in v0.1.3) |

## Developer guides

[`guides/`](guides/README.md) walks a developer through the code: the architecture and one deposit
traced end to end, the CLI, the Tempora API path on the EVM chains, the registry, the Solana path, the wallet
portfolio checks, the test tiers, and the build. Coding agents start at
[`guides/AGENTS.md`](guides/AGENTS.md).

## Contributing and project

[`CONTRIBUTING.md`](https://github.com/TemporaLabs/treasury/blob/main/CONTRIBUTING.md) · [`SECURITY.md`](https://github.com/TemporaLabs/treasury/blob/main/SECURITY.md) ·
[`CHANGELOG.md`](https://github.com/TemporaLabs/treasury/blob/main/CHANGELOG.md)

## Two invariants, stated once

1. **The client knows nothing of the fund's internals.** On the EVM chains it knows the Tempora API; on Solana, the
   vault's registry row, an RPC and the vault's public interface. What the fund holds, how it allocates, and who operates it are readable on-chain
   and are not modelled here.
2. **Nothing in this repository holds, reads, derives, or is handed a private key. Nothing signs.
   A call reaches the chain only from the operator's own wallet, after the operator approves it
   there,** and only after the step was checked against what the operator asked for: by `@temporalabs/client`'s
   checks on the EVM chains and for portfolios, by the Solana gate on Solana. A test fails the build if any file under the package
   reads a secret, reaches outside the package, or starts any process other than the platform's own
   "open this URL" command.
