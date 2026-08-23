#!/usr/bin/env bash
# Fingerprint the llmlint judge configuration, for the judged tier's cache key.
#
# `just lint-llm-diff` resolves this before it runs the cached Nx target and
# exports the answer as `LLMLINT_JUDGE_FINGERPRINT`, which `nx.json` declares as
# one of that target's inputs. So a recorded verdict is invalidated by the two
# things no tracked file records: the *installed* llmlint version, and the
# resolved content of a plugin pinned in `llmlint.yml` but fetched from outside
# this repository. `llmlint config` prints the effective merged config — this
# repo's `llmlint.yml` plus every plugin's resolved rules — so one hash covers
# all of them.
#
# Both readings are taken under `scripts/llmlint-runtime-env.sh`, the same
# environment `scripts/llmlint-judge.sh` judges under, so the key describes the
# judge configuration the run would actually use rather than the caller's.
#
# Why the recipe resolves this instead of `nx.json` declaring it as a `runtime`
# input, which is how the pattern reached here: Nx scores a runtime input that
# exits non-zero as *no contribution* rather than as an error. A fingerprint that
# could not be produced would then drop the whole judge configuration out of the
# key and replay a verdict that configuration has moved on from — silently. Taken
# in the recipe, an unproducible fingerprint fails the tier instead, which is the
# louder half of the same guarantee.
#
# Absolute paths are folded out so two checkouts of the same repository share
# cache entries; the repository root is the only path-dependent thing in that
# output.
#
# Run it by hand to see the current judge fingerprint — the answer to "why did the
# tier re-judge when nothing in the tree changed?".
set -euo pipefail

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)" || {
  echo "llmlint-fingerprint: could not locate the repository from this script" >&2
  echo "ACTION: restore the checkout's directory layout and retry" >&2
  exit 1
}
# shellcheck source=scripts/llmlint-runtime-env.sh
. "$root/scripts/llmlint-runtime-env.sh" || {
  echo "llmlint-fingerprint: could not load the pinned runtime environment" >&2
  echo "ACTION: restore scripts/llmlint-runtime-env.sh and retry" >&2
  exit 1
}
llmlint_runtime_env

cd "$root" || {
  echo "llmlint-fingerprint: could not enter '$root'" >&2
  echo "ACTION: repair that directory's permissions and retry" >&2
  exit 1
}
version="$(llmlint --version)" || {
  echo "llmlint-fingerprint: 'llmlint --version' failed" >&2
  echo "ACTION: run 'just setup-llmlint' and retry" >&2
  exit 1
}
config="$(llmlint config)" || {
  echo "llmlint-fingerprint: 'llmlint config' failed" >&2
  echo "ACTION: repair llmlint.yml or its plugin pins and retry" >&2
  exit 1
}
digest="$(printf '%s\n%s\n' "$version" "${config//"$root"/\{root\}}" | sha256sum)" || {
  echo "llmlint-fingerprint: could not hash the judge configuration" >&2
  echo "ACTION: verify sha256sum is on PATH and retry" >&2
  exit 1
}
printf '%s\n' "${digest%% *}"
