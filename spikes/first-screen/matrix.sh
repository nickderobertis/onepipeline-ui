#!/usr/bin/env bash
# Every measurement the first-screen report states, each one invocation of
# scripts/spike-run-open-costs.mjs, written to OUT/<name>.json. A figure already written is
# kept, so an interrupted pass resumes. One pass: each is taken once, with its load.
#   matrix.sh first|content|today OUT REAL_ROOT SMALL_RUN LIVE_RUN LARGEST_RUN CORPUS_ROOT LIVE_NODE
set -uo pipefail
lane=$1 out=$2 root=$3 small=$4 live=$5 largest=$6 corpus=$7 live_node=$8
repo=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$out"
corpus_run=load-live-open
m() {
  local name=$1 file="$out/$1.json"
  shift
  [ -s "$file" ] && return 0
  echo "== $name load $(cut -d' ' -f1 /proc/loadavg)"
  node "$repo/scripts/spike-run-open-costs.mjs" "$@" >"$file.tmp" 2>"$file.err" &&
    mv "$file.tmp" "$file" || { echo "FAILED $name: $(head -3 "$file.err" | cut -c1-300)"; rm -f "$file.tmp"; }
}
R=(--runs-root "$root" --cwd "$(dirname "$root")")
C=(--runs-root "$corpus" --cwd "$(dirname "$corpus")")
each() { # each _ FUNCTION: small, live, largest, corpus
  for label in small live largest corpus; do
    case $label in
      small) "$2" "$label" "${R[@]}" --run "$small" ;;
      # A running node of the graph: the last one dispatched may have been replanned away.
      live) "$2" "$label" "${R[@]}" --run "$live" --node "$live_node" ;;
      largest) "$2" "$label" "${R[@]}" --run "$largest" ;;
      corpus) "$2" "$label" "${C[@]}" --run "$corpus_run" ;;
    esac
  done
}
views_first() {
  local name=$1; shift
  for view in graph overall node; do
    m "first.$view.$name" "$@" --measure "first-$view" --timeout 120
    m "first.$view.$name.cold-cache" "$@" --measure "first-$view" --cache cold --timeout 120
    m "first.$view.$name.fresh-server" "$@" --measure "first-$view" --server fresh --timeout 300
  done
}
views_today() {
  local name=$1; shift
  for view in graph overall node; do
    m "today.$view.$name" "$@" --measure "first-$view" --client today --timeout 1500
  done
}
views_content() {
  local name=$1; shift
  for view in graph overall node; do
    m "content.$view.$name" "$@" --measure "first-content-$view" --timeout 1500
    m "whole.$view.$name" "$@" --measure "first-content-$view" --first-query whole=1 --timeout 1500
  done
  m "content.graph.$name.no-stream-ends" "$@" --measure first-content-graph --first-query whole=1\&no_stream_ends=1 --timeout 1500
  m "content.overall.$name.no-stream-ends" "$@" --measure first-content-overall --first-query no_stream_ends=1 --timeout 1500
  m "rest.$name" "$@" --measure first-rest --timeout 1500
  m "open-current.$name" "$@" --measure first-open-current
  m "kinds.$name" "$@" --measure first-kinds
  m "answer-checkpoint.graph.$name" "$@" --measure first-answer-graph --first-query checkpoint=1
  m "answer-every-edge.graph.$name" "$@" --measure first-answer-graph --first-query every_edge=1
}
case $lane in
  first) each x views_first ;;
  today) each x views_today ;;
  content)
    # Only runs that do not change give a meaningful comparison: the settled largest and
    # the corpus. The small and active runs are read too, for their first answer's bytes.
    each x views_content ;;
esac
echo "lane $lane done"
