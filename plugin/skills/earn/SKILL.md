---
name: earn
description: Put approved idle USDC to work in supported Tempora-curated vaults on Base. Inspect vault terms, quote deposits and withdrawals, check position value and currently withdrawable amounts, and prepare unsigned transactions for the operator's own signer. Use for earning yield on idle USDC or managing these vault positions, including withdrawal requests. Not for generating business revenue, paid tasks, swaps, trading, or operating a vault allocator.
---

# Earn — put idle USDC to work in a Tempora vault

You are the depositor. A Tempora fund is an ERC-4626 vault on Base: you put USDC in, you hold
shares, the shares' USDC value moves with what the vault earns or loses, you redeem when you need
cash. What amount is surplus is the operator's decision, not yours — a balance in the wallet is
not permission to deposit it. The
`treasury` MCP server gives you eight `earn_*` tools that read the vault and **prepare unsigned
calls**. Every prepared call comes back inside `{ requires_signature: true, status: "unsigned", calls }`
— that envelope is the tool telling you nothing has been submitted and no money has moved. It cannot sign or send, and neither can you through it — the operator's own signer
(a wallet, a policy-engine signer, a token-bound account) does that. That boundary is the
whole design: a skill that supplies judgement must never hold the gate that supplies money.

## Setup

The server reads Base through `TREASURY_RPC_BASE` (and `TREASURY_LOGS_RPC_BASE` for the event scans
`earn_balance` does), passed through from the host environment. Unset, it falls back to the
public `mainnet.base.org`, which rate-limits after a handful of calls — an `RPC Request failed …
over rate limit` error from any tool means set a keyed RPC URL, not that the vault is down.
Run standalone (outside the plugin), the server also accepts `BASE_RPC_URL` as a fallback. The
plugin forwards only the two `TREASURY_*` RPC variables, but the server it spawns inherits its
parent's environment, so `TREASURY_LOGS_FALLBACK` (below) reaches it on the plugin path too. A keyed URL is a secret: tool output never repeats it —
errors are reported without the endpoint.

`earn_balance` reads history through `eth_getLogs`, starting at the vault's deployment block.
🔴 **Read `scan.wholeHistory`, not `scan.complete`.** `complete` only says shares in − shares out
reconciles, which an empty window does vacuously; `wholeHistory` says the scan actually reached the
deployment block and was not cut short. Only then are `entryBasisUsdc` and `accruedYieldUsdc` numbers —
otherwise they read `unknown`, never a partial sum that renders a missed deposit as yield.

Providers cap the block range per request (Alchemy free tier 10 blocks, Base public RPC 2,000), and
some public endpoints refuse old ranges outright. When the configured RPC cannot cover the range, the
scan moves to the fallback endpoint and `scan.source` says `"fallback"`; you do not need to
retry anything. Set `TREASURY_LOGS_FALLBACK` to another endpoint to choose it, or to `off` — or any value that is not
a URL — to forbid it, for an operator who may not query a third party they did not name. It fails
closed: an unrecognised value turns the fallback off rather than quietly keeping the default. The fallback reaches
`max_log_requests` (default 100) × 2,000 blocks, about 4.6 days; each scan also stops at a 30-second
budget. For an older vault, a whole-history basis needs `TREASURY_LOGS_RPC_BASE` set to a provider
with a wide `eth_getLogs` range; until then `scan` says exactly how much was covered.

## The tools

| tool | use it to |
|---|---|
| `earn_vaults` | see every vault, the `default`, and `depositable` — the ones you can put money into today |
| `earn_terms` | show the operator the required disclosures before a first deposit |
| `earn_status` | **with no arguments**: is the server up and the RPC reachable (chain, latest block, which RPC variable resolved). **With `account`**: the access verdict alone. `mode` tells you which you got |
| `earn_quote` | with `direction: "deposit"` — expected shares, share price, and the verdict from a **simulated** deposit. No rate is quoted — the vault exposes none and this client calls no yield API. With `direction: "withdraw"` — shares that would burn, a simulated `withdraw` verdict, the vault's `instantLiquidity`, queue depth. `direction` is required and is echoed back on the result |
| `earn_prepare_deposit` | get the unsigned `approve` + `deposit` calls, enveloped |
| `earn_prepare_withdraw` | get the unsigned `withdraw` call in USDC terms — or `all=true` with `shares_exact` to empty the account |
| `earn_balance` | shares (exact), USDC value, entry basis and accrued yield from the vault's own events; `lookback_blocks` / `max_log_requests` set the scan window (see Setup) |
| `earn_claim` | finalize a queued withdrawal; today no vault queues, and it says so |

