# AGENTS.md

Instructions for coding agents working in this repository. People should start with
[`CONTRIBUTING.md`](CONTRIBUTING.md); it is the full version of everything below, and wins if the two
ever disagree.

Treasury is a depositor client for ERC-4626 vaults on Base: a vault registry, pre-flight checks, and
builders for **unsigned** deposit and withdraw calls, served as a library and as an MCP server.

## Two rules that decide every review

1. **Nothing holds, reads, derives or is handed a private key. Nothing signs. Nothing sends.**
   Treasury prepares unsigned calls; the operator supplies the signer. Do not add a `sign`, `send` or
   `transfer` tool, a wallet client, or a private-key variable — that is a design change, not a pull
   request. CI starts the bundled server and fails if `tools/list` offers any such tool.
2. **The client knows only the chain.** It has a vault address and an RPC endpoint, nothing else.
   `tests/boundary.unit.test.ts` parses every audited file and fails on any import, `require`, child
   process or path that reaches outside this repository's allowlist. Do not weaken that test to make
   a change pass.

## Commands

Node.js 22 or later. The fork tier also needs [Foundry](https://getfoundry.sh) for `anvil`.

```bash
npm ci                     # never `npm install` — CI fails on a stale lockfile
npm run build              # tsc, the dist/mcp-server.mjs bundle, and THIRD_PARTY_NOTICES.md
npm run typecheck
npm test                   # unit tier; live and fork tiers skip themselves without an RPC
TREASURY_RPC_BASE=https://... npm test           # adds live read-only checks against Base
TREASURY_RPC_BASE=https://... npm run test:fork  # anvil fork round trips, impersonated accounts
npm run registry:check     # reconcile registry/vaults.json against the chain
```

## Things that fail CI if forgotten

- **`dist/mcp-server.mjs` is committed.** After any change under `src/`, run `npm run build` and commit
  the result; CI rebuilds and fails on a difference.
- **Every commit carries a `Signed-off-by` trailer** matching its author (`git commit -s`). See
  [`DCO.md`](DCO.md).
- **Every relative link in `docs/` must resolve.**
- **Do not bump versions.** The declared version follows the release branch, and maintainers cut
  releases ([`docs/release-process.md`](docs/release-process.md)).

## Conventions

- **Tests never need a real key.** Anything that moves funds runs on a fork and impersonates the
  account.
- **Show that a new test can fail**: break the behaviour it guards, see it go red, restore it.
- **Measured, not assumed.** A registry row, decimal count, revert selector or RPC window carries the
  block or date it was measured at. `registry/vaults.json` is a set of measurements, and a row is a
  product decision — see CONTRIBUTING's section on vaults.
- **Amounts are strings in the asset's own decimals.** Never a float; never round a share balance.
- **Errors say what to do next**, and a failure never renders as an empty result.
- **Tests that pin a product decision** (the default vault, the listed set) are restated when that
  decision changes, never loosened to survive it.

## Pull requests

- Target the current `release/vX.Y.Z` branch, not `main`.
- One change per pull request; a documentation fix found along the way gets its own.
- Say which test tier ran: unit, live read-only, or fork.
- Adding, removing or renaming a tool needs the matching change to `SKILL.md` in
  [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin).
- Security issues go through private vulnerability reporting ([`SECURITY.md`](SECURITY.md)), never a
  public issue.
