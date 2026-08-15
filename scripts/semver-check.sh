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

baseline="${1:-}"
if [ -z "$baseline" ] || [ ! -f "$baseline/Cargo.toml" ]; then
  echo "usage: bash scripts/semver-check.sh <baseline-root>" >&2
  echo "  <baseline-root> is a checkout of the previous release; it has no Cargo.toml" >&2
  exit 2
fi

# Both sides, because the resolve below can reach neither.
cargo fetch --locked --manifest-path "$baseline/Cargo.toml"
cargo fetch --locked

set +e
CARGO_NET_OFFLINE=true cargo semver-checks --baseline-root "$baseline" --color never
status=$?
set -e

case "$status" in
  0)
    echo "semver-check: the public surface is unchanged against $baseline"
    ;;
  100)
    echo "semver-check: the public surface broke; release-plz raises the bump for it"
    ;;
  *)
    echo "::error::cargo-semver-checks exited $status without a verdict; the release would otherwise be versioned as API compatible with nothing read" >&2
    exit 1
    ;;
esac
