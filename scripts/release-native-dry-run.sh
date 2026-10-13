#!/usr/bin/env bash
# Rehearse the Mac packaging path on a real host binary. No registry or forge
# writes: maturin builds, the same staging command packs, real pip/npm install.
set -euo pipefail
run_checked() {
  local action="$1"
  shift
  "$@" || { echo "release-native-dry-run: $1 failed" >&2; echo "ACTION: $action" >&2; exit 1; }
}
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo 'release-native-dry-run: an output directory is required' >&2
  echo 'ACTION: pass a writable scratch directory as the sole argument' >&2
  exit 2
fi
out="$1"
mkdir -p "$out"
version="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)"
target="$(rustc -vV | sed -n 's/^host: //p')"
run_checked "install Python with venv support and retry staging in a writable output directory" python3 -m venv "$out/producer"
run_checked "confirm the pinned maturin and packaging versions are reachable and retry the producer environment install" "$out/producer/bin/pip" install --disable-pip-version-check maturin==1.14.1 packaging==25.0
run_checked "inspect the compiler error, restore the locked toolchain and browser bundle, then retry the native build" "$out/producer/bin/maturin" build --release --locked --out "$out/build" --features bundled-ui
wheel=("$out/build"/*.whl)
"$out/producer/bin/python" scripts/release-package.py --target "$target" --wheel "${wheel[0]}" --out "$out" --tag "v$version" >/dev/null
node scripts/verify-staged-release.mjs "$out" "$target" "$version"
