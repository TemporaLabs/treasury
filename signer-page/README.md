# signer-page — approve prepared calls in your own wallet

Treasury prepares unsigned calls; it never signs and never holds a key. This is an optional companion
that gets those calls in front of **your wallet extension** (MetaMask, Rabby, Coinbase Wallet) without
you copying anything into a terminal: it opens a page, shows you where the money goes, and your wallet
asks you to confirm each transaction. The wallet's confirmation is the signature.

The core package does not depend on this directory, does not import it, and does not publish it. A test
keeps it that way (`tests/no-signing.test.ts`).

## Use

```bash
# 1. your agent calls earn_prepare_deposit (or earn_prepare_withdraw) and saves the result:
#    envelope.json
# 2. open the page for the account that will sign:
node signer-page/open.mjs --account 0xYOUR_ACCOUNT --file envelope.json
#    (or pipe the envelope in on stdin)
```

### Manual mode: type an amount

```bash
node signer-page/open.mjs --manual [--vault tlCashPlusUSDC2]
```

No envelope and no agent. Connect a wallet and the page shows your position (USDC in the wallet, shares held,
what they are worth), with **Deposit** and **Withdraw** side by side and an amount field for each. **Max**
fills your USDC balance; **Withdraw everything** redeems your exact share balance so nothing is left behind.
**Review** builds the transaction for the connected wallet, checks it, and shows it in the Destination card
before any Send button works. A deposit is approve then deposit, or just the deposit when the allowance
already covers it. Amounts are checked against the chain when you press Review: more than you hold, more
than the position is worth, zero, or more than six decimal places is refused with the reason.

The page builds these calls itself, so its output goes through the same validator as an agent's envelope
(`validate.mjs`): a registry vault only, receiver and owner are the connected account, an approve that is
exactly the deposit after it. A test also pins its calldata byte for byte to what Treasury's own builders
emit. The two amount fields are the only inputs the page has; a test allows exactly those two and fails on
any other, and on anything typed being used for more than an amount.

### Privy mode: log in with email, Google, or an existing wallet — no browser extension needed

```bash
npm --prefix signer-page/privy ci && npm --prefix signer-page/privy run build   # once: builds vendor/privy-provider.js
node signer-page/open.mjs --manual --privy-app-id <your Privy app id>
```

The button becomes **Log in**, and Privy's own modal shows all three ways in on one screen — no second
click to find "connect a wallet" the way Privy's own default order puts it behind one:

- **Email** — Privy sends a code and, the first time, creates an embedded wallet on Base.
- **Google** — via a Google OAuth popup, which needs no widening of this page's policy: a popup is a
  separate browsing context, not governed by the CSP of the page that opened it.
- **A wallet extension already installed** — shown directly if Privy detects one (MetaMask and similar).
- **A phone wallet's QR code** — a WalletConnect tile, and "More options" for a wallet not shown outright.

Whichever wallet results — an extension, a phone via WalletConnect, or one Privy creates for an email or
Google login — is used exactly as it is, never wrapped in or confused with an embedded one.

The rest of the page is unchanged: the same deposit and withdraw screens, the same validator, the same
fixed list of wallet methods (the bridge in `privy/entry.jsx` enforces that list itself and refuses
anything else). It also works with an envelope, and then follows the wallet that results. It is opt-in:
without `--privy-app-id` nothing here is loaded, the default policy is byte for byte the same, and the page
never contacts Privy.

What is different, so nobody is surprised:

- **Custody.** Privy creates and holds the wallet's key material; a browser extension keeps it on your
  machine. "Your wallet signs" is still true, but the wallet is Privy's, and you are trusting Privy.
- **A new wallet starts empty.** The position card shows its address and says so. Send it USDC and a
  little ETH on Base (gas) before depositing; the card shows the ETH balance and warns when it is low.
- **Privy keeps a login session in this browser** (in its own storage, inside its script). The default page
  stores nothing; this mode does not make that claim. Because of that, this page also shows **Log out**
  once logged in — a browser's own account switcher has no equivalent for a login, and without it the page
  would silently keep reopening as the same person, on this device, until the browser's storage was cleared
  by hand. Log out ends Privy's session (so a reload does not return as the same person) and clears the
  page back to its pre-login state, so someone else can log in as themselves. It is refused, with the
  reason, while a transaction from the current run has been sent and has not yet confirmed, the same way
  switching accounts is.
