#!/usr/bin/env bash
# The single Mac build: maturin compiles each target once. All other carriers
# take the final wheel binary, including its stripping, as their sole input.
set -euo pipefail
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo 'release-darwin: an output directory is required' >&2
  echo 'ACTION: pass the staged output directory as the sole argument' >&2
  exit 2
fi
out="$1"
mkdir -p "$out"
version="$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)"
[ "${GITHUB_REF_NAME:-v$version}" = "v$version" ] || { echo 'release tag differs from Cargo.toml' >&2; echo 'ACTION: build the tag whose version matches Cargo.toml; never restamp an existing release' >&2; exit 1; }
if [ -z "${DARWIN_TARGETS:-}" ]; then
  echo 'release-darwin: DARWIN_TARGETS is missing' >&2
  echo 'ACTION: supply the Darwin target list declared by release.yml' >&2
  exit 2
fi
read -r -a targets <<< "$DARWIN_TARGETS"
for target in "${targets[@]}"; do
  case "$target" in x86_64-apple-darwin|aarch64-apple-darwin) ;; *) echo "not a Darwin target: $target" >&2; echo "ACTION: set DARWIN_TARGETS to the Darwin triples declared by release.yml" >&2; exit 2 ;; esac
  rustup target add "$target"
  maturin build --release --locked --target "$target" --out "$out/build-$target" --features bundled-ui
  wheel=("$out/build-$target"/*.whl)
  python3 scripts/release-package.py --target "$target" --wheel "${wheel[0]}" --out "$out" --tag "v$version" >/dev/null
done
echo "Darwin distributions staged from final wheel binaries"
