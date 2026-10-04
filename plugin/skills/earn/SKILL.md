---
name: earn
description: Put approved idle USDC to work in supported Tempora-curated vaults on Base or Arbitrum. Inspect vault terms, quote deposits and withdrawals, check position value and currently withdrawable amounts, prepare unsigned transactions for the operator's own signer, and connect the operator's own wallet (a browser wallet, or an email or social login) to confirm them in a browser page. Use for earning yield on idle USDC or managing these vault positions, including withdrawal requests. Not for generating business revenue, paid tasks, swaps, trading, or operating a vault allocator.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" *)
---

# Earn — put idle USDC to work in a Tempora vault

You are the depositor. A Tempora fund is an ERC-4626 vault on Base, Arbitrum One or Robinhood Chain: you put USDC in (USDG on Robinhood Chain), you hold
shares, the shares' USDC value moves with what the vault earns or loses, you redeem when you need
cash. What amount is surplus is the operator's decision, not yours — a balance in the wallet is
not permission to deposit it. The
bundled `treasury` CLI gives you eight `earn` commands that read the vault and **prepare unsigned
calls**, and five `connect` commands that put those calls in front of the operator's own wallet in a
browser page. Run each one with the shell, exactly like this (nothing stays running between commands):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" earn <command> --flag value …
node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" connect <command> --flag value …
```

Run exactly that, one plain command per shell call — no `cd`, no variables, no `&&` or `;` chains. That
form is pre-approved; anything wrapped around it asks the operator for permission instead. When unsure of
a command's flags, run `earn <command> --help` first: the CLI shows only what you ask it for.

Below, each command is named by its tool name: `earn_quote` is `earn quote`, and its arguments are its
flags (`--direction deposit --account 0x… --amount_usdc 25`). `earn --help` lists every command and
flag; a switch such as `--all` takes no value. A command prints one JSON document on stdout. When it
cannot run as asked (an unknown or repeated flag, a vault on another chain, a quote or balance whose
RPC cannot be reached) it exits non-zero with `{ "error": … }` on stderr — report it, never read it as a
result. A verdict is a result and exits 0, with its fields saying what was found: `WHITELIST_GATED`,
or `earn_status` reporting `rpc: "unreachable"` or a pre-flight `UNRESOLVED`. Every prepared call comes back inside
`{ requires_signature: true, status: "unsigned", calls }` — that envelope is the command telling you
nothing has been submitted and no money has moved. No `earn` command can sign or send, and neither can you through it — the operator's own signer
(a wallet, a policy-engine signer, a token-bound account) does that. `connect` does not sign either: it
opens a page where the operator confirms each call in their own wallet. That boundary is the
whole design: a skill that supplies judgement must never hold the gate that supplies money.

## Setup

**Each chain has its own RPC.** The CLI reads Base through `TREASURY_RPC_BASE`, Arbitrum One
through `TREASURY_RPC_ARBITRUM` and Robinhood Chain through `TREASURY_RPC_ROBINHOOD` (and the matching
`TREASURY_LOGS_RPC_*` variable for the event scans `earn_balance` does), from the shell's environment. A chain never reads
another chain's variable. Unset, a chain falls back to its public endpoint (`mainnet.base.org`,
`arb1.arbitrum.io`, `rpc.mainnet.chain.robinhood.com`), which rate-limits after a handful of calls — an `RPC Request failed …
over rate limit` error from any tool means set a keyed RPC URL for that chain, not that the vault
is down. The CLI also accepts `BASE_RPC_URL`, `ARBITRUM_RPC_URL` and `ROBINHOOD_RPC_URL` as fallbacks. A keyed URL is a
secret: command output never repeats it — errors are reported without the endpoint.

`earn_status` with `chain` checks that chain's RPC. 🔴 **`rpc: "wrong_chain"` means the variable for
that chain holds an endpoint for a different one** — say so and stop. The same refusal comes back
from a quote, a pre-flight or a balance (*"the endpoint in … answers for chain N"*): it is a setup
problem to report, naming the variable, and never a verdict about the vault or the position.

`earn_balance` reads history through `eth_getLogs`, starting at the vault's deployment block.
🔴 **Read `scan.wholeHistory`, not `scan.complete`.** `complete` only says shares in − shares out
reconciles, which an empty window does vacuously; `wholeHistory` says the scan actually reached the
deployment block and was not cut short. Only then are `entryBasisUsdc` and `accruedYieldUsdc` numbers —
otherwise they read `unknown`, never a partial sum that renders a missed deposit as yield.

Providers cap the block range per request (Alchemy free tier 10 blocks, Base public RPC 2,000, Infura on Arbitrum 10,000), and
some public endpoints refuse old ranges outright. When the configured RPC cannot cover the range, the
scan moves to the fallback endpoint and `scan.source` says `"fallback"`; you do not need to
retry anything. Set `TREASURY_LOGS_FALLBACK` to another endpoint to choose it, or to `off` — or any value that is not
a URL — to forbid it, for an operator who may not query a third party they did not name. It fails
closed: an unrecognised value turns the fallback off rather than quietly keeping the default. A URL
there names a Base endpoint, so on Arbitrum One and Robinhood Chain a set variable means no fallback at all. On Base the fallback reaches
`max_log_requests` (default 100) × 2,000 blocks, about 4.6 days; each scan also stops at a 30-second
budget. For an older vault, a whole-history basis needs that chain's logs variable
(`TREASURY_LOGS_RPC_BASE`, `TREASURY_LOGS_RPC_ARBITRUM`, `TREASURY_LOGS_RPC_ROBINHOOD`) set to a provider with a wide `eth_getLogs`
range; until then `scan` says exactly how much was covered.

## The tools

| tool | use it to |
|---|---|
| `earn_vaults` | see every vault and the chain it is on, `chains` — where a deposit can go, each with its own default vault — the `default`, and `depositable` — the ones you can put money into today |
| `earn_terms` | show the operator the required disclosures before a first deposit |
| `earn_status` | **with no `account`**: is the CLI healthy and the chain's RPC reachable (chain, latest block, which RPC variable resolved); pass `chain` to check the chain you are about to use. **With `account`**: the access verdict alone. `mode` tells you which you got |
| `earn_quote` | with `direction: "deposit"` — expected shares, share price, and the verdict from a **simulated** deposit. No rate is quoted — the vault exposes none and this client calls no yield API. With `direction: "withdraw"` — shares that would burn, a simulated `withdraw` verdict, the vault's `instantLiquidity`, queue depth. `direction` is required and is echoed back on the result |
| `earn_prepare_deposit` | get the unsigned `approve` + `deposit` calls, enveloped; `--receiver` (required) is where the shares land |
| `earn_prepare_withdraw` | get the unsigned `withdraw` call in terms of the vault's asset — or `--all` with `--shares_exact` to empty the account |
| `earn_balance` | shares (exact), USDC value, entry basis and accrued yield from the vault's own events; `lookback_blocks` / `max_log_requests` set the scan window (see Setup) |
| `earn_claim` | finalize a queued withdrawal; today no vault queues, and it says so |

Everything is USDC in, USDC out — except on Robinhood Chain, where the vault's asset is **USDG** and every
amount is USDG: say USDG to the operator there, even though the argument is still named `amount_usdc`
and the result field `usdcValue`. A vault's own asset is `asset.symbol` in `earn_vaults`. Vault shares exist only inside `earn_balance` (as an exact
string you hand back to `earn_prepare_withdraw` unchanged) — you never compute with them.

Every tool that takes `vault` also takes **`chain`** (`"base"`, `"arbitrum"` or `"robinhood"`). A vault is on one
chain, so naming the vault is enough; naming only the chain selects that chain's default vault; naming
both when they disagree is refused, and the error says which chain the vault is on. Every result that
names a vault carries `chain` and `chainId`.

The address argument is **`account`** on every tool that takes one — whose shares these are.
**Both prepare commands also require `--receiver`**, and it is a different thing: on
`earn_prepare_deposit` it is where the new **shares** land, on `earn_prepare_withdraw` where the
**asset** (USDC, or USDG on Robinhood Chain) lands. They are usually the same address as `account`, and the command will not assume it —
**neither may you.** The receiver comes from the operator's own message, through the destination check
below, before you build either call; never fill it in from `account` on your own.

## Choosing the chain

A deposit goes to ONE chain, and the vault's asset (USDC; USDG on Robinhood Chain) has to be on that chain already — this skill does not
bridge. **Which chain is the operator's decision. Ask; do not pick.**

- **Before preparing a deposit, if the operator has not said which chain, show them `earn_vaults` →
  `chains` and ask.** Each entry is a chain with its default vault; the first is the default chain.
  Put it as a choice they can answer in a word: "Base (default), Arbitrum or Robinhood Chain?"
- **Do not ask again once it is settled.** If they named a chain, named a vault, or said where
  their funds are, that is the answer for the rest of the task.
- **Never ask for a withdrawal, a balance or a quote on an existing position.** A position is on
  the chain its vault is on. Name the vault and the tools use the right chain.
- **If no vault was named and you do not already know which vault holds the position, find out
  before you answer.** A tool called with neither `vault` nor `chain` reads the default chain's
  default vault, and "no position there" says nothing about the others. Call `earn_balance` for each
  listed vault first. If more than one holds shares and the request is to withdraw, ask which position.
- **"The default" with no chain named means the default chain's default vault** — only when the
  operator says to use the default, not as a way to skip the question.
- **An account's positions on different chains are separate.** To report everything an account
  holds, call `earn_balance` once per vault; a zero on one chain says nothing about the other.
- **Say the chain out loud at every money step**: in the quote, when you hand over the calls, and
  when you report the result. The operator's signer must be on that network (below).

## Opening an account and depositing

1. **Settle the chain first (above), then the vault.** If the operator names no vault, use that
   chain's default (`earn_vaults` → `chains[].default`; today Tempora Labs Cash Plus USDC (Test 2B) on
   Base, Tempora Labs Cash Plus USDC (Test 2C) on Arbitrum One and Tempora Labs Cash Plus USDG (Test 2D) on Robinhood Chain, all open to any account; Test 2 on Base is the demo vault, used only when it is named). Every listed vault is a Tempora vault.
   Read that chain's `defaultAccess` (`chains[].defaultAccess`; the top-level one is the default
   chain's): when it is `"whitelist"`, run `earn_status` for the account first, and if
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
   operator is one. Do not paraphrase them into something friendlier. Through `connect`, its
   acknowledgement carries these terms in plain words on every deposit: post that instead, rather than
   asking twice, and show the full `earn_terms` text whenever the operator asks for it.
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
5. **Through `connect`, skip this step:** `connect deposit` builds the same two calls and checks them, and
   opens the signing page only after the operator acknowledges them, every time (see **Handing calls to
   the signer** below). Its acknowledgement carries the disclosures, in plain words, on every deposit, not only the first.
   **Otherwise, `earn_prepare_deposit`, then hand BOTH calls in `calls` to the signer in order, and ask before each.** The
   envelope names `chain` and `chainId`: tell the operator which chain these calls are for before
   anything else, because a call sent on the wrong chain can be mined there and do nothing. The
   amount is in the vault's asset (USDC, or USDG on Robinhood Chain; 6 decimals for both); the tool
   refuses more precision than that. Show the operator
   each call's `description` — that sentence exists to be read by a human before a signature —
   **and its `gasAdvice`**: Morpho V2 calls can run out of gas on an unbuffered estimate even
   when every simulation passes, because accrual work grows with the time between estimate and
   inclusion. Estimate × 1.5. **And its `precondition`, where present**: the `deposit` call names
   the read (`allowance(owner, spender) >= minimum`, raw units) that must hold on the RPC the
   signer sends through before it is estimated or sent. The `approve` receipt can come from a
   node ahead of the one simulating the `deposit` — measured on both real round trips — so a
   signer that reads the precondition until it holds is deterministic and one that retries on
   an error string is not. **Then follow the envelope's `signer_rules`**, which every prepared
   build carries: send on the chain the call's `chainId` names and no other, confirm each destination against the operator's own addresses, set the nonce
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
keyed RPC for the vault's chain (`TREASURY_RPC_BASE`, `TREASURY_RPC_ARBITRUM`, `TREASURY_RPC_ROBINHOOD`) is what makes both available in one call.

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
- **Withdraw in the vault's asset** (USDC; USDG on Robinhood Chain). `earn_quote` with `direction: "withdraw"`, then `connect withdraw` (same flags,
  receiver = the connected account) or `earn_prepare_withdraw` with `amount_usdc` and the `account` whose shares burn; the vault burns
  whatever shares that costs at inclusion. To empty the account, pass `--all` and
  `--shares_exact` copied **verbatim** from `earn_balance.sharesExact` — never a number you rounded
  or computed: an 18-decimal balance exceeds 2⁵³, floats round it (sometimes up), and redeeming
  more than is owned reverts.
- **A withdrawal can be refused for liquidity, not balance.** Some vaults (Fusion) pay a withdrawal
  only from what they hold un-deployed in that block; the rest of the account's value is in markets
  and comes back when the fund unwinds. The withdraw quote reports `instantLiquidity` and, on a
  Fusion refusal, says so in those terms. Withdraw at most that amount now, or wait. A Morpho V2
  vault holds almost no idle USDC and pays out of its markets, so there the quote shows the chain's
  own revert reason instead, and a smaller amount may still pass: quote it. Either way, do **not** read a
  refusal as "approve first" (that is a deposit failure) and do not trust `maxWithdraw`, which
  reports the full position on exactly these vaults.
- One call, one signature, same rules as depositing: show the description and `gasAdvice`, run
  the destination check below on `receiver`, hand it over.

## Handing calls to the signer

**First choice: the operator's own wallet, through `connect`.** It needs a browser on this machine: the
page is served on `localhost` only, so a phone or another computer cannot open it.
`connect wallet`, and `connect deposit` / `connect withdraw` run with `--ack`, each wait up to 9 minutes
for the operator, so give each of those shell calls a timeout of at least 9 minutes. The form is the same as `earn`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" connect deposit --vault <symbol> --amount_usdc 25 --receiver 0x…
```

