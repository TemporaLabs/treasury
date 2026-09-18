# Changelog

All notable changes to Agent Treasury are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
Pre-1.0, minor versions may change tool names, schemas and behaviour.

## [0.1.0] - 2026-09-18

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
