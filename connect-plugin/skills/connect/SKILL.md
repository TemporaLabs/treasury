---
name: connect
description: Connect, check, disconnect, or switch an account for Tempora Labs treasury skills — an existing wallet connected directly (MetaMask, Rabby, Coinbase Wallet or any browser wallet), or a Google/email login that opens a Privy embedded wallet — and relay one already-built call through a confirmation page so the operator sees the amount, vault and receiver before anything is signed. Produces an address; never asks for a key or seed phrase. Use before an Earn action that needs an account, whenever the operator wants to connect, check, disconnect, or change their account, or when Earn hands you a prepared call to get signed. Does not decide what a transaction contains — that is Earn's job.
---

# Connect — authenticate an account, and relay a call to it

You are establishing WHO the operator is, and — when asked — carrying ONE call someone else built
to that account's wallet. You never build a call yourself and never decide what one should contain:
that is Earn's job entirely. The `treasury-connect` MCP server gives you five tools, and each does
exactly one narrow thing: report or change whether an address is known, or hand one call to a
confirmation page and then to that address's wallet.

Connecting grants no signing authority by itself. **Every call, for every kind of wallet, opens a
confirmation page in the operator's browser first**, showing the decoded call — action, amount,
vault, receiver, chain — and nothing is signed until the operator clicks Confirm there. If the
operator asks this skill to decide an amount or a destination, say plainly that this skill only
moves what Earn already built — Earn's `earn_prepare_*` tools are where that gets decided.

## One sign-in button, two kinds of wallet

`connect_wallet` opens one browser page with a single **Connect** button. It opens one Privy modal
with email, Google and the browser wallets Privy detects. Both kinds connect a wallet the operator
**already has and controls**; you never ask which one up front, the operator picks in the modal.

- **A browser wallet** (MetaMask, Rabby, Coinbase Wallet or any detected extension). Privy only shows
  the picker. The operator signs a free sign-in message (no gas, cannot move funds), which the server
  checks locally; Privy's own login is not trusted for who controls the address. `connect_status`
  reports `via: "wallet"`, `walletType: "external"`. Needs a browser on the same machine as the agent
  with the wallet extension.
- **Google or email** — Privy signs the operator in and opens (or creates) its
  *embedded* wallet, which signs in the browser through Privy's own modal.
  `connect_status` reports `via: "privy"`, `walletType: "embedded"`.

Never offer or use WalletConnect, a QR code or a pairing link; this plugin does not support them. If
the operator wants a phone or remote wallet, say plainly that this plugin only connects a wallet in
a browser on the agent's own machine.

## What a send looks like

| Connected as | After the operator clicks Confirm on the page |
|---|---|
| `wallet` (external) | The wallet pops up its own prompt; the operator approves it there |
| `privy` (embedded) | The same page opens Privy's own modal; the operator approves it there and the page sends |

Because the page is where the destination is shown, the operator must read it. Still do Earn's
*Destination check* paste-back in chat before sending: quote the receiver from the operator's own
message and wait for them to confirm it. The page flags any receiver or owner that is not the
operator's account. The plugin signs nothing itself: a wallet's own prompt, or Privy's modal, is the
signature.

**Disconnecting** clears this machine's record of the session. The Privy login itself lives only in
the browser; it is replaced the next time the operator connects.

## Setup

Nothing is needed for a browser wallet. For **Google or email**, once: a Privy app with embedded
wallets on Base and email/Google login enabled, with `http://localhost:53682` listed as an allowed
origin (Privy accepts exact origins only; the page uses a fixed port, changeable with
`TREASURY_CONNECT_PORT`). `PRIVY_APP_ID` defaults to Tempora's app. There is no signing service and
nothing to export. **Never** put a Privy app secret or authorization key anywhere; if an operator
pastes one into chat, tell them to rotate it.

If a Google/email login fails, read the message on the page to the operator and have them run
`connect_wallet` again; do not retry in a loop.

## The tools

| tool | use it to |
|---|---|
| `connect_status` | check the current state and how it was made (`via`): `disconnected`, `awaiting_approval` (a sign-in is in flight), `connected`, or `rejected` (read once, then clears) |
| `connect_wallet` | sign in. Opens the one-button sign-in page and **waits up to `wait_seconds` (default 90)**, returning `connected` directly |
| `disconnect_wallet` | end the current session and clear the local record; reports `disconnected: false` if nothing was connected |
| `switch_wallet` | disconnect whatever is connected, then open a new sign-in page — also how to move between a directly connected wallet and a Google/email wallet |
| `connect_send_transaction` | Hand ONE call (`to`, `data`, optional `value`) from Earn's prepared envelope to the confirmation page, then returns `{status: "submitted", hash, verified}` or `{status: "rejected", reason}` |

## Connecting

1. **Call `connect_status` first.** Never assume a wallet is or isn't connected from prior
   conversation — session state can change between turns, and this is the one source of truth.
2. **If `disconnected`, call `connect_wallet`.** Tell the operator a tab is opening with a Connect
   button and that they pick email, Google or a wallet in the modal. The call waits and returns `connected` with the `account`
   — no polling. If it comes back `awaiting_approval` with `opened: true`, the wait ran out: tell
   them the tab is still open and call `connect_status` once they say they are done. If
   `opened: false`, no browser could be opened on this machine (SSH, no display): give them the
   `url` only if they are at this machine, otherwise say this plugin cannot sign in from there.
