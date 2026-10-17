#!/usr/bin/env bash
# Provision the sibling `onepipeline` CLI at the release the lock pins, into the
# tree — the `_ensure-sibling` recipe's body.
#
# The journeys hold what the read API serves to what this CLI prints, so it has to
# be the release this build links and no other: a stray build on PATH speaks a
# different document. That is why the probe looks at one path, the one the
# justfile exports, and why both ways of filling that path end in the same
# version probe.
#
# Two ways to fill it, in this order:
#   1. the release's own archive for this host's triple, from the onepipeline
#      Release named by the pin, checked against the `.sha256` published beside
#      it. Seconds, where compiling the CLI is the largest single cost of a clean
#      bootstrap — 400-590 s on a Linux runner and 980-1,180 s on Windows.
#   2. `cargo install` of that version, only when the Release carries no archive
#      for this triple. A Release that has one and fails its checksum, or whose
#      binary reports another version, is refused rather than compiled around: an
#      archive that is not what it says it is is a fact somebody has to look at.
#
# Usage:
#   ensure-sibling.sh VERSION
#
# Reads ONEPIPELINE_UI_ONEPIPELINE_BIN, the path the justfile exports, and
# ONEPIPELINE_UI_SIBLING_RELEASES, where the Releases are: an https base URL (the
# default is onepipeline's GitHub Releases) or a local directory laid out the same
# way, `<dir>/v<VERSION>/<asset>`, for a mirror or a machine without the network.
#
# Exit 0: the pinned sibling is at that path. Exit 1: it could not be provisioned,
# named on stderr with what to do. Exit 2: the call was malformed.
set -euo pipefail

fail() {
  echo "ensure-sibling: $1" >&2
  echo "ACTION: $2" >&2
  exit 1
}

version="${1:-}"
binary="${ONEPIPELINE_UI_ONEPIPELINE_BIN:-}"
if [ -z "$version" ] || [ -z "$binary" ]; then
  echo "ensure-sibling: needs the pinned version and ONEPIPELINE_UI_ONEPIPELINE_BIN" >&2
  echo "ACTION: run 'just _ensure-sibling', which passes both" >&2
  exit 2
fi
# The version reaches a URL and a file name, so it is held to what a release
# version looks like rather than trusted.
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || {
  echo "ensure-sibling: '$version' is not a release version" >&2
  echo "ACTION: run 'just _ensure-sibling', which reads it from Cargo.lock" >&2
  exit 2
}

# The probe reads the exported variable instead of having it interpolated into a
# shell line: `justfile_directory()` is separated by backslashes on Windows, which
# that line would spend as escapes, and a probe that cannot resolve reinstalls on
# every run rather than failing — quietly, and only on that platform.
probe() {
  [ "$("$binary" --version 2>/dev/null)" = "onepipeline $version" ]
}
probe && exit 0

install_from_source() {
  cargo install onepipeline --version "$version" --locked --root .tools --quiet ||
    fail "cannot provision onepipeline $version — the journeys that compare the read API against it cannot run without it" \
      "fix the cargo error above (crates.io reachable, toolchain installed), then re-run 'just bootstrap'"
  probe || fail "cargo installed onepipeline $version, but $binary does not report 'onepipeline $version'" \
    "remove .tools and re-run 'just bootstrap'; if it recurs, the crate's binary name or version output changed upstream"
}

host="$(rustc -vV 2>&1)" || fail "rustc -vV failed: $host" \
  "install the toolchain rust-toolchain.toml pins ('rustup toolchain install'), then retry"
triple="$(printf '%s\n' "$host" | sed -n 's/^host: //p')"
[ -n "$triple" ] || fail "rustc -vV named no host triple: $host" \
  "install the toolchain rust-toolchain.toml pins ('rustup toolchain install'), then retry"
case "$triple" in
  *-windows-*) archive_kind="zip"; member="onepipeline.exe" ;;
  *) archive_kind="tar.gz"; member="onepipeline" ;;
esac
# llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] these names are onepipeline's release contract, which its own release workflow writes and no offline copy here could be reconciled against. Drift cannot install a wrong binary: an archive is used only when it matches the checksum published beside it and reports the pinned version, and a renamed asset reads as "no archive", which compiles — the slower, still-correct path — and says so on stderr.
asset="onepipeline-v$version-$triple.$archive_kind"
# The checksum is published beside the archive under the triple's own name.
checksum="onepipeline-v$version-$triple.sha256"
# llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
releases="${ONEPIPELINE_UI_SIBLING_RELEASES:-https://github.com/nickderobertis/onepipeline/releases/download}"
# A mirror is a directory that has to be there: one that is misspelled or
# unreadable would otherwise read as a release without an archive, and compile.
case "$releases" in
  *://*) ;;
  *)
    [ -d "$releases" ] && [ -r "$releases" ] && [ -x "$releases" ] ||
      fail "ONEPIPELINE_UI_SIBLING_RELEASES='$releases' is not a readable directory" \
        "name an existing mirror directory, or unset it to use onepipeline's GitHub Releases"
    ;;
