# 02: Pre-flight, quotes and the unsigned builders

## The pre-flight: can this account deposit?

`preflightDeposit` (`src/preflight.ts`) answers with a `PreflightStatus`. The type's comments define
each value; the shape of the decision is:

1. **Refuse before the chain** (`REFUSED_BY_CLIENT`) when the chassis has no ERC-4626 path.
2. **Identity.** Read `asset()` and `decimals()` from the vault. A mismatch with the registry row is
   refused: a presence check cannot detect a swapped address, asking the vault what it is can.
3. **State.** Balances, allowance, share price, `totalAssets` and `maxDeposit`. `maxDeposit` is kept as
   `advisory` only, because it is known to report "unlimited" behind a whitelist on one chassis and
   zero on an open vault on another.
4. **The verdict.** Simulate `deposit(assets, account)` from the account. Success is `OPEN_READY`.
   A revert goes to `classifyRevert`, which names a cause only where the revert discriminates: the
   access manager's selector is `WHITELIST_GATED`; a failure at the token pull is `NEEDS_APPROVAL`
   (access is open, an approval is missing); anything else is `REVERTED_OTHER` with candidate causes
   listed, not diagnosed. The selectors live in `knownRevertSelectors` (`src/abi/erc4626.ts`).

A read failure at any step is `UNRESOLVED`. `isRevert` and `extractRevert` walk viem's error chain to
tell a definite revert from a transport failure, and only a revert becomes a verdict. When you add a
read, keep it inside a `try` that returns `UNRESOLVED`, never a guess.

`canDeposit` is true for `OPEN_READY` and `NEEDS_APPROVAL`: the builders always emit the approval, so a
missing allowance is not a reason to stop.

## Quotes

`src/quote.ts` keeps what the chain says the trade would do now apart from what this client cannot
know (gas at inclusion, share-price movement), and labels each as itself (`bounds`, `validUntil`).

- `quoteDeposit` runs the pre-flight, then `previewDeposit` and the price of one share. A preview that
  reverts and a preview that could not be read are reported differently.
- `quoteWithdraw` reads the shares held, `previewWithdraw`, `maxWithdraw` (advisory) and the vault's
  own asset balance (`instantLiquidity`), then simulates `withdraw(assets, owner, owner)`. A revert is
  explained per chassis, because the causes differ: a chassis that pays only from its own balance
  can be short of liquidity, while a Morpho Vault V2 also pays out of its markets. It does not reuse
  the deposit classifier, whose "approve first" advice would be wrong here.

## The builders

`src/build.ts` produces the only thing the package emits on the write side: `UnsignedCall`. Read the
interface's comments; every field exists because a signer needed it.

- `buildDeposit` returns two calls: `approve(vault, assets)` on the asset, exactly the deposit amount
  and never unlimited, then `deposit(assets, receiver)` on the vault. The deposit carries a
  `precondition`: do not estimate or send it until `allowance(account, vault)` reads at least the
  amount on the RPC you send through, because a replica one block behind can serve the estimate.
- `buildWithdraw` returns one call: `withdraw(assets, receiver, owner)` for an amount in the asset, or
  `redeem(shares, receiver, owner)` with the exact share balance for "everything", which is the only
  way to empty an account without dust.
- Every call carries `gasAdvice` (buffer the estimate) and `value: "0x0"`.

`encodeCall` produces `data`, the human-readable `function` signature and the `args` map from one
argument tuple and one ABI entry. There is no decode step, so the description an operator reads
cannot drift from the bytes. Keep it that way: never add a second path that derives one from the
other.

`assert4626` refuses a chassis outside `erc4626Chassis`; the gate in `src/connect/gate.ts` checks
again from the calldata alone (see [`../connect/02-gates.md`](../connect/02-gates.md)).

## From builder to command

`earn prepare_deposit` and `earn prepare_withdraw` (`src/earn/commands.ts`) resolve the vault, call
the builder, and wrap the result with `unsigned`: the envelope with `requires_signature`,
`status: "unsigned"`, the chain, `next_step`, `signer_rules` and, for a deposit only, the vault's
warning. Library consumers calling `buildDeposit` directly get the bare array and are their own
boundary ([`../../security-model.md`](../../security-model.md#the-boundary)).

`earn claim` exists so callers can code against a queued-withdrawal step; no chassis in the registry
queues, so it reports that nothing is claimable.
