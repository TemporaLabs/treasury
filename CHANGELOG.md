# Changelog

All notable changes to Agent Treasury are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
Pre-1.0, minor versions may change tool names, schemas and behaviour.

## [v0.1.3] - Unreleased

### Added — Ethereum and Monad
- **Two more chains: Ethereum and Monad**, each with its own default vault, so `earn` and `connect`
  now work on Ethereum and Monad too. `--chain ethereum` uses Tempora Labs Cash Plus USDC (Test 2E) and
  `--chain monad` uses Tempora Labs Cash Plus USDC (Test 2F); both are Morpho Vault V2 vaults over
  USDC, open to any account, with 18-decimal shares. Base stays the default chain.
- Each chain reads only its own variables: `TREASURY_RPC_ETHEREUM` (then `ETHEREUM_RPC_URL`, then
  `https://ethereum.reth.rs/rpc`) and `TREASURY_LOGS_RPC_ETHEREUM`; `TREASURY_RPC_MONAD` (then
  `MONAD_RPC_URL`, then `https://rpc.monad.xyz`) and `TREASURY_LOGS_RPC_MONAD`.
- **On Monad, set `TREASURY_LOGS_RPC_MONAD` for position history.** Monad's public endpoint serves
  `eth_getLogs` over at most 100 blocks per request, and Monad makes about three blocks a second, so
  `earn balance` through it covers under an hour and reports the scan as cut short (basis and yield
  `unknown`). Measured 2026-10-11.
- The earn skill lists the new chains when it asks which chain, and **tells the operator that
  Ethereum gas is far higher** when they pick Ethereum for a small amount.
- Explorer links: Etherscan on Ethereum, MonadScan on Monad. The connect page accepts both chains.
- `earn balance` reads the Ethereum public endpoint's range refusal ("query exceeds max block range
  100000") as a 100,000-block window and walks the history in chunks.

### Added — Solana
- **A Kamino vault on Solana: Tempora Labs Cash Plus USDC (Test 2G), `--chain solana`.** The earn commands
  read, quote and prepare for it; `treasury connect wallet --chain solana` connects a Solana wallet (Phantom,
  Solflare, Backpack, or a Privy wallet from an email or social login), and `connect deposit` / `withdraw`
  confirm through it, with the same acknowledgement step. A withdrawal by amount is acknowledged as that amount, and
  the shares worth it are worked out when the operator confirms, so the vault earning in between does not void it.
  Base stays the default chain.
- On Solana a prepared deposit or withdrawal is ONE unsigned transaction (`transaction.wire`, base64), simulated
  before it is returned, that lands only before `transaction.expiresAfterBlockHeight` (about a minute). The
  confirm page builds it when the operator presses Confirm, and a gate admits it only if every instruction is
  a compute-unit limit, the account's own token-account creation, or this vault's deposit or withdrawal for the
  connected account.
- A confirmed Solana transaction is checked against what the page built: it must name a blockhash the page
  was handed and be paid for by the connected account, or it is `mismatch`. Its token balances then decide:
  a deposit takes the acknowledged amount, or less by under one share's worth (the program mints whole shares
  and takes only what backs them), and a withdrawal burns the acknowledged shares, less at most one share unit
  of rounding per withdraw instruction, the same allowance the simulation before sending makes.
- Quotes and positions are read from simulated transactions. Each withdraw instruction keeps up to 0.001 USDC in
  the vault — Kamino's global withdrawal penalty for every vault on its program, which Kamino can change; a
  withdrawal split across reserves pays it per part — and one worth 0.001 USDC or less is refused; `receives`
  is exact and net of it. A withdrawal whose simulation burns fewer shares than asked for, beyond one share unit of rounding per
  withdraw instruction, is refused, in the quote,
  the prepared transaction and the confirm flow: Kamino pays what a reserve can and leaves the rest of the shares,
  rather than failing, when one part asks for more than its reserve can pay. Kamino's program can require a co-signer on every deposit and withdrawal; the client
  refuses to build while one is set (none is today). Entry basis and yield are not read on Solana.
- `TREASURY_RPC_SOLANA` (then `SOLANA_RPC_URL`, then `https://api.mainnet-beta.solana.com`). A new runtime
  dependency, `@solana/kit`. The instruction builders and account decoders are pinned byte for byte to
  Kamino's own SDK by committed fixtures (`vendor/kamino/`); that SDK is not a dependency.
