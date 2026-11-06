#!/usr/bin/env bash
# Build the server `scripts/spike-run-open-costs.mjs` measures: this branch's library,
# symbolled, under `pprof`, over the locked engine with `RunView::open_current` made
# public so the checkpoint prototypes can call it. Its own target directory, so the
# crate's other builds are untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(awk '/^name = "onepipeline"$/ { getline; gsub(/[^0-9.]/, ""); print; exit }' Cargo.lock)
cargo fetch --locked --quiet
source=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"onepipeline-$version" | head -1)
engine=target/spike/engine
rm -rf "$engine"
mkdir -p target/spike
cp -r "$source" "$engine"
chmod -R u+w "$engine"
sed -i 's/pub(crate) fn open_current(/pub fn open_current(/' "$engine/src/views.rs"
grep -q 'pub fn open_current(' "$engine/src/views.rs"
cp Cargo.lock spikes/run-open-costs/Cargo.lock
cd spikes/run-open-costs
CARGO_TARGET_DIR=../../target/spike cargo build --release
