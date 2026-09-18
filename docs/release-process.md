# Release process

Two artifacts ship from two repositories, on **two different channels**, and only one of them
involves npm. Getting that distinction wrong is the reason this page exists.

| what ships | from | channel | needs an npm publish? |
|---|---|---|---|
| `@temporalabs/treasury` — the library and the MCP server bundle | this repository | **npm registry** | **yes, every release** |
| the `earn` plugin and skill | the plugin repository | **git ref**, via `claude plugin marketplace add` | **no, never** |

The plugin is installed by pointing Claude Code at a git ref; there is no registry in the path, so
a plugin release is a merge and a tag and nothing else. It keeps `"private": true` deliberately.

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
2. **Bump the version in `package.json` if it is not already the version being released.** Do this
   before tagging — the publish workflow refuses a tag that disagrees with `package.json`, which is
   the guard that stops a release burning the wrong immutable version number.
3. Merge the release pull request into `main`.
4. Tag the merge commit, annotated: `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`.
5. Publish to npm: run the **`publish`** workflow, `tag: vX.Y.Z`, **`dry_run: true` first**. It
   re-runs the full suite, refuses a tag that disagrees with `package.json`, refuses a version that
   already exists, and refuses a tag that is not an ancestor of `main`. Re-run with
   `dry_run: false` once it is green.
6. Update any documentation that names the published version or told readers to vendor the bundle
   by hand — **after** the publish, never in the same change that merely makes publishing possible.
   A document that says "install from npm" is false until step 5 has actually run.
7. Release the plugin separately: merge, tag, and point the marketplace at the new ref. No npm.

## Why the publish is `workflow_dispatch`, not a tag trigger

Tagging and publishing are two irreversible acts and this repository keeps them separate. A tag can
be moved or deleted; an npm version cannot. If pushing a tag published automatically, then
`git push --tags` would spend the one-shot version number as a side effect of an action people
reasonably treat as cheap. Someone tags, looks at the tag, and then chooses to publish it.

Provenance comes from the workflow's own OIDC identity, which is why the publish runs in CI and not
from anyone's machine: a local `npm publish` cannot mint it.
