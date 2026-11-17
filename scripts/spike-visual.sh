#!/usr/bin/env bash
# SPIKE (spike-visual, never lands): re-capture every screenshot the DAG UI
# readability plan's visual spike reports, into shots/local/spike/.
#
#   scripts/spike-visual.sh            # befores and afters
#   scripts/spike-visual.sh before     # befores only
#   scripts/spike-visual.sh after      # afters only
#
# Afters: this branch (the mock) through scripts/visual-capture.sh, filtered to
# spike.screens.spec.ts's @after shots.
#
# Befores: the base commit, unchanged but for the spike's fixture runs and its
# capture spec, snapshotted with `git archive` into target/spike-base/ and captured
# by that tree's own scripts/visual-capture.sh, filtered to the @before shots.
# Befores the report takes from the deployed baseline gallery are not re-captured.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
cd "$repo"
base="${SPIKE_BASE:-e01895f}"
phase="${1:-all}"
dest="$repo/shots/local/spike"
mkdir -p "$dest"

# The files the before capture adds to the base: the fixture runs and the spec.
FIXTURE=(
  apps/dag-ui-e2e/fixtures/runs.mjs
  apps/dag-ui-e2e/fixtures/human-items-world.mjs
  apps/dag-ui-e2e/spike.screens.spec.ts
)

if [ "$phase" = all ] || [ "$phase" = before ]; then
  snapshot="$repo/target/spike-base"
  # Rebuilt from the base every time, keeping only its build caches.
  if [ -d "$snapshot" ]; then
    find "$snapshot" -mindepth 1 -maxdepth 1 \
      ! -name target ! -name node_modules ! -name .tools -exec rm -rf {} +
  fi
  mkdir -p "$snapshot"
  git archive "$base" | tar -x -C "$snapshot"
  for file in "${FIXTURE[@]}"; do cp "$repo/$file" "$snapshot/$file"; done
  # Warm the snapshot's server build and sibling CLI from this tree's.
  [ -d "$snapshot/target/dag-ui-api" ] || {
    mkdir -p "$snapshot/target"
    cp -a --reflink=auto "$repo/target/dag-ui-api" "$snapshot/target/"
  }
  [ -d "$snapshot/.tools" ] || cp -a "$repo/.tools" "$snapshot/.tools"
  # A git repository of its own, for whatever in the build asks git.
  [ -d "$snapshot/.git" ] || (cd "$snapshot" && git init -q && git add -A >/dev/null && git -c user.name=spike -c user.email=spike@invalid commit -qm "base $base + spike fixture")
  rm -rf "$snapshot/shots/local/spike-before"
  (cd "$snapshot" && SHOTS_OUT=shots/local/spike-before \
    bash scripts/visual-capture.sh spike.screens.spec.ts --grep @before)
  cp "$snapshot"/shots/local/spike-before/*.png "$dest/"
fi

if [ "$phase" = all ] || [ "$phase" = after ]; then
  rm -rf "$repo/shots/local/spike-after"
  SHOTS_OUT=shots/local/spike-after \
    bash scripts/visual-capture.sh spike.screens.spec.ts --grep @after
  cp "$repo"/shots/local/spike-after/*.png "$dest/"
fi

ls -1 "$dest"
