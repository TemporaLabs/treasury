# Changelog

All notable changes to the Agent Treasury plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
The product's own changes are in the repository's [`CHANGELOG.md`](../CHANGELOG.md).

## [v0.1.1] - 2026-09-29

Carries `@temporalabs/treasury` v0.1.1.

### Changed
- **The plugin now ships from `TemporaLabs/treasury`, in its `plugin/` folder.** The manifests moved
  here unchanged apart from their repository URL and the marketplace entries' source path
  (`./plugin`), and the `earn` skill and its trigger cases moved unchanged. The server bundle, vault registry and licence files in this folder are copies of the
  repository's own files, written by `npm run build` in the same commit and checked byte for byte by
  CI; nothing is copied from another repository. The install id is unchanged (`treasury@treasury`);
  only the marketplace source moves to `TemporaLabs/treasury`.
- **The plugin keeps running its own copy of the bundle.** The `npx` pin announced in v0.1.0's note
  below is withdrawn: resolving `@temporalabs/treasury` by name would install the library's runtime
  dependencies, which the self-contained bundle does not need.

### Not supported
- **Codex.** The Codex marketplace entry now declares a policy value Codex accepts (`ON_USE`; the
  earlier `NONE` was refused at install, #55), so Codex installs the plugin, but the server does not
  start there: Codex does not expand `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json`'s launch path. This was
  equally true of v0.1.0.

History up to and including v0.1.0 below is from the plugin's earlier repository,
[TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin), where it was released.

## [v0.1.0] - 2026-09-18

Carries `@temporalabs/treasury` v0.1.0.

### Added
- Plugin manifests for Claude Code, Codex and the `.agents` marketplace format.
- The `earn` skill (`skills/earn/SKILL.md`).
- The committed MCP server bundle (`dist/mcp-server.mjs`) and the vault registry it reads
  (`registry/vaults.json`), matching `@temporalabs/treasury` v0.1.0 byte for byte.
- The server contacts the RPC you configure and nothing else: no analytics, no yield API, no vendor.
  It quotes no rate, and a position's accrued yield is read from the vault's own on-chain events.

### Changed
- Refreshed the bundle and registry to the state merged by `TemporaLabs/treasury#8`,
  its vault-identity rework (with `TemporaLabs/treasury#7`): a vault is now named by its own on-chain
  ERC-20 `symbol` rather than an internal registry `slug`, `earn_vaults` reports `name` in place of
  `displayName`, and every response that commits money (`earn_prepare_deposit`, `earn_status`'s
  pre-flight, `earn_quote`'s deposit branch) now carries the vault's `warning` disclosure — not only
  the discovery call. This landed before this repository's own first release to `main`, so the
  plugin's initial public artifact carries the fixed shape rather than the internal-slug/no-warning
  shape it would otherwise have shipped with.
- Refreshed the bundle again to the state merged by `TemporaLabs/treasury#15`,
  picking up `TemporaLabs/treasury#14` with it: `earn_balance` now returns `scan.depositTxs` /
  `scan.withdrawTxs` (the transactions behind the basis scan, so an operator gets an explorer link
  without anyone rebuilding the log query), and every `earn_prepare_*` call carries `function` and
  `args` — the decoded signature and named arguments a block explorer's Write Contract form asks
  for. `skills/earn/SKILL.md` is updated to match: the signer hand-off no longer teaches
  hand-decoding calldata, because the tool now supplies the decoded form directly.

  Both entries above name a PULL REQUEST deliberately, and they have named two other things first.
  A branch was the original choice, and `release/v0.1.0` moves: the first entry had already become
  unverifiable by the time the second was written. A commit hash replaced it and is the better
  instinct, but it is stable only for as long as the history containing it is, which is a weaker
  guarantee than it looks. A merged pull request number is fixed for the life of the repository —
  it outlives any rewriting or re-tagging of history, and the commit it merged can always be read
  back from the pull request itself. It is not indestructible: a repository rename moves it, and
  deleting the repository takes it with everything else. But against the thing that actually breaks
  provenance in practice — the history underneath a claim changing after the claim is written — the
  pull request number is the part of this sentence that holds still.

### Note

`@temporalabs/treasury` is not yet published to npm. `.mcp.json` runs the bundle committed in this
repository directly (`node ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs`) rather than resolving the
package by name. Once the package is published, this arrangement is replaced by an `npx` pin to
the exact published version — that is the ordering the plugin/product split was designed around,
not a change of plan.
