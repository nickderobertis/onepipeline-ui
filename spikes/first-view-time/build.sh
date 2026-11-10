#!/usr/bin/env bash
# Build the first-view-time spike's prototype server, `target/spike-first-view/release/
# onepipeline-api-spike`: the engine the root lock pins, copied out of cargo's registry
# into `target/spike-first-view/engine` (untracked) with `engine.patch` applied, under
# this branch's library with `spike-engine` on. The browser view it embeds is
# `apps/dag-ui/dist`, which `npx nx run dag-ui:build` writes.
#
#   spikes/first-view-time/build.sh            # build
#   spikes/first-view-time/build.sh --diff     # rewrite engine.patch from the copy's edits
set -euo pipefail
cd "$(dirname "$0")/../.."
version=$(awk '/^name = "onepipeline"$/ { getline; gsub(/[^0-9.]/, ""); print; exit }' Cargo.lock)
spike=target/spike-first-view
if [ "${1:-}" = --diff ]; then
  (cd "$spike" && diff -ruN engine.orig engine | sed -e 's#^--- engine.orig/#--- a/#' -e 's#^+++ engine/#+++ b/#' \
    > "$OLDPWD/spikes/first-view-time/engine.patch") || true
  echo "wrote spikes/first-view-time/engine.patch"
  exit 0
fi
[ -f apps/dag-ui/dist/index.html ] || { echo "no apps/dag-ui/dist: run 'npx nx run dag-ui:build'" >&2; exit 1; }
cargo fetch --locked --quiet
source=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"onepipeline-$version" | head -1)
mkdir -p "$spike"
# Copied afresh only when the patch changed, so a rebuild for the library alone does
# not recompile the engine.
if ! cmp -s spikes/first-view-time/engine.patch "$spike/engine.applied" 2>/dev/null; then
  rm -rf "$spike/engine" "$spike/engine.orig"
  cp -r "$source" "$spike/engine.orig"
  cp -r "$source" "$spike/engine"
  chmod -R u+w "$spike/engine" "$spike/engine.orig"
  patch --silent -p1 -d "$spike/engine" < spikes/first-view-time/engine.patch
  cp spikes/first-view-time/engine.patch "$spike/engine.applied"
fi
cp Cargo.lock spikes/first-view-time/Cargo.lock
cd spikes/first-view-time
CARGO_TARGET_DIR=../../target/spike-first-view cargo build --release --features "" 2>&1 | tail -3
echo "built target/spike-first-view/release/onepipeline-api-spike over onepipeline $version, patched"
