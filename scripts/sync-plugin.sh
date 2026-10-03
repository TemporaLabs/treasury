#!/usr/bin/env bash
# Refresh plugin/ from this repository's own build, or check that it is already fresh.
#
# The Claude Code plugin ships from plugin/, not from the repository root. A plugin install copies
# its folder and, when that folder holds package.json AND a lockfile, runs `npm ci` inside it. The
# root has both, so a root-level plugin would install every dependency (169 packages, measured)
# for a CLI bundle that needs none of them. plugin/ therefore carries a version-only
# package.json and no lockfile, plus the files the CLI reads beside itself at runtime
# (../registry/vaults.json, ../package.json) and the licence files that must travel with it.
#
# Every file below is a COPY of a file at the root, made in the same commit. Nothing is pinned to
# a release and nothing is fetched: the check is byte identity against this tree.
#
# Usage: bash scripts/sync-plugin.sh           # write the copies
#        bash scripts/sync-plugin.sh --check   # exit 1 naming each stale copy, change nothing
set -euo pipefail
cd "$(dirname "$0")/.."

# Hardcoded on purpose: a list read from data can be shortened, and a check that silently covers
# fewer files is the failure this exists to prevent.
FILES=(dist/treasury.mjs registry/vaults.json LICENSE NOTICE THIRD_PARTY_NOTICES.md)

version=$(node -e 'process.stdout.write(require("./package.json").version)')
manifest=$(printf '{\n  "name": "treasury-plugin",\n  "version": "%s",\n  "private": true\n}\n' "$version")

if [ "${1:-}" = "--check" ]; then
  stale=0
  for f in "${FILES[@]}"; do
    if [ -L "plugin/$f" ]; then
      echo "::error file=plugin/$f::is a symlink — a plugin install copies plugin/ alone, so it must be a real file"; stale=1
    elif [ ! -f "plugin/$f" ]; then
      echo "::error file=plugin/$f::missing — run: bash scripts/sync-plugin.sh"; stale=1
    elif ! cmp -s "$f" "plugin/$f"; then
      echo "::error file=plugin/$f::differs from $f — run: bash scripts/sync-plugin.sh"; stale=1
    else
      echo "  ok  plugin/$f"
    fi
  done
  if ! cmp -s plugin/package.json <(printf '%s\n' "$manifest"); then
    echo "::error file=plugin/package.json::must be exactly the version-only manifest for $version (no dependencies) — run: bash scripts/sync-plugin.sh"; stale=1
  else
    echo "  ok  plugin/package.json ($version, no dependencies)"
  fi
  # The reason plugin/ exists: an install must not find a lockfile beside package.json.
  for lock in package-lock.json npm-shrinkwrap.json bun.lock bun.lockb yarn.lock pnpm-lock.yaml; do
    if [ -e "plugin/$lock" ]; then echo "::error file=plugin/$lock::a lockfile in plugin/ makes every install run a dependency install — remove it"; stale=1; fi
  done
  # The layout this folder exists for: the marketplace must install plugin/ (not the root, which holds
  # a lockfile), and the skill must run the copy this script checks, not some other file. Headless: no
  # server is declared, so nothing stays running between commands.
  if ! node -e '
    const fs = require("node:fs");
    const bad = [];
    const cc = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"));
    const entry = (cc.plugins || []).find((p) => p.name === "treasury");
    if (!entry || entry.source !== "./plugin") bad.push(".claude-plugin/marketplace.json: the treasury entry must have source \"./plugin\"");
    const ag = JSON.parse(fs.readFileSync(".agents/plugins/marketplace.json", "utf8"));
    const aentry = (ag.plugins || []).find((p) => p.name === "treasury");
    if (!aentry || !aentry.source || aentry.source.path !== "./plugin") bad.push(".agents/plugins/marketplace.json: the treasury entry must have path \"./plugin\"");
    if (fs.existsSync("plugin/.mcp.json")) bad.push("plugin/.mcp.json: the plugin is headless — the skill runs the CLI, and no server is declared");
    const skill = fs.readFileSync("plugin/skills/earn/SKILL.md", "utf8");
    if (!skill.includes("node \"${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs\"")) bad.push("plugin/skills/earn/SKILL.md: the skill must run node \"${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs\", the copy this script checks");
    for (const b of bad) console.log("::error::" + b);
    process.exit(bad.length ? 1 : 0);
  '; then stale=1; else echo "  ok  marketplace source ./plugin; no server declared; the skill runs dist/treasury.mjs"; fi
  exit "$stale"
fi

mkdir -p plugin/dist plugin/registry
for f in "${FILES[@]}"; do cp "$f" "plugin/$f"; done
printf '%s\n' "$manifest" > plugin/package.json
echo "plugin/ refreshed from this tree (version $version)"
