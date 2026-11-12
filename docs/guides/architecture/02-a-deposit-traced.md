# 02: One deposit, traced end to end

The flow below is a deposit into the default vault on Base through `treasury connect`, the path that
touches every layer. Amounts and names are an example. Each step names the function that does the
work, so you can open it.

## 1. Which vault, on which chain

```
treasury earn vaults
```

`src/cli.ts` splits argv into a skill word (`earn`) and a command (`vaults`), looks up `earn_vaults`
in the table `buildCommands()` returns (`src/earn/commands.ts`), validates the flags against the
command's zod schema, and prints what the handler returns. The handler reads the registry through
`loadRegistry()` (`src/registry.ts`), which parses `registry/vaults.json` against
`src/registry-schema.ts` once per process. No RPC is touched: every row comes with explorer links
derived by `linksFor` (`src/links.ts`), and the response lists each chain with its default vault.

## 2. The pre-flight and the quote

```
treasury earn quote --direction deposit --account 0xA… --amount_usdc 25 --chain base
```

`resolveAnyVault(undefined, "base")` picks the chain's default vault: `EARN.defaultVaultByChain.base`
in `src/config/earn.ts`, which must also be the row marked `isDefault` (`defaultVault` throws when the
two disagree). `rpcUrlFromEnv` (`src/client.ts`) picks the endpoint from that chain's own variables
or its public endpoint, and `makePublicClient` builds a read-only viem client with the
rate-limit-aware fetch.

`quoteDeposit` (`src/quote.ts`) runs `preflightDeposit` (`src/preflight.ts`) first:

1. **identity**: the vault's own `asset()` and `decimals()` must equal the row's, or the row is
   refused;
2. **state**: balances, allowance, share price, `totalAssets`, and `maxDeposit` (reported as advisory
   only);
3. **the verdict**: `simulateContract` of the real `deposit(assets, account)` from the account. A
   success is `OPEN_READY`; a revert at the token pull is `NEEDS_APPROVAL` (access is open, an
   approval is missing); an access-manager revert is `WHITELIST_GATED`; a transport error is
   `UNRESOLVED`, never a verdict.

Meanwhile `onItsChain` (`src/earn/commands.ts`) asks the endpoint which chain it serves. If it answers
for another chain, that is reported instead of whatever the reads returned.

## 3. The operator's acknowledgement

```
treasury connect wallet          # once: the operator signs in on a local page
treasury connect deposit --amount_usdc 25 --chain base --receiver 0xA…
```

`connect wallet` serves the sign-in page and records the proven address in the connection file
(see [`../connect/01-local-page-and-sign-in.md`](../connect/01-local-page-and-sign-in.md)).

`connect deposit` without `--ack` opens nothing. `depositLeg` (`src/connect/commands.ts`) refuses a
`--receiver` that is not the connected account, builds the calls with the same `buildDeposit`
(`src/build.ts`) the prepare command uses, and passes them through `admit` (`src/connect/gate.ts`).
`summarize` and `acknowledgementText` (`src/connect/ack.ts`) turn the admitted calls into a fixed
text. `issueAck` stores a pending acknowledgement whose code is bound to `callsDigest`, a hash of the
connected account and every call's chain, destination, calldata and value. The command returns
`needs_acknowledgement`, the text and the code.

## 4. The confirm page

The agent posts the text, the operator says yes, and the agent runs the same command with
`--ack <code>`. `checkAck` rebuilds the digest from freshly built calls and refuses a missing, expired
or different one; the pending acknowledgement is then deleted, so it opens one page only.

`runConfirm` calls `prepareConfirm`, which runs the gate again on exactly these calls, reads the
account's balances and the chain head, then `serveOnce` (`src/connect/http.ts`) serves the page on a
loopback port. The browser loads the shell from `shell` (`src/connect/page.ts`) and the React bundle
`dist/connect-page.js` (source in `connect-page/src/main.tsx`), which shows each call decoded and asks
the wallet to send step 1, the `approve`.

## 5. What landed

The page posts each transaction hash to `/result`. `accept` in `prepareConfirm` takes one step at a
time: the hash goes on record first, then `verifyLanded` (`src/connect/verify.ts`) reads the receipt
and looks for the token's own `Approval` event for the account and the exact amount. Only a
`matched` or `extra_transfer` verdict lets the next call go, and for the `deposit` only once the
allowance reads back on this process's RPC (`allowanceVisible`). The `deposit` is then verified by
the vault's own `Deposit` event.

`outcome` turns the verdicts into the command's result: `completed` when every call landed as
confirmed, `stopped` with a reason otherwise, `not_reported` when nothing came back.

## The same deposit without `connect`

`treasury earn prepare_deposit` stops after step 2's build: it returns the envelope from `unsigned`
(`src/earn/commands.ts`), with `requires_signature: true`, `status: "unsigned"`, the chain, the
vault's warning, `SIGNER_RULES` and the calls. Whatever holds the key signs them;
[`../../runbooks/sign_and_send.md`](../../runbooks/sign_and_send.md) is one working way.

## On Solana

The same commands with `--chain solana` take the branch to `src/earn/solana.ts`. There is one
transaction instead of a list of calls, it is simulated before it is returned, and the confirm page
builds it only when the operator presses Confirm, because it expires. See
[`../solana/01-kamino-vault-path.md`](../solana/01-kamino-vault-path.md).
