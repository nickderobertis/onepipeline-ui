#!/usr/bin/env bash
# Photograph the DAG Observatory at every viewport in the matrix, reproducibly.
#
# This is the repository's one capture path. `just dag-ui-screens` runs it for an
# operator who wants to look at the app, `.githooks/pre-push` runs it to regenerate
# the digest baseline screencomp gates on, and `.github/workflows/visual-docs.yml`
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
# `SHOTS_OUT` names the directory the capture is written to, which is how the guard
# and CI point it at `shots/current/<arch>`; with none named, one is made per
# invocation so two operators — or two agents — capturing at the same time neither
# overwrite each other's images nor dirty the tree.
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
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
# second thing to keep in step between here and CI.
if [ -n "${SHOTS_OUT:-}" ]; then
  shots_out="$SHOTS_OUT"
  mkdir -p "$shots_out"
else
  mkdir -p shots/local
  shots_out="$(mktemp -d "$repo_root/shots/local/capture-XXXXXXXX")"
fi
# Absolute, because the spec is handed this path and a relative one would scatter
# images wherever the process happened to start — and then said again the way the
# container sees it, since the tree is mounted at /work and a host path means nothing
# inside it. The destination has to be under the tree for that reason: it is the one
# mount the capture writes through, and a directory outside it would need a second.
shots_out="$(CDPATH='' cd -- "$shots_out" && pwd)"
case "$shots_out" in
  "$repo_root"/*) shots_in_container="/work/${shots_out#"$repo_root"/}" ;;
  *)
    echo "visual-capture: SHOTS_OUT must name a directory inside $repo_root, not $shots_out" >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "visual-capture: Docker is unavailable, and the capture renders in $image" >&2
  echo "ACTION: start Docker and rerun; a capture taken against a host browser would not match the committed baseline" >&2
  exit 1
fi

# --- the host half: build what is photographed -------------------------------
# `dag-ui:build-api-server` depends on `dag-ui:build`, so this is the bundle and the
# binary that embeds it. Not `dag-ui-e2e:screens`, whose dependencies include the
# sibling `onepipeline` CLI: the journeys that compare the two need it and a capture
# never does, and provisioning it here would be minutes of build per photograph.
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
cid_file="$scratch/container.id"
# shellcheck disable=SC2317  # reached through the `trap` below, which shellcheck
# does not follow; every line of this function is live on each of those exits.
cleanup() {
  if [ -s "$cid_file" ]; then
    # By the id this invocation started and nothing else: several dispatches share
    # this host, and a container matched by name or image could be somebody's.
    docker rm --force "$(cat "$cid_file")" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM
mkdir -p "$scratch/home"

status=0
# `--ipc=host` and a 2 GiB /dev/shm keep Chromium from running out of shared memory
# part way through a page, which it reports as a renderer crash. Neither changes a
# byte of output; the flags that do are in `apps/dag-ui-e2e/screenshots.config.ts`.
docker run --rm \
  --cidfile "$cid_file" \
  --platform "$platform" \
  --ipc=host --shm-size=2g \
  --user "$(id -u):$(id -g)" \
  --volume "$repo_root:/work" \
  --volume "$scratch:/scratch" \
  --env HOME=/scratch/home \
  --env "SHOTS_OUT=$shots_in_container" \
  --workdir /work \
  "$image" \
  npx playwright test --config apps/dag-ui-e2e/screenshots.config.ts "$@" || status=$?

if [ "$status" -eq 0 ]; then
  echo "visual-capture: $arch capture in $shots_out"
  exit 0
fi
# Named on the failing ending too, so a capture that died part way through still says
# where its partial images are and which surface it stopped on is in the output above.
echo "visual-capture: playwright exited $status; whatever it captured is in $shots_out" >&2
exit 1
