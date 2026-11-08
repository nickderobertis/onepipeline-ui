#!/usr/bin/env bash
# SPIKE (question-items-2026-11-08 spike-visual): capture the "before" views of
# Action items with the app's source exactly as the spike's starting head had it
# (c5797b8), through the repository's capture path, then put the spike back.
# Not meant to land.
set -euo pipefail
cd "$(dirname "$0")/.."
base=c5797b8
if ! git diff --quiet HEAD -- apps/dag-ui/src; then
  echo "spike-action-items-before: apps/dag-ui/src has uncommitted changes; commit them first" >&2
  exit 2
fi
trap 'git checkout HEAD -- apps/dag-ui/src' EXIT
git checkout "$base" -- apps/dag-ui/src
# The starting head's own copy of the page, byte for byte.
git diff --quiet "$base" -- apps/dag-ui/src/features/human-items/HumanItemsPage.tsx apps/dag-ui/src/styles.css
SHOTS_OUT=shots/local/action-items-before bash scripts/visual-capture.sh \
  --grep "at (390x844|1440x900) captures Action items mock (3[01]|37)-"
