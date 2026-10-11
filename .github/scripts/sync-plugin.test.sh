#!/usr/bin/env bash
# Offline proof that scripts/sync-plugin.sh --check can go RED, and goes red for the right reason.
# Run: bash .github/scripts/sync-plugin.test.sh
#
# --check is what stops plugin/ (the folder a plugin install copies) from drifting away from the
# build it is a copy of, and from growing the things that make an install expensive or wrong: a
# lockfile, a symlink, a declared server. It runs in CI BEFORE the build on purpose, so a regression
# in its own logic would otherwise be caught only indirectly and only for stale copies. Each case
# builds a throwaway repository shaped like this one, brings plugin/ up to date with the script's own
# write mode, damages exactly one thing, and runs a copy of the script (it finds the repository root
# from its own location, so it must live in the tree it checks). Needs node, as the check itself does.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; script="$here/../../scripts/sync-plugin.sh"
[ -f "$script" ] || { echo "FAIL: $script not found"; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
t="$tmp/tree"; pass=0

COPIES=(dist/treasury.mjs dist/connect-page.js registry/vaults.json LICENSE NOTICE THIRD_PARTY_NOTICES.md THIRD_PARTY_NOTICES.connect-page.md)

tree() { # tree [version] — a repository whose plugin/ is up to date, built by the script's own write mode
  local v="${1:-0.1.2}"
  rm -rf "$t"; mkdir -p "$t/scripts" "$t/dist" "$t/registry" "$t/.claude-plugin" "$t/.agents/plugins" \
    "$t/plugin/.claude-plugin" "$t/plugin/.codex-plugin" "$t/plugin/skills/earn"
  cp "$script" "$t/scripts/sync-plugin.sh"
  printf '{ "name": "@temporalabs/treasury", "version": "%s" }\n' "$v" > "$t/package.json"
  local f; for f in "${COPIES[@]}"; do printf 'content of %s\n' "$f" > "$t/$f"; done
  printf '{ "name": "treasury", "plugins": [ { "name": "treasury", "source": "./plugin", "version": "%s" } ] }\n' "$v" > "$t/.claude-plugin/marketplace.json"
  printf '{ "name": "treasury", "plugins": [ { "name": "treasury", "source": { "source": "local", "path": "./plugin" } } ] }\n' > "$t/.agents/plugins/marketplace.json"
  printf '{ "name": "treasury", "version": "%s" }\n' "$v" > "$t/plugin/.claude-plugin/plugin.json"
  printf '{ "name": "treasury", "version": "%s" }\n' "$v" > "$t/plugin/.codex-plugin/plugin.json"
  cat > "$t/plugin/skills/earn/SKILL.md" <<'MD'
---
name: earn
---
Run the CLI through the shell:

node "${CLAUDE_PLUGIN_ROOT}/dist/treasury.mjs" earn <command> --flag value
MD
  (cd "$t" && bash scripts/sync-plugin.sh >/dev/null)
}
put() { printf '%s\n' "$2" > "$t/$1"; } # put <file> <content>

fingerprint() { (cd "$t" && LC_ALL=C find . -type f -o -type l | LC_ALL=C sort | while read -r p; do printf '%s %s\n' "$p" "$(sha256sum < "$p" 2>/dev/null | cut -d' ' -f1)"; done | sha256sum | cut -d' ' -f1); }

# expect <exit> <regex-the-output-must-match | -> <label>
expect() {
  local want="$1" rx="$2" label="$3"
  local out got
  set +e; out=$(cd "$t" && bash scripts/sync-plugin.sh --check 2>&1); got=$?; set -e
  if [ "$got" -ne "$want" ]; then echo "FAIL: $label — exit $got, wanted $want"; echo "$out" | sed 's/^/    /'; exit 1; fi
  if [ "$rx" != "-" ] && ! printf '%s\n' "$out" | grep -Eq -- "$rx"; then
    echo "FAIL: $label — exit $got as wanted, but the output does not say why (wanted /$rx/)"; echo "$out" | sed 's/^/    /'; exit 1
  fi
  pass=$((pass+1)); echo "ok: $label (exit $got)"
}

tree
expect 0 'ok  marketplace source ./plugin; no server declared' "a plugin/ brought up to date passes, and the layout it pins is reported"
expect 0 'ok  plugin/package.json \(0.1.2, no dependencies\)' "...including its version-only manifest"
(cd "$t" && bash scripts/sync-plugin.sh >/dev/null)
expect 0 - "the write mode is idempotent: writing again changes nothing the check can see"

# every copy, one at a time: a file left out of the list is a file that can drift unseen
for f in "${COPIES[@]}"; do
  tree
  printf 'a stale line\n' >> "$t/plugin/$f"
  expect 1 "plugin/$f::differs from $f" "a stale copy of $f is named"
done

tree; rm "$t/plugin/registry/vaults.json"
expect 1 'plugin/registry/vaults.json::missing' "a copy that was deleted is named missing, not skipped"
tree; printf 'changed at the root, not re-synced\n' >> "$t/NOTICE"
expect 1 'plugin/NOTICE::differs from NOTICE' "the root file changed and the copy was not refreshed"
tree; printf 'x\n' >> "$t/plugin/dist/treasury.mjs"; printf 'y\n' >> "$t/plugin/NOTICE"
out=$(cd "$t" && bash scripts/sync-plugin.sh --check 2>&1 || true)
n=$(printf '%s\n' "$out" | grep -c '::differs from' || true)
[ "$n" = 2 ] || { echo "FAIL: two stale copies must be two errors, not the first only — got $n"; echo "$out" | sed 's/^/    /'; exit 1; }
pass=$((pass+1)); echo "ok: every stale copy is reported, not just the first (2 of 2)"

# the discriminating one: a symlink to the root file has IDENTICAL bytes, so a byte comparison alone passes it
tree; rm "$t/plugin/NOTICE"; ln -s ../NOTICE "$t/plugin/NOTICE"
cmp -s "$t/NOTICE" "$t/plugin/NOTICE" || { echo "FAIL: fixture error — the symlink does not read as identical"; exit 1; }
expect 1 'plugin/NOTICE::is a symlink' "a symlink whose bytes match the root file still fails (a plugin install copies plugin/ alone)"

# the manifest has to be EXACTLY the version-only one
tree; put plugin/package.json '{ "name": "treasury-plugin", "version": "0.1.2", "private": true, "dependencies": { "viem": "^2" } }'
expect 1 'plugin/package.json::must be exactly the version-only manifest for 0.1.2' "a dependency added to plugin/package.json"
tree; sed -E 's/"version": "0.1.2"/"version": "0.1.1"/' "$t/package.json" > "$t/package.json.new" && mv "$t/package.json.new" "$t/package.json"
expect 1 'plugin/package.json::must be exactly the version-only manifest for 0.1.1' "the root version moved on and plugin/package.json was not refreshed"

# the reason plugin/ exists: no lockfile beside its package.json, whatever the package manager
for lock in package-lock.json npm-shrinkwrap.json bun.lock bun.lockb yarn.lock pnpm-lock.yaml; do
  tree; printf '{}\n' > "$t/plugin/$lock"
  expect 1 "plugin/$lock::a lockfile in plugin/" "a $lock in plugin/ is refused"
done

# the layout pins
tree; put .claude-plugin/marketplace.json '{ "plugins": [ { "name": "treasury", "source": "./", "version": "0.1.2" } ] }'
expect 1 'the treasury entry must have source "./plugin"' "the Claude Code marketplace points at the repository root, which holds a lockfile"
tree; put .claude-plugin/marketplace.json '{ "plugins": [ { "name": "other", "source": "./plugin", "version": "0.1.2" } ] }'
expect 1 'the treasury entry must have source "./plugin"' "the marketplace has no entry named treasury"
tree; put .agents/plugins/marketplace.json '{ "plugins": [ { "name": "treasury", "source": { "source": "local", "path": "./" } } ] }'
expect 1 'the treasury entry must have path "./plugin"' "the Codex marketplace points at the repository root"
tree; put plugin/.mcp.json '{ "mcpServers": { "treasury": { "command": "node", "args": ["server.mjs"] } } }'
expect 1 'plugin/.mcp.json: the plugin is headless' "a server declared in plugin/.mcp.json (a redirected launch path is the same failure)"
tree; put plugin/.claude-plugin/plugin.json '{ "name": "treasury", "version": "0.1.2", "mcpServers": { "treasury": { "command": "node" } } }'
expect 1 'plugin/.claude-plugin/plugin.json: declares mcpServers' "a server declared INLINE in the Claude Code manifest, which the file check cannot see"
tree; put plugin/.codex-plugin/plugin.json '{ "name": "treasury", "version": "0.1.2", "mcpServers": { "treasury": { "command": "node" } } }'
expect 1 'plugin/.codex-plugin/plugin.json: declares mcpServers' "a server declared inline in the Codex manifest"
tree; printf '%s\n' '---' 'name: earn' '---' 'Run: node "dist/somewhere-else.mjs" earn quote' > "$t/plugin/skills/earn/SKILL.md"
expect 1 'the skill must run node' "the skill runs some other file than the copy this script checks"
tree; rm "$t/plugin/skills/earn/SKILL.md"
expect 1 - "the skill file is missing altogether (the layout check cannot read it)"

# --check is read-only: a failing check must leave the tree exactly as it found it
tree; printf 'stale\n' >> "$t/plugin/NOTICE"
before=$(fingerprint)
set +e; (cd "$t" && bash scripts/sync-plugin.sh --check >/dev/null 2>&1); got=$?; set -e
after=$(fingerprint)
[ "$got" = 1 ] || { echo "FAIL: fixture error — the damaged tree should fail, exit $got"; exit 1; }
[ "$before" = "$after" ] || { echo "FAIL: --check changed the tree it was checking"; exit 1; }
pass=$((pass+1)); echo "ok: a failing --check changes nothing (it does not repair what it reports)"

echo "all $pass cases behaved"
