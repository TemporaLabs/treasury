# Install

Treasury is a command-line program plus an agent skill: the agent runs `treasury earn <command>` (or
`treasury connect <command>`) with its shell and reads the JSON it prints. Nothing stays running between commands. Two ways to get it in
front of an agent.

## Claude Code — the plugin

```bash
claude plugin marketplace add TemporaLabs/treasury@v0.1.2
claude plugin install treasury@treasury
```

`@<ref>` pins the marketplace to a tag or a branch, and is recorded with the marketplace entry, so
`claude plugin marketplace update` refreshes *that* ref rather than moving the install onto another
branch; `#<ref>` is equivalent. Prefer a tag — it is immutable. Before a release is tagged, pin its
release branch instead (`TemporaLabs/treasury@release/v0.1.2`); dropping the suffix entirely tracks
this repository's default branch.

The plugin is the [`plugin/`](../plugin/) folder of this repository: its manifests, the `earn` skill,
and a copy of this repository's own `dist/treasury.mjs`, `dist/connect-page.js` (the page
`treasury connect` serves) and `registry/vaults.json`, made by
`npm run build` in the same commit. The plugin gives Claude Code the `earn` skill, which runs its copy
of the bundled CLI with a bare `node` — `node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" earn …` (or `connect …`) — once
per command. `plugin/` carries a version-only `package.json` and no lockfile, so a marketplace install
copies files and runs no dependency install. **Node 22 or later is required and must be on `PATH`** —
without it every command fails with the shell's own `node: command not found`.

**Codex is not supported as a plugin host in this release.** The skill names the CLI through
`${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes and Codex did not (measured on Codex 0.155.1, for
the launch path of the earlier server). With Codex, install the package as in
[the section below](#any-agent-runtime-with-a-shell--the-cli) and give the agent the skill with the
command replaced by `npx --no-install treasury` (`--no-install` so `npx` never fetches an
unrelated package of that name).

### Upgrading an earlier install

An install made before v0.1.1 used a marketplace with the same name, `treasury`, from a different
source. Claude Code refuses to add the new one while the old one is configured, and removing the old
marketplace also uninstalls the plugin, so upgrade in three steps:

```bash
claude plugin marketplace remove treasury
claude plugin marketplace add TemporaLabs/treasury@v0.1.2
claude plugin install treasury@treasury
```

**Run `/reload-plugins` (or start a new Claude Code session) after installing**, or after changing
the marketplace ref, so the `earn` skill is loaded.

Set an RPC before you rely on it:

```bash
export TREASURY_RPC_BASE=https://...          # a keyed Base RPC (Alchemy, Infura, QuickNode, your own node)
export TREASURY_LOGS_RPC_BASE=https://...     # optional: a wide-window provider for earn_balance's event scans
export TREASURY_RPC_ARBITRUM=https://...      # a keyed Arbitrum One RPC, if you will use a vault on Arbitrum
export TREASURY_LOGS_RPC_ARBITRUM=https://... # optional, the same for Arbitrum
export TREASURY_RPC_ROBINHOOD=https://...     # a keyed Robinhood Chain RPC, if you will use a vault there
```

Each chain reads only its own variable. Unset, a chain falls back to its public RPC, which rate-limits
after a handful of calls. A `… over rate limit` error from any command means "set a keyed RPC for that
chain", not "the vault is down". The CLI reads the shell's environment, so export these before you
start Claude Code. See [`configuration.md`](configuration.md).

The skill pre-approves its own command (`node …/dist/treasury.mjs …`, for both `earn` and `connect`) for the turn it is used in.
If Claude Code still asks, allow that command for the project; it is the same program every time.

**Updating:** `claude plugin update` will not refresh a plugin whose version has not changed. To pick
up a same-version rebuild, `claude plugin uninstall treasury@treasury` then install again.

## Any agent runtime with a shell — the CLI

The same bundle is published to npm as `@temporalabs/treasury`. Install it pinned to the exact
version — a published version is immutable, and `--save-exact` keeps a later `npm install` from moving
to another one:

```bash
npm install --save-exact @temporalabs/treasury@0.1.2
npx --no-install treasury earn --help     # every command and flag, as JSON
npx --no-install treasury earn vaults     # or: node <project>/node_modules/@temporalabs/treasury/dist/treasury.mjs earn vaults
```

`dist/treasury.mjs` is byte-identical to the file committed at the matching tag and to the bundle the
Claude Code plugin carries; [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md) shows how
to check it from the tarball. A checkout of the repository at the tag, or the plugin cache after a
Claude Code install, holds the same file if you would rather not install from npm.

The CLI carries exactly the eight `earn` commands and five `connect` commands in [`tools.md`](tools.md),
each printing one JSON document; a refusal exits 1 with `{ "error": … }` on stderr. No command signs:
the `connect` commands hand calls to your own wallet for approval, and your runtime's own signer
takes the calls `earn prepare_deposit` and `earn prepare_withdraw` return. The `earn` skill ships with
the plugin, at [`plugin/skills/earn/SKILL.md`](../plugin/skills/earn/SKILL.md) in this repository. It is
plain Markdown and can be given to any agent as instructions; it tells the agent how to use these
commands and what to refuse.

Releases up to 0.1.1 shipped an MCP server (`dist/mcp-server.mjs`, the `treasury-mcp` bin) instead of
this CLI; see the [changelog](../CHANGELOG.md). A host that still runs that server must stay on
0.1.1 exactly (install the package with `--save-exact` at version `0.1.1`): a `^0.1.1` range resolves to a later
release, which has no `dist/mcp-server.mjs`. Upgrading the plugin likewise removes the eight `earn_*`
MCP tools; the `earn` skill reaches the same operations through the CLI.

## Connecting a wallet (`treasury connect`)

`treasury connect wallet` opens a one-time URL on `http://localhost:53682` in the browser on the same machine: one
Connect button, then Privy's window. Its first screen lists the browser wallets installed there
(MetaMask, Rabby, or any wallet that announces itself to the page), then email and Google, four
entries in all: with three or more wallets installed, Google moves under "More options", and with
four or more, email does too. Apple, X and Coinbase Wallet are under "More options". Signing in costs
nothing. After that, `treasury connect deposit` and `treasury connect withdraw`
open a confirm page for each transaction. See [`tools.md`](tools.md#the-connect-commands--treasury-connect-command).

- It needs a browser on the machine running the agent. Over SSH, on Linux with no display, or with
  `TREASURY_CONNECT_NO_OPEN` set, the command prints the URL instead of opening it; it prints the URL
  on stderr either way.
- Port 53682 must be free while a page is open; one sign-in or confirmation runs at a time.
- Phone wallets are not offered in this release: the page lists wallets installed in the browser, and
  an email or social login gives a wallet with no extension at all.

## As a library

`@temporalabs/treasury` — the same package, `npm install @temporalabs/treasury@0.1.2` — also exports
the builders, the pre-flight, the position scan and the registry as plain functions. ⚠️ The library returns bare `UnsignedCall[]` arrays; the
`{ requires_signature: true, status: "unsigned", calls }` envelope is a property of the command
boundary, not of the functions. If you consume the library directly, you are the boundary.

## Verifying what you installed

The committed bundle is rebuilt in CI and must match byte-for-byte, and on the public repository every
build carries a provenance attestation. [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)
shows how to check the bundle in your plugin cache against the commit it claims.
