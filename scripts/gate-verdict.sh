#!/usr/bin/env bash
# Rule on the jobs behind ci.yml's `gate`, the context branch protection requires.
#
# `gate` is the one required check a pull request has to turn green, so every job
# whose failure must block a merge reports through it rather than through a
# context of its own that protection would also have to list. v0.16.0 is why the
# Linux wheels are among them: `wheel` was not required, so a wheel that could
# not build in the release's image still left every required check green.
#
# A job passes when it succeeded. A job named by --may-skip also passes when it
# was skipped — `wheel` is, on a change that cannot reach the crate. Anything else
# (failure, cancelled, or skipped where skipping is not allowed) fails, naming the
# job and what it reported.
#
# Usage:
#   gate-verdict.sh [--may-skip JOB]... JOB=RESULT...
#
# Exit 0: every job passed. Exit 1: at least one did not. Exit 2: the arguments
# were refused.
set -euo pipefail

usage="run 'gate-verdict.sh [--may-skip JOB]... JOB=RESULT...'"

fail_usage() {
  echo "$1" >&2
  echo "ACTION: $usage" >&2
  exit 2
}

may_skip=" "
results=()
while [ $# -gt 0 ]; do
  case "$1" in
    --may-skip)
      [ $# -ge 2 ] || fail_usage "--may-skip needs a job name"
      may_skip+="$2 "
      shift 2
      ;;
    -*) fail_usage "unknown option: $1" ;;
    ?*=?*)
      results+=("$1")
      shift
      ;;
    *) fail_usage "not JOB=RESULT: '$1'" ;;
  esac
done
[ ${#results[@]} -gt 0 ] || fail_usage "no job results to rule on"

failed=0
for pair in "${results[@]}"; do
  job="${pair%%=*}" result="${pair#*=}"
  case "$result" in
    success) continue ;;
    skipped) [[ "$may_skip" == *" $job "* ]] && continue ;;
  esac
  echo "gate: \`$job\` reported $result" >&2
  failed=1
done
if [ "$failed" -ne 0 ]; then
  echo "ACTION: open the jobs named above in this run and fix what they report; gate passes only once each has succeeded" >&2
  exit 1
fi
echo "gate: every required job passed"
