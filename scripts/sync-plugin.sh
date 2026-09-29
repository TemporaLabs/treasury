#!/usr/bin/env bash
# Refresh plugin/ from this repository's own build, or check that it is already fresh.
#
# The Claude Code plugin ships from plugin/, not from the repository root. A plugin install copies
# its folder and, when that folder holds package.json AND a lockfile, runs `npm ci` inside it. The
# root has both, so a root-level plugin would install every dependency (169 packages, measured)
# for a server bundle that needs none of them. plugin/ therefore carries a version-only
# package.json and no lockfile, plus the files the server reads beside itself at runtime
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
FILES=(dist/mcp-server.mjs registry/vaults.json LICENSE NOTICE THIRD_PARTY_NOTICES.md)

version=$(node -e 'process.stdout.write(require("./package.json").version)')
manifest=$(printf '{\n  "name": "treasury-plugin",\n  "version": "%s",\n  "private": true\n}\n' "$version")

if [ "${1:-}" = "--check" ]; then
  stale=0
  for f in "${FILES[@]}"; do
    if [ ! -f "plugin/$f" ]; then
      echo "::error file=plugin/$f::missing — run: bash scripts/sync-plugin.sh"; stale=1
    elif ! cmp -s "$f" "plugin/$f"; then
      echo "::error file=plugin/$f::differs from $f — run: bash scripts/sync-plugin.sh"; stale=1
    else
      echo "  ok  plugin/$f"
    fi
  done
  if [ "$(cat plugin/package.json 2>/dev/null)" != "$manifest" ]; then
    echo "::error file=plugin/package.json::must be exactly the version-only manifest for $version (no dependencies) — run: bash scripts/sync-plugin.sh"; stale=1
  else
    echo "  ok  plugin/package.json ($version, no dependencies)"
  fi
  # The reason plugin/ exists: an install must not find a lockfile beside package.json.
  for lock in package-lock.json npm-shrinkwrap.json bun.lock bun.lockb yarn.lock pnpm-lock.yaml; do
    if [ -e "plugin/$lock" ]; then echo "::error file=plugin/$lock::a lockfile in plugin/ makes every install run a dependency install — remove it"; stale=1; fi
  done
  exit "$stale"
fi

mkdir -p plugin/dist plugin/registry
for f in "${FILES[@]}"; do cp "$f" "plugin/$f"; done
printf '%s\n' "$manifest" > plugin/package.json
echo "plugin/ refreshed from this tree (version $version)"
