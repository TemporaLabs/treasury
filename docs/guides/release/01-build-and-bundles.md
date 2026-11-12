# 01: The build, the committed bundles and the plugin copies

## Why the build output is committed

The Claude Code plugin is installed by copying a folder from a git ref, and that install runs no
build. So the CLI must arrive as one self-contained file that a bare `node` can run, and it must be in
the repository. That is `dist/treasury.mjs`, and its copy `plugin/dist/treasury.mjs`. The connect page
bundle (`dist/connect-page.js`) is committed for the same reason. CI rebuilds each and fails on a
difference of a byte, so the committed file is always the build of the committed source.

## `npm run build`, step by step

The `build` script in `package.json` runs, in order:

| step | what it does | output |
|---|---|---|
| `tsc -b` | compiles the library and its type declarations | `dist/index.js`, `dist/index.d.ts` and the rest of the library (not committed) |
| `tsup` | bundles `src/cli.ts` with every dependency inlined into one ESM file with a `node` shebang (`tsup.config.ts`) | `dist/treasury.mjs` |
| `scripts/third-party-notices.ts --write` | writes the licence of every package the bundle actually inlines, read from the bundle's own module comments, not from `package.json` | `THIRD_PARTY_NOTICES.md` |
| `scripts/llms-txt.ts --write` | writes the guide for agents running the CLI without the plugin: the Earn skill's body, then every command and flag exactly as `--help` prints them | `llms.txt` |
| `scripts/sync-plugin.sh` | copies the plugin's files from the root and writes its version-only `plugin/package.json` | `plugin/` |

Two details in `tsup.config.ts` matter:

- **Only the version is inlined from `package.json`.** `src/version.ts` imports the manifest, and the
  `versionOnly` esbuild plugin replaces it with `{ version }`, so a dev-dependency bump does not change
  the bundle while `treasury --version` still reports the version it was built from.
- **`noExternal` inlines everything**, including the registry JSON, so the bundle reads no file beside
  itself ([`../../design-embed-registry-and-version.md`](../../design-embed-registry-and-version.md)).

`llms.txt` and the third-party notices each have a check mode without `--write`
(`npm run llms:check`, `npm run notices:check`) that exits 1 when the committed file is stale.

## The connect page is a separate build

`connect-page/` has its own `package.json` and lockfile. Run `npm ci && npm run build` there:
`connect-page/build.mjs` bundles `connect-page/src/main.tsx` with esbuild into one minified
`dist/connect-page.js`, stubs out every WalletConnect and Reown module and fails if one returns, and
writes `THIRD_PARTY_NOTICES.connect-page.md` from what the bundle inlines. Then run `npm run build` at
the root so `scripts/sync-plugin.sh` copies the page into `plugin/`. Commit all of it.

## The plugin folder

`plugin/` is what the marketplaces install (`.claude-plugin/marketplace.json` for Claude Code,
`.agents/plugins/marketplace.json` for Codex, both pointing at `./plugin`). It holds the skill
(`plugin/skills/earn/SKILL.md`), its manifests (`plugin/.claude-plugin/plugin.json`,
`plugin/.codex-plugin/plugin.json`), and **copies** of root files written by `scripts/sync-plugin.sh`.
The list of copied files is hardcoded in that script on purpose. `npm run plugin:check` (the script's
`--check` mode plus `scripts/check-versions.sh`) fails on:

- a copy that is missing, a symlink, or differs from its source;
- a `plugin/package.json` that is not exactly the version-only manifest;
- any lockfile in `plugin/`, since an install would then run a dependency install;
- a marketplace entry that does not install `./plugin`, a declared server (the plugin is headless:
  the skill runs the CLI), or a skill that does not run the checked copy of the bundle;
- any version declaration that disagrees with `package.json` (the list is in `scripts/check-versions.sh`).

Never edit a copy in `plugin/` by hand; edit the source and rebuild. `npm run lint:skill`
(`scripts/lint-skill.sh`) validates the skill against the official skill specification.

## What CI holds to a fresh build

The `check` job in `.github/workflows/ci.yml` (read its step names for the current list) rebuilds and
compares the CLI bundle and its plugin copies, the connect page and its notices, and `llms.txt`;
packs the npm artifact and checks it ships the licence and notice files; runs the bundle and asserts
its exact command and flag set with no sign or send command; and compares the skill's command table
with the CLI's. The `cli-exit` job installs the package on several operating systems and Node versions
and checks the bundle's exit codes. The `attest` job mints and verifies a provenance attestation for
`dist/treasury.mjs` on the public repository.

`prepack` in `package.json` runs the build and refuses to pack if it changed `dist/treasury.mjs`,
`THIRD_PARTY_NOTICES.md` or `llms.txt`, so a stale tree cannot be packed by accident.

## When you change something here

- After any change under `src/`, or to `registry/vaults.json`, `LICENSE` or `NOTICE`: `npm run build`,
  then commit the bundle, the plugin copies and anything regenerated.
- After a change to the skill or to any command description: `npm run build` regenerates `llms.txt`.
- Do not bump versions in a feature pull request. The version follows the release branch, and the
  release sequence in [`../../release-process.md`](../../release-process.md) moves every declaration
  together.
- The build's last step uses `bash`; on Windows run it from Git Bash or WSL.
