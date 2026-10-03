#!/usr/bin/env bash
# Every place this repository declares its own version must say the same thing.
#
# Why this is not bookkeeping: a package.json version is a RUNTIME value, not metadata. The bundled
# CLI reads `../package.json` at module load and reports what it finds as `treasury --version` and in
# `earn status`, so the plugin's copy reports plugin/package.json and an npm install reports the root
# one. The manifests are what the marketplaces and the plugin hosts advertise. When any of them
# disagree, a user installing "0.1.0" gets a CLI that introduces itself as something else: measured, the
# identical bundle reported `0.1.1` from one tree and `0.1.0` from another, decided entirely by the
# package.json beside it.
#
# Usage: bash scripts/check-versions.sh            # all declarations must agree
#        bash scripts/check-versions.sh 0.1.1      # ...and must equal this
set -euo pipefail
cd "$(dirname "$0")/.."

# Hardcoded, like the file list in sync-plugin.sh and for the same reason: a list read from
# data is a list that can be shortened, and a check that silently covers fewer declarations is the
# failure this exists to prevent. `.agents/plugins/marketplace.json` is deliberately absent — that
# format carries no version field at all, so there is nothing there to disagree.
#
# Each entry is  <file>\t<python expression over the parsed document>
DECLARATIONS=$(cat <<'EOF'
package.json	d["version"]
plugin/package.json	d["version"]
plugin/.claude-plugin/plugin.json	d["version"]
plugin/.codex-plugin/plugin.json	d["version"]
.claude-plugin/marketplace.json	[p for p in d["plugins"] if p.get("name")=="treasury"][0]["version"]
EOF
)

expected="${1:-}"
fail=0
seen=""

while IFS=$'\t' read -r file expr; do
  [ -n "$file" ] || continue
  if [ ! -f "$file" ]; then
    echo "::error::$file is missing — a declaration this check covers no longer exists, so it checked nothing"
    fail=1; continue
  fi
  # A missing or renamed field must be an ERROR, never an empty string that compares equal to
  # another empty string. Two documents that have both lost the field would otherwise "agree".
  if ! got=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
try:
    v=$expr
except Exception:
    sys.exit(3)
if not isinstance(v,str) or not v:
    sys.exit(3)
print(v)
" "$file" 2>/dev/null); then
    echo "::error::$file has no version where this check expects one ($expr) — the document changed shape, so nothing was compared"
    fail=1; continue
  fi
  printf '  %-36s %s\n' "$file" "$got"
  seen="$seen$got\n"
done <<< "$DECLARATIONS"

[ "$fail" = 0 ] || exit 2

distinct=$(printf '%b' "$seen" | sed '/^$/d' | sort -u)
if [ "$(printf '%s\n' "$distinct" | wc -l)" -ne 1 ]; then
  echo "::error::this repository declares more than one version: $(printf '%s' "$distinct" | tr '\n' ' ')"
  echo "::error::package.json is what the CLI reports as treasury --version; the manifests are what the marketplace advertises. A release cannot ship them disagreeing."
  exit 1
fi

if [ -n "$expected" ] && [ "$distinct" != "$expected" ]; then
  echo "::error::every declaration says ${distinct}, but ${expected} was expected"
  exit 1
fi

echo "all declarations agree: ${distinct}${expected:+ (= expected ${expected})}"
