#!/usr/bin/env bash
# Time `just ci-test-linux` on a cold Rust cache, as a hosted `test-linux` job
# that restored no cache runs it: the measurement behind
# docs/linux-cold-cache-timing.md.
#
# A clone of one commit is made under --workdir, provisioned untimed the way the
# job's earlier steps provision it (bootstrap, the release tools), and its
# `target`, Nx cache and baseline server removed. The recipe then runs pinned to
# --cpus, a hosted runner's four, with every compiler cache off. Docker does not
# inherit `taskset`, so `docker run` is handed `--cpuset-cpus` by a shim on PATH
# (scripts/measure-cold-linux.d/docker).
#
# --fixture names a change, `FROM...TO` in this repository, applied on top as one
# commit, so the recipe selects what that change selects: the measurements use
# PR #395's, which selects the cancelled jobs' tasks. The clone's base for the
# affected selection and the baseline server is --commit itself.
#
# The scratch directory the journeys use is put under --workdir, beside the
# clone: a journey that renames a provisioned tool into it fails with EXDEV when
# the two are on different filesystems.
#
# Usage:
#   scripts/measure-cold-linux.sh --commit REV [--fixture FROM...TO] [--label NAME]
#     [--cpus LIST] [--workdir DIR] [--keep]
#
# Prints one line, `measure-cold-linux: LABEL exit=N wall=S nx=…`, and leaves the
# recipe's log beside it. Exit: the recipe's own status; 2 for a usage error;
# 1 when the clone could not be set up.
set -euo pipefail

usage() {
  echo "measure-cold-linux: $1" >&2
  echo "ACTION: run 'scripts/measure-cold-linux.sh --commit REV [--fixture FROM...TO] [--label NAME] [--cpus LIST] [--workdir DIR] [--keep]'" >&2
  exit 2
}
fail() {
  echo "measure-cold-linux: $1" >&2
  echo "ACTION: $2" >&2
  exit 1
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
commit="" fixture="" label="" cpus="0-3" workdir="/tmp/onepipeline-ui-cold" keep=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit | --fixture | --label | --cpus | --workdir)
      [ "$#" -ge 2 ] || usage "$1 needs a value"
      case "$1" in
        --commit) commit="$2" ;;
        --fixture) fixture="$2" ;;
        --label) label="$2" ;;
        --cpus) cpus="$2" ;;
        --workdir) workdir="$2" ;;
      esac
      shift 2
      ;;
    --keep) keep="yes"; shift ;;
    *) usage "unknown argument '$1'" ;;
  esac
done
[ -n "$commit" ] || usage "--commit is required"
printf '%s' "$cpus" | grep -Eq '^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$' \
  || usage "--cpus '$cpus' is not a CPU list such as 0-3"
