# 01: The API path, and what is checked here

What each command takes and returns is in [`../../tools.md`](../../tools.md); what this path can and cannot protect
is in [`../../security-model.md`](../../security-model.md#the-vaults-on-the-evm-chains-treasury-earn-and-treasury-connect).
This guide is where the code is and why it is shaped the way it is.

## The files

| file | what it owns |
|---|---|
| `src/earn/api.ts` | the MCP client (`/mcp` on the API's host, `TREASURY_API_URL` or the pinned one), the vault products, resolving `vault`/`chain` to one listed vault by its contract address (`resolveProduct`; a ticker becomes its address through the registry), how a response names a vault (`vaultNamed`: address, ticker, name), the chain's CAIP-2 name, an amount in the vault's own decimals (`assetsAmount`), and the terms check (`verifiedTerms`) |
| `src/earn/request.ts` | the intent a step is held to (`depositIntent`, `withdrawIntent`, `intentOf` for a request read again), `checkedSteps` (refuses a request that fails `checkSteps`), a step's description and decoded call read from its calldata (`describeStep`), `nextStep`, and `SIGNER_RULES` |
| `src/earn/commands.ts` | the earn commands: Solana's local path when a call names Solana, the API path otherwise; `connectedOwner` (the connected wallet, and nobody else); `commitsMoney`, the one place a vault's warnings are attached |
| `src/connect/vault-request.ts` | an EVM leg of `connect`: `vaultLeg` (body, intent, digest, acknowledgement summary) and `startVaultCore`, the confirm flow for one request, in the shape the confirm and plan pages drive |
| `src/invest/api.ts` | `apiUrl`, `withOwner` and the sign-in: one sign-in, made for both of the API's doors, serves invest, earn and connect |
| `src/config/earn.ts` | `defaultVaultAddressByChain`: the one thing kept here about the EVM vaults, a default vault address per chain, which only picks the API's vault |

## Trust the record, check the step

Treasury holds no contract address for these vaults. The vault's address, its asset, its decimals and its chain are
read from the API's product row on every call, and every step the API prepares is checked against that row and the
operator's own numbers with `checkSteps` from `@temporalabs/client`: an approval only to the vault's asset, for exactly
the deposit's amount, with the vault as spender; a deposit only into the vault, paying the shares to the owner; a
withdrawal or redeem only from the vault, paid to and owned by the owner, for exactly the amount; no value; on the
vault's chain. That catches a wrong step. It cannot catch a wrong record, and nothing here tries to: a second source
of addresses would only be a second way to be wrong.

## A request's life

1. **Start.** A prepare command (or `connect`, on the operator's yes) calls `deposit` or `withdraw`. A deposit sends
   the terms version and the sha256 the operator accepted; `earn prepare_deposit` refuses a sha256 that is not the one
   the API publishes now, before anything is asked.
2. **Check.** The whole request is held to the intent. A request that fails is refused, and nothing in it is handed
   out (`connect` also cancels it).
3. **Send.** Only a step that is `ready` and carries a payload is handed out, with exactly its `to`, `data` and
   `value`. A deposit's second step is `waiting` until the first is recorded; it has nothing to send yet.
4. **Submit.** The hash goes to the API (`submit`), with the wallet's nonce and sender when known. The API reads the
   chain at that hash and records how the step landed.
5. **Read again.** `status` returns the request; it is checked again before any further step is shown.

`connect` drives all five on its page. Without `connect`, `earn prepare_*`, `earn submit` and `earn request` are the
same steps, one command each.

## Never twice

The guards are `treasury invest`'s (`drive` in `src/invest/flow.ts`), carried to a flow the page drives rather than
the command:

- a step the API puts up again after it was sent is refused (`checked` in `startVaultCore`);
- a hash the page could not hand over normally still goes to the API, by that hash, once (`onReject`);
- a submit the API refuses after a send stops the flow with the hash, and says not to send it again;
- a wallet error after the send was asked for is "not confirmed sent" on the page, and the result names the request;
- a request nothing was sent for is cancelled when the flow ends (`settle`), so it does not hold back the next one.

## The sign-in

Every owner call goes through `withOwner`: a kept token, or one sign-in on a local page, checked line by line before
the wallet signs (`src/invest/challenge.ts`). `connect` signs in before its signing page opens, on a page of its own
and only when the API needs it; a sign-in the API asks for while the signing page is open stops the flow instead of
opening a second page.

## Tests

`tests/earn-api.unit.test.ts` runs every earn command against a stand-in MCP client and a stand-in wallet, and fails
if any request leaves the stand-ins. `tests/connect-api.unit.test.ts` plays the confirm and plan pages over their own
HTTP protocol against `tests/fixtures/api.ts`, a stand-in API whose products mirror the registry's EVM rows and whose
requests behave as the API's do. Each guard above has a test that fails when the guard is removed.
