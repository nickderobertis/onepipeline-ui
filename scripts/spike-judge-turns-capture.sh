#!/usr/bin/env bash
# SPIKE (throwaway, never lands): re-capture every picture of the judge-turns /
# event-kinds visual spike through the repository's one capture path.
#
# Befores: the mock's changes to apps/dag-ui reverted in the tree (the base plus the
# fixture only). Afters: the mock, with its patched copy of @oneharness/ui's built
# files. Writes raw shots to shots/local/judge-spike/raw and, per view and side, the
# desktop shot beside the phone shot to shots/local/judge-spike/report.
#
# Usage: scripts/spike-judge-turns-capture.sh [comma-separated shot-name prefixes]
set -euo pipefail
cd "$(dirname "$0")/.."
out="shots/local/judge-spike"

# The patched copy the mock's vite alias reads. Copied, never edited in place:
# node_modules/@oneharness/ui's files are hard links into bun's shared cache.
rm -rf node_modules/.spike/oneharness-ui
mkdir -p node_modules/.spike
cp -r node_modules/@oneharness/ui node_modules/.spike/oneharness-ui
patch -s -p1 -d node_modules/.spike/oneharness-ui <spike/oneharness-ui.patch

mock=$(git log --format=%H -1 --grep='^feat(spike): judge-turns and event-kinds mock')
restore() { git checkout -q HEAD -- apps/dag-ui; git clean -qfd apps/dag-ui/src; }
trap restore EXIT
rm -rf "$out/raw" "$out/report"
export SHOTS_OUT="$out/gallery" SPIKE_OUT="$out" SPIKE_ONLY="${1:-}"
status=0
git diff "$mock^" HEAD -- apps/dag-ui | git apply -R
SPIKE_SIDE=before bash scripts/visual-capture.sh --grep 'SPIKE-judge before' || status=$?
restore
SPIKE_SIDE=after bash scripts/visual-capture.sh --grep 'SPIKE-judge (after|compose)' || status=$?
exit "$status"
