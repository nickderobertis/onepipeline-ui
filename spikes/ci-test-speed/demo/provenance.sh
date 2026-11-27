#!/usr/bin/env bash
# provenance.sh <pr> <head sha> <GITHUB_SHA>: what a demonstration's run
# executed, from git alone. It fetches refs/pull/<pr>/merge (the commit the run
# checked out, GITHUB_SHA), checks that its tree is the head's (a head that
# descends from its base merges to its own tree), and prints the executed
# workflow file's blob.
set -euo pipefail
pr="${1:?pr}"; head="${2:?head sha}"; merge="${3:?GITHUB_SHA}"
git cat-file -e "$merge^{commit}" 2>/dev/null || git fetch -q origin "+refs/pull/$pr/merge:refs/spike/merge-$pr" 2>/dev/null || true
git cat-file -e "$head^{commit}" 2>/dev/null || git fetch -q origin "+refs/pull/$pr/head:refs/spike/head-$pr"
if git cat-file -e "$merge^{commit}" 2>/dev/null; then
  mt="$(git rev-parse "$merge^{tree}")"; ht="$(git rev-parse "$head^{tree}")"
  [ "$mt" = "$ht" ] && same="identical" || same="DIFFERENT"
  echo "PR #$pr: GITHUB_SHA $merge tree $mt; head $head tree $ht ($same); executed ci.yml blob $(git rev-parse "$merge:.github/workflows/ci.yml")"
else
  echo "PR #$pr: GITHUB_SHA $merge is no longer fetchable (closed PR's merge ref); head $head; head ci.yml blob $(git rev-parse "$head:.github/workflows/ci.yml")"
fi
