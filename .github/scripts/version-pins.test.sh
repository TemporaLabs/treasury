#!/usr/bin/env bash
# Proof that version-pins.sh discriminates. Each case pairs the pass with the failure that must
# accompany it, in a throwaway repository shaped like this one (README.md + docs/*.md, tracked).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; check="$here/version-pins.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"; git init -q -b main .; mkdir -p docs/runbooks

write() { # write <version-for-README> <version-for-docs> <version-for-runbook>
  printf 'npm install @temporalabs/treasury@%s\nclaude plugin marketplace add TemporaLabs/treasury-plugin@v%s\n' "$1" "$1" > README.md
  printf 'npm install @temporalabs/treasury@%s\n[skill](https://github.com/TemporaLabs/treasury-plugin/blob/v%s/skills/earn/SKILL.md)\n' "$2" "$2" > docs/install.md
  printf 'pinned: `TemporaLabs/treasury-plugin@release/v%s` and @temporalabs/treasury@%s\n' "$3" "$3" > docs/runbooks/verify.md
  git add -A
}
expect() { # expect <code> <label> <args...>
  local want="$1" label="$2"; shift 2
  set +e; out=$(bash "$check" "$@" 2>&1); got=$?; set -e
  if [ "$got" -ne "$want" ]; then echo "FAIL: $label — exit $got, wanted $want"; echo "$out" | sed 's/^/    /'; exit 1; fi
  echo "ok: $label (exit $got)"
}

write 0.1.0 0.1.0 0.1.0
expect 0 "all pins agree, no expected version" 
expect 0 "all pins agree and equal the expected version" 0.1.0
expect 1 "all pins agree but the expected version moved (a tag without its docs change)" 0.1.1

write 0.1.1 0.1.0 0.1.1
expect 1 "one document lags the others (a half-updated release)"
expect 1 "one document lags, and the expected version is the new one" 0.1.1

printf 'no pins here\n' > README.md; printf 'none here either\n' > docs/install.md; printf 'nor here\n' > docs/runbooks/verify.md; git add -A
expect 2 "no pin matches at all — the gate did not run, and says so"

# the release-branch spelling counts as a pin too, so a lagging `@release/vX` is caught on its own
write 0.1.1 0.1.1 0.1.1
sed -i 's#@release/v0.1.1#@release/v0.1.0#' docs/runbooks/verify.md; git add -A
expect 1 "a release-branch pin lags while every other pin is current"
# --newest-release-tag: a pre-release tag is never chosen, and no release tag at all is a refusal
write 0.1.1 0.1.1 0.1.1
expect 2 "no release tag visible — the gate refuses rather than checking against nothing" --newest-release-tag
git commit -q -m "pins"
git tag v0.1.0; git tag v0.1.1; git tag v0.1.1-rc.1; git tag v0.2.0-alpha; git tag v0.10.0-beta.1
expect 0 "newest RELEASE tag is v0.1.1 despite v0.2.0-alpha, v0.1.1-rc.1 and v0.10.0-beta.1" --newest-release-tag
git tag v0.10.0
expect 1 "v0.10.0 sorts above v0.2.0-alpha AND above v0.1.1 numerically, and the pins now lag it" --newest-release-tag
echo "all cases behaved"
