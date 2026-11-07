#!/usr/bin/env bash
# Which tier of the gate a CI build of ci.yml owes: `affected` or `broader`.
#
# Releases here are batched: release-plz keeps one release pull request open and
# every merge to `main` adds to it, so the commit that ships is the head of that
# pull request, which no merge to `main` ever swept. That puts the broader tier —
# one full `just check` over every project — on the release pull request, and
# keeps every other build on the affected tier: an ordinary pull request against
# its merge base, and a push to `main` against the commit before the push. AGENTS.md
# ("Commits, releases, and merging") records the model; this is the one place a
# build is told which side of it it is on.
#
# The release pull request is the one release-plz opens, which it names
# `release-plz-<timestamp>` — release-plz.toml leaves `pr_branch_prefix` at that
# default, and `tests/e2e/ci_tier.rs` holds the two to each other.
#
# Reads what Actions sets on every build: GITHUB_EVENT_NAME, and GITHUB_HEAD_REF
# on a pull request. Prints one word on stdout.
#
# Refuses, with exit 2, an event ci.yml is not triggered by — a trigger added
# without deciding its tier here — and a run with no GITHUB_EVENT_NAME at all,
# which did not happen inside Actions. Either fails the `changes` job and with it
# `gate`, rather than letting a build nobody placed run a tier by default.
set -euo pipefail

# The prefix release-plz gives the branch of the release pull request it opens.
RELEASE_PR_PREFIX="release-plz-"

event="${GITHUB_EVENT_NAME:-}"
if [ -z "$event" ]; then
  echo "ci-tier: GITHUB_EVENT_NAME is not set, so this is not a GitHub Actions build" >&2
  echo "ACTION: run this from a workflow step, or set GITHUB_EVENT_NAME (and GITHUB_HEAD_REF on a pull_request) to ask about one" >&2
  exit 2
fi

case "$event" in
pull_request)
  case "${GITHUB_HEAD_REF:-}" in
  "$RELEASE_PR_PREFIX"*) printf 'broader\n' ;;
  *) printf 'affected\n' ;;
  esac
  ;;
push)
  printf 'affected\n'
  ;;
*)
  echo "ci-tier: '$event' is not an event ci.yml is triggered by, so no tier is decided for it" >&2
  echo "ACTION: add '$event' to scripts/ci-tier.sh with the tier its builds owe (AGENTS.md, \"Commits, releases, and merging\")" >&2
  exit 2
  ;;
esac
