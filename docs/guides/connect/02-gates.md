# 02: The gates

> **Scope.** On the EVM chains there is no local gate: each step comes from the Tempora API and is held by
> `checkSteps` from `@temporalabs/client` before the wallet sees it
> ([`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md)). This guide is the Solana gate.

A **gate** decides what `treasury connect` may put in front of the operator's wallet at all. It runs
before any acknowledgement is issued and again before any page opens, on exactly the calls (or the
transaction) the wallet will receive. It trusts nothing the builder says about its own output: it
re-derives everything from the bytes and the registry, so a builder bug and a transaction from
anywhere else meet the same refusal.

What it admits, stated as guarantees, is in
[`../../security-model.md`](../../security-model.md#the-wallet-connection-treasury-connect). This guide is how the
code reaches those answers, and what to keep when you change it.

## Solana: `admitSolana` in `src/connect/gate-solana.ts`

Input: the base64 wire transaction and the connected account. It decodes the transaction message
itself and admits it only if:

- the fee payer is the connected account and it is the only signer; no lookup table is used;
- every instruction is one of: a compute-unit limit (and nothing else from that program), an
  idempotent creation of the connected account's own token account for the vault's asset or share
  mint, or a Kamino vault `deposit` or `withdraw`;
- there is one deposit, or one or more withdrawals, never both, on one registry vault;
- inside each vault instruction, every account the registry determines is pinned: the vault state,
  its token vault and authority (derived PDAs), its token and share mints, and the connected
  account's own token and share accounts.

The reserve, market and program accounts a withdrawal lists are left to the vault program's own
account constraints. The file header says so; keep that sentence true if you change it.

`buildForIntent` (`src/connect/solana.ts`) is where the gate meets the acknowledgement on Solana: it
builds a fresh transaction for the acknowledged intent, admits it, and refuses unless the admitted
kind, vault and amount are the intent's. A deposit is then simulated, and a withdrawal goes through
`simulateWithdrawal` and `partialWithdrawal` before the wallet sees it.

## Changing a gate

- Widening what a gate admits is a design change, not a fix (the root [`AGENTS.md`](../../../AGENTS.md)).
  A relay that accepts an arbitrary destination is refused by rule.
- Every refusal names the call and the reason, so an operator or agent can act on it.
- The tests are `tests/solana-gate.unit.test.ts` (the gate) and `tests/solana-connect.unit.test.ts` (the flows).
  Show that a new rule can fail: break it, watch the test go red, restore it.
