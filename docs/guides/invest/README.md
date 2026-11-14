# Smart Growth portfolios (`src/invest/`)

`treasury invest` deposits into and withdraws from Smart Growth portfolios through the Tempora API, with the
`@temporalabs/client` package. The API prepares each request; the owner's own wallet signs or sends every step
on a local page; nothing the API says about a step is trusted until the client's own check has read the step's
bytes.

| guide | read it when |
|---|---|
| [`01-steps-and-checks.md`](01-steps-and-checks.md) | you change anything in `src/invest/`, `src/config/invest.ts` or `connect-page/src/invest.tsx` |

New in v0.1.5: `src/invest/`, `src/config/invest.ts` and `connect-page/src/invest.tsx`.
