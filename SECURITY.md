# Security Policy

Treasury prepares transactions that move money. A defect here can cost a depositor funds, so we
treat reports seriously and answer quickly.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting for this repository:
**Security → Report a vulnerability** (a private advisory only maintainers can see). If that is not
available to you, email `security@tempor.ai` with the subject line `treasury: <short summary>`.

Include what you can: the affected tool or file, a minimal reproduction (a fork of Base is fine — no
real funds are ever needed to demonstrate a defect in this package), and the impact as you
understand it.

## What to expect

| step | commitment |
|---|---|
| Acknowledgement | within **3 business days** |
| Triage and severity | within **7 days** of acknowledgement |
| Fix and disclosure | as fast as severity demands; a fix that changes shipped behaviour goes out with an advisory and a `CHANGELOG` entry naming the class of defect, never a report's private details |

We will keep you informed as we work, credit you in the advisory if you want to be credited, and
never take action against a good-faith report.

## What warrants an advisory

Anything that lets this package do what it promises never to do, or fail to do what it promises:

- a code path that reads, derives, logs or transmits a private key or a keyed RPC URL;
- a prepared call whose `to`, `data` or amount does not match what the tool's description and the
  operator's inputs say it should be — a transposed `receiver`/`owner`, a wrong decimal, a wrong vault;
- a verdict that says a deposit or withdrawal will succeed when the chain says it will not, or the
  reverse, on a supported chassis;
- a balance, basis or yield figure presented as a measurement when the scan did not cover the history;
- any way for a registry row to point somewhere other than the on-chain contract it names;
- a dependency or build-pipeline issue that lets the committed `dist/mcp-server.mjs` differ from what
  the committed source builds to.

## Scope

In scope: everything in this repository — the client source, the skill, the workflows, the
documentation where it makes a claim the code should honour.

Out of scope: the vault contracts themselves and the protocols they hold positions in (report those to
their maintainers; we will pass along anything you send us), the RPC providers, and the agent
runtimes that host the plugin.

## Supported versions

Security fixes go to the latest release. Pre-1.0 releases are not patched retroactively; upgrade.
