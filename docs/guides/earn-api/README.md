# The vaults on the EVM chains, through the Tempora API

On Base, Arbitrum One, Robinhood Chain, Ethereum and Monad, `treasury earn` and `treasury connect` reach the Tempora
API, through `@temporalabs/client`, and nothing else. The API lists the vaults, reads positions and quotes, and
prepares each deposit and withdrawal as a request of steps; Treasury checks every step against the API's own record
of the vault before a wallet sees it, and hands each sent step's hash back.

| guide | read it when |
|---|---|
| [`01-the-api-path.md`](01-the-api-path.md) | you change `src/earn/api.ts`, `src/earn/request.ts`, `src/connect/vault-request.ts`, an EVM earn or connect command, or `src/config/earn.ts` |
