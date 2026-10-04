# Connect: Privy and wallet sign-in, handover

> **Update (0.8.0):** the signing service and delegation described below are gone. A Google/email
> embedded wallet now signs in the browser (free challenge at connect; Privy's modal on the confirm
> page, served from `localhost:53682`). `TREASURY_SIGNER_URL` and `PRIVY_SIGNER_ID` are no longer
> read. See `connect-plugin/CHANGELOG.md`. Sections below that mention the service are historical.

State of the wallet and Privy work as of 2026-10-03, written for whoever picks it up next. It
describes what exists, what was observed running it, and what is not done. Nothing here is a
claim that the flows are production-ready.

## What is in this change

| Path | What it is |
|---|---|
| `connect-plugin/` | The `treasury-connect` MCP server (v0.7.0, unreleased). Source in `src/`, bundle in `dist/`, built with `npm run build`. Tools: `connect_status`, `connect_wallet`, `disconnect_wallet`, `switch_wallet`, `connect_send_transaction`. |
| `connect-plugin/skills/connect/SKILL.md` | The skill that tells an agent how to use those tools. |
| `connect-plugin/src/privy-page/` | The browser page (React, bundled to `dist/privy-page.js`) that holds the single Connect button and the Privy modal. |
| `signer-page/` | A separate local page that hands prepared Earn calls to a browser wallet. Its own README explains it. The core package does not import it; `tests/no-signing.test.ts` enforces that. |

Both directories were copied from working trees that were not committed anywhere. The previous
homes were `treasury-connect-plugin` (branch `connect/browser-signin`) and
`treasury-internal/signer-page` (branch `signer/wallet-page`). The `treasury-connect-plugin` remote
`https://github.com/TemporaLabs/treasury-connect-plugin.git` returned "Repository not found" on
2026-10-03, so this change may be the only copy of that work that is pushed anywhere.

## How sign-in works

`connect_wallet` opens one local browser page (fixed port 53682, `TREASURY_CONNECT_PORT` to change)
with one **Connect** button that opens a single Privy modal (email, Google, detected browser
wallets; no WalletConnect). The operator picks in the modal. Superseded the two-button page.

### Connect a wallet (direct)

- MetaMask, Rabby, Coinbase Wallet or any browser wallet. The operator signs a free sign-in message;
  the server verifies the signature locally.
- Privy only shows the picker; the server checks the wallet's signature locally and does not trust
  Privy's login for the address. `connect_status` reports `via: "wallet"`, `walletType: "external"`.
- Needs a browser with the extension on the same machine as the agent.

### Continue with Google or email (Privy embedded wallet)

- Privy signs the operator in and opens or creates its embedded wallet on Base. After one
  delegation, a **signing service** signs calls for that wallet inside a fixed policy.
  `connect_status` reports `via: "privy"`, `walletType: "embedded"`, `delegated: true`.
- Needs a Privy app with embedded wallets on Base, email/Google login enabled, and
  `http://localhost:53682` as an allowed origin (Privy takes exact origins only).
- Needs the signing service and these variables exported before Claude Code starts:
  `TREASURY_SIGNER_URL` (the service), `PRIVY_SIGNER_ID` (the key-quorum id attached to the wallet
  as signer), optionally `PRIVY_SIGNER_POLICY_IDS` (comma separated). `PRIVY_APP_ID` defaults to
  the value in `connect-plugin/src/config.ts`; it is an app identifier, not a secret.
- Never put a Privy app secret or authorization key in this plugin or its environment. They belong
  only to the signing service.

### What is not in this repository

**The signing service is not in this change.** `connect-plugin/src/signer-client.ts` is only a
client for it. Whoever continues the Privy path needs the service's source, its deployment, and its
policy definition from wherever they live. This change does not contain them.

## Sending a call

`connect_send_transaction` takes one call (`to`, `data`, optional `value`) from an Earn envelope. It
always opens a one-shot confirmation page showing the decoded call (action, amount, vault, receiver,
chain, raw data), with warnings for a receiver or owner that is not the account, an unlimited
approve, attached ETH, a plain transfer, or an unrecognised call. Nothing is signed until the
operator clicks Confirm. A direct wallet then shows its own prompt; an embedded wallet is signed by
the signing service.

The result carries `verified`:

- `matched`: the transaction on chain is exactly the call that was requested.
- `unverified`: the lookup did not answer in time.
- `mismatch`: stop. What landed is not what was asked for. `detail` explains it.

