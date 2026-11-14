# docs/guides/AGENTS.md

The map for a coding agent about to change how Treasury works. Read it before touching `src/`,
`connect-page/` or `registry/vaults.json`. It points; the guides and the code explain.

## Start here

1. [`architecture/01-overview.md`](architecture/01-overview.md): the layers and which file owns what.
2. [`architecture/02-a-deposit-traced.md`](architecture/02-a-deposit-traced.md): one deposit through
   every layer.
3. The topic for your task (table below), then [`testing/01-test-tiers.md`](testing/01-test-tiers.md).

The repository's own rules are in the root [`AGENTS.md`](../../AGENTS.md) and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md); they win over anything here.

## Where authority lives

Copy no number or list out of prose. Read it from the file that owns it.

| fact | owned by |
|---|---|
| vaults on the EVM chains: contract, asset, decimals, status, terms, warnings | the Tempora API's products, read by `src/earn/api.ts`; nothing about them is stored here |
| the Solana vault (and the library's EVM rows): addresses, assets, decimals, chassis, measured access, deployment block | `registry/vaults.json`, validated by `src/registry-schema.ts` |
| default chain, default vault address per EVM chain, the library's default vault per chain, round-trip vault, test fixtures | `src/config/earn.ts` (`EARN`) |
| supported EVM chains, their RPC variables and public endpoints | `chains` and `CHAIN_INFO` in `src/client.ts` |
| Solana's RPC variables and public endpoint | `SOLANA_INFO` in `src/client.ts` |
| block explorers | `EXPLORER` in `src/links.ts` |
| Solana program ids, PDA seeds, account sizes, transaction limits | `src/solana/constants.ts` |
| Kamino account layouts | `src/solana/layout.ts`, pinned to `vendor/kamino/decode-fixtures.json` |
| the pre-deposit disclosures | `DISCLOSURES` in `src/disclosures.ts` |
| the signer rules every build carries | `SIGNER_RULES` in `src/earn/commands.ts`, `SOLANA_SIGNER_RULES` in `src/earn/solana.ts` |
| acknowledgement and plan lifetimes, plan size | `ACK_TTL_MS`, `PLAN_TTL_MS`, `PLAN_MAX_LEGS` in `src/connect/ack.ts` |
| connect page time limits | `CONNECT_TTL_MS`, `CONFIRM_TTL_MS`, `LEG_MIN_MS` in `src/connect/commands.ts` |
| connect ports, Privy app id, state directory | `src/connect/config.ts` |
| the page's Content-Security-Policy | `PAGE_CSP` in `src/connect/page.ts` |
| invest limits | `INVEST` in `src/config/invest.ts` |
| environment variables the package may read | the allowlist in `tests/boundary.unit.test.ts`; documented in [`../configuration.md`](../configuration.md) |
| the command list and flags | the `register(...)` calls in `src/earn/commands.ts` and `src/connect/commands.ts`; `treasury earn --help` prints them |
| the declared version | `package.json`; `scripts/check-versions.sh` lists every other declaration |

## Binding rules

| rule | enforced by |
|---|---|
| Nothing signs, holds or derives a key; the earn commands only return unsigned calls | no signer code exists; the CI step that runs the bundle and asserts the exact command and flag set (`.github/workflows/ci.yml`) |
| The client reaches only the chain: no import, process or environment variable outside the allowlist | `tests/boundary.unit.test.ts` (an AST analysis, with fixtures that must fail it). Never loosen it to make a change pass |
| `treasury connect` and `earn prepare_*` put in front of a wallet only checked steps, for the connected account | on the EVM chains `checkSteps` in `src/earn/request.ts` and `src/connect/vault-request.ts`, see [`earn-api/01-the-api-path.md`](earn-api/01-the-api-path.md); on Solana `src/connect/gate-solana.ts`, see [`connect/02-gates.md`](connect/02-gates.md) |
| A page opens only for calls the operator was shown in the acknowledgement text | `checkAck` and `checkPlanLeg` in `src/connect/ack.ts` |
| A deposit response carries the vault's warning, from one place only | `commitsMoney` in `src/earn/commands.ts`, asserted by `tests/commands.unit.test.ts` |
| The library's default vault in config and the registry's `isDefault` agree | `defaultVault` in `src/registry.ts` throws on disagreement |
| An EVM chain's default product is one the API lists, never replaced by another | `resolveProduct` in `src/earn/api.ts`, asserted by `tests/earn-api.unit.test.ts` |
| Committed bundles and generated files match a fresh build | CI rebuilds and compares; see [`release/01-build-and-bundles.md`](release/01-build-and-bundles.md) |
| `plugin/` copies are never edited by hand | `scripts/sync-plugin.sh --check` (`npm run plugin:check`) |
| Adding, removing or renaming a command updates `plugin/skills/earn/SKILL.md` in the same pull request | the CI step comparing the skill's command table with `earn --help` |
| Amounts are decimal strings in the asset's decimals, never floats | `parseAmount` / `formatAmount` in `src/units.ts` |
| This repository is public: nothing internal in any file, commit or pull request | the root [`AGENTS.md`](../../AGENTS.md) |

## Topics

| directory | open it when |
|---|---|
| [`architecture/`](architecture/README.md) | you are new, or a change crosses layers |
| [`cli/`](cli/README.md) | you add or change a command, a flag, a response field or an error |
| [`earn-api/`](earn-api/README.md) | you change an EVM earn or connect command, or what is checked before a step reaches a wallet |
| [`registry/`](registry/README.md) | you change the Solana row, a chain, or how the library chooses a vault |
| [`evm/`](evm/README.md) | you change the library's EVM read, quote, pre-flight, build or position (the commands no longer use it) |
| [`solana/`](solana/README.md) | you change anything for the Solana vault |
| [`connect/`](connect/README.md) | you change `treasury connect`, its gates, acknowledgements or page |
| [`invest/`](invest/README.md) | you change `src/invest/` |
| [`testing/`](testing/README.md) | you write a test or need to know which tier proves what |
| [`release/`](release/README.md) | you change the build, the bundles, the plugin folder or generated files |

## When the guides are wrong

The code wins. Fix the guide in a documentation-only pull request against the current
`release/vX.Y.Z` branch, separate from any feature work, and run the repository's link check (the
`docs` step in `.github/workflows/ci.yml`) before pushing.