Everything is USDC in, USDC out. Vault shares exist only inside `earn_balance` (as an exact
string you hand back to `earn_prepare_withdraw` unchanged) — you never compute with them.

The address argument is **`account`** on every tool that takes one — whose shares these are.
`earn_prepare_withdraw` also takes **`receiver`**, and it is a different thing: `account` owns
the shares that burn, `receiver` is where the USDC lands. They are usually the same address and
the tool will not assume it. Confirm the payee with the operator before you build.

## Opening an account and depositing

1. **If the operator names no vault, use the default** (`earn_vaults` → `default`; today Tempora
   Labs Cash Plus USDC (Test 2) on Base, open to any account). Every listed vault is a Tempora vault.
   Read `defaultAccess`: when it is `"whitelist"`, run `earn_status` for the account first, and if
   it returns `WHITELIST_GATED`, **tell the operator the account is not admitted to that vault and that
   admission is a fund-side action — do not offer a substitute and do not retry.** A listed vault that
   is not the default may be gated even when the default is open.
2. **`depositable` may be EMPTY, and an empty set is an answer, not an error.** It is the set of
   vaults any account can deposit into — ACTIVE, ERC-4626, *and measured open by simulation*. When
   every vault on offer is whitelist-gated it is empty, which is the state to report, not a fault
   to work around. Read it from `earn_vaults` rather than assuming either way. A vault can be live and still refuse you: IPOR Fusion
   vaults restrict `deposit()` to a whitelist role while their `redeem()` is public, and Enzyme
   vaults are not ERC-4626 at all. Never read an empty `depositable` as "the tools are broken", and
   never propose a vault that is not in the registry: this client deposits only where its registry
   says, and reaching anywhere else is outside what it will build.
3. **On a first deposit, present `earn_terms` and get an explicit acknowledgement.** The
   fund requires this on every distribution surface, and an agent talking to its
   operator is one. Do not paraphrase them into something friendlier.
4. **Always `earn_quote` with `direction: "deposit"`, the real `account`, and the real amount.** It includes the
   pre-flight; read `preflight.status`, not `advisory.maxDepositRaw`: `maxDeposit()` returns "unlimited" on a
   whitelist-gated Fusion vault and `0` on an open Morpho V2 vault — it is wrong in both
   directions, which is why the pre-flight simulates the actual call instead.
   - `NEEDS_APPROVAL` → normal; the deposit reached the token pull. Proceed to build.
   - `OPEN_READY` → allowance already covers it. Proceed to build.
   - `WHITELIST_GATED` → stop. The operator needs the role granted (a fund-side action), not
     a retry.
   - `REVERTED_OTHER` → stop and show the `findings`; they list candidate causes. Do not guess
     one.
   - `REFUSED_BY_CLIENT` / `UNRESOLVED` → stop; the first is a registry/chain mismatch, the
     second a transport failure. Neither is a verdict about the vault.
