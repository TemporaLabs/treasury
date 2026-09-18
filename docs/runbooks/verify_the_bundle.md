# Verifying the bundle you installed is the one CI built — a runbook

Treasury ships as a Claude Code plugin installed **from git**: the marketplace copies the plugin
repository, [TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin), and the
MCP server that runs is its committed `dist/mcp-server.mjs` — a byte copy of this repository's
`dist/mcp-server.mjs` (2 MB, dependencies inlined, no `npm install` on your side).
Nothing about "it came from GitHub" tells you that file was built by this repository's CI from the
commit it claims. This runbook is how a stranger checks that, with no membership in the org and no
trust in anyone's word. It is the last mile of "the code is open": open source you cannot tie to the
bytes you are running is a claim, not a property.

## What is attested, and by whom

On every push to `main` or a version branch, `.github/workflows/ci.yml` runs two jobs on the
same commit:

1. **`check`** rebuilds the bundle from the commit's source and fails if the committed file differs
   (the stale-dist guard). It also runs the twelve offline cases of the attestation gate. This job
   runs `npm ci`, tests and other dependency code, so it is granted **no** signing identity.
2. **`attest`** (`needs: check`, so it only runs once `check` passed on this commit) checks the
   repository out without persisting credentials, runs nothing but the gate script, the attest
   action and `gh`, and signs a **SLSA build-provenance attestation** for
   `dist/mcp-server.mjs` with the workflow run's own GitHub OIDC identity
   (`actions/attest-build-provenance`). No key is stored anywhere — the signing identity *is*
   the run, granted to this job alone, and the signature lands in this repository's attestation
   store and in a Sigstore transparency log. It then verifies the attestation back with
   `gh attestation verify`, checks the attested digest equals the file's digest at that moment,
   and asserts that the attest and verify steps actually ran when they should have. A step that
   passes by skipping renders identically to one that worked, so that assertion
   (`.github/scripts/attestation-gate.sh`) is what makes green mean *attested*.

Two claims, two mechanisms — keep them apart:

- **The attestation proves:** these exact bytes were attested by this workflow, in this repository,
  at this commit, by a job that ran no dependency code. It ties *bytes* to a *commit and a workflow
  identity*.
- **The stale-dist guard proves:** the committed bytes equal a rebuild of that commit's source. It
  ties the bytes to the *source*. The attestation inherits this only because `attest` requires
  `check` to have passed on the same commit; the attest job does not rebuild anything.

What neither proves: that the source is correct, that the registry points where you want, or
anything about the vaults it talks to. Read the source for that; these only tie the source to the
bytes you are running.

## Where the attestation exists

GitHub issues artifact attestations for **public** repositories. On the public `TemporaLabs/treasury`
repository the attest and verify steps are **required**: every CI run on `main` mints an attestation
for `dist/mcp-server.mjs` and verifies it against the signer workflow before the run can go green.
On a private mirror of this tree the same steps are gated to skip, and the assertion accepts the
skip only because the repository is private — a skip can never pass as a success on the public
repository. Whatever repository you are reading this in, the weaker chain is always checkable: the
commit's `dist/` equals a rebuild of the commit's source (CI's stale-dist step, which you can
reproduce with `npm ci && npm run build && git diff --exit-code -- dist`).

## Verifying, as a stranger (public repository)

You need `gh` ≥ 2.49 (`gh attestation` was added in 2.49) and a GitHub login of any kind — the
command reads the attestation from GitHub's API; it does not need read access to anything private.

1. Find the file you are actually running. For a Claude Code plugin install it is under the plugin
   cache; the path ends in `dist/mcp-server.mjs`. Record its digest:

   ```bash
   f=~/.claude/plugins/cache/treasury/treasury/*/dist/mcp-server.mjs
   sha256sum $f
   ```

2. Verify it against the public repository and its workflow:

   ```bash
   gh attestation verify $f --repo TemporaLabs/treasury \
     --signer-workflow TemporaLabs/treasury/.github/workflows/ci.yml
   ```

   Success prints the attestation's subject digest and the commit (`sourceRepositoryRef`,
   `sourceRepositoryDigest`) that produced it. That commit is in this repository, not the plugin
   repository: the plugin's release notes name the release of this repository its bundle was copied
   from, and `claude plugin list` shows which plugin version you have. The verification is by
   digest, so a byte-identical copy in the plugin cache verifies against this repository's attestation;
   a copy that differs by one byte does not.

3. What a failure means. `no attestations found` — either the file was modified after install, or
   it was never built by CI (a local build, a fork, a tampered cache). A signer mismatch — it was
   attested, but not by this workflow in this repository. Either way: do not run it; reinstall from
   the marketplace and verify again.

Offline: `gh attestation download $f --repo TemporaLabs/treasury` writes a `sha256:….jsonl` bundle you can
keep and later pass to `gh attestation verify --bundle <file>`; the signature and transparency-log
inclusion are checked locally, but the trust roots are still fetched from Sigstore/GitHub on first
use, so "offline" means "without this repository", not "air-gapped".

## The npm half

The package is published as [`@temporalabs/treasury`](https://www.npmjs.com/package/@temporalabs/treasury)
with npm provenance: each version is published from `publish.yml` running on GitHub's hosted runner
with `id-token: write`, from the release tag, and npm records that fact against the tarball.
`package.json` is what makes that hold — `repository` names the public repository,
`TemporaLabs/treasury` (CI fails if it names anything else, because that is the only repository
provenance can be issued from), `files` limits the tarball to `dist/` and `registry/` (the skill is
not in it — it ships from the plugin repository), `publishConfig.provenance` is on, and `prepack`
builds so `main`/`types` exist in the tarball — only `dist/*.mjs` is committed, so without that build
the tarball would carry the bundle and nothing the manifest's own `main`/`types` point at.

To check a published version against the attested bundle: `npm pack @temporalabs/treasury@<version>`
downloads the exact tarball; the `dist/mcp-server.mjs` inside it must have the same sha256 as the
attestation for that version's tag. `npm audit signatures` in a project that depends on the package
verifies npm's own provenance record for it.

`prepack` **rebuilds** `dist/mcp-server.mjs`, so an `npm pack` or `npm publish` would otherwise ship
whatever the publishing machine built rather than the attested committed file — agreeing only while
the build is byte-deterministic, and disagreeing silently, because both artifacts are "the bundle".

It now cannot. `prepack` is `npm run build && git diff --exit-code -- dist/mcp-server.mjs`: it still
produces the `main`/`types` outputs the tarball needs, and then **refuses** if the rebuild differs by
a byte from what is committed and attested. Verified by changing a disclosure string in `src/` and
running it: exit 1, naming the file; restored, exit 0.

So a publish from any machine ships the attested bytes or does not happen. `publish.yml` runs on the
tagged commit CI attested — this guard makes a mismatch loud rather than making the job unnecessary.
