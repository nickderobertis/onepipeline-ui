#!/usr/bin/env bash
# THROWAWAY (spike-saved-results): the base-push lookup the plan's action will make,
# through plain `gh`, counting every HTTP request gh really sent.
#   merged-run-reads.sh <commit-sha> [artifact-name] [out-dir]
# Prints one `reads:` line per stage and a final `TOTAL_REST=<n>`. A commit with no pull
# request, or a run with no such artifact, stops there and still prints the total.
set -uo pipefail
sha="$1"; artifact="${2:-budget-results}"; out="${3:-$(mktemp -d)}"
repo="${GITHUB_REPOSITORY:-nickderobertis/onepipeline-ui}"
workflow="${SPIKE_WORKFLOW:-ci.yml}"
mkdir -p "$out"; dbg="$out/gh-debug.log"; : > "$dbg"
total=0
# A GitHub API request, as gh logs it. "* Request took" would match a looser pattern, and the
# archive's 302 target (blob storage) is a transfer the action's own count also leaves out.
api_requests() { grep -c '^\* Request to https://api\.github\.com/' "$dbg" || true; }
read_api() { # label, endpoint, output file: one `gh api` call and how many requests it took
  local label="$1" endpoint="$2" file="$3" t0 t1 before after
  before="$(api_requests)"; t0="$(date +%s.%N)"
  GH_DEBUG=api gh api "$endpoint" > "$file" 2>> "$dbg"; local rc=$?
  t1="$(date +%s.%N)"; after="$(api_requests)"
  total=$((total + after - before))
  printf 'reads: %-24s exit=%s requests=%s seconds=%.2f %s\n' "$label" "$rc" "$((after - before))" "$(echo "$t1 - $t0" | bc)" "$endpoint"
  return "$rc"
}
finish() { echo "TOTAL_REST=$total"; exit 0; }

read_api commit-pulls "repos/$repo/commits/$sha/pulls" "$out/pulls.json" || finish
echo "pulls: $(jq -c '[.[] | {number,state,merged_at,merge_commit_sha:(.merge_commit_sha//""|.[0:10]),head:.head.sha[0:10]}]' "$out/pulls.json")"
head="$(jq -r --arg s "$sha" 'map(select(.merged_at != null and ((.merge_commit_sha // "") | startswith($s) or ($s | startswith(.merge_commit_sha // "x"))))) | .[0].head.sha // empty' "$out/pulls.json")"
[ -n "$head" ] || { echo "result: no merged pull request whose merge commit is this one (pulls listed: $(jq length "$out/pulls.json"))"; finish; }

read_api head-pull-request-run "repos/$repo/actions/workflows/$workflow/runs?event=pull_request&head_sha=$head&per_page=1" "$out/runs.json" || finish
echo "runs: $(jq -c '{total_count, run: (.workflow_runs[0] | {id,run_attempt,conclusion,head_sha:.head_sha[0:10]})}' "$out/runs.json")"
run="$(jq -r '.workflow_runs[0].id // empty' "$out/runs.json")"
[ -n "$run" ] || { echo "result: no pull_request run at $head"; finish; }

read_api artifact-by-name "repos/$repo/actions/runs/$run/artifacts?name=$artifact" "$out/artifacts.json" || finish
echo "artifacts: $(jq -c '{total_count, artifacts:[.artifacts[]|{id,name,size_in_bytes,expired,created_at}]}' "$out/artifacts.json")"
id="$(jq -r '[.artifacts[] | select(.expired | not)] | sort_by(.created_at) | last | .id // empty' "$out/artifacts.json")"
[ -n "$id" ] || { echo "result: run $run holds no unexpired $artifact"; finish; }

read_api artifact-archive "repos/$repo/actions/artifacts/$id/zip" "$out/artifact.zip" || finish
echo "archive: $(wc -c < "$out/artifact.zip") bytes"
mkdir -p "$out/x" && (cd "$out/x" && unzip -qo ../artifact.zip && ls -la . | sed 's/^/archive-file: /')
if [ -f "$out/x/budget-run.json" ]; then
  echo "budget-run.json results: $(jq '.results | length' "$out/x/budget-run.json")"
fi
finish
