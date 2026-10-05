# Design note: embed the registry and the version at build time

Status: proposal, for decision. Tracks issue #59. Nothing here is implemented; the measurements
below come from a throwaway spike that was not committed.

## The problem

`src/registry.ts` and `src/version.ts` read `../registry/vaults.json` and `../package.json` at runtime,
relative to their own module file. That holds in every layout this repository ships: the repository
root, an npm install under `node_modules/@temporalabs/treasury/`, and the plugin's `plugin/` folder
(including through the npm bin symlink).

It does not hold for a library consumer who bundles `dist/index.js` into their own output. Then
`import.meta.url` is the consumer's bundle, and both files are looked for beside it.

Reproduced on this branch by bundling `dist/index.js` with esbuild into a folder of its own and calling
`listVaults()`:

| layout beside the consumer's bundle | result |
|---|---|
| no `registry/` | `ENOENT`, on the first registry read |
| a `registry/vaults.json` one level up | that file is parsed instead; here it failed the schema, and a schema-valid one would be served as Treasury's registry |

The second row is the dangerous one: the registry is the list of vaults the client will build calls
for, and it should not be selectable by what happens to sit near the consumer's output.

(`src/connect/page.ts` has the same read-beside-me shape for the page bundle. It is not exported from
`index.ts`, so it is not a library hazard, and this note leaves it alone.)

## Options

**A. Leave it, and document that the library must not be re-bundled.** No code change. The failure
stays, and the "wrong registry read silently" row stays with it.

**B. Import the two JSON files with import attributes** (`import registry from "../registry/vaults.json"
with { type: "json" }`, and the same for `package.json`). No generated file; the single source of each
value stays where it is. A consumer's bundler resolves the import from `dist/` at the consumer's own
build time and inlines it; the CLI bundle (`tsup`) inlines it too.

**C. A generated module inside `src/`** (for example `src/generated/registry.ts`, written by a build
step from the two files). The same outcome as B, at the cost of a generated file that must be kept
fresh and a CI check that says so.

## What a spike of B measured

- `tsc -b` compiles it and emits the `with { type: "json" }` import unchanged; `dist/registry.js`
  then imports `../registry/vaults.json`, which the npm package ships.
- The consumer re-bundle from the table above now works with no registry beside it (`listVaults()`
  returns the four vaults of that revision).
- The `tsup` CLI bundle runs from a directory holding neither `registry/` nor `package.json`:
  `--version` prints `0.1.2` and `earn vaults` lists the registry. The bundle grew by about 15 KB,
  the registry now being inside it.
- The unit suite then fails four tests, and that is the real cost of B:
  - `boundary.unit.test.ts`, two tests: the module-reach audit requires every import to resolve inside
    `src/`, and `../registry/vaults.json` does not. This is the guard behind the security model's
    "reaches outside the package" claim, so loosening it is a decision, not a fix. Option C passes it
    by construction.
  - `entrypoint.unit.test.ts`, two tests: they copy the bundle next to a deliberately broken
    `registry/vaults.json` and check that the CLI reports the problem by command instead of failing to
    start. With the registry inside the bundle there is nothing to swap, so these need another way to
    feed the CLI a broken registry (a build-time fixture, or an environment-free seam that already
    exists for the in-process tests).
- `sync-plugin.sh --check` reports `plugin/dist/treasury.mjs` stale after the rebuild, as it should.

## What changes under either B or C

- **`plugin/` shrinks.** Its `registry/vaults.json` and its version-only `package.json` exist only
  because the bundle reads them at runtime. Embedded, the bundle needs neither. Dropping them removes
  the exact-manifest check in `scripts/sync-plugin.sh`, the `plugin/package.json` declaration in
  `scripts/check-versions.sh` (five declarations become four), and the cases in the two offline test
  scripts that exercise them. Keeping them is harmless but then misleading: a reader would assume
  they are read.
- **`treasury --version` stops following the file beside the bundle.** It reports the version the
  bundle was built from. `check-versions.sh` still has to hold every manifest to the same version, and
  that check becomes the only thing tying the plugin manifests to the bundle, so it must stay.
- **A registry-only edit now changes `dist/treasury.mjs`** (and its plugin copy), so the existing
  "dist is stale" CI step fires on every registry change. That is correct: the bundle is what ships.
  The cost is that a registry PR now also carries the rebuilt bundle and its plugin copy, as a diff of
  the embedded registry text, where it carried neither.
- **The symlink handling added in #57** (resolving the module's real path) is no longer needed for
  these two reads. It is still needed for the page bundle.
- **The consumer's own bundler must accept JSON import attributes** under B (esbuild, webpack 5 and
  Rollup with its JSON plugin do). Under C it needs only to bundle TypeScript output.

## Recommendation

Do B for the registry and the version, and decide the boundary test explicitly: allow exactly the two
named JSON files as in-package reaches, by path, not by pattern. Prefer B to C because it adds no
generated file to go stale, and the reach allow-list is two lines that a reviewer can read. If the
maintainers do not want the audit loosened at all, C is the same behaviour with the audit untouched.

Import `package.json` for `version` only if embedding the whole manifest is acceptable (about 2 KB
here); otherwise C's generated module can carry just the number.

Do not remove `plugin/registry/` or `plugin/package.json` in the same change. That is a second change
with its own check updates, best landed right after, so that each can be reviewed alone.

## Open questions

1. B with an explicit two-path allow-list in the boundary test, or C so the audit stays as written?
2. Is it acceptable that every registry-only PR also rebuilds and commits the bundle? The alternative is to keep reading the
   registry at runtime and fix only the version, which leaves the table's second row open.
3. Which release carries it? It changes how `dist/index.js` resolves its data, so it is a library-visible
   change even though the CLI behaves the same.
