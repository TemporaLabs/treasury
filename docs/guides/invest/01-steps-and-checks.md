# 01: Steps, checks and the signing page

The pattern is the one `treasury connect` uses for vaults: a service prepares something for the owner to sign, and
**nothing the service says about it is trusted**. The command checks the bytes the wallet would sign or send, and
the wallet is the owner's own.

## The modules

| file | what it does |
|---|---|
| `src/invest/api.ts` | the API's address (pinned in `src/config/invest.ts`, or `TREASURY_API_URL`), a keyless client, and `asOwner` / `withOwner`: one owner call with the kept token (`src/connect/owner-tokens.ts`), signing in again once when the API refuses it. `treasury earn` and `treasury connect` sign in through the same `withOwner` |
| `src/invest/challenge.ts` | `checkChallenge`: the six-line sign-in message, every line checked, before the wallet signs it |
| `src/invest/page.ts` | the local signing page's server side: one step at a time, each signature checked to be the owner's before the command sees it; once the page has ended, a step asked of it is refused at once |
| `connect-page/src/invest.tsx` | the page's browser side: asks the wallet, and reads the page's time left before and after the gas estimate, refusing a step with under a minute left (`MIN_MS_LEFT`) |
| `src/invest/flow.ts` | `ownerWallet` (the page, opened on first use) and `drive`, which carries a request through its steps |
| `src/invest/deposit.ts` | the deposit's amount, its body, its check (`checkPortfolioDeposit`) and what the page shows for each step |
| `src/invest/withdraw.ts` | the withdrawal's check (`checkPortfolioWithdrawal`), the smart account and holdings from the API's positions, and the EIP-712 domain type |
| `src/invest/chain.ts` | BNB Chain's fixed facts: the USDT contract and its CAIP-19 id |
| `src/invest/commands.ts` | the `invest` commands (`buildInvestCommands`; `treasury invest --help` lists them) |

## How a request is carried through (`drive`)

1. Before any step reaches the wallet, the **whole request** is checked again. A request the API changed between two
   steps is held to the same intent, and a refused check stops the command with nothing more signed or sent. A
   request asking for more than `INVEST.maxSteps` steps is refused, never followed.
2. **A step reaches the wallet only when the API's next action (`next`) names it:** `send` and `sign_again` by
   step, `sign` for the steps signed together, each at the generation `next` gives. `wait`, `done`, `failed` and
   `cancelled` offer nothing. `expired` stops the command ("ran out"), and so does `hand_back`, which says the
   transfer may already have been sent and not to send it again. A `next` of a kind this client does not know stops
   it too. Without a `next`, a ready step is offered only while the request's `expiresAt` and the step's own are in
   the future; a lapsed or unreadable date stops the command (`offered` in `src/invest/flow.ts`).
3. The step is prepared from the checked request: what the page shows is built from the step's own bytes and the
   owner's own numbers, never from the API's words.
4. The wallet signs or sends it, and the result goes back to the API with `submit`. Withdrawal authorizations that
   are ready together are all signed first, then handed back one after another, so the account is never left half
   withdrawn while the owner reads the next one.
5. With nothing left for the wallet, the request is read again every `INVEST.pollMs` until it ends, or until
   `INVEST.watchMs` passes; then the command reports it as still running. The request's own state decides when it
   ends, not any one step's: a transfer the wallet replaced stays running while the API waits for it.

**A transfer is never sent twice.** When the page could not record a transfer's hash (`sent_unrecorded`), the hash
still goes to the API. When the API does not take it, the command stops with the hash and says not to send again.
When the wallet errs after it was asked to send, with no hash, the page says "not confirmed sent", never "not sent".

## The deposit

One or two steps: the enrolment signature when the wallet has no account on the portfolio yet, then the transfer.
`checkPortfolioDeposit` holds the transfer to `transfer(smartAccount, amount)` on the USDT contract pinned in
`src/invest/chain.ts`, exactly the amount asked, with no value; the enrolment to exactly 32 bytes. The enrolment is a hash
nobody can read on its own, so the page says so. The smart account comes from the API: the check cannot vouch for
it, and the API verifies on chain that the transfer left the owner's wallet for it.

## The withdrawal

Everything in the smart account, paid to the owner in USDT. The smart account and its holdings come from the API's
positions; a request naming another smart account is refused. `checkPortfolioWithdrawal` holds every authorization
to the provider's form, on BNB Chain, debiting that account, paying the owner, settling in USDT, expiring within
`INVEST.maxAuthorizationLifetimeSeconds`, matching its attached plan, and asking in total for no more of any asset
than the account holds.

**The domain type is added before signing** (`withDomainType`). The API's authorizations carry no
`EIP712Domain` type, and a wallet signing through `eth_signTypedData_v4` signs a missing domain type as an empty one,
which binds neither the chain nor the account.

## Tests

`tests/invest-flow.unit.test.ts` runs the commands against a stand-in API and wallet, and alters one step at a time;
`tests/invest-page.unit.test.ts` plays the page the way its browser bundle does; `tests/invest-api.unit.test.ts`
covers the sign-in; `tests/invest-chain-challenge.unit.test.ts` the challenge.
