# Release process

Two artifacts ship from this repository, on **two different channels**, and only one of them
involves npm. Getting that distinction wrong is the reason this page exists.

| what ships | from | channel | needs an npm publish? |
|---|---|---|---|
| `@temporalabs/treasury` — the library and the CLI bundle | this repository | **npm registry** | **yes, every release** |
| the `earn` plugin and skill | this repository's [`plugin/`](../plugin/) folder | **git ref**, via `claude plugin marketplace add` | **no, never** |

The plugin is installed by pointing Claude Code at a git ref; there is no registry in the path, so
a plugin release is a merge and a tag and nothing else. Its `plugin/package.json` keeps
`"private": true` deliberately, and `plugin/` is outside the npm package's `files` list.

## 🔴 npm does not update itself, and a published version is permanent

Two properties, and every rule below follows from them:

1. **The registry never pulls.** Publishing is a push. Merging to `main`, moving a tag, or
   rebuilding the bundle changes nothing on npm — consumers keep resolving the last version that
   was actually published, forever, until someone publishes another one.
2. **A published version is immutable.** `0.1.0` can carry exactly one tarball for all time.
   Unpublishing is narrow, time-boxed, and does not free the number for reuse.

Together: **there is no such thing as re-publishing a release.** Shipping changed code to npm means
publishing a *new version number*. So the publish is not a one-time setup task — it is a step in
every release, and a release that skips it leaves npm consumers on the previous release with no
signal that anything happened.

## The sequence

1. Land the work on `release/vX.Y.Z`.
2. **Bump the version if it is not already the version being released**, in every place it is
   declared: `package.json`, the two `version` fields at the top of `package-lock.json`,
   `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json` and the `treasury` entry
   in `.claude-plugin/marketplace.json`. Then run `npm run build` and commit what it changes in the
   same commit: on a version bump that is `plugin/package.json`, `llms.txt`, `dist/treasury.mjs` and
   `plugin/dist/treasury.mjs`, since `llms.txt` and both bundled CLIs carry the version. CI rebuilds
   and fails when any of them differs from what the build produces. `npm run plugin:check` confirms
   the declarations agree (all but the lockfile, which `npm install` rewrites to match
   `package.json`); CI fails when they do not. Do this before tagging — the publish workflow refuses a tag that disagrees with
   `package.json`, which is the guard that stops a release burning the wrong immutable version number.
3. **Move the install instructions to the new version in the release pull request**: every pin in
   `README.md` and `docs/` (`npm install @temporalabs/treasury@X.Y.Z`,
   `TemporaLabs/treasury@vX.Y.Z`, `TemporaLabs/treasury/blob/vX.Y.Z/…` links). This cannot wait for
   the publish: the plugin installs from the tag, so a tagged tree whose documentation named the
   previous version would send every reader to a tree without this release in it. CI holds the pins
   on `main`, and in any pull request into it, to `package.json`'s version.
4. Merge the release pull request into `main` with a merge commit. **Do steps 4 to 7 in one
   sitting:** from the merge until the tag and the publish exist, `main`'s install lines name a ref
   that does not resolve and a version npm does not have. CI on `main` warns until the tag exists.
5. Tag the merge commit, annotated: `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`. A tag push
   runs no workflow.
6. Publish to npm: run the **`publish`** workflow, `tag: vX.Y.Z`, **`dry_run: true` first**. It
   checks the plugin's copies, every version declaration and the install pins at the tag, re-runs the
   full suite,
   refuses a tag that disagrees with `package.json`, refuses a version that already exists, and
   refuses a tag that is not an ancestor of `main`. Re-run with `dry_run: false` once it is green.
7. Verify both channels as a user would.
   - **npm:** `npm view @temporalabs/treasury@X.Y.Z version` answers, and a clean project that
     installs it gets a `treasury` whose `--version` reports `X.Y.Z`.
   - **The plugin**, which ships with the same tag and involves no npm: in a clean configuration
     (`CLAUDE_CONFIG_DIR` pointing at an empty directory), run
     `claude plugin marketplace add TemporaLabs/treasury@vX.Y.Z` and
     `claude plugin install treasury@treasury`. Then check that `claude plugin list` shows `X.Y.Z`
     and that a new session runs `earn vaults` through the skill.
8. Open the next cycle. Cut `release/vX.Y.Z+1` from `main`'s tip and bump every version declaration
   in step 2 to the new version, then run `npm run build` and commit everything it changed
   (`plugin/package.json`, `llms.txt` and both bundles) in the same commit as the bump. CI on a
   version branch fails when `package.json` does not declare the branch's version and when a
   committed bundle or `llms.txt` is stale, so a bump without the build leaves the new branch red
   from its first commit. The install pins in `README.md` and `docs/` stay on the published version
   until that cycle's release pull request moves them (step 3).

## Why the publish is `workflow_dispatch`, not a tag trigger

Tagging and publishing are two irreversible acts and this repository keeps them separate. A tag can
be moved or deleted; an npm version cannot. If pushing a tag published automatically, then
`git push --tags` would spend the one-shot version number as a side effect of an action people
reasonably treat as cheap. Someone tags, looks at the tag, and then chooses to publish it.

Provenance comes from the workflow's own OIDC identity, which is why the publish runs in CI and not
from anyone's machine: a local `npm publish` cannot mint it.
