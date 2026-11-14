---
name: earn
description: Put approved idle USDC, or USDG on Robinhood Chain, to work in supported vaults curated by Tempora Labs on Base, Arbitrum, Robinhood Chain, Ethereum, Monad or Solana. Inspect vault terms, quote deposits and withdrawals, check position value and currently withdrawable amounts, prepare unsigned transactions for the operator's own signer, and connect the operator's own wallet (a browser wallet, or an email or social login) to confirm them in a browser page. Use for earning yield on idle USDC or USDG, managing these vault positions, including withdrawal requests, or when asked what Treasury or these vaults can do. Not for bridging, swaps, trading, staking, vaults from other providers, analysing what a vault itself holds or why its share price moved, operating a vault allocator, generating business revenue, or paid tasks.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" *)
---

# Earn — put idle USDC to work in a Tempora Labs vault

You are the depositor. A Tempora Labs fund is an ERC-4626 vault on Base, Arbitrum One, Robinhood Chain, Ethereum or Monad, or a Kamino vault on Solana: you put USDC in (USDG on Robinhood Chain), you hold
shares, the shares' USDC value moves with what the vault earns or loses, you redeem when you need
cash. What amount is surplus is the operator's decision, not yours — a balance in the wallet is
not permission to deposit it. **How much to deposit or withdraw is the operator's decision. Ask; do
not pick.** Not a small test amount, not a round number, not the wallet's balance: if the operator has
not named an amount, ask for one before you quote. The
bundled `treasury` CLI gives you nine `earn` commands that read the vault and **prepare unsigned
steps**, and six `connect` commands that put those steps in front of the operator's own wallet in a
browser page. On the EVM chains both go through the Tempora API: it lists the vaults and prepares each
deposit or withdrawal as a **request** of numbered steps, and treasury checks every step against what the
operator asked for before it shows one to sign. On Solana they read the chain directly. Run each one with
the shell, exactly like this (nothing stays running between commands):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" earn <command> --flag value …
node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" connect <command> --flag value …
```

Run exactly that, one plain command per shell call — no `cd`, no variables, no `&&` or `;` chains. That
form is pre-approved; anything wrapped around it asks the operator for permission instead. When unsure of
a command's flags, run `earn <command> --help` first: the CLI shows only what you ask it for.

Below, each command is named by its tool name: `earn_quote` is `earn quote`, and its arguments are its flags
(`--direction deposit --amount_usdc <amount>`; every amount in this file is a placeholder for the operator's own).
`earn --help` lists every command and flag; a switch such as `--all` takes no value. A command prints one JSON
document on stdout. When it cannot run as asked (an unknown or repeated flag, a vault on another chain, an account
that is not the connected wallet, a refusal from the Tempora API, or an API or RPC that cannot be reached) it exits
non-zero with `{ "error": … }` on stderr — report it, never read it as a result. A verdict is a result and exits 0,
with its fields saying what was found: a deposit `check.state` of `not_admitted`, `earn_status` reporting
`apiStatus: "unreachable"`, or on Solana a pre-flight `UNRESOLVED`. Every prepared deposit or withdrawal comes back
inside `{ requires_signature: true, status: "unsigned", steps }` (on Solana, one `transaction` in place of `steps`) —
that envelope is the command telling you nothing has been sent and no money has moved. No `earn` command can sign or
send, and neither can you through it — the operator's own signer (a wallet, a policy-engine signer, a token-bound
account) does that. `connect` does not sign either: it opens a page where the operator confirms each step in their own
wallet. That boundary is the whole design: a skill that supplies judgement must never hold the gate that supplies money.

## When the operator asks what this can do

Answer in at most five lines, then ask what they want to do. Name the chains from `earn_vaults`, never from memory. Say that they
can quote, deposit, check what a position is worth and can be withdrawn for now, and withdraw, in one vault or several in one request
(below); that money moves only from their own wallet, after their yes there, and that you never sign, bridge or swap; and that there
are two ways in: through you, or in a browser at `https://app.temporalabs.com`. Quote no yield; this client reads none.

## Setup

**The EVM chains need no RPC setup.** On Base, Arbitrum One, Robinhood Chain, Ethereum and Monad, `earn` and
`connect` read nothing from the chain themselves: every vault list, quote, balance and request goes to the Tempora
API (`https://api.temporalabs.com`; `TREASURY_API_URL` points at another deployment, https only unless it is on this
machine). The API reads the chain and prepares each step; treasury holds no vault or asset address for these chains
and checks each step against the API's own record of the vault, so it catches a wrong step, not a wrong record.
`earn_status` with no `account` is the health check: `apiStatus` is `ok`, or `unreachable` with a `reason`. An
unreachable API is a fault to report, never a verdict about the vault or the position.

