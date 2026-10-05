# The commands

Eight `earn` commands, each named here by its tool name, `earn_`-prefixed: `earn_quote` runs as
`treasury earn quote`, and its arguments are its flags (`--direction deposit --account 0x…
--amount_usdc 25`). Each prints one JSON document; a refusal exits 1 with `{ "error": … }` on stderr.
`treasury earn --help` lists every command and flag, `treasury earn <command> --help` one command's
(put `--help` right after the command), `treasury --help` the skills, and `treasury --version` the
bare version. A flag's `_` may be typed as `-` (`--amount-usdc`), and so may a command's
(`prepare-deposit`). Two kinds: **READ** commands query the chain and
return facts; **PREPARE** commands return unsigned calls for your signer. Nothing signs, sends or
transfers, and CI asserts the command list exactly — a ninth command, or a `sign`, fails the build.
The five `connect` commands [further down](#the-connect-commands--treasury-connect-command) are a third
kind: they hand calls to the operator's own wallet for approval. Their list is pinned by CI the same way.

Every tool that takes a vault takes it as `vault`, the vault's ERC-20 ticker (e.g. `tlCashPlusUSDC2`), and uses the default when it is
omitted. Every tool that takes an address takes it as `account` — whose shares these are.
Both prepare commands also take `receiver`, which is a different thing: where the shares land on a
deposit, where the asset (USDC; USDG on Robinhood Chain) lands on a withdrawal.

## `chain` — which chain a call is for

A vault is on one chain. Every tool that takes `vault` also takes `chain`: `"base"`, `"arbitrum"` or `"robinhood"`
— the chains with a vault in the registry, as `earn_vaults` lists them under `chains`.

| `vault` | `chain` | resolves to |
|---|---|---|
| omitted | omitted | the default chain's default vault (Base) |
| omitted | given | that chain's default vault |
| given | omitted | that vault, on the chain it is on |
| given | given | that vault — **refused** if it is on a different chain; the error names the chain the vault is on and the vaults on the chain that was asked for |

An unknown chain name is refused, with the list of chains that have a vault. Names are exact:
`"Arbitrum"` and `"42161"` are refused. An empty string counts as omitted, for `chain` as for
`vault`. Nothing is resolved by guessing: the two readings of a mismatch are different contracts on
different chains.

Every result that names a vault carries `chain` and `chainId`. On a prepared envelope they come
before the calls, and every call inside carries the same `chainId`: a call is correct on that chain
only. Sent on another chain, a transaction to an address with no contract there is mined and does
nothing.

**The agent asks, the tool does not choose.** When the operator has not said which chain to deposit
on, the skill has the agent show `earn_vaults` → `chains` and ask. Withdrawals, quotes and balances
on an existing position need no question: the vault names the chain.

Amounts are decimal strings in the vault's asset (`"25"`, `"0.05"`): USDC, or USDG on Robinhood Chain.
The arguments and fields named for USDC (`amount_usdc`, `usdcValue`) keep those names for every asset.
More fractional digits than the asset has (6 for both) are refused, never truncated. Shares never cross the boundary as numbers — only as an exact string.

---

## `earn_vaults` — READ

No inputs. Every vault in the registry, on every chain, with its chassis, decimals and **measured** deposit-open
status (the block and method it was measured at). Each row carries the vault's public identity:

- `symbol` — the vault's own ERC-20 ticker, e.g. `tlCashPlusUSDC2`, as `symbol()` reports it;
- `name` — the vault's `name()`;
- `chain` and `chainId` — the chain the vault is on, e.g. `"arbitrum"` and `42161`;
- `address` — the contract itself, on that chain;
- `links` — `explorer` always (the chain's own: BaseScan, Arbiscan, or Robinhood Chain's Blockscout), and `app` where the chassis has a front end whose page for this vault exists. **These need no
  RPC endpoint.** They are how an operator verifies, without this client's help, that the address
  about to be used is the vault it claims to be;
- `warning` — what to show before preparing a deposit into this vault. Show it; do not summarise it.
  It is repeated on every response that commits money — see `earn_prepare_deposit` below — so a
  caller who never lists still receives it.

And, once per response:

- `chains` — the chains a deposit can go to, the default chain first. Each entry is
  `{ chain, chainId, name, default, defaultAccess, depositable }`: that chain's default vault, its
  access, and the vaults on that chain any account can deposit into. This is what an agent shows an
  operator who has not chosen a chain;
- `defaultChain` — the chain used when a tool is called with neither `vault` nor `chain`;
- `default` — the vault used in that case: the default chain's default;
- `defaultAccess` — `"open"` if the default takes deposits from any account, `"whitelist"` if only
  admitted ones;
- `depositable` — those any account can put money into today, across all chains: ERC-4626 chassis and measured open.
  **May be empty.** An empty set is a state of the offering, not a fault.

## `earn_terms` — READ

No inputs. The pre-deposit disclosures, verbatim. The skill shows them to the operator and records
an acknowledgement before building a first deposit.

## `earn_status` — READ

| input | |
|---|---|
| `vault` | optional ticker |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | optional address |
| `amount_usdc` | optional; the amount the simulated deposit uses |

With **no `account`**, a health check: chain, chain id, latest block, registry version, and *which
environment variable* supplied the RPC — never the URL. Returns a verdict when the RPC is
unreachable; it does not throw. Each chain has its own RPC, so pass `chain` to check the one you are
about to use. Its `server: "treasury"` field keeps the name it had when this ran as a server, so the
result stays the same JSON; it names the program, not a running process. `rpc` is one of:

| `rpc` | meaning |
|---|---|
| `ok` | the endpoint answered. For a configured endpoint, `chainVerified` says whether it also said it is this chain: `false` means it answered a block number and would not say which chain it is |
| `unreachable` | the endpoint did not answer; `reason` says why, without the URL |
| `wrong_chain` | the configured endpoint answers for a different chain (`rpcChainId`). Reads through it fail with "returned no data", because the vault has no contract there. Point the variable `reason` names at an endpoint for this chain |

When a separate logs endpoint is configured (`TREASURY_LOGS_RPC_BASE`, `TREASURY_LOGS_RPC_ARBITRUM`,
`TREASURY_LOGS_RPC_ROBINHOOD`),
the result also carries `logsRpc` (`ok`, `wrong_chain` or `unreachable`) and `logsRpcSource`: that is
the endpoint `earn_balance` reads through, and it can be wrong on its own.

The same check runs inside every tool that reads the chain. With `account`, `earn_status` — like
`earn_quote` and `earn_balance` — refuses with *"the endpoint in `<variable>` answers for chain N,
not …"* instead of returning a verdict read from the wrong chain.

With `account`, the access verdict for that account from a **simulated `deposit()`**:

| status | meaning | next step |
|---|---|---|
| `OPEN_READY` | the deposit would succeed as-is; allowance already covers it | build |
| `NEEDS_APPROVAL` | the deposit reached the token pull; access is open, the allowance is not set | build — the first call is the approve |
| `WHITELIST_GATED` | the vault admits only whitelisted accounts, and this is not one | stop; admission is a fund-side action, not a retry |
| `REVERTED_OTHER` | it reverted for a reason the client could not classify; `findings` lists candidates | stop and show the findings |
| `REFUSED_BY_CLIENT` | the registry row and the chain disagree (e.g. decimals) | stop; a client defect or a stale registry |
| `UNRESOLVED` | the RPC failed | stop; not a verdict about the vault |

The `mode` field says which of the two answers you got. `advisory.maxDepositRaw` is reported but
never trusted: `maxDeposit()` says "unlimited" behind a whitelist on one chassis and `0` on an open
vault on another.

## `earn_quote` — READ

| input | |
|---|---|
| `vault` | optional ticker |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | required |
| `amount_usdc` | required |
| `direction` | required, `"deposit"` or `"withdraw"`; echoed back on the result |

**`deposit`:** expected shares (`previewDeposit`), share price, and the same pre-flight verdict as
`earn_status`. No rate is quoted: an ERC-4626 vault exposes none, and this client calls no yield
API. What a position has actually earned comes from `earn_balance`, from the vault's own events. `canProceed` is false unless the verdict allows it.

**`withdraw`:** shares that would burn (`previewWithdraw`), shares held, a **simulated `withdraw()`**
verdict (`OK`, or `REVERTED` with the chain's revert reason; on a Fusion vault, which pays only from its
own balance, also in liquidity terms), the vault's `instantLiquidity`, and
`maxWithdraw` as an advisory only.

## `earn_balance` — READ

| input | |
|---|---|
| `vault` | optional ticker |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | required |
| `lookback_blocks` | optional; default is from the vault's deployment block, i.e. the whole history |
| `max_log_requests` | optional; cap on `eth_getLogs` calls per event per scan, default 100 |

A position is in one vault, on that vault's chain. An account's positions on different chains are
separate calls, and an empty result on one chain says nothing about another.

Returns: `chain` and `chainId`, `sharesExact` (the string to hand back for a full withdrawal), `shares` (display),
`usdcValue`, `sharePriceInAssets`, `entryBasisUsdc`, `accruedYieldUsdc`, and two
objects worth reading carefully:

- **`exit`** — `exitableNow` is what a withdrawal of the whole position would actually return at
  this block, measured by simulating it; `measuredAs` says how; `instantLiquidity` is the vault's
  liquid balance; `maxWithdrawSays` is the advisory figure the vault reports, which can be far larger.
- **`scan`** — where the history was read from and how much of it. 🔴 **Read `scan.wholeHistory`,
  not `scan.complete`.** `complete` only says shares in − shares out reconciles, which an empty
  window does vacuously; `wholeHistory` says the scan reached the deployment block and was not cut
  short. Only then are `entryBasisUsdc` and `accruedYieldUsdc` numbers; otherwise they read
  `unknown`. `scan.source` says `"fallback"` when the configured RPC could not cover the range and the
  public fallback did — see [`configuration.md`](configuration.md).
- **`scan.depositTxs` / `scan.withdrawTxs`** — the transactions behind those events, oldest first:
  `txHash`, `blockNumber`, `amountUsdc`. Paste `txHash` after the explorer's `/tx/` to show an
  operator what landed; `earn_vaults` gives the vault's own `links.explorer`. These come from the
  logs the basis scan already fetched, so they cost no extra request — and they carry the same
  caveat as the basis: they are the events **inside the scanned window**, which is the whole history
  only when `wholeHistory` is true. Each list holds at most 100 entries, the most recent; `deposits`
  and `withdrawals` remain the totals, so a truncated list is visible by comparing the two.

## `earn_prepare_deposit` — PREPARE

| input | |
|---|---|
| `vault` | optional ticker |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for) |
| `account` | required; the depositing account, which signs both calls |
| `amount_usdc` | required |
| `receiver` | required; where the **shares** land — usually the account, not necessarily |

