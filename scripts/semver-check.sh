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
# Four things follow, and this script is all four:
#
#   * Fetch what each side's lockfile pins and resolve offline, so the comparison
#     is the tag's own dependencies rather than today's registry — and so no
#     third-party publish can decide the verdict.
#   * Run the check for its exit code before release-plz does. 100 is a verdict
#     (the surface broke, and release-plz raises the bump for it); 0 is a verdict;
#     anything else is a check that did not happen.
#   * Read what the pending release claims off the commits release-plz versions
#     it from — the ones touching the crate's *packaged* files, which is the only
#     thing release-plz sees — rather than off every commit in the range.
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
# A tag, not any revision: the workflow hands over one of `git tag --list 'v*'`,
# and a revision expression reaching some other commit would choose which commits
# the pending release is judged to be made of.
git rev-parse --verify --quiet "refs/tags/${baseline_ref}^{commit}" >/dev/null \
  || usage "$baseline_ref names no release tag here, so what the pending release claims cannot be read"

# The two arguments describe one release between them, and a pair that does not
# would read this tree's commits against a release that never produced the surface
# beside them — the reading and the claim it is judged by would be about different
# tags. So the checkout is asked what it is, with the ambient repository variables
# cleared: `-C` names a directory, and `GIT_DIR` would answer for whichever
# repository the environment names instead.
baseline_head="$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$baseline" rev-parse HEAD 2>/dev/null)" \
  || usage "$baseline is not a git checkout, so it cannot be shown to be the one $baseline_ref names"
[ "$baseline_head" = "$(git rev-parse "refs/tags/${baseline_ref}^{commit}")" ] \
  || usage "$baseline is a checkout of $baseline_head rather than of $baseline_ref"

# A tool this environment never installed says nothing about the baseline, so it
# is never read past: it fails whatever the pending release claims, rather than
# reaching the exit code below as one more reading that did not happen.
command -v cargo-semver-checks >/dev/null 2>&1 || {
  echo "::error::cargo-semver-checks is not on PATH, so no reading can be taken" >&2
  echo "ACTION: install it ('cargo install cargo-semver-checks --locked', or the pinned build .github/workflows/release-plz.yml provisions) and run 'just semver-check $baseline $baseline_ref' again" >&2
  exit 1
}

# This tree's own lockfile is this repository's problem whatever the release
# announces, so it fails outright — and both readings below need what it fetched.
if ! cargo fetch --locked --quiet; then
  echo "::error::this tree's locked dependencies could not be fetched" >&2
  echo "ACTION: run 'cargo fetch --locked' here and fix what it reports; nothing below can download anything itself" >&2
  exit 1
fi

# The files `cargo package` would upload — which is exactly the set release-plz
# diffs to decide a release is due, and so the only commits it versions from.
# Taken from cargo rather than by reading `[package] include` a second time here;
# `tests/packaging.rs` holds that set to what a published artifact carries.
packaged="$(cargo package --list --offline --locked --allow-dirty)" || {
  echo "::error::the files this crate packages could not be listed, so the commits release-plz versions from cannot be known" >&2
  echo "ACTION: run 'cargo package --list' here and fix what it reports; until it answers, no release can be read" >&2
  exit 1
}
# Read into the array a line at a time rather than with `mapfile`, which the bash
# a macOS runner puts first on PATH does not have.
packaged_paths=()
while IFS= read -r listed; do
  packaged_paths+=("$listed")
done <<<"$packaged"

unreadable_history() {
  echo "::error::the commits between $baseline_ref and HEAD could not be read, so what the pending release announces is unknown" >&2
  echo "ACTION: give this checkout the history the range needs ('git fetch --unshallow --tags', and a HEAD with a commit on it), then run 'just semver-check $baseline $baseline_ref' again" >&2
  exit 1
}

# Why the reading below need not be taken, or empty while it must be. Only the
# commits that touched a packaged file are read: release-plz sees no other, so a
# `!` on one that touches none authorizes no release and answers for none. With
# none of them at all there is no release being versioned to hold. Subjects and
# bodies are read apart so a body quoting a subject cannot answer for one.
#
# llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] release-plz publishes no parser to derive the grammar from, so it is Conventional Commits v1.0.0 read a second time — only ever to relax, and over exactly the commits release-plz itself versions from. Bounded both ways: reading fewer breaks leaves the release blocked exactly as it is without this, and reading more would need release-plz to stop honouring the specification.
range="refs/tags/${baseline_ref}..HEAD"
subjects="$(git log --format=%s "$range" -- "${packaged_paths[@]}")" || unreadable_history
bodies="$(git log --format=%b "$range" -- "${packaged_paths[@]}")" || unreadable_history
read_past=""
if [ -z "$subjects" ]; then
  read_past="no commit since $baseline_ref touched a packaged file, so release-plz versions no release here for a reading to hold"
elif grep -Eq '^[A-Za-z]+(\([^)]*\))?!:' <<<"$subjects" \
  || grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
  read_past="the packaged commits since $baseline_ref announce a break, so this release claims compatibility with nothing and the reading could only agree with a bump already taken"
fi
# llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]

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
  local what="$1" action="$2" evidence="${3:-}"
  if [ -n "$read_past" ]; then
    echo "::warning::$what — read past: $read_past. Nothing is required of this release; to take the reading anyway, $action" >&2
    exit 0
  fi
  [ -z "$evidence" ] || echo "$evidence" >&2
  echo "::error::$what" >&2
  echo "ACTION: $action" >&2
  exit 1
}

# The baseline's own, because the resolve below can reach neither side's. Held
# rather than printed as it happens: a run that reads past this one succeeds, and
# what cargo said about a baseline nothing is being released against is not that
# run's news. The failing run prints it, because there it is the whole of it.
if ! baseline_fetch="$(cargo fetch --locked --quiet --manifest-path "$baseline/Cargo.toml" 2>&1)"; then
  reading_not_taken \
    "the baseline at $baseline has dependencies that no longer resolve" \
    "run 'cargo fetch --locked' in that checkout and fix what it reports — until it resolves, that release has no surface to read" \
    "$baseline_fetch"
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
