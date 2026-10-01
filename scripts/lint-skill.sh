#!/usr/bin/env bash
# Spec-validate the skill with the official validator, fetched into a local cache — the same thing
# CI does — instead of assuming a particular plugin marketplace is installed on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE=${SKILL_VALIDATOR_CACHE:-.cache/claude-plugins-official}
VALIDATOR_REPO=https://github.com/anthropics/claude-plugins-official
if [ ! -f "$CACHE/plugins/skill-creator/skills/skill-creator/scripts/quick_validate.py" ]; then
  # Only ever remove a directory this script created (a clone whose origin IS the validator repository) or
  # one that does not exist yet — `set -u` guards an UNSET name, not a set-but-wrong one like
  # `SKILL_VALIDATOR_CACHE=~`, and "has a .git" is not "is that clone": any other repository has one too.
  if [ -e "$CACHE" ] && [ "$(git -C "$CACHE" config --get remote.origin.url 2>/dev/null || true)" != "$VALIDATOR_REPO" ]; then
    echo "lint-skill: refusing to remove $CACHE — it exists and is not a clone of $VALIDATOR_REPO" >&2; exit 2
  fi
  rm -rf "$CACHE"; mkdir -p "$(dirname "$CACHE")"
  git clone -q --depth 1 "$VALIDATOR_REPO" "$CACHE"
fi
python3 "$CACHE/plugins/skill-creator/skills/skill-creator/scripts/quick_validate.py" plugin/skills/earn
python3 "$CACHE/plugins/skill-creator/skills/skill-creator/scripts/quick_validate.py" connect-plugin/skills/connect
