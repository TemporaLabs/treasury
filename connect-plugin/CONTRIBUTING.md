# Contributing to the Agent Treasury Connect plugin

This repository is open source under the Apache License, Version 2.0 (see
[`LICENSE`](LICENSE)). You can use, modify and redistribute it freely, and improvements are
welcome. Tempora Labs reviews every change and decides what merges.

This repository carries the server source (`src/`), its tests, the skill, the plugin manifests, and the
built files the plugin runs (`dist/`).

## Before you open a pull request

- **Run the checks:** `npm run typecheck`, `npm test` and `bash scripts/lint-skill.sh` must pass.
- **Rebuild `dist/`:** `npm run build` after any change under `src/`, and commit the result. CI fails if
  `dist/connect-server.mjs` is not the build of `src/`. Never edit `dist/` by hand.
- **The skill's `description:` decides whether the skill is reached at all, so treat a change to it
  as a behavioural change.** Measure it by running the plugin — `claude -p --plugin-dir <this tree>`
  from a working directory that is *not* this tree, then check which tools the run actually
  invoked. A description that reads better is not evidence of anything.
- **Keep a pull request to one change.** A documentation fix found along the way gets its own pull
  request.

## What lives here

The whole connect plugin: the MCP server (`src/`), the two pages it serves, the skill, and the
manifests. Deciding what a transaction contains belongs to Earn
([TemporaLabs/treasury-plugin](https://github.com/TemporaLabs/treasury-plugin)), not here.

## Security

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