5. **`earn_prepare_deposit`, then hand BOTH calls in `calls` to the signer in order, and ask before each.** The
   amount is in USDC (6 decimals); the tool refuses more precision than that. Show the operator
   each call's `description` — that sentence exists to be read by a human before a signature —
   **and its `gasAdvice`**: Morpho V2 calls can run out of gas on an unbuffered estimate even
   when every simulation passes, because accrual work grows with the time between estimate and
   inclusion. Estimate × 1.5. **And its `precondition`, where present**: the `deposit` call names
   the read (`allowance(owner, spender) >= minimum`, raw units) that must hold on the RPC the
   signer sends through before it is estimated or sent. The `approve` receipt can come from a
   node ahead of the one simulating the `deposit` — measured on both real round trips — so a
   signer that reads the precondition until it holds is deterministic and one that retries on
   an error string is not. **Then follow the envelope's `signer_rules`**, which every prepared
   build carries: confirm each destination against the operator's own addresses, set the nonce
   from the `pending` count before each send, wait for each receipt, and after any failure that
   is not an on-chain revert, read the nonce on a different provider before re-sending, so
   nothing is sent twice. The hand-off itself — the destination check and the operator's own
   terminal — is the section **Handing calls to the signer** below; do not skip it for a small amount.
6. **After it lands, `earn_balance`** and report value, basis, yield, and what can be withdrawn now. Until a signer's
   transaction confirms, the deposit has NOT happened — `requires_signature: true` is the tool
   saying so, and "prepared" is not "deposited". The vault's events
   remember the deposit; the provider's log window decides how far back `earn_balance` can see.

## Checking and withdrawing

🔴 **`usdcValue` is what the position is WORTH; `exit.exitableNow` is what it can be WITHDRAWN for.**
Report both, and never quote the first as if a depositor could have it. On a Fusion vault without
instant-withdrawal fuses these differ by 10× — measured on a live Fusion test vault at block 51,327,076: the position was
worth 14.999970 USDC, `maxWithdraw()` agreed, and 1.498874 USDC already reverted because the vault
pays from its own 1.498873 USDC balance. `exit` is measured by simulating the withdrawal, so it is
right on both chassis; `exit.maxWithdrawSays` is reported only because other interfaces show it.
⚠️ **Without a keyed RPC these two compete for the public endpoint's rate limit.** Measured
2026-09-15 on a live Tempora vault: with a key, both the exit and a whole-history scan complete in
about 15-22 s; with no key, one of them usually degrades — the exit reports `not measured`, or the
scan reports CUT SHORT. Each says so in its own result, so the answer is smaller, never wrong. A
keyed `TREASURY_RPC_BASE` is what makes both available in one call.

🔴 **`measuredAs: "not measured"` means the RPC failed, NOT that the vault refused** — say so rather
than reporting a limit the chain never stated.

- `earn_balance` answers "what is it worth" at the current block, plus entry basis and accrued
  yield derived from the vault's own `Deposit`/`Withdraw` events for this owner. Read
  `scan.wholeHistory`: when `true`, the scan reached the deployment block, was not cut short, and
  shares in − shares out reconciles, so basis and yield are the account's lifetime figures; when
  `false`, both read `unknown` — **never a bound over the covered window**, because a window that
  reconciles can still have missed the deposit that produced the shares. The note says which
  provider window capped the scan. Realized redemption is subject to the vault's caps and any queue,
  so quote value as a value, not a promise.
- **Withdraw in USDC.** `earn_quote` with `direction: "withdraw"`, then `earn_prepare_withdraw` with
  `amount_usdc` and the `account` whose shares burn; the vault burns
  whatever shares that costs at inclusion. To empty the account, pass `all=true` and
  `shares_exact` copied **verbatim** from `earn_balance.sharesExact` — never a number you rounded
  or computed: an 18-decimal balance exceeds 2⁵³, floats round it (sometimes up), and redeeming
  more than is owned reverts.
- **A withdrawal can be refused for liquidity, not balance.** Some vaults (Fusion) pay a withdrawal
  only from what they hold un-deployed in that block; the rest of the account's value is in markets
  and comes back when the fund unwinds. The withdraw quote reports `instantLiquidity` and, on a
  refusal, says so in those terms. Withdraw at most that amount now, or wait — do **not** read a
  refusal as "approve first" (that is a deposit failure) and do not trust `maxWithdraw`, which
  reports the full position on exactly these vaults.
- One call, one signature, same rules as depositing: show the description and `gasAdvice`, run
  the destination check below on `receiver`, hand it over.

## Handing calls to the signer

