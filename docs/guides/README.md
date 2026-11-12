# Developer guides

How Treasury works inside, written so a developer, a student or a coding agent can reason about it
without first reading `src/`. Each topic is a directory with a short README and numbered guides, in
reading order.

These guides explain mechanisms and where they live. They do not repeat the user-facing documents:
what each command takes and returns is in [`../tools.md`](../tools.md), the vaults on offer in
[`../vaults.md`](../vaults.md), environment variables in [`../configuration.md`](../configuration.md),
the security guarantees in [`../security-model.md`](../security-model.md), and shipping a release in
[`../release-process.md`](../release-process.md). Where a guide needs one of those facts, it links.

**Where a guide and the code disagree, the code is right and the guide is a bug.** Fix the guide in
its own documentation-only pull request.

## Reading order

1. [`architecture/`](architecture/README.md): the whole picture, then one deposit traced end to end.
2. The topic your change touches, from the table below.
3. [`testing/`](testing/README.md) before you open a pull request.

## Topics

| directory | covers | read it when |
|---|---|---|
| [`architecture/`](architecture/README.md) | the layers, which file owns what, one deposit traced from `earn quote` to the receipt | you are new here, or a change crosses two layers |
| [`cli/`](cli/README.md) | `src/cli.ts`, how a command is declared, the response envelope, errors, `--help` and `llms.txt` | you add, rename or change a command or a flag |
| [`registry/`](registry/README.md) | `registry/vaults.json`, its schema, how a vault and a chain are resolved, defaults, reconciliation | you add a vault or a chain, or touch vault selection |
| [`evm/`](evm/README.md) | the ERC-4626 path: RPC clients, pre-flight, quotes, the unsigned builders, the position read | you change anything an EVM read or build does |
| [`solana/`](solana/README.md) | the Kamino vault path: decoders, instruction builders, simulation, the Solana earn commands | you change anything on Solana |
| [`connect/`](connect/README.md) | `treasury connect`: the local page, sign-in, the gates, the acknowledgement and plans, receipt checks | you change the wallet connection or its page |
| [`invest/`](invest/README.md) | `src/invest/`: the portfolio-withdrawal gate, BNB Chain holdings and the sign-in challenge check | you change `src/invest/` |
| [`testing/`](testing/README.md) | the unit, live and fork tiers, the boundary test, and the tests that pin decisions | you write or run tests |
| [`release/`](release/README.md) | the build, the committed bundles, the plugin copies, generated files and the CI gates on them | you change the build, or anything CI rebuilds and compares |

Agents start at [`AGENTS.md`](AGENTS.md), which maps where each kind of fact lives.