🔴 **On an EVM chain the owner commands act for the CONNECTED wallet, and for no other.** `earn_status` with
`account`, `earn_quote`, `earn_balance`, both prepare commands, `earn_submit` and `earn_request` answer only for the
wallet `treasury connect wallet` connected (`connect status` names it). Run `connect wallet` first; `--account` may
then be left out, and any other account is refused. When the API needs a sign-in, the command opens a local page where
the operator's wallet signs a free message (no gas, nothing moves) and waits for it, so give an owner command a shell
timeout of at least 9 minutes. One sign-in serves `earn` and `invest`. Both pages need a browser on this machine.

**Solana still reads its own chain**, through `TREASURY_RPC_SOLANA` (or `SOLANA_RPC_URL`) from the shell's
environment. Unset, it falls back to the public `api.mainnet-beta.solana.com`, which rate-limits after a handful of
calls — an `RPC Request failed … over rate limit` error on a Solana vault means set a keyed RPC URL, not that the vault
is down. A keyed URL is a secret: command output never repeats it. `earn_status --chain solana` checks it. 🔴
**`rpc: "wrong_chain"` means that variable holds an endpoint that is not Solana mainnet** — say so and stop: it is a
setup problem to report, naming the variable, and never a verdict about the vault or the position.

## The tools

| tool | use it to |
|---|---|
| `earn_vaults` | see every vault and the chain it is on, `chains` — where a deposit can go, each with its own default vault — the `default`, and `depositable` — the ones you can put money into today |
| `earn_terms` | show the operator the vault's terms (`terms.text`, `version`, `sha256`) and the required disclosures before a first deposit |
| `earn_status` | **with no `account`**: is the CLI healthy and the Tempora API reachable (`apiStatus`), and which vault the call resolves to; on Solana, the Solana RPC instead. **With `account`** (the connected wallet): its `standing`, the vault's `gates`, the wallet's balance and allowance, and with `amount_usdc` whether the vault would take that deposit. `mode` tells you which you got |
| `earn_quote` | with `direction: "deposit"` — expected shares, share price, and the API's check of that deposit (`check.state`). No rate is quoted — this client reads none. With `direction: "withdraw"` — the position and how much of it can be withdrawn now (`withdrawable`). `direction` is required and is echoed back on the result |
| `earn_prepare_deposit` | start a deposit and get its unsigned, checked steps (`approve`, then `deposit`), enveloped (on Solana, one transaction); on an EVM chain `--terms_sha256` from `earn_terms` is required and the shares go to the connected wallet; `--receiver` is for Solana only |
| `earn_prepare_withdraw` | start a withdrawal and get its unsigned, checked step: one of `--amount_usdc`, `--all` or `--shares_exact` on an EVM chain; on Solana `--all` goes with `--shares_exact` |
| `earn_balance` | shares (exact), value, and what can be withdrawn now; on an EVM chain read from the Tempora API for the connected wallet, with entry basis and yield not available |
| `earn_submit` | hand the transaction hash of a step the connected wallet sent to the Tempora API; never send a step again because of a refusal |
| `earn_request` | read a request again by `--request_id` or `--tx_hash`, with any step now ready, checked; `--cancel` one still waiting |

Everything is USDC in, USDC out — except on Robinhood Chain, where the vault's asset is **USDG** and every
amount is USDG: say USDG to the operator there, even though the argument is still named `amount_usdc`. The
vault's `name` in `earn_vaults` says which asset it takes, and `assetDecimals` its decimals. Vault shares exist only
inside `earn_balance` (`sharesExact`, an exact string you hand back to `earn_prepare_withdraw` unchanged) — you never
compute with them.

**`vault` is the vault as `earn_vaults` lists it**: on an EVM chain its contract address (`vault`, `0x…`) or its
`ticker` (such as `tlCashPlusUSDC2B`), on Solana its ticker. Results name a vault by `vault` (the contract address),
`ticker` (`null` when it has none) and `name`. Every tool that takes `vault` also takes **`chain`**
(`"base"`, `"arbitrum"`, `"robinhood"`, `"ethereum"`, `"monad"` or `"solana"`). A vault is on one chain, so naming
the vault is enough; naming only the chain selects that chain's default vault; naming both when they disagree is
refused, and the error says which chain the vault is on. Every result that names a vault carries `chain` and `chainId`.

