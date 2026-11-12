# 01: Test tiers, and the tests that are rules

Everything runs under vitest (`vitest.config.mts`, which includes `tests/**/*.test.ts`). `npm test`
first compiles the package and the scripts (`tsc -b`, `tsc -p tsconfig.scripts.json`), so a type error
fails the run before any test.

## The three tiers

| tier | what it proves | runs when | files |
|---|---|---|---|
| **unit** | the code's logic, against synthetic rows, scripted RPC answers and committed snapshots; no network | always (`npm test`) | `tests/*.unit.test.ts`, and the offline files without the suffix (`tests/build.test.ts`, `tests/withdraw.test.ts`, `tests/registry.test.ts`, `tests/registry-check.chain.test.ts`) |
| **live** | the instruments still fire on the real chain: a gated vault classifies as gated, an open one as needing an approval, a public control vault the same | that chain's RPC variable is set; each chain's block is skipped otherwise | `tests/live.test.ts` |
| **fork** | a full deposit and withdrawal round trip against every depositable vault, using only calls and transactions this package builds | `TREASURY_FORK=1` (`npm run test:fork`) and that chain's RPC variable to fork from | `tests/fork.test.ts` (anvil, EVM), `tests/fork-solana.test.ts` (Surfpool, Solana) |

CI runs the unit tier only; live and fork skip themselves there. Say in a pull request which tiers
you ran, because the unit tier says nothing about the chain.

**No tier needs a real key.** The EVM fork signs by impersonating funded accounts on anvil (the
fixtures in `EARN.fixtures`, `src/config/earn.ts`). A whitelist member for a gated vault is discovered
from the vault's own access manager (`tests/access.ts`), never written into the repository. The
Solana fork signs with a key generated for the run and funded only on the local fork. Each fork test
uses its own port, records the PID it started, and kills only that PID.

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
  for the clock, the browser opener, the chain reads and the time limits; the position read takes a
  `now` and budgets. Use them.
- **Keep a tier honest.** A test that needs a chain belongs in the live or fork tier and must skip,
  visibly, when its variable is unset.

## Shell-script gates

`.github/scripts/` holds the shell gates CI runs (DCO, version pins, package detection, the
attestation decision) and offline `*.test.sh` cases that prove each gate, and the root scripts
`scripts/check-versions.sh` and `scripts/sync-plugin.sh`, can go red. Run the matching test script
after changing one of them.
