# Portfolio withdrawals (`src/invest/`)

Local checks for withdrawing from a portfolio held by an outside provider on BNB Chain: a gate over
the withdrawal authorizations the owner would be asked to sign, a read of the owner's holdings on
BNB Chain, and a strict check of the sign-in message the owner would sign.

**Scope today:** these are library modules with unit tests. No `treasury` command imports them yet,
so nothing in the CLI or the connect page reaches them. Their comments refer to `invest` calls;
`invest` is not one of the skills `src/cli.ts` carries in this version.

| guide | read it when |
|---|---|
| [`01-withdrawal-gate.md`](01-withdrawal-gate.md) | you change `src/invest/gate.ts`, `src/invest/chain.ts`, `src/invest/challenge.ts` or `src/config/invest.ts` |

New in v0.1.5: `src/invest/` and `src/config/invest.ts`.
