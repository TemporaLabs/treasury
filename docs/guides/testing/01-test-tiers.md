# 01: Test tiers, and the tests that are rules

Everything runs under vitest (`vitest.config.mts`, which includes `tests/**/*.test.ts`). `npm test`
first compiles the package and the scripts with TypeScript 7 (`tsc -b`, `tsc -p tsconfig.scripts.json`, run by path,
see [the build guide](../release/01-build-and-bundles.md#npm-run-build-step-by-step)), so a type error
fails the run before any test.

## The three tiers

| tier | what it proves | runs when | files |
|---|---|---|---|
| **unit** | the code's logic, against synthetic rows, a stand-in Tempora API, scripted RPC answers and committed snapshots; no network | always (`npm test`) | `tests/*.unit.test.ts`, and the offline files without the suffix (`tests/registry.test.ts`, `tests/registry-check.chain.test.ts`) |
| **live** | the Solana decoders still read the program's current layout, and a stranger's pre-flight still says it needs funds | `TREASURY_RPC_SOLANA` (or `SOLANA_RPC_URL`) is set; skipped otherwise | `tests/live.test.ts` |
| **fork** | a full deposit and withdrawal round trip on the Solana vault, using only transactions this package builds | `TREASURY_FORK=1` (`npm run test:fork`) and a Solana RPC to fork from | `tests/fork-solana.test.ts` (Surfpool) |

CI runs the unit tier only; live and fork skip themselves there. Say in a pull request which tiers
you ran, because the unit tier says nothing about the chain. There is no EVM live or fork tier: on the EVM chains
the Tempora API reads and prepares everything, so the unit tier holds the commands to a stand-in API
(`tests/fixtures/api.ts`), and `checkSteps` is tested in `@temporalabs/client` itself.

**No tier needs a real key.** The Solana fork signs with a key generated for the run and funded only on the local
fork. It uses its own port, records the PID it started, and kills only that PID.

## TypeScript 6 in two tests

`tests/boundary.unit.test.ts` and `tests/connect-page-source.unit.test.ts` read source files with the TypeScript
compiler as a library. TypeScript 7 has no JavaScript compiler API yet, so they import `@typescript/typescript6`, a
dev-dependency that is never shipped and never used to build. Nothing else uses it. When TypeScript 7 gains that API,
the two tests can move to it and the package can be removed.

## Shared fixtures

- `tests/fixtures/registry.ts`: synthetic registry rows (chassis the registry does not ship, a vault
  open to anyone), installed through `__setRegistryForTests` so a unit test does not depend on which
  vaults the fund offers today.
- `tests/fixtures/solana/`: a recorded mainnet vault snapshot, the input for the Solana decoders and
  simulations offline.
- `vendor/kamino/`: Kamino's own encodings of the same inputs (see
  [`../solana/01-kamino-vault-path.md`](../solana/01-kamino-vault-path.md)).

## The tests that are rules

Some tests encode a design rule rather than a behaviour. Do not weaken them to make a change pass;
if the rule should change, that is a separate decision.

- **`tests/boundary.unit.test.ts`.** Parses every TypeScript file under `src/`, `scripts/` and `tests/`
  with the TypeScript compiler and fails on any import, `require` or dynamic load outside the
  package's allowlist, any environment variable not on its exact allowlist (or read with a computed
  key), any process started outside the named files, and shipped code reaching a test seam. It has
  positive controls, so it cannot pass by seeing nothing. A new chain's RPC variables are the one
  routine edit it needs. What it enforces, as a guarantee, is in
  [`../../security-model.md`](../../security-model.md#what-enforces-it).
- **Tests that pin a product decision** (`tests/registry.test.ts` for the shipped registry, the
  default-vault tests). Restate them deliberately when the decision changes.
- **Structural single-source tests.** `tests/commands.unit.test.ts` fails if any line but
  `commitsMoney` writes a deposit warning; `tests/connect-page-source.unit.test.ts` reads the page's
  source as text and pins what it may ask a wallet for and where it may connect.
- **The bundle and entry point.** `tests/entrypoint.unit.test.ts` runs the committed
  `dist/treasury.mjs` and checks it answers only when it is the file Node was asked to run;
  `tests/embedded.unit.test.ts` checks the registry and version are inlined into a bundle.

## Writing a new test

- **Show it can fail.** Break the behaviour it guards, watch it go red, restore it.
- **Separate a refusal from a transport failure** in what you assert, as the code does: a mocked
  revert and a mocked network error must produce different results.
- **Inject, do not patch globals.** The connect flows take a `ConnectDeps` (`src/connect/commands.ts`)
  for the clock, the browser opener, the Tempora API, the Solana reads and the time limits. Use them.
- **Keep a tier honest.** A test that needs a chain belongs in the live or fork tier and must skip,
  visibly, when its variable is unset.

## Shell-script gates

`.github/scripts/` holds the shell gates CI runs (DCO, version pins, package detection, the
attestation decision) and offline `*.test.sh` cases that prove each gate, and the root scripts
`scripts/check-versions.sh` and `scripts/sync-plugin.sh`, can go red. Run the matching test script
after changing one of them.
