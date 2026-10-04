#!/usr/bin/env bash
# Offline proof that scripts/check-versions.sh can go RED, and that it goes red for the right reason.
# Run: bash .github/scripts/check-versions.test.sh
#
# check-versions.sh is a gate over five version declarations. A gate that has only ever been run
# against a matching tree has not been shown to discriminate, and the failure that matters most here
# is the quiet one: two documents that BOTH lost their version field must not "agree" on nothing.
# Each case builds a throwaway tree shaped like this repository's declarations and runs a copy of the
# script inside it (the script finds the repository root from its own location, so it has to live in
# the tree it checks). Exit codes: 0 agree, 1 disagree or wrong version, 2 a declaration could not
# be read, so nothing was compared.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; script="$here/../../scripts/check-versions.sh"
[ -f "$script" ] || { echo "FAIL: $script not found"; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
t="$tmp/tree"; pass=0

tree() { # tree <version> — a repository with all five declarations at <version>, and a copy of the script
  rm -rf "$t"; mkdir -p "$t/scripts" "$t/plugin/.claude-plugin" "$t/plugin/.codex-plugin" "$t/.claude-plugin"
  cp "$script" "$t/scripts/check-versions.sh"
  printf '{ "name": "treasury", "version": "%s" }\n' "$1" > "$t/package.json"
  printf '{ "name": "treasury-plugin", "version": "%s", "private": true }\n' "$1" > "$t/plugin/package.json"
  printf '{ "name": "treasury", "version": "%s" }\n' "$1" > "$t/plugin/.claude-plugin/plugin.json"
  printf '{ "name": "treasury", "version": "%s" }\n' "$1" > "$t/plugin/.codex-plugin/plugin.json"
  printf '{ "name": "treasury", "plugins": [ { "name": "treasury", "source": "./plugin", "version": "%s" } ] }\n' "$1" > "$t/.claude-plugin/marketplace.json"
}
put() { printf '%s\n' "$2" > "$t/$1"; } # put <file> <content> — replace one declaration

# expect <exit> <regex-the-output-must-match | -> <label> [args to the script]
# The exit status is read straight from the command, never through a pipe, and the output must show
# the reason the case names: a different failure that happens to share the exit code is not a pass.
expect() {
  local want="$1" rx="$2" label="$3"; shift 3
  local out got
  set +e; out=$(cd "$t" && bash scripts/check-versions.sh "$@" 2>&1); got=$?; set -e
  if [ "$got" -ne "$want" ]; then echo "FAIL: $label — exit $got, wanted $want"; echo "$out" | sed 's/^/    /'; exit 1; fi
  if [ "$rx" != "-" ] && ! printf '%s\n' "$out" | grep -Eq -- "$rx"; then
    echo "FAIL: $label — exit $got as wanted, but the output does not say why (wanted /$rx/)"; echo "$out" | sed 's/^/    /'; exit 1
  fi
  pass=$((pass+1)); echo "ok: $label (exit $got)"
}

tree 0.1.2
expect 0 'all declarations agree: 0.1.2$' "all five declarations agree"
expect 0 '= expected 0.1.2' "all agree and equal the expected version" 0.1.2
expect 1 'every declaration says 0.1.2, but 0.1.3 was expected' "all agree but the expected version moved (a release that forgot to bump)" 0.1.3

# one declaration at a time drifts: each must be reachable by the check, or it covers fewer files than it names
for pair in \
  "plugin/.codex-plugin/plugin.json|a Codex manifest" \
  "plugin/.claude-plugin/plugin.json|the Claude Code plugin manifest" \
  "package.json|the root package.json (what an npm install reports)" \
  "plugin/package.json|the plugin's package.json (what the plugin's copy of the CLI reports)"; do
  tree 0.1.2
  f="${pair%%|*}"; what="${pair#*|}"
  sed -E 's/"version": "0.1.2"/"version": "0.1.1"/' "$t/$f" > "$t/$f.new" && mv "$t/$f.new" "$t/$f"
  expect 1 'more than one version: 0.1.1 0.1.2' "$what drifts, and the output names both versions"
done
tree 0.1.2
put .claude-plugin/marketplace.json '{ "plugins": [ { "name": "treasury", "source": "./plugin", "version": "0.1.1" } ] }'
expect 1 'more than one version: 0.1.1 0.1.2' "the marketplace entry drifts"

# a plugin entry for something else is not the treasury entry, whatever order the list is in
tree 0.1.2
put .claude-plugin/marketplace.json '{ "plugins": [ { "name": "other", "version": "9.9.9" }, { "name": "treasury", "version": "0.1.2" } ] }'
expect 0 'all declarations agree: 0.1.2$' "an unrelated plugin entry listed first is ignored; the treasury entry is read by name"

# the document changed shape: exit 2, never a pass — otherwise two documents that lost the field agree on nothing
tree 0.1.2
put plugin/.claude-plugin/plugin.json '{ "name": "treasury" }'
expect 2 'plugin/.claude-plugin/plugin.json has no version where this check expects one' "a version field removed from one manifest"
tree 0.1.2
put plugin/.claude-plugin/plugin.json '{ "name": "treasury" }'; put plugin/.codex-plugin/plugin.json '{ "name": "treasury" }'
expect 2 'has no version where this check expects one' "the field removed from TWO manifests — they must not 'agree' on the empty string"
tree 0.1.2
put plugin/.claude-plugin/plugin.json '{ "name": "treasury" }'; put plugin/.codex-plugin/plugin.json '{ "name": "treasury" }'
out=$(cd "$t" && bash scripts/check-versions.sh 2>&1 || true)
n=$(printf '%s\n' "$out" | grep -c 'has no version where this check expects one' || true)
[ "$n" = 2 ] || { echo "FAIL: both broken declarations must be reported, one error each — got $n"; echo "$out" | sed 's/^/    /'; exit 1; }
pass=$((pass+1)); echo "ok: every unreadable declaration is reported, not just the first (2 of 2)"
tree 0.1.2
put .claude-plugin/marketplace.json '{ "plugins": [ { "name": "treasury", "source": "./plugin" } ] }'
expect 2 '.claude-plugin/marketplace.json has no version where this check expects one' "the marketplace entry has no version field (a nested field removed)"
tree 0.1.2
put .claude-plugin/marketplace.json '{ "plugins": [ { "name": "other", "version": "0.1.2" } ] }'
expect 2 '.claude-plugin/marketplace.json has no version where this check expects one' "the marketplace has no entry named treasury"
tree 0.1.2
rm "$t/plugin/package.json"
expect 2 'plugin/package.json is missing' "a declaring file is missing entirely"
tree 0.1.2
put plugin/package.json '{ "name": "treasury-plugin", "version": "" }'
expect 2 'plugin/package.json has no version where this check expects one' "an empty version string is not a version"
tree 0.1.2
put plugin/package.json '{ "name": "treasury-plugin", "version": 12 }'
expect 2 'plugin/package.json has no version where this check expects one' "a version that is not a string is not a version"
tree 0.1.2
printf '{ not json\n' > "$t/package.json"
expect 2 'package.json has no version where this check expects one' "a declaration that does not parse"

# the script finds the repository from its own location, so where it is started from does not matter
tree 0.1.2
set +e; out=$(cd / && bash "$t/scripts/check-versions.sh" 2>&1); got=$?; set -e
[ "$got" = 0 ] && printf '%s\n' "$out" | grep -q 'all declarations agree: 0.1.2$' || { echo "FAIL: run from /, exit $got"; echo "$out" | sed 's/^/    /'; exit 1; }
pass=$((pass+1)); echo "ok: started from another directory it still reads this tree (exit 0)"
tree 0.1.2
sed -E 's/"version": "0.1.2"/"version": "0.1.1"/' "$t/package.json" > "$t/package.json.new" && mv "$t/package.json.new" "$t/package.json"
set +e; (cd / && bash "$t/scripts/check-versions.sh" >/dev/null 2>&1); got=$?; set -e
[ "$got" = 1 ] || { echo "FAIL: run from /, a drifted tree must still fail — exit $got"; exit 1; }
pass=$((pass+1)); echo "ok: started from another directory it still FAILS a drifted tree (exit 1)"

echo "all $pass cases behaved"