- **The policy widens, only in this mode**, to `auth.privy.io` / `*.privy.io` (Privy itself), Privy's own
  Base RPC (`base-mainnet.rpc.privy.systems`) and `mainnet.base.org`, and — for "connect a wallet" —
  `explorer-api.walletconnect.com` (the wallet list), `relay.walletconnect.org` (the live WalletConnect
  session) and `verify.walletconnect.org` (its domain check). A test pins the exact list; verified in
  headless Chrome, with the real bundle, against several wallets, with no policy violation.
- **Your Privy app must allow it.** The app id is a public identifier, not a secret. Add the page's origin
  under allowed origins in the Privy dashboard, and turn on, as login methods, whichever of email, Google
  and external wallets you want offered — a method left off in the dashboard will not appear here either,
  whatever this page asks for.
- **The 5 MB bundle is built, never committed** (`vendor/` is gitignored), from versions pinned exactly in
  `privy/package.json`. Privy's SDK brings a large dependency tree of its own, which is why this lives in
  its own build folder and not in the core package.

Verified: with the real bundle and a real app id, headless Chrome reaches the login modal, all three
options render (email, Google, connect a wallet), and clicking into "connect a wallet" loads the full
602-wallet list (MetaMask included) from `explorer-api.walletconnect.com` with no policy violation; picking
a phone-only wallet (Rainbow, Trust Wallet) reaches the real QR screen, with WalletConnect's relay
(`wss://relay.walletconnect.org`) and verify endpoint contacted and nothing refused. Not verified: completing
any of the three logins for real (email and Google both need a real code or account; WalletConnect needs an
actual phone to scan), wallet creation or connection under your app's settings, and sending a transaction
through Privy's provider. See "Not yet covered".

#### Send USDC out (Privy mode only)

A wallet Privy creates is owned by its user: Privy's dashboard cannot sign for it, so it cannot move that
wallet's funds. To get USDC out, the Privy page has a **Send USDC** panel: an amount and a destination
address. It is not shown in extension mode, where the wallet itself can send.

- The address you paste is checked before anything is built: 0x plus 40 characters, and if it is written in
  mixed case its EIP-55 checksum must match, so a mistyped character is refused rather than sent. It is then
  shown in full, checksummed, in bold, with a warning, in the Destination card, and again by Privy's own
  confirmation.
- It sends USDC (a registry vault's asset) and nothing else, from the connected wallet. It refuses a zero
  amount, more than the wallet holds, the wallet's own address, the zero address, the USDC contract, and any
  vault (USDC sent to a contract by `transfer` is lost, not deposited).
- **It is not something an agent's envelope can ever carry.** The shared validator still refuses a
  `transfer`; a send exists only when a person types the destination on this page, and has its own stricter
  check (`validateSend`). Tests pin both.
- It adds a third and fourth text field, so the allow-list test now names all four inputs: three amounts
  and one address (at most 42 characters, so an address fits and a private key does not).

### Envelope mode

Leave `--account` out and the page follows the wallet you connect: the deposit's receiver (or a withdrawal's
receiver and owner) is set to that wallet, the destination card redraws with its address, and only then can
you send. Nothing else changes: the vault, the amounts and the approve are validated exactly as before, and
the shares always go to the account that signs. Switching account in the wallet pauses the page; click
**Connect wallet** again and it re-aims the calls at the new account and redraws the card, until the first
transaction has been sent. After that the calls cannot move, because the approval and the deposit must belong
to one account. A redeem is one account's exact share balance, so it needs `--account`.

The opener validates the envelope first and refuses a bad one with the reason, before any page exists.
Otherwise it serves the page on `127.0.0.1:41337`, opens your browser, and prints the address in case
you want a different browser: use the one that has your wallet extension.

On the page: read the destination, **Connect wallet**, then **Send to wallet** for each step in order.
The wallet shows its own confirmation; approve it there. The page waits for each receipt before it
lets you send the next step, and prints the transaction hashes at the end.

