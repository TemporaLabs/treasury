#!/usr/bin/env bash
# Decide whether this tree carries the package, for the CI step that gates everything else.
#
# 🔴 WHY THIS IS A SCRIPT AND NOT A ONE-LINER. Its answer gates ten steps plus the whole `attest`
# job. Written inline as `[ -f package.json ] && echo yes || echo no` it could not fail: a path that
# moved answered "no", every gated step skipped, and CI went GREEN — because a documents-only
# version branch legitimately has no package, and nothing could tell that apart from a move.
#
# It has now been wrong twice, and BOTH times a reviewer caught it rather than the gate itself:
#   1. the original could not see a move at all;
#   2. its first repair demanded that absence be UNANIMOUS, which catches a PARTIAL move and still
#      waves through a WHOLESALE one — move every file down into packages/treasury/ and all the
#      probes go missing together, which is indistinguishable from having no package.
# Hence this file, and the case-driven .test.sh beside it: the next person to be wrong about it
# finds out offline, in a second.
#
# The rule: the package is present, or it is absent AND THERE IS NO PACKAGE ANYWHERE ELSE.
#
# 🔴 THE SKILL IS NOT IN `PARTS`, AND ITS ABSENCE IS NOT A MOVE. It used to be, and that was this
# file asserting a dependency on its own CONSUMER: the plugin reads the product, never the reverse.
# The skill is the plugin's contract with its host, written against this package's interface, and it
# ships from the plugin repository. A product tree with no `skills/` is COMPLETE, not half-moved.
# Nothing in `src/` reads the skill — checked, zero references — so it was never a part of this
# package, only a file this package's CI happened to validate.
set -uo pipefail

PARTS=(package.json src dist/mcp-server.mjs registry/vaults.json)
found=(); missing=()
for p in "${PARTS[@]}"; do
  if [ -e "$p" ]; then found+=("$p"); else missing+=("$p"); fi
done

# `${#arr[@]}` on an empty array is why this file does not use `set -u`'s strict cousin: it is only
# safe from bash 4.4, and this script gets copied.
if [ "${#found[@]}" -gt 0 ] && [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::this tree carries part of the package but is missing: ${missing[*]} — if the layout moved, every check gated on this step would otherwise have SKIPPED and the run would have been green" >&2
  exit 1
fi

if [ "${#found[@]}" -gt 0 ]; then
  echo "yes"
  exit 0
fi

# Nothing at the root. Distinguish "no package" from "the package is somewhere else" — the case the
# previous repair missed, and the shape of the very change that motivated it.
#
# ⚠️ Look for THIS package's SHAPE, not for a manifest. Any manifest is the wrong probe: a JS or
# composite GitHub Action carries package.json, so does a docs site, and both live on documents-only
# branches where nothing has moved. Excluding node_modules does not cover them, and the next
# vendored directory would not be covered either. A moved package brings its own distinctive files
# with it; an unrelated manifest does not.
stray=""
for probe in dist/mcp-server.mjs registry/vaults.json; do
  hit="$(find . -path "*/$probe" -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path './.git/*' -print -quit 2>/dev/null)"
  if [ -n "$hit" ]; then stray="${hit#./}"; break; fi
done
if [ -n "$stray" ]; then
  echo "::error::no package at the repository root, but ${stray} exists — the package has MOVED. Every check gated on this step would otherwise have skipped and this run would have been green. Update the paths in ci.yml and in .github/scripts/detect-package.sh." >&2
  exit 1
fi

echo "no"