The address argument is **`account`** — whose shares these are. On an EVM chain it is always the connected wallet,
and the money lands there too: a deposit's shares and a withdrawal's asset go to the connected wallet, and the
prepare commands refuse a `--receiver`. On Solana, `account` is required on every owner command and `--receiver`, when
given, must be that same account (below). Either way, the address money lands at comes from the operator — their own
message, or the wallet they connected themselves — never from you: see the destination check below.

## Choosing the chain

A deposit goes to ONE chain, and the vault's asset (USDC; USDG on Robinhood Chain) has to be on that chain already — this skill does not
bridge. An operator can still put money into several vaults, on one chain or several, in one request: one deposit per vault (below). **Which chain is the operator's decision. Ask; do not pick.**

- **Before preparing a deposit, if the operator has not said which chain, show them `earn_vaults` →
  `chains` and ask.** Each entry is a chain with its default vault; the first is the default chain.
  Put it as a choice they can answer in a word: "Base (default), Arbitrum, Robinhood Chain, Ethereum, Monad or Solana?"
- **Ethereum gas is far higher than on the other chains.** When the operator picks Ethereum for a small amount, say so
  before preparing anything: the approve and the deposit, and later the withdrawal, each pay Ethereum gas in ETH, which
  can be a large share of a small deposit. Offer another chain; the choice stays theirs.
- **Do not ask again once it is settled.** If they named a chain, named a vault, or said where
  their funds are, that is the answer for the rest of the task.
- **Never ask for a withdrawal, a balance or a quote on an existing position.** A position is on
  the chain its vault is on. Name the vault and the tools use the right chain.
- **If no vault was named and you do not already know which vault holds the position, find out
  before you answer.** A tool called with neither `vault` nor `chain` reads the default chain's
  default vault, and "no position there" says nothing about the others. Call `earn_balance` for each
  listed vault first. If more than one holds shares and the request does not say which, ask which position, or whether all of them (below).
- **"The default" with no chain named means the default chain's default vault** — only when the
  operator says to use the default, not as a way to skip the question.
- **An account's positions on different chains are separate.** To report everything an account
  holds, call `earn_balance` once per vault; a zero on one chain says nothing about the other.
- **Say the chain out loud at every money step**: in the quote, when you hand over the steps, and
  when you report the result. The operator's signer must be on that network (below).

### Several vaults in one request

An operator can move money in several vaults in one sitting — "1 USDC on Base and 3 on Solana", "2 USDC on every chain",
"withdraw 1 from 2B and deposit 1 into 2C". Vaults may be on different chains or one, and deposits and withdrawals may
mix. Each vault is one **leg** with its own transactions; nothing moves money in several vaults at once.

1. **Settle the legs from the operator's own words:** each leg's action, vault, chain and amount. A chain named without a
   vault means its default vault. "Every chain" means every entry in `earn_vaults` → `chains`, each with its default
   vault; "every vault" means every vault in `depositable` (a listed vault outside it cannot take a deposit: name it,
   do not drop it silently). "Withdraw everything" means every vault whose `earn_balance` holds shares, each withdrawn in
   full. Do not add, drop or resize a leg on your own.
2. **Check every leg before any money moves:** `earn_quote` with the leg's direction and amount, for the real account.
   The asset has to be on that vault's chain already (USDG, not USDC, on Robinhood Chain); this skill does not bridge.
   Two deposits on one chain draw on one balance: check it covers both. On Solana the account also needs SOL, and on
   Ethereum gas can be a large share of a small amount: say so for that leg. A vault that cannot pay its withdrawal now
   (liquidity) is a leg that cannot go ahead as asked: say so, and do not shrink it on your own.
3. **Through `connect`, one acknowledgement covers the whole request: `connect plan`.** Pass the legs in order,
   `--legs "deposit <vault> <amount>; withdraw <vault> <amount|all>"`: each vault by its address or ticker from `earn_vaults`, at most
   8 legs. `all` on an EVM chain is the whole position as it stands when the leg runs (no balance is read when the plan
   is made); on Solana it binds the share balance read at that moment. Like `connect deposit`, the first run opens
   nothing and returns one `acknowledgement` listing every leg, its receiver and the warnings: post it word for word and
   wait. Only on the operator's explicit yes, run it again with the same `--legs` and `--ack <code>`: that records the
   yes, opens nothing, and returns each leg's `command`. Full `earn_terms` still come first, before the operator's first
   deposit. A plan with legs on EVM chains and on Solana needs both wallets connected.
