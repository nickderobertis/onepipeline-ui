#!/usr/bin/env bash
# Measurement only. The workflow caller owns the best-effort exit policy.
set -euo pipefail
trap 'printf "%s\n" "Disk report incomplete: inspect the command error above and verify the workspace, home and step-summary paths are accessible." >&2' ERR
: "${1:?Pass the report label as the first argument}"
: "${GITHUB_WORKSPACE:?Set GITHUB_WORKSPACE to the checkout directory}"
: "${HOME:?Set HOME to the runner home directory}"
: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY to the step-summary file}"

# A pipe can be reopened by tee even when the runner's stdout is a socket.
if [ -n "${GH_TOKEN:-}" ]; then
  exec 3> >(cat)
  disk_log_pid=$!
  finish_log() {
    local report_status=$?
    exec 3>&-
    if ! wait "$disk_log_pid"; then
      printf '%s\n' 'Disk log copy failed: inspect the GitHub check annotations and step summary, and verify the runner stdout pipe is writable.' >&2
      report_status=1
    fi
    exit "$report_status"
  }
  trap finish_log EXIT
fi

# llmlint: ignore-block[tool_output_is_signal] The requested diagnostic must put every measurement in both the job log and step summary so disk exhaustion can be diagnosed from either artifact; a status-only log would omit the evidence.
{
  printf '### Runner disk: %s\n\n' "$1"
  printf 'Bytes (filesystem total, used, available):\n\n'
  for directory in "$GITHUB_WORKSPACE" "$HOME"; do
    printf '%s\n' "$directory"
    df -B1 --output=size,used,avail "$directory"
  done
  if [ "$1" = 'After Rust cache restore' ]; then
    printf '\nRestored target allocated bytes:\n'
    if [ -d "$GITHUB_WORKSPACE/target" ]; then
      du -s -B1 "$GITHUB_WORKSPACE/target"
    else
      printf 'target directory absent\n'
    fi
  fi
  printf '\n'
} | {
  if [ -n "${GH_TOKEN:-}" ]; then
    tee -a "$GITHUB_STEP_SUMMARY" /dev/fd/3 | node .github/scripts/disk-delivery.mjs report "$1"
  else
    tee -a "$GITHUB_STEP_SUMMARY"
  fi
}
# llmlint: ignore-end[tool_output_is_signal]
