#!/usr/bin/env bash
# Every measurement the run-open-costs report states, each one invocation of
# scripts/spike-run-open-costs.mjs, written to OUT/<name>.json. A figure already written is
# kept, so an interrupted matrix resumes. Lanes run one measurement at a time.
#   matrix.sh real|corpus OUT REAL_ROOT SMALL_RUN LIVE_RUN LARGEST_RUN [DEBUG_BINARY]
set -uo pipefail
lane=$1 out=$2 root=$3 small=$4 live=$5 largest=$6 debug=${7:-}
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
if [ "$lane" = real ]; then
  R=(--runs-root "$root" --cwd "$(dirname "$root")")
  m checkouts --measure checkouts --cwd "$(dirname "$root")"
  m human-items "${R[@]}" --measure human-items
  m cli-unpublished --measure cli-unpublished --cwd "$(dirname "$root")" --timeout 300
  for h in claude-code codex opencode goose qwen crush copilot cursor; do
    m "probe.$h" --measure provider-probe --harness "$h" --cwd "$(dirname "$root")"
  done
  for label in small live largest; do
    run=${!label}
    m "status.$label" "${R[@]}" --run "$run" --measure status
    m "status.$label.no-providers" "${R[@]}" --run "$run" --measure status --prototype status-no-providers
    m "status.$label.no-providers.heap" "${R[@]}" --run "$run" --measure status --prototype status-no-providers,heap-merge
    m "status.$label.no-providers.checkpoint" "${R[@]}" --run "$run" --measure status --prototype status-no-providers,status-checkpoint
    m "cli-status.$label" "${R[@]}" --run "$run" --measure cli-status --cli onepipeline
    m "cli-status.$label.no-providers" "${R[@]}" --run "$run" --measure cli-status --cli onepipeline --no-providers
    m "just-status.$label" "${R[@]}" --run "$run" --measure cli-status --cli just
    m "just-status.$label.no-providers" "${R[@]}" --run "$run" --measure cli-status --cli just --no-providers
  done
  m status.small.concurrent6 "${R[@]}" --run "$small" --measure status --concurrent 6
  m sidebar "${R[@]}" --measure sidebar
  for label in small live largest; do
    run=${!label}
    for view in graph overall node; do
      m "$view.$label" "${R[@]}" --run "$run" --measure "$view" "${slow[@]}"
      m "$view.$label.lazy" "${R[@]}" --run "$run" --measure "$view" --prototype lazy-activity "${slow[@]}"
      m "$view.$label.index" "${R[@]}" --run "$run" --measure "$view" --prototype session-index "${slow[@]}"
      m "$view.$label.index.heap" "${R[@]}" --run "$run" --measure "$view" --prototype session-index,heap-merge "${slow[@]}"
      m "$view.$label.checkpoint" "${R[@]}" --run "$run" --measure "$view" --prototype checkpoint-first,lazy-activity "${slow[@]}"
      m "page-$view.$label" "${R[@]}" --run "$run" --measure "page-$view" "${slow[@]}"
      m "page-$view.$label.index.heap" "${R[@]}" --run "$run" --measure "page-$view" --prototype session-index,heap-merge "${slow[@]}"
      m "page-$view.$label.checkpoint" "${R[@]}" --run "$run" --measure "page-$view" --prototype checkpoint-first,lazy-activity "${slow[@]}"
    done
  done
  m graph.live.concurrent2 "${R[@]}" --run "$live" --measure graph --concurrent 2 "${slow[@]}"
  m graph.live.profiled "${R[@]}" --run "$live" --measure graph --profile --keep-profile "$out/graph.live.folded" "${slow[@]}"
  m overall.live.profiled "${R[@]}" --run "$live" --measure overall --prototype lazy-activity --profile --keep-profile "$out/overall.live.folded" "${slow[@]}"
else
  # OUT/plain and OUT/store, as apps/dag-ui-e2e/load/corpus.mjs writes them.
  for variant in plain store; do
    dir="$out/$variant"
    if [ ! -f "$dir.facts.json" ]; then
      mkdir -p "$dir"
      driver=()
      [ "$variant" = store ] && driver=(transcript-store)
      start=$(date +%s)
      node --experimental-strip-types "$repo/apps/dag-ui-e2e/load/corpus.mjs" "$dir/runs" host-850 "${driver[@]}" >"$dir.facts.json" 2>"$dir.facts.err"
      echo "$(($(date +%s) - start))" >"$dir.seconds"
    fi
    R=(--runs-root "$dir/runs" --cwd "$dir")
    for label in open settled; do
      run=load-live-open
      [ "$label" = settled ] && run=load-settled-000
      m "$variant.status.$label" "${R[@]}" --run "$run" --measure status
      m "$variant.status.$label.bare" "${R[@]}" --run "$run" --measure status --server-path /usr/bin:/bin
      m "$variant.status.$label.bare.stub20" "${R[@]}" --run "$run" --measure status --server-path /usr/bin:/bin --stub-provider-seconds 20
      m "$variant.status.$label.heap" "${R[@]}" --run "$run" --measure status --prototype status-no-providers,heap-merge
      for view in graph overall node; do
        m "$variant.$view.$label" "${R[@]}" --run "$run" --measure "$view" "${slow[@]}"
        m "$variant.$view.$label.index.heap" "${R[@]}" --run "$run" --measure "$view" --prototype session-index,heap-merge "${slow[@]}"
        m "$variant.page-$view.$label" "${R[@]}" --run "$run" --measure "page-$view" "${slow[@]}"
      done
    done
    if [ -n "$debug" ]; then
      m "$variant.debug.status.open.bare" "${R[@]}" --run load-live-open --measure status --server-path /usr/bin:/bin --binary "$debug"
      m "$variant.debug.graph.open" "${R[@]}" --run load-live-open --measure graph --binary "$debug" "${slow[@]}"
      m "$variant.debug.overall.open" "${R[@]}" --run load-live-open --measure overall --binary "$debug" "${slow[@]}"
    fi
  done
fi
echo "lane $lane done"
