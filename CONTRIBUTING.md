# Contributing to Treasury

Thanks for considering a contribution. Treasury is open source under the Apache License, Version 2.0
(see [`LICENSE`](LICENSE) and [`docs/licensing.md`](docs/licensing.md)). You can use, modify and
redistribute it freely, and improvements are welcome.

Tempora Labs reviews every change and decides what merges.

## Licensing of contributions

**Every commit certifies the Developer Certificate of Origin, v1.1** ([`DCO.md`](DCO.md), copied
verbatim from [developercertificate.org](https://developercertificate.org/)). Certifying it means
you wrote the contribution or otherwise have the right to submit it under Apache-2.0, and that you
understand the contribution and this certification are public and recorded indefinitely. It is not
a copyright transfer and it does not need counsel: you keep your copyright and license the
contribution to everyone under Apache-2.0, exactly as `LICENSE` already provides for.

Certify it by adding a `Signed-off-by` trailer, with your real name, to every commit:

```
Signed-off-by: Jane Smith <jane@example.com>
```

`git commit -s` adds this automatically from your `user.name` and `user.email` git config, so set
those before your first commit — in this repository, or globally with `--global`:

```
git config user.name  "Your Name"
git config user.email "you@example.com"
```

Because `-s` reads the same two values git records as the commit's author, the trailer and the
author match by construction. A CI check reads every commit on a pull request and fails if one is
missing the trailer, or if the trailer's name and email do not match that commit's author — the
comparison is case-insensitive, and merge commits are skipped, so merging never trips it.

**Already committed without it?** That is the usual way people meet this check, and the fix is
quick. `git commit --amend --signoff --no-edit` repairs the last commit;
`git rebase --signoff <base>` repairs a branch of them, followed by
`git push --force-with-lease`. The check reads every commit on the pull request, not the final
diff, so a branch is only green once all of them carry the trailer.

Your name and email enter public git history permanently, where they are cloned and mirrored beyond
anyone's reach — clause (d) of [`DCO.md`](DCO.md) is what has you acknowledge that. Only the real
*name* is required, so if you would rather not publish a personal address, GitHub's
`users.noreply.github.com` address for your account is a fine choice.

- **Third-party code is disclosed.** A contribution that includes code you did not write names its
  source and licence. Code under a licence incompatible with Apache-2.0 cannot merge.
- **Names are separate.** Section 6 of the licence grants no right to the Tempora names and marks
  beyond describing where the work came from.

## Before you start

Open an issue first for anything larger than a small fix. It is the cheapest way to learn whether a
change fits before you spend time on it.

Two rules decide most reviews. A change that breaks either is a design change, not a pull request.

1. **Nothing in this repository holds, reads, derives or is handed a private key. Nothing signs.
   Nothing sends.** Treasury prepares unsigned calls. The person or agent running it supplies the
   signer and the verification. A `sign`, `send` or `transfer` tool, a wallet client, or a private-key
   variable will not merge.
2. **The client knows only the chain.** It has a vault address and an RPC endpoint. Code may not
   depend on any fund's internal source, deploy records, operators or private services. A vault's row
   in `registry/vaults.json` is a set of measurements that
   `scripts/registry-check.ts` reconciles against the chain.

Both rules are enforced by tests, not by review alone.

## Adding or changing a vault

Every row in `registry/vaults.json` is a vault the client will list and build calls
for, so a new row is a product decision, not only a passing build. Treasury's official registry lists
Tempora vaults. Proposing a new destination needs Tempora Labs' agreement; say so in the pull request.

A row is a set of measurements. `scripts/registry-check.ts` reconciles each one against the chain, and
the pull request should say which block it was measured at.

## Development

Requires Node.js 22 or later. Fork tests also need [Foundry](https://getfoundry.sh) for `anvil`.

```bash
npm ci
npm run build                     # compiles, bundles dist/mcp-server.mjs, regenerates the notices
npm run typecheck
npm test                          # unit tests
TREASURY_RPC_BASE=https://... npm test          # adds live read-only checks against Base
TREASURY_RPC_BASE=https://... npm run test:fork # anvil fork round trips with impersonated accounts
```

- **Use `npm ci`, not `npm install`.** It fails on a stale lockfile, which is what CI does.
- **Rebuild the bundle when source changes.** `dist/mcp-server.mjs` is committed,
  because a plugin install runs no build. After any change under `src/`, run `npm run build` and commit the result.
  CI fails on a stale bundle.
- **Say which test tier ran.** Unit tests say nothing about the chain. State in the pull request
  whether you ran unit, live read-only or fork tests.
- **Tests never need a real key.** A test that moves funds runs on a fork and impersonates the
  account.
- **Measured, not assumed.** A registry row, a decimal count, a revert selector, an RPC window — each
  carries the block or date it was measured at. A claim in a comment is not a test; if it matters, pin it.
- **Amounts are strings in the asset's own decimals.** Never a float; never round a share balance.
  `sharesExact` from `earn_balance` is handed back verbatim.
- **Errors say what to do.** A refusal names the reason and the next step; a failure never masquerades
  as an empty result.

## Pull requests

- **Target the current release branch** — `release/vX.Y.Z`, not `main` and not a tag. Ask in an
  issue if you are unsure which one is current; a pull request opened against the wrong base
  will be retargeted.
- **Keep a pull request to one change.** A documentation fix found along the way gets its own pull
  request, so it can merge without waiting on the feature's review.
- **Show that a new test can fail.** Break the behaviour it guards, confirm the test goes red, then
  restore it. A test that passes both ways proves nothing.
- **The skill lives in the plugin repository.** `SKILL.md`, its trigger queries and its validation
  ship from [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin), which
  carries the skill and the bundled server together and checks the skill's tool table against the
  server's real `tools/list`. A change here that adds, removes or renames a tool needs the matching
  change there; this repository cannot catch that drift, and that repository can.

- **Expect questions.** Reviewers run the change rather than only reading it, and a review usually
  takes more than one round. Approval does not mean merge; a Tempora Labs maintainer merges.
- **Do not bump versions.** Releases are cut by maintainers, each as a single commit of the release
  tree; the public repository carries no drafting history, so nothing you see in a release commit's
  parent is missing — there is none.

## Security

Do not open a public issue for a vulnerability, especially one that could misdirect a deposit or a
withdrawal. Report it privately, through GitHub's private vulnerability reporting for this
repository, as [`SECURITY.md`](SECURITY.md) describes.

## Using Treasury without contributing

You do not need to contribute to use Treasury. The Apache License already lets you use, modify and
redistribute it, including inside commercial products and hosted services. If you distribute a
modified version, keep the `LICENSE` and `NOTICE` files and do not present it as the official Agent
Treasury (Apache-2.0, section 6).
