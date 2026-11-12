# 01: The withdrawal gate, holdings and the sign-in check

The pattern is the one `treasury connect` uses for vaults: a service prepares something for the owner
to sign, and **nothing the service says about it is trusted**. A local gate reads the signed bytes
themselves and holds them to what the owner asked for and to what the chain says the owner holds.

## Terms

- **Authorization (batch):** one EIP-712 typed-data message the provider returns, which the owner
  would sign to move funds out of the portfolio. One withdrawal can be several.
- **Smart account:** the provider's account that holds the portfolio; the EIP-712 domain's
  `verifyingContract`.
- **Sale / transfer:** a sale (`liquidate: true`) sells a holding and settles in USDT; a transfer
  moves idle USDT as it is. One withdrawal may hold both, and the gate records each batch's kind
  in order.
- **Fraction:** what the owner asks for, `all` or a decimal in (0, 1] of each holding (`parseFraction`).

## `admitWithdrawal` in `src/invest/gate.ts`

Each batch must be exactly the provider's `Withdrawal` form: the domain name and version, the field
list and types (`FIELDS`, `FIELD_TYPES`, `ASSET_TYPES`), with no field shown that is not signed and
none signed that is not read. Then, per batch:

- the domain's chain is BNB Chain, its `verifyingContract` is the smart account named for this
  portfolio, and the `portfolioId` matches;
- the recipient is the owner's own wallet on BNB Chain (`eip155:56:<owner>`);
- a sale settles in USDT on BNB Chain; a transfer moves only USDT;
- every asset entry is exactly `{ assetId, amountRaw }`, a token on BNB Chain in CAIP-19 form
  (`tokenOf` in `src/invest/chain.ts`), a positive whole number of units, named at most once per batch;
- the expiry is in the future and no later than `INVEST.maxAuthorizationLifetimeSeconds`
  (`src/config/invest.ts`) from now, because an authorization valid for days is a standing permission.

**The bound comes from the chain.** Each asset's total across every batch must be at most the asked
fraction (`allowedOf`, rounded down) of that asset's `balanceOf` on the smart account. A token the
account does not hold is refused. So a plan altered together with its authorizations is still refused:
the limit never came from the service.

The result carries each batch's kind in order, the per-asset totals against holdings, the earliest
expiry, and a `digest` over every batch's EIP-712 hash in order, for an acknowledgement to bind to.

**What it cannot check**, stated in the file header: the smart-account address itself comes from the
service, so the bound is only as independent as that address. The harm is still bounded, because the
recipient must be the owner.

## Holdings: `src/invest/chain.ts`

BNB Chain is not a row of `CHAIN_INFO`, since `earn` has no vault there. `BNB_INFO` follows the same
rules as every chain here: its own variables (`TREASURY_RPC_BNB`, then `BNB_RPC_URL`, both on the
boundary test's allowlist), then its public endpoint. `readHoldings` refuses an endpoint that does not
answer chain 56 before it reads any balance, then reads `balanceOf` for each distinct token.
`BNB_USDT` records USDT's address and its measured decimals.

## The sign-in challenge: `src/invest/challenge.ts`

Before acting for an owner, a service may ask the owner's wallet to sign a sign-in message. A server
could hand over any text, including a message valid somewhere else, so `checkChallenge` accepts only
a fixed six-line message, every line checked: the first line `CHALLENGE_FIRST_LINE`, the host the
caller expects, the client `CHALLENGE_CLIENT`, the connected owner, a nonce of letters and digits, and
issue and expiry times no more than `CHALLENGE_MAX_LIFETIME_MS` apart, not issued in the future
(within a clock-skew allowance) and not expired. The header explains why it is not Sign-In with
Ethereum: a wallet compares a SIWE domain with the page's origin, and a loopback page would warn on
every message.

## Tests

`tests/invest-gate.unit.test.ts` builds authorizations in the provider's shape and alters them one way
at a time; `tests/invest-chain-challenge.unit.test.ts` covers the holdings read and the challenge.
