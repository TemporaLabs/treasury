# Security Policy

## Scope

This repository is the Agent Treasury Connect plugin: the MCP server source and its built files, the
plugin manifests, and the `connect` skill. A report about any of those belongs here, including how a
sign-in is verified, how the confirmation page decodes a call, and how the session is persisted.

A defect in the separately hosted signing service, or in what Earn builds, belongs to
[TemporaLabs/treasury](https://github.com/TemporaLabs/treasury). Report it there.

This plugin never requests, displays, stores, or transmits a private key or seed phrase, and
connecting a wallet through it never grants transaction authority — every send needs the operator's
click on a confirmation page. A report claiming otherwise is exactly the kind of thing this policy
exists for.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting for this repository: **Security → Report a
vulnerability**, or open an advisory directly at
[Security advisories](https://github.com/TemporaLabs/treasury-connect-plugin/security/advisories/new).
It is private between you and the maintainers until a fix ships.

## Supported versions

Security fixes go to the latest release. Pre-1.0 releases are not patched retroactively; upgrade.