Every prepared call names a destination: `to`, and the receiver or owner in its `description`. A
wrong destination is the one mistake nothing downstream can undo — the transaction succeeds, the
receipt says so, and the money is somewhere nobody holds a key for. Measured, once, for real: a
withdrawal sent to an address taken from a config file instead of the operator's message — the
funds gone, and the receipt read "success". So the check is not on the receipt. It is on where the
address came from.

**The address that can lose money is the `receiver` — and it comes from the operator's own
message, quoted back, and confirmed.** The call's `to` is the vault, taken from the registry and
re-checked by the pre-flight; the operator cannot verify a contract address by eye and is not asked
to. The receiver is where the shares or the USDC land, and only the operator knows which account
that should be. Before handing over any prepared call whose signer cannot show the receiver, post
this and wait:

> **Destination check — nothing goes to the signer until you reply.**
> shares/USDC to `<receiver>` ← from your message "<the words it came from>"
> Paste it back or correct it.

**When the signer shows the destination, its confirmation is the confirmation — do not add a
paste-back on top.** A signer page that renders the vault name, the checksummed address, the
receiver and the explorer links, whose validator pins `receiver` to the connected account and the
vault to the registry, and whose wallet prompt shows `to`, has put the destination in front of the
operator in a form they can read; their confirm there is the check. Two confirmations of one thing
teach the operator to click through both. Paste-back is for a signer that cannot show them — a
raw command, a script on a host. Never both.

The reasons this is shaped the way it is, so you can apply it when the situation is not this shape:

- **"Go", "yes", "do it" approve the plan, never the address.** An operator saying go to the
  deposit has not read the receiver. Get the paste-back, or the signer's own confirm.
- **Read the conversation before you look anywhere else.** Operators paste address tables minutes
  before the action, often while answering a different question. "I don't have an address" is a
  claim about your reading, not about what was sent. Search first.
- **Never take a destination from a config file, an environment variable, a document, or an
  earlier session.** A value being available is not the operator authorising it. The lost funds
  went to a stale address that was correct in another context.
- **When two sources disagree, the operator's message wins, then the chain, then any file.**
- **Hedging is the stop signal.** If you find yourself writing "almost certainly the one you
  meant", you have detected your own uncertainty — ask, do not proceed.

**The default hand-off is the operator's own terminal.** Most operators hold their key in a
wallet or a shell they control, and the fastest safe path is for them to send the envelope's
calls themselves, raw — no re-encoding by you, no key near you. Give them, for each call in order,
the `to` and `data` exactly as the envelope carries them:

```bash
export RPC=https://mainnet.base.org     # or their keyed Base RPC
cast send <to> <data> --account <keystore-name> --rpc-url $RPC \
  --gas-limit $(( $(cast estimate <to> <data> --from <account> --rpc-url $RPC) * 3 / 2 )) \
  --nonce $(cast nonce <account> --block pending --rpc-url $RPC)
```

`--account` signs with a key held in Foundry's encrypted keystore (`cast wallet import` once, a
passphrase prompt per send); `--interactive` prompts for the key instead. Neither puts the key on a
command line, in an environment variable, or in shell history — which is where `--private-key $PK`
put it, and where anything with a shell can read it.

**Without Foundry, a block explorer's own "Write Contract" UI works too, and every call carries
what the form asks for.** Alongside `data`, each call has `function` — the full signature — and
`args`, its arguments by name. Nothing needs decoding: go to `to`, pick the function `function`
names, and type the values from `args`.

```json
{ "function": "approve(address spender, uint256 value)",
  "args": { "spender": "0x040f…34Cf", "value": "25000000" } }
```

🔴 **`args` values are RAW CONTRACT UNITS, and the scale is not the same in every call.** The form
takes them exactly as given — copy them, never round them, and never retype a value from
`description`, which is the human sentence (`25 USDC`) and not what the form wants. In one deposit-
and-exit cycle you will hand over all of these:

| call | field | a real value | scale |
|---|---|---|---|
| `approve` / `deposit` | `value` / `assets` | `25000000` | USDC, 6 decimals |
| `withdraw` | `assets` | `2500000` | USDC, 6 decimals |
| `redeem` | `shares` | `1234567890123456789` | SHARES — see below |

