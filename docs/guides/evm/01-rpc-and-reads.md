# 01: RPC endpoints and read clients

`src/client.ts` is the only place a chain is described, and it constructs exactly one kind of thing:
a read-only (public) viem client. There is no wallet client anywhere in the package.

## One table per chain

`chains` maps each supported chain id to viem's chain definition. `CHAIN_INFO` adds what this client
needs: the key a caller types (`base`, `arbitrum`, …), the display name, the RPC variables in the
order they are tried, the logs variable, and the public endpoint. It is typed
`Record<SupportedChainId, ChainInfo>`, so a chain in `chains` without a row here does not compile.
`supportedChainIds` fixes the display order (the order chains were added), and
`tests/client.unit.test.ts` holds it equal to the keys of `chains`.

Solana is not a row of `CHAIN_INFO`: it has no chain id and no `eth_getLogs`. `SOLANA_INFO` follows
the same rules (its own variables, then its public endpoint).

## Choosing the endpoint

- `rpcUrlFromEnv(chainId)` tries the chain's own variables, then its public endpoint. **A chain reads
  only its own variables**: an Arbitrum call never falls back to a Base endpoint, because the vault's
  address has no contract there and the error would look like a broken vault.
- `rpcUrlFromEnvValue` treats anything that is not an `http(s)` URL as unset, including an
  unexpanded `${VAR}` placeholder a host may forward verbatim.
- `logsRpcUrlFromEnv` prefers the chain's logs variable for event scans; `logsFallbackUrlFromEnv`
  decides the scan's fallback, and fails closed when the operator set `TREASURY_LOGS_FALLBACK` to
  anything unrecognised.
- `rpcSourceForEnv` reports which variable supplied the URL, by name only. That name is what
  `earn status` shows; the value never leaves the process.

## The client

`makePublicClient` sets three things deliberately, each explained in its comment:

- `retryCount: 0`, because `makeRateLimitedFetch` owns the retry policy and the two would multiply;
- `timeout: RPC_TIMEOUT_MS`, the whole-call deadline the rate-limit wrapper races against;
- `ccipRead: false`, which closes the one path by which a contract could make viem fetch a URL of its
  choosing. With it on, "the RPC you configure and nothing else" would not be true.

`makeRateLimitedFetch` waits out HTTP 429 (honouring `Retry-After`, capped in total by
`RATE_LIMIT_WAIT_MS`) but returns at once on the measured "capacity limit exceeded" body, since a
plan out of quota will not recover in seconds. An unreachable host is not retried: that is a fault to
report quickly, not a limit to wait for.

## Is the endpoint on the right chain?

`endpointChainId` asks an endpoint for its chain id once per URL per run, bounded by `CHAIN_PROBE_MS`;
`firstEndpointOnWrongChain` checks a list. The earn commands run this beside their reads
(`onItsChain` in `src/earn/commands.ts`) so a healthy call pays no extra round trip, and a mismatch is
reported in place of the reads' own confusing errors. `earn status` with no account reports
`rpc: "wrong_chain"` as a verdict rather than throwing.

## Keeping secrets out of output

A keyed RPC URL is a secret. `resolvedRpcSecrets` lists every value this process could be holding
(each URL and its credential-bearing parts), and `registerSecretSource` hands that list to
`src/redact.ts`. `describeError` then builds a one-line message from viem's `shortMessage` and
`details`, and `redactEndpoints` masks those literal values and any URL shape. Every read failure in
this package goes through `describeError`; a new one must too. The guarantee itself is stated in
[`../../security-model.md`](../../security-model.md#secrets-in-output).

## Amounts

`parseAmount` and `formatAmount` (`src/units.ts`) convert between a decimal string in the asset's own
decimals and a bigint of base units. More fractional digits than the token has is refused, never
truncated, and a zero or negative amount is refused. Amounts never pass through a float, and a share balance is never
rounded: `sharesExact` from `earn balance` is handed back verbatim to redeem everything.