- `registry:check` reconciles the Solana row against the vault's own state.
- The Solana vault is reached through the CLI. The library's `listVaults()` and builders cover the EVM vaults
  only, and `loadRegistry()` returns the Solana row under `solanaVaults`.
- Pre-flight on Solana: an account with no SOL for the fee is `NEEDS_FUNDS` with `canDeposit: false`, because
  the simulation stopped before the vault and says nothing about whether it takes the deposit. A deposit over
  the vault's cap is not `canDeposit` either. A vault that requires a co-signer is `REVERTED_OTHER` with the
  whole reason. A withdrawal split across reserves gives the rest to the last reserve in order.
- A Solana call refused with `HTTP error (429)` or a 5xx on the public endpoint carries the `setup_required`
  hint naming `TREASURY_RPC_SOLANA`, and `npm run registry:check` reports a Solana endpoint on another cluster
  as not checked.

### Changed — the registry and the version are inside the bundle
- The vault registry and the package version are now compiled into the CLI bundle and the library build
  instead of being read from files beside them. `treasury --version` reports the version the bundle was built
  from, and `listVaults()` returns the shipped registry even when the library is re-bundled into another
  application, where it used to look for `registry/vaults.json` beside the consumer's own bundle and read
  whatever it found there. A registry change now also changes `dist/treasury.mjs`.
- A bundler that builds on this package must accept JSON import attributes (`with { type: "json" }`);
  esbuild, webpack 5 and Rollup with its JSON plugin do.
- The CLI bundle carries only the `version` field of `package.json`, so editing anything else there (a
  dev-dependency bump) leaves `dist/treasury.mjs` unchanged.
- Importing the library unbundled on Node 22.0 to 22.11 prints Node's `ExperimentalWarning` for JSON modules;
  it works, and Node 22.12 and later print nothing. The CLI is unaffected.

