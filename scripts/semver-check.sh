#!/usr/bin/env bash
# Read this crate's public surface against the previous release, and answer only
# when a reading actually happened.
#
# The failure this exists for: cargo-semver-checks builds both surfaces through a
# generated manifest of its own, which reads no `Cargo.lock` on either side. So a
# requirement the *released* manifest left open resolves to whatever the registry
# serves today — for v0.3.3 that is an `onepipeline` which no longer compiles at
# all — and the check dies building its baseline. release-plz reports exactly that
# as "✓ API compatible changes" and versions from the commit type instead, saying
# nothing. A release then ships a breaking change as a compatible one on the
# strength of a check nobody ran.
#
# Two things follow, and this script is both:
#
#   * Fetch what each side's lockfile pins and resolve offline, so the comparison
#     is the tag's own dependencies rather than today's registry — and so no
#     third-party publish can decide the verdict.
#   * Run the check for its exit code before release-plz does. 100 is a verdict
#     (the surface broke, and release-plz raises the bump for it); 0 is a verdict;
#     anything else is a check that did not happen, and fails the release rather
#     than passing as compatible.
#
# Usage: bash scripts/semver-check.sh <baseline-root>
#
# <baseline-root> is a checkout of the previous release — the workflow hands over
# the worktree it made of the tag. `cargo-semver-checks` must be on PATH.
set -euo pipefail

usage() {
  echo "semver-check: $1" >&2
  echo "usage: bash scripts/semver-check.sh <baseline-root>" >&2
  echo "  <baseline-root> is a checkout of the previous release, and the only argument" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage "expected exactly one argument, got $#"
baseline="$1"
[ -f "$baseline/Cargo.toml" ] || usage "$baseline has no Cargo.toml, so it is not a checkout"

# Both sides, because the resolve below can reach neither.
if ! cargo fetch --locked --quiet --manifest-path "$baseline/Cargo.toml"; then
  echo "::error::the baseline at $baseline has dependencies that no longer resolve" >&2
  echo "ACTION: run 'cargo fetch --locked' in that checkout and fix what it reports — until it resolves, that release has no surface to read" >&2
  exit 1
fi
if ! cargo fetch --locked --quiet; then
  echo "::error::this tree's locked dependencies could not be fetched" >&2
  echo "ACTION: run 'cargo fetch --locked' here and fix what it reports; the reading below can download nothing itself" >&2
  exit 1
fi

set +e
# llmlint: ignore[tool_output_is_signal] this report *is* the reading — on 100 it names every item that broke, on 0 it says how many checks ran — and the release is versioned from it, so a verdict whose evidence was swallowed is the thing this script exists to stop.
CARGO_NET_OFFLINE=true cargo semver-checks --baseline-root "$baseline" --color never
status=$?
set -e

case "$status" in
  0)
    echo "semver-check: the public surface is compatible with $baseline"
    ;;
  100)
    echo "semver-check: the public surface broke; release-plz raises the bump for it"
    ;;
  *)
    echo "::error::the reading exited $status without a verdict; the release would otherwise be versioned as API compatible with nothing read" >&2
    echo "ACTION: check that cargo-semver-checks is installed ('cargo install cargo-semver-checks --locked'), then read the failure above and take the reading again with 'just semver-check $baseline'. A baseline whose requirements no longer resolve to something that compiles is fixed by a new release carrying tighter ones, never by editing that tag" >&2
    exit 1
    ;;
esac