4. **Then run the plan on one signing page: `connect plan --run`**, each shell call with a timeout of at least 9
   minutes. It returns `in_progress` near that limit: run it again at once, and the operator's open page carries on.
   Solana legs run on the same page; on a plan that also has EVM legs, the operator's wallet may ask once, at Start, to
   connect its Solana account, and a wallet without one (Rabby) ends the plan there with nothing sent. **The yes covers every leg:
   do not ask again between them.** Report each leg as in **Handing steps to the signer**, step 4.
5. **Stop at the first leg that does not complete**; the CLI refuses the rest. Report every leg (vault, chain, amount,
   transactions, and which did not run; `connect plan --status` lists them). What is left needs a new plan and a new yes.

**Without `connect`, the plan is yours to show:** one table, a row per leg with the total, and a yes to it; then one
complete deposit or withdrawal per vault through the prepare commands, one at a time, each with its own destination check
(to withdraw everything, `--all` on an EVM chain; on Solana `--all` with that vault's own `sharesExact`). **"What do I
hold?"** is `earn_balance` on every vault `earn_vaults` lists (the EVM and the Solana account each), as one table: per
vault, its chain, what it is worth and what it can be withdrawn for now, with the totals.

## Solana is different

The vault on Solana (`chain: "solana"`) is a Kamino vault, not an ERC-4626 one, and treasury reads it from the chain
itself, not through the Tempora API. The same commands work on it, with these differences — say them to the operator
where they apply:

- **Addresses are Solana addresses** (base58, no `0x`). An EVM address for a vault on Solana is refused, and the other
  way round. The operator's Solana address comes from their own message, through the destination check, like any other.
- **`--account` is required, and `--receiver` must be the account itself.** The vault mints shares to the depositing
  account and pays a withdrawal to the account whose shares burn; there is no other receiver, and anything else is refused.
- **One transaction, and it expires.** `earn prepare_deposit` / `prepare_withdraw` return ONE unsigned
  transaction (`transaction.wire`, base64), simulated before it is returned, that lands only before
  `transaction.expiresAfterBlockHeight` — about a minute. Prepare it only when the operator is ready to sign,
  and if the height has passed, prepare it again; never hand over an expired one. Through `connect`, the page
  builds it when the operator presses Confirm, so this does not arise there. There is no request: `earn_submit`
  and `earn_request` are for the EVM chains.
- **The account needs SOL**, for the fee and, on a first deposit, about 0.002 SOL of rent for its share
  account. `earn status --chain solana --account …` says `NEEDS_FUNDS` when it lacks USDC or SOL.
- **Each withdraw instruction keeps up to 0.001 USDC in the vault** — Kamino's charge for every vault on its
  program, which Kamino can change; a withdrawal split across reserves pays it per part — and one worth 0.001
  USDC or less is refused. Quotes report `receives`, exact and net of it; say so before a small withdrawal.
- **The balance has its own fields:** `earn_balance` reports shares, `usdcValue` and what a full exit would pay now
  (`exit.exitableNow`), and `entryBasisUsdc` and `accruedYieldUsdc` read `unknown`. Do not present the value as profit.
- **`connect wallet --chain solana`** connects a Solana wallet (Phantom, Solflare, Backpack, or a Privy wallet
  from an email or social login), separately from the EVM connection; `connect deposit` / `withdraw` with
  `--chain solana` then use it, with the same acknowledgement step.

## Opening an account and depositing

1. **Settle the chain first (above), then the vault, then the amount — the operator's, asked for if
   they have not given one, never one you choose.** If the operator names no vault, use that
   chain's default (`earn_vaults` → `chains[].default`; today `tlCashPlusUSDC2B` on Base, `tlCashPlusUSDC2C` on
   Arbitrum One, `tlCashPlusUSDG2D` on Robinhood Chain, `tlCashPlusUSDC2E` on Ethereum, `tlCashPlusUSDC2F` on Monad,
   and Tempora Labs Cash Plus USDC (Test 2G), `tlCashPlusUSDC2G`, on Solana). A chain's `default` is `null` when the API does not list that vault now: say so, and do not substitute
   another. Every listed vault is a Tempora Labs vault. On an EVM chain, connect the wallet first (Setup), then run
   `earn_status` with the account: `gates` gives each gate's `status` and the vault's own `reason` — quote the reason
   verbatim. **If the account is not admitted, tell the operator that admission is a fund-side action — do not offer a
   substitute and do not retry.** A listed vault that is not the default may be gated even when the default is open.
2. **`depositable` may be EMPTY, and an empty set is an answer, not an error.** It is the set of
   vaults taking deposits now: on an EVM chain those the API lists with `status: "live"` (`paused` takes withdrawals
   only), on Solana the Kamino vault when it is open. Report an empty set as the state it is, not a fault to work
   around, and read it from `earn_vaults` rather than assuming either way. Never propose a vault `earn_vaults` does
   not list: this client deposits only where the Tempora API (or, on Solana, its registry) says, and reaching
   anywhere else is outside what it will build.
