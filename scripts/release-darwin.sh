#!/usr/bin/env bash
# The single Mac build: maturin compiles each target once. All other carriers
# take the final wheel binary, including its stripping, as their sole input.
set -euo pipefail
out="${1:?pass an output directory}"
mkdir -p "$out"
version="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)"
[ "${GITHUB_REF_NAME:-v$version}" = "v$version" ] || { echo 'release tag differs from Cargo.toml' >&2; echo 'ACTION: build the tag whose version matches Cargo.toml; never restamp an existing release' >&2; exit 1; }
read -r -a targets <<< "${DARWIN_TARGETS:?the release workflow declares Darwin targets}"
for target in "${targets[@]}"; do
  case "$target" in x86_64-apple-darwin|aarch64-apple-darwin) ;; *) echo "not a Darwin target: $target" >&2; echo "ACTION: set DARWIN_TARGETS to the Darwin triples declared by release.yml" >&2; exit 1 ;; esac
  rustup target add "$target"
  maturin build --release --locked --target "$target" --out "$out/build-$target" --features bundled-ui
  wheel=("$out/build-$target"/*.whl)
  python3 scripts/release-package.py --target "$target" --wheel "${wheel[0]}" --out "$out" --tag "v$version"
done
