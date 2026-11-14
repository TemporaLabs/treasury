# 04: What landed: receipt verification

> **Scope.** On the EVM chains, `connect` no longer reads receipts itself: each hash goes to the Tempora API, whose
> reading of how the step landed is the verdict reported
> ([`../earn-api/01-the-api-path.md`](../earn-api/01-the-api-path.md)). The EVM receipt check described here
> (`src/connect/verify.ts`) remains in the library; the Solana check is what `connect` uses on Solana.

After the wallet sends a transaction, the page posts its hash (EVM) or signature (Solana) to the local
process, which decides whether it did what the operator confirmed. That verdict, not the wallet's
word, decides whether the next call is offered and what the command reports.

## The verdicts

`Verdict` in `src/connect/verify.ts` defines them, and the Solana check uses the same type:

| verdict | meaning |
|---|---|
| `matched` | the expected effect is there, and nothing else left the account |
| `extra_transfer` | the expected effect is there, and the account also sent the asset elsewhere in the same transaction (`alsoMoved`) |
| `mismatch` | it landed, but not as confirmed |
| `reverted` | it failed on chain |
| `unverified` | no answer within the wait, or the records needed to judge it were missing |

Only `matched` and `extra_transfer` let a flow continue. Anything else stops it, with the reason.

## EVM: `verifyLanded`

A smart-account wallet does not send the call itself: it wraps it in a batch a relayer submits, so a
transaction's `from` and `to` name the relayer. So the evidence is read from the **receipt's logs**,
never from the transaction envelope:

1. Poll for the receipt until the attempts run out or the flow's deadline passes; none is `unverified`.
   A failed receipt is `reverted`.
2. A receipt mined at or before the chain head read when the flow started (`notBefore`) is an older
   transaction of the same shape, so it is a `mismatch`.
3. Look for the token's or the vault's own event for the connected account and the exact admitted
   amount: `Approval` for an approve, `Deposit` for a deposit, `Withdraw` (receiver and owner the
   account, assets or shares as admitted) for a withdraw or redeem. Missing is a `mismatch`.
4. Every `Transfer` of the asset out of the account that the call does not explain (a deposit
   explains exactly one pull of its amount to the vault) is listed in `alsoMoved`, and turns a match
   into `extra_transfer`. ETH movements are not checked.

In `prepareConfirm` (`src/connect/commands.ts`), each hash is put on record **before** its receipt is
read, so whatever ends the flow, the command reports the transaction rather than saying nothing was
sent. A hash the page could not hand over is recorded through `onReject` as `unverified`. Between an
approval and its deposit, `allowanceVisible` waits until the allowance reads back on this process's
RPC; if it never does, the flow stops before the deposit is sent.

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

`tests/connect.unit.test.ts` scripts receipts for each verdict on EVM; `tests/solana-connect.unit.test.ts`
checks landed Solana transactions against a scripted RPC; `tests/solana-withdraw-sim.unit.test.ts`
holds every path to refusing a partial withdrawal before it is sent; `tests/fork-solana.test.ts` runs
`verifySolanaLanded` on transactions that really landed on a local fork.
