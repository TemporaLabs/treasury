#!/usr/bin/env bash
# Documentation version pins: every place README.md and docs/ tell a reader to install a specific
# version must name ONE version, and on `main` that version must be the latest release tag.
#
# Why this exists: the install instructions pin on purpose — `npm install @temporalabs/treasury@X`,
# `claude plugin marketplace add TemporaLabs/treasury-plugin@vX`, a `blob/vX/` link — because a
# published version is immutable and a pinned install cannot drift. The cost is that the pins are
# prose: nothing ties them to package.json (which on a release branch is legitimately AHEAD of the
# docs until the publish has actually happened, see docs/release-process.md step 6), so six of them
# shipped in 0.1.0 with no check that a later release would move all six. This holds two things:
#   - all pins agree with each other (a half-updated release cannot ship);
#   - given an expected version, all pins equal it. CI passes the newest `v*` tag on `main`, so a
#     tag pushed without the follow-up documentation change goes red on the next push to main —
#     which is exactly "release-process step 6 is outstanding".
# The plugin release carries the same version as the package it bundles; the plugin pins are held
# to the same version for that reason. A deliberate divergence changes this script, not the docs.
#
# Usage: version-pins.sh [expected-version | --newest-release-tag]
#   expected-version       bare X.Y.Z, no leading v
#   --newest-release-tag   expected = the newest RELEASE tag (vX.Y.Z exactly — a pre-release tag
#                          such as v0.2.0-alpha or v0.1.1-rc.1 is never chosen, because no pin can
#                          equal it and the gate would be unsatisfiable until the tag was deleted)
# Exit 0 when the pins agree (and match the expected version, if given). Exit 1 naming each pin
# that disagrees. Exit 2 when the gate could not run — NO pin found at all (the patterns stopped
# matching), or --newest-release-tag found NO release tag (on main after the first release that is
# a failed tag fetch, never a real state, and it must not degrade to the weaker check silently).
set -euo pipefail

expected="${1:-}"
if [ "$expected" = "--newest-release-tag" ]; then
  expected=$(git tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
  if [ -z "$expected" ]; then
    echo "::error::no release tag (vX.Y.Z) is visible — on main after the first release that means the tag fetch failed, so the pins were checked against nothing"
    exit 2
  fi
  echo "newest release tag: ${expected}"
  expected="${expected#v}"
fi
files=$(git ls-files README.md 'docs/**/*.md' 'docs/*.md' | sort -u)
[ -n "$files" ] || { echo "::error::no README.md or docs/*.md tracked — nothing to check"; exit 2; }

# file:line:version for every pin, in every spelling the docs use
pins=$(grep -n -o -E \
  '@temporalabs/treasury@[0-9]+\.[0-9]+\.[0-9]+|treasury-plugin@(release/)?v[0-9]+\.[0-9]+\.[0-9]+|treasury-plugin/blob/v[0-9]+\.[0-9]+\.[0-9]+' \
  $files | sed -E 's#@(release/)?v?([0-9]+\.[0-9]+\.[0-9]+)$#:\2#; s#/blob/v([0-9]+\.[0-9]+\.[0-9]+)$#:\1#' || true)
if [ -z "$pins" ]; then
  echo "::error::no version pin matched in README.md or docs/ — the patterns in $0 no longer match the documents, so nothing was checked"
  exit 2
fi

versions=$(printf '%s\n' "$pins" | awk -F: '{print $NF}' | sort -u)
count=$(printf '%s\n' "$pins" | wc -l)
failures=0
if [ "$(printf '%s\n' "$versions" | wc -l)" -ne 1 ]; then
  echo "::error::the documentation pins more than one version: $(printf '%s' "$versions" | tr '\n' ' ')"
  printf '%s\n' "$pins" | sed 's/^/  /'
  failures=1
fi
pinned=$(printf '%s\n' "$versions" | head -1)
if [ -n "$expected" ] && [ "$pinned" != "$expected" ]; then
  echo "::error::the documentation pins ${pinned} but the expected version is ${expected} — the install instructions name a version other than the latest release (docs/release-process.md step 6)"
  printf '%s\n' "$pins" | grep -v ":${expected}\$" | sed 's/^/  /'
  failures=1
fi

if [ "$failures" -eq 0 ]; then
  echo "${count} version pins across README.md and docs/, all ${pinned}${expected:+ (= expected ${expected})}"
fi
exit "$failures"
