# Security model

One sentence: **Treasury supplies judgement; your signer supplies the gate.** Everything below is
how that sentence is made true in code rather than in a promise.

## The boundary

Treasury has exactly two kinds of tool. READ tools query the chain and return facts. PREPARE tools
return unsigned calls. There is no EXECUTE kind, and adding one is a design change the project refuses.

```
   agent ──▶ Treasury ──▶ { requires_signature: true, status: "unsigned", calls: [...] }
                                              │
                          your signer — a wallet, a policy engine, a token-bound account
                                              │
                                            chain
```

The envelope is the point: an unsigned build is **structurally distinguishable** from anything that
has happened. A consumer, a test, or a policy engine can assert on `requires_signature` and
`status: "unsigned"` rather than parsing prose. (The library functions `buildDeposit` /
`buildWithdraw` return bare arrays; the envelope belongs to the MCP boundary. If you consume the
library directly, you are the boundary.)

## What enforces it

**`tests/boundary.unit.test.ts`** parses every TypeScript file under the package with the TypeScript
compiler and fails the build if any file:

- imports, requires or dynamically loads anything outside the package and its three declared
  dependencies (`@modelcontextprotocol/sdk`, `viem`, `zod`);
- reads an environment variable that is not on the allowlist of four
  ([`configuration.md`](configuration.md)), or reads one with a computed key;
- starts a process, except three named files — two test tiers that spawn the reconciliation script and
  a fork node against a mock or a local fork, and the round-trip harness under `scripts/`;
- reaches a private test seam from shipped code.

It is written as an analysis of the AST, not a grep for a string, because a rename defeats a grep and
a template literal defeats a regex. It has a control: fixtures that *must* fail it, so the gate cannot
go vacuous.

**CI** rebuilds `dist/mcp-server.mjs` from source and fails if the committed bundle differs by a byte;
starts the bundle and asserts the exact tool list, the exact property set of every tool's schema, and
the absence of `sign`, `send` and `transfer`; and, on the public repository, mints a provenance
attestation for the bundle and verifies it before the run can go green
([`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)).

## Keys

Nothing in the package reads, derives, logs or transmits a private key. There is no code path for it.
The fork tier signs by impersonating accounts on a local Anvil fork; the live tier only reads. Who
may deposit into a gated vault is discovered from the chain when a test needs it, and never written
into the repository.

## Secrets in output

A keyed RPC URL is a secret. Every tool handler runs inside a guard that redacts endpoints from
anything it returns or throws; the health check reports which environment variable supplied the
RPC, never its value. This is tested against real provider failure shapes with synthetic keys.

## Measurements, not assumptions

The parts of a vault's interface that lie are not trusted:

- `maxDeposit()` says "unlimited" behind a whitelist on one chassis and `0` on an open vault on
  another — so access is a **simulated `deposit()`** from the account's address.
- `maxWithdraw()` reports an entitlement, not what the vault can pay — so exit is a **simulated
  `withdraw()`** of the whole position.
- an event scan that did not reach the deployment block is not a history — so basis and yield read
  `unknown` unless `scan.wholeHistory` is true.

## What this model does not cover

The vault contracts and the protocols they hold, the RPC provider's honesty, and the agent runtime
that hosts the plugin. Treasury believes the RPC; it cannot verify the chain. And Treasury cannot
stop a model from *reporting* that something was deposited — nothing at an MCP boundary can. What it
can do is make an unsigned build impossible to mistake for a completed one, by shape.
