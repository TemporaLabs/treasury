# Configuration

Treasury reads the environment variables below and nothing else that an operator can set: twelve
for the chains, four optional ones for `treasury connect`, and one optional one for the Tempora API. A test pins the exact set — these, plus
`TREASURY_FORK` (a switch only the Solana fork test tier reads, never the shipped code) and the four a
browser launcher checks to see whether there is a browser to open (`DISPLAY`, `WAYLAND_DISPLAY`,
`SSH_CONNECTION`, `SSH_TTY`) — so a variable read anywhere else in the package fails the build.

**On the EVM chains, `treasury earn` and `treasury connect` read no RPC variable.** They call the Tempora API
(`TREASURY_API_URL`, below), which reads those chains itself, and nothing else, except that `connect wallet` checks a
smart-contract wallet's sign-in through `TREASURY_RPC_BASE`. The other EVM chains' RPC variables are read only by
`npm run registry:check`, which reconciles the registry's rows against each chain; every one of them is still
registered with the redactor, so a value set in the environment never appears in output. On Solana every command
still reads its own chain, through `TREASURY_RPC_SOLANA`.

**Each chain has its own variables, and a chain reads only its own.** An Arbitrum, Robinhood Chain, Ethereum, Monad or Solana
call never falls back to a Base endpoint: a vault's address has no contract on the other chain, so reads there fail
with "returned no data", which looks like a broken vault, not like a misconfiguration.

| variable | purpose | unset |
|---|---|---|
| `TREASURY_RPC_BASE` | the Base RPC `connect wallet` checks a smart-contract wallet's sign-in through (ERC-1271 / ERC-6492), whatever chain the vault is on; also what `registry:check` reads Base through | falls back to `BASE_RPC_URL`, then to Base's public endpoint `https://mainnet.base.org`, which rate-limits after a handful of calls |
| `BASE_RPC_URL` | a conventional alias, used when `TREASURY_RPC_BASE` is unset — through the plugin too | — |
| `TREASURY_RPC_ARBITRUM` | the Arbitrum One RPC `registry:check` reads the registry's Arbitrum One rows through | falls back to `ARBITRUM_RPC_URL`, then to Arbitrum's public endpoint `https://arb1.arbitrum.io/rpc`, which also rate-limits |
| `ARBITRUM_RPC_URL` | a conventional alias, used when `TREASURY_RPC_ARBITRUM` is unset — through the plugin too | — |
| `TREASURY_RPC_ROBINHOOD` | the Robinhood Chain RPC `registry:check` reads the registry's Robinhood Chain rows through | falls back to `ROBINHOOD_RPC_URL`, then to Robinhood Chain's public endpoint `https://rpc.mainnet.chain.robinhood.com` |
| `ROBINHOOD_RPC_URL` | a conventional alias, used when `TREASURY_RPC_ROBINHOOD` is unset — through the plugin too | — |
| `TREASURY_RPC_ETHEREUM` | the Ethereum RPC `registry:check` reads the registry's Ethereum rows through | falls back to `ETHEREUM_RPC_URL`, then to the public endpoint `https://ethereum.reth.rs/rpc` |
| `ETHEREUM_RPC_URL` | a conventional alias, used when `TREASURY_RPC_ETHEREUM` is unset — through the plugin too | — |
| `TREASURY_RPC_MONAD` | the Monad RPC `registry:check` reads the registry's Monad rows through | falls back to `MONAD_RPC_URL`, then to Monad's public endpoint `https://rpc.monad.xyz` |
| `MONAD_RPC_URL` | a conventional alias, used when `TREASURY_RPC_MONAD` is unset — through the plugin too | — |
| `TREASURY_RPC_SOLANA` | the Solana RPC every tool reads through for the vault on Solana. An endpoint whose genesis hash is not mainnet-beta's is reported as `wrong_chain` | falls back to `SOLANA_RPC_URL`, then to Solana's public endpoint `https://api.mainnet-beta.solana.com`, which rate-limits after a handful of requests |
| `SOLANA_RPC_URL` | a conventional alias, used when `TREASURY_RPC_SOLANA` is unset — through the plugin too | — |
| `TREASURY_API_URL` | the Tempora API `treasury earn` and `treasury connect` call on the EVM chains, and `treasury invest` calls, in place of the one this release pins. It must be `https` (plain `http` only for this machine). **It also decides which host a sign-in is given for:** the wallet signs the API's sign-in message only when it names this URL's host, so point it only at a deployment you trust with your wallet's sign-in | `https://api.temporalabs.com` |
| `PRIVY_APP_ID` | the Privy app the `treasury connect` sign-in page uses. A Privy app ID is public — it ships in the page — so a fork can point at its own app | Tempora Labs' own app |
| `TREASURY_CONNECT_PORT` | one local port for the connect page, in place of the default list. Privy accepts sign-in only from origins its dashboard lists exactly, so set it only to a port listed there | the first free of `53682` to `53686` |
| `TREASURY_CONNECT_HOME` | the directory holding the connect session file (an address, how it signed in, when; no credential), `owner-tokens.json` (the Tempora API sign-in tokens, a credential, mode 0600), the pending acknowledgement and the open page's lock | `~/.config/treasury` |
| `TREASURY_CONNECT_NO_OPEN` | set to anything to stop `treasury connect` opening a browser itself; it prints the page's URL instead | the browser opens |

