#!/usr/bin/env bash
# Decide whether a release actually reached the registries, and make the GitHub
# Release say so.
#
# The failure this exists for: a red `test` job in release.yml *skips* the ten
# publish and verify jobs rather than failing them, so the run goes red in a
# corner of the Actions tab while the tag and the GitHub Release stay exactly as
# a successful release leaves them — assets attached, marked Latest. v0.2.0 and
# v0.3.0 both ended that way, and only querying npm and PyPI directly showed
# that neither had shipped. release-plz then reads the tag as proof the version
# released and never retries it.
#
# So the last job of every release runs this. It reads the result of every job
# that had to succeed for the tag to mean "published", and:
#
#   * if they all did — leaves the Release alone, unless a previous attempt had
#     demoted it, in which case it restores it;
#   * if any did not — marks the Release a prerelease and prepends a banner
#     naming the jobs, then exits non-zero.
#
# A prerelease is what `/releases/latest` and the Latest badge skip, so after
# this neither a person nor an agent reading the Release can mistake it for a
# version that shipped. The tag is left alone: tags here are immutable (see
# AGENTS.md), and the recovery is a new patch version, which the banner says.
#
# Whether a publish job *had* to succeed is the operator's choice, so the
# expectation is passed in rather than assumed: the crates.io publish
# self-activates on a secret, and PyPI and npm publishing are switched by
# repository variables. A job that is switched off is not required; a job that is
# switched on and did not succeed is a failed release.
#
# Input comes from the environment, because that is how a workflow hands over
# `needs.*.result` without interpolating it into a shell command:
#
#   RELEASE_TAG   the tag of the Release to hold, e.g. v0.3.1
#   JOB_RESULTS   whitespace-separated `job=result` pairs, one per job
#   EXPECT_CRATE  'true' when publish-crate had to run
#   EXPECT_PYPI   'true' when publish-pypi and verify-pypi had to run
#   EXPECT_NPM    'true' when publish-npm and verify-npm had to run
#
# The three switches take 'true', 'false' or nothing; anything else is a usage
# error rather than an "off".
#
# `gh` must be on PATH and authenticated for the repository (GH_TOKEN).
set -euo pipefail

usage="set RELEASE_TAG and JOB_RESULTS (and the EXPECT_* switches), then run 'release-status.sh'"

fail_usage() {
  echo "$1" >&2
  echo "ACTION: $usage" >&2
  exit 2
}

fail() {
  echo "::error::$1" >&2
  echo "ACTION: $2" >&2
  exit 1
}

RELEASE_TAG="${RELEASE_TAG:-}"
JOB_RESULTS="${JOB_RESULTS:-}"
EXPECT_CRATE="${EXPECT_CRATE:-}"
EXPECT_PYPI="${EXPECT_PYPI:-}"
EXPECT_NPM="${EXPECT_NPM:-}"

[ -n "$RELEASE_TAG" ] || fail_usage "RELEASE_TAG is required"
[ -n "$JOB_RESULTS" ] || fail_usage "JOB_RESULTS is required"

# Whether a switch is on. Anything that is neither `true`, `false` nor unset is a
# usage error rather than a `false`: these decide which publish jobs a release was
# waiting for, so a misspelled repository variable read as "off" would quietly
# leave this gate asking nothing of the registry the operator meant to publish to
# — the exact silence the whole script exists to end.
switched_on() {
  case "$2" in
    true) return 0 ;;
    false | "") return 1 ;;
    *) fail_usage "$1 must be 'true', 'false' or unset, not '$2'" ;;
  esac
}

# The banner's own delimiters. The opening one is what makes this idempotent
# across re-runs, and it carries the one fact demoting destroys: whether the
# Release was already a prerelease. Restoring an `-rc` tag to Latest would be
# its own wrong state.
BANNER_OPEN="<!-- release-status: publish-failed"
BANNER_CLOSE="<!-- release-status: end -->"

# The jobs a release cannot be called published without. `upload` and
# `verify-assets` are here because the GitHub Release's own assets are a
# distribution too; `build-wheels` and `build-npm` because they run
# unconditionally by design, so a packaging break reddens a release even where
# publishing is switched off.
required="test upload verify-assets build-wheels build-npm"
if switched_on EXPECT_CRATE "$EXPECT_CRATE"; then
  required="$required publish-crate"
fi
if switched_on EXPECT_PYPI "$EXPECT_PYPI"; then
  required="$required publish-pypi verify-pypi"
fi
if switched_on EXPECT_NPM "$EXPECT_NPM"; then
  required="$required publish-npm verify-npm"
fi

# No associative arrays: the suite runs this on macOS, whose bash is 3.2.
result_of() {
  local pair
  for pair in $JOB_RESULTS; do
    case "$pair" in
      "$1="*)
        printf '%s' "${pair#*=}"
        return 0
        ;;
    esac
  done
  return 1
}