esac

work="$(mktemp -d)" || fail "could not open temporary storage for the download" "free disk space and retry"
trap 'rm -rf "$work"' EXIT

# Fetch one file of the release into the work directory. Answers 0 when it
# arrived, 3 when the Release has no such file, and stops the script on anything
# else: an unreachable host is not evidence that no archive exists.
fetch() {
  local name="$1" code status=0
  case "$releases" in
    # llmlint: ignore-block[changed_behavior_has_e2e] the https branch is the one every `just bootstrap` and every CI job's bootstrap takes, against onepipeline's real Releases; the offline gate cannot reach a forge, and the journeys drive everything after the fetch — checksum, unpack, version probe, and the no-archive fallback — through the mirror branch below, which shares it.
    https://*)
      code="$(curl --proto '=https' --tlsv1.2 --silent --show-error --location \
        --retry 3 --output "$work/$name" --write-out '%{http_code}' \
        "$releases/v$version/$name")" || status=$?
      [ "$status" -eq 0 ] || fail "could not reach $releases for $name (curl exit $status)" \
        "check the network, or point ONEPIPELINE_UI_SIBLING_RELEASES at a reachable mirror, then retry"
      case "$code" in
        200) return 0 ;;
        404) return 3 ;;
        *) fail "$releases answered HTTP $code for $name" "retry once the release host answers" ;;
      esac
      ;;
    # llmlint: ignore-end[changed_behavior_has_e2e]
    *://*)
      fail "ONEPIPELINE_UI_SIBLING_RELEASES='$releases' is neither an https URL nor a directory" \
        "unset it to use onepipeline's GitHub Releases, or name an https base URL or a local mirror directory"
      ;;
    *)
      [ -f "$releases/v$version/$name" ] || return 3
      cp "$releases/v$version/$name" "$work/$name" ||
        fail "could not copy $name out of $releases" "check the mirror directory is readable and retry"
      ;;
  esac
}

# GNU's tool where it runs, else the one macOS ships.
sha256_of() {
  local sum
  sum="$(sha256sum "$1" 2>/dev/null)" || sum="$(shasum -a 256 "$1" 2>/dev/null)" ||
    fail "neither sha256sum nor shasum could hash $1" \
      "install coreutils (sha256sum) or perl's shasum, then retry"
  printf '%s' "${sum%% *}"
}

status=0
fetch "$asset" || status=$?
if [ "$status" -eq 3 ]; then
  echo "ensure-sibling: onepipeline v$version publishes no $asset; compiling it instead" >&2
  install_from_source
  exit 0
fi

status=0
fetch "$checksum" || status=$?
[ "$status" -eq 0 ] || fail "onepipeline v$version publishes $asset but no $checksum to check it against" \
  "report the incomplete release upstream; nothing unverified is installed"
# An unreadable checksum file reads as an empty one, which the comparison below
# refuses with the same diagnostic as a wrong one.
expected="$(cut -d' ' -f1 <"$work/$checksum" 2>/dev/null | tr -d '\r\n')" || expected=""
actual="$(sha256_of "$work/$asset")"
[ -n "$expected" ] && [ "$expected" = "$actual" ] ||
  fail "$asset does not match its published checksum (expected '$expected', got '$actual')" \
    "do not use this archive; retry, and report the release upstream if it still differs"

{ mkdir -p "$work/unpacked" && case "$archive_kind" in
  # llmlint: ignore-block[changed_behavior_has_e2e] the zip branch is Windows', whose journeys cannot pack a fixture zip with any tool the Windows runner is sure to carry; `test-windows`'s own bootstrap takes this branch against onepipeline's real Windows archive on every run, and the checksum and version probe after it are the journeys' shared path.
  zip)
    if command -v unzip >/dev/null 2>&1; then
      unzip -q -o "$work/$asset" "$member" -d "$work/unpacked"
    else
      python3 -m zipfile -e "$work/$asset" "$work/unpacked"
    fi
    ;;
  # llmlint: ignore-end[changed_behavior_has_e2e]
  *) tar -xzf "$work/$asset" -C "$work/unpacked" "$member" ;;
esac; } || fail "could not unpack $member from $asset, although it matches its checksum" \
  "free disk space and retry; if it recurs, the release's archive lacks $member — report it upstream"

directory="$(dirname -- "$binary")"
mkdir -p "$directory" && rm -f "$binary" && cp "$work/unpacked/$member" "$binary" && chmod +x "$binary" ||
  fail "could not install $member into $directory" \
    "check the directory is writable — a container run as root can leave it unwritable — and retry"

probe || {
  reported="$("$binary" --version 2>&1 || true)"
  rm -f "$binary"
  fail "the binary in $asset reports '$reported', not 'onepipeline $version'" \
    "report the mislabelled release upstream; the journeys need exactly the release the lock pins"
}
