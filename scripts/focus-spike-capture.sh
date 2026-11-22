#!/usr/bin/env bash
# SPIKE (throwaway, never lands): re-capture the conversation-focus spike's images.
# Befores: the mock's commit reverted in the tree (base + fixture only); afters: the mock.
# Both through the repository's one capture path, filtered to focus-spike.screens.spec.ts.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-shots/local/focus-spike}"
mock=$(git log --format=%H -1 --grep='^feat(spike): conversation-focus mock')
restore() { git checkout -q HEAD -- apps/dag-ui/src; git clean -qfd apps/dag-ui/src; }
trap restore EXIT
git diff "$mock^" "$mock" -- apps/dag-ui/src | git apply -R
SPIKE_SIDE=before SHOTS_OUT="$out" bash scripts/visual-capture.sh -- focus-spike.screens.spec.ts
restore
SPIKE_SIDE=after SHOTS_OUT="$out" bash scripts/visual-capture.sh -- focus-spike.screens.spec.ts