**Check the Tempora API with `earn_status`.** With no account it reports `apiStatus: "ok"` or `"unreachable"` (with
the reason) and the vault a call resolves to. **Check Solana's RPC with `earn_status --chain solana`**: it reports
which variable supplied the endpoint, and `rpc: "wrong_chain"` when that endpoint is not Solana mainnet-beta. The
Solana commands that read the chain make the same check on every call, and the refusal names the variable that holds
it.

**A keyed RPC URL is a secret.** Treasury treats it as one: no tool output, no error, no health check
ever repeats it. `earn_status` reports *which variable* supplied the RPC, never its value.

**A keyed RPC out of quota is reported as itself.** `Monthly capacity limit exceeded`, `quota`, or
another sentence about your plan means the key is out of quota for the billing period; the tools do
not wait for that — it resets when the provider says it does — so they report the provider's own
sentence at once. The vault is fine; the key is the problem. A plain `429` that carries no such
sentence, a per-second throttle, is retried with backoff until the request's deadline, then reported
as a `429`.

## Through the plugin

The plugin (the [`plugin/`](../plugin/) folder of this repository) declares no server: its skill runs
the CLI through Claude Code's shell, so every variable above reaches it from the environment Claude
Code was started in. Export them before you start it. Treasury treats an empty value, or an unexpanded
`${…}` placeholder, as unset and falls back, so an unset variable is never mistaken for an endpoint.

## What Treasury never does with the network

No telemetry or analytics from Treasury itself. On the EVM chains, the `earn`, `connect` and `invest` commands call
the Tempora API (`TREASURY_API_URL`, above) and no other host, only through `@temporalabs/client`: its MCP endpoint
for earn's reads and requests, its HTTP routes for the owner's sign-in and for invest; see
[security-model.md](security-model.md#the-vaults-on-the-evm-chains-treasury-earn-and-treasury-connect). The one RPC
read left there is `connect wallet`'s check of a smart-contract wallet's sign-in, through `TREASURY_RPC_BASE`. On
Solana the commands call no host but Solana's RPC endpoints above. There is no yield API, no vendor endpoint, and no
code path that could add one without a code change. The other exception is the
`treasury connect` page in your browser, which loads Privy's sign-in
(auth.privy.io and Privy's RPC) and Cloudflare's bot check, and Privy's script sends its own
analytics; see [security-model.md](security-model.md#the-wallet-connection-treasury-connect). The
boundary test enforces that no code under the package reaches any other module or environment
variable, or starts any process but the browser opener.
