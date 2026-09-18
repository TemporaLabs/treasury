#!/usr/bin/env bash
# Offline proof that attestation-gate.sh can go RED (12 cases). Run: bash .github/scripts/attestation-gate.test.sh
# Every case names the branch it exercises; a case whose expected exit does not match fails the file.
set -u
G="$(dirname "$0")/attestation-gate.sh"; pass=0; fail=0
t() { # name expected_exit env...
  local name="$1" want="$2"; shift 2
  local got; env -i PATH="$PATH" "$@" bash "$G" assert >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   ($got) $name"; else fail=$((fail+1)); echo "FAIL (got $got, want $want) $name"; fi
}
t "private push, attest skipped → green (the private-repo path)"                 0 REPO_VISIBILITY=private EVENT_NAME=push ATTEST_OUTCOME=skipped
t "private push, attest ran anyway → red (gate said skip)"                        1 REPO_VISIBILITY=private EVENT_NAME=push ATTEST_OUTCOME=success ATTESTATION_ID=1 VERIFY_OUTCOME=success
t "pull_request on public → green skip (PR heads are not the artifact)"          0 REPO_VISIBILITY=public EVENT_NAME=pull_request ATTEST_OUTCOME=skipped
t "public push, attested + verified → green"                                      0 REPO_VISIBILITY=public EVENT_NAME=push ATTEST_OUTCOME=success ATTESTATION_ID=123 VERIFY_OUTCOME=success
t "public push, attest step SKIPPED → red (the silent-skip failure)"              1 REPO_VISIBILITY=public EVENT_NAME=push ATTEST_OUTCOME=skipped
t "public push, attest failed → red"                                              1 REPO_VISIBILITY=public EVENT_NAME=push ATTEST_OUTCOME=failure VERIFY_OUTCOME=skipped
t "public push, attested but NO attestation-id → red"                             1 REPO_VISIBILITY=public EVENT_NAME=push ATTEST_OUTCOME=success ATTESTATION_ID= VERIFY_OUTCOME=success
t "public push, attested but verify failed (dist edited after attest) → red"      1 REPO_VISIBILITY=public EVENT_NAME=push ATTEST_OUTCOME=success ATTESTATION_ID=123 VERIFY_OUTCOME=failure
t "forced on private, attest failed → red — the runnable proof here"             1 REPO_VISIBILITY=private EVENT_NAME=workflow_dispatch ATTEST_INPUT=force ATTEST_OUTCOME=failure
t "forced on private, attest somehow succeeded + verified → green"               0 REPO_VISIBILITY=private EVENT_NAME=workflow_dispatch ATTEST_INPUT=force ATTEST_OUTCOME=success ATTESTATION_ID=9 VERIFY_OUTCOME=success
t "unknown visibility → fail closed (required) → red when skipped"                1 REPO_VISIBILITY= EVENT_NAME=push ATTEST_OUTCOME=skipped
t "private push, attest skipped but verify RAN (an if: drifted) → red"           1 REPO_VISIBILITY=private EVENT_NAME=push ATTEST_OUTCOME=skipped VERIFY_OUTCOME=success
echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
