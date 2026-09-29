# Changelog

All notable changes to the Agent Treasury plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [v0.1.1] - 2026-09-25

### Added
- CI now checks that what this repository carries from the product is byte-identical to the
  product's own copies, so a stale bundle goes red instead of waiting for someone to notice (#7).
  `bundle-source.json` names the product ref the carried files came from; `validate` fetches the
  product at that ref and compares `dist/mcp-server.mjs`, `registry/vaults.json`, `NOTICE` and
  `THIRD_PARTY_NOTICES.md`. The ref must be a release tag or a full commit SHA — a branch name is
  refused, since a comparison against something that moves proves nothing the next day — and a fetch
  that fails is a failure rather than a skip, because a check that passes when it cannot read the
  other side agrees with everything. A pinned commit must additionally be **reachable** from one of
  the product's published refs: a commit orphaned by a history rewrite is still served on request,
  so it fetches and compares clean while naming something no branch or tag can reach, and retrieval
  therefore had to be checked separately from provenance. `LICENSE` is deliberately not in that
  list: it is already pinned to the canonical Apache-2.0 text, which is a stronger claim than
  agreeing with the product.

  What this establishes is that the carried files match the release they *claim*, which is not the
  same as the claim being current. When the product has tagged something newer, the run says so as a
  warning and does not fail — the product's release cadence is not this repository's, and a red
  build on every unrelated pull request the moment the product ships would only teach everyone to
  ignore the colour.

### Changed
- `@temporalabs/treasury` v0.1.0 is published to npm (2026-09-18), so the v0.1.0 note below no
  longer describes the registry. What it describes about this repository still holds, and now on
  purpose rather than as an interim: the plugin keeps carrying `dist/mcp-server.mjs` instead of
  resolving the package by name, and the `npx` pin that note announces is withdrawn. The carried
  bundle installs nothing; the package declares the library's runtime dependencies, which resolve to
  on the order of a hundred packages the MCP server never loads because they are already inlined.
  Pinning is done by the release tag, which is immutable. The invariant is byte-identity between the
  carried bundle and the product's release, and it is now enforced in CI rather than asserted (#7).
  This release carries `TemporaLabs/treasury` `v0.1.0` — its only tagged release at this time; the
  byte-identity check above is what will catch drift once a newer one exists.

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
