# The tools

Eight tools, all prefixed `earn_`. Two kinds: **READ** tools query the chain and return facts;
**PREPARE** tools return unsigned calls for your signer. Nothing signs, sends or transfers, and CI
asserts the tool list exactly — a ninth tool, or a `sign`, fails the build.

Every tool that takes a vault takes it as `vault`, a registry slug, and uses the default when it is
omitted. Every tool that takes an address takes it as `account` — whose shares these are.
`earn_prepare_withdraw` also takes `receiver`, which is a different thing (where the USDC lands).

Amounts are decimal strings in USDC (`"25"`, `"0.05"`). More fractional digits than USDC has (6) are
refused, never truncated. Shares never cross the boundary as numbers — only as an exact string.

---

## `earn_vaults` — READ

No inputs. Every vault in the registry with its chassis, decimals and **measured** deposit-open
status (the block and method it was measured at). Each row carries the vault's public identity:

- `symbol` — the vault's own ERC-20 ticker, e.g. `tlCashPlusUSDC2`, as `symbol()` reports it;
- `displayName` — the vault's `name()`;
- `address` — the contract itself;
- `links` — `explorer` always, and `app` where the chassis has a known front end. **These need no
  RPC endpoint.** They are how an operator verifies, without this client's help, that the address
  about to be used is the vault it claims to be;
- `warning` — what to show before preparing a deposit into this vault. Show it; do not summarise it.

And, once per response:

- `default` — the vault used when a tool is called without `vault`;
- `defaultAccess` — `"open"` if the default takes deposits from any account, `"whitelist"` if only
  admitted ones;
- `depositable` — those any account can put money into today: ERC-4626 chassis and measured open.
  **May be empty.** An empty set is a state of the offering, not a fault.

## `earn_terms` — READ

No inputs. The pre-deposit disclosures, verbatim. The skill shows them to the operator and records
an acknowledgement before building a first deposit.

## `earn_status` — READ

| input | |
|---|---|
| `vault` | optional slug |
| `account` | optional address |
| `amount_usdc` | optional; the amount the simulated deposit uses |

With **no arguments**, a health check: chain id, latest block, registry version, and *which
environment variable* supplied the RPC — never the URL. Returns a verdict when the RPC is
unreachable; it does not throw.

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
| `vault` | optional slug |
| `account` | required |
| `amount_usdc` | required |
| `direction` | required, `"deposit"` or `"withdraw"`; echoed back on the result |

**`deposit`:** expected shares (`previewDeposit`), share price, and the same pre-flight verdict as
`earn_status`. No rate is quoted: an ERC-4626 vault exposes none, and this client calls no yield
API. What a position has actually earned comes from `earn_balance`, from the vault's own events. `canProceed` is false unless the verdict allows it.

**`withdraw`:** shares that would burn (`previewWithdraw`), shares held, a **simulated `withdraw()`**
verdict (`OK` or `REVERTED` with the reason in liquidity terms), the vault's `instantLiquidity`, and
`maxWithdraw` as an advisory only.

## `earn_balance` — READ

| input | |
|---|---|
| `vault` | optional slug |
| `account` | required |
| `lookback_blocks` | optional; default is from the vault's deployment block, i.e. the whole history |
| `max_log_requests` | optional; cap on `eth_getLogs` calls per event per scan, default 100 |

Returns: `sharesExact` (the string to hand back for a full withdrawal), `shares` (display),
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

## `earn_prepare_deposit` — PREPARE

| input | |
|---|---|
| `vault` | optional slug |
| `account` | required; the depositing account, which signs both calls |
| `amount_usdc` | required |
| `receiver` | required; where the **shares** land — usually the account, not necessarily |

Returns `{ requires_signature: true, status: "unsigned", calls: [approve, deposit] }`. Each call is
`{ to, data, value, description, gasAdvice, precondition? }`. Hand them to your signer **in order**;
the deposit's precondition names the allowance the approve must have set. Nothing has happened until
the signer's transactions confirm.

## `earn_prepare_withdraw` — PREPARE

| input | |
|---|---|
| `vault` | optional slug |
| `account` | required; whose shares are burnt |
| `receiver` | required; where the **USDC** lands — not necessarily the account |
| `amount_usdc` | the USDC to withdraw (`withdraw(assets, receiver, owner)`) |
| `all` + `shares_exact` | instead of an amount: empty the account by `redeem` of the exact share string from `earn_balance.sharesExact`, verbatim |

Same envelope. Quote first: the simulated verdict is what tells you whether the vault can pay this
out now, and the agent must be told before signing.

## `earn_claim` — READ

| input | |
|---|---|
| `receipt_id` | required |

Finalizes a queued withdrawal on chassis that settle asynchronously. No vault offered today queues —
they settle in the withdraw transaction — so this reports that nothing is claimable. It exists so a
consumer can code against the full contract before an asynchronous chassis is added.

---

## Failure paths, in general

- A keyed RPC URL never appears in any output, on any path, including thrown errors.
- The health path returns a verdict when the RPC is down; it does not throw.
- A scan that could not finish says so in `scan` rather than returning a partial sum as a number.
- Every refusal names its reason and the next step.
