#!/usr/bin/env bash
# Affected-only selection, keyed off an explicitly derived base.
#
# Two modes:
#   scripts/nx-affected.sh -t check           run a target over the affected projects
#   scripts/nx-affected.sh --affects PATTERN  print `true`/`false`: is any project the
#                                             Nx pattern names affected (a project
#                                             name, or e.g. `tag:lang:rust`)
#
# The base is one of two things, in this order:
#   ONEPIPELINE_UI_NX_BASE_SHA   a commit, used as given — what a push build passes,
#                                the commit the branch stood at before the push
#   the merge base with a branch ONEPIPELINE_UI_NX_BASE_REF, else GITHUB_BASE_REF
#                                on a pull request, else `main` outside CI
#
# Both modes **fail closed**: when no base can be derived — a shallow clone, a
# missing base branch, a push build handed no commit, a commit that does not
# resolve — this runs everything and says so on stderr rather than reporting a
# scoped pass as a full one. Affected selection is a speed optimisation, and a
# speed optimisation that can silently skip a check is a correctness hole.
#
# llmlint: ignore-file[tool_output_is_signal] the fallback notices say "this ran
# everything, not the affected set" — unrecoverable once green, since both sweeps
# then look identical. They go to stderr; stdout stays one line.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "nx-affected: cannot enter the repository root $ROOT" >&2
  echo "ACTION: run this from a checkout whose directories are readable" >&2
  exit 1
}

# The base branch as GitHub names it on a pull request, or the local default.
#
# `GITHUB_BASE_REF` is workflow-controlled rather than attacker-controlled, but it
# reaches `git fetch` as a refspec, so its shape is validated at the boundary
# instead of trusted: a branch name is what a branch name may look like.
#
# In CI its absence is meaningful rather than missing: a push build is *on* the
# base branch, so scoping against it would find nothing changed and skip every
# check. A push build names its base with ONEPIPELINE_UI_NX_BASE_SHA instead, and
# reaches this only without one — no base, which means run everything.
base_branch() {
  local ref="${ONEPIPELINE_UI_NX_BASE_REF:-${GITHUB_BASE_REF:-}}"
  if [ -z "$ref" ]; then
    if [ -n "${CI:-}" ]; then
      echo "nx-affected: no base branch — this is not a pull-request build" >&2
      return 1
    fi
    printf 'main'
    return 0
  fi
  if ! printf '%s' "$ref" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$'; then
    echo "nx-affected: '$ref' is not a usable branch name" >&2
    return 1
  fi
  printf '%s' "$ref"
}

# The commit a push build names, when it names one: the commit to diff from, and
# one that has to exist here. A value that is set and does not resolve is refused
# rather than passed over to the branch below it — whoever set it meant this
# commit and no other — and the refusal names the variable, because the full
# sweep it falls back to looks like any other green run once it passes.
#
# A shape check comes first for the reason `base_branch` gives: the value reaches
# git as an argument, and a commit is what a commit may look like. GitHub's
# all-zero `before` — a push that created the branch — has that shape and names
# no commit, so it is refused by the resolution like any other unknown one.
base_commit() {
  local sha="$ONEPIPELINE_UI_NX_BASE_SHA"
  if ! printf '%s' "$sha" | grep -Eq '^[0-9a-fA-F]{7,64}$'; then
    echo "nx-affected: ONEPIPELINE_UI_NX_BASE_SHA='$sha' is not a commit id" >&2
    return 1
  fi
  if ! git rev-parse --quiet --verify "$sha^{commit}" 2>/dev/null; then
    echo "nx-affected: ONEPIPELINE_UI_NX_BASE_SHA=$sha does not resolve to a commit in this checkout" >&2
    return 1
  fi
}

# The base to diff from, or nothing when it cannot be derived.
resolve_base() {
  if [ -n "${ONEPIPELINE_UI_NX_BASE_SHA:-}" ]; then
    base_commit
    return
  fi
  local branch
  branch="$(base_branch)" || return 1
  # A PR runner's checkout has the base branch only as a remote-tracking ref if
  # it was fetched; fetch it before asking for the merge base so detection does
  # not depend on how deep the checkout happened to be.
  if [ -n "${CI:-}" ]; then
    git fetch --no-tags --quiet origin \
      "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null || true
  fi
  git merge-base "origin/$branch" HEAD 2>/dev/null || return 1
}

case "${1:-}" in
--affects)
  pattern="${2:-}"
  [ -n "$pattern" ] || {
    echo "nx-affected: --affects needs a project name or an Nx project pattern" >&2
    exit 2
  }
  if ! base="$(resolve_base)"; then
    echo "nx-affected: no base — treating '$pattern' as affected" >&2
    printf 'true\n'
    exit 0
  fi
  # Nx resolves the pattern itself — an exact name, a glob, or `tag:` — so a
  # project whose name is a substring of another's cannot answer for it, and a
  # pattern naming nothing is an empty answer rather than a match.
  if ! projects="$(bash scripts/nx.sh show projects --affected --base="$base" --head=HEAD \
    --projects "$pattern" --json)"; then
    echo "nx-affected: Nx could not list the affected projects — treating '$pattern' as affected" >&2
    printf 'true\n'
    exit 0
  fi
  # Read as a parsed JSON array rather than by grepping the text, which is the one
  # shape Nx promises on stdout.
  if printf '%s' "$projects" |
    node -e 'const fs=require("node:fs");process.exit(JSON.parse(fs.readFileSync(0,"utf8")).length>0?0:1)'; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
  ;;
*)
  [ "$#" -gt 0 ] || {
    echo "nx-affected: pass the Nx arguments to run, e.g. '-t check'" >&2
    exit 2
  }
  if ! base="$(resolve_base)"; then
    echo "nx-affected: no base — running every project instead of the affected ones" >&2
    exec bash scripts/nx.sh run-many "$@"
  fi
  exec bash scripts/nx.sh affected --base="$base" --head=HEAD "$@"
  ;;
esac
