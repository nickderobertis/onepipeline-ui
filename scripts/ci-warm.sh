#!/usr/bin/env bash
# Compile what one OS's pull-request CI compiles, and run nothing: the build
# `.github/workflows/ci-cache.yml` saves from `main` for ci.yml's four jobs to
# restore. `just ci-warm-linux`, `ci-warm-windows` and `ci-warm-macos` are this
# script.
#
# Pull requests restore that build and never save one (ci.yml), so the cache is
# only as warm as this list is complete: every compile a job's checks make has
# its line here, under the profile, flags and target directory its source
# compiles with, because cargo reuses nothing built with a different one. A
# compile it leaves out is one each pull request pays for in full.
#
# Each line names its source — the justfile recipe, the Nx target or the test
# that makes that compile — and runs that source itself wherever the source only
# compiles. Where it would also run tests, the line is the source's cargo command
# stopped before running: `--no-run` for nextest, a filter matching no test for
# the instrumented tiers; and a compile a test makes inside a journey is spelled
# as that test spells it. `--plan` prints the lines, source then command, one per
# line, without compiling anything, and `.github/tests/ci-warm.test.mjs` reads
# that plan against every task the four jobs reach through the real Nx graph:
# a compile missing here, differing from its source, or here with no source
# fails it.
#
# Needs what `just bootstrap` provisions, the browser view `just build` writes
# (the binary embeds it), and on Linux the MSRV toolchain and Docker.
#
# Usage:
#   ci-warm.sh linux|windows|macos [--plan]
#
# Quiet when every compile succeeds; a compile that fails is named after its own
# output. Exit 0: everything compiled (or, with --plan, was listed). Non-zero: a
# compile failed — main does not build, which is what this job exists to catch
# now that no push to main runs the tests — or the call was refused (2).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "ci-warm: cannot enter the repository root $ROOT" >&2
  echo "ACTION: run this from a checkout whose directories are readable" >&2
  exit 1
}

usage() {
  echo "ci-warm: $1" >&2
  echo "ACTION: run 'scripts/ci-warm.sh linux|windows|macos [--plan]'" >&2
  exit 2
}

os="${1:-}"
case "$os" in
  linux | windows | macos) ;;
  *) usage "'${os}' is not an OS ci.yml tests on" ;;
esac
shift
plan=""
case "${1:-}" in
  "") ;;
  --plan) plan="yes"; shift ;;
  *) usage "unknown argument '$1'" ;;
esac
[ "$#" -eq 0 ] || usage "unexpected argument '$1'"

# compile SOURCE COMMAND...: list it under --plan, otherwise run it. A leading
# NAME=VALUE word is an environment variable of the command, as in its source.
compile() {
  local source="$1"
  shift
  if [ -n "$plan" ]; then
    printf '%s\t' "$source"
    printf '%q ' "$@" | sed 's/ $//'
    printf '\n'
    return
  fi
  env "$@" || {
    echo "ci-warm: the compile $source makes failed (its output is above): $*" >&2
    echo "ACTION: fix the build error above; '$*' reproduces it" >&2
    exit 1
  }
}

compile "just _crate-lint" just _crate-lint
compile "nx dag-ui-build-cache:lint" bash scripts/nx.sh run dag-ui-build-cache:lint --skip-nx-cache
# Every tier's test binaries, uninstrumented: `--no-run` compiles every binary
# the default collection reaches, the union of the tiers' filters, so this one
# line is `_tier-test`'s every profile and the build-cache test's.
compile "just _tier-test" cargo nextest run --locked --no-run
compile "just _crate-install-build" just _crate-install-build

if [ "$os" = linux ]; then
  compile "just _crate-msrv" just _crate-msrv
  compile "just _crate-doc" just _crate-doc
  compile "just _tier-test-covered" \
    cargo llvm-cov nextest --locked --no-report -E 'none()' --no-tests=pass
  compile "nx dag-ui:build-api-server" bash scripts/nx.sh run dag-ui:build-api-server --skip-nx-cache
  compile "nx dag-ui-read-latency:compile-release-server" \
    cargo build --release --locked --features bundled-ui --bin onepipeline-api
  compile "test tests/e2e/linked_report.rs" \
    cargo auditable build --offline --locked --bin onepipeline-api --config 'build.build-dir="target"' --target-dir target/auditable
  # The wheel smoke builds into .tools/wheel-smoke and the release rehearsal into
  # its own --out; cargo's target directory is `target/wheel-<target>` for both.
  compile "just _crate-wheel-smoke" just wheel-linux x86_64-unknown-linux-gnu .tools/wheel-smoke
  # Caches saved before the wheel smoke moved out of `target` restore its old
  # virtualenv's directories under target/wheel-smoke, which rust-cache's save
  # walks as cargo output and errors on; removed so this job's save drops them.
  if [ -z "$plan" ]; then
    rm -rf target/wheel-smoke || {
      echo "ci-warm: could not remove target/wheel-smoke (rm's reason is above), which this job's cache save would carry on" >&2
      echo "ACTION: make target/wheel-smoke removable by $(id -un) (its owner and its parent's permissions), then re-run" >&2
      exit 1
    }
  fi
fi
