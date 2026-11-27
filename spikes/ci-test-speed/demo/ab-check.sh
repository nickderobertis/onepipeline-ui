#!/usr/bin/env bash
# ab-check.sh <hist A> <head A> <hist B> <head B>: prints each side's
# measurement-only diff digest and the executed workflow's blob, and fails
# unless the two diffs are byte-identical.
set -euo pipefail
a="$(git diff "$1" "$2" | git hash-object --stdin)"
b="$(git diff "$3" "$4" | git hash-object --stdin)"
echo "side A: diff $1..$2 = $a; ci.yml blob $(git rev-parse "$2:.github/workflows/ci.yml") (historical $(git rev-parse "$1:.github/workflows/ci.yml"))"
echo "side B: diff $3..$4 = $b; ci.yml blob $(git rev-parse "$4:.github/workflows/ci.yml") (historical $(git rev-parse "$3:.github/workflows/ci.yml"))"
git diff --stat "$1" "$2"
[ "$a" = "$b" ] || { echo "ab-check: the two sides' measurement-only diffs differ" >&2; exit 1; }
echo "ab-check: identical"