case "$workdir" in
  /*) ;;
  *) usage "--workdir '$workdir' is not an absolute path" ;;
esac
# Compared as the filesystem resolves it, symlinks and `..` included: this
# script deletes and clones under it.
resolved="$(realpath -m -- "$workdir")"
case "$resolved/" in
  "$root"/*) usage "--workdir '$workdir' is inside this checkout, whose target it would share" ;;
esac
[ "$resolved" != / ] || usage "--workdir '$workdir' is the root directory, whose children this would delete"
workdir="$resolved"
sha="$(git -C "$root" rev-parse --verify --quiet "$commit^{commit}")" \
  || usage "--commit '$commit' is not a commit in this repository"
if [ -n "$fixture" ]; then
  case "$fixture" in
    *...*...*) usage "--fixture '$fixture' is not FROM...TO" ;;
    ?*...?*) ;;
    *) usage "--fixture '$fixture' is not FROM...TO" ;;
  esac
  if ! git -C "$root" rev-parse --verify --quiet "${fixture%%...*}^{commit}" >/dev/null ||
    ! git -C "$root" rev-parse --verify --quiet "${fixture##*...}^{commit}" >/dev/null; then
    usage "--fixture '$fixture' does not name two commits in this repository"
  fi
fi
label="${label:-cold-${sha:0:7}}"
printf '%s' "$label" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' || usage "--label '$label' is not a plain name"
for tool in taskset docker git just; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH" "install $tool; this measures a Linux host with Docker"
done
docker_bin="$(command -v docker)"
[ "$docker_bin" -ef "$root/scripts/measure-cold-linux.d/docker" ] \
  && fail "the docker on PATH is this measurement's own shim" "take $root/scripts/measure-cold-linux.d off PATH, then re-run"

clone="$workdir/$label"
scratch="$workdir/$label-scratch"
log="$workdir/$label.log"
# Each is deleted below, so none may be this checkout or hold it, however the
# filesystem resolves its name.
for doomed in "$clone" "$scratch"; do
  case "$root/" in
    "$(realpath -m -- "$doomed")"/*) usage "--workdir '$workdir' with --label '$label' names $doomed, which holds this checkout" ;;
  esac
done
rm -rf "$clone" "$scratch" \
  || fail "could not remove the last run's $clone and $scratch (rm's reason is above)" "make them writable, or pass another --label"
mkdir -p "$workdir" "$scratch" || fail "could not create $workdir" "make its parent writable, or pass another --workdir"

git clone --quiet "$root" "$clone" || fail "could not clone $root into $clone" "free space on the filesystem holding $workdir"
git -C "$clone" checkout --quiet -B measure "$sha" \
  || fail "could not check $sha out in $clone (git's reason is above)" "free space on the filesystem holding $workdir, then re-run"
git -C "$clone" update-ref refs/remotes/origin/main "$sha" \
  || fail "could not point the clone's origin/main at $sha" "check that $clone/.git is writable, then re-run"
if [ -n "$fixture" ]; then
  git -C "$root" diff "$fixture" | git -C "$clone" apply --index \
    || fail "the fixture $fixture does not apply on $sha" "pick a fixture whose files $sha still has unchanged"
  git -C "$clone" -c user.name=measure -c user.email=measure@localhost commit --quiet -m "fixture: $fixture" \
    || fail "could not commit the fixture $fixture on $sha (git's reason is above)" "if git says there is nothing to commit, $sha already holds the fixture; otherwise fix what git names, then re-run"
fi


# No compiler cache anywhere: a hosted runner has none, and a host's
# `build.rustc-wrapper` would otherwise reach the journeys that clear
# RUSTC_WRAPPER from their own builds.
run_env=(
  "PATH=$root/scripts/measure-cold-linux.d:$PATH"
  "MEASURE_DOCKER=$docker_bin"
  "MEASURE_CPUS=$cpus"
  "RUSTC_WRAPPER="
  "CARGO_BUILD_RUSTC_WRAPPER="
  "CARGO_INCREMENTAL=0"
  "CARGO_TERM_COLOR=always"
  "ONEPIPELINE_NODE_SCRATCH_DIR=$scratch"
  "ONEPIPELINE_UI_NX_BASE_SHA=$sha"
)

# Provisioning, untimed, as the job's steps before the gate: the release tools
# are copied from this checkout's .tools when they are at the pins there, which
# is what `just release-tools` does with a binary on PATH.
provisioning="$workdir/$label-bootstrap.log"
cd "$clone"
provisioning_failed() {
  echo "measure-cold-linux: '$1' failed in the clone; the last lines of $provisioning:" >&2
  tail -n 20 "$provisioning" >&2
  fail "'$1' failed in the clone (log: $provisioning)" "fix what the log names, then re-run"
}
env "${run_env[@]}" just bootstrap >"$provisioning" 2>&1 || provisioning_failed "just bootstrap"
env "${run_env[@]}" PATH="$root/.tools/bin:$root/scripts/measure-cold-linux.d:$PATH" just release-tools >>"$provisioning" 2>&1 \
  || provisioning_failed "just release-tools"

rm -rf target .nx/cache .nx/workspace-data .tools/bin/onepipeline-api-baseline .tools/bin/onepipeline-api-baseline.commit \
  || fail "could not clear the clone's target, Nx cache and baseline server, so the run would not start cold" "make $clone writable, then re-run"
started="$(date +%s)"
status=0
env "${run_env[@]}" taskset -c "$cpus" just ci-test-linux >"$log" 2>&1 || status=$?
wall=$(($(date +%s) - started))
# An unreadable log leaves the summary's duration unknown rather than ending it.
nx="$({ sed 's/\x1b\[[0-9;]*m//g' "$log" || true; } | sed -n 's/^ *Run duration: *//p' | tail -n1)"
echo "measure-cold-linux: $label exit=$status wall=${wall}s nx=${nx:-unknown} log=$log"
if [ "$status" -ne 0 ]; then
  echo "measure-cold-linux: 'just ci-test-linux' failed in the clone of $sha (exit $status); its last lines:" >&2
  { sed 's/\x1b\[[0-9;]*m//g' "$log" || true; } | tail -n 20 >&2
  echo "ACTION: read $log for the failing task; a timing from a failed run is not a measurement, so fix it and re-run" >&2
fi
cd "$workdir"
# The measured status is what this exits with; a cleanup that fails says so
# and changes nothing about it.
if [ -z "$keep" ] && ! rm -rf "$clone" "$scratch"; then
  echo "measure-cold-linux: could not remove $clone and $scratch after the run (rm's reason is above)" >&2
  echo "ACTION: remove them by hand before the next run with --label $label" >&2
fi
exit "$status"