### Added — several vaults in one request
- **The Earn skill says how to spread a deposit across vaults**, on one chain or several ("1 USDC on Base and
  3 on Solana", "2 USDC on every chain"): settle the list from the operator's words, check every leg first,
  show one plan with what cannot go ahead and why, then run one complete deposit per vault, one at a time,
  stopping to ask if a leg fails. `llms.txt` carries the same text.
- **Positions and withdrawals across vaults, the same way:** "what do I hold?" is one table over every vault, and
  "withdraw everything" is one plan with what each vault can pay now, then one withdrawal per vault.
- **When the operator asks what Treasury can do,** the skill says how to answer: the chains and vaults from the live
  list, quote, deposit, check and withdraw in one vault or several, money moving only from the operator's own wallet,
  and the two ways in (an agent, or the browser app at app.temporalabs.com), in at most five lines. The skill's
  description now names that question, so the skill is loaded for it.

### Added — a guide for agents without the plugin
- **`llms.txt`**, in the npm package and at `https://raw.githubusercontent.com/TemporaLabs/treasury/v0.1.3/llms.txt` (each
  release's own copy, at its tag; the URL and the `npx` line in the guide follow the package version): the Earn skill's
  rules and every command with its flags, for an agent that runs `treasury` without the plugin. It is generated from the skill and
  the command descriptions, and CI fails when the committed file differs from what they produce.
- **`treasury --help` and `treasury <skill> --help` carry a `guide` field** that tells the agent to read it first, with the
  file's path when it sits beside the CLI and the URL. Measured on 0.1.2: with no pointer in `--help` an agent read the guide
  0 times in 9; with one, 9 times in 9, and showed all of the first-deposit terms instead of about a third.
  The plugin's copy of the CLI carries no `guide`: its Earn skill is the same text and is already loaded.

### Changed — the connect page falls back to another port
- `treasury connect` serves its page on the first free port of 53682 to 53686, in that order, instead of
  53682 only, so another program holding 53682 no longer stops sign-in or confirmation. Each of these is an
  allowed origin of the Privy app. 53682 stays first, so an operator who signed in before keeps the same
  origin; a page that falls back is a different site to the browser, and an email or social login may be
  asked for again there.
- One page at a time is now kept by a lock file next to the session (`connect-page.lock`), not by the
  port: a second sign-in or confirmation is refused while one is open, naming the port it is on. A lock
  left by a process that has gone, or by a page that has expired, is replaced.
- `TREASURY_CONNECT_PORT` still sets one port, with no fallback.

### Documentation
- The README names the two ways to use the vaults: in a browser at app.temporalabs.com, or with an agent
  through OAT.
- The earn skill now says the amount is the operator's to decide, in the same words as the chain: ask,
  do not pick. Its example amounts are placeholders (`<amount>`), in the skill, `llms.txt` and the tools
  reference. When a vault cannot pay a whole withdrawal now, the skill says what can come out and asks the
  operator what to do, instead of withdrawing or quoting a smaller amount on its own.

### Fixed
- **Windows with Node 24: the health check no longer exits `3221226505` (`0xC0000409`) after a
  correct answer** (#122). Node aborted on an internal assertion about a closing handle
  (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`) when the CLI called `process.exit` right
  after the health check's request. On Windows the CLI now sets the exit code and lets Node end on its
  own, with a two-second backstop for a request that is still pending; macOS and Linux exit exactly as
  before. Measured on Windows, a command now takes about 0.1 s longer to end.
- `earn status --account` on an EVM chain echoes the account checksummed.
- **The earn skill no longer loads to analyse what a vault holds or why its share price moved**
  (#113). Its description now names that as out of scope, along with bridging, staking and vaults
  from other providers.

### Dependencies
- viem 2.57.3, inlined in the CLI bundle. Treasury does not call `waitForTransactionReceipt`, the function
  this release of viem fixes.

## [v0.1.2] - 2026-10-05

### Changed — headless: a command line replaces the MCP server
- **Treasury is now a command-line program, `treasury earn <command>`, and no longer an MCP server.**
  The eight tools are the eight commands, with the same names and arguments: `earn_quote` runs as
  `treasury earn quote --direction deposit --account 0x… --amount_usdc 25`, and `treasury earn --help`
  lists every command and flag as JSON. Each run prints one JSON document — the same document the
  tool returned — and a refusal exits 1 with `{ "error": … }` on stderr. Nothing stays running between
  commands. A flag's or command's `_` may be typed as `-` (`--amount-usdc`, `prepare-deposit`), and
  `treasury --version` prints the bare version.
- The bundle is `dist/treasury.mjs` and the npm bin is `treasury`. The plugin declares no server: its
  skill runs `node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" earn …` through the shell, so no server
  has to connect at session start; a new session loads the skill. The CLI reads every variable in
  `docs/configuration.md` from the environment it was started in, on every path; nothing filters
  them on the way in.
- **Upgrading the plugin removes the eight `earn_*` MCP tools.** An agent reaches the same eight
  operations through the `earn` skill, which runs the CLI; anything that called a tool by its MCP
  name must move to the command line. The skill pre-approves its own command for the turn it is used
  in, so a first run after upgrading may still show a one-time permission prompt for that command.
- Every command that cannot run as asked exits 1 with `{ "error": … }` on stderr: an unknown flag, a
  flag given twice (either spelling), a switch given a value (`--all` takes none), a vault on another
  chain. A verdict such as `WHITELIST_GATED` is still a result and exits 0.

### Changed for callers
- **MCP hosts and plugin users:** the eight `earn_*` MCP tools are now commands (the section above),
  and an MCP host that runs the old bundle must pin v0.1.1 exactly (Removed, below).
- **The default vault on Base is now Test 2B, not Test 2.** A call, or the library's `defaultVault()`,
  with no vault and no chain resolves to Test 2B. Name `--vault tlCashPlusUSDC2` to keep using Test 2,
  and to read or withdraw a position held there: `earn balance` with no vault reads Test 2B and reports
  nothing about a position in Test 2.
- **The registry spans three chains.** `earn vaults` and `listVaults()` list vaults on Base, Arbitrum
  One and Robinhood Chain. Send each prepared call on the chain its `chainId` names, and do not assume
  the asset is USDC: Test 2D's is USDG, carried in `amount_usdc` and `usdcValue` under their old names.

### Added — `treasury connect`: the operator's own wallet, in the browser
- **`treasury connect wallet | deposit | withdraw | status | disconnect`.** `connect wallet` opens a page
  on the operator's machine with one Connect button and Privy's window: a browser wallet (MetaMask,
  Rabby, Coinbase Wallet), or an email, Google, Apple or X login with a Privy embedded wallet. The
  wallets already installed in the browser are on the window's first screen, ahead of email and
  Google (four entries in all, so several installed wallets push those under "More options"); Apple,
  X and Coinbase Wallet are one click further. The wallet signs a free sign-in message: checked offline for an ordinary wallet, and through its contract
  on Base for a smart-contract wallet. `connect deposit` / `connect withdraw` build
  the calls for the connected account, refuse anything outside the registry or paying anyone
  else (and any batch other than approve + deposit, withdraw or redeem on one vault and one chain,
  or calldata that is not its canonical encoding), and hand each call to the wallet in turn on a
  confirm page; the operator confirms on the page and
  in the wallet. Each transaction comes back with `verified` read from the receipt — `matched`,
  `extra_transfer` (the wallet also moved money besides the call), `mismatch`, `reverted` or
  `unverified` — and the flow stops at the first one that did not land as confirmed. The result's
  `status` is `completed` only when every call landed; otherwise `stopped` with a `reason`, or
  `not_reported` when no transaction came back. Each command returns within nine minutes. Nothing
  signs.
- The confirm page links each sent transaction on the chain's explorer, shows the wallet's balances
  (read once) and warns when a deposit needs more than the wallet holds or there is nothing for the
  network fee, without blocking the button. A call declined in the wallet sent nothing, so the page stays
  open to confirm it again or cancel; a declined sign-in offers "Sign in again". An error after the
  wallet was asked to send, with no hash, is reported as not known to have gone out, never as "not sent".
- Coinbase Wallet's own entry in the sign-in window (the Coinbase SDK, for its mobile app or a smart
  wallet) is untested in this release (#88). It is separate from the Coinbase Wallet browser
  extension, which, like any installed wallet, is listed on the window's first screen.
- `dist/connect-page.js`, the page, built from `connect-page/` with its own dependencies so none of
  them enters this package's. No WalletConnect or Reown code is included. The page's notices are in
  `THIRD_PARTY_NOTICES.connect-page.md`.
- `PRIVY_APP_ID`, `TREASURY_CONNECT_PORT`, `TREASURY_CONNECT_HOME`, `TREASURY_CONNECT_NO_OPEN`, all optional.

### Added — the operator acknowledges before any signing page opens
- **`connect deposit` and `connect withdraw` run twice.** The first run builds and gate-checks the
  calls, opens nothing, and returns `status: "needs_acknowledgement"` with `acknowledgement`: one fixed
  text, written by the CLI rather than the agent, naming the amount, chain, vault and its explorer link,
  the receiver, that a deposit asks the wallet twice (approve, then deposit), the vault's warning and the
  disclosures, ending in a yes-or-no question. On the
  operator's yes, the same command with `--ack <code>` opens the page. The code works once, for 15
  minutes, and only for exactly the calls acknowledged; a completed sign-in or a disconnect voids it. The
  `earn` skill posts the acknowledgement word for word before every page open, so an operator's earlier
  yes never carries over to the next deposit or withdrawal.
- The acknowledgement states the disclosures in plain words, short enough to read every time (about
  1,560 characters for a deposit, down from about 2,600). The full text stays in `earn terms`, and the
  `earn` skill still shows it in full before a first deposit.
- The disclosure on who signs now names both paths: the operator's own wallet through `connect`, or
  the operator's own signer. It said only "the operator's own signer".

### Removed
- The MCP server: `dist/mcp-server.mjs`, the `treasury-mcp` bin, `plugin/.mcp.json`, and the
  `@modelcontextprotocol/sdk` dependency (about 90 fewer installed packages; the bundle is 1.5 MB,
  was 2.1 MB). **An MCP host that runs the old bundle must pin v0.1.1 exactly**
  (`npm install --save-exact @temporalabs/treasury@0.1.1`): a `^0.1.1` range resolves to this release,
  which has no `dist/mcp-server.mjs`.
- For contributors, `npm run mcp` is replaced by `npm run cli`, which runs the CLI from source.

### Added
- **Earn on more than one chain: Arbitrum One joins Base** (#62). Every tool that takes `vault` also
  takes `chain` (`"base"` or `"arbitrum"`). Base stays the default chain: a call that names neither a chain
  nor a vault stays on Base (see Changed for callers for its default vault). Naming a chain alone uses that chain's default vault; a `vault` and
  a `chain` that disagree are refused. Results name the chain, and a prepared envelope carries
  `chain` and `chainId` ahead of its calls.
- **Tempora Labs Cash Plus USDC (Test 2C)**, `tlCashPlusUSDC2C`, the default vault on Arbitrum One: a
  Morpho Vault V2 over native USDC, measured open to any account at block 511,070,816.
- **Robinhood Chain joins as the third chain** (#89), `chain: "robinhood"`, with
  **Tempora Labs Cash Plus USDG (Test 2D)**, `tlCashPlusUSDG2D`, its default vault: a Morpho Vault V2
  over **USDG**, the first vault whose asset is not USDC. Measured open to any account at block
  79,974,900; deployed at block 79,381,803. Amounts for it are USDG, in USDG's own decimals; the
  argument `amount_usdc` and the field `usdcValue` keep their names for every asset. Its variables are
  `TREASURY_RPC_ROBINHOOD`, `TREASURY_LOGS_RPC_ROBINHOOD` and the alias `ROBINHOOD_RPC_URL`; its explorer
  link is Robinhood Chain's Blockscout; the connect page offers it as a wallet chain.
- Chains are listed in a declared order — Base, Arbitrum One, Robinhood Chain — rather than by chain id.
- `earn_vaults` returns `chains` — the chains a deposit can go to, the default first, each with its
  default vault — and `defaultChain`. The `earn` skill has the agent ask the operator which chain
  before preparing a deposit when they have not said, and never for a withdrawal or a balance.
- `TREASURY_RPC_ARBITRUM` and `TREASURY_LOGS_RPC_ARBITRUM` (and the alias `ARBITRUM_RPC_URL`). A chain
  reads only its own variables.
- **An endpoint for the wrong chain is named, not guessed at.** `earn_status` takes `chain`, and
  reports `rpc: "wrong_chain"` with `rpcChainId` when a configured endpoint answers for a different
  chain, `chainVerified: false` when it would not say, and `logsRpc` for a separate logs endpoint.
  A pre-flight, a quote or a balance through such an endpoint is refused, naming the variable.
- A signer rule, first in `signer_rules`: send each call on the chain its `chainId` names. The
  envelope's `next_step` opens by naming the chain.
- The event scan reads Infura's range refusal (`range N exceeds limit of 10000`) as a window.

### Changed
- **The `earn` skill's description names Robinhood Chain and USDG**, beside Base, Arbitrum and USDC, so a request about idle USDG on Robinhood Chain reaches the skill (#104).
- **Tempora Labs is named in full** in the documentation, the skill body, the connect page and the pre-deposit terms; their wording changed only in that name (`source` notes the revision).
- **Tempora Labs Cash Plus USDC (Test 2B) is the default on Base**, and Test 2 becomes the demo
  vault: still listed, open and depositable, chosen by naming it. Test 2B's cash-like leg is a
  savings-rate token, not a lending vault (#47). Morpho's app has no page for it, so it carries no
  `app` link, and `src/links.ts` now offers one only for vaults Morpho is known to list.
- The registry marks one default vault **per chain** (it was one in total), and
  `src/config/earn.ts` names them in `defaultVaultByChain`, with `defaultChain` beside it.
- `TREASURY_LOGS_FALLBACK` set to a URL names a Base endpoint: on Arbitrum One and Robinhood Chain a
  set variable means no fallback. Unset, each chain falls back to its own public endpoint.
- `scripts/registry-check.ts` reads each row on its own chain, and reports a chain whose endpoint
  did not answer, or answered for another chain, as not checked.
- A vault's explorer link is its chain's (Arbiscan on Arbitrum One). A chain with no explorer on
  record now fails loudly instead of producing a broken link.
- A registry with no vault on the default chain is refused when it is loaded, with the cause named.

### Fixed
- `earn quote --direction withdraw` no longer explains every Morpho V2 revert as a liquidity
  shortfall. That note applies only to Fusion, which pays withdrawals from its own balance; on
  Morpho V2 the quote now shows the chain's own revert reason and says a smaller amount may pass
  (#78). The Fusion note now carries the revert reason too. `earn balance` likewise keeps its
  "the rest needs an unwind" note for Fusion; on Morpho V2 a paid idle-balance withdrawal is reported
  as what can come out now, with more possibly withdrawable.
- From the release review of `treasury connect`:
  - A full withdrawal's acknowledgement no longer says it redeems "every share the account holds":
    `--shares_exact` is not checked against the chain there, so the text now says the amount given is
    the whole position only if it equals the account's share balance. The confirm page names such a
    step "Redeem <vault> shares".
  - The confirm page sends each transaction with its `chainId`, so a wallet whose network changed after
    the switch refuses it rather than sending it on the wrong chain.
  - A second tab of the same confirm page cannot send a step that is already being handled, and a flow
    that ends before every call was reported always gives a `reason`.
  - An acknowledgement whose expiry cannot be read counts as expired.
  - `connect withdraw` and `earn prepare_withdraw` refuse `--amount_usdc` together with `--all`, and
    `--shares_exact` without `--all`, instead of silently using one of them.
- A chain's own name in an RPC URL (`…/arbitrum/<key>`) is no longer treated as a secret, so an
  error that names the chain is not masked.
- From the release smoke test:
  - A `previewDeposit` that fails because the RPC failed (a rate limit, for one) is reported as such
    in the pre-flight findings and in `earn quote`'s `expectedShares`, no longer as a revert by the vault.
  - A withdrawal's acknowledgement leaves out the vault warning's advice on how much to deposit.
  - The confirm flow reads the chain's block number when it starts, and a receipt mined before it is
    `mismatch` (it is not this flow's transaction) instead of `matched` (#102).
  - `earn balance` no longer reports a full exit on a vault with no liquid balance as refused twice:
    only the full withdrawal was asked, and the note says no smaller one was tried and whether the
    vault's chassis can still pay one: a Morpho V2 vault may, a Fusion vault likely not until it unwinds (#103).
- `scripts/registry-check.ts` reports a failed `eth_getCode` as not checked, through the same
  redaction as every other read; it used to escape as an uncaught error.

### CI
- Offline tests show that `scripts/sync-plugin.sh --check` and `scripts/check-versions.sh` can fail, and
  fail for the reason they name (#60).
- The live Base whole-history test no longer times out at the 20-second default: it allows two
  minutes, and accepts either a whole history or a scan that says it was cut short and gives no
  lifetime figure (#70).
- CI runs the bundled CLI and asserts the exact `earn` and `connect` command and flag sets.

### Dependencies
- viem 2.57.2, inlined in the CLI bundle; esbuild 0.28.2, which builds the connect page (#119).
- Development: vitest 5.0.3 and `@types/node` 22.20.5 (#117).

## [v0.1.1] - 2026-09-29

### Added
- **The Claude Code plugin and the `earn` skill now ship from this repository**, in
  [`plugin/`](plugin/) (#53). Up to v0.1.0 they shipped from a separate plugin repository, which
  carried byte copies of this repository's bundle, refreshed by hand. The copies in `plugin/` are now
  written by `npm run build` in the same commit and checked by CI, so a tool change and its skill text
  land in one pull request. The install id is unchanged (`treasury@treasury`); the marketplace source
  is now `TemporaLabs/treasury`. The move does not change the npm package's contents: `plugin/` is
  outside its `files` list.
- `AGENTS.md`, instructions for coding agents working in this repository (#49).

### Fixed
- The package's `treasury-mcp` command now starts the server: the entry check compares the file's
  identity, not the name it was invoked by (#27, fixes #22). A script that imports or preloads the
  bundle no longer starts it, whatever that script is named.
- The MCP server reads its own `package.json` and vault registry when run through a symlink with
  `--preserve-symlinks-main`; it failed at startup before (#57).
- `earn_quote` and `earn_balance` name `instantLiquidity` in their descriptions, and the prepare-tool
  population is derived rather than listed (#29, fixes #17).

### Changed
- The project is named Open Agent Treasury (OAT), the treasury management system for AI agents, with
  a mascot and a simpler README (#33, #37, #39, #41, #43).
- The install docs cover the published npm package, use an absolute MCP path, and compare a published
  bundle to its tag (#23, #24).

### CI
- The documentation version pins must agree, and on `main` equal `package.json`'s version; a release
  moves them in its own pull request (#30, #55).
- The publish workflow checks the plugin's copies, every version declaration and the install pins at
  the tag, and polls the registry for up to ten minutes, warning rather than failing on a timeout
  (#28, #55, #57).
- `prepack` also refuses rebuilt third-party notices that differ from the committed file (#57).
- Dependabot no longer proposes TypeScript or `@types/node` majors (#25); GitHub Actions and
  development dependencies bumped (#20, #55).

### Not supported in this release
- **Codex.** `plugin/` carries Codex manifests and Codex installs the plugin (#55 corrected a policy
  value Codex refused), but the server does not start there: measured on Codex 0.155.1, Codex does
  not expand `${CLAUDE_PLUGIN_ROOT}` in the launch path. With Codex, register the npm package's
  bundle by its absolute path with `codex mcp add`
  ([docs/install.md](docs/install.md#claude-code--the-plugin)).

### Upgrading an earlier Claude Code install
Remove the old marketplace first — adding the new one while it is still configured is refused,
because both are named `treasury` — then add the new one and reinstall. Removing the marketplace also
uninstalls the plugin, so the last step is needed:

```bash
claude plugin marketplace remove treasury
claude plugin marketplace add TemporaLabs/treasury@v0.1.1
claude plugin install treasury@treasury
```

Then restart your Claude Code session so the tools connect.

## [v0.1.0] - 2026-09-18

The first public release. Everything below is what ships in it.

### Added
- **The `treasury` MCP server** — eight `earn_*` tools that read a Tempora vault and prepare
  unsigned deposits and withdrawals for the operator's own signer. No `sign`, no `send`; the tool
  list is asserted in CI.
- **The `earn` skill**, which tells an agent how to drive those tools and what to refuse. It ships
  from [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin) together with
  the bundled server, not from this repository: the plugin reads this package, never the reverse.
- **Simulation-based pre-flight.** `earn_status` and `earn_quote` simulate the real `deposit()`
  from the account's address and report `OPEN_READY`, `NEEDS_APPROVAL`, `WHITELIST_GATED`,
  `REVERTED_OTHER`, `REFUSED_BY_CLIENT` or `UNRESOLVED` — never trusting `maxDeposit()`.
- **Exit measured by simulation.** `earn_balance` reports `exit.exitableNow`, what a withdrawal of the
  whole position would actually return at this block, next to `usdcValue`, what it is worth.
- **The transactions behind the scan.** `earn_balance` reports `scan.depositTxs` and
  `scan.withdrawTxs` — `{ txHash, blockNumber, amountUsdc }`, oldest first — projected from the
  logs the basis scan already fetched, so an explorer link needs no second query. Each list holds
  at most the 100 most recent; the counts remain the totals.
- **Whole-history basis.** Entry basis and accrued yield come from the vault's own events, from its
  deployment block; they read `unknown` unless the scan covered the whole history.
- **The unsigned envelope.** Every prepared call returns inside
  `{ requires_signature: true, status: "unsigned", calls }`.
- **Prepared calls carry their own decoding.** Alongside the raw `data`, every call reports
  `function` (e.g. `approve(address spender, uint256 value)`) and `args` by name, so an operator
  signing through a block explorer's Write Contract form does not hand-decode calldata. Both are
  produced at the same call site as `data`, from the same arguments, so they cannot drift from it.
- **The hand-off to the signer, in the skill.** Before any prepared call reaches a signer the agent quotes
  every destination back to the operator with the message it came from and waits for the paste-back;
  "go" approves the plan, never the address; a config file, an environment variable or an earlier
  session is never a source. The default signing path is the operator's own terminal, sending the
  envelope's `to`/`data` raw.
- **Endpoint redaction.** A keyed RPC URL never appears in tool output, on any failure path.
- **A signed, reproducible bundle.** `dist/mcp-server.mjs` is committed, rebuilt in CI byte-for-byte,
  and carries a provenance attestation on the public repository.
- **Licence: Apache License 2.0** from launch, with `NOTICE`.
- **A Developer Certificate of Origin** (`DCO.md`, the standard text from developercertificate.org),
  certified per commit by a `Signed-off-by` trailer and checked by a GitHub check that reads every
  commit on a pull request.
- **Two vaults offered.** The default is Tempora Labs Cash Plus USDC (Test 2) on Base, a Morpho Vault
  V2 open to any account. Cash Plus USDC (Test 2A), an IPOR Fusion vault, stays listed with
  whitelist-gated deposits; for an account it has not admitted the skill tells an
  agent to stop rather than substitute.
- **No depositor address is configured anywhere.** For the gated vault, the fork tier discovers a
  whitelist member from its own AccessManager, events then `hasRole`, and never writes one down.
- **Pre-deposit disclosures** are plain-language terms this repository owns, including that the default
  is a Tempora-curated destination on which Tempora can set fees.
- **The default's fee and position notes say what the chain says.** Its fee timelocks are 0, so a fee
  can be introduced without notice; and one of its positions lends against a stablecoin priced at
  par by a fixed oracle, which the fund's loss model does not price.
