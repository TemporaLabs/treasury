# Install

Treasury is an MCP server plus an agent skill. Two ways to get it in front of an agent.

## Claude Code — the plugin

```bash
claude plugin marketplace add TemporaLabs/treasury-plugin
claude plugin install treasury@treasury
```

The plugin is packaged in [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin)
from this repository's releases. It gives Claude Code the `earn` skill and the eight `earn_*` tools. The plugin starts the
bundled server (`dist/mcp-server.mjs`) with a bare `node` — the bundle is committed, so a marketplace
install, which copies files and runs no `npm install`, works as-is. Node 22 or later.

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

## Any agent runtime — the MCP server over stdio

The same bundle runs under any MCP host. There is no npm package yet (publishing is a later step, see
[`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)); take `dist/mcp-server.mjs`
from a checkout of the repository, or from the plugin cache after a Claude Code install, and point your
runtime's MCP configuration at it:

```json
{
  "mcpServers": {
    "treasury": {
      "command": "node",
      "args": ["<path-to-checkout>/dist/mcp-server.mjs"],
      "env": { "TREASURY_RPC_BASE": "https://..." }
    }
  }
}
```

The server speaks MCP over stdio and exposes exactly the eight tools in [`tools.md`](tools.md). No
tool signs or sends: your runtime's own signer takes the calls the `earn_prepare_*` tools return.
The `earn` skill ships with the plugin, at
[`skills/earn/SKILL.md`](https://github.com/TemporaLabs/treasury-plugin/blob/v0.1.0/skills/earn/SKILL.md).
It is plain Markdown and can be given to any agent as instructions; it tells the agent how to use
these tools and what to refuse.

## As a library

`@temporalabs/treasury` also exports the builders, the pre-flight, the position scan and the registry
as plain functions. ⚠️ The library returns bare `UnsignedCall[]` arrays; the
`{ requires_signature: true, status: "unsigned", calls }` envelope is a property of the MCP boundary,
not of the functions. If you consume the library directly, you are the boundary.

## Verifying what you installed

The committed bundle is rebuilt in CI and must match byte-for-byte, and on the public repository every
build carries a provenance attestation. [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)
shows how to check the bundle in your plugin cache against the commit it claims.
