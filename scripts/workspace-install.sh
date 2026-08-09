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
  echo "ACTION: install Node.js 20+ (https://nodejs.org/) and re-run 'just bootstrap'" >&2
  exit 1
fi

if ! npm ci --silent --no-audit --no-fund >&2; then
  echo "workspace-install: 'npm ci' failed in $ROOT" >&2
  echo "ACTION: check network access to the npm registry, then re-run 'just bootstrap'" >&2
  exit 1
fi
