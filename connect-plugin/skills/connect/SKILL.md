---
name: connect
description: Connect, check, disconnect, or switch an account for Tempora Labs treasury skills — an existing wallet (MetaMask, Rabby, Coinbase Wallet, OKX Wallet, or any WalletConnect-compatible wallet; by browser tab or by WalletConnect) — and relay one already-built call to a connected wallet for a signature. Produces an address; never asks for a key or seed phrase. Use before an Earn action that needs an account, whenever the operator wants to connect, check, disconnect, or change their account, or when Earn hands you a prepared call to get signed. Does not decide what a transaction contains — that is Earn's job.
---

# Connect — authenticate an account, and relay a call to it

You are establishing WHO the operator is, and — when asked — carrying ONE call someone else built
to that account's wallet. You never build a call yourself and never decide what one should contain:
that is Earn's job entirely. The `treasury-connect` MCP server gives you five tools over two sign-in methods,
and each tool does exactly one narrow thing: report or change whether an address
is known, or hand one call to that address's wallet and wait for its own approve/reject decision.
Connecting here grants no signing authority by itself — nothing is authorized until a wallet
approves that one specific call, fresh, every time. If the operator asks this skill to decide an
amount or a destination, say plainly that this skill only moves what Earn already built — Earn's
`earn_prepare_*` tools are where that gets decided.

## Two ways to sign in

Both connect a wallet the operator **already has and already controls**. Nothing new is created;
you're just learning an address that already existed. Pick with `connect_wallet`'s `method`:

- **`browser`** (the default). A tab opens in the operator's browser; they pick their wallet
  extension (MetaMask, Rabby, Coinbase Wallet…) and sign a free sign-in message. The tab then says
  to close it and go back to the terminal. Nothing is pasted anywhere. It proves control of the
  address with a real signature, which costs no gas and cannot move funds. Needs a browser on the
  same machine as the agent, with the wallet extension installed.
- **`walletconnect`**. Returns a pairing `uri` and a text `qr` for any WalletConnect wallet, including a
  phone. Use it when the operator asks for it, prefers a mobile wallet, has no extension, or the
  session is over SSH or remote (a browser cannot open there; `connect_wallet` says so with
  `opened: false`).

Which one made the session is reported as `via` and decides how a later send works (see below).
Do not ask the operator which to use unless they have hinted at one: start with `browser`, and offer
WalletConnect only if the tab cannot open or the operator says it is not working.

Email login and creating a new wallet are **not supported** (a future iteration may add them if
users need it). If the operator says "log in with my email" or "I don't have a wallet", say so
plainly and suggest they set up a wallet such as MetaMask or Rabby first — don't simulate an email login.

## Setup

`WALLETCONNECT_PROJECT_ID` — a free project id from WalletConnect's dashboard (cloud.reown.com). It
identifies this app to the relay; it is **not** a secret. The plugin ships a default, so this is
only needed to override it. If it is missing the tools throw a clear error saying so.

## v1 scope, plainly

Supported: Base (chain 8453), by browser sign-in (any extension wallet) or WalletConnect (MetaMask,
Rabby, OKX Wallet, and others, including mobile). **Not supported: email login, creating a new wallet,
Google login.** `connect_send_transaction` asks the connected wallet's own approve/reject prompt to
sign and broadcast.

## The tools

| tool | use it to |
|---|---|
| `connect_status` | check the current state and how it was made (`via`): `disconnected`, `awaiting_approval` (a sign-in is in flight), `connected`, or `rejected` (read once, then clears) |
| `connect_wallet` | sign in. `method: "browser"` (default) opens a tab and **waits up to `wait_seconds` (default 90)**, returning `connected` directly; `method: "walletconnect"` returns immediately with a `uri` and an ASCII `qr` |
| `disconnect_wallet` | end the current session (either method) and clear the local record; reports `disconnected: false` if nothing was connected |
| `switch_wallet` | disconnect whatever is connected, then start a new sign-in with the `method` you pass — also how to move from one method to the other |
| `connect_send_transaction` | Hand ONE call (`to`, `data`, optional `value`) from Earn's prepared envelope to whichever wallet is connected, then returns `{status: "submitted", hash}` or `{status: "rejected", reason}`. WalletConnect: blocks up to 120s for the wallet app. Browser: opens a one-shot tab (up to 3 min) |

## Connecting

1. **Call `connect_status` first.** Never assume a wallet is or isn't connected from prior
   conversation — session state can change between turns (the wallet's own app can end a session
   at any time), and this is the one source of truth.
2. **If `disconnected`, call `connect_wallet`** (browser by default; `method: "walletconnect"` if the
   operator asked for it or no browser can open here).
   - **Browser:** tell the operator a tab is opening and to pick their wallet and sign the free message
     there. The call waits for them and returns `connected` with the `account` — no polling. If it comes
     back `awaiting_approval` with `opened: true`, the wait ran out: tell them the tab is still open and
     call `connect_status` once they say they are done. If `opened: false`, no browser could be opened
     on this machine: either give them the `url` (only if they are at this machine) or switch to
     `walletconnect`.
   - **WalletConnect:** show the operator the `uri` and the `qr` exactly as returned — the `qr` is plain
     text, safe to render in chat. Tell them to open the `uri` in a WalletConnect-compatible wallet, or
     scan the `qr` with a mobile wallet's scanner.
