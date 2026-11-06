#!/usr/bin/env bash
# SPIKE, nothing here lands: re-capture the action-items visual spike's screenshots into
# shots/local/spike-visual/{before,after}. "before" renders apps/dag-ui/src as the base
# commit has it, or takes the deployed baseline where its digest matches ours.
set -euo pipefail
cd "$(dirname "$0")/.."
base="${SPIKE_BASE:-7acfdc80c24c00e2c1777c0d6ee1557783831959}"
out=shots/local/spike-visual
gallery=https://nickderobertis.github.io/onepipeline-ui/baseline
[ -z "$(git status --porcelain -- apps/dag-ui/src)" ] || { echo "apps/dag-ui/src is dirty" >&2; exit 1; }
rm -rf "$out"; mkdir -p "$out"

trap 'git restore --source=HEAD --worktree -- apps/dag-ui/src' EXIT
git restore --source="$base" --worktree -- apps/dag-ui/src
SHOTS_OUT="$out/before" just dag-ui-screens -g SPIKE-before
git restore --source=HEAD --worktree -- apps/dag-ui/src
trap - EXIT
SHOTS_OUT="$out/after" just dag-ui-screens -g SPIKE-after

curl -fsS "$gallery/captures.json" -o "$out/deployed.json"
for size in 390x844 1440x900; do
  node -e '
    const [deployed, ours] = [process.argv[1], "shots/baseline/x86_64.json"].map(f => JSON.parse(require("fs").readFileSync(f)).shots);
    const hash = list => list.find(s => s.name === "01-run-list-overall" && s.toggles.viewport === process.argv[2])?.hash;
    if (!hash(ours) || hash(ours) !== hash(deployed)) process.exit(1);' "$out/deployed.json" "$size" \
    || { echo "deployed baseline for $size does not match; capture it on the base commit" >&2; exit 1; }
  curl -fsS "$gallery/01-run-list-overall-$size.png" -o "$out/before/b7-updates-$size.png"
done
rm "$out/deployed.json"
echo "spike-visual: captures in $out"
