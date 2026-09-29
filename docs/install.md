# Install

Treasury is an MCP server plus an agent skill. Two ways to get it in front of an agent.

## Claude Code — the plugin

```bash
claude plugin marketplace add TemporaLabs/treasury@v0.1.1
claude plugin install treasury@treasury
```

`@<ref>` pins the marketplace to a tag or a branch, and is recorded with the marketplace entry, so
`claude plugin marketplace update` refreshes *that* ref rather than moving the install onto another
branch; `#<ref>` is equivalent. Prefer a tag — it is immutable. Before a release is tagged, pin its
release branch instead (`TemporaLabs/treasury@release/v0.1.1`); dropping the suffix entirely tracks
this repository's default branch.

The plugin is the [`plugin/`](../plugin/) folder of this repository: its manifests, the `earn` skill,
and a copy of this repository's own `dist/mcp-server.mjs` and `registry/vaults.json`, made by
`npm run build` in the same commit. The plugin gives Claude Code the `earn` skill and the eight `earn_*` tools, and starts its copy of the bundled
server with a bare `node`. `plugin/` carries a version-only `package.json` and no lockfile, so a
marketplace install copies files and runs no dependency install. **Node 22 or later is required
and must be on `PATH`** — without it the server process fails to spawn, and Claude Code reports that
as a bare `CONNECTION_CLOSED` on any `earn_*` call, with no mention of Node.

**Codex is not supported as a plugin host in this release.** Codex installs the plugin from this
marketplace, but the server does not start: measured on Codex 0.155.1, Codex does not expand
`${CLAUDE_PLUGIN_ROOT}` in the launch path. With Codex, install the package as in
[the stdio section below](#any-agent-runtime--the-mcp-server-over-stdio) and register the bundle by
its absolute path:

```bash
codex mcp add treasury -- node <project>/node_modules/@temporalabs/treasury/dist/mcp-server.mjs
```

### Upgrading an earlier install

An install made before v0.1.1 used a marketplace with the same name, `treasury`, from a different
source. Claude Code refuses to add the new one while the old one is configured, and removing the old
marketplace also uninstalls the plugin, so upgrade in three steps:

```bash
claude plugin marketplace remove treasury
claude plugin marketplace add TemporaLabs/treasury@v0.1.1
claude plugin install treasury@treasury
```

**Restart your Claude Code session once after installing** (or after changing the marketplace ref).
MCP servers connect only at session start — `/reload-plugins` explicitly excludes them — so the
`earn_*` tools stay absent until the next session, which otherwise looks identical to an install
failure.

Set an RPC before you rely on it:

```bash
export TREASURY_RPC_BASE=https://...          # a keyed Base RPC (Alchemy, Infura, QuickNode, your own node)
export TREASURY_LOGS_RPC_BASE=https://...     # optional: a wide-window provider for earn_balance's event scans
```

Unset, the server falls back to Base's public RPC, which rate-limits after a handful of calls. A
`… over rate limit` error from any tool means "set a keyed RPC", not "the vault is down". The plugin
is expected to pass only these two variables through to the server. See [`configuration.md`](configuration.md).

Claude Code asks once whether the plugin may start a Node process for the MCP server. Allow it for
the project; it is the same command every time (`node …/dist/mcp-server.mjs`).

**Updating:** `claude plugin update` will not refresh a plugin whose version has not changed. To pick
up a same-version rebuild, `claude plugin uninstall treasury@treasury` then install again.

## Claude Code — the connect plugin (WalletConnect)

`earn` prepares unsigned calls; the **connect** plugin connects your existing wallet over
WalletConnect and asks it to sign them. It ships from the same marketplace as `treasury`, in this
repository's [`connect-plugin/`](../connect-plugin/) folder, so it installs from the marketplace you
already added. It is available from v0.1.2; until that is tagged, add the marketplace from the
`release/v0.1.2` branch instead of a tag.

```bash
claude plugin install connect@treasury

# Restart Claude Code so the connect MCP server starts, then:
# 1. Ask the agent to "connect my wallet" — it shows a WalletConnect link and QR code
# 2. Open the link in MetaMask, Rabby, OKX Wallet or any WalletConnect wallet and approve on Base
```

`WALLETCONNECT_PROJECT_ID` is optional: the plugin ships with a default project id (it identifies the
app to the relay, it is not a secret). Set your own from [cloud.reown.com](https://cloud.reown.com) to
override it. Connecting only reveals an address; every transaction still needs your wallet's own
approval, requested fresh each time. Only WalletConnect wallets are supported — there is no email or
Google login and no new-wallet creation. The `connect` server exposes five tools: `connect_status`,
`connect_wallet`, `disconnect_wallet`, `switch_wallet` and `connect_send_transaction`.

## Any agent runtime — the MCP server over stdio

The same bundle is published to npm as `@temporalabs/treasury`. Install it, pinned to the exact
version — a published version is immutable, so the install cannot drift — and point your runtime's
MCP configuration at the bundle inside the package:

```bash
npm install @temporalabs/treasury@0.1.1
```

```json
{
  "mcpServers": {
    "treasury": {
      "command": "node",
      "args": ["<project>/node_modules/@temporalabs/treasury/dist/mcp-server.mjs"],
      "env": { "TREASURY_RPC_BASE": "https://..." }
    }
  }
}
```

Give the absolute path: a relative one resolves against the host's working directory, which is
rarely the project. That file is byte-identical to the `dist/mcp-server.mjs` committed at the matching tag and to the
bundle the Claude Code plugin carries; [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)
shows how to check it from the tarball. A checkout of the repository at the tag, or the plugin cache
after a Claude Code install, holds the same file if you would rather not install from npm.

From 0.1.1 the package's `treasury-mcp` bin starts the server too. In 0.1.0 it exits without
starting it ([#22](https://github.com/TemporaLabs/treasury/issues/22)), so run the bundle by path, as
above, if you are pinned to that version.

The server speaks MCP over stdio and exposes exactly the eight tools in [`tools.md`](tools.md). No
tool signs or sends: your runtime's own signer takes the calls the `earn_prepare_*` tools return.
The `earn` skill ships with the plugin, at
[`plugin/skills/earn/SKILL.md`](../plugin/skills/earn/SKILL.md) in this repository. It is plain Markdown and can be given to any agent as instructions; it tells the agent how to use
these tools and what to refuse.

## As a library

`@temporalabs/treasury` — the same package, `npm install @temporalabs/treasury@0.1.1` — also exports
the builders, the pre-flight, the position scan and the registry as plain functions. ⚠️ The library returns bare `UnsignedCall[]` arrays; the
`{ requires_signature: true, status: "unsigned", calls }` envelope is a property of the MCP boundary,
not of the functions. If you consume the library directly, you are the boundary.

## Verifying what you installed

The committed bundle is rebuilt in CI and must match byte-for-byte, and on the public repository every
build carries a provenance attestation. [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)
shows how to check the bundle in your plugin cache against the commit it claims.
