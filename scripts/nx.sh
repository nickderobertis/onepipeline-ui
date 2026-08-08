#!/usr/bin/env bash
# The one entry point to this workspace's Nx.
#
# Nx lives in `node_modules/.bin`, which a fresh clone does not have, so every
# invocation heals through a locked install first. That is what lets `just check`
# work from a clean clone without a separate "install the orchestrator" step, and
# what keeps one recipe from failing with `nx: command not found` while another
# quietly repaired it.
#
# Nx's own streams are handed straight through: every target here shells out to a
# language-native tool (cargo, clippy, rustdoc), whose diagnostics already name
# the exact problem and its fix. Wrapping them would bury the signal.
#
# Nx orchestrates targets; it is never a runtime dependency of the scripts it
# runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "nx: cannot enter the repository root $ROOT" >&2
  echo "ACTION: run this from a checkout whose directories are readable" >&2
  exit 1
}

# The daemon is a long-lived background process per workspace root that buys
# about a tenth of a second here; it is not worth a resident process the gate
# never reaps. `NX_DAEMON=true` still turns it back on for anyone who wants it.
export NX_DAEMON="${NX_DAEMON-false}"
# Keep a daemon that *is* turned back on from fetching its own private `nx@latest`
# for housekeeping: this workspace's pinned Nx is the only one that may run.
export NX_USE_LOCAL=true

if [ ! -e node_modules/.bin/nx ] && [ ! -e node_modules/.bin/nx.cmd ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "nx: npm not found; cannot install the pinned Nx the project graph needs" >&2
    echo "ACTION: install Node.js 20+ (https://nodejs.org/) and re-run 'just bootstrap'" >&2
    exit 1
  fi
  # Installer chatter is not this command's output: callers such as
  # `nx show projects --json` read stdout for Nx's answer.
  if ! npm ci --silent --no-audit --no-fund >&2; then
    echo "nx: 'npm ci' failed in $ROOT" >&2
    echo "ACTION: check network access to the npm registry, then re-run 'just bootstrap'" >&2
    exit 1
  fi
fi

# The npm-written shim rather than a path inside the package: Nx has moved its
# bin entry between releases, and the shim is the one name that cannot.
NX_BIN="node_modules/.bin/nx"
[ -e "$NX_BIN" ] || NX_BIN="node_modules/.bin/nx.cmd"

exec "$NX_BIN" "$@"
