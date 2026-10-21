#!/usr/bin/env bash
# THROWAWAY visual spike (dag-ui-project-centric). Re-captures the spike's
# screenshots at 1440x900 into shots/local/spike/:
#   after-*   — this branch's mock (`?spike=<view>`), via scripts/visual-capture.sh
#   before-*  — the three views no committed baseline image covers, captured on the
#               unchanged base commit (BASE, default: the merge-base with origin/main)
# The other "before" images are the gh-pages gallery's, whose digests match
# shots/baseline/x86_64.json; `--gallery` copies them in too.
# Usage: scripts/spike-visual.sh [--gallery]
set -euo pipefail
repo="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo"
out="$repo/shots/local/spike"
mkdir -p "$out"

# after: this branch's build
SHOTS_OUT="$out" bash scripts/visual-capture.sh spike-visual --grep after-

# before: the unchanged base, same spec, its own bundle; the API binary is this
# branch's (the spike touches no Rust), copied so the base needs no cargo build.
base="${BASE:-$(git merge-base HEAD origin/main)}"
wt="$(mktemp -d)/base"
git worktree add --detach "$wt" "$base" >/dev/null
trap 'git worktree remove --force "$wt"' EXIT
cp apps/dag-ui-e2e/spike-visual.screens.spec.ts "$wt/apps/dag-ui-e2e/"
mkdir -p "$wt/target/debug"
cp target/debug/onepipeline-api "$wt/target/debug/"
sed 's/run dag-ui:build-api-server/run dag-ui:build/' scripts/visual-capture.sh >"$wt/scripts/visual-capture.sh"
(cd "$wt" && SHOTS_OUT="$wt/shots/local/spike" bash scripts/visual-capture.sh spike-visual --grep before-)
cp "$wt"/shots/local/spike/before-*.png "$out/"

if [ "${1:-}" = "--gallery" ]; then
  git fetch -q origin gh-pages
  for pair in 1-sidebar:11-project-list 3-header:01-run-list-overall \
    4-nodelist:05-node-collapsed 7-channel:13-channel; do
    git show "FETCH_HEAD:x86_64/${pair#*:}-1440x900.png" >"$out/before-${pair%%:*}.png"
  done
fi
ls "$out"
