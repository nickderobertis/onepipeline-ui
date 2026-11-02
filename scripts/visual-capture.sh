#!/usr/bin/env bash
# Photograph the DAG Observatory at every viewport in the matrix, reproducibly.
#
# This is the repository's one capture path. `just dag-ui-screens` runs it for an
# operator who wants to review and update the digest baseline, and
# `.github/workflows/visual-docs.yml`
# drives the same Playwright config inside the same image on the CI side. There is
# deliberately no second one: a gallery that came from anywhere else would be
# compared, by content hash, against a baseline this one wrote.
#
# Two halves, and the split is the point.
#
# The **host half** builds what is photographed — the workspace install, the Vite
# bundle, and the `onepipeline-api` binary the bundle is served by. None of that is
# rendering, all of it wants this machine's toolchains, and `apps/dag-ui-e2e/fixtures/
# serve-fixture.mjs` locates that binary rather than building it, so a build inside
# Playwright's readiness window is a timeout reported as a server that would not start.
#
# The **container half** is the rendering, and it is in a container because pixels are
# not portable: glyph rasterisation, the font stack and the browser build all decide
# bytes, and a hash gate over a capture taken against whatever Chromium a host happens
# to carry is a gate that fails on the machine rather than on the change. The image is
# pinned to this repository's own `@playwright/test`, derived below from the one
# manifest that declares it, and `.github/workflows/visual-docs.yml` names the same tag
# — `apps/dag-ui/src/test/visual-docs.test.ts` fails when the two part.
#
# Usage:
#   scripts/visual-capture.sh [--] [playwright args...]
#
# `SHOTS_OUT` names the directory the capture is written to, which is how manual review
# and CI point it at `shots/current/<arch>`; with none named, one is made per
# invocation so two operators — or two agents — capturing at the same time neither
# overwrite each other's images nor dirty the tree.
#
# `SHOTS_VERIFY`, when named, is a second destination for screencomp's reproducibility
# gate: the same build is photographed a second time, by a container of its own, into
# that directory. The two renders run side by side rather than one after the other,
# because a capture's time is almost all waiting — every shot waits for a second of
# quiet, three times over — and the two share nothing a render reads: each container
# has its own loopback, its own `/tmp` and so its own fixture workspace and ports, its
# own Playwright output directory, and its own browser. What they share is the build,
# which is made once, before either starts: a render may not build anything.
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# Physical, because every destination is held to it as it resolves on disk.
repo_root="$(CDPATH='' cd -P -- "$(dirname -- "$script_dir")" && pwd -P)"
cd "$repo_root"

# The browser image, derived rather than written down: the container has to carry the
# browser build the tests were written against, and a tag that drifted from the
# `@playwright/test` in the manifest means the capture either downloads a browser or
# cannot find one. `apps/dag-ui-e2e/package.json` is the single declaration, so bumping
# the dependency is the whole of bumping the image.
playwright_version="$(
  node -e 'process.stdout.write(require("./apps/dag-ui-e2e/package.json").devDependencies["@playwright/test"])'
)"
image="mcr.microsoft.com/playwright:v${playwright_version}-noble"

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64"; platform="linux/arm64" ;;
  x86_64 | amd64) arch="x86_64"; platform="linux/amd64" ;;
  *)
    echo "visual-capture: no capture lane for $(uname -m); add it to [capture].arches in screencomp.toml" >&2
    exit 1
    ;;
esac

# Where this capture lands. Inside the tree either way, because the tree is what the
# container has mounted — a destination outside it would need a mount of its own and a
# second thing to keep in step between here and CI. Absolute, because the spec is
# handed this path and a relative one would scatter images wherever the process
# happened to start — and then said again the way the container sees it, since the
# tree is mounted at /work and a host path means nothing inside it.
#
# Each named destination is held to the tree as it resolves on disk, and before
# anything is made: a refused destination leaves no directory behind, wherever it
# pointed. A path is read as written up to its deepest component that exists, that
# component is resolved physically — which is what catches a symlink out of the tree,
# or onto the other destination — and the components still to be made are appended.
# A `..` is refused outright rather than resolved, because after a symlink it climbs
# out of wherever the link went, not out of the path as it reads.

# refuse NAME NAMED WHY: exit 2 naming the destination and why it is not one.
refuse() {
  echo "visual-capture: $1 must name a directory inside $repo_root, not $2; $3" >&2
  echo "ACTION: set $1 to a directory under $repo_root, such as shots/local/<name>; the container mounts only the tree" >&2
  exit 2
}

