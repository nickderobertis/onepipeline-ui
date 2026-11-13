#!/usr/bin/env bash
# The spike's process recorder around a CI step: `record.sh start <dir>` before
# it, `record.sh stop <dir>` after it (with `if: always()`), then upload <dir>.
#   Linux:   bpftrace (trace.bt, connect.bt) and BSD process accounting (acct).
#   macOS:   BSD process accounting, the one tracer SIP leaves a hosted runner.
#   Windows: process creation/termination audit events plus a CPU sampler
#            (windows.ps1).
# Each recorder is best-effort: one that cannot start writes `<name>.unavailable`
# with its reason, and the step it wraps runs either way.
set -uo pipefail
mode="${1:?start or stop}"
out="${2:?an output directory}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out"
clock() { python3 -c 'import time; print(time.time_ns(), time.monotonic_ns())' 2>/dev/null || node -e 'const n=process.hrtime.bigint(); console.log(String(BigInt(Date.now())*1000000n), String(n))'; }
case "$(uname -s)" in
Linux)
  if [ "$mode" = start ]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bpftrace acct >"$out/install.log" 2>&1 || echo "apt-get install failed" >"$out/install.unavailable"
    sudo touch "$out/pacct" && sudo accton "$out/pacct" || echo "accton failed" >"$out/acct.unavailable"
    clock >"$out/clock-start.txt"
    sudo bpftrace -q "$here/trace.bt" >"$out/trace.txt" 2>"$out/trace.err" & echo $! >"$out/trace.pid"
    sudo bpftrace -q "$here/connect.bt" >"$out/connect.txt" 2>"$out/connect.err" & echo $! >"$out/connect.pid"
    for _ in $(seq 1 120); do grep -q '^READY' "$out/trace.txt" 2>/dev/null && break; sleep 0.5; done
    grep -q '^READY' "$out/trace.txt" || echo "bpftrace never reported READY" >"$out/trace.unavailable"
    clock >"$out/clock-ready.txt"
  else
    clock >"$out/clock-stop.txt"
    for name in trace connect; do
      [ -f "$out/$name.pid" ] && sudo kill -INT "$(cat "$out/$name.pid")" 2>/dev/null
    done
    sleep 5
    sudo accton off 2>/dev/null
    sudo chown -R "$(id -u):$(id -g)" "$out"
    ls -la "$out"
  fi
  ;;
Darwin)
  if [ "$mode" = start ]; then
    sudo touch "$out/acct" && sudo accton "$out/acct" || echo "accton failed" >"$out/acct.unavailable"
    clock >"$out/clock-start.txt"
  else
    clock >"$out/clock-stop.txt"
    sudo accton
    sudo chown -R "$(id -u):$(id -g)" "$out"
    lastcomm -f "$out/acct" >"$out/lastcomm.txt" 2>&1 || true
    ls -la "$out"
  fi
  ;;
MINGW* | MSYS* | CYGWIN*)
  pwsh -NoProfile -File "$(cygpath -w "$here/windows.ps1")" "$mode" "$(cygpath -w "$out")"
  ;;
*) echo "record.sh: no recorder for $(uname -s)" >"$out/recorder.unavailable" ;;
esac
exit 0
