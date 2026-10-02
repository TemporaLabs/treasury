#!/usr/bin/env bash
# Proof that version-pins.sh discriminates. Each case pairs the pass with the failure that must
# accompany it, in a throwaway repository shaped like this one (README.md + docs/*.md, tracked).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; check="$here/version-pins.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"; git init -q -b main .; mkdir -p docs/runbooks
# the tag cases commit, and a CI runner has no git identity of its own
export GIT_AUTHOR_NAME="Ada Example" GIT_AUTHOR_EMAIL="ada@example.org"
export GIT_COMMITTER_NAME="Ada Example" GIT_COMMITTER_EMAIL="ada@example.org"

write() { # write <version-for-README> <version-for-docs> <version-for-runbook>
  printf 'npm install @temporalabs/treasury@%s\nclaude plugin marketplace add TemporaLabs/treasury@v%s\n' "$1" "$1" > README.md
  printf 'npm install @temporalabs/treasury@%s\n[skill](https://github.com/TemporaLabs/treasury/blob/v%s/plugin/skills/earn/SKILL.md)\n' "$2" "$2" > docs/install.md
  printf 'pinned: `TemporaLabs/treasury@release/v%s` and @temporalabs/treasury@%s\n' "$3" "$3" > docs/runbooks/verify.md
  git add -A
}
edit() { # edit <file> <sed-expression> — rewrites in place without GNU-only `sed -i`
  sed -E "$2" "$1" > "$1.new" && mv "$1.new" "$1"; git add -A
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
edit docs/runbooks/verify.md 's#@release/v0.1.1#@release/v0.1.0#'
expect 1 "a release-branch pin lags while every other pin is current"
# --newest-release-tag: a pre-release tag is never chosen, and no release tag at all is a refusal
write 0.1.1 0.1.1 0.1.1
expect 2 "no release tag visible — the gate refuses rather than checking against nothing" --newest-release-tag
git commit -q -m "pins"
git tag v0.1.0; git tag v0.1.1; git tag v0.1.1-rc.1; git tag v0.2.0-alpha; git tag v0.10.0-beta.1
expect 0 "newest RELEASE tag is v0.1.1 despite v0.2.0-alpha, v0.1.1-rc.1 and v0.10.0-beta.1" --newest-release-tag
git tag v0.9.0
expect 1 "v0.9.0 is newer than every pin" --newest-release-tag
git tag v0.10.0
expect 1 "v0.10.0 sorts above v0.9.0 numerically (byte order would pick v0.9.0), and the pins lag it" --newest-release-tag
LC_ALL=C expect 1 "the same under the C locale a CI runner uses" --newest-release-tag
out=$(LC_ALL=C bash "$check" --newest-release-tag 2>&1 || true)
printf '%s\n' "$out" | grep -q '^newest release tag: v0.10.0$' \
  || { echo "FAIL: the newest release tag under LC_ALL=C is not v0.10.0"; echo "$out"; exit 1; }
echo "ok: under LC_ALL=C the newest release tag is v0.10.0"
# the plugin now installs from this repository: its pins count, and a lagging one is caught
write 0.1.1 0.1.1 0.1.1
printf 'claude plugin marketplace add TemporaLabs/treasury@v0.1.1\n[skill](https://github.com/TemporaLabs/treasury/blob/v0.1.1/plugin/skills/earn/SKILL.md)\n' >> README.md; git add -A
expect 0 "the TemporaLabs/treasury@vX spelling is a pin, and agrees" 0.1.1
edit README.md 's#TemporaLabs/treasury@v0.1.1#TemporaLabs/treasury@v0.1.0#'
expect 1 "a lagging TemporaLabs/treasury@vX pin is caught on its own"
edit README.md 's#TemporaLabs/treasury@v0.1.0#TemporaLabs/treasury@v0.1.1#; s#TemporaLabs/treasury/blob/v0.1.1/#TemporaLabs/treasury/blob/v0.1.0/#'
expect 1 "a lagging TemporaLabs/treasury/blob/vX link is caught on its own"
# every other spelling a reader can copy: #vX, /tree/vX, and a pre-release suffix on any of them
for lag in 'TemporaLabs/treasury#v0.1.0' 'https://github.com/TemporaLabs/treasury/tree/v0.1.0/docs' \
           'TemporaLabs/treasury@v0.1.1-alpha' '@temporalabs/treasury@0.1.1-rc.1'; do
  write 0.1.1 0.1.1 0.1.1
  printf 'also: %s\n' "$lag" >> docs/install.md; git add -A
  expect 1 "a lagging pin spelled ${lag} is caught" 0.1.1
done
write 0.1.1 0.1.1 0.1.1
printf 'the old repository, TemporaLabs/treasury-plugin@v0.1.0, is not a pin\n' >> README.md; git add -A
expect 0 "TemporaLabs/treasury-plugin@vX is a different repository, not a pin" 0.1.1
# --package-version: the expected version is package.json's
printf '{ "name": "x", "version": "0.1.1" }\n' > package.json; git add -A
expect 0 "pins equal package.json's version" --package-version
printf '{ "name": "x", "version": "0.1.2" }\n' > package.json; git add -A
expect 1 "package.json moved on and the pins did not (a release that forgot its install lines)" --package-version
# the result does not depend on the directory the script is run from
write 0.1.0 0.1.1 0.1.1
(cd docs && expect 1 "run from docs/, the lagging README.md is still read")
echo "all cases behaved"
