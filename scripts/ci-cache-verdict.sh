#!/usr/bin/env bash
# Whether a cancelled CI job's Rust build may be saved to the cache.
#
# ci.yml's four pull-request jobs save their build even when they do not succeed
# (rust-cache's `cache-on-failure`), so a run stopped at its cap still leaves what
# it compiled for the next one. A run cancelled before its cap was superseded by
# a newer push instead: it compiled a fraction of what the next run will, and
# saved under the full key that fraction is a hit no later run replaces, so every
# run of the branch at that lockfile restores it and starts nearly cold. For that
# run this withdraws the save, through the switch rust-cache's post step reads
# when it decides whether to run: CACHE_ON_FAILURE, set to false in $GITHUB_ENV.
#
# A job stopped at its cap is cancelled at the cap measured from when the job
# started, and --started is taken by the job's first step, a few seconds later; a
# cancellation inside the last minute of the cap is read as the cap.
#
# Usage:
#   ci-cache-verdict.sh --started EPOCH_SECONDS --cap-minutes N
#
# Exit 0 with a verdict printed, 2 when the arguments or $GITHUB_ENV are refused.
set -euo pipefail

usage="run 'ci-cache-verdict.sh --started EPOCH_SECONDS --cap-minutes N' from a step that has \$GITHUB_ENV"

fail_usage() {
  echo "ci-cache-verdict: $1" >&2
  echo "ACTION: $usage" >&2
  exit 2
}

started= cap=
while [ $# -gt 0 ]; do
  case "$1" in
    # Decimal with no leading zero, which bash arithmetic would read as octal,
    # and short enough that nothing below can overflow: an epoch second has ten
    # digits until 2286, and a job's cap is at most GitHub's 4320 minutes.
    --started)
      [ $# -ge 2 ] || fail_usage "$1 needs a value"
      [[ "$2" =~ ^[1-9][0-9]{0,10}$ ]] || fail_usage "$1 takes epoch seconds, not '$2'"
      started="$2"
      shift 2
      ;;
    --cap-minutes)
      [ $# -ge 2 ] || fail_usage "$1 needs a value"
      [[ "$2" =~ ^[1-9][0-9]{0,3}$ ]] || fail_usage "$1 takes whole minutes from 1 to 9999, not '$2'"
      cap="$2"
      shift 2
      ;;
    *) fail_usage "unknown argument: $1" ;;
  esac
done
[ -n "$started" ] || fail_usage "--started is required"
[ -n "$cap" ] || fail_usage "--cap-minutes is required"
[ -n "${GITHUB_ENV:-}" ] || fail_usage "\$GITHUB_ENV is not set"

elapsed=$(($(date +%s) - started))
if [ "$elapsed" -ge $((cap * 60 - 60)) ]; then
  echo "ci-cache-verdict: cancelled ${elapsed}s into a ${cap}-minute cap, so at the cap: saving what this run built"
else
  echo "CACHE_ON_FAILURE=false" >>"$GITHUB_ENV"
  echo "ci-cache-verdict: cancelled ${elapsed}s into a ${cap}-minute cap, so superseded: saving nothing, which leaves the key to a run that finishes"
fi
