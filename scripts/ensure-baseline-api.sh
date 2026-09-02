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
cd "$root" || {
  echo "ensure-baseline: located the repository at '$root' but could not enter it" >&2
  echo "ACTION: check the checkout's permissions on that directory and retry" >&2
  exit 1
}

# Where to provision to. It arrives from the environment and this script then
# *deletes and writes* at it, so it is checked to the one place this repository
# provisions rather than trusted: a caller that could name any path could have
# this script remove a file of its own choosing, and the recipe exports exactly
# one value. Compared as a whole path rather than by prefix — a prefix test
# admits `.tools/bin/../../something` — and the name is the one the justfile
# derives from the platform, read back rather than restated.
binary="${ONEPIPELINE_UI_BASELINE_BIN:-}"
[ -n "$binary" ] || {
  echo "ensure-baseline: ONEPIPELINE_UI_BASELINE_BIN is unset" >&2
  echo "ACTION: run 'just _ensure-baseline' rather than this script directly" >&2
  exit 2
}
provisioned="$root/.tools/bin/onepipeline-api-baseline"
case "$binary" in
  "$provisioned" | "$provisioned.exe") : ;;
  *)
    echo "ensure-baseline: ONEPIPELINE_UI_BASELINE_BIN is '$binary', which is not this clone's provisioning path" >&2
    echo "ACTION: run 'just _ensure-baseline', which exports the one path this script writes" >&2
    exit 2
    ;;
esac
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
# Written out and then extracted, rather than piped, so each half reports its
# own failure: reading the commit out of this repository and writing its tree to
# disk fail for unrelated reasons and are fixed by unrelated actions, and a pipe
# reports whichever one it was as the same sentence.
archive="$work/baseline-tree.tar"
git archive --format=tar --output="$archive" "$base" || {
  echo "ensure-baseline: could not read the tree at $base out of this repository" >&2
  echo "ACTION: fetch that commit ('git fetch origin main') and retry" >&2
  exit 1
}
tar -xf "$archive" -C "$work" || {
  echo "ensure-baseline: read the tree at $base but could not write it into $work" >&2
  echo "ACTION: free space on the filesystem holding \$TMPDIR ($(df -Ph "$work" | awk 'NR==2 {print $4}') free), check it is writable, and retry" >&2
  exit 1
}
rm -f "$archive"

# The base commit's own lockfile decides its dependency graph, and this process's
# environment must not reach in and redirect where it is built.
# `--quiet` for the reason every other recipe here is quiet on success: what this
# provisioning has to say is that it could not do it. Cargo's own diagnostics
# still reach stderr when the build fails, which is the case the guard below
# names an action for.
(
  unset CARGO_TARGET_DIR
  cargo build --locked --quiet --bin onepipeline-api \
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

# The stamp goes last and the old one goes first, so an interrupted install
# leaves a binary with no stamp — which reads as "not provisioned" and is built
# again — rather than a stale server a stamp vouches for. Each step says what to
# do about it: `set -e` would end the script here with the shell's own message,
# and a provisioning that stopped without saying why is one an operator has to
# reconstruct from an empty `.tools/`.
mkdir -p "$(dirname -- "$binary")" && rm -f "$binary" "$stamp" || {
  echo "ensure-baseline: could not clear $(dirname -- "$binary") to provision into" >&2
  echo "ACTION: check the directory is writable — a container run as root can leave it unwritable — and retry" >&2
  exit 1
}
cp "$built" "$binary" || {
  echo "ensure-baseline: could not install the server built at $base" >&2
  echo "ACTION: free disk space, check $(dirname -- "$binary") is writable, and retry" >&2
  exit 1
}
printf '%s\n' "$base" >"$stamp" || {
  echo "ensure-baseline: could not stamp the provisioned server with $base" >&2
  echo "ACTION: check $(dirname -- "$binary") is writable and retry; the unstamped binary is rebuilt rather than used" >&2
  exit 1
}
