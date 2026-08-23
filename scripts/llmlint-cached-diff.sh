#!/usr/bin/env bash
# The memo around the judged tier: what `just lint-llm-diff <base> [nx args]` runs.
#
# The judge is non-deterministic across the gap between what it judges and what
# changed — it judges every file in the base-to-head diff, because llmlint has no
# increment mode, while what changed is one hunk. With no memo, every worker gate,
# every publication gate and every CI run over the same diff is an independent
# roll, and rolls of one branch have named a different rule each time. So one tree
# judged against one base with one judge configuration gets **one** verdict: the
# Nx target `onepipeline-ui:lint-llm-diff` is cached, and a second run over an
# unchanged tree replays the first run's report instead of rolling again.
#
# What this script contributes is the three things Nx cannot work out for itself:
#
#   * The **base commit**. The ref is resolved to a commit here, before Nx hashes
#     it, so a rebased or advanced base misses rather than replaying a verdict
#     computed against a different base. It is reported with the verdict, because
#     "green" means green *against that commit*.
#   * The **judge configuration**, as `scripts/llmlint-fingerprint.sh`. Resolved
#     here rather than declared as an Nx `runtime` input, because Nx scores a
#     runtime input that exits non-zero as no contribution rather than as an
#     error — which would silently drop the judge configuration out of the key and
#     replay a verdict it has moved on from. Here it fails the tier instead.
#     `nx.json` keys on `LLMLINT_SHARD_BUDGET_CHARS` beside it, because that is
#     the other half of the same question: it decides how the change is split
#     across judge calls, and `scripts/lint-llm-diff.sh` says why that matters —
#     a rule needing two files together only sees them together in one shard.
#   * Which **cache skip** counts. `--skip-nx-cache` in this invocation's Nx
#     arguments re-judges without reading or writing the cache, and that is the
#     one supported way to force a fresh roll. An ambient `NX_SKIP_NX_CACHE` /
#     `NX_DISABLE_NX_CACHE` — exported to re-judge this tier and then inherited by
#     everything else — is reported and ignored here, because it would re-roll a
#     non-deterministic judge from every unrelated command. Every other Nx target
#     still honours it.
#
# Only a clean run is replayed, because Nx caches successful tasks only. Findings
# (llmlint exit 1) and a toolchain that never reached a verdict (exit >= 2) both
# fail this tier and are judged again next run.
#
# llmlint: ignore-file[tool_output_is_signal] the judge's own report is this
# tier's product and is passed through whole — a replayed run has to say what a
# fresh one said or the memo has deleted the tier's result. The one line this
# script adds on a clean run is the provenance Nx's report does not state in
# those words: judged or replayed, and against which commit. Its own failures
# each carry a message and an ACTION below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "lint-llm-diff: cannot enter the repository root $ROOT" >&2
  echo "ACTION: run this from a checkout whose directories are readable" >&2
  exit 1
}

readonly TARGET="onepipeline-ui:lint-llm-diff"

usage_error() {
  echo "lint-llm-diff: $1" >&2
  echo "ACTION: $2" >&2
  exit 2
}

base="${1:-origin/main}"
shift || true
# The base reaches `git rev-parse` as a revision argument, so its shape is
# validated rather than trusted: one leading dash would make it an option.
case "$base" in
  -* | "") usage_error "'$base' is not a revision" "pass a branch, tag, or commit" ;;
esac

# `^{commit}` rather than a bare resolve, so an annotated tag keys the cache on
# the commit it points at rather than on the tag object — two names for one tree
# must not be two verdicts.
base_sha="$(git rev-parse --verify --quiet "${base}^{commit}")" || base_sha=""
[ -n "$base_sha" ] || usage_error "'$base' does not resolve to a commit in this checkout" \
  "fetch it first, or pass one that exists here (e.g. origin/main)"

# Loudly, and before anything is judged. An unproducible fingerprint is the one
# failure this tier must not shrug off: Nx would key the run on the tree and the
# base alone and replay a verdict the judge configuration has moved on from. This
# is also where a missing llmlint is reported, resolved through the tier's own
# runtime environment rather than the caller's PATH.
fingerprint="$(./scripts/llmlint-fingerprint.sh)" || {
  echo "lint-llm-diff: refusing to judge without a fingerprint of the judge configuration (diagnostics above) — an unkeyed configuration would replay a verdict it has moved on from" >&2
  exit 2
}

if [ -n "${NX_SKIP_NX_CACHE:-}${NX_DISABLE_NX_CACHE:-}" ]; then
  echo "lint-llm-diff: ignoring the ambient global Nx cache skip — it would re-roll this non-deterministic judge from every unrelated command" >&2
  echo "ACTION: force a fresh judgement of this tier alone with 'just lint-llm-diff $base --skip-nx-cache'" >&2
fi
unset NX_SKIP_NX_CACHE NX_DISABLE_NX_CACHE

report="$(mktemp)" || {
  echo "lint-llm-diff: could not open temporary storage for the judge report" >&2
  echo "ACTION: free disk space and retry" >&2
  exit 1
}
trap 'rm -f "$report"' EXIT

status=0
LLMLINT_DIFF_BASE_SHA="$base_sha" \
  LLMLINT_JUDGE_FINGERPRINT="$fingerprint" \
  bash scripts/nx.sh run "$TARGET" ${@+"$@"} >"$report" 2>&1 || status=$?
cat "$report"

# Read below rather than `$report` itself: the provenance and the exit status are
# both recovered from Nx's own wording, and Nx colourizes that wording whenever
# something sets `FORCE_COLOR` — which Nx itself does for every task it runs, so a
# nested invocation buries `[local cache]` in escape sequences. Matching the
# painted text reported every replay as a fresh judgement, which is worse than
# saying nothing: it is the one line an operator reads to know whether the verdict
# in front of them was rolled or recalled.
plain="$(sed "s/$(printf '\033')\[[0-9;]*[a-zA-Z]//g" "$report")" || {
  echo "lint-llm-diff: could not read the judge report back" >&2
  echo "ACTION: rerun; if it persists, verify sed is on PATH" >&2
  exit 1
}

# Provenance comes from Nx's own cache reporting: the task line it annotates, or
# the summary line it prints only when it replayed instead of running. Both are
# matched because only the first is safe at any size — Nx replays a hit as one
# burst, so a replay larger than a pipe buffer can arrive with its summary cut
# off. `tests/e2e/llmlint_cache.rs` asserts both wordings, and asserts them
# through a colourized run, so an Nx upgrade that renames or repaints them fails
# the suite rather than quietly reporting every replay as a fresh judgement.
# Nx reports every failed task as exit 1, so the one status it cannot carry is
# read back out of the line `scripts/llmlint-judge.sh` prints for it: a judge that
# never reached a verdict exits >= 2 here, as it did before this tier was cached.
if [ "$status" -ne 0 ]; then
  no_verdict="$(printf '%s\n' "$plain" | sed -n 's/^lint-llm-diff: the judge never reached a verdict (llmlint exit \([0-9]\{1,\}\))$/\1/p' | tail -1)"
  [ -z "$no_verdict" ] || status="$no_verdict"
fi

if printf '%s\n' "$plain" | grep -qE "^Nx read the output from the cache instead of running the command|^> nx run ${TARGET} +\[(local cache|remote cache|existing outputs match the cache)"; then
  echo "lint-llm-diff: replayed the recorded verdict for base $base_sha (Nx cache hit)" >&2
else
  echo "lint-llm-diff: judged this diff against base $base_sha (Nx cache miss)" >&2
fi
exit "$status"
