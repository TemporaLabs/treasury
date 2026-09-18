# Signing and sending Treasury's unsigned calls — a runbook

Treasury never signs, never sends, never holds a key. Something else has to.
This is that something else, written up from the first time it was actually done: a real 0.05 USDC
deposit → withdraw round trip against a Tempora Morpho V2 vault on Base mainnet, 2026-09-11, using a
key the operator already held on their own host — not a fork, not a testnet,
real signed transactions (`0xd34111…`, `0x3bad94…`, `0x7a64b7…`, all `status: success`).

This is the shape a real consumer of Treasury takes: **call the MCP tools to get intent and unsigned
calls, then hand those calls to something that holds a key and never let the key touch the same
process the calls came from.** The two are deliberately different trust domains.

## The three-step shape

1. **Quote and status** (`earn_quote` with `direction` / `earn_status`) — read-only, no key involved.
   Confirms the vault will actually accept the deposit (`NEEDS_APPROVAL` means access is open, not
   blocked — `maxDeposit()` is not trusted, the simulated call is).
2. **Prepare** (`earn_prepare_deposit` / `earn_prepare_withdraw`) — pure computation, no key
   involved. Returns `{ requires_signature: true, status: "unsigned", calls }`, each call
   `{to, data, value, gasAdvice}`. This is the entire handoff surface: nothing else crosses from
   Treasury's process into the signer's. ⚠️ Consuming the LIBRARY directly rather than the MCP
   server — as this runbook's own script does — gets the bare `UnsignedCall[]` with no envelope;
   the envelope is a property of the tool boundary, not of `buildDeposit`/`buildWithdraw`.
3. **Sign and send** — outside Treasury entirely. The runbook below is one way to do this when the
   signer is a key held on a remote host the operator runs, rather than a local wallet.

## The signer script — what it does and does not do

A single Node script, deployed to the signer's host, that:
- reads exactly one secret from `process.env`, named by an argument (never hardcoded, never a
  default) — so the script file itself carries no secret and is safe to write to disk, transmit,
  or commit as an example;
- signs and sends each call in order, applying `gasAdvice` (estimate × 1.5 — see below for why);
- prints **only** the signer's address (not the key), each tx hash, and its receipt status;
- stops on the first non-`success` receipt rather than sending the next call.

