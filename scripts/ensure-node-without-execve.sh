#!/usr/bin/env bash
# Provision a real Node release that has no `process.execve`, into the tree — the
# `_ensure-node-without-execve` recipe's body.
#
# The npm launcher replaces itself with the read API binary through
# `process.execve`, and on a node without it refuses before anything starts
# (`npm/onepipeline-api-cli/bin/onepipeline-api.js`). That refusal is a journey
# in `tests/e2e/packaging.rs`, and it runs under the node a user on an old release
# would have rather than one with the API taken away. Node 22.14.0 is the last
# release of the 22 line before `process.execve` arrived in 22.15.0.
#
# The archive is held to the digest pinned below, copied from that release's
# SHASUMS256.txt, so what unpacks is that release; the refusal journey then holds
# the node it runs to having no `process.execve`, since one that has the API
# would make it a journey that cannot fail. The install is stamped with the
# archive's digest, and one whose stamp, version or API is anything else is
# replaced. The verified archive is kept beside the install, so a replacement
# unpacks it again rather than fetching it. Nothing already installed is removed
# until its replacement has passed its digest.
#
# Windows provisions nothing: the launcher has no exec there, so the refusal
# journey is Unix-only and nothing on that platform runs this node.
#
# Usage:
#   ensure-node-without-execve.sh HOST
#
# HOST is `<os>-<arch>` as just's `os()` and `arch()` report it, which the recipe
# passes.
#
# Reads ONEPIPELINE_UI_NODE_WITHOUT_EXECVE, the node binary's path as the justfile
# exports it, and ONEPIPELINE_UI_NODE_DIST, where the releases are: an https base
# URL (the default is nodejs.org/dist) or a local directory laid out the same way,
# `<dir>/v<VERSION>/<asset>`, for a mirror or a machine without the network.
#
# Exit 0: the pinned node is at that path (or this is Windows). Exit 1: it could
# not be provisioned, named on stderr with what to do. Exit 2: the call was
# malformed.
set -euo pipefail

version="22.14.0"

fail() {
  echo "ensure-node-without-execve: $1" >&2
  echo "ACTION: $2" >&2
  exit 1
}

host="${1:-}"
node_bin="${ONEPIPELINE_UI_NODE_WITHOUT_EXECVE:-}"
if [ $# -ne 1 ] || [ -z "$host" ] || [ -z "$node_bin" ]; then
  echo "ensure-node-without-execve: needs exactly the host, as <os>-<arch>, and ONEPIPELINE_UI_NODE_WITHOUT_EXECVE" >&2
  echo "ACTION: run 'just _ensure-node-without-execve', which passes both" >&2
  exit 2
fi
# The install directory is replaced whole, so it must be one only this script
# writes: a path such as /usr/bin/node would otherwise name /usr.
if [ "$(basename -- "$(dirname -- "$node_bin")")" != "bin" ] || [ "$(basename -- "$node_bin")" != "node" ] ||
  [ "$(basename -- "$(dirname -- "$(dirname -- "$node_bin")")")" != "node-without-execve" ]; then
  echo "ensure-node-without-execve: ONEPIPELINE_UI_NODE_WITHOUT_EXECVE must name <dir>/node-without-execve/bin/node, not $node_bin" >&2
  echo "ACTION: run 'just _ensure-node-without-execve', which exports the path this script installs to" >&2
  exit 2
fi

# The host as just's `os()` and `arch()` name it, mapped to the archive
# nodejs.org publishes for it and that archive's digest from
# https://nodejs.org/dist/v22.14.0/SHASUMS256.txt.
case "$host" in
  windows-*)
    echo "ensure-node-without-execve: nothing to provision on Windows, where the launcher has no exec to refuse" >&2
    exit 0
    ;;
  linux-x86_64) platform="linux-x64" expected="9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2" ;;
  linux-aarch64) platform="linux-arm64" expected="8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0" ;;
  macos-aarch64) platform="darwin-arm64" expected="e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42" ;;
  macos-x86_64) platform="darwin-x64" expected="6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250" ;;
  *) fail "no pinned Node $version for $host" \
    "run the npm launcher journeys on Linux or macOS (x86_64 or aarch64), or on Windows, or add this host's digest from Node $version's SHASUMS256.txt here" ;;
