# 01: The registry, its schema, and how a vault is chosen

## A row is a set of measurements

A **registry row** describes one vault contract: its ticker, name, chain, address, chassis, asset,
share decimals, whether a stranger can deposit, and (where known) the block it was deployed at.
Every field that can be read from the chain is a claim the chain can contradict, and the code treats
it that way: the EVM pre-flight compares `asset()` and `decimals()` with the row before anything else
(`src/preflight.ts`), and the Solana `readVault` refuses a row whose mints or decimals disagree with
the vault state (`src/solana/vault.ts`).

The **chassis** is the vault's contract family. `chassisSchema` in `src/registry-schema.ts` lists the
values; `erc4626Chassis` is the subset with a standard ERC-4626 `deposit`/`redeem`, and every build,
pre-flight and default rule checks against it. A chassis outside that set can be listed but never
built for.

**Access is measured, not configured.** `depositOpen` records the result of a simulated deposit from
a stranger, with its method, block (or slot) and time, and a reason when closed. The schema refuses a
closed row with no reason, an open row with one, and a non-ERC-4626 row marked open. The pre-flight
re-measures access on every call, so a stale row costs a clear refusal, never funds.

## Two families, two schemas

EVM rows (`vaultEntrySchema`) and Solana rows (`solanaVaultEntrySchema`) are separate schemas in
separate lists (`vaults`, `solanaVaults`), because a Kamino vault has no chain id, no checksummed
address and a share mint of its own. `registrySchema` adds the whole-file rules: exactly one
`isDefault` per chain that has a vault, a default that is buildable and open (or, on EVM, gated by
whitelist), and no duplicate ticker or address across both lists.

EVM addresses must be checksummed (`isAddress(…, { strict: true })`): the registry is hand-edited
and a checksum is the only typo detector an address carries. Solana addresses are base58 and never
normalised.

## Loading and embedding

`loadRegistry()` (`src/registry.ts`) parses the file once per process and caches it. It also refuses
a registry with no vault on `EARN.defaultChain`, naming the cause, instead of failing later on a
chain nobody asked for.

The JSON is imported, not read from disk, so the build inlines it into `dist/treasury.mjs`: a bundle
never reads a registry file that happens to sit beside it. The decision and its alternatives are in
[`../../design-embed-registry-and-version.md`](../../design-embed-registry-and-version.md), and
`tests/embedded.unit.test.ts` holds it.

`__setRegistryForTests` is a test seam for synthetic rows (`tests/fixtures/registry.ts`), and it is
deliberately not exported from `src/index.ts`; the boundary test also refuses shipped code that
reaches a test seam.

## Resolving `vault` and `chain`

Every vault-taking command accepts an optional `vault` (a ticker) and an optional `chain`.
`resolveVault(symbol, chain)` settles them for the EVM rows:

| caller names | result |
|---|---|
| neither | the default chain's default vault |
| chain only | that chain's default vault |
| vault only | that vault, on whatever chain it is on |
| both | that vault, which must be on that chain; a disagreement is refused, never resolved by picking one |

An empty string counts as omitted, because some hosts send `""` for every optional argument.
`resolveAnyVault` adds Solana: `chain: "solana"`, or a ticker found in `solanaVaults`, returns
`{ family: "solana", vault }`; everything else is `{ family: "evm", vault }`. Every caller branches on
`family` before using the row.

**Defaults have two sources on purpose.** `EARN.defaultChain` and `EARN.defaultVaultByChain` in
`src/config/earn.ts` are the toggle; the registry's `isDefault` is the measurement. `defaultVault`
throws when they disagree ("change both or neither"). `defaultVaultByChain` is typed
`Record<ChainKey, …>`, so a chain added to `CHAIN_INFO` without a default does not compile.

Other selectors in `src/registry.ts`: `offeredChains()` (supported chains that have a vault, default
first), `offeredChainKeys()` (the list a refusal names, with Solana), and `depositableVaults()` /
`depositableSolanaVaults()`, which are a rule (buildable chassis and measured open), not a list.

## Adding a chain

The compiler holds most of it together: a chain id in `chains` (`src/client.ts`) without a
`CHAIN_INFO` row, a schema literal without an `EXPLORER` entry (`src/links.ts`), or a chain key without
a default in `src/config/earn.ts` fails to build. The rest (RPC variables in the boundary test's
allowlist and in [`../../configuration.md`](../../configuration.md), pinned chain lists in
`tests/registry.test.ts` and `tests/client.unit.test.ts`, the prose that names chains) is the checklist
in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## Reconciling against the chain

`npm run registry:check` runs `scripts/registry-check.ts`. Each row is checked on its own chain,
through that chain's endpoint, against what the contract says about itself (`symbol()`, `name()`,
`decimals()`, `asset()`, and code at the address; Solana rows through `scripts/solana-row.ts`). There
are three outcomes per row, not two: agrees, disagrees, or **not checked** because the endpoint
failed or served another chain. A transport failure is never reported as a wrong row.

`tests/registry-check.chain.test.ts` runs the script against a local mock RPC and asserts that it
calls only chain methods on one host, exits 0 when the chain agrees, and names the row when one byte
of one symbol disagrees. The chain is the only source the script consults.

## What the tests pin

`tests/registry.test.ts` keeps two questions apart: what the shipped file contains (a product
decision, restated deliberately when it changes) and what the schema refuses (exercised on synthetic
rows, so a rule about a chassis stays tested after the last vault of that chassis retires).
