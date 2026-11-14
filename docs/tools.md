# The commands

Nine `earn` commands, each named here by its tool name, `earn_`-prefixed: `earn_quote` runs as
`treasury earn quote`, and its arguments are its flags (`--direction deposit --amount_usdc <amount>`,
where the amount is always the operator's own). Each prints one JSON document; a refusal exits 1 with `{ "error": … }` on stderr.
`treasury earn --help` lists every command and flag, `treasury earn <command> --help` one command's
(put `--help` right after the command), `treasury --help` the skills, and `treasury --version` the
bare version. A flag's `_` may be typed as `-` (`--amount-usdc`), and so may a command's
(`prepare-deposit`). Three kinds: **READ** commands return facts; **PREPARE** commands start a
deposit or withdrawal and return its unsigned steps for your signer; **REQUEST** commands
(`earn_submit`, `earn_request`) hand back the hash of a step your signer sent, and read or cancel a
request. Nothing signs or sends a transaction, and CI asserts the command list exactly — a tenth
command, or a `sign`, fails the build.
The six `connect` commands [further down](#the-connect-commands--treasury-connect-command) are a fourth
kind: they hand each step to the operator's own wallet for approval. Their list is pinned by CI the same way. The five
`invest` commands [after them](#the-invest-commands--treasury-invest-command) do the same for Smart Growth
portfolios, through the Tempora API, and are pinned the same way.

**Where the answers come from.** On the EVM chains (Base, Arbitrum One, Robinhood Chain, Ethereum and
Monad), `earn` reads and acts through the Tempora API and nothing else: `https://api.temporalabs.com`
by default, or the deployment `TREASURY_API_URL` names (https only, except for an address on this
machine). No RPC endpoint is read on those chains. Treasury names a vault there by its contract
address, which only picks the vault among those the API lists: its asset, decimals, status, terms and
warnings are the API's, read when the command runs. The API prepares each step of a deposit or withdrawal, and Treasury
checks every step against the API's own record of the vault (with `checkSteps` from
`@temporalabs/client`) before handing it out. That check catches a wrong step; it cannot catch a
wrong record. On Solana nothing changed: the commands read the chain directly and take the vault from
the registry (see [On Solana](#on-solana)).

Every tool that takes a vault takes it as `vault`, and uses the default when it is omitted. On an EVM
chain `vault` is the vault's contract address (`0x…`, in any case), as `earn_vaults` lists it under
`vault`, or its ticker (e.g. `tlCashPlusUSDC2B`), which the registry turns into that address. The
address picks the vault the API lists at it: an address no listed vault has, or more than one has, is
refused, and so is a value that is neither an address nor a known ticker. On Solana `vault` is the
vault's ticker, which the registry assigns. Each EVM chain's default is a contract address, that of
`tlCashPlusUSDC2B` on Base, `tlCashPlusUSDC2C` on Arbitrum One, `tlCashPlusUSDG2D` on Robinhood Chain,
`tlCashPlusUSDC2E` on Ethereum and `tlCashPlusUSDC2F` on Monad. A default the API does not list now is
refused, never replaced by another vault.

Every response names a vault on an EVM chain by `vault` (its contract address), `ticker` (the
registry's ticker for that address, or `null`) and `name` (the API's).

Every tool that takes an address takes it as `account` — whose shares these are. On an EVM chain the
owner calls (`earn_status` with `account`, `earn_quote`, `earn_balance`, both prepare commands,
`earn_submit` and `earn_request`) act for the **connected wallet** only (`treasury connect wallet`):
`account` may be left out, and any other account is refused. When the API needs the wallet to sign
in, a local page opens for it to sign a free sign-in message (no gas, nothing moves); otherwise no
page opens. One sign-in serves `invest` and `earn`. On Solana `account` is required. The prepare
commands take `receiver` on Solana only, where it must be the account itself; on an EVM chain the
shares and the asset (USDC; USDG on Robinhood Chain) always go to the connected wallet, and
`receiver` is refused.

## `chain` — which chain a call is for

A vault is on one chain. Every tool that takes `vault` also takes `chain`: `"base"`, `"arbitrum"`, `"robinhood"`, `"ethereum"`, `"monad"` or `"solana"`
— as `earn_vaults` lists them under `chains`.

| `vault` | `chain` | resolves to |
|---|---|---|
| omitted | omitted | the default chain's default vault (Base) — refused if the API does not list it |
| omitted | given | that chain's default vault — refused if the API does not list it |
| given | omitted | that vault, on the chain it is on |
| given | given | that vault — **refused** if it is on a different chain; the error names the chain the vault is on and the vaults on the chain that was asked for |

An unknown chain name is refused, with the list of chains that have a vault, before anything is
asked of the API. Names are exact: `"Arbitrum"` and `"42161"` are refused. An empty string counts as
omitted, for `chain` as for `vault`. Nothing is resolved by guessing: the two readings of a mismatch
are different contracts on different chains.

Every result that names a vault carries `chain` and `chainId`. On a prepared envelope they come
first: its steps are correct on that chain only. Sent on another chain, a transaction to an address
with no contract there is mined and does nothing. On Solana `chainId` is `null`, the envelope carries
one `transaction` instead of steps, and `cluster` and `genesisHash` name the chain (see
[On Solana](#on-solana)).

**The agent asks, the tool does not choose.** When the operator has not said which chain to deposit
on, the skill has the agent show `earn_vaults` → `chains` and ask. Withdrawals, quotes and balances
on an existing position need no question: the vault names the chain.

Amounts are decimal strings in the vault's asset (`"25"`, `"0.05"`): USDC, or USDG on Robinhood Chain.
The arguments and fields named for USDC (`amount_usdc`, `usdcValue`) keep those names for every asset.
More fractional digits than the asset has (6 for both) are refused, never truncated. Shares never cross the boundary as numbers — only as an exact string.

---

## `earn_vaults` — READ

No inputs. Every vault the Tempora API lists now, on every EVM chain, and the vault on Solana this
client reads from its own chain. Each EVM row carries:

- `vault` — the vault's contract address, the value every other tool takes as `vault`; `ticker` — the
  registry's ticker for it, taken as `vault` too, or `null` when it has none; and `name`;
- `status` — the API's: `live` takes deposits and withdrawals, `paused` takes withdrawals only, and
  anything else takes no deposit. `depositsOpen` is true only for `live`;
- `isDefault` — whether it is its chain's default;
- `chain`, `chainId` and `caip2` — the chain the vault is on, e.g. `"arbitrum"`, `42161` and
  `"eip155:42161"`;
- `standard`, `vaultAddress`, `assetAddress`, `assetDecimals` and `shareDecimals` — the vault's
  contract and asset, as the API records them;
- `termsVersion` — the version of the vault's terms ([`earn_terms`](#earn_terms--read) shows the
  text); and `fees`;
- `links` — openable without any endpoint. They are how an operator verifies, without this client's
  help, that the address about to be used is the vault it claims to be;
- `warnings` — what to show before preparing a deposit into this vault. Show them; do not summarise
  them. They are repeated on every response that commits money — see `earn_prepare_deposit` below —
  so a caller who never lists still receives them.

A Solana row is as before — `symbol`, `name`, `address`, `chassis`, `asset`, `sharesMint`,
`shareDecimals`, `depositOpen`, `warning` (one string) and a Solscan `links.explorer` — plus `vault`
and `ticker`, both its ticker, the value the tools take as `vault` on Solana.

And, once per response:

- `api` — the API address the list was read from;
- `chains` — the chains a deposit can go to, the default chain first. Each entry is
  `{ chain, chainId, name, default, depositable }`: that chain's default vault (`{ vault, ticker, name }`,
  present only when the API lists it, otherwise `null`) and the vaults on that chain taking deposits
  now, each `{ vault, ticker, name }`. An EVM
  chain appears only when the API lists a vault on it. This is what an agent shows an operator who
  has not chosen a chain;
- `defaultChain` — the chain used when a tool is called with neither `vault` nor `chain`;
- `default` — the vault used in that case: the default chain's default, or `null` when the API does
  not list it;
- `depositable` — the vaults taking deposits now, across all chains, each `{ vault, ticker, name }`: `live` on an EVM chain, measured
  open on Solana. **May be empty.** An empty set is a state of the offering, not a fault.

Whether one account may deposit is decided by the API's per-account gates: run `earn_status` with
the account before a deposit.

## `earn_terms` — READ

| input | |
|---|---|
| `vault` | optional; see above |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |

The vault's terms as the Tempora API publishes them, `terms: { text, version, sha256 }`, with the
pre-deposit `disclosures` and a `next_step`. The text is hashed here (SHA-256 of its UTF-8 bytes, as
`0x` and lowercase hex) and refused when it does not match the `sha256` the API sent with it. The
skill shows `terms.text` and the disclosures to the operator in full and records an acknowledgement
before building a first deposit: a deposit is made against this exact version and sha256. On Solana,
the disclosures alone.

## `earn_status` — READ

| input | |
|---|---|
| `vault` | optional; see above |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | optional; on an EVM chain, the connected wallet |
| `amount_usdc` | optional; the deposit amount to check |

With **no `account`**, a health check: `mode: "health"`, `version`, `api` (the API address), and
`apiStatus`, `ok` or `unreachable` (with `reason`). When the API answered, the result also carries
`vaultsListed` and the vault the call resolves to (`vault`, `ticker`, `name`, `status`, `depositsOpen`, `chain`,
`chainId`). It returns a verdict when the API cannot be reached; it does not throw. Its
`server: "treasury"` field keeps the name it had when this ran as a server, so the result stays the
same JSON; it names the program, not a running process. A call that names a `vault` but no `account`
is answered as a health check too, and says so with `requested: "preflight"` and
`missing: ["account"]`: it is not a pass.

With `account`, the API's view of the connected wallet on the vault, `mode: "preflight"`:

- `standing` — the API's summary of the account on this vault;
- `gates` — every gate, each with its `status` and the vault's own `reason`. Show the reason
  verbatim;
- `wallet` — the wallet's balance of the vault's asset and its allowance to the vault, in raw units
  with `decimals`; `null` when it could not be read, never `0`;
- `alerts` and `warnings` — the API's alerts for the account, and the vault's warnings;
- with `amount_usdc`, `deposit: { amount, check, block, asOf }` — whether the vault would take that
  deposit: `check.state` is `open`, `holdings`, `not_admitted`, `refused`, `unsupported` or
  `unknown`, with the vault's `reason`.

The `mode` field says which of the two answers you got.

## `earn_quote` — READ

| input | |
|---|---|
| `vault` | optional; see above |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | on an EVM chain the connected wallet, and may be left out; required on Solana |
| `amount_usdc` | required for a deposit; on an EVM chain optional for a withdrawal |
| `direction` | required, `"deposit"` or `"withdraw"`; echoed back on the result |

A pre-trade quote from the Tempora API for the connected wallet, read and simulated at one `block`
(with `asOf`). Advice only: the request decides.

**`deposit`:** `expectedShares` and `sharePrice` (raw, with decimals), and whether the vault would
take it (`check.state`: `open`, `holdings`, `not_admitted`, `refused`, `unsupported` or `unknown`,
with the vault's own `reason`), plus the vault's `warnings`. No rate is quoted: this client calls no
yield API.

**`withdraw`:** the wallet's `position` (its shares, and their value in the asset), and how much of
it can be withdrawn now, found by simulating withdrawals: `withdrawable.state` is `all`, `partial`,
`refused` or `unknown`, with `assets`, `within` and `reason`. No warnings on this side. On Solana the
quote is read from the chain (see [On Solana](#on-solana)).

## `earn_balance` — READ

| input | |
|---|---|
| `vault` | optional; see above |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | on an EVM chain the connected wallet, and may be left out; required on Solana |

A position is in one vault, on that vault's chain. An account's positions on different chains are
separate calls, and an empty result on one chain says nothing about another.

Returns, from the Tempora API: `chain` and `chainId`, `stage` (the API's), `shares` (the exact share
balance, `{ raw, decimals }`), `sharesExact` (the same number as a decimal string, never rounded: the
string to hand back for a withdrawal by shares), `value` (`{ usd, state, asOf }`: what it is worth,
and how that was read), and:

- **`withdrawable`** — what can actually be withdrawn now, found by simulating withdrawals at
  `withdrawable.block`: `withdrawable.withdrawable.state` is `all`, `partial`, `refused` or `unknown`,
  with `assets` and `reason`. `basis: "floor"` means the figure is a lower bound. It can be less than
  the position's value. `"unknown"` when the API sent none.
- A `stage` of `unknown` means the share balance could not be read: `shares` and `sharesExact` then
  read `"unknown"`, never `0`.
- `basis` and `yield` read `"not available"`: entry basis and accrued yield are not available
  through the API.

`position: "none"` means the API lists no position for this wallet in this vault.

## On Solana

The vault on Solana is a Kamino vault, read from its own chain through `TREASURY_RPC_SOLANA` (or the
public endpoint; see [`configuration.md`](configuration.md)), and the same commands answer for it
with these differences:

- Every result carries `chain: "solana"`, `chainId: null`, `cluster: "mainnet-beta"` and the cluster's
  `genesisHash`.
- `account` and `receiver` are Solana addresses, and `receiver` must equal `account`. No sign-in is
  involved.
- `earn_status` with no `account` is a health check of the endpoint: `rpc` is `ok` (with
  `chainVerified`), `unreachable` (`reason` says why, without the URL) or `wrong_chain` (an endpoint
  whose genesis hash differs), with `rpcSource` naming *which environment variable* supplied the
  endpoint — never the URL — and `latestSlot`. It returns a verdict when the endpoint is down; it does
  not throw.
- `earn_status` with `account` simulates the deposit and returns `OPEN_READY`, `NEEDS_FUNDS` (no USDC,
  or no SOL for the fee), `REVERTED_OTHER` (including a vault that requires a co-signer) or
  `UNRESOLVED` (the endpoint failed: not a verdict about the vault). With no SOL, `canDeposit` is
  false: the simulation stopped before the vault and says nothing about it. A deposit over the vault's
  cap is not `canDeposit` either.
- `earn_quote --direction deposit` reports `expectedShares`, `sharePriceInAssets` and the same
  `preflight` verdict; read `preflight.status`. `--direction withdraw` reports `sharesToBurn`,
  `sharesHeld`, `instantLiquidity`, `canWithdraw` with a `note`, and `receives`, the USDC the
  account's balance would rise by: each withdraw instruction keeps up to 0.001 USDC in the vault
  (Kamino's charge, which it can change).
- `earn_balance` reports `sharesExact`, `shares`, `usdcValue`, `sharePriceInAssets` and `exit`: a
  simulated full withdrawal, or, when Kamino would cap it, `measuredAs` `a simulated partial
  withdrawal` (what a withdrawal of just the shares that burned pays) or `a capped withdrawal` with
  `exitableNow: unknown`. `entryBasisUsdc`, `accruedYieldUsdc` and `scan.wholeHistory` say the history
  was not read.
- `earn_prepare_deposit` and `earn_prepare_withdraw` return ONE unsigned transaction, not a list of steps:
  `transaction` carries `wire` (base64, every signature slot empty), `feePayer`, `blockhash`,
  `preparedAtBlockHeight` and `expiresAfterBlockHeight`. It is simulated before it is returned, and a
  transaction the program would refuse is not returned at all. Neither is a withdrawal whose simulation burns
  fewer shares than asked, beyond one share unit of rounding per withdraw instruction: the program would pay
  what a reserve can and leave the rest of the shares, so the quote reports `canWithdraw: false` with a `note`
  and the prepare refuses. `expected` and `simulated` say what the simulation minted or paid. A
  withdrawal of everything is `--all` with `--shares_exact`. There is nothing to `earn_submit`: the
  operator's own Solana wallet sends the transaction.
- The vault's warning is one string, `warning`, on the same responses that carry `warnings` on an EVM
  chain.

## `earn_prepare_deposit` — PREPARE

| input | |
|---|---|
| `vault` | optional; see above |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | the depositing account; on an EVM chain the connected wallet, which sends both steps, and may be left out; required on Solana |
| `amount_usdc` | required |
| `terms_sha256` | required on an EVM chain: the `terms.sha256` from `earn_terms` for the terms the operator was shown and accepted |
| `receiver` | Solana only, where the shares land: the account itself. Refused on an EVM chain |

On an EVM chain this starts a deposit at the Tempora API, with the vault's current terms version and
that sha256, and returns its steps unsigned. Terms that changed since the operator read them are
refused: show them again with `earn_terms`. Every step is checked before it is returned: the approval
only to the vault's asset, for exactly the amount, with the vault as spender; the deposit only into
the vault, for exactly the amount, paying the shares to the connected wallet. A request that fails
the check hands nothing out, and the refusal names it so it can be cancelled with `earn_request`.

Returns `{ requires_signature: true, status: "unsigned", chain, chainId, warnings, vault, account, requestId, state, expiresAt, steps: [approve, deposit], next_step, signer_rules }`. Each step is
`{ stepId, state, after?, purpose?, to, data, value, function, args, description }`. Only a step whose
`state` is `ready` has something to send. A `waiting` step (the deposit, until the approval is
submitted) has no `to` or `data` yet: its `after` names the step it waits for, and its
`description` says to read it again with `earn_request`. Nothing has happened until the wallet's
transactions confirm.

The flow: prepare → send step 1 from the connected wallet → `earn_submit` its hash → `earn_request`
until step 2 is `ready` → send it → `earn_submit` its hash. The approve is on the vault's own asset on
that chain (USDC, or USDG on Robinhood Chain) and names that chain's vault as the spender. An asset on
one chain cannot be deposited into a vault on another; Treasury does not bridge.

`function` and `args` are the same call `data` encodes, in the form a block explorer's **Write
Contract** tab asks for — for an operator with no CLI signer, that is often the friendliest way to
sign something:

```json
{ "function": "approve(address spender, uint256 value)",
  "args": { "spender": "0x1516…99ef", "value": "1000000" } }
```

Three things to know about them:

- **`args` values are RAW contract units**, exactly what the form takes — `1000000`, not `1 USDC`.
  `description` is the human sentence; `args` is what you paste.
- **They cannot disagree with `data`.** `function`, `args` and `description` are all decoded from
  the step's own `data`, never taken from the API's words.
- **The parameter NAMES are this client's; the bytes are the contract's.** An explorer labels its
  form from the verified contract's own ABI, which may name a parameter differently. The values,
  their order and their types are what bind — if a label differs, fill by position.

`signer_rules` says what a signer must do for each step to land exactly once: send on the chain
`chainId` names and no other; send only a `ready` step, one at a time, in order, from the connected
wallet; set the nonce from the pending count immediately before each send; wait for each receipt
before the next step; and never send again when the nonce moved after a failed send or receipt poll —
submit the hash you have with `earn_submit` instead.

`warnings` are the vault's own disclosures, repeated here rather than left at discovery — **show them
before the signer sees the steps, verbatim**. Every response that commits money carries them:
`earn_status`'s preflight, `earn_quote` on the deposit side, this one, and `earn_submit` or
`earn_request` when a deposit step is ready to send. Withdrawals deliberately do not: the risk they
describe is committing funds, not retrieving them, and a disclosure repeated where it does not apply
is what teaches a reader to skip it.

## `earn_prepare_withdraw` — PREPARE

| input | |
|---|---|
| `vault` | optional; see above |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for). A position is withdrawn on the chain it is on: name the vault |
| `account` | whose shares are burnt; on an EVM chain the connected wallet, and may be left out; required on Solana |
| `amount_usdc` | an amount of the vault's asset to withdraw |
| `all` | a switch: everything, as a redeem of every share |
| `shares_exact` | a number of shares, copied verbatim from `earn_balance.sharesExact`; never a rounded number |
| `receiver` | Solana only, where the asset lands: the account itself. Refused on an EVM chain |

On an EVM chain give exactly one of `amount_usdc`, `all` or `shares_exact`. The withdrawal is
started at the Tempora API, and its step — a `withdraw` for an amount, a `redeem` for shares or
everything — is checked before it is returned: only from the vault, paid to and owned by the
connected wallet, for exactly the amount asked. Same envelope, without `warnings`; send the step, then
`earn_submit` its hash. Quote first: `earn_quote`'s `withdrawable` is what tells you whether the vault
can pay this out now, and the agent must be told before signing. On Solana, `all` goes with
`shares_exact`.

## `earn_submit` — REQUEST

| input | |
|---|---|
| `request_id` | required; `requestId` in the envelope |
| `step_id` | required; the step the transaction was sent for, `stepId` in the envelope |
| `tx_hash` | required; the transaction hash the wallet returned |
| `nonce` + `from` | optional, together: the transaction's nonce and the address that sent it, which must be the connected wallet |
| `block` | optional, with `nonce` and `from`: the block it was mined in, when known |

Hands the hash of a step the connected wallet sent to the Tempora API, which reads the chain itself
at that hash. Answers with the request: `requestId`, `action`, `state`, `expiresAt`, each step's state
and the API's `verification` of a sent one, `checked`, and, when a later step is now `ready`, that
step checked as the prepare command checks it, with `next_step` and `signer_rules`. A refusal names
the API's code: **never send the transaction again because of one** — read the request with
`earn_request`. A hash the API recorded is said to be recorded even when what follows it is refused.

## `earn_request` — REQUEST

| input | |
|---|---|
| `request_id` | the request's id |
| `tx_hash` | instead of `request_id`: the hash of a transaction sent for it |
| `cancel` | optional, with `request_id`: cancels a request still waiting on the owner (nothing has moved for it) |

Give exactly one of `request_id` or `tx_hash`. Reads one of the connected wallet's vault requests
again, or cancels it, and answers in the same shape as `earn_submit`. A step that is now `ready` is
shown with what to send only after the same check against the request's own amount, the vault the
API lists and the connected wallet. A request for anything other than a listed vault is shown with
its states only (`checked: false`, with a `note`), never with anything to send; a portfolio's request
is read with `invest request`.

---

## The connect commands — `treasury connect <command>`

These hand each step to the operator's own wallet instead of returning it: a browser wallet (MetaMask,
Rabby, Coinbase Wallet), or a Privy embedded wallet opened with an email, Google, Apple or X login.
Coinbase Wallet's own entry in the sign-in window (the Coinbase SDK, for its mobile app or a smart
wallet) is untested in this release ([#88](https://github.com/TemporaLabs/treasury/issues/88)). That
entry is separate from the Coinbase Wallet browser extension, which, like any wallet installed in the
browser, is listed on the window's first screen.
A page opens on the operator's machine, at a one-time URL on `http://localhost:53682` (or the next free port up to 53686) that the command
also prints on stderr; they read each step there and
confirm it in the wallet. Nothing here signs. On an EVM chain the vault is one the Tempora API lists,
named by its contract address or its ticker, and the deposit or withdrawal is a request of the API, exactly as in `earn`: when
the API needs a sign-in, a page of its own asks the wallet for one first. See [`security-model.md`](security-model.md#the-wallet-connection-treasury-connect).

| command | flags | does |
|---|---|---|
| `connect status` | — | the connected account and how it signed in (`external` / `embedded`), or `disconnected`, with the connected Solana account under `solana`; reads a local file only |
| `connect wallet` | `--chain` (optional; `solana` connects a Solana wallet: Phantom, Solflare, Backpack, or a Privy wallet) | opens the sign-in page: one Connect button, then Privy's window. The wallet signs a free sign-in message; waits up to 9 minutes and returns `{ status: "connected", account, walletType, connectedAtIso, opened }`. If the sign-in does not finish, it exits 1 with `not connected: <reason>` |
| `connect deposit` | `--amount_usdc`, `--receiver`, optional `--vault`, `--chain`, then `--ack`, or `--plan` with `--leg` | a deposit from the connected account. Without `--ack`, opens nothing and returns the operator's acknowledgement; with its code, starts the request at the API (on Solana, builds the transaction), checks it, and hands each step to the wallet in turn |
| `connect withdraw` | `--receiver`, then `--amount_usdc` or `--all` (on an EVM chain alone, or with `--shares_exact`; on Solana with `--shares_exact`), optional `--vault`, `--chain`, then `--ack`, or `--plan` with `--leg` | the same for a withdrawal. On an EVM chain `--all` alone is the whole position as it stands when the withdrawal runs; with `--shares_exact`, exactly those shares |
| `connect plan` | `--legs`, then `--ack`; then `--run`; or `--status` alone | one acknowledgement for several deposits and withdrawals, across vaults and chains. `--legs` and `--ack` open nothing; `--run` opens one signing page for every leg, EVM and Solana; each leg's command also runs alone with `--plan` and `--leg`. See [below](#a-plan-one-acknowledgement-for-several-legs) |
| `connect disconnect` | — | forgets the connected accounts, EVM and Solana, and the API sign-in kept for them; moves nothing |

`--receiver` must be the connected account: this page pays no one else. It comes from the operator's
own message, never from the agent. Nothing in Treasury pays another address: `earn prepare_deposit`
and `earn prepare_withdraw` also pay only the connected wallet on an EVM chain, and only the account
itself on Solana.

### The acknowledgement before the page opens

`connect deposit` and `connect withdraw` open nothing on their first run. They work out what the
operator asked for — on an EVM chain from the vault the Tempora API lists, with its terms checked
against their own sha256; nothing is started at the API yet — then return

`{ status: "needs_acknowledgement", opened: false, action, amount, chain, chainId, vault, account, receiver, terms?, acknowledgement, ack, expiresAtIso, next_step }`

`vault` is `{ symbol, name, address, explorer }`. On an EVM chain `symbol` is the vault's ticker, or
its contract address shortened when it has none.
`terms` (an EVM deposit only) is `{ version, sha256 }`: the terms the deposit sends.

`acknowledgement` is one fixed text, written by the CLI and not by the agent: the action and amount,
the chain, the vault's name, ticker and explorer link, the receiver, for an EVM deposit the terms version
and sha256, how many wallet prompts to expect (a deposit asks twice, approve then deposit; a
withdrawal once), the vault's warning, and the disclosures in plain words: a short form of
[`earn terms`](#earn_terms--read) before a deposit, with the sentence that only admitted accounts can
deposit when the API gates the vault by an allowlist, and before a withdrawal only the two points
that hold for every action. It says the full terms can be asked for; `earn terms` returns them, and
the skill still shows them in full before a first deposit. It ends by asking for a yes or a no. The
agent posts it to the operator word for word.

On the operator's yes, the same command run again with `--ack <ack>` opens the page. The code is
refused, and nothing opens, when:

- it is not the pending acknowledgement's code (each first run replaces the one before);
- it was already used: each acknowledgement opens one page;
- it is more than 15 minutes old;
- what it would send differs from what was acknowledged (another amount, vault, chain, receiver,
  direction or connected account, or, for an EVM deposit, other terms).

A `connect wallet` that completes a sign-in, or a `connect disconnect`, clears any pending
acknowledgement; a sign-in that does not finish leaves it as it was. The pending one
sits beside the session file (`connect-ack.json`, owner-readable only) and holds a digest of what was
acknowledged, not the steps. While a page is open, `connect-page.lock` beside them names its process and port, and a second
sign-in or confirmation is refused until the page closes. The page's process touches the file every 5 seconds; a
lock left by a run that crashed (its process gone, its page expired, or the file untouched for 30 seconds and still
untouched a few seconds later) is replaced.

### What the confirm flow returns

On an EVM chain, the `--ack` run starts the request at the Tempora API and checks every step, as
`earn prepare_deposit` and `earn prepare_withdraw` do, before the page opens; a request that fails the
check is cancelled, and nothing opens. The page is handed only a checked step that is `ready`, and
sends exactly its `to`, `data` and `value`. Each hash goes to the API (`submit`), which reads the
chain and says how the step landed; the request is then read again until the next step is ready or
the request settles. A step is never put to the wallet twice: a step the API asks for again after it
was sent is refused. A hash the page could not hand over is still submitted, by that hash, once. A
wallet error after the send was asked for is reported as not confirmed sent, never as declined. A
request nothing was sent for is cancelled.

With `--ack`, `connect deposit` and `connect withdraw` return
`{ status, chain, chainId, account, opened, reason?, calls_total, txs, requestId, next_step }`
(`requestId` on an EVM chain; `earn request` reads it again); `opened` says
whether a browser was opened or only the URL printed. `txs` has one entry per transaction,
`{ step, stepId?, description, hash, verified, detail?, alsoMoved? }`, with `step` the step's position in the
flow. An entry with `step: 0` is a transaction the page reported but could not tie to a step of this
flow; it is always `unverified`, so look its hash up before retrying anything. On an EVM chain
`verified` is the API's reading of the step; on Solana it is read from the transaction itself:

| `verified` | meaning |
|---|---|
| `matched` | the step landed as asked: on an EVM chain the API reads it as landed; on Solana the vault's own effect for the connected account and the exact amount is there, and no other transfer of the vault's asset left the account |
| `extra_transfer` | as `matched`, but the account ALSO sent the asset elsewhere in the same transaction (`alsoMoved`) — often a wallet's fee for paying gas in tokens. Tell the operator |
| `mismatch` | the transaction did not do what the step asked: on an EVM chain the API reads it as a mismatch or as replaced. On Solana: a transaction the page did not build (another blockhash), one paid for by another account, a deposit short by more than rounding, or a partial withdrawal. Stop |
| `reverted` | it failed on chain; nothing it was meant to do happened |
| `unverified` | not yet read as landed when the flow ended; look the hash up (on an EVM chain, read the request with `earn request`) before retrying anything |

The flow stops at the first transaction that is not `matched` or `extra_transfer`, and sends nothing
after it. A step declined in the wallet sent nothing, so the page stays open to confirm it again or
cancel. On Solana, before the first call the page shows the wallet's balances, read once, and warns
when a deposit needs more than the wallet holds or there is nothing for the network fee; the warnings
never block the button. Each sent transaction is linked on the chain's explorer. The result's `status` says how the whole flow ended:

| `status` | meaning |
|---|---|
| `completed` | every step of the flow landed (`txs` has `calls_total` entries, each `matched` or `extra_transfer`) |
| `stopped` | the flow ended before every step landed; `reason` says why, and the last entry's `verified` and `detail` give the transaction's own verdict. On an EVM chain this includes a request the API ended other than `completed`, and a hash the API did not record: do not send it again |
| `not_reported` | the page reported no transaction (cancelled, or nine minutes passed). This is not proof that none was sent: if the wallet showed a confirmation, check `earn balance` (and, on an EVM chain, `earn request`) before any retry |

Each command returns within nine minutes, however slow the chain or the API is; a transaction still
being checked then is listed as `unverified`. A cancel waits up to 30 seconds for a check already in
progress, so it can report that transaction's verdict. The confirm page will not start a step with
less than a minute left, and a transaction hash is accepted only once per flow.

### A plan: one acknowledgement for several legs

`connect plan` is for a request that moves money in more than one vault: any mix of deposits and
withdrawals, on one chain or several. Instead of one acknowledgement per vault, the operator answers
one for the whole plan. It never opens a page itself.

`--legs` lists the legs in order, separated by `;`: each `deposit <vault> <amount>` or
`withdraw <vault> <amount|all>`, with the vault as `earn vaults` lists it (on an EVM chain its contract
address or its ticker, on Solana its ticker) and the amount as a plain decimal. A plan holds at most 8 legs. On an EVM chain each
leg is one request of the Tempora API, and `all` is the whole position as it stands when the leg
runs: no balance is read when the plan is made. On Solana, `all` reads the account's share balance
when the plan is made and binds that exact amount. Either way a withdrawal of `all` must be the first
leg on its vault and the last: one after an earlier deposit into or withdrawal from the same vault is
refused, and so is any leg on a vault after its withdrawal of `all`. Each leg's receiver is the
connected account of its family (EVM or Solana), so a plan with legs in both needs both wallets
connected. Every leg is described as its own `connect deposit` or `connect withdraw` would be.

Without `--ack` it returns

`{ status: "needs_acknowledgement", opened: false, legs: [{ leg, action, vault, chain, amount, receiver }], acknowledgement, ack, expiresAtIso, next_step }`

Each leg's `vault` is the vault's contract address on an EVM chain (the value its own command takes as
`--vault`), and its ticker on Solana.

`acknowledgement` is one fixed text: every leg in order (action, amount, chain, the vault's name,
ticker and explorer link, the receiver, for an EVM deposit the terms version and sha256, and the wallet
prompts to expect), how long the plan lasts, that its legs run in order on one signing page,
how to stop it partway, the totals, each warning once with the vaults it covers, and the disclosures
once. A withdrawal of `all` is named as the whole position as it stands when the leg runs on an EVM
chain, and as the share balance read when the plan was made on Solana. It ends by asking for a yes or
a no to exactly those legs.
The agent posts it to the operator word for word. `expiresAtIso` is 60 minutes after this run.

On the operator's yes, the same `--legs` with `--ack <ack>` records the yes, opens nothing, and returns

`{ status: "acknowledged", opened: false, code, expiresAtIso, legs: [{ leg, action, vault, chain, amount, command }], next_step }`

The code is refused if it is not the pending plan's, the plan has expired or was already
acknowledged, or the legs are not the ones acknowledged (a leg, its order or amount, a vault, a
vault's terms, or, on Solana, a share balance changed).

**One page for the whole plan: `connect plan --run`** (#174), alone, after the `--ack` run. It opens one
signing page that lists every leg (what it does, on which chain, the vault's contract address, where the money
goes, and its state) and walks them in order: the page switches the wallet to each leg's chain, and the wallet
asks for each transaction as it always does (a deposit: approve, then deposit). Each leg is still described
again and held to the digest it was acknowledged as when it starts. An EVM leg's request is then started at the
API and checked, and each of its hashes is handed to the API, as in a single `connect deposit|withdraw`; a
Solana leg is gate-checked and checked from what landed. A leg that does not complete ends the plan. Only the
wallet's own answer or a recorded transaction moves a leg: a "no" in the wallet sends nothing, and the operator
can ask the wallet again or stop the plan there. It returns

`{ status, code, expiresAtIso, opened, reason?, legs: [{ leg, action, vault, chain, amount, status, reason?, txs: [{ hash, verified, alsoMoved? }] }], next_step }`

with `status` `completed`, `stopped`, `not_reported` (a leg may have been sent; check before anything else),
`expired`, or `in_progress`. A leg's own `status` is `pending`, `running`, `completed`, `stopped` or
`not_reported`. No leg starts with less than 5 minutes of the run's 9 left: the run then returns
`in_progress`, and the agent runs `connect plan --run` again at once. The page keeps its secret and port in the
plan file, so that run serves the same page and the operator's open tab carries on. It refuses a plan not yet
acknowledged, a plan with a leg on a chain family whose wallet is not connected, and a leg that no longer
describes to what was acknowledged (another connected account, amount, vault's terms or, on Solana, share
balance). A run records
only on its own plan: if another command replaces or clears the plan while the page is open (`connect plan
--legs`, `connect wallet`, `connect disconnect`), or the plan expires, no further leg starts, the run ends at once,
and it still reports every transaction that landed.

A Solana leg (#184) runs on the same page, in its turn. When it starts it is held to its acknowledged intent, its
shares are worked out (a withdrawal by amount) and its transaction is built, gate-checked and simulated, as a single
`connect deposit|withdraw` on Solana does before its page opens. Its transaction is built again when the operator
presses for it (a blockhash lasts about a minute), and only a signature for a transaction built for that leg verifies.
The page uses the wallet the operator signed in with, never another. A plan of only Solana legs signs in as a single
Solana confirmation does. A plan that also has EVM legs signs in with the EVM wallet and, when it starts, connects
that same wallet's Solana account (the wallet may ask once) and checks it is the connected Solana account. A wallet
that cannot (none of that name, another account, or no Solana support, as with Rabby) ends the plan there: leg 1 is
`stopped` with a reason starting `not prepared:`, and nothing was sent. A Solana leg that fails on chain (for one, a
wallet that replaced the transaction's compute limit) is `stopped` with its signature `reverted`, and ends the plan.

Each leg can also run alone, exactly as its `command` gives it:
`connect deposit|withdraw --vault <vault> (--amount_usdc <n> | --all [--shares_exact <s>]) --receiver <r> --plan <code> --leg <n>`.
`--plan` and `--leg` take the place of `--ack` and cannot be combined with it. The leg opens its own
signing page and returns the result [above](#what-the-confirm-flow-returns), plus
`plan: { code, leg, of }`; its `next_step` names the next leg's command, or says the plan is done or
where it ended. The operator's yes covers every leg, so the agent does not ask again between them.
A leg is refused, and nothing opens, when:

- the plan has not been acknowledged, or the code is not the pending plan's;
- the plan has expired: a leg must start before `expiresAtIso`;
- an earlier leg has not completed, or this leg already ran or is running;
- what it would send differs from the acknowledged leg (another amount, vault, chain, receiver,
  vault's terms or connected account).

A leg whose flow does not end `completed` (`stopped`, `not_reported`, or an error once its page has
opened) ends the plan: no later leg runs, and what is left needs a new plan and a new yes. A leg that
fails before its page opens (another page is open, a port is taken, a read fails, or the API does not
start its request or the request fails the check) sent nothing: it stays pending, and the same
command can run it again.

`connect plan --status`, alone, reads a local file only. It returns `{ status: "none" }`, or
`{ status, code, expiresAtIso, legs: [{ leg, action, vault, chain, amount, digest, command, args, status, txs?, reason? }] }`
with the plan's `status` `needs_acknowledgement` or `acknowledged`, and each leg's `status` as above. A leg
still `running` when no run is serving the plan means that run never finished: check before anything else. The plan sits in `connect-plan.json`
beside `connect-ack.json`, owner-readable only; a `connect wallet` that completes a sign-in, or a
`connect disconnect`, clears it. A single acknowledgement with `--ack` works as before.

---

## The invest commands — `treasury invest <command>`

Smart Growth portfolios: USDT on BNB Chain, held by an outside provider, through the Tempora API. The API
prepares each request; the operator's own connected wallet signs in to the API and signs or sends each step on a
local page (the same ports as `connect`), and every step is checked before the wallet sees it. They need a
connected wallet (`connect wallet`); the API's sign-in token is kept for the next command. Nothing here signs.
See [`security-model.md`](security-model.md#smart-growth-portfolios-treasury-invest).

| command | flags | does |
|---|---|---|
| `invest products` | — | the portfolios the API offers: `id` (the `--product` every other command takes), status, chain and token, minimums, the amount forms and the steps. No sign-in |
| `invest balance` | — | the connected wallet's positions: stage, smart account, value, balances, idle USDT, profit and loss |
| `invest deposit` | `--product`, `--amount_usdt` | deposits the operator's own amount (at most 6 decimal places) from the connected wallet to its own smart account: the enrolment signature first when the wallet has none, then the transfer. Returns the request and whether it settled |
| `invest withdraw` | `--product`, `--all` | withdraws everything, paid to the connected wallet in USDT: one signature per authorization. A part withdrawal is not offered |
| `invest request` | `--request_id` or `--tx_hash`; optional `--cancel` with `--request_id` | reads a request again, or cancels one still waiting on the owner (nothing has moved for it) |

A command that sent a transfer and could not have it recorded stops with the transaction hash: read the request
with `invest request` before doing anything else, and never send it again.

## Failure paths, in general

- A keyed RPC URL never appears in any output, on any path, including thrown errors.
- The health path returns a verdict when the Tempora API (on Solana, the RPC) cannot be reached; it
  does not throw.
- A balance, allowance or share count that could not be read says `unknown` or `null`, never `0`.
- A step that fails the check is never handed out, and a hash the API did not record is never a reason
  to send the transaction again.
- Every refusal names its reason and the next step.
