# The EVM path

> **Scope.** The `earn` and `connect` commands no longer use this path on the EVM chains: they go through the Tempora
> API ([`../earn-api/`](../earn-api/README.md)). What is described here is the library (`src/index.ts`), which a
> program holding its own signer can still call, and which the live and fork test tiers exercise.

Everything Treasury does for an ERC-4626 vault: which endpoint it reads through, how it decides an
account can deposit, how quotes and unsigned calls are built, and how a position's value, exit and
history are read. Each command's output fields are documented in [`../../tools.md`](../../tools.md);
the RPC variables and the `eth_getLogs` windows in [`../../configuration.md`](../../configuration.md).

| guide | read it when |
|---|---|
| [`01-rpc-and-reads.md`](01-rpc-and-reads.md) | you touch `src/client.ts`, retries, timeouts, or the wrong-chain check |
| [`02-preflight-quote-build.md`](02-preflight-quote-build.md) | you change a pre-flight verdict, a quote, or the calls the builders emit |
| [`03-position-and-exit.md`](03-position-and-exit.md) | you change `earn balance`: value, exitable amount, event scan |
