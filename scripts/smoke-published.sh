#!/usr/bin/env bash
# Smoke-test an `onepipeline-ui` that is already on PATH.
#
# Every post-publish verify leg — the GitHub Release, the PyPI wheel, the npm
# package — installs its own way and then hands what it installed to this one
# script, so "it works" means the same thing on all of them. Single-shot on
# purpose: the install is what races a registry (scripts/retry-install.sh
# retries that), and a wrong version or a broken binary must fail now.
#
# What it asserts is the artifact's whole user-visible contract today: the
# version it reports, that `--help` renders, and that `serve` refuses with the
# documented exit code rather than starting something. When the read API lands,
# its journey lands here too.
#
# Usage:
#   smoke-published.sh --expect-version X.Y.Z [--label TEXT] [--command NAME]
set -euo pipefail

expect_version=""
label=""
command_name="onepipeline-ui"

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

fail() {
  echo "::error::$label: $1" >&2
  echo "ACTION: $2" >&2
  exit 1
}

if ! command -v "$command_name" >/dev/null 2>&1; then
  fail "'$command_name' is not on PATH after the install" \
    "check the install step above — the package may not put its console command on PATH"
fi

# `--version` prints `<name> <version>`; take the last field so the assertion is
# about the version and not about how clap spells the program name.
reported="$("$command_name" --version | tr -d '\r' | awk 'NR==1 {print $NF}')"
if [ "$reported" != "$expect_version" ]; then
  fail "installed $reported but the release is $expect_version" \
    "check that the publish job uploaded artifacts built from this tag"
fi

"$command_name" --help >/dev/null || fail "'--help' failed" \
  "the installed binary is broken; check the build job for this platform"

# `serve` is landed interface-only and must refuse with the documented status.
# Anything else — a zero exit, or a usage error — means the artifact does not
# behave the way its own docs say.
code=0
"$command_name" serve --runs-root . >/dev/null 2>&1 || code=$?
if [ "$code" -ne 70 ]; then
  fail "'serve' exited $code, not the documented 70" \
    "compare against docs/contract.md and src/main.rs at this tag"
fi

echo "$label: smoke test passed"