3. **On a first deposit, present `earn_terms` and get an explicit acknowledgement.** The
   fund requires this on every distribution surface, and an agent talking to its
   operator is one. Show `terms.text` in full, with `disclosures`; do not paraphrase them into something friendlier.
   The text is checked against its `sha256` before you see it. A deposit is made against that exact `terms.version`
   and `terms.sha256`: pass the `sha256` the operator accepted to `earn_prepare_deposit --terms_sha256`. Terms that
   changed since are refused — show the new ones and get a new acceptance, never retry with the new hash on your own.
   This holds through `connect` too: post the full `earn_terms` once, before the operator's first deposit. The
   acknowledgement `connect` returns names the terms version and sha256 and restates the disclosures in plain words
   before every signing page; it comes after the full terms on a first deposit, never instead of them. Show the full
   text again whenever the operator asks.
4. **Always `earn_quote` with `direction: "deposit"` and the operator's amount, for the real account.** On an EVM
   chain read `check.state`, with its `reason`:
   - `open` → the vault would take it. Proceed.
   - `holdings` → the wallet does not hold enough of the asset. Show the reason, and quote again once the operator
     has funded it.
   - `not_admitted` → stop. The operator needs admission (a fund-side action), not a retry.
   - `refused` → stop and show the `reason` verbatim. Do not guess a cause.
   - `unsupported` / `unknown` → stop; the deposit could not be checked. Neither is a verdict about the vault.

   On Solana read `preflight.status`: `OPEN_READY` → proceed; `NEEDS_FUNDS` → the account lacks USDC, or SOL for the
   fee: show the `findings` and quote again once funded; `REVERTED_OTHER` → stop and show the `findings`;
   `UNRESOLVED` → stop, a transport failure, not a verdict.
5. **Through `connect`, skip this step:** `connect deposit` starts the same request (on Solana, builds the one
   transaction), checks it, and opens the signing page only after the operator acknowledges it, every time (see
   **Handing steps to the signer** below); each hash goes to the API for you. **Otherwise, `earn_prepare_deposit` with
   `--terms_sha256`, then the request's steps, one at a time:**
   1. The envelope names `chain` and `chainId`: tell the operator which chain these steps are for before anything
      else, because a transaction sent on the wrong chain can be mined there and do nothing. It also names the
      `requestId` and each step's `stepId` and `state`. The amount is in the vault's asset (USDC, or USDG on Robinhood
      Chain; 6 decimals for both); the tool refuses more precision than that.
   2. Show the operator the `ready` step's `description` — that sentence is read from the step's own calldata and
      exists to be read by a human before a signature — and have them send it from the connected wallet.
   3. Run `earn_submit --request_id <id> --step_id <step> --tx_hash <hash>` with the hash the wallet returned (add
      `--nonce` and `--from` together, and `--block`, when the wallet reported them). The API reads the chain at that
      hash and answers with the request.
   4. The deposit step waits until the approval is submitted. Run `earn_request --request_id <id>` until it is
      `ready`, then send it and `earn_submit` its hash the same way. Follow the envelope's `next_step`, which says this
      for the request in hand.

   🔴 **Never send a step again because of a refusal.** A refused `earn_submit` names its code; the transaction may
   well have landed. Read the request with `earn_request` (by `--request_id`, or `--tx_hash`) and report what it
   says. A request nothing was sent for can be cancelled with `earn_request --request_id <id> --cancel`. **Then
   follow the envelope's `signer_rules`**, which every prepared request carries: send on the chain `chainId` names and
   no other; only a `ready` step, one at a time, in order, from the connected wallet; the nonce from the `pending`
   count before each send; wait for each receipt; and after any failure that is not an on-chain revert, read the nonce
   on a different provider — a nonce that moved means the transaction was accepted, so submit the hash you have, never
   re-send. The hand-off itself is the section **Handing steps to the signer** below; do not skip it for a small amount.
6. **After it lands, `earn_balance`** and report value and what can be withdrawn now. Until the steps confirm, the
   deposit has NOT happened — `requires_signature: true` is the tool saying so, and "prepared" is not "deposited".
   Entry basis and yield are not available (`basis` and `yield` say so): never present the value as profit.

## Checking and withdrawing