The signing service's policy, per the skill, allows only: USDC `approve` to a registry vault (capped,
never unlimited); vault `deposit` with the receiver set to the connected account (per-transaction
and daily caps); vault `withdraw` or `redeem` with receiver and owner both the connected account.
Everything else is refused before Privy is asked. Disconnecting a delegated session revokes the
service's session token but does not remove the signer from the wallet inside Privy; that is done in
Privy.

## Decisions already made

- **No WalletConnect.** Removed in 0.7.0 (method, pairing URI, QR, `@walletconnect/sign-client`,
  `WALLETCONNECT_PROJECT_ID`). The Privy SDK still bundles WalletConnect code as its own
  dependency; the plugin configures it off and offers no WalletConnect login. See
  `THIRD_PARTY_NOTICES.md`.
- **No headless signing.** Every send, including for an embedded wallet, goes through the
  confirmation page.
- The Turnkey email login (briefly present, removed in 0.5.0) is not coming back.

## What was observed running it (2026-10-03)

A manual session on Base with a directly connected browser wallet. Facts only, not a diagnosis.

1. `connect_wallet` connected (`via: wallet`, `walletType: external`, chain 8453).
2. USDC `approve` for 0.6 USDC to the default vault: submitted, `verified: matched`.
3. Vault `deposit` of 0.6 USDC: submitted, **`verified: mismatch`**. The tool's detail: the
   transaction on chain is a wrapped batch; the requested call is inside it; it also contains
   `transfer(0xe3478b0bb1a5084567c319096437924948be1964, 62637 raw units)` that was not requested.
   Hash `0x86f0ef76d44c8e2e6599ffeef4b99bb100ffe5bafeeeec32478c3680133d4c19`.
4. Vault `withdraw` of 0.6 USDC: submitted, **`verified: mismatch`**, same shape, with
   `transfer(0xe347…1964, 62206 raw units)`. Hash
   `0xd118791cf231f1cbd328ffff7d06aa31e28cc9d94a2ebbad604bd96ea3c4099e`.
5. A later `connect_wallet` attempt returned `rejected`: "the signing service could not be reached:
   fetch failed". That message comes from the Google/email path; the signing service was not
   reachable from that machine.

**Open question, not resolved:** what added the extra transfer. It appeared on both transactions
that went through the wallet, to the same address, at roughly 10% of the deposit amount each time.
The wallet wrapped the call in a smart-account batch. Not yet established: which wallet or
extension it was, whether it has a fee, tip or sponsorship feature, or whether the recipient is
known to Tempora. The `mismatch` check in `connect-plugin/src/` is what caught it; keep it. Until it
is explained, do not treat the direct-wallet path as safe for real amounts.

## Known gaps

- **Real flows are untested.** The tests (`connect-plugin/test/`, `signer-page/tests/`) cover the
  decoder and the confirmation and connect servers with the wallet and the signing service stubbed.
  A real MetaMask, a real Privy login and the real signing service are not exercised by anything.
- **The skill and the tool disagree on a required argument.** `earn_prepare_deposit` rejected a call
  without `receiver` ("expected string, received undefined at receiver"), but the Earn skill's
  one-click flow does not mention it. The skill needs updating, or the tool needs a default.
- **The Earn skill's connect step is out of date.** It says to show a `uri`/`qr` and poll
  `connect_status`. `connect_wallet` now waits and returns `connected` directly, and there is no QR.
- **`dist/` is checked in.** It is large (about 40k lines in `connect-server.mjs`). Rebuild with
  `npm run build` in `connect-plugin/` and check the diff before trusting it.
- **No CI** covers `connect-plugin/` or `signer-page/` in this repository yet.
- **Version.** `connect-plugin/package.json` says 0.7.0 and the changelog calls it Unreleased. Do
  not infer a release from the number.

## Running it

```bash
cd connect-plugin
npm ci
npm run build       # builds dist/
npm run typecheck
npm test
```

```bash
node signer-page/open.mjs --manual     # signer page, no agent needed
```

I ran none of these as part of preparing this change, so the commands are as documented in each
`package.json` and README, not as verified today.

## Suggested next steps

1. Find out what added the extra transfer (see above) before anything else touches real funds.
2. Get the signing service's source and policy into reach, then exercise the Google/email path end
   to end against it.
3. Fix the `receiver` and `uri`/`qr` mismatches in the Earn skill.
4. Add CI for both directories.
5. Decide whether `dist/` stays checked in.
