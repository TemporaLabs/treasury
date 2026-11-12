# 03: The acknowledgement and plans

`connect deposit` and `connect withdraw` run **twice**. The first run builds the calls, passes them
through the gate, and returns a fixed text for the operator plus a short code; it opens nothing. The
second run, with `--ack <code>`, opens the page only for exactly the calls that text described. All of
it lives in `src/connect/ack.ts`, wired up in `confirmInWallet` and `confirmSolana`
(`src/connect/commands.ts`). What the result fields mean is in the acknowledgement sections of
[`../../tools.md`](../../tools.md).

## The text is generated, never written by the agent

`summarize` (EVM) and `summarizeSolana` turn the admitted calls (or the Solana intent) into an
`AckSummary`: action, amount, chain, vault name, ticker and explorer link, receiver, what the wallet
will ask, the vault's warning and the disclosures. `acknowledgementText` renders it; the same calls
always produce the same words.

- `operatorWarning` drops the registry warning's closing instruction to the agent, which makes no
  sense to the operator reading it, and before a withdrawal also drops advice about how much to
  deposit.
- The disclosures come from `DISCLOSURES.plain` in `src/disclosures.ts`, the short form; the gated
  deposit line is added only for a vault not measured open. The full text stays in `earn terms`.

## The code binds the page to the text

`callsDigest` hashes the connected account and each call's chain, destination, calldata and value.
`issueAck` derives an eight-character code from that digest and the issue time, with an expiry of
`ACK_TTL_MS`, and the command stores it as the one pending acknowledgement.

On the second run the command builds the calls again from the same arguments, and `checkAck` refuses
unless the code names the pending acknowledgement, it has not expired (an unreadable expiry counts as
expired), and the fresh digest equals the stored one. A changed amount, vault, chain, receiver or
connected account produces a different digest. The pending acknowledgement is then deleted before the
page opens, so one code opens one page.

**On Solana** the transaction cannot be the thing hashed: it names a blockhash that expires in about a
minute, and the page builds a fresh one when the operator presses Confirm. So `solanaIntentDigest`
hashes the intent instead (account, vault, action, raw amount), and the gate holds every transaction
built for it to that intent (`buildForIntent`, see [`02-gates.md`](02-gates.md)). A withdrawal by
amount is acknowledged as `withdraw-assets` with the asset amount, because the shares it costs change
as the vault earns; they are worked out only after the acknowledgement is accepted.

**What the code does not prove.** It ties the page to the text the CLI issued; it cannot prove the
operator read it or said yes, because the agent that receives the code can pass it back. The skill
requires the agent to ask, and the wallet's own prompt is the confirmation no agent can give. The
security model says this plainly ([`../../security-model.md`](../../security-model.md#what-this-model-does-not-cover)),
and new wording here should not claim more.

## Plans: one acknowledgement for several legs

`connect plan --legs "deposit <vault> <amount>; withdraw <vault> <amount|all>"` covers a request that
moves money in several vaults. A **leg** is one deposit or withdrawal of the plan.

1. **Describe.** Each leg is built and gate-checked as its own run would be, in `describe` mode, which
   returns its digest and summary and writes nothing. `planAcknowledgementText` renders one text for
   every leg.
2. **Issue.** `issuePlan` derives the plan's code from `planDigest`, the ordered list of leg digests,
   with an expiry of `PLAN_TTL_MS`; the number of legs is capped by `PLAN_MAX_LEGS`. The plan is
   written to the plan file with each leg's exact command.
3. **Acknowledge.** The same `--legs` with `--ack <code>`: `checkPlanAck` refuses a changed leg, order,
   amount or share balance, and marks the plan acknowledged. Nothing opens.
4. **Run.** Either each leg alone (`connect deposit|withdraw … --plan <code> --leg <n>`), or every leg
   on one page with `connect plan --run`. `checkPlanLeg` admits a leg only if the plan is acknowledged
   and unexpired, every earlier leg completed, this one has not run, and its freshly built digest is
   the one acknowledged.

`runPlanLeg` records a leg as running before its page opens and its outcome after. A leg that throws
before any page opened goes back to pending (nothing could have been sent); any other leg that does
not complete ends the plan.

**One page for the whole plan.** `runPlanPage` (inside `buildConnectCommands`) serves one page for
every leg, EVM and Solana, rendered by `connect-page/src/plan.tsx`. It starts no new leg with less than
`LEG_MIN_MS` of page time left; it returns `in_progress`, and the next `--run` serves the same page,
because the page's secret and port are kept on the plan. A secret is only ever served on the port it
was minted for: if that port is taken, a new secret is minted. A run records only on its own plan, so
a plan replaced or cleared while the page is open stops after the current leg.

## Tests

`tests/connect.unit.test.ts` covers the acknowledgement and plan flows end to end with injected chain
reads and a fake browser; `tests/connect-plan.unit.test.ts` covers plans; `tests/solana-connect.unit.test.ts`
and `tests/solana-intent.unit.test.ts` cover the Solana intent.
