# 02: The gates

A **gate** decides what `treasury connect` may put in front of the operator's wallet at all. It runs
before any acknowledgement is issued and again before any page opens, on exactly the calls (or the
transaction) the wallet will receive. It trusts nothing the builder says about its own output: it
re-derives everything from the bytes and the registry, so a builder bug and a transaction from
anywhere else meet the same refusal.

There are two, one per chain family. What each admits, stated as guarantees, is in
[`../../security-model.md`](../../security-model.md#the-wallet-connection-treasury-connect). This guide is how the
code reaches those answers, and what to keep when you change it.

## EVM: `admit` in `src/connect/gate.ts`

Input: the calls (`chainId`, `to`, `data`, `value`) and the connected account. Output: one `Admitted`
per call (`kind`, the registry `vault`, the raw `amount`), or a thrown `refused (call i of n): …`.

The checks, in order:

1. **One chain per batch**, a supported one, and no native value on any call.
2. **Decode the calldata** against the ERC-4626 ABI, then **re-encode** it and require byte equality.
   Decoding forgives trailing bytes and stray high bits in an address word, but the wallet signs the
   bytes as sent, so only canonical calldata passes.
3. **Per function:**
   - `approve`: `to` is the asset of a listed vault on this chain, the spender is that vault, the
     amount is non-zero and below `UNLIMITED`;
   - `deposit`: `to` is a listed vault; the receiver is the connected account;
   - `withdraw` / `redeem`: `to` is a listed vault; receiver and owner are both the connected account.
4. **Pairing:** an approval must be followed by a deposit of exactly that amount into the same vault.
5. **Shape:** the whole batch must be one of `SHAPES`: approve then deposit, a lone withdraw, or a lone
   redeem. With the pairing rule, that also means one vault per batch.

Callers use the `Admitted` values, not the call's own fields. `prepareConfirm`
(`src/connect/commands.ts`) reads the allowance to wait for from the admitted approval and deposit,
never from the call's `precondition`, which the gate does not check; `verifyLanded` checks receipts
against the admitted amount.

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
- The tests are `tests/connect.unit.test.ts` (EVM gate and flows) and `tests/solana-gate.unit.test.ts`.
  Show that a new rule can fail: break it, watch the test go red, restore it.
