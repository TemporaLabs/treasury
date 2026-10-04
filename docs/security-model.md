# Security model

One sentence: **Treasury supplies judgement; your signer supplies the gate.** Everything below is
how that sentence is made true in code rather than in a promise.

## The boundary

Treasury has three kinds of command. READ commands query the chain and return facts. PREPARE commands
return unsigned calls. CONNECT commands hand calls that passed a gate to the operator's own wallet,
which asks for approval each time, and report what landed
([below](#the-wallet-connection-treasury-connect)). Nothing in the package signs or holds a key, and
a command that did would be a design change the project refuses.

```
   agent ──▶ Treasury ──▶ { requires_signature: true, status: "unsigned", calls: [...] }
                                              │
                          your signer — a wallet, a policy engine, a token-bound account
                                              │
                                            chain
```

The envelope is the point: an unsigned build is **structurally distinguishable** from anything that
has happened. A consumer, a test, or a policy engine can assert on `requires_signature` and
`status: "unsigned"` rather than parsing prose. (The library functions `buildDeposit` /
`buildWithdraw` return bare arrays; the envelope belongs to the command boundary. If you consume the
library directly, you are the boundary.)

## What enforces it

**`tests/boundary.unit.test.ts`** parses every TypeScript file under the package with the TypeScript
compiler and fails the build if any file:

- imports, requires or dynamically loads anything outside the package and its two declared
  dependencies (`viem`, `zod`);
- reads an environment variable that is not on the allowlist
  ([`configuration.md`](configuration.md)), or reads one with a computed key;
- starts a process, except the named files — the test tiers that spawn the reconciliation script, a
  fork node and the committed bundle, the round-trip harness under `scripts/`, and
  `src/connect/open.ts`, which may start only the platform's own "open this URL" command
  (`open`, `cmd /c start`, `xdg-open`);
- reaches a private test seam from shipped code.

It is written as an analysis of the AST, not a grep for a string, because a rename defeats a grep and
a template literal defeats a regex. It has a control: fixtures that *must* fail it, so the gate cannot
go vacuous.

**CI** rebuilds `dist/treasury.mjs` from source and fails if the committed bundle differs by a byte;
runs the bundle and asserts the exact command list, the exact flag set of every command, and
the absence of `sign`, `send` and `transfer`; and, on the public repository, mints a provenance
attestation for the bundle and verifies it before the run can go green
([`runbooks/verify_the_bundle.md`](runbooks/verify_the_bundle.md)). The attestation covers
`dist/treasury.mjs`; the connect page `dist/connect-page.js` is held to a fresh rebuild and checked for
WalletConnect code, but not attested.

## Keys

Nothing in the package reads, derives, logs or transmits a private key. There is no code path for it.
The fork tier signs by impersonating accounts on a local Anvil fork; the live tier only reads. Who
may deposit into a gated vault is discovered from the chain when a test needs it, and never written
into the repository.

## Secrets in output

A keyed RPC URL is a secret. Every tool handler runs inside a guard that redacts endpoints from
anything it returns or throws; the health check reports which environment variable supplied the
RPC, never its value. This is tested against real provider failure shapes with synthetic keys.

## Measurements, not assumptions

The parts of a vault's interface that lie are not trusted:

- `maxDeposit()` says "unlimited" behind a whitelist on one chassis and `0` on an open vault on
  another — so access is a **simulated `deposit()`** from the account's address.
- `maxWithdraw()` reports an entitlement, not what the vault can pay — so exit is a **simulated
  `withdraw()`** of the whole position.
- an event scan that did not reach the deployment block is not a history — so basis and yield read
  `unknown` unless `scan.wholeHistory` is true.

## What this model does not cover

The vault contracts and the protocols they hold, the RPC provider's honesty, the agent runtime
that hosts the plugin, and, for `treasury connect`, Privy's service and the keys it manages for an
embedded wallet, and the browser and wallet extension the operator confirms in. Treasury believes the RPC; it cannot verify the chain. And Treasury cannot
stop a model from *reporting* that something was deposited — nothing at a command boundary can. What it
can do is make an unsigned build impossible to mistake for a completed one, by shape.

## The wallet connection (`treasury connect`)

`treasury connect` hands calls to the operator's own wallet; it does not sign. What protects that path:

- **A page on the operator's own machine, for one flow.** Each sign-in or confirmation starts a server
  on the machine's loopback addresses (`127.0.0.1`, and `::1` where IPv6 is on) that answers only requests carrying its random secret, its own `Host`, and (for
  every POST) its own `Origin`, takes one result at a time, and closes itself when the flow ends or
  after nine minutes. Nothing is hosted by Tempora.
- **The account is proven, not claimed.** Both sign-in paths — a browser wallet, or a Privy embedded
  wallet from an email or social login — sign a free sign-in message whose nonce is the flow's
  secret. An ordinary wallet's signature is checked offline; a smart-contract wallet's is checked by
  asking its contract through your Base RPC. The session file records only the address, how the page
  said it signed in, and when; it is created owner-readable only and holds no credential.
- **A gate before any page opens** (`src/connect/gate.ts`). Calls are built by the same builders as the
  prepare commands, then re-checked from the calldata alone: an `approve` only on a listed vault's
  asset, only to that vault, for exactly the deposit that follows, never unlimited; a `deposit`,
  `withdraw` or `redeem` only on a listed vault, paying and burning only for the connected account;
  no attached value. A batch is one operation on one vault and one chain — `approve` + `deposit`,
  `withdraw`, or `redeem` — and each call's calldata must be exactly the canonical encoding of what it
  decodes to (no trailing bytes, no stray bits in an address). The allowance the deposit waits for is
  read from those checked calls, not from the call's own `precondition` field. Anything else is
  refused before the operator is asked anything.
- **The operator confirms every call twice:** on the page, which shows the builder's description of the call
  (amount, vault, receiver), the vault, its address and explorer link; and in the wallet's own prompt
  (the extension, or Privy's dialog, which the page always asks Privy to show).
- **What landed is read from the receipt.** A smart-account wallet relays a call inside a batch, so the
  transaction's own `from`/`to` name a relayer. The check is the vault's or token's own event for the
  connected account and the exact amount; any other movement of the asset out of the account in the
  same transaction is reported as `extra_transfer`, never folded into a match. The next call is
  offered only after the previous one is confirmed this way.
- **No WalletConnect code ships.** The page bundle stubs out every `@walletconnect` / `@reown` module
  (some are under a licence that is not open source) and its build fails if one returns; the page's CSP also blocks
  WalletConnect's servers. The Privy app ID in the page is a public identifier; no Privy secret
  exists anywhere in this package.
- **Tests pin the page's source and policy** (`tests/connect-page-source.unit.test.ts`). They read
  every file under `connect-page/src` as text: the page may ask a wallet only for `personal_sign`
  (sign-in), `eth_estimateGas`, `eth_sendTransaction` and a chain switch; it may not sign typed data,
  send raw transactions, touch key material, write HTML from strings, store anything in the browser,
  or reach the network except by a direct `fetch` of its own local server. The
  Content-Security-Policy is pinned host by host, and `tests/connect.unit.test.ts` checks that the
  server sends exactly that policy with the page. These are tripwires for the ordinary, literal
  forms, so adding a wallet method or a destination the usual way fails the suite and gets a
  reviewer's eyes; they are not a proof. A text scan cannot follow every computed name, the bundled
  Privy library is not scanned, and the policy admits images from any HTTPS host, so it limits
  scripts, frames and connections but is not an exfiltration boundary.
