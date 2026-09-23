#!/usr/bin/env bash
# Point this clone's git hooks at the committed `.githooks/`.
#
# `core.hooksPath` is per-clone configuration and git has no way to commit it, so a
# committed hook that nothing activates is a hook that runs nothing — which for a
# strict visual gate is the worst of both worlds: the repository looks protected and
# the local half of it never executes. `just bootstrap` runs this, so provisioning a
# clone is what makes the guard real, and `screencomp doctor --env` is what reports
# whether it is.
#
# The directory carries the screencomp guard and nothing else. `just gate` — the
# pre-push bar — stays unhooked and is still run deliberately; nothing here changes
# how this repository is checked, only whether the visual baseline can drift
# unnoticed.
#
# Idempotent, and it displaces nothing: this repository has never installed a hook of
# any kind, so `.git/hooks` holds only git's own disabled samples.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "enable-hooks: not a git checkout, so there are no hooks to point anywhere" >&2
  echo "ACTION: nothing — the visual guard is a pre-push hook, and a tree with no git has no push to guard" >&2
  exit 0
fi

if [ "$(git config --get core.hooksPath || true)" = ".githooks" ]; then
  exit 0
fi

git config core.hooksPath .githooks
echo "enable-hooks: core.hooksPath -> .githooks (the screencomp visual guard is now active)"