Returns `{ requires_signature: true, status: "unsigned", chain, chainId, warning, next_step, signer_rules, calls: [approve, deposit] }`. Each call is
`{ chainId, to, data, function, args, value, description, gasAdvice, precondition? }`. Hand them to your signer
**in order**, on the chain `chainId` names; the deposit's precondition names the allowance the approve must have set. Nothing has
happened until the signer's transactions confirm.

The approve is on the vault's own asset on that chain (USDC, or USDG on Robinhood Chain) and names that
chain's vault as the spender. An asset on one chain cannot be deposited into a vault on another;
Treasury does not bridge.

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
- **They cannot disagree with `data`.** Both are produced at one call site from one argument tuple,
  and the parameter names are read off the same ABI entry that encodes the bytes. There is no
  decode step to drift (see `encodeCall` in `src/build.ts`).
- **The parameter NAMES are this client's; the bytes are the contract's.** An explorer labels its
  form from the verified contract's own ABI, which may name a parameter differently. The values,
  their order and their types are what bind — if a label differs, fill by position.

`warning` is the vault's own disclosure, repeated here rather than left at discovery — **show it
before the signer sees the calls, verbatim**. Every response that commits money carries it:
`earn_status`'s pre-flight verdict, `earn_quote` on the deposit side, and this one. Withdrawals
deliberately do not: the risk it describes is committing funds, not retrieving them, and a
disclosure repeated where it does not apply is what teaches a reader to skip it.

