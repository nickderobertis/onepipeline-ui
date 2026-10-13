#!/usr/bin/env bash
# Rehearse the Mac packaging path on a real host binary. No registry or forge
# writes: maturin builds, the same staging command packs, real pip/npm install.
set -euo pipefail
out="${1:?pass an output directory}"
mkdir -p "$out"
version="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)"
target="$(rustc -vV | sed -n 's/^host: //p')"
python3 -m venv "$out/producer"
"$out/producer/bin/pip" install --disable-pip-version-check maturin==1.14.1 packaging==25.0
"$out/producer/bin/maturin" build --release --locked --out "$out/build" --features bundled-ui
wheel=("$out/build"/*.whl)
"$out/producer/bin/python" scripts/release-package.py --target "$target" --wheel "${wheel[0]}" --out "$out" --tag "v$version"
node scripts/verify-staged-release.mjs "$out" "$target" "$version"
