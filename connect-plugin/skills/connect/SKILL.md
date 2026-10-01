---
name: connect
description: Connect, check, disconnect, or switch an account for Tempora Labs treasury skills — an existing wallet (MetaMask, Rabby, OKX Wallet, or any other WalletConnect-compatible wallet) — and relay one already-built call to a connected wallet for a signature. Produces an address; never asks for a key or seed phrase. Use before an Earn action that needs an account, whenever the operator wants to connect, check, disconnect, or change their account, or when Earn hands you a prepared call to get signed. Does not decide what a transaction contains — that is Earn's job.
---

# Connect — authenticate an account, and relay a call to it

You are establishing WHO the operator is, and — when asked — carrying ONE call someone else built
to that account's wallet. You never build a call yourself and never decide what one should contain:
that is Earn's job entirely. The `treasury-connect` MCP server gives you five tools over WalletConnect,
and each tool does exactly one narrow thing: report or change whether an address
is known, or hand one call to that address's wallet and wait for its own approve/reject decision.
Connecting here grants no signing authority by itself — nothing is authorized until a wallet
approves that one specific call, fresh, every time. If the operator asks this skill to decide an
amount or a destination, say plainly that this skill only moves what Earn already built — Earn's
`earn_prepare_*` tools are where that gets decided.

## One connect method: WalletConnect

**`connect_wallet`** pairs with a wallet the operator **already has and already controls**
(MetaMask, Rabby, OKX Wallet, or any other WalletConnect-compatible wallet), via WalletConnect.
Nothing new is created; you're just learning an address that already existed.

Email login and creating a new wallet are **not supported** (a future iteration may add them if
users need it). If the operator says "log in with my email" or "I don't have a wallet", say so
plainly and suggest they set up a WalletConnect-compatible wallet such as MetaMask or Rabby first —
don't simulate an email login.

## Setup

`WALLETCONNECT_PROJECT_ID` — a free project id from WalletConnect's dashboard (cloud.reown.com). It
identifies this app to the relay; it is **not** a secret. The plugin ships a default, so this is
only needed to override it. If it is missing the tools throw a clear error saying so.

## v1 scope, plainly

Supported: any WalletConnect-compatible wallet (MetaMask, Rabby, OKX Wallet, and others) on Base
(chain 8453). **Not supported: email login, creating a new wallet, Google login.**
`connect_send_transaction` asks the connected wallet's own approve/reject prompt to sign and broadcast.

## The tools

| tool | use it to |
|---|---|
| `connect_status` | check the current state: `disconnected`, `awaiting_approval` (a WalletConnect pairing is in flight), `connected`, or `rejected` (read once, then clears) |
| `connect_wallet` | start a WalletConnect pairing; returns immediately with a `uri` and an ASCII `qr` — it does **not** wait for the wallet's approval |
| `disconnect_wallet` | end the current session and clear the local record; reports `disconnected: false` if nothing was connected |
| `switch_wallet` | disconnect whatever is connected, then immediately start a new **WalletConnect** pairing — same result as calling the two above in order. |
| `connect_send_transaction` | Hand ONE call (`to`, `data`, optional `value`) from Earn's prepared envelope to whichever wallet is connected; blocks up to 120s for the wallet's own approve/reject, then returns `{status: "submitted", hash}` or `{status: "rejected", reason}` |

## Connecting

1. **Call `connect_status` first.** Never assume a wallet is or isn't connected from prior
   conversation — session state can change between turns (the wallet's own app can end a session
   at any time), and this is the one source of truth.
2. **If `disconnected`, call `connect_wallet`.** Show the operator the `uri` and the `qr` exactly as
   returned — the `qr` is plain text, safe to render in chat. Tell them: open the `uri` in a
   WalletConnect-compatible wallet (desktop or mobile), or scan the `qr` with a mobile wallet's
   WalletConnect scanner.
3. **This does not block.** `connect_wallet` returns the moment the pairing URI exists, not once
   the wallet approves — that can take anywhere from seconds to never. Call `connect_status` again
   to see whether it resolved. If it is still `awaiting_approval`, the same `uri`/`qr` come back
   unchanged; re-show them if the operator asks.
4. **`rejected` is read once.** If the wallet declined or the pairing timed out, `connect_status`
   reports `rejected` with a `reason` exactly once, then reads as `disconnected` on the next call.
   Tell the operator what happened before calling `connect_status` again — the reason will not
   still be there afterward.
5. **`connected` gives you an `account`.** That is the address — pass it to Earn's tools as their
   `account` argument. Nothing about being connected here is required for Earn to work: Earn's
   tools take an explicit `account` on every call and will accept one from anywhere the operator
   gives it. Connect exists so the operator doesn't have to paste an address by hand.

## Disconnecting and switching

- **`disconnect_wallet`** when the operator is done, or wants to be sure no address is being
  reused. There is no separate "revoke" step for a WalletConnect session (this server never held
  signing authority to begin with).
- **`switch_wallet`** when the operator wants a different WalletConnect wallet — it disconnects the
  current session and starts a fresh pairing in one call.

## Sending a call Earn prepared

1. **Earn builds; you only relay.** After `earn_prepare_deposit` or `earn_prepare_withdraw`
   returns its envelope (`{ requires_signature: true, status: "unsigned", calls }`), follow the
   envelope's own `signer_rules` first — confirm the destination against what the operator actually
   said, check any `precondition`. Those rules exist whether or not this skill is doing the sending.
2. **Call `connect_send_transaction` once per call, in order.** Pass exactly the `to` and `data`
   the envelope gave you, and `value` only if the call carries one. Do not modify them.
3. **Wait for the result — this call blocks.** Unlike `connect_wallet`, this one waits (up to
   120s) for the connected wallet's own approve/reject. `{status: "submitted",
   hash}` means it signed and broadcast; it does **not** mean it confirmed. `{status: "rejected",
   reason}` covers a decline, an authorization failure, or a timeout — report the `reason` plainly.
4. **A rejection on step 2 of a deposit (the actual `deposit` call, after `approve` already
   submitted) is not a failure to retry blindly.** Tell the operator the approve went through and
   ask whether to retry the deposit — resending the same approve is redundant, not wrong, but
   needless.
5. **Confirmation is Earn's job, not this skill's.** Once every call in the envelope reports
   `submitted`, hand back to Earn — `earn_balance` or `earn_status` is what confirms the transaction
   actually landed. This tool has no RPC access and cannot tell you whether a hash confirmed.

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
