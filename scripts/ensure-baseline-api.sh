#!/usr/bin/env bash
# Provision the server this branch forked from, for the journeys that compare
# what this build serves against what that one served.
#
# The comparison itself is cheap — two servers over one runs root — and the
# expensive part is compiling another commit's whole dependency graph. So the
# build lives here, behind the `onepipeline-ui:ensure-baseline` Nx target, rather
# than inside the suite: a change to a workflow, a script or a document must not
# make the root project's tests recompile a second server.
#
# Idempotent, on `_ensure-sibling`'s terms: the binary is stamped with the commit
# it was built from, and a stamp that still names this branch's base is a build
# already done. A base that moved sweeps the old binary rather than leaving a
# server nothing will ask for again sitting in the tree.
set -euo pipefail

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)" || {
  echo "ensure-baseline: could not locate the repository from this script" >&2
  echo "ACTION: restore the checkout's directory layout and retry" >&2
  exit 1
}
cd "$root"

binary="${ONEPIPELINE_UI_BASELINE_BIN:-}"
[ -n "$binary" ] || {
  echo "ensure-baseline: ONEPIPELINE_UI_BASELINE_BIN is unset" >&2
  echo "ACTION: run 'just _ensure-baseline' rather than this script directly" >&2
  exit 2
}
stamp="$binary.commit"

# The commit this branch forked from. `origin/main` first and `main` after it: a
# clone the harness cut has the remote ref and a working checkout has both, and a
# merge base against either is the same commit. Refused rather than guessed — a
# baseline resolved to the wrong commit compares this build against something
# that is not what it replaced, and says nothing while looking like it did.
base=""
for reference in origin/main main; do
  base="$(git rev-parse --verify --quiet "$reference^{commit}" >/dev/null 2>&1 && git merge-base HEAD "$reference" 2>/dev/null || true)"
  [ -z "$base" ] || break
done
[ -n "$base" ] || {
  echo "ensure-baseline: this checkout resolves neither 'origin/main' nor 'main'" >&2
  echo "ACTION: fetch the default branch so the base commit of this branch is known" >&2
  exit 2
}

if [ -x "$binary" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$base" ]; then
  exit 0
fi

work="$(mktemp -d)" || {
  echo "ensure-baseline: could not open temporary storage for the baseline tree" >&2
  echo "ACTION: free disk space and retry" >&2
  exit 1
}
trap 'rm -rf "$work"' EXIT

# `git archive` rather than a worktree: a worktree writes administrative state
# into the `.git` directory every other checkout of this repository shares, and
# an interrupted run would leave a registration behind for somebody else to trip
# over. A plain tree needs no cleanup but its own.
git archive --format=tar "$base" | tar -x -C "$work" || {
  echo "ensure-baseline: could not lay out the tree at $base" >&2
  echo "ACTION: fetch that commit and retry" >&2
  exit 1
}

# The base commit's own lockfile decides its dependency graph, and this process's
# environment must not reach in and redirect where it is built.
(
  unset CARGO_TARGET_DIR
  cargo build --locked --bin onepipeline-api \
    --manifest-path "$work/Cargo.toml" --target-dir "$work/target"
) || {
  echo "ensure-baseline: could not build the server at $base" >&2
  echo "ACTION: check that commit builds under this toolchain, then retry" >&2
  exit 1
}

# The extension the platform gave the file, taken off the destination rather than
# spelled a second time: the justfile decides it once, and a literal here would
# drift into a copy that silently matches nothing on the platform it is wrong for.
case "$binary" in
  *.exe) built="$work/target/debug/onepipeline-api.exe" ;;
  *) built="$work/target/debug/onepipeline-api" ;;
esac

mkdir -p "$(dirname -- "$binary")"
# The stamp goes last and the old one goes first, so an interrupted copy leaves a
# binary with no stamp — which reads as "not provisioned" and is rebuilt — rather
# than a stale binary a stamp vouches for.
rm -f "$binary" "$stamp"
cp "$built" "$binary"
printf '%s\n' "$base" >"$stamp"
