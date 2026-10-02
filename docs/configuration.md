# Configuration

Treasury reads the seven environment variables below and nothing else that an operator can set. A
test pins the exact set — the seven here plus `TREASURY_FORK`, a switch only the fork test tier reads,
never the shipped code — so a variable read anywhere else in the package fails the build.

**Each chain has its own variables, and a chain reads only its own.** An Arbitrum call never falls
back to a Base endpoint: the same address read on the wrong chain answers with empty data, which
looks like an empty position, not like a misconfiguration.

| variable | purpose | unset |
|---|---|---|
| `TREASURY_RPC_BASE` | the Base RPC every tool reads through for a vault on Base | falls back to `BASE_RPC_URL`, then to Base's public endpoint `https://mainnet.base.org`, which rate-limits after a handful of calls |
| `TREASURY_LOGS_RPC_BASE` | the RPC `earn_balance` scans `Deposit`/`Withdraw` events through on Base — a provider with a wide `eth_getLogs` window | uses `TREASURY_RPC_BASE` |
| `BASE_RPC_URL` | a conventional alias, honoured when Treasury runs outside the plugin | — |
| `TREASURY_RPC_ARBITRUM` | the Arbitrum One RPC every tool reads through for a vault on Arbitrum One | falls back to `ARBITRUM_RPC_URL`, then to Arbitrum's public endpoint `https://arb1.arbitrum.io/rpc`, which also rate-limits |
| `TREASURY_LOGS_RPC_ARBITRUM` | the RPC `earn_balance` scans events through on Arbitrum One | uses `TREASURY_RPC_ARBITRUM` |
| `ARBITRUM_RPC_URL` | a conventional alias, honoured when Treasury runs outside the plugin | — |
| `TREASURY_LOGS_FALLBACK` | where a scan goes when the configured RPC cannot cover the range: an `http(s)` URL for a Base endpoint, or anything that is not a URL (`off`, `disabled`, …) to forbid a fallback on every chain | the chain's own public endpoint |

**Check a chain's RPC with `earn_status` and `chain`.** It reports which variable supplied the
endpoint, and `rpc: "wrong_chain"` when that endpoint answers for a different chain — the likeliest
mistake once there are two variables.

**A keyed RPC URL is a secret.** Treasury treats it as one: no tool output, no error, no health check
ever repeats it. `earn_status` reports *which variable* supplied the RPC, never its value.

**A keyed RPC out of quota is reported as itself.** `Monthly capacity limit exceeded`, `quota`, or
another sentence about your plan means the key is out of quota for the billing period; the tools do
not wait for that — it resets when the provider says it does — so they report the provider's own
sentence at once. The vault is fine; the key is the problem. A plain `429` that carries no such
sentence, a per-second throttle, is retried with backoff until the request's deadline, then reported
as a `429`.

## Through the plugin

The plugin (the [`plugin/`](../plugin/) folder of this repository; its server declaration is
[`plugin/.mcp.json`](../plugin/.mcp.json)) forwards exactly `TREASURY_RPC_BASE`, `TREASURY_LOGS_RPC_BASE`, `TREASURY_RPC_ARBITRUM` and `TREASURY_LOGS_RPC_ARBITRUM` from the host environment — that is
the contract its manifest honours. The server it spawns also inherits its parent's environment, so
`TREASURY_LOGS_FALLBACK` reaches it on the plugin path too. When a forwarded variable is unset, the
`${VAR:-}` default in `.mcp.json` passes an empty string. Treasury treats an empty value, or an
unexpanded `${…}` placeholder from a host that does not apply the default, as unset and falls back,
so an unset variable is never mistaken for an endpoint.

## `eth_getLogs` windows — why each chain has two RPC variables

Providers cap the block range a single `eth_getLogs` may cover: some free tiers at **10 blocks**,
Base's public endpoint at **2,000**, Infura on Arbitrum One at **10,000**, paid plans far wider.
`earn_balance` scans from the vault's deployment block, so on a narrow window a whole-history scan
can need thousands of requests.

Arbitrum One produces a block about every quarter of a second, so its ranges are roughly eight
times Base's for the same time span: a vault deployed a week ago is about 2.4 million blocks back.
Measured 2026-10-02, Arbitrum's public endpoint served an 800,000-block range in one request.

What Treasury does about it, in order:

1. It learns the window from the provider's own error message (the stated limit is parsed, never
   guessed) and walks the range in chunks of that size, up to `max_log_requests` per event.
2. If the configured provider cannot finish the range, the scan moves to the fallback endpoint and the
   result says so: `scan.source: "fallback"`. You do not retry anything.
3. If the fallback is forbidden, or also cannot finish, the scan stops where it is and says how far it
   got: `scan.capped: true`, `scan.wholeHistory: false`, and the basis and yield read `unknown`.

For a vault with a long history, set that chain's logs variable (`TREASURY_LOGS_RPC_BASE`,
`TREASURY_LOGS_RPC_ARBITRUM`) to a provider with a wide window. Until then, `scan` says exactly how
much was covered, and no partial sum is ever presented as a number.

## An operator who may not query a third party

Set `TREASURY_LOGS_FALLBACK=off`. It fails closed: an unrecognised value turns the fallback off rather
than quietly keeping the default, so a typo cannot re-enable a query to an endpoint you did not name.
The opt-out applies on every chain.

A URL in `TREASURY_LOGS_FALLBACK` names a Base endpoint. On Arbitrum One it is not used — it would
answer for the wrong chain — and because the variable is set, no other fallback is used there
either: you named where this process may talk, and Arbitrum's public endpoint is not it. For history
on Arbitrum One, set `TREASURY_LOGS_RPC_ARBITRUM`.

## What Treasury never does with the network

No telemetry. No analytics. No call to any host but the RPC endpoints above — there is no yield
API, no vendor endpoint, and no code path that could add one without a code change. The
boundary test enforces that no code under the package reaches any other module, environment variable
or process.
