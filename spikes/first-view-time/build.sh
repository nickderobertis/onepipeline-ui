#!/usr/bin/env bash
# Build the first-view-time spike's prototype server as the tier builds its release
# server: `dag-ui-read-latency:compile-release-server` (the release's manylinux build,
# `scripts/build-linux-wheel.sh`), over the manifest overlay `release-overlay.sh` writes,
# whose `[patch.crates-io]` takes onepipeline from the local clone `.tools/onepipeline-spike`
# (`engine.patch` committed there), with the `spike-engine` feature. The binary is kept as
# `target/spike-release/onepipeline-api`; its switches are all off by default.
#
#   spikes/first-view-time/build.sh             # the prototype server
#   spikes/first-view-time/build.sh --default   # the branch's own release server, no overlay,
#                                               # kept as target/spike-release/onepipeline-api-default
set -euo pipefail
cd "$(dirname "$0")/../.."
built=target/wheel-x86_64-unknown-linux-gnu/x86_64-unknown-linux-gnu/release/onepipeline-api
mkdir -p target/spike-release
if [ "${1:-}" = --default ]; then
  npx nx run dag-ui-read-latency:compile-release-server --skip-nx-cache
  cp "$built" target/spike-release/onepipeline-api-default
  echo "built target/spike-release/onepipeline-api-default"
  exit 0
fi
engine=.tools/onepipeline-spike
if ! git -C "$engine" diff --quiet c58295e HEAD -- src 2>/dev/null \
  || ! diff -q <(git -C "$engine" diff c58295e HEAD -- src) spikes/first-view-time/engine.patch >/dev/null; then
  echo "$engine does not hold exactly engine.patch over onepipeline v0.105.0 (c58295e)" >&2
  exit 1
fi
bash spikes/first-view-time/release-overlay.sh
WHEEL_MANIFEST_OVERLAY=target/spike-release WHEEL_FEATURES=spike-engine \
  npx nx run dag-ui-read-latency:compile-release-server --skip-nx-cache
cp "$built" target/spike-release/onepipeline-api
echo "built target/spike-release/onepipeline-api over $engine at $(git -C "$engine" rev-parse --short HEAD)"
