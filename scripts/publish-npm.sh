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
      fail "npm could not publish '$identity'; fix the reported authentication or package error, then re-run the release"
    fi
    if ! stages="$(npm stage list "${identity%@*}" --json 2>"$work/stage-error")"; then
      cat "$work/publish-output" "$work/stage-error" >&2
      fail "cannot ask npm whether it staged '$identity' rather than publishing it; re-run the release when the npm registry answers"
    fi
    # llmlint: ignore-block[contracts_have_one_source_or_a_drift_gate] npm publishes no schema for its stage queue; `id`, `packageName` and `version` are the fields its own CLI reads off each entry (`npm stage list` prints them, `npm stage approve` takes the id), and this runs against npm's real registry on every release, where an entry of any other shape is refused below rather than read as no staged version.
    if ! stage="$(printf '%s' "$stages" | node -e '
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
    ' "${identity%@*}" "${identity##*@}" 2>"$work/stage-error")"; then
      cat "$work/stage-error" >&2
      fail "npm answered its stage list for '$identity' with something that is not one; re-run the release when the npm registry answers"
    fi
    # llmlint: ignore-end[contracts_have_one_source_or_a_drift_gate]
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
