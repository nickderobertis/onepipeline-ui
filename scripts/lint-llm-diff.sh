#!/usr/bin/env bash
# The blocking `llmlint` PR check, split so every judge call fits its harness.
#
# llmlint puts the *diff* of every target file into one prompt per judge batch,
# and a harness caps how large a single turn may be: codex refuses a turn over
# 1048576 characters outright (`input_too_large`, code -32602) before the model
# is called, and oneharness treats that as a task failure rather than an
# unavailable harness, so it does not fall through to the next one either. The
# branch that imported the frontend produced 1077088 characters of diff, so the
# batch carrying the broadest rules came back `errored` instead of judged —
# `no_hardcoded_secrets`, `boundary_inputs_validated` and `least_privilege_grants`
# among them. llmlint's own `batch_size` cannot fix that: it splits *rules*
# across calls and every call still carries the whole file set, so a single-rule
# run was refused at the same size.
#
# The split therefore has to be by file. Each shard is a run of changed files
# whose combined diff stays under a character budget, named explicitly so llmlint
# judges every rule against exactly that shard. Two properties keep it honest:
#
#   * Every changed file lands in exactly one shard, so a rule matching any file
#     is judged in at least one shard. Sharding cannot drop a rule the way an
#     exclude or an `ignore` would; it only splits the evidence.
#   * The budget counts the raw `git diff`, which is never smaller than what
#     llmlint sends (llmlint drops what `llmlint.yml` excludes). Over-counting
#     makes a shard smaller than the cap, never larger.
#
# The cost is real and worth stating: a rule that needs two files together to see
# a violation only sees them together when they share a shard. Files are packed
# in path order so a directory stays contiguous, and a diff small enough for one
# call — every ordinary change — produces a single shard, which is exactly the
# `llmlint --diff` run this replaces.
set -euo pipefail

# Characters of `git diff` per shard. Well under codex's 1048576-character turn
# cap: llmlint adds the prompt template, every rule's description, and one path
# per file on top of the diff, and a harness with a smaller cap wants a smaller
# number here rather than a code change.
readonly DEFAULT_BUDGET=700000

usage_error() {
  echo "lint-llm-diff: $1" >&2
  echo "ACTION: $2" >&2
  exit 2
}

if ! command -v llmlint >/dev/null 2>&1; then
  usage_error "llmlint is not installed" "run 'just setup-llmlint'"
fi

base="${1:-origin/main}"
shift || true
# The base reaches `git diff` as a revision argument, so its shape is validated
# rather than trusted: one leading dash would make it an option instead.
case "$base" in
  -* | "") usage_error "'$base' is not a revision" "pass a branch, tag, commit, or A..B range" ;;
esac

budget="${LLMLINT_SHARD_BUDGET_CHARS:-$DEFAULT_BUDGET}"
case "$budget" in
  '' | *[!0-9]* | 0) usage_error "LLMLINT_SHARD_BUDGET_CHARS='$budget' is not a positive integer" \
    "unset it for the default of $DEFAULT_BUDGET, or set a character count" ;;
esac

# `--diff-base` semantics, mirrored from llmlint so the file set this script
# shards is the file set llmlint would have judged: a plain ref is three-dot
# (what a pull request shows as "Files changed"), an `A..B` range is git's own.
case "$base" in
  *..*) range="$base" ;;
  *) range="$base...HEAD" ;;
esac

# Resolve the range before streaming it below, where a failure would be hidden
# inside a process substitution and read as "nothing changed".
if ! git diff --name-only "$range" -- >/dev/null 2>&1; then
  usage_error "'$base' is not a revision this repository can diff against" \
    "fetch it first, or pass one that exists here (e.g. origin/main)"
fi

# Pack in path order (git's own), so a shard boundary falls between directories
# rather than through one. A file whose diff exceeds the budget alone still gets
# its own shard: the harness may refuse it, and a refusal llmlint reports as an
# error is the right outcome — silently leaving it unjudged is not.
#
# Deleted paths are left out because llmlint leaves them out: its target set is
# the files matching its globs in the work tree whose diff is non-empty.
shard_sizes=()
shard_starts=()
files=()
total=0
running=0
while IFS= read -r -d '' file; do
  size="$(git diff "$range" -- "$file" | wc -c)"
  if [ "${#files[@]}" -gt 0 ] && [ "$((running + size))" -gt "$budget" ]; then
    shard_sizes+=("$running")
    shard_starts+=("${#files[@]}")
    running=0
  fi
  files+=("$file")
  running=$((running + size))
  total=$((total + size))
done < <(git diff --name-only --diff-filter=d -z "$range" --)

if [ "${#files[@]}" -eq 0 ]; then
  echo "lint-llm-diff: nothing changed vs $base" >&2
  exit 0
fi
shard_sizes+=("$running")
shard_starts+=("${#files[@]}")

shard_count="${#shard_starts[@]}"
echo "lint-llm-diff: ${#files[@]} changed file(s), $total diff chars, $shard_count shard(s) of <= $budget" >&2

status=0
start=0
for ((i = 0; i < shard_count; i++)); do
  end="${shard_starts[$i]}"
  shard=("${files[@]:$start:$((end - start))}")
  start="$end"
  echo "lint-llm-diff: shard $((i + 1))/$shard_count — ${#shard[@]} file(s), ${shard_sizes[$i]} diff chars" >&2
  rc=0
  llmlint --diff --diff-base "$base" ${1+"$@"} "${shard[@]}" || rc=$?
  # llmlint exits 1 for violations and 2 for a judge that never reached a
  # verdict. Every shard runs regardless: stopping at the first would report one
  # shard's findings as the whole change's.
  if [ "$rc" -gt "$status" ]; then
    status="$rc"
  fi
done

if [ "$status" -eq 0 ]; then
  echo "lint-llm-diff: $shard_count shard(s) judged, none reported a violation" >&2
else
  echo "lint-llm-diff: $shard_count shard(s) judged, worst exit $status — see the reports above" >&2
fi
exit "$status"
