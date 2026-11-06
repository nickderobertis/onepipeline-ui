#!/usr/bin/env bash
# SPIKE, nothing here lands: re-capture the action-items visual spike's screenshots into
# shots/local/spike-visual/{before,after}. A "before" with a gallery surface is that
# surface's deployed baseline where its digest matches ours, and otherwise a render on the
# unchanged base; one with no gallery surface is always rendered on the base's source. Then
# shots/local/spike-visual/report/ holds the one phone-over-desktop image per report entry.
set -euo pipefail
cd "$(dirname "$0")/.."
base="${SPIKE_BASE:-7acfdc80c24c00e2c1777c0d6ee1557783831959}"
out=shots/local/spike-visual
gallery=https://nickderobertis.github.io/onepipeline-ui/baseline
sizes=(390x844 1440x900)
ours=shots/baseline/x86_64.json
deployed="$out/deployed.json"
fixtures=apps/dag-ui-e2e/fixtures
[ -z "$(git status --porcelain -- apps/dag-ui/src "$fixtures")" ] || { echo "apps/dag-ui/src or $fixtures is dirty" >&2; exit 1; }
rm -rf "$out"; mkdir -p "$out/before"

restore() { git restore --source=HEAD --worktree -- apps/dag-ui/src "$fixtures"; }
trap restore EXIT

# capture_on_base GREP PATH...: render the matching surfaces with PATHs as the base has them.
capture_on_base() {
  local grep="$1"
  shift
  git restore --source="$base" --worktree -- "$@"
  SHOTS_OUT="$out/before" just dag-ui-screens -g "$grep"
  restore
}

# shot_hash INDEX NAME SIZE: the digest INDEX records for that shot; empty when it has none.
shot_hash() {
  node -e '
    let shots = [];
    try { shots = JSON.parse(require("fs").readFileSync(process.argv[1])).shots; } catch {}
    const shot = shots.find(s => s.name === process.argv[2] && s.toggles.viewport === process.argv[3]);
    process.stdout.write(shot?.hash ?? "");' "$1" "$2" "$3"
}

# from_baseline NAME TARGET: fetch NAME as TARGET at every size, or fail if any digest differs.
# A deployed index or image that cannot be read has no digest to match, so it fails too.
from_baseline() {
  local name="$1" target="$2" size expected image
  for size in "${sizes[@]}"; do
    expected="$(shot_hash "$ours" "$name" "$size")"
    [ -n "$expected" ] || return 1
    [ "$expected" = "$(shot_hash "$deployed" "$name" "$size")" ] || return 1
    image="$out/before/$target-$size.png"
    curl -fsS "$gallery/$name-$size.png" -o "$image" || return 1
    [ "$expected" = "$(sha256sum "$image" | cut -d' ' -f1)" ] || return 1
  done
}

curl -fsS "$gallery/captures.json" -o "$deployed" || : > "$deployed"
for pair in 11-project-list:b6-nav:SPIKE-base-nav 01-run-list-overall:b7-updates:SPIKE-base-updates; do
  IFS=: read -r name target grep <<<"$pair"
  if from_baseline "$name" "$target"; then
    echo "spike-visual: $target from the deployed baseline $name, digests match"
  else
    echo "spike-visual: $target has no matching deployed baseline $name; capturing on $base"
    capture_on_base "$grep" apps/dag-ui/src "$fixtures"
  fi
done
rm "$deployed"

# These two read the spike's stubbed items and long task, so only the source is the base's.
capture_on_base SPIKE-before apps/dag-ui/src
trap - EXIT
SHOTS_OUT="$out/after" just dag-ui-screens -g SPIKE-after

# One image per report entry, in the browser image the captures rendered in.
docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD:/work" --workdir /work --env HOME=/tmp \
  "mcr.microsoft.com/playwright:v$(node -p 'require("./apps/dag-ui-e2e/package.json").devDependencies["@playwright/test"]')-noble" \
  node scripts/spike-visual-compose.mjs
echo "spike-visual: captures in $out"
