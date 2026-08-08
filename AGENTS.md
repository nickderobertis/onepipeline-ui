# AGENTS.md

Durable instructions for humans and agents working in this repo. Write for a
future maintainer, not as a session log. Deterministic steps live in `scripts/`
and the `justfile`; this file holds the judgment. Rules scoped to a subtree go in
that subtree's `AGENTS.md` (see `tests/AGENTS.md`).

> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` only.

## What this repo is

The read API and browser view for onepipeline runs: a Rust (axum) server wrapping
the onepipeline SDK, and the frontend that reads it. One crate
(`onepipeline-ui`, library + CLI) ships on crates.io and, as thin
prebuilt-binary wrappers, on PyPI and npm as `onepipeline-ui-cli`.

**It is landed interface-only today.** `src/` renders
[`docs/contract.md`](docs/contract.md) as types with nothing behind them;
`onepipeline-ui serve` exits `70`. Two rules outlive that phase:

- **The contract is the source of truth, in that direction only.** If the code
  and `docs/contract.md` disagree, the code is wrong. The contract is quoted in
  from a decision made outside this repo — never edited to suit the code, and
  never to satisfy a lint.
- **Payload records come from the onepipeline SDK, not from here.** Anything
  presentation-worthy is computed in the SDK/CLI first, so the agent reading the
  CLI has at least the visibility the human in the UI has. That is why payloads
  are `serde_json::Value` and this crate owns only the envelope: inventing record
  types here would put a second source of truth in the wrong repo.

## Two standing goals on every task

The user drives product features and their request is the priority — but carry
two goals into *every* task, folding either into the same task when it is the
lowest-error path to what was asked and surfacing the rest as follow-ups:
**engineer the context for next time** (real e2e for what the user sees, scripts
for steps done by hand, a terse note here for what the code doesn't show), and
**engineer the codebase and environment** (clean, repeatable, `just bootstrap`
from a clean clone, the same checks and pins locally and in CI).

## Stack and composition

Recorded because the create-repo skill requires the composition to be auditable,
and because nothing else recovers *why* the tooling is what it is.

- **Shape:** `cli`, composed additionally with `react` (which pulls in
  `web-app`) — the frontend lands in this repo, against this API.
- **Languages:** Rust (crate), TypeScript/JavaScript (npm launcher today, the
  app later), Bash, and YAML/JSON/TOML config.
- **Composed:** `base` + `ci` + `shapes/{cli,web-app,react}` +
  `languages/{rust,typescript}` + `intersections/rust-cli` + `releasing` +
  `monorepo`, plus the `llmlint` judge tier. Nx owns the project graph, affected
  selection, and caching; the language-native tools remain the source of each
  check.
- **Excluded:** asdf/direnv — `rust-toolchain.toml` and the lockfiles already
  pin reproducibly. A second Nx project for the npm launcher — it is a committed
  shim with no build step, driven end to end by `tests/e2e/packaging.rs`; the
  frontend brings the second project. No invariant is excluded.

## Command surface

`just --list` is the index; do not hand-roll equivalents. **`just gate` is the
complete pre-push bar** — the deterministic `just check` plus the diff-scoped
llmlint tier. `just deps-check` is deliberately outside both: it needs a network
advisory database, and the gate stays offline.

The repo-wide verbs delegate to Nx, which fans one uniformly-named target across
every project; what a target *does* stays with its project. Adding a project
means adding its `project.json`, its `CODEOWNERS` line, and — where its rules
differ from these — a nested `AGENTS.md`.

## Commits, releases, and merging

- **Squash-merge only, via PR, with auto-merge.** The default branch is
  protected: merge and rebase merging are off, so one PR is one squash commit
  whose subject is the PR title. Queue with `gh pr merge --auto --squash`. Admins
  may bypass in a break-glass.
- **All gating checks are required**, including the `gate` job and the separate
  `llmlint` job. `published-smoke` is *not* required and cannot be: branch
  protection lists contexts a pull request reports, and it runs on a schedule.
- **Releases are fully automated; the only human action is merging a PR.**
  release-plz is the single version driver — it computes the version, writes
  `CHANGELOG.md` and the manifests, tags `vX.Y.Z`, and cuts the Release, which
  fires `release.yml`. Pre-1.0: `feat` → minor, `fix`/`perf`/`refactor`/`build`
  → patch, `!`/`BREAKING` → minor; `chore`/`docs`/`ci`/`test`/`style` do not
  release.
- **Never hand-edit a version.** `pyproject.toml` takes it from Cargo.toml via
  `dynamic = ["version"]` and the npm packages via `scripts/npm-build.mjs`, so a
  literal version anywhere else is a second source to drift.
- **release-plz authenticates with `RELEASE_PLZ_TOKEN`, a PAT, not the default
  `GITHUB_TOKEN`.** A tag or Release created by `GITHUB_TOKEN` triggers no
  workflow, so `release.yml` would never run and the release would ship nothing.
  `gh-secrets.json` names every secret the workflows read.

## Invariants (non-negotiable)

- The gate is strict: no warnings-only mode anywhere. A diagnostic is an error or
  a suppression with a written reason at the narrowest scope the tool allows.
- **Coverage is enforced at 95% line coverage**; the gate fails below it.
- **Tests are realistic, not mocked, and complete, not minimal** — see
  `tests/AGENTS.md`.
- **Validate external input at its trust boundary.** Every `{...}` a route
  interpolates is a validated identifier newtype constructible only through
  `TryFrom`; a raw `String` must never reach storage. CLI arguments are validated
  by their `value_parser`, before anything binds a port.
- **Exit codes are a contract**: `0` on success, `2` on a usage error, `70` when
  a command parsed but is not implemented. `scripts/smoke-published.sh` asserts
  all three against every published artifact, on every platform.
- Do not commit secrets. Values live in the platform secret store, referenced by
  name in `gh-secrets.json`; the allowlist in `.claude/settings.json` stays
  narrow, and keeping it current — rather than re-approving a routine command
  every session — is part of the work.