3. **`rejected` is read once.** If the operator declined, cancelled the tab, the
   login failed, or the sign-in timed out, `connect_status` reports `rejected` with a `reason` exactly
   once, then reads as `disconnected` on the next call. Tell the operator what happened before
   calling `connect_status` again — the reason will not still be there afterward.
4. **`connected` gives you an `account`.** That is the address — pass it to Earn's tools as their
   `account` argument. Earn's tools take an explicit `account` on every call and accept one from
   anywhere the operator gives it; Connect exists so the operator doesn't have to paste an address.

## Disconnecting and switching

- **`disconnect_wallet`** when the operator is done, or wants to be sure no address is being reused.
- **`switch_wallet`** when the operator wants a different wallet, or to move between a directly
  connected wallet and a Google/email wallet.

## Sending a call Earn prepared

1. **Earn builds; you only relay.** After `earn_prepare_deposit` or `earn_prepare_withdraw`
   returns its envelope (`{ requires_signature: true, status: "unsigned", calls }`), follow the
   envelope's own `signer_rules` first — confirm the destination against what the operator actually
   said, check any `precondition`. Those rules exist whether or not this skill is doing the sending.
2. **Call `connect_send_transaction` once per call, in order.** Pass exactly the `to` and `data`
   the envelope gave you, and `value` only if the call carries one. Do not modify them. Tell the
   operator a confirmation tab is opening and what it will show.
3. **Wait for the result — this call blocks (up to 3 minutes).** The operator reads the decoded call
   on the page and clicks Confirm or Reject. For a directly connected wallet their wallet then
   prompts; for an embedded wallet Privy's modal opens on the same page for the operator to approve.
   `{status: "submitted", hash}` means it signed and broadcast; it does **not** mean it confirmed.
   `{status: "rejected", reason}` covers a Reject click, a wallet decline, or a timeout. Report the
   `reason` plainly and do **not** retry a refused call with its fields changed; tell the operator
   instead.
4. **A rejection on step 2 of a deposit (the actual `deposit` call, after `approve` already
   submitted) is not a failure to retry blindly.** Tell the operator the approve went through and
   ask whether to retry the deposit — resending the same approve is redundant, not wrong, but
   needless.
5. **Confirmation of landing is Earn's job, not this skill's.** Once every call in the envelope
   reports `submitted`, hand back to Earn — `earn_balance` or `earn_status` is what confirms the
   transaction actually landed. Every send also reports `verified`: `matched` means the transaction
   on chain is exactly the call you passed; `unverified` means the lookup did not answer in time
   (not a problem, just unchecked); **`mismatch` means stop, do not send the next call, and tell the
   operator** — what landed is not what was asked for. A mismatch can carry a `detail` explaining
   it; read it to the operator verbatim. A wallet that relays calls inside a smart-account batch
   produces a wrapper transaction, and `detail` then says whether the requested call is inside it and
   lists any other `transfer(...)` riding along. That has really happened: an extra USDC transfer of
   about 0.06 USDC to a third address was bundled into a deposit and a withdrawal. Never describe
   such a mismatch as a glitch.
6. **A send needs a browser on this machine.** If it throws that none can open, the operator is on
   SSH or a remote session; say so plainly, and do not suggest an alternative signing path.

## Relationship to Earn

- **Connect owns wallet authentication, lifecycle, and the confirmation-and-signature step. Earn
  owns deciding what a transaction contains.** Earn never signs or sends by itself; Connect never
  decides an amount, a vault, or a destination by itself. Neither substitutes for the other.
- **If the operator invokes an Earn action and no account is known, call Connect first.** Run
  `connect_status`; if it isn't `connected`, run `connect_wallet`, get the address, then proceed
  with the Earn action using that `account`.
- **Connecting a wallet is never permission to transact.** Earn still presents disclosures, still
  quotes and pre-flights, and still returns an unsigned envelope first. Nothing moves until the
  operator clicks Confirm on the page for that exact call — fresh, every time.

## What this skill will not do

- **Ask for, display, store, or transmit a private key or seed phrase.** A directly connected wallet
  holds its own key; a Privy embedded wallet is signed inside Privy. This skill only ever carries a
  sign-in or a call to relay — never a key.
- **Use or offer WalletConnect, a QR code or a pairing link.**
- **Decide what to send.** `connect_send_transaction` relays a call it did not build and cannot
  alter. An operator asking this skill to "deposit some USDC" is asking the wrong skill — that
  decision, the vault, the amount, all belong to Earn; bring its prepared envelope here.
- **Sign anything without the operator's click on the confirmation page**, including for a
  delegated embedded wallet.
- **Hold or ask for a Privy app secret or authorization key.**
- **Assume a session survives forever.** `connect_status` is what notices, not memory of an earlier turn.
- **Confirm a transaction landed.** `connect_send_transaction` reports what was signed and whether
  it matches the request, not what the chain later did with it — that is `earn_balance`/`earn_status`.

## Reporting

State the actual status word (`disconnected` / `awaiting_approval` / `connected` / `rejected`),
and for `connected`, the address and which sign-in made it. An operator who sees "awaiting approval,
the tab is still open" can act; one who is told "still working on it" cannot.
