#!/usr/bin/env bash
# Refresh plugin/ and connect-plugin/ from this repository's own build, or check that they are already fresh.
#
# The Claude Code plugins ship from plugin/ (earn) and connect-plugin/ (connect), not from the repository root. A plugin install copies
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
# fewer files is the failure this exists to prevent. Each entry is <source at the root>:<path in the folder>.
EARN_FILES=(dist/mcp-server.mjs:dist/mcp-server.mjs registry/vaults.json:registry/vaults.json LICENSE:LICENSE NOTICE:NOTICE THIRD_PARTY_NOTICES.md:THIRD_PARTY_NOTICES.md)
CONNECT_FILES=(dist/connect-server.mjs:dist/connect-server.mjs LICENSE:LICENSE NOTICE:NOTICE CONNECT_THIRD_PARTY_NOTICES.md:THIRD_PARTY_NOTICES.md)

version=$(node -e 'process.stdout.write(require("./package.json").version)')
manifest_for() { printf '{\n  "name": "%s",\n  "version": "%s",\n  "private": true\n}\n' "$1" "$version"; }

check_dir() { # <dir> <manifest name> <files...>
  local dir=$1 name=$2; shift 2
  local stale=0 pair src dst
  for pair in "$@"; do
    src=${pair%%:*}; dst=${pair##*:}
    if [ -L "$dir/$dst" ]; then
      echo "::error file=$dir/$dst::is a symlink — a plugin install copies $dir/ alone, so it must be a real file"; stale=1
    elif [ ! -f "$dir/$dst" ]; then
      echo "::error file=$dir/$dst::missing — run: bash scripts/sync-plugin.sh"; stale=1
    elif ! cmp -s "$src" "$dir/$dst"; then
      echo "::error file=$dir/$dst::differs from $src — run: bash scripts/sync-plugin.sh"; stale=1
    else
      echo "  ok  $dir/$dst"
    fi
  done
  if ! cmp -s "$dir/package.json" <(manifest_for "$name"); then
    echo "::error file=$dir/package.json::must be exactly the version-only manifest for $version (no dependencies) — run: bash scripts/sync-plugin.sh"; stale=1
  else
    echo "  ok  $dir/package.json ($version, no dependencies)"
  fi
  # The reason these folders exist: an install must not find a lockfile beside package.json.
  for lock in package-lock.json npm-shrinkwrap.json bun.lock bun.lockb yarn.lock pnpm-lock.yaml; do
    if [ -e "$dir/$lock" ]; then echo "::error file=$dir/$lock::a lockfile in $dir/ makes every install run a dependency install — remove it"; stale=1; fi
  done
  return "$stale"
}

sync_dir() { # <dir> <manifest name> <files...>
  local dir=$1 name=$2; shift 2
  local pair src dst
  for pair in "$@"; do
    src=${pair%%:*}; dst=${pair##*:}
    mkdir -p "$(dirname "$dir/$dst")"; cp "$src" "$dir/$dst"
  done
  manifest_for "$name" > "$dir/package.json"
  echo "$dir/ refreshed from this tree (version $version)"
}

if [ "${1:-}" = "--check" ]; then
  stale=0
  check_dir plugin treasury-plugin "${EARN_FILES[@]}" || stale=1
  check_dir connect-plugin connect-plugin "${CONNECT_FILES[@]}" || stale=1
  # The layout these folders exist for: the marketplace must install the folder (not the root, which
  # holds a lockfile), and each plugin must launch the copy this script checks, not some other file.
  if ! node -e '
    const fs = require("node:fs");
    const bad = [];
    const cc = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"));
    const ag = JSON.parse(fs.readFileSync(".agents/plugins/marketplace.json", "utf8"));
    for (const [name, dir, server, key] of [["treasury", "plugin", "mcp-server.mjs", "treasury"], ["connect", "connect-plugin", "connect-server.mjs", "connect"]]) {
      const entry = (cc.plugins || []).find((p) => p.name === name);
      if (!entry || entry.source !== "./" + dir) bad.push(".claude-plugin/marketplace.json: the " + name + " entry must have source \"./" + dir + "\"");
      const aentry = (ag.plugins || []).find((p) => p.name === name);
      if (!aentry || !aentry.source || aentry.source.path !== "./" + dir) bad.push(".agents/plugins/marketplace.json: the " + name + " entry must have path \"./" + dir + "\"");
      const mcp = JSON.parse(fs.readFileSync(dir + "/.mcp.json", "utf8"));
      const args = mcp.mcpServers && mcp.mcpServers[key] && mcp.mcpServers[key].args;
      if (JSON.stringify(args) !== JSON.stringify(["${CLAUDE_PLUGIN_ROOT}/dist/" + server])) bad.push(dir + "/.mcp.json: the " + key + " server must launch ${CLAUDE_PLUGIN_ROOT}/dist/" + server);
    }
    for (const b of bad) console.log("::error::" + b);
    process.exit(bad.length ? 1 : 0);
  '; then stale=1; else echo "  ok  marketplace sources ./plugin and ./connect-plugin; each plugin launches its own bundle"; fi
  exit "$stale"
fi

sync_dir plugin treasury-plugin "${EARN_FILES[@]}"
sync_dir connect-plugin connect-plugin "${CONNECT_FILES[@]}"
