# Agent Treasury — Connect

**Wallet connect plugin for AI agents.** By Tempora Labs.

The Claude Code / Codex plugin that connects a wallet for
[Agent Treasury](https://github.com/TemporaLabs/treasury) skills — starting with
[`earn`](https://github.com/TemporaLabs/treasury-plugin) — and carries each prepared call through a
confirmation page before it is signed. It never carries a key.

Connecting produces an address. It also carries one already-built call to that wallet for a
signature, when Earn hands it one — but it never decides what that call is: Earn builds every
transaction; Connect shows the operator exactly what Earn built and signs only after they click
Confirm, fresh, every time.

## How it works

`connect_wallet` opens one browser page with a single **Connect** button. It opens one Privy modal
with email, Google and the browser wallets Privy detects (no WalletConnect, no QR):

- **Google or email** — [Privy](https://privy.io) signs you in and opens (or creates)
  an *embedded* wallet. After a one-time delegation, a separately hosted signing service can sign
  deposits and withdrawals for it within a fixed policy.
- **A browser wallet** — MetaMask, Rabby, Coinbase Wallet or any detected extension. Privy only shows
  the picker: you sign a free sign-in message, which the plugin checks locally. A stored Privy session
  is cleared on load and never resumed.

Then, for every deposit or withdrawal, whichever wallet is connected, a **confirmation page** opens
showing the decoded call: action, amount, vault, receiver and chain, with warnings if the receiver or
owner is not your account, if an approval is unlimited, or if the call is not one Earn would build.
Nothing is signed until you click **Confirm** there. A directly connected wallet then shows its own
prompt; an embedded wallet is signed by the signing service.

WalletConnect is not supported and is never offered.

## Layout

- `src/` — the server source. `src/connect-server.ts` is the MCP entry (five tools:
  `connect_status`, `connect_wallet`, `disconnect_wallet`, `switch_wallet`,
  `connect_send_transaction`); `src/flows.ts` the connect and confirm flows; `src/http.ts` the
  one-shot loopback server; `src/pages.ts` the connect and confirmation pages; `src/decode.ts` the
  call decoder; `src/privy-page/main.tsx` the sign-in page.
- `dist/connect-server.mjs`, `dist/privy-page.js` — the two built files the plugin runs and serves.
  Rebuild with `npm run build`; never edit by hand.
- `test/` — `npm test` (decoder, confirmation and connect flows). `npm run typecheck` for types.
- `skills/connect/SKILL.md` — the skill an agent reads.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `.mcp.json` — plugin manifests and launch config.

## What it never contains

- No key belonging to the operator. A directly connected wallet signs on its own side; a Privy
  embedded wallet is signed inside Privy.
- No Privy app secret and no Privy authorization key. A delegated embedded wallet is signed by a
  separately hosted signing service that holds those; this plugin carries only an opaque, revocable
  session token (in a `0600` file, never printed) and public identifiers.
- No say over what gets sent. `connect_send_transaction` relays a call it did not build and cannot
  alter — deciding an amount, a vault, or a destination is Earn's job entirely.
- No persistent server and no dashboard. Each sign-in and each confirmation opens one page on a
  loopback address, answers only requests carrying its random secret and its own origin, then closes.

## Install the connect plugin

1. Add the marketplace and install the plugin:

   ```sh
   claude plugin marketplace add TemporaLabs/treasury-connect-plugin
   claude plugin install connect@connect
   ```

2. Restart Claude Code (or reload plugins) so the `connect` MCP server starts. Claude Code asks once
   whether the plugin may start a Node process for it; it is always `node …/dist/connect-server.mjs`.
3. Ask the agent to **connect my wallet**. A browser tab opens with the Connect button.
4. The agent reports your address. When it later needs a signature, a confirmation tab opens for
   that one call.

Needs a browser on the same machine as the agent (not SSH), and `node` 20 or later.

### Setting up Google / email

A directly connected wallet needs no setup. Google or email needs, once:

1. **A Privy app.** In the Privy dashboard, enable embedded wallets on Base and email/Google login,
   and add `http://localhost:53682` as an allowed origin. Privy only accepts listed origins, so the
   page uses a fixed port; change it with `TREASURY_CONNECT_PORT` and list that origin instead.
   `PRIVY_APP_ID` defaults to Tempora's app; set it to use your own.
2. **The signing service** running somewhere (`signer-service/` in
   [TemporaLabs/treasury](https://github.com/TemporaLabs/treasury)), a Privy authorization key (key
   quorum) registered as a signer, and these exported before starting Claude Code:
   `TREASURY_SIGNER_URL` (the service) and `PRIVY_SIGNER_ID` (the key-quorum id).

If the service is not running, a Google/email sign-in stops with "the signing service could not be
reached"; connect a wallet directly instead.

The service signs only USDC `approve` to a registry vault, vault `deposit` to you, and vault
`withdraw`/`redeem` to you, under per-transaction and daily caps. Disconnecting revokes the service's
session token; it does not remove the signer from the wallet inside Privy.

### Developing

```sh
npm ci
npm run typecheck && npm test
npm run build        # rewrites dist/connect-server.mjs and dist/privy-page.js
```

To pick up a same-version rebuild in Claude Code, `claude plugin uninstall connect@connect` and
install again.

## Using it alongside `earn`

Install both plugins ([`treasury@treasury`](https://github.com/TemporaLabs/treasury-plugin) and
`connect@connect`). If the operator asks Earn to do something and no account is known, Earn's own
skill calls Connect first; once Earn has built a deposit or withdrawal, it hands each prepared call
to `connect_send_transaction`. This is pure skill-level composition (the agent reads both `SKILL.md`
files and calls tools on both MCP servers in sequence), not a code dependency between the two.

## Docs, security, contributing

See [`SECURITY.md`](SECURITY.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

Apache License, Version 2.0 — see [`LICENSE`](LICENSE). Third-party components in the built files are
listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The Tempora names and marks are not
licensed (section 6): a fork may say it is based on Agent Treasury; it may not present itself as the
official distribution.