🔴 **`value` is what the position is WORTH; `withdrawable` is what it can be WITHDRAWN for now.** Report both, and
never quote the first as if a depositor could have it. Some vaults pay a withdrawal only from what they hold
un-deployed in that block, so the two can differ by 10× — measured on a live test vault: a position worth 14.999970
USDC could withdraw only about 1.5 USDC at that block. `withdrawable` is found by simulating withdrawals at
`withdrawable.block`; `basis: "floor"` means it is a lower bound.

- On an EVM chain `earn_balance` answers for the connected wallet: `shares` (raw, with `decimals`), `sharesExact` (the
  same number as a decimal string, never rounded), `value` (`usd`, `state`, `asOf`), `withdrawable`
  (`withdrawable.withdrawable.state`: `all`, `partial`, `refused` or `unknown`, with `assets` and `reason`) and `stage`.
  🔴 **`unknown` is never 0.** A `stage` of `unknown` means the share balance could not be read, and `shares` says
  `unknown`; a `withdrawable` state of `unknown` means it was not measured, not that the vault refused. Say so rather
  than reporting an empty position or a limit nobody measured. `position: "none"` means the API lists no position for
  this wallet in this vault. Value is a value, not a promise: redemption is subject to the vault's caps and liquidity.
- On Solana the fields are `usdcValue` and `exit.exitableNow`, and `measuredAs: "not measured"` means the RPC failed,
  not that the vault refused.
- **Withdraw in the vault's asset** (USDC; USDG on Robinhood Chain). `earn_quote` with `direction: "withdraw"`, then
  `connect withdraw` (same flags, receiver = the connected account) or `earn_prepare_withdraw` with exactly one of
  `--amount_usdc` (the vault burns whatever shares that costs at inclusion), `--all` or `--shares_exact`. On an EVM
  chain `--all` alone redeems every share as it stands when the withdrawal runs; `--shares_exact` redeems exactly that
  many, copied **verbatim** from `earn_balance.sharesExact` — never a number you rounded or computed: an 18-decimal
  balance exceeds 2⁵³, floats round it (sometimes up), and redeeming more than is owned reverts. On Solana, to empty
  the account, pass `--all` with `--shares_exact`.
- **A withdrawal can be refused for liquidity, not balance.** The withdraw quote's `withdrawable` says whether `all`,
  `partial` (`assets` is what comes out now) or none of the position can be withdrawn, with the vault's own `reason`.
  Tell the operator at most that amount comes out now, and ask whether to withdraw that, another amount, or wait; do
  not shrink the withdrawal yourself, and quote only an amount the operator names. Do **not** read a refusal as
  "approve first" — that is a deposit failure.
- One step, one signature, same rules as depositing: show the `description`, send it from the connected wallet,
  `earn_submit` its hash, and never re-send because of a refusal. On Solana, run the destination check below on
  `receiver` first.

## Handing steps to the signer

