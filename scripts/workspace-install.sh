#!/usr/bin/env bash
# Heal the workspace's node_modules from the committed lockfile, if it is missing.
#
# A fresh clone and a freshly created worktree both have no `node_modules` at all,
# and two different callers need one: `scripts/nx.sh`, because Nx itself lives
# there, and `scripts/dag-ui-screens.sh`, because Playwright does. This is that one
# step, so neither caller can quietly repair what the other reports missing.
#
# Quiet and idempotent when the install is already present. Installer chatter goes
# to stderr: a caller such as `nx show projects --json` reads stdout for an answer.
set -euo pipefail

# The floors the committed lockfile imposes, named once. `.github/workflows/`
# pins the same Node major to every job, so a green CI run and a green local
# `just check` are the same install.
NODE_FLOOR=24
NPM_FLOOR=11

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "workspace-install: cannot enter the repository root $ROOT" >&2
  echo "ACTION: run this from a checkout whose directories are readable" >&2
  exit 1
}

# The Nx shim is the marker rather than the directory: a `node_modules` left half
# written by an interrupted install is exactly the state that must reinstall.
if [ -e node_modules/.bin/nx ] || [ -e node_modules/.bin/nx.cmd ]; then
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "workspace-install: npm not found; cannot install the workspace's pinned dependencies" >&2
  echo "ACTION: install Node.js $NODE_FLOOR+ (https://nodejs.org/) and re-run 'just bootstrap'" >&2
  exit 1
fi

# npm 10 and npm 11 build different trees from the same lockfile — npm 10 reads
# this one as missing a transitive dependency npm 11 records nested, and refuses
# the whole install. The lockfile is this repo's only pin for the workspace, so
# the npm that reads it has to be the npm that wrote it; saying so here is what
# keeps that from surfacing as a one-second `npm ci` failure in CI.
npm_major="$(npm --version | cut -d. -f1)"
if [ "$npm_major" -lt "$NPM_FLOOR" ]; then
  echo "workspace-install: npm $(npm --version) cannot install package-lock.json, which npm $NPM_FLOOR wrote" >&2
  echo "ACTION: use Node.js $NODE_FLOOR+ (https://nodejs.org/), which ships npm $NPM_FLOOR; CI pins the same floor in .github/workflows/" >&2
  exit 1
fi

# `--loglevel=error` rather than `--silent`: a successful install still says
# nothing, but a refused one keeps npm's own diagnostic, which names the package
# at fault. Silencing that is what made this step fail with no reason attached.
# llmlint: ignore[work_goes_through_command_surface] this is the step the command
# surface is built on, not one that may route through it: `just bootstrap` runs
# `scripts/nx.sh`, which runs this script precisely because Nx lives in the
# `node_modules` this line creates. Calling `just` here would close that loop.
if ! npm ci --loglevel=error --no-audit --no-fund >&2; then
  echo "workspace-install: 'npm ci' failed in $ROOT" >&2
  echo "ACTION: read npm's diagnostic above; if it names no package, check network access to the npm registry, then re-run 'just bootstrap'" >&2
  exit 1
fi
