#!/usr/bin/env bash
# local-compile.sh <checkout> <plain|instrumented> <target dir>
# One cold build of every test target in <checkout>'s workspace, without
# running a test: <target dir> is emptied first, and the build is
# `cargo test --no-run --workspace --tests --offline`, plain or with
# `cargo llvm-cov show-env`'s instrumentation. Prints one line:
#   <mode> elapsed_s=<s> user_s=<s> sys_s=<s> cpu_s=<user+sys> load1=<before>/<after>
# CPU seconds are the figure to compare on a shared host; elapsed time moves
# with whatever else the host runs (load1 says how much), so it is recorded
# beside them, never compared alone.
set -euo pipefail
checkout="${1:?usage: local-compile.sh <checkout> <plain|instrumented> <target dir>}"
mode="${2:?usage: local-compile.sh <checkout> <plain|instrumented> <target dir>}"
target="${3:?usage: local-compile.sh <checkout> <plain|instrumented> <target dir>}"
case "$mode" in
plain | instrumented) ;;
*)
  echo "local-compile: mode is plain or instrumented, not '$mode'" >&2
  exit 2
  ;;
esac
cd "$checkout"
rm -rf "$target"
mkdir -p "$target"
if [ "$mode" = instrumented ]; then
  # show-env names its own target dir; the build below is pointed at ours.
  eval "$(cargo llvm-cov show-env --export-prefix)"
fi
load() { cut -d' ' -f1 /proc/loadavg; }
before="$(load)"
times="$(mktemp)"
/usr/bin/time -f '%e %U %S' -o "$times" \
  cargo test --offline --no-run --workspace --tests --target-dir "$target" \
  >"$target/build.log" 2>&1 || {
  echo "local-compile: the build failed; its output is $target/build.log" >&2
  exit 1
}
read -r elapsed user sys <"$times"
rm -f "$times"
echo "$mode elapsed_s=$elapsed user_s=$user sys_s=$sys cpu_s=$(echo "$user + $sys" | bc) load1=$before/$(load)"
