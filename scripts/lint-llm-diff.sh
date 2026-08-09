#!/usr/bin/env bash
# The blocking `llmlint` PR check, split so every judge call fits its harness.
#
# A harness caps how large a single turn may be, and codex refuses one over
# 1048576 characters outright — before the model is called:
#
#   turn/start failed: Input exceeds the maximum length of 1048576 characters.
#   (code -32602), data: {"input_error_code":"input_too_large",
#   "max_chars":1048576,"actual_chars":1168716}
#
# oneharness reads that as a task failure rather than an unavailable harness, so
# it does not fall through to claude-code either; llmlint retries the schema
# three times, gets the same refusal, and reports the last symptom instead of the
# cause — "produced output that failed schema validation: no JSON value could be
# extracted from the response". The batch carrying the broadest rules therefore
# came back `errored` rather than judged on the branch that imported the
# frontend, `no_hardcoded_secrets`, `boundary_inputs_validated` and
# `least_privilege_grants` among them.
#
# What a judge call carries is the union of its rules' target files, each with
# its unified diff inlined. Two levers were measured against that, both by
# capturing the prompt llmlint hands the harness:
#
#   * `batch_size` splits *rules* across calls, not files. A single-rule run over
#     this branch still built a 1109927-character prompt, so no batch size
#     reaches it.
#   * Naming files as llmlint's positional arguments does not bound it either:
#     a rule's own `files:` glob takes precedence over them, so the glob-scoped
#     rules pulled the whole change back in and the largest call only fell from
#     1130840 to 968116 characters — still over the cap once the harness adds its
#     schema and wrapper (~37876 characters).
#
# `--exclude` is the one that works, because it is a denylist that always wins —
# it narrows every rule's set, glob-scoped or not. So each shard runs the whole
# rule set with every changed file *outside* that shard excluded, which took the
# largest call to 656097 characters. Two properties keep that a split rather than
# a quiet exclusion:
#
#   * The shards partition the changed files — every one is judged in exactly one
#     shard, and the excludes for a shard are exactly its complement. Sharding
#     cannot drop a rule the way an `ignore` or a config exclude would; it only
#     splits the evidence.
#   * Every shard runs even after one fails, and the worst exit code wins, so a
#     judge that never reached a verdict (exit 2) still fails the check.
#
# The cost is real and worth stating: a rule that needs two files together to see
# a violation only sees them together when they share a shard. Files are packed
# in path order so a directory stays contiguous, and a diff small enough for one
# call — every ordinary change — runs as a single unsharded llmlint invocation,
# exactly the `llmlint --diff` this replaces.
set -euo pipefail

# Characters of `git diff` per shard. The budget is spent on the raw diff, which
# is never smaller than what llmlint sends (llmlint drops what `llmlint.yml`
# excludes, lock files included), so over-counting makes a shard smaller than the
# cap, never larger. 700000 measured out at 656097 prompt characters on the
# largest shard of this repository's largest change — a third of codex's cap
# spare for the preamble, the rule descriptions, and a harness with less room.
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
shard_ends=()
files=()
total=0
running=0
while IFS= read -r -d '' file; do
  size="$(git diff "$range" -- "$file" | wc -c)"
  if [ "${#files[@]}" -gt 0 ] && [ "$((running + size))" -gt "$budget" ]; then
    shard_ends+=("${#files[@]}")
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
shard_ends+=("${#files[@]}")
shard_count="${#shard_ends[@]}"

# One call is the run this script replaces: llmlint's own file selection, no
# excludes, the caller's arguments forwarded untouched.
if [ "$shard_count" -eq 1 ]; then
  echo "lint-llm-diff: ${#files[@]} changed file(s), $total diff chars, one judge run" >&2
  exec llmlint --diff --diff-base "$base" ${@+"$@"}
fi

# `--exclude` takes a glob, so a path is only a faithful exclusion when it
# contains no glob metacharacter. Refusing here is the honest outcome: silently
# excluding more than the one file would leave the difference unjudged, which is
# the failure this script exists to prevent. Checked only when sharding, because
# the single-call path above passes no excludes at all.
for file in "${files[@]}"; do
  case "$file" in
    *[\*\?\[\]\{\}\\]*) usage_error "'$file' contains a glob metacharacter, so it cannot be excluded from a shard exactly" \
      "raise LLMLINT_SHARD_BUDGET_CHARS so the change fits one judge run, or rename the file" ;;
  esac
done

echo "lint-llm-diff: ${#files[@]} changed file(s), $total diff chars, $shard_count shard(s) of <= $budget" >&2

status=0
start=0
for ((i = 0; i < shard_count; i++)); do
  end="${shard_ends[$i]}"
  # Every changed file outside this shard, and nothing else: the shards partition
  # the change, so each file is judged in exactly one of them.
  excludes=()
  for ((f = 0; f < ${#files[@]}; f++)); do
    if [ "$f" -lt "$start" ] || [ "$f" -ge "$end" ]; then
      excludes+=(--exclude "${files[$f]}")
    fi
  done
  echo "lint-llm-diff: shard $((i + 1))/$shard_count — $((end - start)) file(s) judged, ${#excludes[@]} argument(s) excluding the rest" >&2
  rc=0
  llmlint --diff --diff-base "$base" "${excludes[@]}" ${@+"$@"} || rc=$?
  # llmlint exits 1 for violations and 2 for a judge that never reached a
  # verdict. Every shard runs regardless: stopping at the first would report one
  # shard's findings as the whole change's.
  if [ "$rc" -gt "$status" ]; then
    status="$rc"
  fi
  start="$end"
done

if [ "$status" -eq 0 ]; then
  echo "lint-llm-diff: $shard_count shard(s) judged, none reported a violation" >&2
else
  echo "lint-llm-diff: $shard_count shard(s) judged, worst exit $status — see the reports above" >&2
fi
exit "$status"