1. `connect status`. If disconnected, `connect wallet` opens a page; the operator clicks Connect and uses
   a browser wallet, or an email, Google, Apple or X login (a Privy wallet). Wait for it to return.
2. Run the earn quote as usual, then `connect deposit --amount_usdc <n> --receiver <addr>` (or
   `connect withdraw …`), with the same `--vault`/`--chain`. 🔴 **This first run opens nothing.** It
   returns `status: "needs_acknowledgement"` with `acknowledgement` (one fixed text naming the amount,
   chain, vault and its explorer link, the receiver, the vault's warning and the disclosures) and an
   `ack` code. **Post `acknowledgement` to the operator word for word and wait for their answer.** Do
   not summarise it, shorten it, or skip it because they acknowledged an earlier one or said "go"
   before they saw it: every page open has its own.
3. **Only on the operator's explicit yes to that text**, run the same command again with `--ack <code>`
   added. The page opens; the operator confirms each call there and in the wallet; the command returns
   when they finish. Any answer but yes: stop. A refused `--ack` (expired after 15 minutes, already used,
   or the amount, vault, chain or receiver changed) means go back to step 2 for a new acknowledgement,
   never retry the code.
4. Read `status` first. `completed`: every call landed. `stopped`: it ended early; read `reason` and the last transaction's `detail`.
   `not_reported`: no transaction came back, which is not proof none was sent, so check `earn balance`
   before any retry. Report every `hash` and its `verified`. `extra_transfer` means the wallet also moved money besides
   the call (`alsoMoved`, often its own gas fee in USDC): say so. Anything else that is not `matched`:
   stop, check `earn balance`, tell the operator.

`--receiver` must be the connected account (`connect status`), and it still comes from the operator,
not from you: the page pays only that account. For any other receiver, use the prepare commands below
with the operator's own signer.

**No browser here** (an SSH session, a container, a machine with no display): skip `connect` and use the
prepare commands. The first, acknowledgement run of `connect deposit` / `connect withdraw` always says
`opened: false`: it opens nothing by design. On `connect wallet`, or the run with `--ack`, `opened: false`
means no browser opened: the command printed the page's address on stderr, but it returns only after
the page has closed, so the address reaches you too late to pass on. Use the prepare commands instead.

Every prepared call names a destination: `to`, and the receiver or owner in its `description`. A
wrong destination is the one mistake nothing downstream can undo — the transaction succeeds, the
receipt says so, and the money is somewhere nobody holds a key for. Measured, once, for real: a
withdrawal sent to an address taken from a config file instead of the operator's message — the
funds gone, and the receipt read "success". So the check is not on the receipt. It is on where the
address came from.

**The address that can lose money is the `receiver` — and it comes from the operator's own
message, quoted back, and confirmed.** The call's `to` is the vault, taken from the registry and
re-checked by the pre-flight; the operator cannot verify a contract address by eye and is not asked
to. The receiver is where the shares or the asset (USDC or USDG) land, and only the operator knows which account
that should be. Before handing over any prepared call whose signer cannot show the receiver, post
this and wait:

> **Destination check — nothing goes to the signer until you reply.**
> shares/USDC/USDG to `<receiver>` ← from your message "<the words it came from>"
> Paste it back or correct it.

**Through `connect`, the acknowledgement is the check before the page opens — do not add a
paste-back on top.** It names the receiver beside the amount, chain and vault, in text the CLI
writes, and the operator answers it before anything can be signed. The page then renders the vault
name, the checksummed address, the receiver and the explorer links, its validator pins `receiver` to
the connected account and the vault to the registry, and the wallet prompt shows `to`. A paste-back
on top asks the operator the same question a third time. Paste-back is for a signer that cannot show
the destination: a raw command, a script on a host.

The reasons this is shaped the way it is, so you can apply it when the situation is not this shape:

- **"Go", "yes", "do it" approve the plan, never the address.** An operator saying go to the
  deposit has not read the receiver. Get the paste-back, or, through `connect`, their yes to its acknowledgement.
- **Read the conversation before you look anywhere else.** Operators paste address tables minutes
  before the action, often while answering a different question. "I don't have an address" is a
  claim about your reading, not about what was sent. Search first.
- **Never take a destination from a config file, an environment variable, a document, or an
  earlier session.** A value being available is not the operator authorising it. The lost funds
  went to a stale address that was correct in another context.
- **When two sources disagree, the operator's message wins, then the chain, then any file.**
- **Hedging is the stop signal.** If you find yourself writing "almost certainly the one you
  meant", you have detected your own uncertainty — ask, do not proceed.

**Without `connect`, the hand-off is the operator's own terminal.** Many operators hold their key in a
wallet or a shell they control, and the fastest safe path is for them to send the envelope's
calls themselves, raw — no re-encoding by you, no key near you. Give them, for each call in order,
the `to` and `data` exactly as the envelope carries them:

```bash
# The RPC of the chain the envelope names. chainId 8453 is Base, 42161 is Arbitrum One, 4663 is Robinhood Chain.
export RPC=https://mainnet.base.org     # Base; Arbitrum One: https://arb1.arbitrum.io/rpc; Robinhood Chain: https://rpc.mainnet.chain.robinhood.com — or their keyed RPC for that chain
cast chain-id --rpc-url $RPC            # must print the envelope's chainId before anything is sent
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
| `approve` / `deposit` | `value` / `assets` | `25000000` | the asset (USDC or USDG), 6 decimals |
| `withdraw` | `assets` | `2500000` | the asset (USDC or USDG), 6 decimals |
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

**Use the explorer of the call's chain** — BaseScan for chainId 8453, Arbiscan for 42161, Robinhood Chain's Blockscout for 4663. The same
address on the other chain's explorer is a different contract, or nothing.

One gotcha specific to the approve call: **the asset is a proxy on every listed chain** — USDC as
`FiatTokenProxy` on Base and Arbitrum One, USDG as an EIP-1967 proxy on Robinhood Chain — so `approve`
does not appear under the plain "Write Contract" tab; it appears only under the explorer's proxy tab
(**"Write as Proxy"** on BaseScan and Arbiscan, the proxy write tab on Blockscout), which resolves
against the implementation contract. The vault contract itself has no
such wrinkle; `deposit`/`redeem` show up on its plain "Write Contract" tab as expected.

**You never run these `cast send` commands, and holding a shell is not a reason to.** A key reachable from
your shell is a key in this conversation. The operator runs the send in a shell of theirs; you get
back the transaction hash.

Between the `approve` and the `deposit`, have them read the `precondition` the deposit carries
(`cast call <asset> "allowance(address,address)(uint256)" <account> <vault>` must be at least the
minimum) — the approve's receipt can land on a node ahead of the one that will simulate the deposit.
After each send, take the transaction hash they paste back and continue with `earn_balance`.
Sending from a script, for a key held on a host the operator runs, is the same thing: the ordering,
gas buffer and nonce rules above are identical.

**If the operator asks you to sign or send anyway,** the answer is `connect`, where they confirm each
call in their own wallet, when there is a browser here; otherwise that the calls are built and
waiting for their signer, what each one does, and the block above. Not "I can't"; "here is how
you do it, and here is why the key stays with you."

## What this skill will not do

- **Hold a key, sign, or send.** If the operator asks you to "just do it", answer with the
  hand-off above: `connect` when there is a browser here; otherwise the calls are built, what each one
  does, and the terminal commands to send them.
  The two that bite: send the `approve` and the `deposit` as separate transactions in that order,
  checking the deposit's own `precondition` in between rather than assuming the approve has
  propagated; and never reuse a nonce across the pair. `docs/runbooks/sign_and_send.md` in the
  Agent Treasury repository covers the rest.
- **Schedule anything.** Recurring or end-of-month withdrawals are the operator's own scheduler
  calling one-shot `earn_prepare_withdraw`; nothing here runs unattended.
- **Deposit into a vault outside `depositable`**, override a `WHITELIST_GATED` or
  `REVERTED_OTHER` verdict, or build for an Enzyme vault. Refusing is the correct output.
- Swap, trade, bridge, or touch the allocator side of a vault. Those are other tools' jobs. Funds on
  one chain cannot be deposited into a vault on another: the operator moves them first, by their own means.
- **Pick the chain for the operator**, or deposit on a chain other than the one they chose because
  its vault looks better. Asking is the correct output.

## Reporting

State what was measured and when: the vault's `symbol` and its `chain`, the pre-flight `status`, `measuredAtBlock`,
and — after a transaction — the resulting shares and value. Quote `findings` verbatim when
something stopped you. An operator who can see the block and the exact revert can act; one
who is told "it didn't work" cannot.

**Show the transactions, not just the totals.** `earn_balance`'s `scan.depositTxs` and
`scan.withdrawTxs` carry `{ txHash, blockNumber, amountUsdc }` for the events behind the basis, and
a transaction link is `https://basescan.org/tx/<txHash>` on Base and `https://arbiscan.io/tx/<txHash>`
on Arbitrum One and `https://robinhoodchain.blockscout.com/tx/<txHash>` on Robinhood Chain. ⚠️ That is a DIFFERENT path from the
vault's `links.explorer`, which is `https://basescan.org/address/<vault>` (or the Arbiscan or Blockscout equivalent) — swap the `/address/…`
segment for `/tx/<txHash>`, never append to it, or the result is a URL that resolves to nothing.
With the link the operator can open what actually landed instead of taking your word for it. ⚠️ **Each list holds at most the
100 most recent, while `scan.deposits`/`scan.withdrawals` stay the TOTALS** — when the two disagree
the list is partial, and saying so is the difference between a summary and a misleading one.