`redeem` is the one that bites, and 🔴 **the share scale is PER-VAULT, not a constant.** The example
above is the default vault at 18 decimals; a share amount there looks nothing like a USDC amount.
Another vault in the same registry uses 8, which is close enough to 6 that a wrong-scale value looks
plausible — so "does this look like a USDC amount?" is not the check. `earn_vaults` reports each
vault's own share decimals; read it for the vault you are actually on, and never carry a scale over
from one vault to another.

**This is also the first form in which the operator can check the destination themselves.** `args`
names `receiver` and `owner` separately, and they are both addresses — a transposition that is
invisible in hex is legible here. Have them read `receiver` back before signing; that is the
destination check, done on something they can actually read.

One gotcha specific to the approve call: **USDC on Base is deployed as a proxy** (`FiatTokenProxy`),
so `approve` does not appear under the plain "Write Contract" tab — it only appears under **"Write
as Proxy"**, which resolves against the implementation contract. The vault contract itself has no
such wrinkle; `deposit`/`redeem` show up on its plain "Write Contract" tab as expected.

**You never run these commands, and holding a shell is not a reason to.** A key reachable from
your shell is a key in this conversation. The operator runs the send in a shell of theirs; you get
back the transaction hash.

Between the `approve` and the `deposit`, have them read the `precondition` the deposit carries
(`cast call <usdc> "allowance(address,address)(uint256)" <account> <vault>` must be at least the
minimum) — the approve's receipt can land on a node ahead of the one that will simulate the deposit.
After each send, take the transaction hash they paste back and continue with `earn_balance`.
Sending from a script, for a key held on a host the operator runs, is the same thing: the ordering,
gas buffer and nonce rules above are identical.

**If the operator asks you to sign or send anyway,** the answer is that the calls are built and
waiting for their signer, what each one does, and the block above. Not "I can't"; "here is how
you do it, and here is why the key stays with you."

## What this skill will not do

- **Hold a key, sign, or send.** If the operator asks you to "just do it", answer with the
  hand-off above: the calls are built, what each one does, and the terminal commands to send them.
  The two that bite: send the `approve` and the `deposit` as separate transactions in that order,
  checking the deposit's own `precondition` in between rather than assuming the approve has
  propagated; and never reuse a nonce across the pair. `docs/runbooks/sign_and_send.md` in the
  Agent Treasury repository covers the rest.
- **Schedule anything.** Recurring or end-of-month withdrawals are the operator's own scheduler
  calling one-shot `earn_prepare_withdraw`; nothing here runs unattended.
- **Deposit into a vault outside `depositable`**, override a `WHITELIST_GATED` or
  `REVERTED_OTHER` verdict, or build for an Enzyme vault. Refusing is the correct output.
- Swap, trade, bridge, or touch the allocator side of a vault. Those are other tools' jobs.

## Reporting

State what was measured and when: the vault's `symbol`, the pre-flight `status`, `measuredAtBlock`,
and — after a transaction — the resulting shares and value. Quote `findings` verbatim when
something stopped you. An operator who can see the block and the exact revert can act; one
who is told "it didn't work" cannot.

**Show the transactions, not just the totals.** `earn_balance`'s `scan.depositTxs` and
`scan.withdrawTxs` carry `{ txHash, blockNumber, amountUsdc }` for the events behind the basis, and
a transaction link is `https://basescan.org/tx/<txHash>`. ⚠️ That is a DIFFERENT path from the
vault's `links.explorer`, which is `https://basescan.org/address/<vault>` — swap the `/address/…`
segment for `/tx/<txHash>`, never append to it, or the result is a URL that resolves to nothing.
With the link the operator can open what actually landed instead of taking your word for it. ⚠️ **Each list holds at most the
100 most recent, while `scan.deposits`/`scan.withdrawals` stay the TOTALS** — when the two disagree
the list is partial, and saying so is the difference between a summary and a misleading one.
