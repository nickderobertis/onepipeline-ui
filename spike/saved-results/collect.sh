#!/usr/bin/env bash
# THROWAWAY (spike-saved-results): the one command that reads one CI run's measurement.
#   spike/saved-results/collect.sh <run-id> [out-dir]
set -uo pipefail
run="$1"; out="${2:-$(mktemp -d)}"; repo=nickderobertis/onepipeline-ui; mkdir -p "$out"
echo "# run $run"; gh api "repos/$repo/actions/runs/$run" --jq '[.event,.head_sha[0:10],.run_attempt,.status,.conclusion,.head_branch]|@tsv'
gh api "repos/$repo/actions/runs/$run/jobs?per_page=100" > "$out/jobs.json"
echo "## job seconds"
jq -r '.jobs[] | [.name,.conclusion,(((.completed_at//.started_at)|fromdate)-(.started_at|fromdate))] | @tsv' "$out/jobs.json"
echo "## SPIKE and report step seconds (one-second resolution)"
jq -r '.jobs[] | .name as $j | .steps[] | select(.name|test("SPIKE|budget|onebudgetspec|Gate, install";"i")) | [$j,.name,.conclusion,((((.completed_at//.started_at)|fromdate)-(.started_at|fromdate)))] | @tsv' "$out/jobs.json"
echo "## artifacts"
gh api "repos/$repo/actions/runs/$run/artifacts?per_page=100" > "$out/artifacts.json"
jq -r '.artifacts[] | [.id,.name,.size_in_bytes,.created_at] | @tsv' "$out/artifacts.json"
for name in budget-results budget-check-results-test-linux nx-cache-entries-test-linux; do
  id="$(jq -r --arg n "$name" '[.artifacts[]|select(.name==$n)]|sort_by(.created_at)|last|.id//empty' "$out/artifacts.json")"
  [ -n "$id" ] || continue
  gh api "repos/$repo/actions/artifacts/$id/zip" > "$out/$name.zip" && mkdir -p "$out/$name" && unzip -qo "$out/$name.zip" -d "$out/$name"
done
echo "## saved results"
ls -la "$out/budget-check-results-test-linux" 2>/dev/null
for f in "$out"/budget-check-results-test-linux/*.json; do [ -f "$f" ] && jq -r --arg f "$(basename "$f")" '.results[]|[$f,.id,.verdict,.actual,.threshold,.ended_at]|@tsv' "$f"; done
echo "## job's own telemetry"
jq -c '.metrics|map_values(.value)' "$out/budget-results/report-job.json" 2>/dev/null
jq -r '.metrics["report-command-seconds"].detail' "$out/budget-results/report-job.json" 2>/dev/null
echo "## budget rows"
jq -r '.results.results[]|[.id,.verdict,.actual,.threshold]|@tsv' "$out/budget-results/budget-run.json" 2>/dev/null
jq -r '.unavailable[]|[.id,"unavailable",(.reason[0:90])]|@tsv' "$out/budget-results/budget-run.json" 2>/dev/null
echo "## budgets tasks in the Nx cache report"
jq -c '.tasks[]|select(.task|test("budgets"))|{task,hash,cacheable,result,remote_status}' "$out/nx-cache-entries-test-linux/executions.json" 2>/dev/null
jq -c '[.tasks[].result]|group_by(.)|map({(.[0]):length})' "$out/nx-cache-entries-test-linux/executions.json" 2>/dev/null
jq -c '{entries:(.entries|group_by(.source)|map({(.[0].source):length})),stored_bytes}' "$out/nx-cache-entries-test-linux/manifest.json" 2>/dev/null
echo "## logs"
gh api "repos/$repo/actions/runs/$run/jobs?per_page=100" --jq '.jobs[]|select(.name=="test-linux" or .name=="budgets")|[.id,.name]|@tsv' | while IFS=$'\t' read -r id name; do
  gh api --allow-escape-sequences "repos/$repo/actions/jobs/$id/logs" > "$out/$name.log" 2>/dev/null
  echo "### $name"
  grep -E 'ci-job: |SPIKE (upload|download) bracket|reads: |TOTAL_REST|result: |CI-time requests|^.{28} == |Nx read the output|\.json [0-9]+ bytes|target/budget-results/[a-z-]+\.json|[0-9]+\s+target/budget-results|Artifact budget-check.*uploaded|existing outputs match|No files were found' "$out/$name.log" | cut -c29-420 | grep -v '36;1m'
done