# A job with no entry at all is as much a hole as a failed one: it means the
# workflow grew a job this gate was never told about.
stranded=""
for job in $required; do
  if ! result="$(result_of "$job")" || [ -z "$result" ]; then
    result="not reported"
  fi
  if [ "$result" != "success" ]; then
    stranded="${stranded}${stranded:+, }${job} (${result})"
  fi
done

# `gh release view` is also the check that the Release exists at all. Two calls
# rather than a JSON dependency: the body is the only multi-line field, so it is
# read on its own through gh's own `--jq`.
if ! flags="$(gh release view "$RELEASE_TAG" --json isPrerelease 2>&1)"; then
  fail "cannot read the GitHub Release for $RELEASE_TAG: $flags" \
    "check that the tag has a Release and that GH_TOKEN can read it"
fi
# Unlike the call above, this one's output becomes the notes the Release is
# rewritten with, so gh's stderr is left on the job log rather than folded into
# it — a warning captured here would be published as part of the changelog.
if ! body="$(gh release view "$RELEASE_TAG" --json body --jq .body)"; then
  fail "cannot read the notes of the GitHub Release for $RELEASE_TAG (gh's own error is above)" \
    "check that GH_TOKEN can read this repository's releases"
fi

# A shape this does not recognise is rejected rather than read as `false`: this
# flag is the one thing a demotion destroys, so a `false` invented here would
# promote a deliberate `-rc` to Latest the next time the release recovers.
# Whitespace is dropped first, so a pretty-printed answer is still an answer.
case "${flags// /}" in
  *'"isPrerelease":true'*) was_prerelease=true ;;
  *'"isPrerelease":false'*) was_prerelease=false ;;
  *)
    fail "the GitHub Release for $RELEASE_TAG answered with no isPrerelease flag: $flags" \
      "check that gh is authenticated and current enough to serve 'release view --json isPrerelease'"
    ;;
esac
case "$body" in
  *"$BANNER_OPEN"*) demoted=true ;;
  *) demoted=false ;;
esac

# Drop the banner and the blank line that separates it from the notes, leaving
# the changelog release-plz wrote exactly as it was.
strip_banner() {
  printf '%s\n' "$body" | awk -v opener="$BANNER_OPEN" -v closer="$BANNER_CLOSE" '
    skipping && index($0, closer) == 1 { skipping = 0; eating = 1; next }
    skipping { next }
    index($0, opener) == 1 { skipping = 1; next }
    eating { eating = 0; if ($0 == "" || $0 == "\r") next }
    { print }
  '
}

edit_release() {
  local out
  if ! out="$(gh release edit "$RELEASE_TAG" "$@" 2>&1)"; then
    fail "cannot edit the GitHub Release for $RELEASE_TAG: $out" \
      "check that GH_TOKEN has contents:write on this repository"
  fi
}

# The scratch file the notes below are assembled in, removed however this exits —
# including the `fail` paths, which is why a trap rather than an `rm` after each
# use.
notes=""
trap '[ -z "$notes" ] || rm -f "$notes"' EXIT

# Assigns rather than prints: a `fail` inside a command substitution would exit
# only the subshell it ran in.
open_notes() {
  if ! notes="$(mktemp)"; then
    fail "cannot create a temporary file to assemble $RELEASE_TAG's notes in" \
      "check that the runner's TMPDIR exists and is writable"
  fi
}

wrote_notes_or_fail() {
  fail "cannot write $RELEASE_TAG's notes to $notes" \
    "check that the runner's TMPDIR has space and is writable"
}

if [ -z "$stranded" ]; then
  if [ "$demoted" = false ]; then
    echo "release-status: $RELEASE_TAG published — every required job succeeded."
    exit 0
  fi
  # A re-run finished what an earlier attempt left stranded, so the Release stops
  # saying it did not. It goes back to what it was before that demotion.
  open_notes
  strip_banner >"$notes" || wrote_notes_or_fail
  case "$body" in
    *"was-prerelease=true"*) edit_release --prerelease --notes-file "$notes" ;;
    *) edit_release --prerelease=false --latest --notes-file "$notes" ;;
  esac
  echo "release-status: $RELEASE_TAG published on a later attempt — the Release is a release again."
  exit 0
fi

if [ "$demoted" = false ]; then
  open_notes
  {
    echo "$BANNER_OPEN was-prerelease=$was_prerelease -->"
    echo "> [!CAUTION]"
    echo "> **This release did not publish.** These jobs did not succeed:"
    echo "> $stranded."
    echo ">"
    echo "> The tag and whatever assets are attached are all that exists of"
    echo "> \`$RELEASE_TAG\` — the registries do not serve it. Tags here are"
    echo "> immutable, so the recovery is to fix the failure and let release-plz"
    echo "> cut the next patch version."
    echo "$BANNER_CLOSE"
    echo ""
    printf '%s\n' "$body"
  } >"$notes" || wrote_notes_or_fail
  edit_release --prerelease --notes-file "$notes"
fi

fail "$RELEASE_TAG did not publish — $stranded" \
  "the Release is now a prerelease, so nothing reads it as shipped; fix the failure above and let release-plz cut the next patch version"
