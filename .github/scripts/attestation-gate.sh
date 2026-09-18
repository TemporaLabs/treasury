#!/usr/bin/env bash
# Decides whether the bundle attestation MUST run, and afterwards asserts that what happened is
# what the decision required. Two modes:
#
#   attestation-gate.sh decide   → prints `attest=required|forced|skip` and `why=…` to $GITHUB_OUTPUT
#   attestation-gate.sh assert   → exit 1 unless the recorded outcomes match the decision
#
# Why a script and not workflow `if:` expressions: every branch below is runnable OFFLINE with
# plain env vars (see .github/scripts/attestation-gate.test.sh), so "the check can go red" is provable on a
# private repository where the attestation itself cannot run (artifact attestations on private or
# internal repositories need GitHub Enterprise Cloud). A step that passes by
# skipping renders identically to one that worked — this script is what makes the two differ.
#
# Inputs (env):
#   REPO_VISIBILITY   public|private|internal        (github.event.repository.visibility)
#   EVENT_NAME        push|pull_request|workflow_dispatch|schedule
#   ATTEST_INPUT      auto|force                      (workflow_dispatch input; empty otherwise)
#   ATTEST_OUTCOME    success|failure|skipped|cancelled (steps.attest.outcome; assert mode)
#   ATTESTATION_ID    the action's attestation-id output (assert mode)
#   VERIFY_OUTCOME    success|failure|skipped         (steps.verify.outcome; assert mode)
set -euo pipefail
mode="${1:-}"
vis="${REPO_VISIBILITY:-}"; ev="${EVENT_NAME:-}"; inp="${ATTEST_INPUT:-}"

decide() {
  if [ "$inp" = "force" ]; then echo "forced" "workflow_dispatch attest=force: run the attestation even where it is expected to fail, to prove the assertion fires"; return; fi
  if [ "$ev" = "pull_request" ]; then echo "skip" "pull_request: PR heads are not the artifact anyone installs, and fork PRs carry no id-token"; return; fi
  case "$vis" in
    public) echo "required" "public repository on a push/dispatch: the committed bundle must be attested and verified";;
    private|internal) echo "skip" "$vis repository: artifact attestations need GitHub Enterprise Cloud — the green path is only provable on the public repository";;
    *) echo "required" "unknown visibility '$vis': fail closed and demand the attestation";;
  esac
}

case "$mode" in
  decide)
    read -r attest why < <(decide)
    echo "attest=$attest" >> "${GITHUB_OUTPUT:-/dev/stdout}"
    echo "why=$why" >> "${GITHUB_OUTPUT:-/dev/stdout}"
    if [ "$attest" = "skip" ]; then echo "::notice title=bundle attestation skipped::$why"; else echo "::notice title=bundle attestation $attest::$why"; fi
    # Loud in the job SUMMARY too, not only in annotations: a skipped attestation must be visible
    # to someone who opens the run and reads nothing else.
    { echo "### Bundle attestation: **${attest^^}**"; echo; echo "$why"; echo; echo "subject: \`dist/mcp-server.mjs\` sha256 \`$(sha256sum dist/mcp-server.mjs 2>/dev/null | cut -d' ' -f1)\`"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;
  assert)
    read -r attest why < <(decide)
    ao="${ATTEST_OUTCOME:-skipped}"; vo="${VERIFY_OUTCOME:-skipped}"; aid="${ATTESTATION_ID:-}"
    case "$attest" in
      skip)
        if [ "$ao" != "skipped" ]; then echo "::error title=attestation ran when the gate said skip::outcome=$ao ($why)"; exit 1; fi
        if [ "$vo" != "skipped" ] || [ -n "$aid" ]; then echo "::error title=verification or an attestation id exists where the gate said skip::verify=$vo id='$aid' — a future edit to the steps' if: would land here"; exit 1; fi
        echo "ok: attestation skipped — $why"; exit 0;;
      required|forced)
        fail=0
        if [ "$ao" != "success" ]; then echo "::error title=bundle attestation did not succeed::steps.attest.outcome=$ao — gate was '$attest' ($why). A run that skips or fails here is NOT green."; fail=1; fi
        if [ -z "$aid" ]; then echo "::error title=no attestation-id::the attest step produced no attestation id — nothing was attested"; fail=1; fi
        if [ "$vo" != "success" ]; then echo "::error title=bundle verification did not succeed::steps.verify.outcome=$vo — gh attestation verify must pass against the committed dist"; fail=1; fi
        [ "$fail" = 0 ] && echo "ok: attestation $aid minted and verified ($attest)"; exit "$fail";;
    esac;;
  *) echo "usage: $0 decide|assert" >&2; exit 2;;
esac
