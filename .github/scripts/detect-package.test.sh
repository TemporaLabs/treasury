#!/usr/bin/env bash
# Offline proof that detect-package.sh answers correctly, and can go RED (10 cases).
# Run: bash .github/scripts/detect-package.test.sh
#
# Case 4 is the one this file exists for: it passed under the previous repair, silently, and a green
# run meant nothing. Case 6 is its false-positive twin — a stray package.json under node_modules is
# not a moved package, and a fix that fires on it would break every documents-only branch.
set -u
S="$(cd "$(dirname "$0")" && pwd)/detect-package.sh"; pass=0; fail=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

t() { # name want_exit want_stdout build...
  local name="$1" want="$2" wantout="$3"; shift 3
  local d="$tmp/$RANDOM$RANDOM"; mkdir -p "$d"; ( cd "$d" && "$@" )
  local got out; out="$(cd "$d" && bash "$S" 2>/dev/null)"; got=$?
  if [ "$got" = "$want" ] && [ "$out" = "$wantout" ]; then
    pass=$((pass+1)); printf 'ok   (%s%s) %s\n' "$got" "${out:+, $out}" "$name"
  else
    fail=$((fail+1)); printf 'FAIL (got %s/%s, want %s/%s) %s\n' "$got" "${out:-<none>}" "$want" "${wantout:-<none>}" "$name"
  fi
}

full()      { mkdir -p src dist registry; touch package.json dist/mcp-server.mjs registry/vaults.json; }
# The skill ships from the PLUGIN repository, so a product tree without it is complete. This case is
# the published product exactly, and under the previous PARTS it errored as a half-moved package.
withskill() { full; mkdir -p skills/earn; touch skills/earn/SKILL.md; }
# ...and a tree that still carries the skill (the drafting repository) is a package too: the skill
# is not required, and it is not forbidden either.
skillonly() { mkdir -p skills/earn; touch skills/earn/SKILL.md; }
# A lone skill and nothing else is NOT this package moved elsewhere — it is the consumer's file.
straySkill(){ mkdir -p docs elsewhere/skills/earn; touch docs/README.md elsewhere/skills/earn/SKILL.md; }
docsonly()  { mkdir -p docs; touch docs/README.md; }
partial()   { mkdir -p src; }
moved()     { mkdir -p packages/treasury/src packages/treasury/skills/earn packages/treasury/dist packages/treasury/registry
              touch packages/treasury/package.json packages/treasury/skills/earn/SKILL.md \
                    packages/treasury/dist/mcp-server.mjs packages/treasury/registry/vaults.json; }
# The real pre-collapse layout, not a stub of it: it carried the skill, the bundle and the registry
# under skill/treasury/ too. A fixture that omits those is not that layout, and testing against it
# measures the fixture.
nested()    { mkdir -p skill/treasury/src skill/treasury/skills/earn skill/treasury/dist skill/treasury/registry
              touch skill/treasury/package.json skill/treasury/skills/earn/SKILL.md \
                    skill/treasury/dist/mcp-server.mjs skill/treasury/registry/vaults.json; }
nodemods()  { mkdir -p docs node_modules/leftover; touch docs/README.md node_modules/leftover/package.json; }
ghaction()  { mkdir -p docs .github/actions/notify; touch docs/README.md .github/actions/notify/package.json; }
docssite()  { mkdir -p docs/site; touch docs/README.md docs/site/package.json; }

t "the package is at the root (no skill — the product ships none)" 0 yes full
t "the drafting tree, which still carries the skill"            0 yes withskill
t "a lone skill at the root is not this package"                0 no  skillonly
t "a skill elsewhere is the consumer's file, not a move"        0 no  straySkill
t "a documents-only version branch genuinely has none"          0 no  docsonly
t "a PARTIAL move — src/ left behind"                           1 ""  partial
t "a WHOLESALE move to packages/treasury/ — the silent skip"    1 ""  moved
t "the pre-collapse layout, if it ever came back"               1 ""  nested
t "node_modules left in a docs-only tree is NOT a moved package" 0 no  nodemods
t "a docs-only tree with an unrelated manifest is NOT a moved package (JS action)" 0 no ghaction
t "...nor is a docs site with its own manifest"                  0 no  docssite

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
