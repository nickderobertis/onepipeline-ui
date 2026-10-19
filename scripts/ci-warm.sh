#!/usr/bin/env bash
# Compile what one OS's pull-request CI compiles, and run nothing: the build
# `.github/workflows/ci-cache.yml` saves from `main` for ci.yml's four jobs to
# restore. `just ci-warm-linux`, `ci-warm-windows` and `ci-warm-macos` are this
# script.
#
# Pull requests restore that build and never save one (ci.yml), so the cache is
# only as warm as this list is complete: every compile a job's recipe makes
# (`scripts/ci-job.sh`) has its line here, under the profile, flags and target
# directory that recipe compiles with, because cargo reuses nothing built with a
# different one. A compile it leaves out is one each pull request pays for in
# full.
#
#   linux    `lint` and `test-linux`: clippy, the MSRV check and the docs with
#            warnings denied; the test binaries instrumented for coverage and
#            plain; the documented install (release profile, warnings denied);
#            the `cargo auditable` build the linked-report journeys make; and the
#            release's x86_64 Linux wheel.
#   windows  `test-windows`: clippy, the plain test binaries and the install.
#   macos    `test-macos`: clippy, the plain test binaries and the install.
#
# Needs what `just bootstrap` provisions, the browser view `just build` writes
# (the binary embeds it), and on Linux the MSRV toolchain and Docker.
#
# Usage:
#   ci-warm.sh linux|windows|macos
#
# Exit 0: everything compiled. Non-zero: a compile failed — main does not build,
# which is what this job exists to catch now that no push to main runs the tests
# — or the call was refused (2).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "ci-warm: cannot enter the repository root $ROOT" >&2
  exit 1
}

os="${1:-}"
case "$os" in
  linux | windows | macos) ;;
  *)
    echo "ci-warm: '${os}' is not an OS ci.yml tests on" >&2
    echo "ACTION: run 'scripts/ci-warm.sh linux|windows|macos'" >&2
    exit 2
    ;;
esac

step() {
  echo "ci-warm: $*"
}

# `lint`: `_crate-lint`, on every OS.
step "clippy, warnings denied"
cargo clippy --all-targets --locked --quiet -- -D warnings

# Every tier's test binaries, uninstrumented: `_tier-test`, which is the whole
# of the Windows and macOS suites and the baseline, cost, linked-report, CI-jobs
# and judged tiers on Linux. `--no-run` compiles every binary the default
# collection reaches, which is the union of the tiers' filters.
step "test binaries"
cargo nextest run --locked --no-run

# `install-smoke`: the documented install, release profile, warnings denied, into
# the root `_crate-install-smoke` installs into. The smoke test it runs after is
# a test, so it is left to the pull requests.
step "the documented install (release, warnings denied)"
RUSTFLAGS="-D warnings" cargo install --path . --locked --quiet --root target/install-smoke

if [ "$os" = linux ]; then
  # `lint`'s MSRV floor: `_crate-msrv`.
  msrv="$(sed -n 's/^rust-version *= *"\([^"]*\)".*/\1/p' Cargo.toml)"
  step "the MSRV check ($msrv)"
  RUSTFLAGS="-D warnings" cargo +"$msrv" check --locked --all-targets --quiet

  # `doc`: `_crate-doc`.
  step "docs, warnings denied"
  RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet

  # The instrumented tiers: `_tier-test-covered`, as `cargo llvm-cov nextest`
  # compiles them, into its own target directory. A filter no test matches
  # compiles every binary and runs none of them.
  step "test binaries, instrumented for coverage"
  cargo llvm-cov nextest --locked --no-report -E 'none()' --no-tests=pass

  # The linked-report journeys' `cargo auditable` build, into the target
  # directory `tests/e2e/linked_report.rs` builds into.
  step "the cargo auditable build"
  cargo auditable build --offline --locked --bin onepipeline-api --target-dir target/auditable

  # `wheel-smoke`: the release's x86_64 Linux wheel, through the one definition
  # the release builds with, into the directory `_crate-wheel-smoke` uses.
  step "the x86_64 Linux wheel"
  rm -rf target/wheel-smoke
  just wheel-linux x86_64-unknown-linux-gnu target/wheel-smoke
fi

step "$os: ok"
