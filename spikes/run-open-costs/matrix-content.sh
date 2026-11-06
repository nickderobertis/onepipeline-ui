#!/usr/bin/env bash
# Whether each prototype's answer agrees with the unmodified read's, field by field, over
# runs that do not change. Each one invocation of scripts/spike-run-open-costs.mjs.
#   matrix-content.sh LANE OUT ROOT RUN [PROTOTYPE...]
set -uo pipefail
label=$1 out=$2 root=$3 run=$4
shift 4
repo=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$out"
# The status read, sweep off in both, compared with each way of leaving the fold.
if [ "$label" = status ]; then
  for prototype in "$@"; do
    name="$label.$(basename "$run").$prototype"
    [ -s "$out/$name.json" ] && continue
    node "$repo/scripts/spike-run-open-costs.mjs" --runs-root "$root" --cwd "$(dirname "$root")" \
      --run "$run" --measure content-status --baseline-prototype status-no-providers \
      --prototype "$prototype" >"$out/$name.tmp" 2>"$out/$name.err" && mv "$out/$name.tmp" "$out/$name.json"
  done
  exit 0
fi
for prototype in "$@"; do
  for view in graph overall node; do
    name="$label.$view.$prototype"
    [ -s "$out/$name.json" ] && continue
    echo "== $name load $(cut -d' ' -f1 /proc/loadavg)"
    node "$repo/scripts/spike-run-open-costs.mjs" --runs-root "$root" --cwd "$(dirname "$root")" \
      --run "$run" --measure "content-$view" --prototype "$prototype" --timeout 1800 \
      >"$out/$name.tmp" 2>"$out/$name.err" && mv "$out/$name.tmp" "$out/$name.json" ||
      echo "FAILED $name: $(grep -v frozen "$out/$name.err" | head -2 | cut -c1-300)"
  done
done
