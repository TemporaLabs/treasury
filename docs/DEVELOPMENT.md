# Development: what this repository uses and what it teaches

As of the `release/v0.1.5` branch, 2026-11-15. Every row names where to see it. How the pieces fit together is in
the developer guides ([`guides/README.md`](guides/README.md)); this file is the inventory.

## The stack at a glance

- **Language and runtime:** TypeScript, compiled with `tsc` and bundled with tsup into one self-contained ESM file
  (`dist/treasury.mjs`); Node.js 22 or later (`engines` in `package.json`).
- **External systems:** the Tempora API on Base, Arbitrum One, Robinhood Chain, Ethereum and Monad, reached only
  through the public `@temporalabs/client` package (HTTP and MCP); a Kamino vault on Solana, read and built directly
  through Solana RPC.
- **Libraries:** viem (EVM types, ABI decoding, signature checks), `@solana/kit` (Solana transactions and RPC),
  zod (every command's input schema).
- **Browser page:** React with Privy's SDK, bundled with esbuild into one file (`connect-page/`).
- **Tests:** vitest, with an offline unit tier and Solana live and fork tiers (Surfpool).
- **CI and release:** GitHub Actions (`.github/workflows/`), npm publishing with provenance, and an artifact
  attestation of the committed bundle.

## Technologies, by domain

### The Tempora API and on-chain vaults

| Technology | What it is | How this repository uses it | Where |
|---|---|---|---|
| `@temporalabs/client` | The public client for the Tempora API: an HTTP client, an MCP client, the owner sign-in and step checks | Every EVM vault read and request goes through its MCP client; the owner sign-in and the invest calls go through its HTTP client; `checkSteps`, `checkPortfolioDeposit` and `checkPortfolioWithdrawal` hold each prepared step to the operator's intent before a wallet sees it | `src/earn/api.ts`, `src/earn/request.ts`, `src/connect/vault-request.ts`, `src/invest/api.ts`, `src/invest/deposit.ts`, `src/invest/withdraw.ts` |
| MCP (Model Context Protocol) | A protocol for tools and data that agents call | Called as a client, through `@temporalabs/client/mcp`; this repository serves no MCP endpoint | `src/earn/api.ts` |
| ERC-4626 | The standard interface for tokenised vaults (deposit, withdraw, redeem, shares) | The vaults on the EVM chains are ERC-4626; steps are prepared by the API and checked here, and a step's call is decoded from its own calldata for display | `src/abi/erc4626.ts`, `describeStep` in `src/earn/request.ts` |
| CAIP-2, CAIP-10 and CAIP-19 ids | Chain-agnostic names for a chain, an account and an asset | Formed and parsed to name chains, vaults and amounts to the API (carried, not a library) | `caip2Of`, `chainOfCaip2`, `assetIdOf` in `src/earn/api.ts`; `src/invest/chain.ts` |
| viem | A TypeScript library for EVM chains | Chain definitions, address checksums, ABI decoding, offline `verifyMessage`, and one read-only client for a smart-contract wallet's sign-in (ERC-1271 / ERC-6492) and the registry check | `src/client.ts`, `src/connect/commands.ts`, `scripts/registry-check.ts` |
| EIP-712 typed data | A standard for signing structured data | Portfolio withdrawal authorizations are checked, given their missing `EIP712Domain` type, and signed by the owner's wallet | `withDomainType` in `src/invest/withdraw.ts`, `connect-page/src/invest.tsx` |

### Solana

| Technology | What it is | How this repository uses it | Where |
|---|---|---|---|
| `@solana/kit` | The Solana JavaScript SDK | RPC client with a rate-limit retry, transaction compilation with an address-only signer slot, simulation | `src/solana/rpc.ts`, `src/solana/kvault.ts`, `src/solana/vault.ts` |
| Kamino vaults | A curated single-asset vault program over Kamino lending reserves | Account decoders from hand-declared offsets and instruction builders written here, pinned byte for byte to Kamino's own SDK output | `src/solana/layout.ts`, `src/solana/kvault.ts`, `vendor/kamino/` |
| Transaction simulation | Running a transaction against current state without sending it | Every prepared transaction is simulated; a withdrawal is refused unless every share burns | `simulateWithdrawal` in `src/solana/vault.ts`, `src/earn/solana.ts` |
| ed25519 sign-in | Solana's signature scheme | A sign-in message is verified offline | `verifySolanaSignIn` in `src/connect/solana.ts` |

### Command line, local page and browser

| Technology | What it is | How this repository uses it | Where |
|---|---|---|---|
| zod | A schema and validation library | Each command's input schema, parsed strictly; `--help` and `llms.txt` are generated from the schemas' JSON Schema | `src/cli.ts`, `src/earn/commands.ts`, `scripts/llms-txt.ts` |
| `node:util` `parseArgs` | Node's argument parser | Flags derived from the zod schema, repeats refused | `parseFlags` in `src/cli.ts` |
| `node:http` loopback server | Node's HTTP server | A one-shot server per flow on loopback addresses only, with Host, Origin, content-type, body-size and secret checks | `src/connect/http.ts` |
| Content-Security-Policy | A browser policy that limits what a page may load or contact | The page is served under a fixed policy | `PAGE_CSP` in `src/connect/page.ts` |
| React and Privy | A UI library, and a hosted sign-in service with embedded and browser wallets | The confirm, plan and invest pages; wallet requests are `personal_sign`, `eth_signTypedData_v4` and `eth_sendTransaction` | `connect-page/src/` |
| esbuild | A JavaScript bundler | Bundles the page into one minified file and fails if a WalletConnect or Reown module reaches it | `connect-page/build.mjs` |

### Build, CI and distribution

| Technology | What it is | How this repository uses it | Where |
|---|---|---|---|
| tsup | An esbuild-based bundler for libraries | Inlines every dependency and the registry into one file; only the version is inlined from `package.json` | `tsup.config.ts` |
| GitHub Actions | CI on GitHub | On every push and pull request: rebuild-and-compare of committed outputs, unit tests, command-set assertions on the bundle, cross-platform exit codes; publishing by manual dispatch only | `.github/workflows/ci.yml`, `.github/workflows/publish.yml` |
| npm provenance and artifact attestation | Signed statements of where a package or file was built | Publishes with provenance; attests the committed bundle and verifies it as a stranger would | `publishConfig` in `package.json`, the `attest` job in `.github/workflows/ci.yml`, [`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md) |
| Dependabot | Automated dependency updates | Update pull requests, moved from `main` to the current release branch by a workflow | `.github/dependabot.yml`, `.github/workflows/dependabot-target.yml` |
| Claude Code and Codex plugin format | A folder an agent host installs from a git ref | `plugin/` carries the bundle, the Earn skill and both manifests, kept in sync by a script | `plugin/`, `scripts/sync-plugin.sh`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` |
| TypeScript compiler API | Programmatic access to the TypeScript parser | The boundary test parses every source file to find imports, processes and environment reads | `tests/boundary.unit.test.ts` |

## Engineering practices

| Practice | How it is done here | Where |
|---|---|---|
| No key, no signer | Nothing holds or derives a key; commands return unsigned steps, and only the operator's own wallet sends | [`security-model.md`](security-model.md), root `AGENTS.md` |
| Check the step, not the service | Every step an outside service prepares is checked against the operator's intent before a wallet sees it | `src/earn/request.ts`, `src/connect/vault-request.ts`, `src/connect/gate-solana.ts` |
| Exactly-once sending | A step put up again after it was sent is refused; a hash the page could not hand over is still submitted once; an unknown outcome is reported as "not confirmed sent" | `drive` in `src/invest/flow.ts`, `startVaultCore` in `src/connect/vault-request.ts` |
| Human acknowledgement bound by digest | A generated text and a short code bind a page to exactly what the operator was shown | `src/connect/ack.ts` |
| Static boundary test | An AST analysis fails on any import, process or environment variable outside an allowlist, with positive controls | `tests/boundary.unit.test.ts` |
| Single-source tests | Tests fail if a fact gains a second writer (the deposit warning) or the page asks a wallet for more | `tests/commands.unit.test.ts`, `tests/connect-page-source.unit.test.ts` |
| Secret redaction | Every keyed RPC URL is registered and masked in all output | `src/redact.ts`, `resolvedRpcSecrets` in `src/client.ts` |
| Measured registry | Registry rows carry the block and method they were measured at, and a script reconciles them against each chain | `registry/vaults.json`, `src/registry-schema.ts`, `scripts/registry-check.ts` |
| Reproducible committed builds | Bundles, notices and `llms.txt` are committed and CI fails on a byte of difference | [`guides/release/01-build-and-bundles.md`](guides/release/01-build-and-bundles.md) |
| Pinned versions | Exact versions for the client package and the toolchain | `package.json`, `connect-page/package.json` |
| Gates that prove they can fail | Each shell gate has offline cases that must go red | `.github/scripts/*.test.sh` |
| Developer Certificate of Origin | Every commit carries a `Signed-off-by` trailer, checked on each pull request | `DCO.md`, `.github/workflows/dco.yml` |
| Licence notices from the bundle | Third-party licences, and NOTICE files where shipped, are read from what the bundle actually inlines | `scripts/third-party-notices.ts` |

## What working here teaches

| Skill | Evidence in this repository | Roles it maps to |
|---|---|---|
| Designing a non-custodial client that never signs, and checks what a service prepares before a wallet sees it | `src/earn/request.ts`, `src/connect/vault-request.ts`, [`security-model.md`](security-model.md) | Smart-contract or Web3 engineer, security engineer |
| Exactly-once handling of irreversible actions with unknown outcomes | `src/invest/flow.ts`, `src/connect/vault-request.ts` | Backend engineer, payments engineer |
| Writing binary decoders and instruction builders against a program without its SDK, pinned to vendor fixtures | `src/solana/layout.ts`, `src/solana/kvault.ts`, `tests/solana-kvault.unit.test.ts` | Blockchain engineer (Solana) |
| Guarding a supply chain: static boundary analysis, committed reproducible bundles, provenance and attestation | `tests/boundary.unit.test.ts`, `.github/workflows/ci.yml` | Security engineer, platform or DevOps engineer |
| Building a hardened local web flow: loopback server, per-flow secret, CSP, one page at a time | `src/connect/http.ts`, `src/connect/page.ts`, `src/connect/session.ts` | Security engineer, full-stack engineer |
| Designing a CLI as a machine contract for agents: one JSON document per run, schema-generated help, verdicts versus exit codes | `src/cli.ts`, `scripts/llms-txt.ts`, [`guides/cli/01-cli-and-commands.md`](guides/cli/01-cli-and-commands.md) | Developer-tools engineer, AI or agent engineer |
| Keeping secrets out of output in a tool that echoes errors | `src/redact.ts`, `src/client.ts` | Security engineer, backend engineer |
| Testing in tiers: offline units against stand-ins, live reads, and a mainnet fork round trip | [`guides/testing/01-test-tiers.md`](guides/testing/01-test-tiers.md), `tests/fixtures/api.ts`, `tests/fork-solana.test.ts` | Test or QA engineer, backend engineer |

## Learning path

1. Read [`security-model.md`](security-model.md): what the client may and may not do, and why.
2. Read [`guides/architecture/01-overview.md`](guides/architecture/01-overview.md), then the deposit traced end to end
   in [`guides/architecture/02-a-deposit-traced.md`](guides/architecture/02-a-deposit-traced.md).
3. Read `src/cli.ts` and [`guides/cli/01-cli-and-commands.md`](guides/cli/01-cli-and-commands.md): how a command is
   declared and answered.
4. For the EVM chains, read [`guides/earn-api/01-the-api-path.md`](guides/earn-api/01-the-api-path.md) and
   `src/earn/request.ts`; for Solana, [`guides/solana/01-kamino-vault-path.md`](guides/solana/01-kamino-vault-path.md).
5. Read [`guides/connect/README.md`](guides/connect/README.md) for the wallet connection and its page.
6. Run one test file with one worker, for example `npx vitest run tests/earn-api.unit.test.ts --maxWorkers=1`, and
   leave the full suite to CI.

## Not used (to save a newcomer's time)

- **No signer, wallet client or private-key handling** anywhere in the package, by design.
- **No direct EVM RPC for the earn and connect commands:** the Tempora API reads those chains; the one EVM client left
  serves `connect wallet` and `npm run registry:check`.
- **No local EVM transaction builders or pre-flight:** the API prepares every step on the EVM chains.
- **No EVM live or fork test tier:** the EVM paths are held to a stand-in API in the unit tier.
- **No WalletConnect or Reown modules** in the page; the build fails if one is bundled.
- **Kamino's SDK is not a dependency:** it is used only to generate the pinned fixtures in `vendor/kamino/`.
- **No MCP server:** the package is an MCP client of the Tempora API only.
- **No telemetry** ([`configuration.md`](configuration.md)).
