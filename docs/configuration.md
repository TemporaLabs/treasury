# Configuration

Treasury reads the four environment variables below and nothing else that an operator can set. A
test pins the exact set — the four here plus `TREASURY_FORK`, a switch only the fork test tier reads,
never the shipped code — so a variable read anywhere else in the package fails the build.

| variable | purpose | unset |
|---|---|---|
| `TREASURY_RPC_BASE` | the Base RPC every tool reads through | falls back to `BASE_RPC_URL`, then to Base's public endpoint `https://mainnet.base.org`, which rate-limits after a handful of calls |
| `TREASURY_LOGS_RPC_BASE` | the RPC `earn_balance` scans `Deposit`/`Withdraw` events through — a provider with a wide `eth_getLogs` window | uses `TREASURY_RPC_BASE` |
| `TREASURY_LOGS_FALLBACK` | where a scan goes when the configured RPC cannot cover the range: an `http(s)` URL, or anything that is not a URL (`off`, `disabled`, …) to forbid a fallback | Base's public endpoint |
| `BASE_RPC_URL` | a conventional alias, honoured when Treasury runs outside the plugin | — |

**A keyed RPC URL is a secret.** Treasury treats it as one: no tool output, no error, no health check
ever repeats it. `earn_status` reports *which variable* supplied the RPC, never its value.

**A keyed RPC out of quota is reported as itself.** `Monthly capacity limit exceeded`, `quota`, or
another sentence about your plan means the key is out of quota for the billing period; the tools do
not wait for that — it resets when the provider says it does — so they report the provider's own
sentence at once. The vault is fine; the key is the problem. A plain `429` that carries no such
sentence, a per-second throttle, is retried with backoff until the request's deadline, then reported
as a `429`.

## Through the plugin

The plugin ([TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin)) forwards exactly `TREASURY_RPC_BASE` and `TREASURY_LOGS_RPC_BASE` from the host environment — that is
the contract its manifest honours. The server it spawns also inherits its parent's environment, so
`TREASURY_LOGS_FALLBACK` reaches it on the plugin path too. When a forwarded variable is unset, Claude Code passes
the literal placeholder `${TREASURY_RPC_BASE}` — Treasury recognises a placeholder as "not a URL" and
falls back, so an unset variable is never mistaken for an endpoint.

## `eth_getLogs` windows — why there are two RPC variables

Providers cap the block range a single `eth_getLogs` may cover: some free tiers at **10 blocks**,
Base's public endpoint at **2,000**, paid plans far wider. `earn_balance` scans from the vault's
deployment block, so on a narrow window a whole-history scan can need thousands of requests.

What Treasury does about it, in order:

1. It learns the window from the provider's own error message (the stated limit is parsed, never
   guessed) and walks the range in chunks of that size, up to `max_log_requests` per event.
2. If the configured provider cannot finish the range, the scan moves to the fallback endpoint and the
   result says so: `scan.source: "fallback"`. You do not retry anything.
3. If the fallback is forbidden, or also cannot finish, the scan stops where it is and says how far it
   got: `scan.capped: true`, `scan.wholeHistory: false`, and the basis and yield read `unknown`.

For a vault with a long history, set `TREASURY_LOGS_RPC_BASE` to a provider with a wide window. Until
then, `scan` says exactly how much was covered, and no partial sum is ever presented as a number.

## An operator who may not query a third party

Set `TREASURY_LOGS_FALLBACK=off`. It fails closed: an unrecognised value turns the fallback off rather
than quietly keeping the default, so a typo cannot re-enable a query to an endpoint you did not name.

## What Treasury never does with the network

No telemetry. No analytics. No call to any host but the RPC endpoints above — there is no yield
API, no vendor endpoint, and no code path that could add one without a code change. The
boundary test enforces that no code under the package reaches any other module, environment variable
or process.
