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
command's zod schema, and prints what the handler returns. On the EVM chains the handler asks the Tempora API's MCP
endpoint for its products (`vaultProducts` in `src/earn/api.ts`, through `createMcpClient` from
`@temporalabs/client/mcp`) and keeps the vaults. Each row is the API's: its status, chain, contract, asset,
decimals, terms version, warnings and links. `resolveProduct` picks the row by its contract address: the `--vault`
given (an address, or a ticker the registry turns into one) or, with none, the chain's default address in
`EARN.defaultVaultAddressByChain` (`src/config/earn.ts`), named only when the API lists it. An address no listed vault
has, or more than one has, is refused. The row's own product id is only ever sent back to the API. The Solana row
comes from the registry, as before.

## 2. The terms and the quote

```
treasury earn terms --chain base
treasury earn quote --direction deposit --amount_usdc 25 --chain base
```

`resolveProduct` (`src/earn/api.ts`) picks the chain's default product and refuses one the API does not list, or a
vault named with another chain. `verifiedTerms` hashes the terms text (SHA-256 of its UTF-8 bytes) and refuses it
unless that matches the sha256 the API sent; the operator is shown the text, and its sha256 is what a deposit is later
prepared against.

The quote is an owner call: it acts for the connected wallet only (`connectedOwner` in `src/earn/commands.ts`). The
owner's token is kept from an earlier sign-in, or the sign-in runs now (`withOwner` in `src/invest/api.ts`, the same
one `treasury invest` uses), on a local page that opens only for that. The API simulates the deposit at one block and
answers with the expected shares and its check of whether the vault would take it.

## 3. The operator's acknowledgement

```
treasury connect wallet          # once: the operator signs in on a local page
treasury connect deposit --amount_usdc 25 --chain base --receiver 0xA…
```

`connect wallet` serves the sign-in page and records the proven address in the connection file
(see [`../connect/01-local-page-and-sign-in.md`](../connect/01-local-page-and-sign-in.md)).

`connect deposit` without `--ack` opens nothing. `depositLeg` (`src/connect/commands.ts`) refuses a
`--receiver` that is not the connected account. `vaultLeg` (`src/connect/vault-request.ts`) describes the leg from
the vault the API lists: the request body, the intent every step will be held to, and a digest of the connected
account, the product id, its chain, vault and asset address, the action, the amount, and the terms version and
sha256. `acknowledgementText` (`src/connect/ack.ts`) turns that into a fixed text that names the terms, and
`issueAckForDigest` stores a pending acknowledgement bound to the digest. The command returns
`needs_acknowledgement`, the text and the code.

## 4. The request, and the confirm page

The agent posts the text, the operator says yes, and the agent runs the same command with `--ack <code>`. The leg is
described again from the API's listing now; `checkAckDigest` refuses a missing, expired or different digest (a vault,
an amount or terms that changed since), and the pending acknowledgement is deleted, so it opens one page only.

`runVault` starts the request: `startVaultCore` calls the API's `deposit` with the amount and the terms version and
sha256, then holds the whole request to the intent with `checkSteps` from `@temporalabs/client`. A request that fails
the check is cancelled and nothing opens. Otherwise `serveOnce` (`src/connect/http.ts`) serves the confirm page on a
loopback port. The page (`connect-page/src/main.tsx`) shows step 1, the `approve`, as described from its own
calldata, with the decoded call; step 2, the deposit, is `waiting` and has nothing to send yet.

## 5. Each step, sent and recorded

When the operator confirms, the page reads the step again from `/info` and asks the wallet to send exactly its
destination, data and value. It posts the hash to `/result`. `accept` in `startVaultCore` takes one step at a time:
the hash goes on record first, then to the API (`submit`), which reads the chain at that hash. The request is read
again (`status`) and checked again with `checkSteps` until step 1 has landed and step 2 is `ready`: the deposit, into
the vault, paying the shares to the connected account, for exactly the amount. Only then is it offered on the page.
A step the API puts up again after it was sent is refused, never sent twice; a hash the page could not hand over is
still submitted by that hash.

`outcome` turns the API's reading of each step into the command's result: `completed` when every step landed as
confirmed, `stopped` with a reason otherwise, `not_reported` when nothing came back. The result names the request, so
`earn request` can read it again.

## The same deposit without `connect`

`treasury earn prepare_deposit --amount_usdc 25 --terms_sha256 0x…` starts the same request and returns its checked
steps in an envelope (`requires_signature: true`, `status: "unsigned"`, the chain, the vault's warnings, the
`requestId`, the steps, `next_step` and `SIGNER_RULES`). Whatever holds the key sends step 1; `earn submit` hands its
hash to the API; `earn request` reads the request until step 2 is `ready`, and returns it checked.

## On Solana

The same commands with `--chain solana` take the branch to `src/earn/solana.ts`, which reads the chain and the
registry's row as before. There is one transaction instead of a list of steps, it is simulated before it is returned,
and the confirm page builds it only when the operator presses Confirm, because it expires. See
[`../solana/01-kamino-vault-path.md`](../solana/01-kamino-vault-path.md).
