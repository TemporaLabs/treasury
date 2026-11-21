# The EVM chains, read directly

> **Scope.** The `earn` and `connect` commands do not read an EVM chain themselves: they go through the Tempora API
> ([`../earn-api/`](../earn-api/README.md)), which lists the vaults, reads positions and quotes, prepares every step
> and reads how it landed. What is left here is the one read-only client this package still builds for an EVM chain.

`src/client.ts` describes every supported chain and builds a read-only viem client. Two things use it: `connect
wallet`, to check a smart-contract wallet's sign-in on Base, and `scripts/registry-check.ts`, which reconciles the
registry's rows against each chain. The RPC variables are in [`../../configuration.md`](../../configuration.md).

| guide | read it when |
|---|---|
| [`01-rpc-and-reads.md`](01-rpc-and-reads.md) | you touch `src/client.ts`, retries, timeouts, redaction or amounts |
