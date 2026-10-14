#!/usr/bin/env bash
# The measurement behind `onepipeline-ui-pool-maintenance-seconds`: one
# steady-state pass of the declared pool maintenance (`just pool-maintenance`),
# timed and reported by `cargo-prune-superseded` itself through onebudgetspec.
#
# Steady state is the pass a regular post-run maintenance faces — one ordinary
# run's worth of new superseded builds — never a first pass over weeks of
# history, so this establishes that state before it times anything:
#
#   a. one declared pass, untimed, clears whatever backlog this target dir holds;
#   b. the gate's test-target build under `--features bundled-ui`, which gives
#      this crate's own units new metadata hashes, and exactly the entries that
#      build created backdated past the window — they stand in for a run's
#      builds that a later run has since superseded. The ordinary build runs
#      first, untimed, so that build creates only what the feature changes and
#      never a dependency both configurations share;
#   c. the ordinary gate build, so each unit's newest build is the ordinary one;
#   d. one declared pass, timed — the figure — which removes (b)'s builds.
#
# Only (d) runs with `ONEBUDGETSPEC_RESULT` set, so only its report is the
# figure; (a)'s seconds are appended to that report's detail as evidence beside
# it. The script refuses a run in which (d) removed nothing, or removed anything
# (b) did not create: either means the workload was not the one the budget
# describes, and a figure from it would measure something else.
#
# It builds the crate twice, so nothing per-change runs it: only the
# `pool-maintenance:budgets-host` target does (AGENTS.md, "Command surface").
set -euo pipefail

cd "$(dirname "$0")/.."

# Every entry the pruner judges lives under these four directories of a profile.
PROFILE="target/debug"
UNIT_DIRS=(deps .fingerprint build incremental)
# Older than anything an ordinary build in this slot can carry, so the ordinary
# build is always the newer one whatever age this slot's last build is. Any
# date past the 2-day window selects the same builds.
BACKDATE="2000-01-01 00:00:00 UTC"
EVIDENCE="target/pool-maintenance"

if [ ! -f apps/dag-ui/dist/index.html ]; then
  echo "measure.sh: apps/dag-ui/dist holds no browser view, and the alternative build (--features bundled-ui) refuses to compile without one" >&2
  echo "ACTION: run 'just build' first, or run this through 'just budgets', which builds it" >&2
  exit 1
fi

result="${ONEBUDGETSPEC_RESULT:-}"
unset ONEBUDGETSPEC_RESULT
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"

# One sorted line per top-level entry the pruner can select in the profile.
list_entries() {
  local dir
  for dir in "${UNIT_DIRS[@]}"; do
    [ ! -d "$PROFILE/$dir" ] || find "$PROFILE/$dir" -mindepth 1 -maxdepth 1 -printf '%p\n'
  done | LC_ALL=C sort
}

now() { date +%s.%N; }

# (a) The backlog, cleared untimed.
started="$(now)"
just pool-maintenance
backlog_seconds="$(awk -v a="$started" -v b="$(now)" 'BEGIN { printf "%.3f", b - a }')"

# (b) One superseded run's builds, backdated past the window. `-h` stamps a
# symlink itself rather than what it points at, as the pruner never follows one.
cargo nextest run --locked --no-run
list_entries >"$EVIDENCE/before-alternative"
cargo nextest run --locked --no-run --features bundled-ui
list_entries >"$EVIDENCE/after-alternative"
LC_ALL=C comm -13 "$EVIDENCE/before-alternative" "$EVIDENCE/after-alternative" >"$EVIDENCE/alternative"
if [ ! -s "$EVIDENCE/alternative" ]; then
  echo "measure.sh: the alternative build created no entry under $PROFILE, so there is nothing for the timed pass to supersede" >&2
  exit 1
fi
while IFS= read -r entry; do
  find "$entry" -exec touch -h -d "$BACKDATE" {} +
done <"$EVIDENCE/alternative"

# (c) The ordinary gate build, the newest of every unit.
cargo nextest run --locked --no-run

# (d) The figure: the declared pass, reporting its own seconds.
list_entries >"$EVIDENCE/before-timed"
ONEBUDGETSPEC_RESULT="$result" just pool-maintenance
list_entries >"$EVIDENCE/after-timed"
LC_ALL=C comm -23 "$EVIDENCE/before-timed" "$EVIDENCE/after-timed" >"$EVIDENCE/removed"
LC_ALL=C comm -23 "$EVIDENCE/removed" "$EVIDENCE/alternative" >"$EVIDENCE/removed-not-alternative"

if [ ! -s "$EVIDENCE/removed" ]; then
  echo "measure.sh: the timed pass removed no build, so it did not face a run's worth of superseded ones (lists in $EVIDENCE)" >&2
  exit 1
fi
if [ -s "$EVIDENCE/removed-not-alternative" ]; then
  echo "measure.sh: the timed pass removed entries the alternative build did not create (lists in $EVIDENCE):" >&2
  cat "$EVIDENCE/removed-not-alternative" >&2
  exit 1
fi
echo "measure.sh: the timed pass removed $(wc -l <"$EVIDENCE/removed") entries, all the alternative build's; every other entry is still present (lists in $EVIDENCE)" >&2

if [ -n "$result" ]; then
  node -e '
    const fs = require("node:fs");
    const [path, seconds] = process.argv.slice(1);
    const report = JSON.parse(fs.readFileSync(path, "utf8"));
    report.detail = `${report.detail}; untimed backlog pass seconds (evidence, not the figure): ${seconds}`;
    fs.writeFileSync(path, JSON.stringify(report));
  ' "$result" "$backlog_seconds"
fi
