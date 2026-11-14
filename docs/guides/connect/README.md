# The wallet connection (`treasury connect`)

How `treasury connect` signs an operator in on a local page, decides what may be put in front of
their wallet, ties every page to an acknowledgement, and checks what landed. The security argument
for this path (what each protection is for, and what it does not cover) is the "wallet connection"
section of [`../../security-model.md`](../../security-model.md#the-wallet-connection-treasury-connect);
the commands' inputs and results are in [`../../tools.md`](../../tools.md). These guides are the code
walk-through.

| guide | read it when |
|---|---|
| [`01-local-page-and-sign-in.md`](01-local-page-and-sign-in.md) | you touch the loopback server, the page bundle, sign-in or the local state files |
| [`02-gates.md`](02-gates.md) | you change what the Solana gate admits, or the library's EVM gate (an EVM leg is checked as in [`../earn-api/`](../earn-api/README.md)) |
| [`03-acknowledgement-and-plans.md`](03-acknowledgement-and-plans.md) | you change the acknowledgement text, codes, or `connect plan` |
| [`04-receipt-verification.md`](04-receipt-verification.md) | you change how a landed transaction is judged |
