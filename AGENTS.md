# AGENTS.md

Instructions for coding agents working in this repository. People should start with
[`CONTRIBUTING.md`](CONTRIBUTING.md); it is the fuller guide for people, and wins if the two ever
disagree.

Treasury is a depositor client for ERC-4626 vaults on Base and Arbitrum One: a vault registry, pre-flight checks, and
builders for **unsigned** deposit and withdraw calls, served as a library and as a command-line program
(`treasury earn <command>`, one JSON document per run).

## Two rules that decide every review

1. **Nothing holds, reads, derives or is handed a private key. Nothing signs. A call reaches the
   chain only from the operator's own wallet, after the operator approves it there.** The earn
   commands prepare unsigned calls and never send. The wallet connection (`treasury connect`,
   `src/connect/`) may hand a call to the operator's connected wallet — a browser wallet, or a
   Privy embedded wallet with its own confirmation — which shows it and asks for approval every
   time. That relay builds calls only through `src/build.ts`, and its gate (`src/connect/gate.ts`)
   refuses any call whose destination is not a vault in `registry/vaults.json` or that vault's asset
   (the approval to it, for exactly the deposit's amount), and any receiver or owner other than the
   connected account. Do not add a private-key variable, a local signer, a tool that signs, or a
   relay that accepts an arbitrary destination: that is a design change, not a pull request. CI runs
   the bundled CLI and fails if `earn --help` or `connect --help` lists any command beyond its pinned set.
2. **The client knows only the chain.** It has a vault address and an RPC endpoint, nothing else.
   `tests/boundary.unit.test.ts` parses every audited file and fails on any import, `require`, child
   process or path that reaches outside this repository's allowlist. Do not weaken that test to make
   a change pass.

## Commands

Node.js 22 or later. The fork tier also needs [Foundry](https://getfoundry.sh) for `anvil`.

```bash
npm ci                     # never `npm install` — CI fails on a stale lockfile
npm run build              # tsc, the dist/treasury.mjs bundle, THIRD_PARTY_NOTICES.md, and the plugin/ copies
npm run typecheck
npm test                   # unit tier; live and fork tiers skip themselves without an RPC
TREASURY_RPC_BASE=https://... npm test           # adds live read-only checks against Base
TREASURY_RPC_BASE=https://... npm run test:fork  # anvil fork round trips, impersonated accounts
npm run registry:check     # reconcile registry/vaults.json against the chain
```

Each chain's live and fork tiers run when that chain's RPC variable is set: add
`TREASURY_RPC_ARBITRUM=https://...` to the same commands for Arbitrum One. `registry:check` reads
each row on its own chain and reports a chain it could not reach as not checked.

## Things that fail CI if forgotten

- **`dist/treasury.mjs` and the `plugin/` copies are committed.** After any change under `src/`, or
  to `registry/vaults.json`, `LICENSE` or `NOTICE`, run `npm run build` and commit the result; CI
  rebuilds and fails on a difference.
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

## The Claude Code plugin (`plugin/`)

- **Never edit the copies in `plugin/` by hand.** `plugin/dist/treasury.mjs`,
  `plugin/registry/vaults.json`, `plugin/LICENSE`, `plugin/NOTICE`, `plugin/THIRD_PARTY_NOTICES.md` and
  `plugin/package.json` are written by `npm run build`; `npm run plugin:check` fails on a stale one.
- **`plugin/` must never hold a lockfile.** A plugin install runs a dependency install when it finds
  one beside `package.json`.
- **A change to the skill's `description:` is a behavioural change**: it decides whether the skill is
  reached at all. Measure it by running the plugin (`claude -p --plugin-dir <absolute path to this
  repository>/plugin`, from a working directory that is not this repository and with no `treasury`
  plugin installed) and checking whether the run invoked the `treasury:earn` skill and ran its CLI.
- `npm run lint:skill` validates the skill against the official skill spec.

## Pull requests

- Target the current `release/vX.Y.Z` branch, not `main`.
- One change per pull request; a documentation fix found along the way gets its own.
- Say which test tier ran: unit, live read-only, or fork.
- Adding, removing or renaming a command needs the matching change to
  [`plugin/skills/earn/SKILL.md`](plugin/skills/earn/SKILL.md) in the same pull request; CI checks the
  skill's command table against the CLI's real `earn --help`.
- Security issues go through private vulnerability reporting ([`SECURITY.md`](SECURITY.md)), never a
  public issue.
