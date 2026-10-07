#!/usr/bin/env bash
# Heal the workspace's node_modules from the committed lockfile, if it is missing.
#
# A fresh clone and a freshly created worktree both have no `node_modules` at all,
# and two different callers need one: `scripts/nx.sh`, because Nx itself lives
# there, and `scripts/visual-capture.sh`, because a capture needs the Playwright that drives it. This is that one
# step, so neither caller can quietly repair what the other reports missing.
#
# Quiet and idempotent when the install is already present. Installer chatter goes
# to stderr: a caller such as `nx show projects --json` reads stdout for an answer.
#
# Exit codes, one per thing to fix (the sysexits numbers, as the binary's 70 is):
#   0   the workspace is installed, now or already
#   1   the install itself failed, with bun's own diagnostic above the refusal, or
#       the checkout could not be entered
#   69  a runtime (node, bun) is missing, answers no version, or is below its floor
#   78  package.json names no floor for one of them, so there is nothing to hold it to
set -euo pipefail

EX_UNAVAILABLE=69
EX_CONFIG=78

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

# Bun installs the workspace and Node runs it: Nx, Vite, Vitest and Playwright are
# Node programs. package.json's `engines.node` names the oldest major they run on,
# and `.github/workflows/` pins that same major to every job.
NODE_FLOOR="$(sed -n 's/^ *"node": *">=\([0-9]\{1,\}\)".*/\1/p' package.json)"
if [ -z "$NODE_FLOOR" ]; then
  echo "workspace-install: package.json names no Node.js floor in \"engines\"" >&2
  echo "ACTION: restore \"engines\": { \"node\": \">=<major>\" } in package.json; it is the floor this install holds node to" >&2
  exit $EX_CONFIG
fi

if ! command -v node >/dev/null 2>&1; then
  echo "workspace-install: node not found; the workspace's tools run on Node.js" >&2
  echo "ACTION: install Node.js $NODE_FLOOR+ (https://nodejs.org/) and re-run 'just bootstrap'" >&2
  exit $EX_UNAVAILABLE
fi

node_version="$(node --version 2>/dev/null || true)"
if ! [[ "$node_version" =~ ^v([0-9]+)\.[0-9]+\.[0-9]+ ]]; then
  echo "workspace-install: the node on PATH ($(command -v node)) answered --version with '$node_version', which is not a version" >&2
  echo "ACTION: install Node.js $NODE_FLOOR+ (https://nodejs.org/), put it first on PATH and re-run 'just bootstrap'" >&2
  exit $EX_UNAVAILABLE
fi
if [ "${BASH_REMATCH[1]}" -lt "$NODE_FLOOR" ]; then
  echo "workspace-install: node $node_version is older than Node.js $NODE_FLOOR, which package.json's \"engines\" requires" >&2
  echo "ACTION: install Node.js $NODE_FLOOR+ (https://nodejs.org/) and re-run 'just bootstrap'" >&2
  exit $EX_UNAVAILABLE
fi

# The bun that wrote bun.lock is the floor, and package.json's `packageManager` is
# the one place it is named: `oven-sh/setup-bun` reads the same field in every CI
# job, so a green CI run and a green local `just check` are the same install. An
# older bun may not read the lockfile a newer one wrote, and would say so as a
# lockfile error rather than as a version.
BUN_FLOOR="$(sed -n 's/^ *"packageManager": *"bun@\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)".*/\1/p' package.json)"
if [ -z "$BUN_FLOOR" ]; then
  echo "workspace-install: package.json pins no bun version in \"packageManager\"" >&2
  echo "ACTION: restore \"packageManager\": \"bun@<major>.<minor>.<patch>\" in package.json; it is the one pin of the workspace's package manager" >&2
  exit $EX_CONFIG
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "workspace-install: bun not found; cannot install the workspace's pinned dependencies from bun.lock" >&2
  echo "ACTION: install bun $BUN_FLOOR (curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_FLOOR) and re-run 'just bootstrap'" >&2
  exit $EX_UNAVAILABLE
fi

# Field by field rather than `sort -V`, which not every platform's sort has, and
# only once the answer is a version: anything else on a `bun` would reach the
# arithmetic below as a shell error rather than as this refusal.
bun_version="$(bun --version 2>/dev/null || true)"
if ! [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
  echo "workspace-install: the bun on PATH ($(command -v bun)) answered --version with '$bun_version', which is not a version" >&2
  echo "ACTION: install bun $BUN_FLOOR (curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_FLOOR), put it first on PATH and re-run 'just bootstrap'" >&2
  exit $EX_UNAVAILABLE
fi
older=0
IFS=. read -r have_major have_minor have_patch <<<"${bun_version%%[-+]*}"
IFS=. read -r want_major want_minor want_patch <<<"$BUN_FLOOR"
for pair in "${have_major:-0} ${want_major:-0}" "${have_minor:-0} ${want_minor:-0}" "${have_patch:-0} ${want_patch:-0}"; do
  read -r have want <<<"$pair"
  if [ "$have" -gt "$want" ]; then break; fi
  if [ "$have" -lt "$want" ]; then
    older=1
    break
  fi
done
if [ "$older" -eq 1 ]; then
  echo "workspace-install: bun $bun_version is older than bun $BUN_FLOOR, which package.json pins and bun.lock was written with" >&2
  echo "ACTION: run 'bun upgrade' (or install bun $BUN_FLOOR: curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_FLOOR) and re-run 'just bootstrap'" >&2
  exit $EX_UNAVAILABLE
fi

# `--frozen-lockfile` is what makes the lockfile the pin: a manifest the lockfile
# does not carry is refused rather than resolved afresh and written back, so no
# install here can quietly move a dependency. `--no-progress --no-summary` rather
# than `--silent`: a successful install still says nothing, but a refused one keeps
# bun's own diagnostic, which names the package at fault.
# llmlint: ignore[work_goes_through_command_surface] this is the step the command
# surface is built on, not one that may route through it: `just bootstrap` runs
# `scripts/nx.sh`, which runs this script precisely because Nx lives in the
# `node_modules` this line creates. Calling `just` here would close that loop.
if ! bun install --frozen-lockfile --no-progress --no-summary >&2; then
  echo "workspace-install: 'bun install --frozen-lockfile' failed in $ROOT" >&2
  echo "ACTION: read bun's diagnostic above; if it says the lockfile had changes, a package.json moved without bun.lock — run 'bun install' and commit bun.lock; otherwise check network access to the npm registry, then re-run 'just bootstrap'" >&2
  exit 1
fi