## `earn_prepare_withdraw` — PREPARE

| input | |
|---|---|
| `vault` | optional ticker |
| `chain` | optional; see [`chain`](#chain--which-chain-a-call-is-for). A position is withdrawn on the chain it is on: name the vault |
| `account` | required; whose shares are burnt |
| `receiver` | required; where the **asset** (USDC; USDG on Robinhood Chain) lands — not necessarily the account |
| `amount_usdc` | the amount of the vault's asset to withdraw (`withdraw(assets, receiver, owner)`) |
| `all` + `shares_exact` | instead of an amount: empty the account by `redeem` of the exact share string from `earn_balance.sharesExact`, verbatim |

Same envelope, without `warning`. Quote first: the simulated verdict is what tells you whether the vault can pay this
out now, and the agent must be told before signing.

## `earn_claim` — READ

| input | |
|---|---|
| `receipt_id` | required |

Finalizes a queued withdrawal on chassis that settle asynchronously. No vault offered today queues —
they settle in the withdraw transaction — so this reports that nothing is claimable. It exists so a
consumer can code against the full contract before an asynchronous chassis is added.

---

## The connect commands — `treasury connect <command>`

These hand calls to the operator's own wallet instead of returning them: a browser wallet (MetaMask,
Rabby, Coinbase Wallet), or a Privy embedded wallet opened with an email, Google, Apple or X login.
Coinbase Wallet's own entry in the sign-in window (the Coinbase SDK, for its mobile app or a smart
wallet) is untested in this release ([#88](https://github.com/TemporaLabs/treasury/issues/88)). That
entry is separate from the Coinbase Wallet browser extension, which, like any wallet installed in the
browser, is listed on the window's first screen.
A page opens on the operator's machine, at a one-time URL on `http://localhost:53682` that the command
also prints on stderr; they read each call there and
confirm it in the wallet. Nothing here signs. See [`security-model.md`](security-model.md#the-wallet-connection-treasury-connect).

| command | flags | does |
|---|---|---|
| `connect status` | — | the connected account and how it signed in (`external` / `embedded`), or `disconnected`; reads a local file only |
| `connect wallet` | — | opens the sign-in page: one Connect button, then Privy's window. The wallet signs a free sign-in message; waits up to 9 minutes and returns `{ status: "connected", account, walletType, connectedAtIso, opened }`. If the sign-in does not finish, it exits 1 with `not connected: <reason>` |
| `connect deposit` | `--amount_usdc`, `--receiver`, optional `--vault`, `--chain`, `--ack` | builds approve + deposit for the connected account and checks them against the registry. Without `--ack`, opens nothing and returns the operator's acknowledgement; with its code, hands each call to the wallet in turn |
| `connect withdraw` | `--receiver`, then `--amount_usdc` or `--all --shares_exact`, optional `--vault`, `--chain`, `--ack` | the same for a withdrawal |
| `connect disconnect` | — | forgets the connected account; moves nothing |

`--receiver` must be the connected account: this page pays no one else. It comes from the operator's
own message, never from the agent. To pay a different address, use `earn prepare_deposit` /
`earn prepare_withdraw` with the operator's own signer.

### The acknowledgement before the page opens

`connect deposit` and `connect withdraw` open nothing on their first run. They build and gate-check
the calls, then return

`{ status: "needs_acknowledgement", opened: false, action, amount, chain, chainId, vault, account, receiver, acknowledgement, ack, expiresAtIso, next_step }`

`acknowledgement` is one fixed text, written by the CLI and not by the agent: the action and amount,
the chain, the vault's name, symbol and explorer link, the receiver, how many wallet prompts to
expect (a deposit asks twice, approve then deposit; a withdrawal once), the vault's warning, and the
disclosures in plain words: a short form of [`earn terms`](#earn_terms--read) before a deposit, and
before a withdrawal only the two points that hold for every action. It says the full terms can be
asked for; `earn terms` returns them, and the skill still shows them in full before a first deposit.
It ends by asking for a yes or a no. The agent posts it to the operator word for word.

On the operator's yes, the same command run again with `--ack <ack>` opens the page. The code is
refused, and nothing opens, when:

- it is not the pending acknowledgement's code (each first run replaces the one before);
- it was already used: each acknowledgement opens one page;
- it is more than 15 minutes old;
- the calls differ from the ones acknowledged (another amount, vault, chain, receiver, direction or
  connected account).

A `connect wallet` that completes a sign-in, or a `connect disconnect`, clears any pending
acknowledgement; a sign-in that does not finish leaves it as it was. The pending one
sits beside the session file (`connect-ack.json`, owner-readable only) and holds a digest of the calls,
not the calls.

### What the confirm flow returns

With `--ack`, `connect deposit` and `connect withdraw` return
`{ status, chain, chainId, account, opened, reason?, calls_total, txs, next_step }`; `opened` says
whether a browser was opened or only the URL printed. `txs` has one entry per transaction,
`{ step, description, hash, verified, detail?, alsoMoved? }`, with `step` the call's position in the
flow. An entry with `step: 0` is a transaction the page reported but could not tie to a step of this
flow; it is always `unverified`, so look its hash up before retrying anything. `verified` is read from
the receipt:

| `verified` | meaning |
|---|---|
| `matched` | the vault's (or token's) own event for the connected account and the exact amount is there, and no other transfer of the vault's asset left the account |
| `extra_transfer` | as `matched`, but the account ALSO sent the asset elsewhere in the same transaction (`alsoMoved`) — often a wallet's fee for paying gas in tokens. Tell the operator |
| `mismatch` | the transaction succeeded without the expected event, or was mined before this flow started (an older transaction, not this one). Stop |
| `reverted` | it failed on chain; nothing it was meant to do happened |
| `unverified` | no receipt in time; look the hash up before retrying anything |

The flow stops at the first transaction that is not `matched` or `extra_transfer`, and sends nothing
after it. A call declined in the wallet sent nothing, so the page stays open to confirm it again or
cancel. Before the first call the page shows the wallet's balances, read once, and warns when a deposit
needs more than the wallet holds or there is nothing for the network fee; the warnings never block the
button. Each sent transaction is linked on the chain's explorer. The result's `status` says how the whole flow ended:

| `status` | meaning |
|---|---|
| `completed` | every call of the flow landed (`txs` has `calls_total` entries, each `matched` or `extra_transfer`) |
| `stopped` | the flow ended before every call landed; `reason` says why, and the last entry's `verified` and `detail` give the transaction's own verdict. An approval whose allowance does not show on the RPC within about a minute stops here, with the deposit not sent |
| `not_reported` | the page reported no transaction (cancelled, or nine minutes passed). This is not proof that none was sent: if the wallet showed a confirmation, check `earn balance` before any retry |

Each command returns within nine minutes, however slow the RPC is; a transaction still being
checked then is listed as `unverified`. A cancel waits up to 30 seconds for a check already in
progress, so it can report that transaction's verdict. The confirm page will not start a step with
less than a minute left, and a transaction hash is accepted only once per flow.

---

## Failure paths, in general

- A keyed RPC URL never appears in any output, on any path, including thrown errors.
- The health path returns a verdict when the RPC is down; it does not throw.
- A scan that could not finish says so in `scan` rather than returning a partial sum as a number.
- Every refusal names its reason and the next step.
