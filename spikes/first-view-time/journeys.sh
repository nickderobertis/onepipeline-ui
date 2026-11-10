#!/usr/bin/env bash
# Run the tier's first-screen-marks.spec.ts and reach-everything.spec.ts against the
# first-view-time spike's prototype server with the switches named (none by default),
# so a prototype is held to the journeys the landed tree passes.
#
#   spikes/first-view-time/journeys.sh [switch,...] [playwright args...]
#
# `ONEPIPELINE_UI_SPIKE_STUB_KINDS` and the other `ONEPIPELINE_UI_SPIKE_*` settings in
# the environment reach every server the journeys start.
set -euo pipefail
cd "$(dirname "$0")/../.."
server="$PWD/target/spike-first-view/release/onepipeline-api-spike"
[ -x "$server" ] || { echo "no $server: run spikes/first-view-time/build.sh" >&2; exit 1; }
switches="${1:-}"
shift || true
READ_LATENCY_SERVER="$server" ONEPIPELINE_UI_SPIKE="$switches" \
  node_modules/.bin/playwright test --config apps/dag-ui-e2e/read-latency/read-latency.config.ts \
  apps/dag-ui-e2e/read-latency/first-screen-marks.spec.ts apps/dag-ui-e2e/read-latency/reach-everything.spec.ts "$@"
