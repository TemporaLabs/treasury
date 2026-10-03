# Changelog

All notable changes to the Agent Treasury Connect plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.7.0] - Unreleased

Rebuilt from source in this repository. The server logic now lives in `src/` and is built to `dist/`
with `npm run build`; previously this repository carried only a bundle built elsewhere.

### Changed
- **Two separate sign-in paths on one page.** `connect_wallet` opens a page with "Continue with Google
  or email" (a Privy embedded wallet) and "Connect a wallet" (MetaMask, Rabby, Coinbase Wallet or any
  browser wallet, connected directly with a locally verified signature). The Privy SDK is loaded only
  on the Google/email path; the direct-wallet path never loads or calls Privy and never resumes a
  stored Privy session. The Privy page now accepts only Privy's own embedded wallet.
- **Every send goes through a confirmation page.** `connect_send_transaction` always opens a one-shot
  page showing the decoded call (action, amount, vault, receiver, chain, raw data) with warnings for a
  receiver or owner that is not the account, an unlimited approval, attached ETH, a plain transfer, or
  an unrecognised call. An embedded wallet is signed by the signing service only after the click on
  that page (previously it signed headlessly with no prompt); a directly connected wallet then shows
  its own prompt. A double click never signs twice.
- Sends now report `verified: matched | mismatch | unverified` for embedded wallets too.
- `connect_status` reports `via: "wallet"` (direct) or `via: "privy"` (embedded). A saved session from
  before this version that says `browser` is read as `wallet`.
- `connect_wallet` and `switch_wallet` take only `wait_seconds`; the `method` argument is gone.
- `.mcp.json` no longer sets `TREASURY_CONNECT_PROVIDER` or `WALLETCONNECT_PROJECT_ID`.

### Removed
- WalletConnect (the `walletconnect` method, its pairing URI and QR, `@walletconnect/sign-client`, and
  `WALLETCONNECT_PROJECT_ID`). Sessions saved by it read as disconnected.
- The `legacy` provider switch (`TREASURY_CONNECT_PROVIDER`): the extension-only page is now the
  "Connect a wallet" path of the one page.
- Headless signing with no confirmation page.

### Known gaps, stated plainly
- Real MetaMask and Privy flows are not exercised by the tests: they need a browser, an extension and a
  person. The tests cover the decoder, the confirmation and connect servers (secret, origin, double
  submit, rejection, signature checking, signing-service calls) with the wallet and service stubbed.
- The Privy SDK still bundles WalletConnect code as its own dependency (listed in
  `THIRD_PARTY_NOTICES.md`). The plugin configures it off and offers no WalletConnect login method.

## Earlier versions

0.1.0–0.6.0 carried a bundle built in `TemporaLabs/treasury`: WalletConnect pairing (0.1.0), a browser
sign-in alongside it, an optional Privy sign-in, and headless signing for a delegated embedded wallet
(0.6.0), with a short-lived Turnkey email login in between (removed in 0.5.0). The full history is in
git.