# resolve NAME PATH: PATH, absolute and resolved on disk, on stdout; refuses one that
# climbs with `..` or resolves outside the tree. Makes nothing.
resolve() {
  local name="$1" named
  case "$2" in
    /*) named="$2" ;;
    *) named="$repo_root/$2" ;;
  esac
  case "/$named/" in
    */../*) refuse "$name" "$2" "it climbs with '..'" ;;
  esac
  local existing="$named" rest=""
  while [ ! -e "$existing" ] && [ ! -L "$existing" ]; do
    rest="/$(basename -- "$existing")$rest"
    existing="$(dirname -- "$existing")"
  done
  local physical
  if ! physical="$(CDPATH='' cd -P -- "$existing" 2>/dev/null && pwd -P)"; then
    echo "visual-capture: cannot create $name's directory $named: $existing is not a directory this capture can enter" >&2
    echo "ACTION: make $existing a directory the invoking user can enter so $named is creatable, or set $name to another directory under $repo_root" >&2
    exit 1
  fi
  local resolved="${physical%/}$rest"
  case "$resolved" in
    "$repo_root"/*) printf '%s' "$resolved" ;;
    *) refuse "$name" "$2" "it resolves to $resolved" ;;
  esac
}

# make_destination NAME DIR: create a resolved destination, or say why it could not be.
make_destination() {
  local why
  why="$(mkdir -p -- "$2" 2>&1)" && return 0
  echo "visual-capture: cannot create $1's directory $2: $why" >&2
  echo "ACTION: make the nearest existing directory above $2 writable by the invoking user so it is creatable, or set $1 to another directory under $repo_root" >&2
  exit 1
}

# inside A B: whether directory A is B or lies under it.
inside() {
  case "$1/" in "$2"/*) return 0 ;; esac
  return 1
}

if [ -n "${SHOTS_OUT:-}" ]; then
  shots_out="$(resolve SHOTS_OUT "$SHOTS_OUT")"
  minted=""
else
  mkdir -p shots/local
  shots_out="$(mktemp -d "$repo_root/shots/local/capture-XXXXXXXX")"
  # Remembered, so a run that captured nothing at all can take its own empty
  # directory away again rather than leaving a trail of them behind every failure.
  # Only ever the one this invocation minted: a destination the caller named is the
  # caller's, empty or not.
  minted="$shots_out"
fi
verify_out=""
if [ -n "${SHOTS_VERIFY:-}" ]; then
  # A second, independent capture for the reproducibility gate, so it may be neither
  # the first destination under another name nor a directory inside it, nor hold it.
  verify_out="$(resolve SHOTS_VERIFY "$SHOTS_VERIFY")"
  if [ "$verify_out" = "$shots_out" ]; then
    echo "visual-capture: SHOTS_VERIFY names the same directory as SHOTS_OUT ($shots_out); the gate compares two captures, so they need two" >&2
    echo "ACTION: set SHOTS_VERIFY to a directory other than SHOTS_OUT, such as shots/verify/$arch" >&2
    exit 2
  fi
  if inside "$verify_out" "$shots_out" || inside "$shots_out" "$verify_out"; then
    echo "visual-capture: SHOTS_VERIFY ($verify_out) and SHOTS_OUT ($shots_out) nest, so one capture would be written into the other's gallery" >&2
    echo "ACTION: set SHOTS_VERIFY to a directory beside SHOTS_OUT rather than in or above it, such as shots/verify/$arch" >&2
    exit 2
  fi
fi
[ -n "$minted" ] || make_destination SHOTS_OUT "$shots_out"
shots_in_container="/work/${shots_out#"$repo_root"/}"
if [ -n "$verify_out" ]; then
  make_destination SHOTS_VERIFY "$verify_out"
  verify_in_container="/work/${verify_out#"$repo_root"/}"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "visual-capture: Docker is unavailable, and the capture renders in $image" >&2
  echo "ACTION: start Docker and rerun; a capture taken against a host browser would not match the committed baseline" >&2
  exit 1
fi

# --- the host half: build what is photographed -------------------------------
# `dag-ui:build-api-server` depends on `dag-ui:build`, so this is the bundle and the
# binary that embeds it, and it is deliberately the narrowest target that produces
# both. The browser tier's own `test` target additionally provisions the sibling
# `onepipeline` CLI into `.tools/`, because the journeys that hold what this server
# serves to what that one prints cannot run without it — a capture never reads it, and
# building it here would be minutes of cargo per photograph.
bash "$script_dir/workspace-install.sh"
bash "$script_dir/nx.sh" run dag-ui:build-api-server

# --- the container half: render ----------------------------------------------
# Everything this run makes for itself lives in one scratch directory that is removed
# however the run ends — success, a failed capture, an interrupted shell. The
# container writes into the mounted tree as the invoking user rather than as root,
# which is not a tidiness preference: a bind-mounted tree written by a root container
# leaves a working directory its owner cannot clean without becoming root, and on a
# host that runs dispatches in worktrees that is a directory nobody can reclaim.
#
# Three things come with that user mapping, and none is optional:
#   * HOME is a directory under the scratch, because the mapped uid has no entry in
#     the image's passwd file and anything resolving `~` would otherwise write to `/`.
#   * nothing inside the tree is masked, and that is a choice rather than an omission.
#     The container installs nothing: it uses the workspace this host already
#     provisioned, which is sound because the image is pinned to the same
#     `@playwright/test` those modules are, so the browser it carries is the one they
#     expect. Were a mask ever needed it would have to be a host directory this script
#     created — an anonymous or named volume's top directory is Docker's, owned by
#     root, which is the defect this whole mapping exists to avoid.
#   * the container is recorded by id as it starts, so an interrupted run takes it
#     down with it instead of leaving it holding the tree.
scratch="$(mktemp -d)"
# shellcheck disable=SC2317,SC2329  # reached through the `trap`s below, which
# (shellcheck does not follow them); every line of this function is live on each.
cleanup() {
  local cid_file
  for cid_file in "$scratch"/*/container.id; do
    [ -s "$cid_file" ] || continue
    # By the id this invocation started and nothing else: several dispatches share
    # this host, and a container matched by name or image could be somebody's.
    docker rm --force "$(cat "$cid_file")" >/dev/null 2>&1 || true
  done
  rm -rf "$scratch"
}
# Asked to stop, the run takes its containers down and then stops with the status a
# signal's own death would give, rather than resuming where the signal found it. The
# renders are waited on rather than run in the foreground for the same reason: bash
# runs no trap until a foreground command returns, and a render returns only once its
# container is gone.
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

