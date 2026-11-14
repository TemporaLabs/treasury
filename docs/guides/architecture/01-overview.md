# 01: The layers and who owns what

Treasury is a **depositor client**. On the EVM chains it knows the Tempora API and nothing else: the API lists the
vaults, reads positions and prepares each step, and Treasury checks every step against the API's own record of the
vault before a wallet sees it. On Solana it knows the vault's registry row, an RPC endpoint and the vault's public
interface, reads the chain and builds the transaction itself. Either way it prepares unsigned steps and (through
`treasury connect`) hands steps that passed a check to the operator's own wallet. It never signs. Why that line is drawn where it is, and what enforces it, is
[`../../security-model.md`](../../security-model.md); this guide is the map of the code.

## Three ways in

| entry | file | what it is |
|---|---|---|
| the command line | `src/cli.ts` | `treasury <skill> <command> [--flag value]`, one JSON document per run, then exit |
| the library | `src/index.ts` | the registry, read clients, pre-flight, quotes, position and the builders, for a program that holds its own signer; the commands no longer use the EVM parts of it |
| the Claude Code plugin | `plugin/` | a copy of the bundled CLI plus the Earn skill (`plugin/skills/earn/SKILL.md`), which tells an agent how to use the CLI |

The CLI is the product surface. The plugin runs the same bundle (`plugin/dist/treasury.mjs` is a byte
copy of `dist/treasury.mjs`). The library exports the building blocks without the command boundary:
`buildDeposit` returns a bare array of calls, and the `{ requires_signature, status: "unsigned" }`
envelope is added only by the commands.

## The layers

```
 src/cli.ts                      argv -> flags -> one command -> JSON on stdout
   |
   +-- src/earn/commands.ts      the earn commands: READ, PREPARE, SUBMIT and REQUEST
   |     |  EVM vault                            Solana vault
   |     |  src/earn/api.ts     (the Tempora       src/registry.ts (resolve)
   |     |    API's MCP endpoint, vault address,   src/earn/solana.ts
   |     |    terms check)                         src/solana/rpc.ts, vault.ts,
   |     |  src/earn/request.ts (checkSteps,       kvault.ts, layout.ts, constants.ts
   |     |    what a step says, signer rules)
   |
   +-- src/connect/commands.ts   the connect commands: sign in, acknowledge, confirm in the wallet
   |     src/connect/ack.ts            acknowledgement text, codes, plans
   |     src/connect/vault-request.ts  an EVM leg as a Tempora API request, checked before every step
   |     src/connect/gate-solana.ts    Solana gate over transaction bytes
   |     src/connect/http.ts           one-shot loopback server
   |     src/connect/page.ts           HTML shell + CSP; serves dist/connect-page.js (built from connect-page/)
   |     src/connect/session.ts        the connection, pending acknowledgement, plan and page lock files
   |     src/connect/solana.ts         the same flows on Solana
   |
   +-- src/invest/               the invest commands: Smart Growth portfolios through the Tempora API;
                                 src/invest/api.ts is also the one sign-in earn and connect use

 the library, which the commands no longer call on the EVM chains:
   src/client.ts (RPC), src/preflight.ts, src/quote.ts, src/position.ts, src/build.ts,
   src/connect/gate.ts, src/connect/verify.ts
```

Shared underneath everything: `src/registry-schema.ts` (what a vault row is), `src/config/earn.ts`
(defaults), `src/units.ts` (decimal strings to integers and back), `src/redact.ts` (no RPC URL ever
reaches output), `src/links.ts` (explorer links derived from a row), `src/disclosures.ts` (the
pre-deposit text) and `src/version.ts` (the version, inlined at build time).

## Who owns which decision

| decision | owner | guide |
|---|---|---|
| which vaults exist on the EVM chains, with which contract, asset and decimals | the Tempora API (`products`), read in `src/earn/api.ts`; each chain's default vault address in `src/config/earn.ts` | [`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md) |
| which vault exists on Solana | `registry/vaults.json` (data), `src/registry-schema.ts` (rules) | [`../registry/01-the-vault-registry.md`](../registry/01-the-vault-registry.md) |
| which vault a call means when the caller names a chain, a vault, both or neither | `resolveProduct` in `src/earn/api.ts` (EVM), `resolveAnyVault` in `src/registry.ts` (Solana) | both of the above |
| whether an account can deposit | the API's gates and its simulated deposit check (EVM), a simulated transaction in `src/solana/vault.ts` (Solana) | [`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md), [`../solana/01-kamino-vault-path.md`](../solana/01-kamino-vault-path.md) |
| the bytes of a deposit or withdrawal | the Tempora API (EVM), `src/solana/kvault.ts` (Solana) | same |
| what may be put in front of a wallet | `checkSteps` from `@temporalabs/client`, in `src/earn/request.ts` and `src/connect/vault-request.ts` (EVM); `src/connect/gate-solana.ts` (Solana) | [`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md), [`../connect/02-gates.md`](../connect/02-gates.md) |
| what a position is worth and what can leave now | the Tempora API (`positions`, `quote`) on EVM; `solanaBalance` in `src/earn/solana.ts` on Solana | [`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md) |
| whether a page may open at all | `src/connect/ack.ts` | [`../connect/03-acknowledgement-and-plans.md`](../connect/03-acknowledgement-and-plans.md) |
| whether a transaction did what was confirmed | the Tempora API's reading of a submitted hash (EVM); `verifySolanaLanded` in `src/connect/solana.ts` (Solana) | [`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md), [`../connect/04-receipt-verification.md`](../connect/04-receipt-verification.md) |
| which modules, processes and environment variables the package may touch | `tests/boundary.unit.test.ts` | [`../testing/01-test-tiers.md`](../testing/01-test-tiers.md) |

## Three ideas that recur in every layer

**Measured, not assumed.** A vault's own view functions are not trusted where they are known to
mislead (`maxDeposit`, `maxWithdraw`), so the verdict is a simulation of the real call from the real
account: the API's on the EVM chains, Treasury's own on Solana. A registry row is a claim, and the chain is the
authority: the Solana `readVault` refuses a row the contract disagrees with.

**Trust the API's record, check its steps.** On the EVM chains the vault's contract, asset and decimals are the
Tempora API's word, and Treasury holds no address of its own. What it checks is every step against that record and
against what the operator asked for, before a wallet sees the step: a wrong step is caught, a wrong record is not.

**A refusal is not a failure, and a failed read is not a verdict.** An API that cannot be reached is a health
verdict (`apiStatus: "unreachable"`), a share balance it could not read is `unknown`, never 0, and on Solana a
transport failure is `UNRESOLVED`, never a revert. The CLI exits 0 with a verdict and 1 only when
it could not run as asked (the header of `src/cli.ts`).

**One source per fact.** A step's description and decoded call are read from its own checked calldata
(`describeStep` in `src/earn/request.ts`); explorer links are derived from the row, never stored
(`src/links.ts`); the vault's warning is attached in one helper (`commitsMoney` in
`src/earn/commands.ts`). When you add a second place that states a fact, you have added a way for
the two to disagree.

Next: [`02-a-deposit-traced.md`](02-a-deposit-traced.md).
