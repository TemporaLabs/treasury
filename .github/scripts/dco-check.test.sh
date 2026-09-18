#!/usr/bin/env bash
# Proof that dco-check.sh discriminates. A gate that only ever prints green is indistinguishable
# from one that stopped checking, so every case below pairs a pass with the failure that must
# accompany it. Builds a throwaway repository sized past the limit that broke the old gate: forty
# commits, each carrying a ten-kilobyte message, so the commit list is far larger than the 128 KiB
# argument ceiling that used to crash the check before it evaluated anything.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; check="$here/dco-check.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"; git init -q -b main .
export GIT_AUTHOR_NAME="Ada Example" GIT_AUTHOR_EMAIL="ada@example.org"
export GIT_COMMITTER_NAME="Ada Example" GIT_COMMITTER_EMAIL="ada@example.org"
pad="$(head -c 10240 /dev/zero | tr '\0' 'x')"

commit() { # commit <file> <message-body...>
  local f="$1"; shift; echo "$RANDOM" >> "$f"; git add "$f"; git commit -q -m "$@"; }
signed()   { commit "$1" "$2" -m "$pad" -m "Signed-off-by: ${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>"; }
unsigned() { commit "$1" "$2" -m "$pad"; }

commit base "base"; base=$(git rev-parse HEAD)
git checkout -q -b topic
for i in $(seq 1 38); do signed a "signed $i"; done
# a two-parent merge without a sign-off, the shape GitHub's merge button produces
git checkout -q -b side; signed s "side work"; git checkout -q topic; git merge -q --no-ff --no-edit side
# a bot commit without a sign-off
GIT_AUTHOR_NAME="dependabot[bot]" GIT_AUTHOR_EMAIL="49699333+dependabot[bot]@users.noreply.github.com" unsigned b "bump a dependency"
good=$(git rev-parse HEAD)
bytes=$(git log --format=%B "${base}..${good}" | wc -c)
[ "$bytes" -gt 131072 ] || { echo "FAIL: fixture too small to exercise the size case (${bytes} bytes)"; exit 1; }

pass=0; fail=0
expect() { # expect <label> <exit-code> <base> <head> [grep-for-in-output]
  local label="$1" want="$2" b="$3" h="$4" needle="${5:-}"; local out rc=0
  out=$(bash "$check" "$b" "$h" 2>&1) || rc=$?
  if [ "$rc" -ne "$want" ]; then echo "FAIL: $label — exit $rc, wanted $want"; echo "$out" | tail -3; fail=$((fail+1)); return; fi
  if [ -n "$needle" ] && ! grep -qF -- "$needle" <<<"$out"; then echo "FAIL: $label — output lacks '$needle'"; echo "$out" | tail -3; fail=$((fail+1)); return; fi
  echo "ok: $label"; pass=$((pass+1)); }

expect "39 signed + 1 merge + 1 bot, ${bytes} bytes of messages: passes" 0 "$base" "$good" "39 commit(s) evaluated, 1 merge(s) exempt, 1 bot commit(s) exempt, 0 failure(s)"

# one unsigned human commit in the middle of a large range must fail and be named
git checkout -q -b bad1 "$good"; unsigned c "forgot to sign"; culprit=$(git rev-parse --short=12 HEAD); for i in $(seq 1 5); do signed a "after $i"; done
expect "one missing sign-off among 45 commits: fails naming it" 1 "$base" "$(git rev-parse HEAD)" "${culprit} \"forgot to sign\": the sign-off is missing"

# a sign-off that names someone else must fail
git checkout -q -b bad2 "$good"; commit d "signed by a stranger" -m "Signed-off-by: Someone Else <else@example.org>"
expect "sign-off with a different name and email: fails" 1 "$base" "$(git rev-parse HEAD)" "expected \"Ada Example <ada@example.org>\", got \"Someone Else <else@example.org>\""

# name and email are matched case-insensitively, and a committer's identity is acceptable
git checkout -q -b ok2 "$good"; commit e "signed in upper case" -m "Signed-off-by: ADA EXAMPLE <ADA@EXAMPLE.ORG>"
expect "case-insensitive match: passes" 0 "$base" "$(git rev-parse HEAD)"

# merge commits stay exempt: an unsigned two-parent commit alone must not fail
git checkout -q -b m2 "$good"; git checkout -q -b side2; signed t "more side work"; git checkout -q m2; git merge -q --no-ff --no-edit side2
expect "unsigned merge commit: exempt, passes" 0 "$good" "$(git rev-parse HEAD)" "1 merge(s) exempt"

# and the exemption is exactly two-parent, not "has the word merge in it": a single-parent commit
# titled like a merge is still checked
git checkout -q -b fake "$good"; unsigned f "Merge branch 'nothing'"
expect "single-parent commit titled Merge: still checked, fails" 1 "$base" "$(git rev-parse HEAD)" "the sign-off is missing"

# an empty range is the gate failing to run, never a pass
expect "empty range: exit 2, not a pass" 2 "$good" "$good" "no commits in"

echo "dco-check.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
