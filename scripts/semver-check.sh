#!/usr/bin/env bash
# Read this crate's public surface against the previous release, and answer only
# when a reading actually happened — or when nothing is being claimed compatible.
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
# Three things follow, and this script is all three:
#
#   * Fetch what each side's lockfile pins and resolve offline, so the comparison
#     is the tag's own dependencies rather than today's registry — and so no
#     third-party publish can decide the verdict.
#   * Run the check for its exit code before release-plz does. 100 is a verdict
#     (the surface broke, and release-plz raises the bump for it); 0 is a verdict;
#     anything else is a check that did not happen.
#   * Fail on a check that did not happen *only while the pending release claims
#     compatibility*. See `reading_not_taken` below for why, and for the release
#     that stood still until it did.
#
# Usage: bash scripts/semver-check.sh <baseline-root> <baseline-ref>
#
# <baseline-root> is a checkout of the previous release — the workflow hands over
# the worktree it made of the tag — and <baseline-ref> is the tag it is a checkout
# of, which is what says which commits the pending release is made of.
# `cargo-semver-checks` must be on PATH.
set -euo pipefail

usage() {
  echo "semver-check: $1" >&2
  echo "usage: bash scripts/semver-check.sh <baseline-root> <baseline-ref>" >&2
  echo "  <baseline-root> is a checkout of the previous release, and <baseline-ref> the tag it is of" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage "expected exactly two arguments, got $#"
baseline="$1"
baseline_ref="$2"
[ -f "$baseline/Cargo.toml" ] || usage "$baseline has no Cargo.toml, so it is not a checkout"
git rev-parse --verify --quiet "${baseline_ref}^{commit}" >/dev/null \
  || usage "$baseline_ref names no commit here, so what the pending release claims cannot be read"

# The two arguments describe one release between them, and a pair that does not
# would read this tree's commits against a release that never produced the surface
# beside them — the reading and the claim it is judged by would be about different
# tags. So the checkout is asked what it is, with the ambient repository variables
# cleared: `-C` names a directory, and `GIT_DIR` would answer for whichever
# repository the environment names instead.
baseline_head="$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$baseline" rev-parse HEAD 2>/dev/null)" \
  || usage "$baseline is not a git checkout, so it cannot be shown to be the one $baseline_ref names"
[ "$baseline_head" = "$(git rev-parse "${baseline_ref}^{commit}")" ] \
  || usage "$baseline is a checkout of $baseline_head rather than of $baseline_ref"

# A tool this environment never installed says nothing about the baseline, so it
# is never read past: it fails whatever the pending release claims, rather than
# reaching the exit code below as one more reading that did not happen.
command -v cargo-semver-checks >/dev/null 2>&1 || {
  echo "::error::cargo-semver-checks is not on PATH, so no reading can be taken" >&2
  echo "ACTION: install it ('cargo install cargo-semver-checks --locked', or the pinned build .github/workflows/release-plz.yml provisions) and run 'just semver-check $baseline $baseline_ref' again" >&2
  exit 1
}

# What the pending release claims, read off the same conventional commits
# release-plz versions from: a `!` on the type, or a `BREAKING CHANGE:` footer, is
# a release that claims compatibility with nothing. Subjects and bodies are read
# apart so a body quoting a subject cannot answer for one.
#
# llmlint: ignore[contracts_have_one_source_or_a_drift_gate] release-plz exposes no parser to derive this from, and no dry run that reports the bump without first taking the very reading this decides whether to demand — so the grammar is Conventional Commits v1.0.0 read a second time, deliberately, and only ever to relax. Both disagreements are bounded: reading fewer breaks than release-plz leaves the release blocked exactly as it is without this, and reading more would need release-plz to stop treating `!` and `BREAKING CHANGE:` as breaking, which is the specification it and `release-plz.toml`'s documented mapping both name. The residue is a `!` on a commit touching no packaged file, which release-plz does not see: it relaxes a release whose own bump is smaller, and only while the baseline cannot be built at all.
subjects="$(git log --format=%s "${baseline_ref}..HEAD")"
bodies="$(git log --format=%b "${baseline_ref}..HEAD")"
if grep -Eq '^[A-Za-z]+(\([^)]*\))?!:' <<<"$subjects" \
  || grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
  claims_compatibility=no
else
  claims_compatibility=yes
fi

# What to do about a reading that was never taken — a baseline that will not
# fetch, or one cargo-semver-checks could not build a surface out of.
#
# The reading catches an *accidental* incompatibility: a surface that broke inside
# a release the commit types version as compatible. It therefore has something to
# protect exactly while a release claims compatibility. A breaking release claims
# none — cargo-semver-checks could only agree with a bump already taken, and a
# verdict it never returned changes no version — so refusing that release buys
# nothing and costs everything: v0.4.0's own `onepipeline` requires
# `oneagentgraph ^0.2.12`, 0.2.13 added a required field to a struct it builds, and
# the baseline has not compiled since. No requirement writable here reaches a
# dependency of a dependency of a published tag, and the tag is not ours to edit,
# so a breaking release sat unreleasable behind a reading that could never be
# taken again. That is the shape this branch exists for, and it is the *only* one
# it lets through.
reading_not_taken() {
  local what="$1" action="$2"
  if [ "$claims_compatibility" = no ]; then
    echo "::warning::$what — read past: the commits since $baseline_ref break the API, so this release claims compatibility with nothing and the reading could only agree with a bump already taken" >&2
    echo "ACTION: nothing is required of this release, which is versioned from its commits either way. To take the reading anyway: $action" >&2
    exit 0
  fi
  echo "::error::$what" >&2
  echo "ACTION: $action" >&2
  exit 1
}

# Both sides, because the resolve below can reach neither.
if ! cargo fetch --locked --quiet --manifest-path "$baseline/Cargo.toml"; then
  reading_not_taken \
    "the baseline at $baseline has dependencies that no longer resolve" \
    "run 'cargo fetch --locked' in that checkout and fix what it reports — until it resolves, that release has no surface to read"
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
    reading_not_taken \
      "the reading exited $status without a verdict; the release would otherwise be versioned as API compatible with nothing read" \
      "read the failure above, then take the reading again with 'just semver-check $baseline $baseline_ref'. A baseline whose *own* requirements no longer resolve to something that compiles is fixed by a new release carrying tighter ones; one whose transitive requirements drifted is reachable from no manifest here, and only a release that claims no compatibility — a breaking one — is let past it"
    ;;
esac
