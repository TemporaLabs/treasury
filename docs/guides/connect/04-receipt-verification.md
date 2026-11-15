# 04: What landed: receipt verification

> **Scope.** On the EVM chains, `connect` does not read receipts itself: each hash goes to the Tempora API, whose
> reading of how the step landed (the vault's or token's own event for this owner and this amount) is mapped onto the
> verdicts below ([`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md)). This guide is the Solana check.

After the wallet sends a transaction, the page posts its hash (EVM) or signature (Solana) to the local
process, which has it judged (on the EVM chains by the Tempora API, on Solana here) against what the operator
confirmed. That verdict, not the wallet's
word, decides whether the next call is offered and what the command reports. On the EVM chains a call is offered only
when the API's next action (`next`) names that step at its generation; `offered` and `nextStops` in
`src/connect/vault-request.ts` read it.

## The verdicts

`Verdict` in `src/connect/verify.ts` defines them; the Solana check and the EVM mapping of the API's reading
(`src/connect/vault-request.ts`) both use it:

| verdict | meaning |
|---|---|
| `matched` | the expected effect is there, and nothing else left the account |
| `extra_transfer` | the expected effect is there, and the account also sent the asset elsewhere in the same transaction (`alsoMoved`) |
| `mismatch` | it landed, but not as confirmed |
| `reverted` | it failed on chain |
| `unverified` | no answer within the wait, or the records needed to judge it were missing |

Only `matched` and `extra_transfer` let a flow continue. Anything else stops it, with the reason.

## Solana: `verifySolanaLanded`

In `src/connect/solana.ts`. It reads the signature's status and the transaction's token-balance
records:

- the transaction must name a blockhash this flow handed to the page (`built`), and be paid for by the
  connected account; otherwise `mismatch`, whatever its balances show;
- a deposit must take the acknowledged amount of the asset (less is allowed by under one share's
  worth, since the program mints whole shares) and mint shares; more taken is `extra_transfer`;
- a withdrawal must burn the acknowledged shares, less the per-leg rounding allowance, or it is a
  partial withdrawal and a `mismatch`; what it paid is summed over every token account of the asset in
  the transaction (`assetFlows`), and must be at least what the simulation before sending paid and,
  for a withdrawal by amount, the acknowledged amount less what Kamino keeps per withdraw instruction;
- missing or unpairable token-balance records are `unverified`; SOL movements are not checked.

The exact rules, with their measured reasons, are stated in
[`../../security-model.md`](../../security-model.md#the-wallet-connection-treasury-connect).

## The command's result

`outcome` (EVM) and `solanaOutcome` turn the recorded transactions into `completed` (every call
landed as `matched` or `extra_transfer`), `stopped` (with a `reason`), or `not_reported` (nothing came
back, which is not proof nothing was sent). `next_step` tells the agent what to tell the operator and
to check the account with `earn balance` before any retry.

## Tests

`tests/connect-api.unit.test.ts` maps each step state the API reports onto a verdict; `tests/solana-connect.unit.test.ts`
checks landed Solana transactions against a scripted RPC; `tests/solana-withdraw-sim.unit.test.ts`
holds every path to refusing a partial withdrawal before it is sent; `tests/fork-solana.test.ts` runs
`verifySolanaLanded` on transactions that really landed on a local fork.
