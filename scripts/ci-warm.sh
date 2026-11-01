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
# that makes that compile — and `--plan` prints them, source then command, one
# per line, without compiling anything. `.github/tests/ci-warm.test.mjs` reads
# that plan against every task the four jobs reach through the real Nx graph and
# fails when a compile is missing here, differs from its source, or is here with
# no source at all. The one change a line makes to its source is to stop before
# running: `--no-run` for nextest, a filter matching no test for the instrumented
# tiers.
#
#   linux    `lint` and `test-linux`: clippy (the crate's and the build-cache
#            test's), the MSRV check and the docs with warnings denied; the test
#            binaries plain and instrumented for coverage; the browser view's
#            API server; the documented install; the `cargo auditable` build the
#            linked-report journeys make; and the release's x86_64 Linux wheel,
#            which the wheel smoke and the release rehearsal both build.
#   windows  `test-windows`: clippy, the plain test binaries and the install.
#   macos    `test-macos`: clippy, the plain test binaries and the install.
#
# Needs what `just bootstrap` provisions, the browser view `just build` writes
# (the binary embeds it), and on Linux the MSRV toolchain and Docker.
#
# Usage:
#   ci-warm.sh linux|windows|macos [--plan]
#
# Exit 0: everything compiled (or, with --plan, was listed). Non-zero: a compile
# failed — main does not build, which is what this job exists to catch now that
# no push to main runs the tests — or the call was refused (2).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "ci-warm: cannot enter the repository root $ROOT" >&2
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
  echo "ci-warm: $source: $*"
  env "$@"
}

msrv="$(sed -n 's/^rust-version *= *"\([^"]*\)".*/\1/p' Cargo.toml)"
[ -n "$msrv" ] || {
  echo "ci-warm: Cargo.toml declares no rust-version" >&2
  exit 1
}
# `_crate-install-smoke`'s build directory: the shared `target` on Linux, one of
# its own elsewhere (the justfile says why).
install_build_dir="target/install-smoke/build"
[ "$os" != linux ] || install_build_dir="target"

compile "just _crate-lint" \
  cargo clippy --all-targets --locked --quiet -- -D warnings
compile "nx dag-ui-build-cache:lint" \
  cargo clippy --locked --quiet --test build-cache -- -D warnings
# Every tier's test binaries, uninstrumented: `--no-run` compiles every binary
# the default collection reaches, the union of the tiers' filters, so this one
# line is `_tier-test`'s every profile and the build-cache test's.
compile "just _tier-test" \
  cargo nextest run --locked --no-run
compile "just _crate-install-smoke" \
  cargo install --path . --locked --debug --quiet --root target/install-smoke \
  --target-dir target/install-smoke/target --config "build.build-dir=\"$install_build_dir\""

if [ "$os" = linux ]; then
  compile "just _crate-msrv" \
    RUSTFLAGS="-D warnings" cargo +"$msrv" check --locked --all-targets --quiet
  compile "just _crate-doc" \
    RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet
  compile "just _tier-test-covered" \
    cargo llvm-cov nextest --locked --no-report -E 'none()' --no-tests=pass
  compile "nx dag-ui:build-api-server" \
    cargo build --locked --quiet --bin onepipeline-api --target-dir target/dag-ui-api
  compile "test tests/e2e/linked_report.rs" \
    cargo auditable build --offline --locked --bin onepipeline-api --config 'build.build-dir="target"' --target-dir target/auditable
  # The wheel smoke builds into target/wheel-smoke and the release rehearsal into
  # its own --out; cargo's target directory is `target/wheel-<target>` for both.
  compile "just _crate-wheel-smoke" \
    just wheel-linux x86_64-unknown-linux-gnu target/wheel-smoke
fi

[ -n "$plan" ] || echo "ci-warm: $os: ok"
