#!/usr/bin/env bash
# One source for the environment this repository's judged tier runs llmlint in.
#
# Sourced by both ends of the cached tier — `scripts/llmlint-judge.sh`, which
# judges, and `scripts/llmlint-fingerprint.sh`, which keys the cache on the judge
# configuration. That sharing is the whole point: `llmlint config` renders the
# resolved oneharness binary into its output, so a fingerprint that read the
# caller's value instead would hash one judged diff to a different key per
# dispatch, and the non-deterministic judge would re-roll every round. This host
# does leak such a value — a checkout of a *different* repository exports
# `LLMLINT_ONEHARNESS_BIN` pointing at its own wrapper — so the split key is a
# real environment rather than a hypothetical one.
#
# The two things it pins are the two this repository's own setup decides:
#
#   * PATH. `scripts/setup-llmlint.sh` installs llmlint with `uv tool` into
#     `~/.local/bin` and prepends that directory; a caller that never sourced the
#     session env has it nowhere. Prepending the same directory here is what lets
#     the judge and the fingerprint resolve the same binary from any caller.
#   * `LLMLINT_ONEHARNESS_BIN`, cleared rather than set. llmlint finds
#     `oneharness` beside its own executable in the tool venv, which is what
#     `oneharness.toml`'s fallback mode (codex primary, claude-code secondary) is
#     written against; an inherited override would point the judge at another
#     repository's wrapper. Cleared, `llmlint config` reports `"bin": null` — the
#     same value in every checkout, on every host.
#
# Nothing else is narrowed: the inherited PATH is kept rather than replaced,
# because llmlint is installed outside the checkout and both ends must resolve it
# the same way.
set -euo pipefail

llmlint_runtime_env() {
  # Both expansions are guarded rather than assumed: these scripts run under
  # `set -u`, where a bare `$PATH` in an environment that has none aborts with
  # bash's own unbound-variable message and no way to act on it.
  [ -z "${HOME:-}" ] || export PATH="$HOME/.local/bin${PATH:+:$PATH}"
  unset LLMLINT_ONEHARNESS_BIN
}
