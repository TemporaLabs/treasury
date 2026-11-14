# 01: The layers and who owns what

Treasury is a **depositor client**: it knows a vault's address, an RPC endpoint and the vault's
public interface, and nothing about the fund behind the vault. It reads the chain, prepares unsigned
calls, and (through `treasury connect`) hands calls that passed a gate to the operator's own wallet.
It never signs. Why that line is drawn where it is, and what enforces it, is
[`../../security-model.md`](../../security-model.md); this guide is the map of the code.

## Three ways in

| entry | file | what it is |
|---|---|---|
| the command line | `src/cli.ts` | `treasury <skill> <command> [--flag value]`, one JSON document per run, then exit |
| the library | `src/index.ts` | the registry, read clients, pre-flight, quotes, position and the builders, for a program that holds its own signer |
| the Claude Code plugin | `plugin/` | a copy of the bundled CLI plus the Earn skill (`plugin/skills/earn/SKILL.md`), which tells an agent how to use the CLI |

The CLI is the product surface. The plugin runs the same bundle (`plugin/dist/treasury.mjs` is a byte
copy of `dist/treasury.mjs`). The library exports the building blocks without the command boundary:
`buildDeposit` returns a bare array of calls, and the `{ requires_signature, status: "unsigned" }`
envelope is added only by the commands.

## The layers

```
 src/cli.ts                      argv -> flags -> one command -> JSON on stdout
   |
   +-- src/earn/commands.ts      the earn commands: READ and PREPARE
   |     |  EVM vault                        Solana vault
   |     |  src/registry.ts  (resolve)       src/earn/solana.ts
   |     |  src/client.ts    (RPC)             src/solana/rpc.ts, vault.ts,
   |     |  src/preflight.ts, src/quote.ts     kvault.ts, layout.ts, constants.ts
   |     |  src/position.ts
   |     |  src/build.ts     (unsigned calls)
   |
   +-- src/connect/commands.ts   the connect commands: sign in, acknowledge, confirm in the wallet
         src/connect/ack.ts          acknowledgement text, codes, plans
         src/connect/gate.ts         EVM gate over calldata
         src/connect/gate-solana.ts  Solana gate over transaction bytes
         src/connect/http.ts         one-shot loopback server
         src/connect/page.ts         HTML shell + CSP; serves dist/connect-page.js (built from connect-page/)
         src/connect/session.ts      the connection, pending acknowledgement, plan and page lock files
         src/connect/verify.ts       what landed, from the receipt
         src/connect/solana.ts       the same flows on Solana

 src/invest/                     portfolio-withdrawal checks; library code, no command calls it yet
```

Shared underneath everything: `src/registry-schema.ts` (what a vault row is), `src/config/earn.ts`
(defaults), `src/units.ts` (decimal strings to integers and back), `src/redact.ts` (no RPC URL ever
reaches output), `src/links.ts` (explorer links derived from a row), `src/disclosures.ts` (the
pre-deposit text) and `src/version.ts` (the version, inlined at build time).

## Who owns which decision

| decision | owner | guide |
|---|---|---|
| which vaults exist, on which chain, with which asset and decimals | `registry/vaults.json` (data), `src/registry-schema.ts` (rules) | [`../registry/01-the-vault-registry.md`](../registry/01-the-vault-registry.md) |
| which vault a call means when the caller names a chain, a vault, both or neither | `resolveVault` / `resolveAnyVault` in `src/registry.ts` | same |
| which RPC endpoint serves a chain, and whether it is really that chain | `src/client.ts` | [`../evm/01-rpc-and-reads.md`](../evm/01-rpc-and-reads.md) |
| whether an account can deposit | a simulated `deposit()` in `src/preflight.ts` (EVM), a simulated transaction in `src/solana/vault.ts` (Solana) | [`../evm/02-preflight-quote-build.md`](../evm/02-preflight-quote-build.md), [`../solana/01-kamino-vault-path.md`](../solana/01-kamino-vault-path.md) |
| the bytes of a deposit or withdrawal | `src/build.ts` (EVM), `src/solana/kvault.ts` (Solana) | same |
| what a position is worth and what can leave now | `src/position.ts` | [`../evm/03-position-and-exit.md`](../evm/03-position-and-exit.md) |
| what may be put in front of a wallet | `src/connect/gate.ts`, `src/connect/gate-solana.ts` | [`../connect/02-gates.md`](../connect/02-gates.md) |
| whether a page may open at all | `src/connect/ack.ts` | [`../connect/03-acknowledgement-and-plans.md`](../connect/03-acknowledgement-and-plans.md) |
| whether a transaction did what was confirmed | `src/connect/verify.ts`, `verifySolanaLanded` in `src/connect/solana.ts` | [`../connect/04-receipt-verification.md`](../connect/04-receipt-verification.md) |
| which modules, processes and environment variables the package may touch | `tests/boundary.unit.test.ts` | [`../testing/01-test-tiers.md`](../testing/01-test-tiers.md) |

## Three ideas that recur in every layer

**Measured, not assumed.** A vault's own view functions are not trusted where they are known to
mislead (`maxDeposit`, `maxWithdraw`), so the verdict is a simulation of the real call from the real
account. A registry row is a claim, and the chain is the authority: the pre-flight and the Solana
`readVault` both refuse a row the contract disagrees with.

**A refusal is not a failure, and a failed read is not a verdict.** Pre-flight statuses separate a
definite revert (`WHITELIST_GATED`, `REVERTED_OTHER`) from a transport failure (`UNRESOLVED`); see
`isRevert` and `extractRevert` in `src/preflight.ts`. The CLI exits 0 with a verdict and 1 only when
it could not run as asked (the header of `src/cli.ts`).

**One source per fact.** The calldata and its human-readable decoding come from one call
(`encodeCall` in `src/build.ts`); explorer links are derived from the row, never stored
(`src/links.ts`); the vault's warning is attached in one helper (`commitsMoney` in
`src/earn/commands.ts`). When you add a second place that states a fact, you have added a way for
the two to disagree.

Next: [`02-a-deposit-traced.md`](02-a-deposit-traced.md).
