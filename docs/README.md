# Agent Treasury — documentation

Treasury is the depositor-side client for Tempora's vaults: libraries and an agent skill that let an
agent (or any program holding its own signer) open an Earn position in a Tempora vault, read what it
is worth, and prepare — never sign — the transactions to deposit and withdraw. The vaults are ERC-4626
contracts on Base; the client talks to them directly, with no service of Tempora's in the path.

Every document here is written to be read by an agent as well as a person: plain Markdown, one
subject per file, facts stated with the block or date they were measured at.

## Start here

| document | what it answers |
|---|---|
| [`install.md`](install.md) | how to install the plugin in Claude Code, or run the MCP server under any agent runtime |
| [`tools.md`](tools.md) | the eight `earn_*` tools: inputs, outputs, and what each one refuses |
| [`vaults.md`](vaults.md) | the vaults offered, their addresses, access rules, fees and how access is granted |
| [`risks.md`](risks.md) | what can go wrong with your money, stated before you deposit |
| [`configuration.md`](configuration.md) | environment variables, RPC choice, `eth_getLogs` windows and the fallback |

## How it works

| document | what it answers |
|---|---|
| [`security-model.md`](security-model.md) | why Treasury only prepares, how the boundary is enforced in code and CI, and what the redaction guarantees |
| [`runbooks/sign_and_send.md`](runbooks/sign_and_send.md) | one working way to sign and send the prepared calls from a process that holds a key, with the three failure modes met doing it |
| [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md) | how to check that the bundle you installed is the one CI built from the commit it claims |
| [`licensing.md`](licensing.md) | why Apache-2.0, what the licence does and does not grant, and what keeps the official distribution official |

## Contributing and project

[`CONTRIBUTING.md`](https://github.com/TemporaLabs/treasury/blob/main/CONTRIBUTING.md) · [`SECURITY.md`](https://github.com/TemporaLabs/treasury/blob/main/SECURITY.md) ·
[`CHANGELOG.md`](https://github.com/TemporaLabs/treasury/blob/main/CHANGELOG.md)

## Two invariants, stated once

1. **The client knows nothing of the fund's internals.** It knows a vault address, an RPC, and the
   ERC-4626 interface. What the fund holds, how it allocates, and who operates it are readable on-chain
   and are not modelled here.
2. **Nothing in this repository holds, reads, derives, or is handed a private key. Nothing signs.
   Nothing sends.** A test fails the build if any file under the package reads a secret, reaches
   outside the package, or starts a process.
