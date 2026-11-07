#!/usr/bin/env bash
# Every measurement the first-screen report states, each one invocation of
# scripts/spike-run-open-costs.mjs, written to OUT/<name>.json. A figure already written is
# kept, so an interrupted pass resumes. One pass: each is taken once, with its load.
#   matrix.sh first|content|today|extra|quiet|strong OUT REAL_ROOT SMALL_RUN LIVE_RUN LARGEST_RUN CORPUS_ROOT LIVE_NODE [LARGEST_NODE REPLANNED_NODE]
set -uo pipefail
lane=$1 out=$2 root=$3 small=$4 live=$5 largest=$6 corpus=$7 live_node=$8 largest_node=${9:-} replanned_node=${10:-}
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
      live) "$2" "$label" "${R[@]}" --run "$live" --node "$live_node" --moving ;;
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
# The largest run's largest node on its graph, which its first node is not; its largest node
# of all, which was replanned away, so no client draws it and only its answer is read; and
# whether a state resumed from the checkpoint gives the first answer the same values.
extra() {
  local run=(--runs-root "$root" --cwd "$(dirname "$root")" --run "$largest")
  local node=(--node "$largest_node")
  m first.node.largest-node "${run[@]}" "${node[@]}" --measure first-node --timeout 120
  m first.node.largest-node.cold-cache "${run[@]}" "${node[@]}" --measure first-node --cache cold --timeout 120
  m first.node.largest-node.fresh-server "${run[@]}" "${node[@]}" --measure first-node --server fresh --timeout 300
  m today.node.largest-node "${run[@]}" "${node[@]}" --measure first-node --client today --timeout 600
  m content.node.largest-node "${run[@]}" "${node[@]}" --measure first-content-node --timeout 1500
  m rest.largest-node "${run[@]}" "${node[@]}" --measure first-rest --timeout 1500
  m content.node.replanned "${run[@]}" --node "$replanned_node" --measure first-content-node --timeout 1500
  m rest.replanned "${run[@]}" --node "$replanned_node" --measure first-rest --timeout 1500
  m content-checkpoint.graph.largest "${run[@]}" --measure first-content-graph --first-query checkpoint=1 --timeout 1500
  m content-checkpoint.overall.largest "${run[@]}" --measure first-content-overall --first-query checkpoint=1 --timeout 1500
}
# The views the loaded pass left over one second, taken again when the host is quieter.
quiet() {
  local run=(--runs-root "$root" --cwd "$(dirname "$root")" --run "$largest")
  m first.graph.largest.quiet "${run[@]}" --measure first-graph --timeout 120
  m first.overall.largest.quiet "${run[@]}" --measure first-overall --timeout 120
  m first.node.corpus.quiet "${C[@]}" --run "$corpus_run" --measure first-node --timeout 120
}
# Every view and run once on each client under the mark as strengthened: its report says when
# the parts first existed and when the values were right, which is whether a figure moved.
strong() {
  local name
  strong_views() {
    name=$1; shift
    for view in graph overall node; do
      m "first.$view.$name" "$@" --measure "first-$view" --timeout 120
      [ "${STRONG_TODAY:-1}" = 1 ] && m "today.$view.$name" "$@" --measure "first-$view" --client today --timeout 900
    done
  }
  each x strong_views
  local run=(--runs-root "$root" --cwd "$(dirname "$root")" --run "$largest")
  m first.node.largest-node "${run[@]}" --node "$largest_node" --measure first-node --timeout 120
  [ "${STRONG_TODAY:-1}" = 1 ] && m today.node.largest-node "${run[@]}" --node "$largest_node" --measure first-node --client today --timeout 900
}
case $lane in
  strong) strong ;;
  quiet) quiet ;;
  extra) extra ;;
  first) each x views_first ;;
  today) each x views_today ;;
  content)
    # Only runs that do not change give a meaningful comparison: the settled largest and
    # the corpus. The small and active runs are read too, for their first answer's bytes.
    each x views_content ;;
esac
echo "lane $lane done"