```js
// sign_send.mjs — reads the key from process.env[keyEnvVar], never logs it.
import { createWalletClient, erc20Abi, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";

const [, , callsPath, rpcEnvVar, keyEnvVar] = process.argv;
const pk = process.env[keyEnvVar];               // never printed, never re-exported
const calls = JSON.parse(readFileSync(callsPath, "utf8"));
const account = privateKeyToAccount(pk);
console.log("signer:", account.address);          // address only

const client = createWalletClient({
  account, chain: base,
  transport: http(process.env[rpcEnvVar], { timeout: 60_000 }),
}).extend(publicActions);

for (const call of calls) {
  const tx = { to: call.to, data: call.data, value: BigInt(call.value ?? "0x0") };
  // A call that carries `precondition` names the read that must hold — THROUGH THIS CLIENT'S
  // RPC — before it is estimated. The receipt for the previous step can come from a node ahead of
  // the one that will simulate this one (measured on both real Cash-Plus round trips, 2026-09-13:
  // approve confirmed, the deposit estimate said "exceeds allowance", the allowance was on-chain).
  // Reading until it holds is deterministic; retrying on a string match is guessing.
  if (call.precondition) {
    const p = call.precondition;
    for (let i = 0; ; i++) {
      const v = await client.readContract({ address: p.contract, abi: erc20Abi, functionName: p.read, args: [p.owner, p.spender] });
      if (v >= BigInt(p.minimum)) break;
      if (i >= 10) throw new Error(`precondition not met after ${i} reads: ${p.read} = ${v} < ${p.minimum}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const est = await client.estimateGas({ account, ...tx });
  // signer_rules: the nonce is read from the PENDING count right before the send and passed in.
  // Measured 2026-09-14: left to viem, mainnet.base.org's load balancer supplied a stale
  // nonce and the deposit was rejected as "nonce too low".
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const hash = await client.sendTransaction({ ...tx, gas: (est * 3n) / 2n, nonce });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log("tx:", hash, "status:", receipt.status);
  if (receipt.status !== "success") process.exit(1);
}
```

**Why the key is read by name, not passed as a value anywhere in a command line or a file this
script writes:** a shell command's arguments are frequently captured verbatim by whatever ran it —
a remote-execution service's command history, shell history, a CI log — and that record usually
outlives the session and is readable by more people than the key should be. The unsigned calls
(`to`/`data`/`value`) are not secret and travel freely; the key never appears in anything that gets
logged, only in the process's own environment.

## Failure modes hit doing this for real, and the fix

- **The estimate for step N+1 ran against a replica behind step N's receipt** (Base mainnet,
  2026-09-13, both real Cash-Plus round trips). The `approve` receipt was `success`; the immediate
  `estimateGas` for `deposit` reverted "exceeds allowance"; the allowance was on-chain. Since then
  the deposit call carries a
  `precondition` (`allowance(owner, spender) >= minimum`) and the script above reads it until it
  holds before estimating — a read, not a retry-on-string-match. Do not read the first estimate
  failure after a confirmed receipt as the vault refusing you.

- 🔴 **A send that fails on TRANSPORT is not a transaction that did not happen.** Measured
  2026-09-13: the keyed provider answered `eth_sendRawTransaction` with **HTTP 429** after the
  transaction was signed. Rate-limited, timed out and connection-reset sends all leave two possible
  states — never accepted, or accepted and the response lost — and the error text distinguishes
  neither. **Read the account's NONCE on a different provider before re-sending**: an accepted
  transaction has incremented it, a rejected one has not. Checking the effect instead (an allowance,
  a balance) is not sufficient — a transaction still in the mempool shows the old value too. Only
  after the nonce says nothing landed is it safe to send the same calldata again.

- **A load-balanced RPC can hand the signing library a stale nonce** (Base mainnet, 2026-09-14,
  a real round trip). The approve had landed and the nonce was 16 on two
  providers; viem, sending through `mainnet.base.org`, filled in 15 and the node rejected the deposit
  as "nonce too low". Nothing landed. Fix: read `eth_getTransactionCount(account, "pending")`
  immediately before each send and pass the nonce explicitly, as the script above does.

- **A public endpoint may refuse to serve receipts.** Same run: `base-rpc.publicnode.com` accepted
  the signed approve and then answered `eth_getTransactionReceipt` with "Archive requests require a
  personal token", so the script died before the deposit. The approve had succeeded. Poll receipts
  on a provider that serves them, and never read a failed receipt poll as a failed transaction:
  check the nonce on a different provider, per the rule above.

- **Check destinations before signing, in the signer.** That round trip's signer decoded every call first and
  refused to send unless the approve's spender was the vault, and the deposit's receiver and the
  withdrawal's receiver and owner were the address the operator typed, and the signer's own address
  matched it. Every prepared envelope now carries this as `signer_rules`, so the check does not
  depend on the operator remembering it.

- **`ESM` module resolution ignores `NODE_PATH`.** `node --experimental` or a bare `node script.mjs`
  run from an arbitrary directory cannot find a dependency (`viem`) installed elsewhere via
  `NODE_PATH` the way CommonJS's `require` can. Fix: run the script from inside the directory whose
  `node_modules` actually has the dependency, not via an environment variable.
- **A remote-execution one-liner is not a shell.** A sequence such as `set -a && source .env && node …`
  that works typed into a terminal can fail when handed to a remote-execution service as a single
  command string, because the service assembles its own script around it. Write the sequence to a
  real `.sh` file, deploy it, and run that file as the single command.
- **Gas estimation undercounts for Morpho V2.** An `eth_estimateGas` taken moments before sending
  can still under-provision, because Morpho V2's interest-accrual storage writes grow with elapsed
  time since the vault's last accrual — work invisible to the estimate. `gasAdvice` on every
  `UnsignedCall` says estimate × 1.5; this script applies it unconditionally, not just when
  something looks tight.
- **The public Base RPC rate-limits fast** (`eth_call`/`eth_getLogs` failures mid-session, "over rate
  limit"). Use a real provider key for anything beyond one or two reads.

## The trap `earn_balance` exists to catch — and did

Before withdrawing, `earn_balance` was called to get `sharesExact` for `earn_prepare_withdraw({all:
true})`. The wallet used for this test already held ~5.0 unrelated shares of that vault from prior
work — `sharesExact` is the **whole balance**, not "whatever this session deposited." Using
`all: true` here would have withdrawn someone else's position along with the test's own 0.05 USDC.

**The fix was the tool doing what it's for**, not a special case: `earn_prepare_withdraw` also accepts a
USDC-denominated `amount_usdc`, which withdraws exactly that much and leaves the rest of the
position untouched. `all: true` is for actually emptying an account; a bounded test withdraws a
bounded amount. Before assuming a wallet is "empty enough to use `all`," check its existing
position first — the tool will tell you, but only if asked before, not after.

## Verifying the round trip actually closed cleanly

Receipts confirm the transactions were *included and succeeded*; they don't by themselves confirm
the *net effect* was what was intended. What actually closed the loop: reading on-chain balances
before and after (USDC balance, share balance, allowance) and diffing them — USDC returned to
exactly its pre-test value, shares returned to within ERC-4626 rounding dust (~8×10⁻⁹ shares, from
two independent share/asset conversions — expected, not a bug), allowance spent to zero as the
deposit's `approve` intended. A `status: success` receipt is necessary; it is not the same claim as
"the wallet is back where it started," and only the second one is what a smoke test is for.
