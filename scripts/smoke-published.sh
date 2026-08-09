#!/usr/bin/env bash
# Smoke-test an `onepipeline-api` that is already on PATH.
#
# Every post-publish verify leg — the GitHub Release, the PyPI wheel, the npm
# package — installs its own way and then hands what it installed to this one
# script, so "it works" means the same thing on all of them. Single-shot on
# purpose: the install is what races a registry (scripts/retry-install.sh
# retries that), and a wrong version or a broken binary must fail now.
#
# What it asserts is the artifact's whole user-visible contract: the version it
# reports, that `--help` renders, that a bad `--runs-root` is the documented
# usage error rather than a crash, and that `serve` really serves — bound on a
# port the kernel chose, answering `/healthz`, and stopping cleanly when asked.
#
# Usage:
#   smoke-published.sh --expect-version X.Y.Z [--label TEXT] [--command NAME]
set -euo pipefail

expect_version=""
label=""
command_name="onepipeline-api"

usage="run 'smoke-published.sh --expect-version X.Y.Z [--label TEXT] [--command NAME]'"

fail_usage() {
  echo "$1" >&2
  echo "ACTION: $usage" >&2
  exit 2
}

need_value() {
  [ "$#" -ge 2 ] || fail_usage "$1 needs a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-version) need_value "$@"; expect_version="$2"; shift 2 ;;
    --label) need_value "$@"; label="$2"; shift 2 ;;
    --command) need_value "$@"; command_name="$2"; shift 2 ;;
    *) fail_usage "unknown option $1" ;;
  esac
done

[ -n "$expect_version" ] || fail_usage "--expect-version is required"
[ -n "$label" ] || label="$command_name $expect_version"

# A third argument is the server's own output, printed as its own plain line: it
# is evidence for the ACTION rather than the ACTION itself, and a `::error::`
# annotation is a workflow command, which arbitrary server output could close.
fail() {
  echo "::error::$label: $1" >&2
  echo "ACTION: $2" >&2
  if [ "$#" -ge 3 ]; then
    echo "The server printed: $3" >&2
  fi
  exit 1
}

if ! command -v "$command_name" >/dev/null 2>&1; then
  fail "'$command_name' is not on PATH after the install" \
    "check the install step above — the package may not put its console command on PATH"
fi

# `--version` prints `<name> <version>`; take the last field so the assertion is
# about the version and not about how clap spells the program name. Captured
# without `set -e` deciding what happens: `pipefail` would otherwise end the run
# here on a binary that cannot even print its version, with the shell's own
# silence in place of what went wrong and what to do about it.
if ! version_output="$("$command_name" --version 2>&1)"; then
  fail "'$command_name --version' failed: ${version_output}" \
    "the installed binary does not run on this platform; check the build job for it"
fi
reported="$(printf '%s\n' "$version_output" | tr -d '\r' | awk 'NR==1 {print $NF}')"
if [ "$reported" != "$expect_version" ]; then
  fail "installed $reported but the release is $expect_version" \
    "check that the publish job uploaded artifacts built from this tag"
fi

# Captured rather than discarded, here and below: on a runner this script is the
# only witness, and "'--help' failed" without the binary's own words leaves
# whoever reads the log to reproduce the platform before they can start.
if ! help_output="$("$command_name" --help 2>&1)"; then
  fail "'--help' failed: ${help_output}" \
    "the installed binary is broken; check the build job for this platform"
fi

# A runs root this host cannot read is a usage error, exit 2 — the documented
# status, and distinct from the crash a broken binary would give.
code=0
serve_output="$("$command_name" serve --runs-root /no/such/runs/root 2>&1)" || code=$?
if [ "$code" -ne 2 ]; then
  fail "'serve' with an unreadable runs root exited $code, not the documented 2: ${serve_output}" \
    "compare against AGENTS.md's exit-code invariant and src/main.rs at this tag"
fi

# Then the thing the artifact is for. `--bind 127.0.0.1:0` takes whatever port is
# free, and the server names it on its first line of output — so this asks for no
# port of its own and cannot collide with anything else on the runner.
serve_root="$(mktemp -d)"
serve_log="$(mktemp)"
cleanup() {
  [ -n "${serve_pid:-}" ] && kill "$serve_pid" 2>/dev/null
  rm -rf "$serve_root" "$serve_log"
}
trap cleanup EXIT

"$command_name" serve --runs-root "$serve_root" --bind 127.0.0.1:0 >"$serve_log" 2>&1 &
serve_pid=$!

address=""
for _ in $(seq 1 100); do
  address="$(tr -d '\r' <"$serve_log" | sed -n 's|.*on http://||p' | head -n 1)"
  [ -n "$address" ] && break
  kill -0 "$serve_pid" 2>/dev/null || break
  sleep 0.1
done
if [ -z "$address" ]; then
  fail "'serve' never named the address it took" \
    "if the line below names an address in another form, reconcile src/server.rs's startup line with this script's parser; if it names a bind failure, this host denied loopback; if it is empty, check the build job for this platform" \
    "$(tr '\n' ' ' <"$serve_log")"
fi

# The body is held rather than piped straight into `grep`: a route that answers
# 200 with something else is the interesting failure, and piping would report
# only that the match failed while throwing away the thing that did not match.
health=""
if ! health="$(curl -fsS --max-time 10 "http://$address/healthz" 2>&1)" ||
  ! printf '%s' "$health" | grep -q '"ok"'; then
  fail "'serve' did not answer /healthz on $address with an ok status, but with: ${health}" \
    "compare the line below against the /healthz route in src/server.rs at this tag, and check that nothing on this host intercepts loopback" \
    "$(tr '\n' ' ' <"$serve_log")"
fi

# Being asked to stop is the normal end of a read surface, and it exits 0.
#
# Windows is left out of the assertion, not out of the stop: `kill` under MSYS
# is `TerminateProcess`, which ends the server unconditionally and reports a
# status the server never chose, so an exit code there would be the shell's and
# not the artifact's. Every other leg above — the version, `--help`, the
# documented `2`, and serving `/healthz` — runs on every platform.
# A kill that fails means the server is already gone, which under `set -e` would
# end the run here with the shell's silence in place of the reason: the process
# this leg exists to stop died on its own, and the log is what says why.
if ! kill_error="$(kill "$serve_pid" 2>&1)"; then
  fail "'serve' could not be asked to stop: ${kill_error}" \
    "the server exited before this leg asked it to; read the line below for what ended it" \
    "$(tr '\n' ' ' <"$serve_log")"
fi
stopped=0
wait "$serve_pid" || stopped=$?
serve_pid=""
stop_note=""
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    stop_note=" (stopped, but this platform cannot ask, so its status is not asserted)"
    ;;
  *)
    if [ "$stopped" -ne 0 ]; then
      fail "'serve' exited $stopped when asked to stop, not 0" \
        "compare against src/server.rs's graceful shutdown at this tag"
    fi
    ;;
esac

# Success is this one line on every platform; what the stop leg could assert is
# said inside it rather than on a line of its own.
echo "$label: smoke test passed$stop_note"