Options: `--no-open` (print the address only), `--port <n>` (default 41337, fixed so the wallet's
per-site permission survives between runs), `--minutes <n>` (how long to serve, default 30).

## What you are shown, and where it comes from

Everything in the **Destination** card is read from the call data itself or from the vault registry this
page ships with. The agent's own description of a step is shown separately, labelled as not verified, and
nothing on the page depends on it.

- the vault's name, address (with BaseScan and Morpho links), asset and share token, and the block its
  deposit access was measured at, all from `registry/vaults.json`;
- each step, decoded from the calldata: approve *X* USDC, deposit *X* USDC, withdraw, redeem;
- the account the wallet must be, and where shares or USDC will be paid.

## What it refuses

The same validator (`validate.mjs`) runs in the opener and in the page, so a poisoned envelope fails the
same way whether it came through the opener or was pasted into the address by hand. It refuses, with the
reason, anything that is not exactly one of these four sequences on Base:

`[deposit]` · `[approve, deposit]` · `[withdraw]` · `[redeem]`

and, within them: a contract that is not a registry vault (or, for an approve, its own asset); a receiver
or owner that is not the connected account; an approval that is not exactly the deposit that follows it;
a zero amount; a value attached; another chain; malformed or truncated calldata; another selector, such as
`transfer`. One bad call refuses the whole envelope.

## What the page does with your wallet

It calls a fixed list of wallet methods and no others. Reads: `eth_chainId`, `eth_accounts`, `eth_call`,
`eth_estimateGas`, `eth_getTransactionCount`, `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getBalance`. Writes: `eth_requestAccounts`
(connect), `wallet_switchEthereumChain` (to Base), and `eth_sendTransaction`, the one that makes your
wallet ask you to confirm. It never asks a wallet to sign a message, has no field a key could be typed
into (in manual mode, three short amount fields and one address field, allow-listed by a test), and stores
nothing (in Privy mode, Privy's own script keeps a login session; see above, including **Log out**, the one
control this page has that is not an EIP-1193 wallet method — it ends that session, not a transaction).

Before each send it checks that the wallet is on Base and its selected account is the envelope's, and it
pauses if either changes. A deposit waits for the approval to be visible on your wallet's own RPC (the
allowance read is derived from the deposit's calldata, not taken from the envelope). Gas is the wallet's
estimate × 1.5.

**It never sends a step twice.** Once your wallet has returned a transaction hash, that step cannot be
sent again from the page, whatever happens to the receipt lookup. If the wallet errors after the
transaction may have been broadcast (the account's nonce moved), the step is blocked and the page tells
you to check your wallet's activity. A rejection in the wallet, where nothing was sent, can be retried.

## What the server does

`127.0.0.1` only, GET only, four static files (the page, its script, the validator, the registry), no
caching, and a request whose `Host` is not loopback is refused (DNS rebinding). The envelope travels in
the address's `#fragment`, which browsers never send, so the server never sees it. The page's
content-security-policy lets it talk only to its own origin and refuses to be framed.

## Tests

```bash
npm test                                       # unit tests: validator, opener, and the no-signing guards
TREASURY_FORK=1 TREASURY_RPC_BASE=https://… npm run test:fork
```

The fork tier drives the real page in headless Chrome against an anvil fork of Base, with a scripted
stand-in for the wallet extension. It needs Chrome (`CHROME_BIN` to point at one) and Foundry. It covers
a full approve → deposit, a redeem, a poisoned address, markup in a description, a rejected and retried
confirmation, a failing receipt poll, an error after broadcast, and a wallet that changes chain or account
midway.

**Not yet covered: a real wallet extension, and a completed Privy login by any of its three methods.** The
stand-in cannot show that MetaMask or Rabby injects itself into a page served with this policy, and no
automated test can read an email code, complete a Google login, or scan a QR code with a phone. All of that
needs one live run by a person.

## Not here, on purpose

Other embedded-wallet connectors, a hosted copy of the page, and a one-time `connect-wallet` session are
separate changes. The page itself has no dependencies; `privy/` is a separate build folder with its own
pinned dev dependencies, used only to build the optional Privy bundle.
