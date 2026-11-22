#!/usr/bin/env bash
# SPIKE (throwaway, never lands): re-capture the conversation-focus spike's images.
# Befores: every mock change since the mock commit reverted in the tree (base + fixture only); afters: the mock.
# Both through the repository's one capture path, grepped to this spike's tests only.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-shots/local/focus-spike}"
mock=$(git log --format=%H -1 --grep='^feat(spike): conversation-focus mock')
restore() { git checkout -q HEAD -- apps/dag-ui/src; git clean -qfd apps/dag-ui/src; }
trap restore EXIT
git diff "$mock^" HEAD -- apps/dag-ui/src | git apply -R
status=0
SPIKE_SIDE=before SHOTS_OUT="$out" bash scripts/visual-capture.sh --grep 'before 0[1-6]-' || status=$?
restore
SPIKE_SIDE=after SHOTS_OUT="$out" bash scripts/visual-capture.sh --grep 'after 0[1-6]-' || status=$?
exit "$status"
