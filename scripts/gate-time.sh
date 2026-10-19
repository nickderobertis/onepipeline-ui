#!/usr/bin/env bash
# Time `just gate` and hold it to its budget, as a warning: the wrapper the gate
# recipe runs its whole body inside.
#
# It records when the body started and ended to a gitignored file — replacing
# whatever an earlier run left there before the body starts, so the record is
# always this invocation's or absent — then, when the body passed, runs
# `onebudgetspec check budgets.yaml --label host-variable`, whose one budget,
# `onepipeline-ui-gate-time`, reads that record (scripts/gate-time-budget.mjs).
# A development machine's timing varies too much to refuse a gate on, so a
# budget that is over prints a warning naming it and the gate still passes; a
# measurement that errored or a budgets file that is invalid fails it, because
# then the line was never drawn at all.
#
# Usage:
#   gate-time.sh -- COMMAND [ARG]...
#
# Environment:
#   ONEPIPELINE_UI_GATE_TIME_RECORD  where the record goes (default
#                                    .gate-time/record.json under the root)
#
# Exit: the body's own status when it failed; otherwise 0 when the budget is
# within or over, onebudgetspec's status (2 invalid, 3 errored) when it could
# not be measured, and 2 when this script was called wrongly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
record="${ONEPIPELINE_UI_GATE_TIME_RECORD:-$ROOT/.gate-time/record.json}"

if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "gate-time: name the gate's body after --" >&2
  echo "ACTION: run 'scripts/gate-time.sh -- COMMAND [ARG]...'" >&2
  exit 2
fi
shift

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

mkdir -p "$(dirname "$record")"
rm -f "$record"
started="$(now_ms)"
invocation="$$-$started"

status=0
"$@" || status=$?
ended="$(now_ms)"

# Written whole, then moved into place, so a reader never sees half a record.
node -e '
  const [path, invocation, started, ended, status, ...command] = process.argv.slice(1);
  const record = {
    schema_version: 1,
    invocation,
    command,
    started_at_ms: Number(started),
    ended_at_ms: Number(ended),
    exit_code: Number(status),
  };
  require("node:fs").writeFileSync(`${path}.tmp`, `${JSON.stringify(record)}\n`);
  require("node:fs").renameSync(`${path}.tmp`, path);
' "$record" "$invocation" "$started" "$ended" "$status" "$@"

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

budget_status=0
output="$(cd "$ROOT" && ONEPIPELINE_UI_GATE_TIME_RECORD="$record" \
  node_modules/.bin/onebudgetspec check budgets.yaml --label host-variable 2>&1)" || budget_status=$?
printf '%s\n' "$output"
case "$budget_status" in
  0) ;;
  1)
    over="$(printf '%s\n' "$output" | sed -n 's/^budget \([a-z][a-z0-9-]*\): .* — over;.*/\1/p' | paste -sd, -)"
    echo "gate-time: warning: this gate ran over the budget ${over:-onepipeline-ui-gate-time} (budgets.yaml); a development machine's timing is reported, never refused, so the gate still passes" >&2
    ;;
  *)
    echo "gate-time: the gate's time could not be held to its budget: onebudgetspec exited $budget_status (output above)" >&2
    echo "ACTION: fix what onebudgetspec reports above — budgets.yaml must validate, and the record at $record must be this run's — then re-run 'just gate'" >&2
    exit "$budget_status"
    ;;
esac
