# 03: A position: value, exit and history

`getPosition` (`src/position.ts`) is what `earn balance` returns for an EVM vault. It answers three
different questions, and the `Position` interface keeps them in separate fields because each can be
known while another is not.

| question | field | how it is answered |
|---|---|---|
| what are the shares worth? | `usdcValue` | `convertToAssets(shares)` |
| what can come out now? | `exit` | up to two simulated withdrawals (`measureExit`) |
| what was put in, and what did it earn? | `entryBasisUsdc`, `accruedYieldUsdc`, `scan` | the vault's own `Deposit` / `Withdraw` events for the account |

`sharesExact` is the exact share balance as a string, to hand back verbatim for a full redemption.

`earn balance` (`src/earn/commands.ts`) runs every read of this function through the chain's logs
endpoint (`logsRpcUrlFromEnv`), passes the fallback client when there is one, and checks both
endpoints are on the vault's chain: a fallback on the wrong chain would answer the scan with an empty
list that looks like a complete history.

## The exit is simulated, not read

`maxWithdraw()` reports an entitlement, not what the vault can pay, and the vault's idle balance is
the ceiling on one chassis and not on another. So `measureExit` simulates a withdrawal of the whole
position first and, if the vault refuses, one bounded by the vault's liquid balance. `measuredAs`
says which bound produced `exitableNow`. A simulation that did not complete is `"not measured"` with
`exitableNow: "unknown"`, and its note says it is a failure to ask, not an answer. The exit has its
own time budget, taken before the scan's, so the two never share a clock.

## The event scan, and when its numbers count

The scan reads `Deposit` and `Withdraw` events for the account from the vault's `deployedAtBlock`
(the registry row), or from a lookback when the row has none. Providers cap the block range of one
`eth_getLogs`, so the walk works in chunks sized from the provider's own error (`rangeLimitFromError`),
bounded by a request count and a wall-clock budget (`PositionArgs` documents the defaults).

If the configured logs endpoint cannot cover the range (an error no window can be sized from, or a
window too narrow to finish within the request cap), the scan hands over to a fallback client, the
chain's public endpoint unless `TREASURY_LOGS_FALLBACK` says otherwise. `scan.source` says which
served it; it is set only once the fallback has actually answered.

Two flags decide what the result may claim:

- `scan.complete`: shares in minus shares out equals the balance. It is only a reconciliation, and is
  trivially true for an empty window.
- `scan.wholeHistory`: the scan reached the deployment block, was not cut short, **and** reconciles.

Basis and yield are reported as numbers only when `wholeHistory` is true. Otherwise they carry
`UNKNOWN_INCOMPLETE_SCAN`, or `UNKNOWN_AFTER_SCAN_FAILURE` when nothing could be read, because a sum
over part of a history reports a missed deposit as yield. `scan.note` says what happened in words.

`scan.depositTxs` and `scan.withdrawTxs` list the transactions seen (oldest first, capped by
`MAX_SCAN_TXS`, while the counts stay totals). They are sorted explicitly, because the chunked walk
produces a path-dependent order.

## Changing this file

The tests that guard the scan and the exit are `tests/position-scan.unit.test.ts` and
`tests/position-exit.unit.test.ts`. Most of the comments in `src/position.ts` record a measured
failure; read the one above the code you are changing before you change it.