**First choice: the operator's own wallet, through `connect`.** It needs a browser on this machine: the
page is served on `localhost` only, so a phone or another computer cannot open it.
`connect wallet`, and `connect deposit` / `connect withdraw` run with `--ack`, each wait up to 9 minutes
for the operator, so give each of those shell calls a timeout of at least 9 minutes. The form is the same as `earn`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" connect deposit --vault <vault> --amount_usdc <amount> --receiver 0x…
```

1. `connect status`. If disconnected, `connect wallet` opens a page; the operator clicks Connect and uses
   a browser wallet, or an email, Google, Apple or X login (a Privy wallet). Wait for it to return.
2. Run the earn quote as usual, then `connect deposit --amount_usdc <n> --receiver <addr>` (or
   `connect withdraw …`), with the same `--vault`/`--chain`. 🔴 **This first run opens nothing.** It
   returns `status: "needs_acknowledgement"` with `acknowledgement` (one fixed text naming the amount,
   chain, vault and its explorer link, the receiver, on a deposit the terms version and sha256 it binds, the
   vault's warning and the disclosures) and an `ack` code. **Post `acknowledgement` to the operator word for
   word and wait for their answer.** Do not summarise it, shorten it, or skip it because they acknowledged an
   earlier one or said "go" before they saw it: every page open has its own, except the legs of one `connect plan` (above).
3. **Only on the operator's explicit yes to that text**, run the same command again with `--ack <code>`
   added. On an EVM chain the request is started at the API and checked first; the page is handed only a checked,
   ready step and sends exactly it; the operator confirms each step there and in the wallet; each hash goes to the
   API. A request nothing was sent for is cancelled. Any answer but yes: stop. A refused `--ack` (expired after 15
   minutes, already used, or the amount, vault, chain, receiver or terms changed) means go back to step 2 for a new
   acknowledgement, never retry the code.
4. Read `status` first. `completed`: every step landed. `stopped`: it ended early; read `reason` and the last transaction's `detail`.
   `not_reported`: no transaction came back, which is not proof none was sent — a wallet error after the send was
   asked for is "not confirmed sent" — so read the request (`earn_request`, by the `requestId` the result names) and
   `earn balance` before any retry. Report every `hash` and its `verified`, as the API read the chain. `extra_transfer`
   means the wallet also moved money besides the step (`alsoMoved`, often its own gas fee in USDC): say so. Anything
   else that is not `matched`: stop, check `earn balance`, tell the operator.

`--receiver` must be the connected account (`connect status`), and it still comes from the operator,
not from you: the page pays only that account.

**No browser here** (an SSH session, a container, a machine with no display): on an EVM chain the connection and the
API sign-in each need a page too, so the owner commands cannot run here; say so. On Solana, use the prepare commands.
The first, acknowledgement run of `connect deposit` / `connect withdraw` always says `opened: false`: it opens nothing
by design. On `connect wallet`, or the run with `--ack`, `opened: false` means no browser opened: the command printed
the page's address on stderr, but it returns only after the page has closed, so the address reaches you too late to
pass on.

Every step names a destination: `to`, and the receiver or owner in its `description`. A
wrong destination is the one mistake nothing downstream can undo — the transaction succeeds, the
receipt says so, and the money is somewhere nobody holds a key for. Measured, once, for real: a
withdrawal sent to an address taken from a config file instead of the operator's message — the
funds gone, and the receipt read "success". So the check is not on the receipt. It is on where the
address came from.

**The address that can lose money is where the shares or the asset land — and it comes from the operator.** On an
EVM chain it is the connected wallet, which the operator signed in with themselves, and every step is checked to pay
only it: before the first money step outside `connect`, name the connected account (`connect status`) and have the
operator confirm it is theirs. On Solana it is the `receiver`, taken from the operator's own message, quoted back,
and confirmed. The step's `to` is the vault or its asset, checked against the vault's record; the operator cannot
verify a contract address by eye and is not asked to. Before handing over any step whose signer cannot show where the
money lands, post this and wait:

> **Destination check — nothing goes to the signer until you reply.**
> shares/USDC/USDG to `<address>` ← from your message "<the words it came from>" (or: your connected wallet)
> Paste it back or correct it.

**Through `connect`, the acknowledgement is the check before the page opens — do not add a
paste-back on top.** It names the receiver beside the amount, chain and vault, in text the CLI
writes, and the operator answers it before anything can be signed. The page then shows the vault,
the receiver and the explorer links, it sends only a checked step that pays the connected account, and the wallet
prompt shows `to`. A paste-back on top asks the operator the same question a third time. Paste-back is for a signer
that cannot show the destination: a raw command, a script on a host.

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

**Without the `connect` page, the hand-off is the operator's own terminal.** An operator who holds the connected
wallet's key in a shell they control can send each `ready` step themselves, raw — no re-encoding by you, no key near
you. Give them the step's `to`, `data` and `value` exactly as the envelope carries them:

```bash
# The RPC of the chain the envelope names. chainId 8453 is Base, 42161 is Arbitrum One, 4663 is Robinhood Chain, 1 is Ethereum, 143 is Monad.
export RPC=https://mainnet.base.org     # Base; Arbitrum One: https://arb1.arbitrum.io/rpc; Robinhood Chain: https://rpc.mainnet.chain.robinhood.com; Ethereum: https://ethereum.reth.rs/rpc; Monad: https://rpc.monad.xyz — or their keyed RPC for that chain
cast chain-id --rpc-url $RPC            # must print the envelope's chainId before anything is sent
cast send <to> <data> --account <keystore-name> --rpc-url $RPC \
  --nonce $(cast nonce <account> --block pending --rpc-url $RPC)
