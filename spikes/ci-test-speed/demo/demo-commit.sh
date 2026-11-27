#!/usr/bin/env bash
# A control or treatment demonstration: demo-commit.sh <new branch> [<prototype>]
# creates <new branch> at the current HEAD (the session head) plus one commit:
# apply-measurement.mjs --touch-src and, for a treatment, prototype.mjs
# <prototype>. A treatment's tree differs from its control's by that prototype
# alone (`git diff <control> <treatment>`).
set -euo pipefail
branch="${1:?branch name}"
proto="${2:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git switch -q -c "$branch"
node "$here/apply-measurement.mjs" --touch-src
[ -z "$proto" ] || node "$here/prototype.mjs" "$proto"
git add -A
git commit -q -m "test(spike): DO NOT MERGE — ${proto:-control}: a src/ pull request's test jobs with the recorder

Measurement-only changes (apply-measurement.mjs --touch-src)${proto:+ and the prototype $proto (prototype.mjs)}.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1
