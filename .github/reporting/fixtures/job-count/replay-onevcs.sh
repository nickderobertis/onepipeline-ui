#!/usr/bin/env bash
# Replayed host telemetry: stands in for `onevcs host` at the figures script's ONEVCS seam,
# answering each query from a saved file of ANSWERS. Never a live reading.
set -euo pipefail
[ "${1:-}" = host ] || { echo "replay-onevcs: only 'host' is replayed, got: ${1:-}" >&2; exit 2; }
query="${2:-}"
run=""
while [ "$#" -gt 0 ]; do
  [ "$1" != --run ] || run="$2"
  shift
done
case "$query" in
  release-changes | change-checks | commit-runs) cat "$ANSWERS/$query.json" ;;
  run-jobs) cat "$ANSWERS/run-jobs-$run.json" ;;
  *) echo "replay-onevcs: no saved answer for $query" >&2; exit 1 ;;
esac
