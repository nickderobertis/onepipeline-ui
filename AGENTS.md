# AGENTS.md

Durable instructions for humans and agents working in this repo. Write for a
future maintainer, not as a session log. Deterministic steps live in `scripts/`
and the `justfile`; this file holds the judgment.

> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` only.

## What this repo is

The read API and browser view for onepipeline runs: a Rust (axum) server
wrapping the onepipeline SDK, and the frontend that reads it. It ships one crate
(`onepipeline-ui`, a library plus a CLI) distributed on crates.io and, as thin
prebuilt-binary wrappers, on PyPI and npm as `onepipeline-ui-cli`.

**It is landed interface-only today.** [`docs/contract.md`](docs/contract.md) is
the wire contract, quoted verbatim from the task that commissioned this repo and
never edited to suit the code. `src/` is its Rust rendering — route table,
envelope, identifiers, queries, error contract, the `ReadApi` trait, and the CLI
— with no request-serving behind it; `onepipeline-ui serve` exits `70`. Two
consequences that outlive this phase:

- **The contract is the source of truth, in that direction only.** If the code
  and `docs/contract.md` disagree, the code is wrong. A change to the contract is
  a decision made outside this repo and quoted in; `tests/contract.rs` fails the
  gate on drift either way.
- **Payload records come from the onepipeline SDK, not from here.** Anything
  presentation-worthy is computed in the SDK/CLI first, so the agent reading the
  CLI has at least the visibility the human in the UI has. That is why payloads
  are `serde_json::Value` and the fixtures pin only the envelope: inventing
  record types here would put the second-best source of truth in the wrong repo.

## Two standing goals on every task

The user drives product features and their request is the priority — but carry
two goals into *every* task. When either is the lowest-error path to what the
user asked, fold it into the same task without asking first; surface the rest as
follow-ups.

1. **Engineer the context for next time.** Realistic end-to-end tests that
   exercise what the user actually sees — especially for a bug existing tests
   missed — scripts that automate repetitive steps and shrink their output to
   signal, and terse notes here for what the code doesn't make obvious.
2. **Engineer the codebase and environment.** Keep it clean, maintainable, and
   repeatable: `just bootstrap` from a clean clone, the same checks and the same
   pinned toolchain locally and in CI.

## Stack and composition

How this repo was built up from the create-repo reference pieces:

- **Product shape:** `cli` — a Rust library plus the binary that will serve the
  contract. Composed additionally with the `react` shape (which pulls in
  `web-app`) because the frontend lands in this repo, against this API.
- **Language(s):** Rust (cargo, rustfmt, clippy, nextest, llvm-cov) for the
  crate; TypeScript/JavaScript for the npm launcher today and the frontend app
  when it lands; Bash for provisioning and wrappers; YAML, JSON, and TOML for
  configs.
- **Composed:** `base.md` + `ci.md` (always) + `shapes/cli.md` +
  `shapes/web-app.md` + `shapes/react.md` + `languages/rust.md` +
  `languages/typescript.md` + `intersections/rust-cli.md` + `releasing.md`
  (`--releasing`) + `monorepo.md` (`--monorepo`), plus the `llmlint` LLM-judge
  tier. Nx provides the project graph, affected execution, and caching; the
  language-native tools remain the source of each check.
- **Excluded, and why:** **asdf / direnv** — the committed `rust-toolchain.toml`
  and lockfiles already pin the toolchain reproducibly. **A second Nx project for
  the npm launcher** — it is a committed 90-line shim with no build step, driven
  end to end by `tests/e2e/packaging.rs`; a project whose only target ran a
  formatter would be graph noise. The frontend app brings the second project when
  it lands. Nothing non-negotiable is excluded: the gate is strict, the e2e is
  real, and CI proves the artifact on the platform matrix.

## Command surface

Use the `just` recipes (`just --list` is the index); do not hand-roll
equivalents. `just bootstrap` sets up from a clean clone; `just check` is the
deterministic gate; **`just gate` is the complete pre-push bar** — `check` plus
the diff-scoped llmlint tier. `just deps-check` (advisories, licenses, unused
deps) is deliberately outside both: it needs a network advisory database, and the
gate stays offline.

The repo-wide verbs delegate to Nx, which fans one uniformly-named target across
every project. What a target *does* stays with its project — the `_crate-*`
recipes are the Rust crate's own tools, named by `project.json`. Adding a project
means adding its `project.json`, its `CODEOWNERS` line, and a nested `AGENTS.md`.

## Commits, releases, and merging

- **Squash-merge only, via PR, with auto-merge.** The default branch is
  protected: merge commits and rebase-merging are disabled, so one PR is one
  squash commit whose subject is the PR title. Queue with
  `gh pr merge --auto --squash`; merged head branches auto-delete. Admins may
  bypass in a break-glass.
- **All gating checks are required**, including the full-e2e `gate` job and the
  separate `llmlint` job. `published-smoke` is *not* required and cannot be:
  branch protection lists contexts a pull request reports, and it runs on a
  schedule.
- **PRs follow the template** (`.github/pull_request_template.md`): terse
  **What** and **Why**. It becomes the squash commit body.
- **Releases are fully automated; the only human action is merging a PR.**
  Conventional Commits drive it. release-plz (`release-plz.toml`) is the single
  version driver — it computes the version, writes `CHANGELOG.md` and the
  manifests, tags `vX.Y.Z`, and cuts the Release; that Release fires
  `release.yml`, which builds and publishes. Pre-1.0: `feat` → minor,
  `fix`/`perf`/`refactor`/`build` → patch, `!`/`BREAKING` → minor;
  `chore`/`docs`/`ci`/`test`/`style` do not release. **Never hand-edit a version**
  — `pyproject.toml` takes it from Cargo.toml via `dynamic = ["version"]` and the
  npm packages via `scripts/npm-build.mjs`, so a literal version anywhere else is
  a second source to drift.
- **release-plz authenticates with `RELEASE_PLZ_TOKEN`, a PAT, not the default
  `GITHUB_TOKEN`.** A tag or Release created by `GITHUB_TOKEN` triggers no
  workflow, so `release.yml` would never run and the release would ship nothing.
  `gh-secrets.json` names every secret the workflows read.

## Invariants (non-negotiable)

- The gate is strict: format check, clippy `-D warnings`, tests, and rustdoc all
  fail on issues — no warnings-only mode.
- **Coverage is enforced at 95% line coverage** (`cargo llvm-cov nextest
  --fail-under-lines 95`); the gate fails below it.
- **Tests are realistic, not mocked.** The e2e suite spawns the compiled binary
  as a subprocess and asserts on exit code, stdout, and stderr, and drives the
  committed npm launcher under a real node through node's own module resolution.
  Nothing under test is stubbed.
- **Validate external input at the trust boundary.** Every `{...}` a route
  interpolates is a validated identifier newtype, constructible only through
  `TryFrom`; a raw `String` must never reach storage.
- **Exit codes are a contract**: `0` on success, `2` on a usage error (clap),
  `70` when a command parsed but is not implemented. `scripts/smoke-published.sh`
  asserts all three against every published artifact.
- Do not commit secrets. Values live in the platform secret store, referenced by
  name in `gh-secrets.json`; the agent allowlist in `.claude/settings.json` stays
  narrow.

## Tests are context engineering

This repo runs on agents, so the suite is the only QA loop.

- `tests/contract.rs` holds the crate to `docs/contract.md`: every route is in
  both, every fixture round-trips **byte for byte**, and the envelope carries
  schema 10. The fixtures pin the *envelope*; their payload bodies carry only the
  facts the contract itself names and are not a claim about the SDK's records.
- `tests/packaging.rs` is the distribution drift gate across Cargo.toml,
  `pyproject.toml`, the npm launcher, and `release.yml` — the manifests that
  describe one artifact and would otherwise only disagree in public, mid-release.
- `tests/e2e/` is the real-journey tier. A new CLI verb isn't done until its
  journey — happy path *and* failure — lands there.

## Keeping the allowlist current

The allowlist lives in `.claude/settings.json` and the tool enforces it. Your job
is to keep it current: add a new routine command there rather than re-approving
it every session, and keep it narrow.
