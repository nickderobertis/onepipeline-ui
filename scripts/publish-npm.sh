#!/usr/bin/env bash
# Publish npm package directories/tarballs idempotently.
#
# A release job can be re-run — after a flaky sibling job, or to finish a partial
# publish — and an npm version is immutable, so a second `npm publish` of a
# version already live would red-fail a release that actually succeeded. This
# asks the registry first: `npm pack --dry-run` validates each manifest and
# yields its canonical name@version, and only a registry 404 permits publication.
# Auth, network, and server errors fail closed rather than being mistaken for
# "not published yet".
#
# An `npm publish` that exits 0 is not yet a publication. npm's registry can
# *stage* a plain publish — hold it, unserved, until a maintainer approves it
# with 2FA — and answer the PUT with a 2xx the CLI does not read, so npm prints
# `+ name@version` and exits 0 either way. So every publish is followed by a
# read of npm's stage queue, and a version npm staged fails here, naming it and
# its stage id; a queue that cannot be read fails closed like any other read.
#
# A publish npm refuses because it already holds the version — staged, or taken
# and not listed yet — is how a re-run of a release meets what an earlier
# attempt uploaded. A version is immutable, so that upload is what the release
# ships: it is never sent again, and this exits 3, naming each such version and
# any stage id it waits on, for the caller to wait until npm serves it
# (scripts/release.mjs does). Every other failure exits 1.
set -euo pipefail

fail() {
  printf 'publish-npm: %s\n' "$1" >&2
  exit 1
}

[ "$#" -gt 0 ] || fail "pass at least one package directory or tarball"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

published=""
skipped=""
held=""

# The stage id npm holds `name@version` under, or nothing when it staged none.
# Returns 1 when the stage queue cannot be read and 2 when what it answers is
# not one, with npm's own words in "$work/stage-error".
stage_of() {
  local identity="$1" stages
  stages="$(npm stage list "${identity%@*}" --json 2>"$work/stage-error")" || return 1
  # llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] npm publishes no schema for its stage queue; `id`, `packageName` and `version` are the fields its own CLI reads off each entry (`npm stage list` prints them, `npm stage approve` takes the id), and this runs against npm's real registry on every release, where an entry of any other shape is refused below rather than read as no staged version.
  printf '%s' "$stages" | node -e '
    const [name, version] = process.argv.slice(1);
    let input = "";
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      const items = JSON.parse(input);
      const named = key => item => typeof item?.[key] === "string" && item[key] !== "";
      if (!Array.isArray(items) || !items.every(named("packageName")) ||
          !items.every(named("version")) || !items.every(named("id"))) {
        throw new Error("npm stage list did not return staged versions with ids");
      }
      const held = items.find(item => item.packageName === name && item.version === version);
      if (held) process.stdout.write(held.id);
    });
  ' "${identity%@*}" "${identity##*@}" 2>"$work/stage-error" || return 2
  # llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
}

for package in "$@"; do
  if ! metadata="$(npm pack --dry-run --json "$package" 2>"$work/pack-error")"; then
    cat "$work/pack-error" >&2
    fail "cannot read package metadata from '$package'; rebuild the npm artifact with scripts/npm-build.mjs"
  fi
  # The single-quoted program is JavaScript; its template expression is not shell.
  # shellcheck disable=SC2016
  if ! identity="$(printf '%s' "$metadata" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      const items = JSON.parse(input);
      if (!Array.isArray(items) || items.length !== 1 ||
          typeof items[0]?.name !== "string" || typeof items[0]?.version !== "string") {
        throw new Error("npm pack did not return one name/version");
      }
      process.stdout.write(`${items[0].name}@${items[0].version}`);
    });
  ' 2>"$work/metadata-error")"; then
    cat "$work/metadata-error" >&2
    fail "npm returned invalid metadata for '$package'; rebuild the npm artifact with scripts/npm-build.mjs"
  fi

  if npm view "$identity" version >/dev/null 2>"$work/view-error"; then
    skipped="$skipped $identity"
  elif grep -Eq 'E404|404 Not Found' "$work/view-error"; then
    if ! npm publish "$package" --access public >"$work/publish-output" 2>&1; then
      cat "$work/publish-output" >&2
      if grep -Eqi 'cannot publish over (the )?previously (staged|published) version' "$work/publish-output"; then
        # npm holds this version and serves nothing for it: an earlier
        # attempt's upload (see the header). Its stage id, when it has one, is
        # what a maintainer approves to have npm serve it.
        note="it is not listed yet"
        status=0
        stage="$(stage_of "$identity")" || status=$?
        if [ "$status" -ne 0 ]; then
          note="npm's stage queue could not be read to say whether it is staged"
        elif [ -n "$stage" ]; then
          note="it is staged as $stage, which \`npm stage approve $stage\` releases"
        fi
        printf "publish-npm: npm already holds '%s' from an earlier attempt and does not serve it yet (%s); waiting for it rather than publishing it again\n" \
          "$identity" "$note" >&2
        held="$held $identity"
        continue
      fi
      fail "npm could not publish '$identity'; fix the reported authentication or package error, then re-run the release"
    fi
    status=0
    stage="$(stage_of "$identity")" || status=$?
    if [ "$status" -eq 1 ]; then
      cat "$work/publish-output" "$work/stage-error" >&2
      fail "cannot ask npm whether it staged '$identity' rather than publishing it; re-run the release when the npm registry answers"
    elif [ "$status" -ne 0 ]; then
      cat "$work/stage-error" >&2
      fail "npm answered its stage list for '$identity' with something that is not one; re-run the release when the npm registry answers"
    fi
    if [ -n "$stage" ]; then
      cat "$work/publish-output" >&2
      fail "npm staged '$identity' (stage id $stage) instead of publishing it, so it serves nothing; approve it with \`npm stage approve $stage\` and re-run the release, or give the release a credential npm lets publish directly"
    fi
    published="$published $identity"
  else
    cat "$work/view-error" >&2
    fail "cannot query '$identity'; re-run the release when the npm registry is reachable"
  fi
done

# One line for the whole run, whatever it was handed: what a release log needs is
# which versions this push added and which were already live, not a running
# commentary. `# none` keeps the line readable when a re-run publishes nothing.
printf 'publish-npm: published%s; already on npm%s\n' \
  "${published:- none}" "${skipped:- none}"
[ -z "$held" ] || exit 3
