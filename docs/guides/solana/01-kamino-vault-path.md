# 01: The Kamino vault path

On Solana the vault is a Kamino vault (a curated single-asset vault over Kamino lending reserves),
not an ERC-4626 contract. There is no ABI to call and no event log to scan, so Treasury carries its
own decoders and instruction builders, pinned byte for byte to Kamino's SDK, and takes every verdict
from a simulated transaction.

## The files, bottom up

| file | what it holds |
|---|---|
| `src/solana/constants.ts` | program ids, PDA seeds, account sizes, `MAX_TRANSACTION_BYTES`, `MAX_COMPUTE_UNITS`, `MAINNET_GENESIS_HASH`. Both Kamino programs are upgradeable, so anything this client relies on can change; the file says so |
| `src/solana/layout.ts` | decoders for the vault state and a lending reserve, from hand-declared offsets. Each decode checks the discriminator and the exact account length, so a different or resized account is refused rather than misread |
| `src/solana/kvault.ts` | the PDAs, the `deposit` and `withdraw` instructions, the idempotent token-account creation, the compute-unit limit, and `compileUnsigned`, which compiles a transaction whose signer slot is only an address |
| `src/solana/rpc.ts` | one RPC client per run with a 429 retry (`withRateLimitRetry`), and `solanaCluster`, which identifies mainnet by genesis hash: the Solana counterpart of an EVM chain id |
| `src/solana/vault.ts` | `readVault` (state, reserves, holdings, and refusal of a row the chain contradicts), the instruction lists for a deposit or a withdrawal, `simulate`, `simulateWithdrawal`, the Solana pre-flight |
| `src/earn/solana.ts` | the earn commands' Solana branch: vault row, health, pre-flight, quotes, balance, and the prepare envelopes |

**The pin to the vendor.** `tests/solana-kvault.unit.test.ts` compares the builders' data bytes and
account metas with `vendor/kamino/instruction-fixtures.json`, and the decoders' output for a committed
mainnet snapshot (`tests/fixtures/solana/vault-snapshot.json`) with `vendor/kamino/decode-fixtures.json`.
Both fixture files were written by Kamino's own SDK through `vendor/kamino/generate-fixtures.mjs`, at
the version recorded in `vendor/kamino/PINNED`. The SDK is not a dependency: regenerate the fixtures
from a scratch directory as the script's header describes, never by hand.

## What is different from the EVM path

The header of `src/earn/solana.ts` lists the contracts; the reasons, in short:

- **One transaction, not a list of calls**, as base64 wire bytes. It names a recent blockhash, so it
  **expires** after a block height that the envelope states in structure
  (`transaction.expiresAfterBlockHeight`), not only in prose (`envelope`, `freshLifetime`).
- **Simulated before it is returned.** A transaction the program would refuse comes back as the
  program's refusal, not as something to sign.
- **No receiver.** The program mints shares to the signer and pays a withdrawal to the account whose
  shares burn, so `--receiver` must equal `--account` (`sameAsAccount`).
- **No approval and no history.** Basis and yield are reported as unknown, and the note points to the
  account's own transactions.
- **The cluster check.** `onMainnet` asks which cluster the endpoint serves beside the reads, and
  reports a devnet or local endpoint instead of the "no account" errors it causes.

## Deposits

`depositInstructions` is a compute-unit limit, an idempotent creation of the account's share token
account, and the `deposit`. `solanaPrepareDeposit` simulates it, reads how many shares the share
account would gain, and returns the envelope with that figure in `expected`.

## Withdrawals, and why a successful simulation is not enough

`withdrawInstructions` splits the shares across the vault's reserves, in order of what each can
release now, one `withdraw` instruction (a "leg") per reserve needed. The program **caps** a leg
that asks for more than it can pay instead of failing it, so a transaction can succeed and burn
fewer shares than asked. That is why every build path runs `simulateWithdrawal` and
`partialWithdrawal`, and refuses unless every share burns, less a rounding allowance per leg. A
reserve can still move between the simulation and the send; the receipt check reports that case
(see [`../connect/04-receipt-verification.md`](../connect/04-receipt-verification.md)).

Kamino keeps a small amount per withdraw instruction (the global withdrawal penalty described in the
header of `src/solana/vault.ts`). The client does not restate that rule as arithmetic: quotes and
balances report what the simulation paid.

## Co-signers

Kamino lets a vault require a co-signer on every deposit and withdrawal. This client builds
single-signer transactions only, so `assertNoCoSigner` refuses to build while one is set, on every
build. The disclosure that this could stop exits is in `src/disclosures.ts`.

## Tests to run

The Solana unit tests are the `tests/solana-*.unit.test.ts` files; the round trip on a local fork is
`tests/fork-solana.test.ts` (see [`../testing/01-test-tiers.md`](../testing/01-test-tiers.md)).
