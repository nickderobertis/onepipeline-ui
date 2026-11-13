#!/usr/bin/env bash
# One side of the historical A/B (manager ruling c-6fd773ced57b3f757fbef62b302c5e82):
#   ab-commit.sh <historical commit> <new branch> [<session head>]
# creates <new branch> at the session head plus one commit whose tree is the
# historical commit's whole tree, the spike's recorder, and the measurement-only
# patch (apply-measurement.mjs --ab). Both sides' `git diff <historical> <head>`
# are then the same bytes; ab-check.sh holds that.
set -euo pipefail
hist="${1:?historical commit}"
branch="${2:?branch name}"
session="${3:-HEAD}"
session="$(git rev-parse "$session")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch="$(mktemp -d)"
cp "$here/apply-measurement.mjs" "$patch/"
git switch -q -c "$branch" "$session"
git read-tree --reset -u "$hist"
git checkout "$session" -- spikes/ci-test-speed/recorder
node "$patch/apply-measurement.mjs" --ab --only-job test-linux
git add -A
git commit -q -m "test(spike): DO NOT MERGE — A/B side: the tree of ${hist:0:12} with measurement-only changes

The historical tree, the spike recorder and the measurement-only patch (no cache
writes or reads; lint, budgets, test-macos and test-windows off; a 60-minute Linux timeout).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1