esac

name="node-v$version-$platform"
asset="$name.tar.gz"
home="$(dirname -- "$(dirname -- "$node_bin")")"
parent="$(dirname -- "$home")"
stamp="$home.source"
kept="$home.tar.gz"

# GNU's tool where it runs, else the one macOS ships.
sha256_of() {
  local sum gnu
  if ! sum="$(sha256sum "$1" 2>&1)"; then
    gnu="$sum"
    sum="$(shasum -a 256 "$1" 2>&1)" ||
      fail "neither sha256sum nor shasum could hash $1 (sha256sum: $gnu; shasum: $sum)" \
        "if either says $1 is unreadable, free disk space and retry; otherwise install coreutils (sha256sum) or perl's shasum, then retry"
  fi
  printf '%s' "${sum%% *}"
}

# What a node without the API reports, and what one with it cannot.
lacks_execve() {
  [ "$("$1" --version 2>/dev/null)" = "v$version" ] &&
    [ "$("$1" -p 'typeof process.execve' 2>/dev/null)" = "undefined" ]
}

if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$expected" ] && [ -f "$kept" ] &&
  lacks_execve "$node_bin"; then
  exit 0
fi

work="$(mkdir -p "$parent" 2>&1 && mktemp -d "$parent/.node-without-execve.XXXXXX" 2>&1)" ||
  fail "could not create a working directory in $parent ($work)" \
    "make $parent writable (or free disk space there), then retry"
trap 'rm -rf "$work"' EXIT

digest=""
if [ -f "$kept" ]; then
  digest="$(sha256_of "$kept")" || exit 1
fi
if [ -n "$digest" ] && [ "$digest" = "$expected" ]; then
  archive="$kept"
else
  archive="$work/$asset"
  dist="${ONEPIPELINE_UI_NODE_DIST:-https://nodejs.org/dist}"
  if [[ "$dist" == https://* ]]; then
    fetched="$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --retry 3 --output "$archive" "$dist/v$version/$asset" 2>&1)" ||
      fail "could not download $dist/v$version/$asset ($fetched)" \
        "check the network reaches $dist, or set ONEPIPELINE_UI_NODE_DIST to a directory holding v$version/$asset, then retry"
  elif [ -d "$dist" ]; then
    copied="$(cp "$dist/v$version/$asset" "$archive" 2>&1)" ||
      fail "could not copy v$version/$asset from the mirror at $dist ($copied)" \
        "put Node $version's $asset at $dist/v$version/ and make it readable, or unset ONEPIPELINE_UI_NODE_DIST to fetch it from nodejs.org"
  else
    echo "ensure-node-without-execve: ONEPIPELINE_UI_NODE_DIST is neither an https URL nor a directory: $dist" >&2
    echo "ACTION: set it to an https base URL or a local mirror directory, or unset it" >&2
    exit 2
  fi
  digest="$(sha256_of "$archive")" || exit 1
  [ "$digest" = "$expected" ] ||
    fail "$asset has digest $digest, not the $expected Node $version publishes" \
      "the download is not Node $version's release; check what serves it, then retry — never update the pin to match"
fi

installed="$(
  {
    tar -xzf "$archive" -C "$work" &&
      rm -rf "$home" "$stamp" &&
      mv "$work/$name" "$home" &&
      { [ "$archive" = "$kept" ] || mv "$archive" "$kept"; } &&
      printf '%s\n' "$expected" >"$stamp"
  } 2>&1
)" ||
  fail "could not install the verified archive at $home ($installed)" \
    "make $parent and everything under $home writable (or free disk space there), then retry"
