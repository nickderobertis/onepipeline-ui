#!/usr/bin/env bash
# Write the manifest overlay the first-view-time spike's release build reads:
# `target/spike-release/Cargo.toml`, the root manifest with
#
#   [patch.crates-io]
#   onepipeline = { path = ".tools/onepipeline-spike" }
#
# and `target/spike-release/Cargo.lock`, the root lock resolved against it. The engine is
# a local clone of onepipeline at the tag the root lock pins (gitignored, untracked, with
# `engine.patch` committed on a local branch and pushing disabled):
#
#   git clone --depth 1 --branch v<version> https://github.com/nickderobertis/onepipeline.git .tools/onepipeline-spike
#   git -C .tools/onepipeline-spike checkout -b spike-first-view-time
#   patch -p1 -d .tools/onepipeline-spike < spikes/first-view-time/engine.patch   # then commit there
#
# The prototype release server is then built by the tier's own target:
#
#   WHEEL_MANIFEST_OVERLAY=target/spike-release WHEEL_FEATURES=spike-engine \
#     npx nx run dag-ui-read-latency:compile-release-server
#
# Nothing tracked changes: the root manifest and lock stay the landed tree's.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
engine=.tools/onepipeline-spike
[ -f "$engine/Cargo.toml" ] || { echo "no $engine: clone onepipeline there first (see this script's header)" >&2; exit 1; }
out=target/spike-release
mkdir -p "$out"
scratch=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$scratch/tree" >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
git worktree add --quiet --detach "$scratch/tree" HEAD
mkdir -p "$scratch/tree/.tools"
ln -s "$root/$engine" "$scratch/tree/$engine"
printf '\n[patch.crates-io]\nonepipeline = { path = "%s" }\n' "$engine" >> "$scratch/tree/Cargo.toml"
(cd "$scratch/tree" && CARGO_TARGET_DIR="$scratch/target" cargo metadata --format-version 1 --offline >/dev/null)
cp "$scratch/tree/Cargo.toml" "$scratch/tree/Cargo.lock" "$out/"
echo "wrote $out/Cargo.toml and $out/Cargo.lock (onepipeline from $engine at $(git -C "$engine" rev-parse --short HEAD))"
