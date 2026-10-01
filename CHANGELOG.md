# Changelog

All notable changes to Agent Treasury are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
Pre-1.0, minor versions may change tool names, schemas and behaviour.

## [v0.1.2] - Unreleased

### Added
- **The `connect` plugin and MCP server.** `treasury-connect` has five tools (`connect_status`,
  `connect_wallet`, `disconnect_wallet`, `switch_wallet`, `connect_send_transaction`). It connects an
  existing wallet over WalletConnect and relays one already-built call to it for a signature. Email
  and Google login are not supported. The server builds to `dist/connect-server.mjs`, with its bundled
  dependencies listed in `CONNECT_THIRD_PARTY_NOTICES.md`. The plugin ships from
  [`connect-plugin/`](connect-plugin/), beside `plugin/`, and installs as `connect@treasury`.

## [v0.1.1] - 2026-09-29

### Added
- **The Claude Code plugin and the `earn` skill now ship from this repository**, in
  [`plugin/`](plugin/) (#53). Up to v0.1.0 they shipped from a separate plugin repository, which
  carried byte copies of this repository's bundle, refreshed by hand. The copies in `plugin/` are now
  written by `npm run build` in the same commit and checked by CI, so a tool change and its skill text
  land in one pull request. The install id is unchanged (`treasury@treasury`); the marketplace source
  is now `TemporaLabs/treasury`. The move does not change the npm package's contents: `plugin/` is
  outside its `files` list.
- `AGENTS.md`, instructions for coding agents working in this repository (#49).

### Fixed
- The package's `treasury-mcp` command now starts the server: the entry check compares the file's
  identity, not the name it was invoked by (#27, fixes #22). A script that imports or preloads the
  bundle no longer starts it, whatever that script is named.
- The MCP server reads its own `package.json` and vault registry when run through a symlink with
  `--preserve-symlinks-main`; it failed at startup before (#57).
- `earn_quote` and `earn_balance` name `instantLiquidity` in their descriptions, and the prepare-tool
  population is derived rather than listed (#29, fixes #17).

### Changed
- The project is named Open Agent Treasury (OAT), the treasury management system for AI agents, with
  a mascot and a simpler README (#33, #37, #39, #41, #43).
- The install docs cover the published npm package, use an absolute MCP path, and compare a published
  bundle to its tag (#23, #24).

### CI
- The documentation version pins must agree, and on `main` equal `package.json`'s version; a release
  moves them in its own pull request (#30, #55).
- The publish workflow checks the plugin's copies, every version declaration and the install pins at
  the tag, and polls the registry for up to ten minutes, warning rather than failing on a timeout
  (#28, #55, #57).
- `prepack` also refuses rebuilt third-party notices that differ from the committed file (#57).
- Dependabot no longer proposes TypeScript or `@types/node` majors (#25); GitHub Actions and
  development dependencies bumped (#20, #55).

### Not supported in this release
- **Codex.** `plugin/` carries Codex manifests and Codex installs the plugin (#55 corrected a policy
  value Codex refused), but the server does not start there: measured on Codex 0.155.1, Codex does
  not expand `${CLAUDE_PLUGIN_ROOT}` in the launch path. With Codex, register the npm package's
  bundle by its absolute path with `codex mcp add`
  ([docs/install.md](docs/install.md#claude-code--the-plugin)).

### Upgrading an earlier Claude Code install
Remove the old marketplace first — adding the new one while it is still configured is refused,
because both are named `treasury` — then add the new one and reinstall. Removing the marketplace also
uninstalls the plugin, so the last step is needed:

```bash
claude plugin marketplace remove treasury
claude plugin marketplace add TemporaLabs/treasury@v0.1.1
claude plugin install treasury@treasury
```

Then restart your Claude Code session so the tools connect.

## [v0.1.0] - 2026-09-18

The first public release. Everything below is what ships in it.

### Added
- **The `treasury` MCP server** — eight `earn_*` tools that read a Tempora vault and prepare
  unsigned deposits and withdrawals for the operator's own signer. No `sign`, no `send`; the tool
  list is asserted in CI.
- **The `earn` skill**, which tells an agent how to drive those tools and what to refuse. It ships
  from [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin) together with
  the bundled server, not from this repository: the plugin reads this package, never the reverse.
- **Simulation-based pre-flight.** `earn_status` and `earn_quote` simulate the real `deposit()`
  from the account's address and report `OPEN_READY`, `NEEDS_APPROVAL`, `WHITELIST_GATED`,
  `REVERTED_OTHER`, `REFUSED_BY_CLIENT` or `UNRESOLVED` — never trusting `maxDeposit()`.
- **Exit measured by simulation.** `earn_balance` reports `exit.exitableNow`, what a withdrawal of the
  whole position would actually return at this block, next to `usdcValue`, what it is worth.
- **The transactions behind the scan.** `earn_balance` reports `scan.depositTxs` and
  `scan.withdrawTxs` — `{ txHash, blockNumber, amountUsdc }`, oldest first — projected from the
  logs the basis scan already fetched, so an explorer link needs no second query. Each list holds
  at most the 100 most recent; the counts remain the totals.
- **Whole-history basis.** Entry basis and accrued yield come from the vault's own events, from its
  deployment block; they read `unknown` unless the scan covered the whole history.
- **The unsigned envelope.** Every prepared call returns inside
  `{ requires_signature: true, status: "unsigned", calls }`.
- **Prepared calls carry their own decoding.** Alongside the raw `data`, every call reports
  `function` (e.g. `approve(address spender, uint256 value)`) and `args` by name, so an operator
  signing through a block explorer's Write Contract form does not hand-decode calldata. Both are
  produced at the same call site as `data`, from the same arguments, so they cannot drift from it.
- **The hand-off to the signer, in the skill.** Before any prepared call reaches a signer the agent quotes
  every destination back to the operator with the message it came from and waits for the paste-back;
  "go" approves the plan, never the address; a config file, an environment variable or an earlier
  session is never a source. The default signing path is the operator's own terminal, sending the
  envelope's `to`/`data` raw.
- **Endpoint redaction.** A keyed RPC URL never appears in tool output, on any failure path.
- **A signed, reproducible bundle.** `dist/mcp-server.mjs` is committed, rebuilt in CI byte-for-byte,
  and carries a provenance attestation on the public repository.
- **Licence: Apache License 2.0** from launch, with `NOTICE`.
- **A Developer Certificate of Origin** (`DCO.md`, the standard text from developercertificate.org),
  certified per commit by a `Signed-off-by` trailer and checked by a GitHub check that reads every
  commit on a pull request.
- **Two vaults offered.** The default is Tempora Labs Cash Plus USDC (Test 2) on Base, a Morpho Vault
  V2 open to any account. Cash Plus USDC (Test 2A), an IPOR Fusion vault, stays listed with
  whitelist-gated deposits; for an account it has not admitted the skill tells an
  agent to stop rather than substitute.
- **No depositor address is configured anywhere.** For the gated vault, the fork tier discovers a
  whitelist member from its own AccessManager, events then `hasRole`, and never writes one down.
- **Pre-deposit disclosures** are plain-language terms this repository owns, including that the default
  is a Tempora-curated destination on which Tempora can set fees.
- **The default's fee and position notes say what the chain says.** Its fee timelocks are 0, so a fee
  can be introduced without notice; and one of its positions lends against a stablecoin priced at
  par by a fixed oracle, which the fund's loss model does not price.