```

`--account` signs with a key held in Foundry's encrypted keystore (`cast wallet import` once, a
passphrase prompt per send); `--interactive` prompts for the key instead. Neither puts the key on a
command line, in an environment variable, or in shell history — which is where `--private-key $PK`
put it, and where anything with a shell can read it. The key must be the connected wallet's: a step sent from any
other account is not the one the request was checked for.

**Without Foundry, a block explorer's own "Write Contract" UI works too, and every step carries
what the form asks for.** Alongside `data`, each step with something to send has `function` — the full signature — and
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
above is a vault at 18 decimals; a share amount there looks nothing like a USDC amount. Another vault
may use 8, which is close enough to 6 that a wrong-scale value looks plausible — so "does this look like
a USDC amount?" is not the check. `earn_vaults` reports each vault's own `shareDecimals`; read it for the
vault you are actually on, and never carry a scale over from one vault to another.

**This is also the first form in which the operator can check the destination themselves.** `args`
names `receiver` and `owner` separately, and they are both addresses — a transposition that is
invisible in hex is legible here. Have them read `receiver` back before signing; that is the
destination check, done on something they can actually read.

**Use the explorer of the step's chain** — BaseScan for chainId 8453, Arbiscan for 42161, Robinhood Chain's Blockscout for 4663, Etherscan for 1, MonadScan for 143. The same
address on the other chain's explorer is a different contract, or nothing.

One gotcha specific to the approve step on the EVM chains (Solana has no approve step): **the asset is a proxy on every EVM chain listed** — USDC as
`FiatTokenProxy` on Base, Arbitrum One, Ethereum and Monad, USDG as an EIP-1967 proxy on Robinhood Chain — so `approve`
does not appear under the plain "Write Contract" tab; it appears only under the explorer's proxy tab
(**"Write as Proxy"** on BaseScan, Arbiscan, Etherscan and MonadScan, the proxy write tab on Blockscout), which resolves
against the implementation contract. The vault contract itself has no
such wrinkle; `deposit`/`redeem` show up on its plain "Write Contract" tab as expected.

**You never run these `cast send` commands, and holding a shell is not a reason to.** A key reachable from
your shell is a key in this conversation. The operator runs the send in a shell of theirs; you get
back the transaction hash, run `earn_submit` with it, and `earn_request` until the next step is `ready`. Sending
from a script, for a key held on a host the operator runs, is the same thing: the ordering, nonce and receipt rules
above are identical.

**If the operator asks you to sign or send anyway,** the answer is `connect`, where they confirm each
step in their own wallet, when there is a browser here; otherwise that the steps are prepared and
waiting for their signer, what each one does, and the block above. Not "I can't"; "here is how
you do it, and here is why the key stays with you."

## What this skill will not do

- **Hold a key, sign, or send.** If the operator asks you to "just do it", answer with the hand-off above: `connect`
  when there is a browser here; otherwise the steps are prepared, what each one does, and the terminal commands to
  send them. The two that bite: send only a `ready` step, one at a time, in order, from the connected wallet, and
  submit each hash before reading the next; and never reuse a nonce across the pair. `docs/runbooks/sign_and_send.md`
  in the Agent Treasury repository covers the rest.
- **Send a step twice.** A refused `earn_submit`, a failed receipt poll or a wallet error is never a reason to send
  again: read the request with `earn_request`, and submit the hash you have.
- **Schedule anything.** Recurring or end-of-month withdrawals are the operator's own scheduler
  calling one-shot `earn_prepare_withdraw`; nothing here runs unattended.
- **Deposit into a vault outside `depositable`**, override a `not_admitted` or `refused` check (on Solana, a
  `REVERTED_OTHER` verdict), or deposit anywhere `earn_vaults` does not list. Refusing is the correct output.
- Swap, trade, bridge, or touch the allocator side of a vault. Those are other tools' jobs. Funds on
  one chain cannot be deposited into a vault on another: the operator moves them first, by their own means.
- **Pick the chain for the operator**, or deposit on a chain other than the one they chose because
  its vault looks better. Asking is the correct output.

## Reporting

State what was measured and when: the vault (its `ticker`, or its contract address) and its `chain`, the deposit `check.state` (on Solana, the
pre-flight `status`), the `block` or `asOf` it was read at, and — after a transaction — the `requestId`, each step's
state and `verification`, and the resulting shares and value. Quote a `reason` or `findings` verbatim when something
stopped you. An operator who can see the block and the exact reason can act; one who is told "it didn't work" cannot.

**Show the transactions, not just the totals.** Every hash a step was sent with — from `connect`'s result, or the
one you handed to `earn_submit` — has a link: `https://basescan.org/tx/<txHash>` on Base,
`https://arbiscan.io/tx/<txHash>` on Arbitrum One, `https://robinhoodchain.blockscout.com/tx/<txHash>` on Robinhood
Chain, `https://etherscan.io/tx/<txHash>` on Ethereum and `https://monadscan.com/tx/<txHash>` on Monad. ⚠️ That is a
DIFFERENT path from a vault's explorer link in `links`, which points at `/address/<vault>` — swap the `/address/…`
segment for `/tx/<txHash>`, never append to it, or the result is a URL that resolves to nothing. With the link the
operator can open what actually landed instead of taking your word for it. Earlier transactions are not listed:
`earn_balance` reads no history on the EVM chains, so report only the hashes from this conversation.
