# 01: The local page, sign-in and local state

## The pieces

| piece | file |
|---|---|
| the commands (`connect status`, `wallet`, `deposit`, `withdraw`, `plan`, `disconnect`) | `src/connect/commands.ts` |
| the one-shot loopback server | `src/connect/http.ts` |
| the HTML shell and its Content-Security-Policy | `src/connect/page.ts` |
| the browser page (React and Privy's SDK) | `connect-page/src/main.tsx`, `connect-page/src/plan.tsx`, `connect-page/src/shared.tsx`, built into `dist/connect-page.js` |
| opening the operator's browser | `src/connect/open.ts` |
| ports, Privy app id, state directory | `src/connect/config.ts` |
| the local state files and the page lock | `src/connect/session.ts` |
| the Solana sign-in and confirm flows | `src/connect/solana.ts` |

**Privy** is the third-party sign-in service the page uses for email and social logins (which give
the operator an embedded wallet) and for listing browser wallets. Its app id is a public identifier
committed in `src/connect/config.ts`; no Privy secret exists in the package.

## A page that exists for one flow

`serveOnce` (`src/connect/http.ts`) starts a server for one sign-in, one confirmation, or one plan's
page, on the loopback addresses only (`127.0.0.1`, and `::1` where IPv6 is on), on the first free port
of `connectPorts()`. Each port must be an origin the Privy app allows, which is why the list is fixed.
It closes when the flow settles or its time limit (`CONNECT_TTL_MS`, `CONFIRM_TTL_MS` in
`src/connect/commands.ts`) runs out, a limit chosen to stay under a shell tool's 10-minute timeout.

Every request is checked before it is served:

- the `Host` header must be the server's own;
- every GET carries the flow's random secret (`?s=`), compared in constant time;
- every POST (`/challenge`, `/result`) must also carry its own `Origin`, a JSON content type, a body
  under `MAX_BODY_BYTES`, and the secret in the body;
- `/result` takes one result at a time (`busy`), so a double click cannot hand a call over twice.

The routes are `/<mode>` (the shell), `/app.js` (the bundle), `/info` (what the page should show,
from the flow's `info()`), `/challenge` (sign-in only) and `/result`. A `/result` handler answers
`final: false` to keep the flow open, which is how a confirmation takes one transaction at a time.

**One page at a time.** `claimPageLock` (`src/connect/session.ts`) takes a lock file naming the
process and its expiry, touched on a heartbeat; a lock whose process has gone or whose page expired is
replaced. The port no longer serialises pages, because the page can fall back to the next port.

**Opening the browser.** `openBrowser` starts only the platform's own "open this URL" program, and
refuses (so the URL is printed instead) over SSH, on Linux with no display, or with
`TREASURY_CONNECT_NO_OPEN` set. `src/connect/open.ts` is the one shipped file the boundary test lets
start a process.

## Sign-in proves the account

`runConnect` (`src/connect/commands.ts`): the page asks `/challenge` for a sign-in message for the
address the wallet chose. `signInMessage` builds it with the page's origin and the flow's secret as
nonce. The wallet signs it (free, no transaction), and `accept` checks the signature: an ordinary
wallet offline with viem's `verifyMessage`, a smart-contract wallet by asking its contract through the
Base RPC when the offline check fails. Only then is the account written.

On Solana, `runConnectSolana` and `solanaSignInMessage` (`src/connect/solana.ts`) do the same with an
ed25519 signature checked offline (`verifySolanaSignIn`).

## Local state

All under `~/.config/treasury/` unless `TREASURY_CONNECT_HOME` moves it, written owner-readable only
(`writeOwnerOnly`):

| file | holds | written by |
|---|---|---|
| connect-session.json | the EVM account, `walletType`, when it connected | `writeSession` |
| connect-session-solana.json | the Solana account, likewise | `writeSolanaSession` |
| connect-ack.json | the one pending acknowledgement (code, digest, expiry) | `writePendingAck` |
| connect-plan.json | the pending or running plan, its legs, and its page's secret and port | `writePlan` |
| connect-page.lock | which process holds the open page | `claimPageLock` |

None holds a credential. A connection grants nothing by itself: it fixes which account the confirm
page will accept and pay. A new sign-in on either family, and `connect disconnect`, clear any
pending acknowledgement and plan, since they were given for the previous account; `connect
disconnect` also deletes both connection files. Issuing a new acknowledgement replaces the pending
one.

## The page bundle

`connect-page/` is a separate package with its own lockfile, built by `connect-page/build.mjs` into
one minified file. The build stubs out every WalletConnect and Reown module and fails if one reaches
the bundle, and it writes the bundle's third-party notices. `readPageBundle` (`src/connect/page.ts`)
finds the bundle beside the CLI once bundled, or under `dist/` when run from source.

What the page may ask a wallet for, and that it stores nothing and fetches only its own server, is
pinned by `tests/connect-page-source.unit.test.ts`; that the server sends exactly `PAGE_CSP` is checked
in `tests/connect.unit.test.ts`. The limits of those tripwires are stated in
[`../../security-model.md`](../../security-model.md#the-wallet-connection-treasury-connect). Rebuilding the page is
covered in [`../release/01-build-and-bundles.md`](../release/01-build-and-bundles.md).
