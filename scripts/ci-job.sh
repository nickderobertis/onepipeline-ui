#!/usr/bin/env bash
# The checks one of ci.yml's four Nx jobs runs, as one Nx invocation a developer can
# run too: `just ci-lint`, `just ci-test-linux`, `just ci-test-windows` and
# `just ci-test-macos` are this script, and each job's step calls its recipe.
#
# One invocation per job, not one per check, because Nx is what runs the job's
# checks side by side: a pull request waits on its slowest job, and a job that
# ran its tiers and its packaging one after another would wait on their sum. The
# packaging targets (`install-smoke`, `wheel-smoke`) are Nx targets of the crate
# for that reason, so they overlap the test tiers rather than following them.
#
# Every job is scoped by `scripts/nx-affected.sh` — a pull request against its
# merge base, a push against the commit before it — and fails closed the way that
# script does. `test-linux` on the broader tier (the release pull request,
# `scripts/ci-tier.sh`) runs every project instead, which is the sweep: the
# released tree meets the whole graph once, with the host-labelled budgets.
#
# Usage:
#   ci-job.sh lint|test-linux|test-windows|test-macos|read-latency [--tier affected|broader] [--plan]
#
# `--plan` prints the tasks the job would run and runs none of them: the
# selection, readable on a host that cannot run the job's platform. Either way the
# job's first line on stdout names its tasks (`ci-job: <job> runs N task(s): ...`),
# so a log says what was selected before anything ran.
#
# Exit 0: every selected task passed (or none was selected). Non-zero: a task
# failed — Nx's own status — or the call was refused (2).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "ci-job: cannot enter the repository root $ROOT" >&2
  echo "ACTION: run this from a checkout whose directories are readable" >&2
  exit 1
}

usage() {
  echo "ci-job: $1" >&2
  echo "ACTION: run 'scripts/ci-job.sh lint|test-linux|test-windows|test-macos|read-latency [--tier affected|broader] [--plan]'" >&2
  exit 2
}

job="${1:-}"
[ -n "$job" ] || usage "name the job to run"
shift
tier="affected"
plan=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tier)
      [ "$#" -ge 2 ] || usage "--tier needs affected or broader"
      tier="$2"
      shift 2
      ;;
    --plan) plan="yes"; shift ;;
    *) usage "unknown argument '$1'" ;;
  esac
done
case "$tier" in
  affected | broader) ;;
  *) usage "'$tier' is not a tier; it is affected or broader" ;;
esac

# What each job owes, as Nx targets. One list per job and no other copy: the
# workflow names the recipe, never these.
#   lint          what does not depend on the platform it runs on: formatting,
#                 lints, type checks, the MSRV floor and the dependency audit.
#   test-linux    the deterministic gate (`check`: every tier, the coverage floor,
#                 docs), the documented install and the release's Linux wheel.
#   test-windows  the platform-sensitive tiers (`check-cross`), the release's
#                 browser build, and the documented install.
#   test-macos    the platform-sensitive tiers and the documented install.
#   read-latency  dag-ui-read-latency's timings, large-corpus journeys and the
#                 budgets over them, which the `budgets` job runs (below).
case "$job" in
  lint) targets="format-check,lint,typecheck,msrv,deps-check" ;;
  test-linux)
    if [ "$tier" = "broader" ]; then
      # `just check`'s tiers and its aggregate, then `just budgets`: the sweep.
      # No `wheel-smoke`: every project's `test` includes the release journeys
      # (`onepipeline-ui-release:test`), whose rehearsal builds that same wheel
      # through `just wheel-linux` and installs and runs it, beside the archive
      # and npm package packed from its binary. Both compiled into one target
      # directory, one waiting on the other's lock, so the second only set up a
      # container and installed the wheel again.
      targets="format-check,lint,typecheck,build,test,test-baseline,test-cost,doc,check,budgets,budgets-host,install-smoke"
    else
      # `check`'s own tiers, less the formatting, lint and type-check targets
      # `lint` runs over the same affected set, so this job does not compile the
      # crate a second time to lint it. Listed rather than reached through
      # `check`, which would pull them back in; `tests/e2e/ci_jobs.rs` holds the
      # list to `check`'s selection. Browser-bundle tests run here too, so their
      # result is proven before the broader release tier needs it. `prioritize`
      # runs nothing: it is the edge that has Nx start a long suite with the tiers.
      targets="build,test,test-baseline,test-cost,test-isolation,doc,coverage,budgets,test-ci-jobs,install-smoke,wheel-smoke,prioritize"
    fi
    ;;
  test-windows) targets="format-check,lint,test-quick,build,install-smoke" ;;
  test-macos) targets="format-check,lint,test-quick,install-smoke" ;;
  read-latency) ;;
  *) usage "'$job' is not one of ci.yml's jobs" ;;
esac
if [ "$tier" = "broader" ] && [ "$job" != "test-linux" ] && [ "$job" != "read-latency" ]; then
  usage "only test-linux and read-latency have a broader tier; $job runs the affected one"
fi