# render NAME DEST_IN_CONTAINER [docker args...] -- [playwright args...]: one capture,
# in one container, whose home and recorded id live under the scratch's NAME.
render() {
  local name="$1" dest="$2"
  shift 2
  local docker_args=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    docker_args+=("$1")
    shift
  done
  [ "$#" -gt 0 ] && shift
  mkdir -p "$scratch/$name/home"
  # `--ipc=host` and a 2 GiB /dev/shm keep Chromium from running out of shared memory
  # part way through a page, which it reports as a renderer crash. Neither changes a
  # byte of output; the flags that do are in `apps/dag-ui-e2e/screenshots.config.ts`.
  docker run --rm \
    --cidfile "$scratch/$name/container.id" \
    --platform "$platform" \
    --ipc=host --shm-size=2g \
    --user "$(id -u):$(id -g)" \
    --volume "$repo_root:/work" \
    --volume "$scratch/$name:/scratch" \
    "${docker_args[@]}" \
    --env HOME=/scratch/home \
    --env "SHOTS_OUT=$dest" \
    --workdir /work \
    "$image" \
    npx playwright test --config apps/dag-ui-e2e/screenshots.config.ts "$@"
}

verify_status=0
if [ -n "$verify_out" ]; then
  # The second render's Playwright output directory, which is the one path under the
  # tree both renders would otherwise write: the gallery's fixture workspace has a
  # fixed name, so does the output directory named after it, and Playwright empties
  # its output directory as a run starts. A host directory this script made is
  # mounted over the e2e package's `test-results/` for this container alone — made
  # here rather than left to Docker, which would create the mount point as root — so
  # a failed render's traces still land in the tree, under `test-results/verify/`.
  verify_results="$repo_root/apps/dag-ui-e2e/test-results/verify"
  if ! why="$(mkdir -p -- "$verify_results" 2>&1)"; then
    echo "visual-capture: cannot create the verify render's results directory $verify_results: $why" >&2
    echo "ACTION: make $repo_root/apps/dag-ui-e2e writable by the invoking user, or remove a root-owned test-results/ left by an earlier container, then rerun" >&2
    exit 1
  fi
  verify_log="$scratch/verify.log"
  render verify "$verify_in_container" \
    --volume "$verify_results:/work/apps/dag-ui-e2e/test-results" \
    -- "$@" >"$verify_log" 2>&1 &
  verify_pid=$!
fi

status=0
render current "$shots_in_container" -- "$@" &
current_pid=$!
wait "$current_pid" || status=$?

if [ -n "$verify_out" ]; then
  wait "$verify_pid" || verify_status=$?
  # After the first render's own output rather than through it, so each reads as one
  # run; prefixed, so a line is never mistaken for the other capture's.
  sed 's/^/[verify] /' "$verify_log"
  if [ "$verify_status" -ne 0 ]; then
    echo "visual-capture: the verify capture's playwright exited $verify_status; whatever it captured is in $verify_out" >&2
    echo "ACTION: read the failing surface in the [verify] output above and its trace under $verify_results, then rerun" >&2
  fi
fi

if [ "$status" -eq 0 ] && [ "$verify_status" -eq 0 ]; then
  echo "visual-capture: $arch capture in $shots_out${verify_out:+, verify capture in $verify_out}"
  exit 0
fi
if [ "$status" -eq 0 ]; then
  exit 1
fi
if [ -n "$minted" ] && [ -z "$(ls -A "$minted")" ]; then
  rmdir "$minted"
  echo "visual-capture: playwright exited $status without capturing anything; the surface it stopped on, or the server that would not start, is named in its output above" >&2
  exit 1
fi
# Named on the failing ending too, so a capture that died part way through still says
# where its partial images are, and which surface it stopped on is in the output above.
echo "visual-capture: playwright exited $status; whatever it captured is in $shots_out" >&2
exit 1
