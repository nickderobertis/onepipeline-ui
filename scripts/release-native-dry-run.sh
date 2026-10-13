#!/usr/bin/env bash
# Rehearse the Mac packaging path on a real host binary. No registry or forge
# writes: maturin builds, the same staging command packs, real pip/npm install.
set -euo pipefail
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo 'release-native-dry-run: an output directory is required' >&2
  echo 'ACTION: pass a writable scratch directory as the sole argument' >&2
  exit 2
fi
out="$1"
mkdir -p "$out"
version="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)"
target="$(rustc -vV | sed -n 's/^host: //p')"
python3 -m venv "$out/producer"
"$out/producer/bin/pip" install --disable-pip-version-check maturin==1.14.1 packaging==25.0
"$out/producer/bin/maturin" build --release --locked --out "$out/build" --features bundled-ui
wheel=("$out/build"/*.whl)
"$out/producer/bin/python" scripts/release-package.py --target "$target" --wheel "${wheel[0]}" --out "$out" --tag "v$version" >/dev/null
node scripts/verify-staged-release.mjs "$out" "$target" "$version"
