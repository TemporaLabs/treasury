#!/usr/bin/env bash
# DCO gate: every non-merge, non-bot commit in BASE..HEAD carries a Signed-off-by trailer that
# names its author or committer. Reads the commits from git, never from an argument or an
# environment variable, so the size of the pull request cannot affect whether the check runs.
#
# Why this exists: the previous gate handed the whole commit list to an action as a single
# `with:` input. Linux caps one argument or environment string at 128 KiB, and the GitHub API's
# per-commit JSON is about 3.4 KB before the message, so any pull request past roughly 30 commits
# crashed the action with "Argument list too long" before it evaluated a single sign-off. A crashed
# gate and an inert one print different colours for the same coverage: none.
#
# Semantics, kept identical to the action this replaces:
#   - a commit with more than one parent (a merge) is exempt
#   - a commit whose author is a GitHub bot account (`[bot]@users.noreply.github.com`) is exempt
#   - otherwise at least one `Signed-off-by: Name <email>` line must match, case-insensitively,
#     a name from {author, committer} and an email from {author, committer}
#
# Usage: dco-check.sh <base-rev> <head-rev>
# Exit 0 when every required commit is signed. Exit 1 naming each commit that is not. Exit 2 when
# the range is empty, because a pull request always has at least one commit and an empty range
# means the checkout did not fetch it: that is the gate failing to run, and it must not read as a
# pass.
set -euo pipefail

base="${1:?base rev}"; head="${2:?head rev}"

all=$(git rev-list "${base}..${head}")
if [ -z "$all" ]; then
  echo "::error::no commits in ${base}..${head} — the checkout did not fetch the pull request, so nothing was checked"
  exit 2
fi

evaluated=0; merges=0; bots=0; failures=0
while read -r sha; do
  [ -n "$sha" ] || continue
  parents=$(git rev-list --parents -n 1 "$sha" | wc -w)
  if [ "$parents" -gt 2 ]; then merges=$((merges + 1)); continue; fi

  an=$(git log -1 --format=%an "$sha"); ae=$(git log -1 --format=%ae "$sha")
  cn=$(git log -1 --format=%cn "$sha"); ce=$(git log -1 --format=%ce "$sha")
  subject=$(git log -1 --format=%s "$sha")

  case "$(printf '%s' "$ae" | tr '[:upper:]' '[:lower:]')" in
    *'[bot]@users.noreply.github.com') bots=$((bots + 1)); continue ;;
  esac

  evaluated=$((evaluated + 1))
  an_l=$(printf '%s' "$an" | tr '[:upper:]' '[:lower:]'); cn_l=$(printf '%s' "$cn" | tr '[:upper:]' '[:lower:]')
  ae_l=$(printf '%s' "$ae" | tr '[:upper:]' '[:lower:]'); ce_l=$(printf '%s' "$ce" | tr '[:upper:]' '[:lower:]')

  ok=0; seen=0; got=""
  while IFS= read -r line; do
    case "$line" in
      Signed-off-by:*) ;;
      *) continue ;;
    esac
    seen=$((seen + 1))
    rest="${line#Signed-off-by:}"; rest="${rest# }"
    sname="${rest%% <*}"; semail="${rest##*<}"; semail="${semail%>}"
    got="${got:+$got, }\"${sname} <${semail}>\""
    sname_l=$(printf '%s' "$sname" | tr '[:upper:]' '[:lower:]'); semail_l=$(printf '%s' "$semail" | tr '[:upper:]' '[:lower:]')
    if { [ "$sname_l" = "$an_l" ] || [ "$sname_l" = "$cn_l" ]; } && { [ "$semail_l" = "$ae_l" ] || [ "$semail_l" = "$ce_l" ]; }; then ok=1; fi
  done < <(git log -1 --format=%B "$sha")

  if [ "$ok" -ne 1 ]; then
    failures=$((failures + 1))
    if [ "$seen" -eq 0 ]; then
      echo "::error::${sha:0:12} \"${subject}\": the sign-off is missing. Expected \"Signed-off-by: ${an} <${ae}>\"."
    else
      echo "::error::${sha:0:12} \"${subject}\": expected \"${an} <${ae}>\", got ${got}."
    fi
  fi
done <<< "$all"

summary="DCO: ${evaluated} commit(s) evaluated, ${merges} merge(s) exempt, ${bots} bot commit(s) exempt, ${failures} failure(s)"
echo "$summary"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$summary" >> "$GITHUB_STEP_SUMMARY"
[ "$failures" -eq 0 ]