# dag-ui-read-latency times reads on a release build with nothing beside it, and
# its large-corpus journeys run on that build too. test-linux is a CPU-bound pool
# of every other tier on four cores, so those tasks ran after the whole pool,
# alone, and on a cold pull request the two together ran past test-linux's cap.
# They run in the `budgets` job instead, after the four test jobs, on a runner of
# their own: the same targets, on every pull request that reaches the project and
# on the release pull request's sweep, against the release build test-linux
# compiled for its own rehearsal and hands over as an artifact
# (`read-latency-release-server`). So test-linux leaves the project out; the
# rehearsal still reaches `compile-release-server` as its dependency.
READ_LATENCY="dag-ui-read-latency"
if [ "$job" = "read-latency" ]; then
  # In this order, one at a time, each alone on the runner: a timing and the
  # budgets that read it, the large run's timing and its budgets, then the
  # journeys, which time nothing. The sweep adds the project's own static checks
  # and its `check`, which test-linux's sweep no longer reaches.
  read_tasks="test budgets test-large budgets-large test-journeys"
  [ "$tier" = "broader" ] && read_tasks="format-check lint typecheck $read_tasks check"
  if [ "$tier" = "broader" ]; then
    reached="true"
  else
    reached="$(bash scripts/nx-affected.sh --affects "$READ_LATENCY")" || {
      echo "ci-job: could not ask whether this change reaches $READ_LATENCY" >&2
      echo "ACTION: fix the error above; 'scripts/nx-affected.sh --affects $READ_LATENCY' asks the same" >&2
      exit 1
    }
  fi
  tasks=""
  if [ "$reached" = "true" ]; then
    for target in $read_tasks; do tasks="$tasks $READ_LATENCY:$target"; done
  fi
  tasks="${tasks# }"
  count=0
  [ -z "$tasks" ] || count="$(printf '%s\n' $tasks | wc -l | tr -d ' ')"
  echo "ci-job: read-latency runs $count task(s): ${tasks:-none}"
  [ -z "$plan" ] || exit 0
  [ "$count" -gt 0 ] || exit 0
  server="target/wheel-x86_64-unknown-linux-gnu/x86_64-unknown-linux-gnu/release/onepipeline-api"
  [ -x "$server" ] || {
    echo "ci-job: no release server at $server, which these timings read" >&2
    echo "ACTION: download test-linux's read-latency-release-server artifact there, or run 'npx nx run $READ_LATENCY:compile-release-server'" >&2
    exit 1
  }
  # The browser the journeys and timings drive, with what it needs of the host
  # where the host lets this ask for it.
  if [ -n "${CI:-}" ]; then
    npx playwright install --with-deps chromium || exit $?
  else
    npx playwright install chromium || exit $?
  fi
  bash scripts/nx.sh run onepipeline-ui:ensure-sibling --outputStyle=static || exit $?
  for task in $tasks; do
    bash scripts/nx.sh run "$task" --exclude-task-dependencies --skip-nx-cache --outputStyle=static || exit $?
  done
  exit 0
fi

# The selection, as Nx's own task graph rather than a reading of its output.
nx_run() {
  local leave=()
  [ "$job" = "test-linux" ] && leave=(--exclude "$READ_LATENCY")
  if [ "$tier" = "broader" ]; then
    bash scripts/nx.sh run-many -t "$targets" "${leave[@]}" "$@"
  else
    bash scripts/nx-affected.sh -t "$targets" "${leave[@]}" "$@"
  fi
}
graph="$(nx_run --graph=stdout)" || {
  printf '%s\n' "$graph" >&2
  echo "ci-job: Nx could not plan $job's tasks" >&2
  echo "ACTION: fix the Nx error above; 'just nx show projects' lists what it can read" >&2
  exit 1
}
# Read as a parsed graph whose task map must be there (scripts/ci-job-tasks.mjs).
tasks="$(printf '%s' "$graph" | node scripts/ci-job-tasks.mjs)" || {
  printf '%s\n' "$graph" >&2
  echo "ci-job: could not read the task graph Nx planned for $job" >&2
  echo "ACTION: run 'just nx run-many -t $targets --graph=stdout' and fix what it reports" >&2
  exit 1
}
# The release build the `budgets` job's read-latency timings serve. The pool
# reaches it through the rehearsal on any change to the crate, the view or the
# release; a change that reaches the timings alone compiles it after the pool,
# which such a change keeps small.
COMPILE="$READ_LATENCY:compile-release-server"
compile_after=""
if [ "$job" = "test-linux" ] && ! printf '%s\n' $tasks | grep -qx "$COMPILE"; then
  reached="$(bash scripts/nx-affected.sh --affects "$READ_LATENCY")" || {
    echo "ci-job: could not ask whether this change reaches $READ_LATENCY" >&2
    echo "ACTION: fix the error above; 'scripts/nx-affected.sh --affects $READ_LATENCY' asks the same" >&2
    exit 1
  }
  if [ "$reached" = "true" ]; then
    compile_after="yes"
    tasks="${tasks:+$tasks }$COMPILE"
  fi
fi
count=0
[ -z "$tasks" ] || count="$(printf '%s\n' $tasks | wc -l | tr -d ' ')"
echo "ci-job: $job runs $count task(s): ${tasks:-none}"
[ -z "$plan" ] || exit 0

# Six at once on a hosted runner's four cores: the packaging targets are the
# job's longest tasks and have no dependency to wait on, so at four slots they
# start only once the tiers have drained and the job ends on their tail.
# Oversubscribing lets them start with the tiers.
if [ "$count" -gt 0 ]; then
  nx_run --parallel=6 --outputStyle=static || exit $?
fi
if [ -n "$compile_after" ]; then
  bash scripts/nx.sh run "$COMPILE" --outputStyle=static || exit $?
fi

# A committed lockfile the bootstrap or the gate had to change is a stale
# generated file; fail rather than let it drift. Asked whether or not a task ran,
# because the job's bootstrap installs from both lockfiles before this runs.
if [ "$job" = "test-linux" ]; then
  git diff --exit-code -- Cargo.lock bun.lock || {
    echo "ci-job: a committed lockfile differs from what this checkout resolves (diff above)" >&2
    echo "ACTION: run 'just bootstrap', commit the updated lockfile, and push" >&2
    exit 1
  }
fi
