# Agent Treasury — Connect plugin

Wallet connect plugin for AI agents, by Tempora Labs. It connects an existing wallet over
WalletConnect and relays one already-built call to it for a signature. It never holds a key and never
decides what a transaction contains — [`earn`](https://github.com/TemporaLabs/treasury-plugin) builds
every call; Connect only asks the wallet to approve or reject it, fresh, every time.

## What is here

- `skills/connect/SKILL.md` — the skill an agent reads.
- `evals/trigger-eval.json` — trigger cases for the skill.
- The MCP server it starts is this repository's `dist/connect-server.mjs` (source:
  `src/mcp/connect-server.ts`, `src/wallet-session.ts`), declared in the root
  `.claude-plugin/marketplace.json`. Five tools: `connect_status`, `connect_wallet`,
  `disconnect_wallet`, `switch_wallet`, `connect_send_transaction`.

## Scope

Any WalletConnect-compatible wallet (MetaMask, Rabby, OKX Wallet, and others) on Base. Email login,
Google login and creating a new wallet are not supported.

## Install

```sh
claude plugin marketplace add TemporaLabs/treasury@release/v0.1.1   # use @v0.1.1 once tagged
claude plugin install connect@connect
```

Restart Claude Code, then ask the agent to **connect my wallet**. Open the link it shows in a
WalletConnect wallet (or scan the QR from a mobile wallet) and approve on Base. Node 22 or later; there
is nothing to build. `WALLETCONNECT_PROJECT_ID` is optional — a default is set; get your own free one at
cloud.reown.com to override it.

To test a checkout locally instead, run `claude plugin marketplace add <path-to-this-repo>`.

Use it with the `treasury` plugin (`earn`) for the full deposit flow.
