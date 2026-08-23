#!/usr/bin/env bash
# Body of the cached Nx `onepipeline-ui:lint-llm-diff` target: judge this branch's
# diff against one *resolved* base commit.
#
# Run it through `just lint-llm-diff <base>`, which resolves the base ref to the
# commit this reads, fingerprints the judge configuration, and keys the Nx cache
# on both. Running this target directly is refused below, because a base that is
# still a ref name would let one recorded verdict be replayed for another commit.
#
# Nothing here records or replays anything. `scripts/lint-llm-diff.sh` runs — the
# same sharding wrapper `just lint-llm-diff` invoked before this tier was cached,
# unchanged — and its terminal output and exit status become this task's. Nx does
# the rest: it caches a task only when it succeeds, so a clean run's report is
# replayed verbatim while findings (llmlint exit 1) and a toolchain that never
# reached a verdict (exit >= 2) stay uncached and are judged again next run. That
# asymmetry is deliberate: a red costs a fresh roll every time, and a green
# sticks until the tree, the base commit, or the judge configuration moves.
#
# The base arrives as `LLMLINT_DIFF_BASE_SHA` rather than as an argument because
# Nx hashes declared environment variables but not target arguments — keying and
# judging on the same value is what stops a clean verdict computed against one
# base from being replayed for another.
#
# llmlint: ignore-file[tool_output_is_signal] this hands straight to
# `scripts/lint-llm-diff.sh`, whose per-rule report *is* this tier's product: Nx
# replays that terminal output in place of a verdict record, so quieting a
# successful run would leave a replayed verdict saying less than a fresh one.
# Every failure this file owns is announced by its own guard below.
set -euo pipefail

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)" || {
  echo "lint-llm-diff: could not locate the repository from this script" >&2
  echo "ACTION: restore the checkout's directory layout and retry" >&2
  exit 1
}
# shellcheck source=scripts/llmlint-runtime-env.sh
. "$root/scripts/llmlint-runtime-env.sh" || {
  echo "lint-llm-diff: could not load the pinned runtime environment" >&2
  echo "ACTION: restore scripts/llmlint-runtime-env.sh and retry" >&2
  exit 1
}

# The one value this target reads from its environment, and it reaches `git` and
# `llmlint --diff-base` as a revision — so it is validated to the shape a
# resolved commit id has rather than trusted, and then to a commit this checkout
# actually has.
# llmlint: ignore-block[changed_behavior_has_e2e] both refusals are covered by
# `tests/e2e/llmlint_cache.rs`, which runs this file exactly as `project.json`
# tells Nx to run it — the real invocation these guards exist for, since what
# they catch is the target reached without `just lint-llm-diff` in front of it.
# Driving them through `just nx run onepipeline-ui:lint-llm-diff` was tried and
# measured unusable: they fail in tens of milliseconds and Nx drops a task's
# stderr that fast one run in four under the whole suite's load, so the journey
# would assert on a refusal message Nx had swallowed. The recipe entry point is
# covered by the 17 journeys either side of those two.
base_sha="${LLMLINT_DIFF_BASE_SHA:-}"
[[ "$base_sha" =~ ^[0-9a-f]{40,64}$ ]] || {
  echo "lint-llm-diff: LLMLINT_DIFF_BASE_SHA is '${base_sha:-<unset>}', not a resolved commit id" >&2
  echo "ACTION: run 'just lint-llm-diff <base>' rather than this target directly" >&2
  exit 2
}
git -C "$root" rev-parse --verify --quiet "${base_sha}^{commit}" >/dev/null || {
  echo "lint-llm-diff: base commit '$base_sha' is missing from this checkout" >&2
  echo "ACTION: fetch it and retry" >&2
  exit 2
}
# llmlint: ignore-end[changed_behavior_has_e2e]

llmlint_runtime_env
cd "$root" || {
  echo "lint-llm-diff: could not enter '$root'" >&2
  echo "ACTION: repair that directory's permissions and retry" >&2
  exit 1
}
# Not `exec`: Nx reports every failed task as exit 1, which would collapse
# llmlint's two failures into one. `scripts/lint-llm-diff.sh` distinguishes them
# — 1 is findings, >= 2 is a judge that never reached a verdict — and the
# difference is what tells an operator whether to clear a finding or repair a
# toolchain. So the second case announces itself in a line
# `scripts/llmlint-cached-diff.sh` reads the code back out of, restoring the exit
# status this tier had before it was cached. Neither is ever replayed: Nx caches
# successful tasks only.
status=0
./scripts/lint-llm-diff.sh "$base_sha" || status=$?
if [ "$status" -ge 2 ]; then
  echo "lint-llm-diff: the judge never reached a verdict (llmlint exit $status)" >&2
  echo "ACTION: repair the harness or the llmlint toolchain — this is not a finding to clear" >&2
fi
exit "$status"
