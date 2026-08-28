#!/usr/bin/env bash
# What a public registry serves, right now, for one of this repository's release
# targets.
#
# A consumer that depends on something published here has to wait for the
# release that carries it, and the only thing that can tell it the wait is over
# is the registry itself — a merged commit is not a release, and a tag is not
# one either (AGENTS.md: "A tag is not evidence of a release; the registry is").
# `release-targets.json` declares what this repository publishes; this answers
# what each of those names currently resolves to.
#
# One argument: a registry-qualified identifier, `crate:<name>`, `pypi:<name>`,
# or `npm:<name>`, where `<name>` is exactly the name that registry serves. The
# qualification is load-bearing rather than decorative — one name can be a
# project on one registry and a different package on another, and an
# unqualified name cannot say which release a consumer got.
#
# Exactly three answers, and the caller must be able to tell them apart:
#
#   * exit 0, one line on stdout — that version is what the registry serves;
#   * exit 0, nothing on stdout  — the registry has no release of it yet;
#   * any non-zero exit, reason on stderr — NOT ANSWERED.
#
# The third is never the second. A caller holds indefinitely on "not answered"
# and must never read it as evidence that a release has not happened, so every
# way this can fail to establish an answer — an unreachable registry, a document
# it cannot read, a missing tool, an identifier it does not recognise — exits
# non-zero with an empty stdout rather than answering "no release yet".
# `tests/e2e/release_probe.rs` holds that distinction.
#
# Assumes only what the release-target contract promises: this repository's root
# as the working directory, and an environment carrying PATH and HOME. Every
# registry read here is anonymous, because every artifact is public — there is
# no credential to pass and none may be required. `curl` and `node` are the two
# programs it needs on PATH; a host missing either gets "not answered", which is
# the truthful answer for a probe that could not run.
#
# Bounded well inside the sixty seconds the contract allows: at most three
# attempts of twelve seconds each.
set -euo pipefail

# Every failure names what to do next: the caller sees stderr and an exit code,
# and "not answered" is only actionable if it says what it could not establish.
fail() {
  printf 'release-probe: %s\nACTION: %s\n' "$1" "$2" >&2
  exit "${3:-1}"
}

usage='pass exactly one registry-qualified identifier: crate:<name>, pypi:<name>, or npm:<name>'

[ "$#" -eq 1 ] || fail "expects exactly one argument, got $#" "$usage" 2

target="$1"
case "$target" in
  *:*) ;;
  *) fail "'$target' names no registry" "$usage" 2 ;;
esac

registry="${target%%:*}"
name="${target#*:}"

[ -n "$name" ] || fail "'$target' names no artifact" "$usage" 2

# Each registry's canonical anonymous read, and the field in it that *is* the
# version that registry serves: crates.io's own idea of the newest release
# rather than a re-derivation of it here, PyPI's `info.version`, and the
# manifest npm resolves the `latest` dist-tag to. Reading the registry's own
# answer is the point — a probe that recomputed "newest" could disagree with
# what a consumer's installer would actually pick.
case "$registry" in
  crate)
    # crates.io names a crate with the same characters Cargo does.
    [[ "$name" =~ ^[A-Za-z0-9_-]{1,64}$ ]] ||
      fail "'$name' is not a crate name" "$usage" 2
    url="https://crates.io/api/v1/crates/$name"
    ;;
  pypi)
    [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]{0,212}[A-Za-z0-9])?$ ]] ||
      fail "'$name' is not a PyPI project name" "$usage" 2
    url="https://pypi.org/pypi/$name/json"
    ;;
  npm)
    [[ "$name" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$ ]] && [ "${#name}" -le 214 ] ||
      fail "'$name' is not an npm package name" "$usage" 2
    # A scoped name carries a `/`, which is a path separator in the URL unless
    # it is encoded.
    url="https://registry.npmjs.org/${name//\//%2F}/latest"
    ;;
  *)
    fail "'$registry' is not a registry this probe reads" "$usage" 2
    ;;
esac

for tool in curl node; do
  command -v "$tool" >/dev/null 2>&1 ||
    fail "$tool is not on PATH, so '$target' could not be established" \
      "install $tool on the host running this probe; a missing tool is not evidence that '$target' has no release"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A descriptive agent because crates.io requires one, and a bounded, retried read
# because a transient registry blip must not be reported as an answer either way.
if ! status="$(curl --silent --show-error --location \
  --user-agent 'onepipeline-ui-release-probe (https://github.com/nickderobertis/onepipeline-ui)' \
  --connect-timeout 5 --max-time 12 --retry 2 --retry-delay 1 \
  --output "$work/document" --write-out '%{http_code}' \
  "$url" 2>"$work/curl-error")"; then
  cat "$work/curl-error" >&2
  fail "could not reach the registry for '$target'" \
    "re-run this when the registry is reachable; this is NOT an answer that '$target' has no release"
fi

case "$status" in
  200) ;;
  404 | 410)
    # The registry knows the name and serves nothing under it: no release yet.
    exit 0
    ;;
  *)
    fail "the registry answered HTTP $status for '$target'" \
      "re-run this when the registry is healthy; this is NOT an answer that '$target' has no release"
    ;;
esac

# The document parsed and named a version (0), parsed and named none (3), or did
# not parse (anything else) — the same three answers this script has, one layer
# down.
set +e
version="$(node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => {
    let document;
    try {
      document = JSON.parse(input);
    } catch (error) {
      process.stderr.write(`the registry served something that is not JSON: ${error.message}\n`);
      process.exit(1);
    }
    const registry = process.argv[1];
    const served =
      registry === "crate"
        ? (document?.crate?.max_stable_version ?? document?.crate?.newest_version)
        : registry === "pypi"
          ? document?.info?.version
          : document?.version;
    if (typeof served !== "string" || served === "") {
      process.exit(3);
    }
    process.stdout.write(served);
  });
' "$registry" <"$work/document" 2>"$work/read-error")"
read_status=$?
set -e

case "$read_status" in
  0)
    printf '%s\n' "$version"
    ;;
  3)
    # Well-formed, and names no version: the registry has the name and serves no
    # release of it.
    ;;
  *)
    cat "$work/read-error" >&2
    fail "could not read a version out of the registry's answer for '$target'" \
      "check what ${url} serves; this is NOT an answer that '$target' has no release"
    ;;
esac
