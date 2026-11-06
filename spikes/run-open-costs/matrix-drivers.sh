#!/usr/bin/env bash
# The corpus with the drivers `matrix.sh`'s corpus lane lacks: the engine's merge's
# streams, and both drivers with a stand-in provider, and the facts and process counts of
# the real runs. Each one invocation of scripts/spike-run-open-costs.mjs.
#   matrix-drivers.sh OUT REAL_ROOT SMALL_RUN LIVE_RUN LARGEST_RUN
set -uo pipefail
out=$1 root=$2 small=$3 live=$4 largest=$5
repo=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$out"
m() {
  local name=$1 file="$out/$1.json"
  shift
  [ -s "$file" ] && return 0
  echo "== $name load $(cut -d' ' -f1 /proc/loadavg)"
  node "$repo/scripts/spike-run-open-costs.mjs" "$@" >"$file.tmp" 2>"$file.err" &&
    mv "$file.tmp" "$file" || { echo "FAILED $name: $(grep -v frozen "$file.err" | head -3 | cut -c1-300)"; rm -f "$file.tmp"; }
}
slow=(--timeout 1800)
R=(--runs-root "$root" --cwd "$(dirname "$root")")
for label in small live largest; do
  run=${!label}
  m "facts.$label" "${R[@]}" --run "$run" --measure run-facts
  m "exec.status.$label" "${R[@]}" --run "$run" --measure status --trace-exec
  m "exec.status.$label.no-providers" "${R[@]}" --run "$run" --measure status --prototype status-no-providers --trace-exec
done
m exec.cli-unpublished --measure cli-unpublished --cwd "$(dirname "$root")" --timeout 600 --trace-exec
for variant in streams both; do
  dir="$out/$variant"
  if [ ! -f "$dir.facts.json" ]; then
    mkdir -p "$dir"
    driver=(streams=2000)
    [ "$variant" = both ] && driver+=(transcript-store)
    start=$(date +%s)
    node --experimental-strip-types "$repo/apps/dag-ui-e2e/load/corpus.mjs" "$dir/runs" host-850 "${driver[@]}" >"$dir.facts.json" 2>"$dir.facts.err"
    echo "$(($(date +%s) - start))" >"$dir.seconds"
  fi
  C=(--runs-root "$dir/runs" --cwd "$dir" --run load-live-open)
  m "$variant.facts" "${C[@]}" --measure run-facts
  m "$variant.status.bare" "${C[@]}" --measure status --server-path /usr/bin:/bin
  m "$variant.status.bare.stub20" "${C[@]}" --measure status --server-path /usr/bin:/bin --stub-provider-seconds 20
  m "$variant.status.bare.heap" "${C[@]}" --measure status --server-path /usr/bin:/bin --prototype heap-merge
  for view in graph overall node; do
    m "$variant.$view" "${C[@]}" --measure "$view" "${slow[@]}"
    m "$variant.$view.index.heap" "${C[@]}" --measure "$view" --prototype session-index,heap-merge "${slow[@]}"
    m "$variant.$view.checkpoint" "${C[@]}" --measure "$view" --prototype checkpoint-first,lazy-activity "${slow[@]}"
    m "$variant.page-$view" "${C[@]}" --measure "page-$view" "${slow[@]}"
    m "$variant.page-$view.index.heap" "${C[@]}" --measure "page-$view" --prototype session-index,heap-merge "${slow[@]}"
  done
done
echo drivers done