3. **WalletConnect does not block.** It returns the moment the pairing URI exists, not once the wallet
   approves — that can take anywhere from seconds to never. Call `connect_status` again to see whether
   it resolved. If it is still `awaiting_approval`, the same `uri`/`qr` come back unchanged; re-show
   them if the operator asks.
4. **`rejected` is read once.** If the wallet declined, the tab was cancelled, or the sign-in timed out, `connect_status`
   reports `rejected` with a `reason` exactly once, then reads as `disconnected` on the next call.
   Tell the operator what happened before calling `connect_status` again — the reason will not
   still be there afterward.
5. **`connected` gives you an `account`.** That is the address — pass it to Earn's tools as their
   `account` argument. Nothing about being connected here is required for Earn to work: Earn's
   tools take an explicit `account` on every call and will accept one from anywhere the operator
   gives it. Connect exists so the operator doesn't have to paste an address by hand.

## Disconnecting and switching

- **`disconnect_wallet`** when the operator is done, or wants to be sure no address is being
  reused. There is no separate "revoke" step for either method (this server never held
  signing authority to begin with).
- **`switch_wallet`** when the operator wants a different wallet or the other method — it
  disconnects the current session and starts a fresh sign-in (pass `method`) in one call.

## Sending a call Earn prepared

1. **Earn builds; you only relay.** After `earn_prepare_deposit` or `earn_prepare_withdraw`
   returns its envelope (`{ requires_signature: true, status: "unsigned", calls }`), follow the
   envelope's own `signer_rules` first — confirm the destination against what the operator actually
   said, check any `precondition`. Those rules exist whether or not this skill is doing the sending.
2. **Call `connect_send_transaction` once per call, in order.** Pass exactly the `to` and `data`
   the envelope gave you, and `value` only if the call carries one. Do not modify them.
3. **Wait for the result — this call blocks.** Tell the operator what to expect first: with a
   `browser` session a tab opens showing the decoded call and their wallet pops up to confirm; with a
   `walletconnect` session the prompt appears in their wallet app. It waits (WalletConnect up to 120s,
   browser up to 3 minutes) for the connected wallet's own approve/reject. `{status: "submitted",
   hash}` means it signed and broadcast; it does **not** mean it confirmed. `{status: "rejected",
   reason}` covers a decline, an authorization failure, or a timeout — report the `reason` plainly.
4. **A rejection on step 2 of a deposit (the actual `deposit` call, after `approve` already
   submitted) is not a failure to retry blindly.** Tell the operator the approve went through and
   ask whether to retry the deposit — resending the same approve is redundant, not wrong, but
   needless.
5. **Confirmation is Earn's job, not this skill's.** Once every call in the envelope reports
   `submitted`, hand back to Earn — `earn_balance` or `earn_status` is what confirms the transaction
   actually landed. A WalletConnect send cannot tell you whether a hash confirmed. A browser send adds
   `verified`: `matched` means the transaction on chain is exactly the call you passed; `unverified`
   means the lookup did not answer in time (not a problem, just unchecked); **`mismatch` means stop,
   do not send the next call, and tell the operator** — what landed is not what was asked for.
6. **A browser send needs a browser on this machine.** If it throws that none can open, the operator
   is on SSH or a remote session: use `switch_wallet` with `method: "walletconnect"`, then send.

## Relationship to Earn

- **Connect owns wallet authentication, lifecycle, and the actual signature request. Earn owns
  deciding what a transaction contains.** Earn never signs or sends by itself; Connect never
  decides an amount, a vault, or a destination by itself. Neither substitutes for the other.
- **If the operator invokes an Earn action and no account is known, call Connect first.** Run
  `connect_status`; if it isn't `connected`, run `connect_wallet`, get the address, then proceed
  with the Earn action using that `account`.
- **Connecting a wallet is never permission to transact.** Earn still presents disclosures, still
  quotes and pre-flights, and still returns an unsigned envelope first. Nothing moves until
  `connect_send_transaction` asks the connected wallet for that exact call, and the wallet's own
  approval — requested fresh, every time — is what authorizes it, not the earlier connection.

## What this skill will not do

- **Ask for, display, store, or transmit a private key or seed phrase.** A WalletConnect wallet
  holds its own key and does its own signing. This skill only ever carries a pairing handshake or a
  call to relay — never a key.
- **Decide what to send.** `connect_send_transaction` relays a call it did not build and cannot
  alter. An operator asking this skill to "deposit some USDC" is asking the wrong skill — that
  decision, the vault, the amount, all belong to Earn; bring its prepared envelope here.
- **Connect via email or Google, or create a wallet.** Not built; say so plainly, don't simulate it.
- **Assume a session survives forever.** A WalletConnect wallet app can end its side of the session
  at any time; `connect_status` is what notices, not memory of an earlier turn.
- **Confirm a transaction landed.** `connect_send_transaction` reports what the wallet did with the
  request, not what the chain later did with the transaction — that is `earn_balance`/`earn_status`.

## Reporting

State the actual status word (`disconnected` / `awaiting_approval` / `connected` / `rejected`),
and for `connected`, the address. An operator who sees "awaiting approval, here's the QR again" can act; one who is told "still
working on it" cannot.
