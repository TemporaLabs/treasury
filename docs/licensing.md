# Licensing

Treasury (`@temporalabs/treasury`, the `treasury` plugin and its `earn` skill) is open source under
the [Apache License, Version 2.0](https://github.com/TemporaLabs/treasury/blob/main/LICENSE).
Tempora's fund-operations infrastructure is separate and is not part of this repository. Nothing on
this page is legal advice.

## Why Apache-2.0

Treasury's job is to get Tempora's vaults into more agent workflows, not to earn software-licence
revenue. Permissionless integration is therefore worth more than exclusive use of the client: anyone
may use, adapt, sublicense and redistribute it, with no permission conversation, and anyone may build
a competing or redirected version without paying Tempora, within the licence's conditions.

A default earns its place only if a well-informed partner would keep it even when changing it is
easy. If that ever stops being true, the answer is the vault offering, not the licence.

Apache-2.0 removes a licensing obstacle. It does not solve discovery, trust or wallet authorisation;
those are separate work.

## The boundary between Treasury and the fund's operations

- **Tempora's fund-operations infrastructure** — curation, allocation and vault deployment — is not
  part of this repository. Another operator who wants to run that infrastructure needs a direct
  agreement with Tempora.
- **Treasury** is the public, open-source client. Agents use it to read positions and to prepare
  deposits and withdrawals against on-chain vaults.
- **Using a vault is not operating the fund.** Depositing into or withdrawing from a deployed vault
  through Treasury never requires a licence to the fund's own tooling.
- **On-chain deployments are public.** Deployed contract source, ABIs and verification data are what
  a depositor inspects, and they are on the chain regardless of any repository's visibility.

## What keeps the official distribution official

Apache-2.0 does not stop anyone changing Treasury's default destination. What stays with Tempora:

- **The marks.** Section 6 of the licence grants no trademark rights. A fork may say it is based on
  Agent Treasury; it may not present itself as the official or endorsed distribution.
- **The official repository, releases and package scope.** Only what Tempora publishes is official.
- **The registry's defaults.** `registry/vaults.json` is the single source of truth for
  which vaults the official client lists. It is a product and safety decision, not a licence term.

And what Treasury owes its users in return: **transparent routing.** The default is a Tempora-curated
destination, on which Tempora can set fees; the documentation and the pre-deposit terms say so. A
commercially chosen default is never presented as a neutral best-vault ranking.

## The licence files

1. **`LICENSE` is the canonical Apache-2.0 text, unedited.** A test pins its sha256, and a second hash
   over whitespace-normalised text proves it matches the SPDX reference. An abridged or edited licence
   file defeats the automated detection that GitHub, npm and plugin catalogues rely on.
2. **The appendix placeholder stays untouched.** Its `Copyright [yyyy] [name of copyright owner]` line
   is an instruction for source-file headers, not text to edit inside `LICENSE`. Tempora's copyright
   line lives in `NOTICE`.
3. **`NOTICE` carries attribution.** Section 4(d) requires a redistribution to carry its attribution
   notices.
4. **Both travel with what ships.** The package is the repository root, so `LICENSE` and `NOTICE`
   are carried by the `files` list rather than duplicated into a subdirectory; CI checks the packed
   artifact carries them, and the plugin repository gates its own copies against these.
5. **Every manifest declares `Apache-2.0`**, so no file names a different licence from `LICENSE`.

## Contributions

Every commit certifies the Developer Certificate of Origin, v1.1
([`DCO.md`](https://github.com/TemporaLabs/treasury/blob/main/DCO.md), copied verbatim from
[developercertificate.org](https://developercertificate.org/)), via a `Signed-off-by` trailer. A
GitHub check reads every commit on a pull request and fails if the trailer is missing or does not
match the commit's author; it does not check merge commits.

The DCO is a certification of provenance, not a grant beyond the licence: a contributor keeps their
copyright and licenses the contribution to everyone under Apache-2.0 by the same `LICENSE` every
user already relies on — section 5 of Apache-2.0 already covers a submitted contribution, so the DCO
adds no separate grant, only a signed record of the right to submit it. It needs no counsel and no
signing beyond the commit itself. Details are in
[`CONTRIBUTING.md`](https://github.com/TemporaLabs/treasury/blob/main/CONTRIBUTING.md).

## Third-party notices

The MCP server bundle inlines its dependencies, so it must carry their licence notices.
`THIRD_PARTY_NOTICES.md` reproduces the full licence of every package the bundle
actually inlines, at the exact version inlined. It is generated from the bundle by
`scripts/third-party-notices.ts` during `npm run build`, and both a unit test and CI fail if it is
stale. Apache-2.0 applies to Tempora's code only; these components keep their own licences.
