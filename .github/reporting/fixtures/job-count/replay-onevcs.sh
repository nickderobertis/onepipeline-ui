#!/usr/bin/env bash
# Replayed host telemetry: stands in for `onevcs host` at the figures script's ONEVCS seam,
# answering each query from a saved file of ANSWERS. Never a live reading.
set -euo pipefail
refuse() {
  printf 'replay-onevcs: %s\nACTION: %s\n' "$1" "$2" >&2
  exit "${3:-1}"
}
[ "${1:-}" = host ] || refuse "only 'host' is replayed, got: ${1:-}" "call this as: replay-onevcs.sh host QUERY ..." 2
query="${2:-}"
run=""
while [ "$#" -gt 0 ]; do
  [ "$1" != --run ] || run="${2:-}"
  shift
done
case "$query" in
  release-changes | change-checks | commit-runs) saved="$ANSWERS/$query.json" ;;
  run-jobs)
    [[ "$run" =~ ^[0-9]+$ ]] || refuse "run-jobs needs a numeric --run, got: $run" "pass the run id the commit-runs answer names" 2
    saved="$ANSWERS/run-jobs-$run.json"
    ;;
  *) refuse "no replay of query $query" "ask release-changes, change-checks, commit-runs or run-jobs, or add that answer to $ANSWERS" ;;
esac
[ -f "$saved" ] || refuse "no saved answer $saved" "add that answer to the fixture, or check the query's arguments"
cat "$saved"
