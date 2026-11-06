#!/usr/bin/env bash
# Build the server `scripts/spike-run-open-costs.mjs` measures: this branch's library,
# symbolled, under `pprof`, over the locked engine with `spikes/run-open-costs/engine.patch`
# applied: `RunView::open_current` made public for the checkpoint prototypes, and the
# `heap-merge` and `session-index` prototypes, each off until `ONEPIPELINE_UI_SPIKE` names
# it. Its own target directory, so the crate's other builds are untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
# The page measures serve this bundle; a stale one fails the page's contract validation.
(cd apps/dag-ui && npx vite build --config vite.config.ts >/dev/null)
version=$(awk '/^name = "onepipeline"$/ { getline; gsub(/[^0-9.]/, ""); print; exit }' Cargo.lock)
cargo fetch --locked --quiet
source=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"onepipeline-$version" | head -1)
engine=target/spike/engine
rm -rf "$engine"
mkdir -p target/spike
cp -r "$source" "$engine"
chmod -R u+w "$engine"
patch --silent -p1 -d "$engine" < spikes/run-open-costs/engine.patch
cp Cargo.lock spikes/run-open-costs/Cargo.lock
cd spikes/run-open-costs
CARGO_TARGET_DIR=../../target/spike cargo build --release
