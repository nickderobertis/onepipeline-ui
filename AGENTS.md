# AGENTS.md

Durable instructions for humans and agents working in this repo. Write for a
future maintainer, not as a session log. Deterministic steps live in `scripts/`
and the `justfile`; this file holds the judgment.

> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` only.

## What this repo is

The read API and browser view for onepipeline runs: a Rust (axum) server wrapping
the onepipeline SDK, and the frontend that reads it.

Two things ship, split by what they contain. The crate `onepipeline-ui`
(library + CLI) goes to crates.io and, as thin prebuilt-binary wrappers, to PyPI
and npm as **`onepipeline-api-cli`** — that is the read-API server. The React
app goes to npm alone as **`onepipeline-ui`**, which carries the built frontend
rather than a binary. The crate keeps its `onepipeline-ui` name, matching the
repository; the command it installs is **`onepipeline-api`**, because a command
called `onepipeline-ui` would be handed out by the wrapper while the package
actually named `onepipeline-ui` installs no command at all. `tests/packaging.rs`
holds every distribution to that split.

`onepipeline-ui-cli` is a fourth name, retired rather than renamed: it is what
the wrappers published as up to v0.1.0, and npm and PyPI still serve that
version under it. Nothing here publishes it again, so a consumer pinning
`onepipeline-ui-cli` is pinned to 0.1.0 and has to move to
`onepipeline-api-cli`. `PYPI_TOKEN` must therefore be account-scoped: a token
scoped to the old project cannot create the new one.

Two rules govern what may be written here:

- **[`docs/contract.md`](docs/contract.md) is the source of truth, in that
  direction only.** If the code and the contract disagree, the code is wrong.
  The contract is quoted in from a decision made outside this repo — never
  edited to suit the code, and never to satisfy a lint.
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
pre-push bar.** `just bootstrap` also provisions the `onepipeline` CLI at the
version the lock pins its library to, into `.tools/`: the read API asks it for
each run's telemetry document, the two speak a versioned document, and a
mismatched pair serves every run with no clock at all. `/healthz` reports that
release from `onepipeline::VERSION`, so a host pinning the engine that writes a
run store and this reader of it separately can *prove* the two match rather than
assume it. The SDK pin and `tests/fixtures/healthz.json` move together.

**`oneagentgraph` is not pinned here: the SDK's requirement decides it and the
lock follows.** Cargo unifies one version of it across this crate and
`onepipeline`, and that library has shipped a breaking field in a *patch*
release, so `cargo update` on it can hand the pinned SDK a sibling it does not
compile against. Move it only by moving the SDK. Sharing one resolution is also
what lets `tests/contract.rs` hold this crate's copy of the shared filter grammar
to `oneagentgraph`'s own declaration of it rather than to a second reading of the
wire. `just deps-check` is deliberately outside the gate: it needs a network
advisory database, and the gate stays offline and deterministic.

Adding a project means adding its `project.json` and its `CODEOWNERS` line; Nx
fans one uniformly-named target across all of them.

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
- **`[package] include` in Cargo.toml is the release trigger, not just the crate
  tarball.** release-plz opens a release PR only when one of the crate's
  *packaged files* changed, and that is the only lever it offers. One version
  stamps three deliverables here, so the set covers everything whose bytes reach
  any of them — including the frontend the `onepipeline-ui` npm package ships,
  whose sources ride along in the crate tarball as the price. Anything a
  published artifact carries has to be added there, and `tests/packaging.rs`
  fails if it is not.
- **A release that did not publish must not look like one.** `release.yml`'s
  last job runs `scripts/release-status.sh` over every other job's result: if a
  job the operator's switches say had to succeed did not, the GitHub Release is
  demoted to a prerelease with a banner naming the jobs, and the job fails. The
  tag is never touched — tags here are immutable — so the recovery for any
  stranded version is the next patch version, never a re-run of its tag, whose
  tree is the one that failed. v0.2.0 and v0.3.0 are stranded that way and stay
  unpublished.
- **A tag is not evidence of a release; the registry is.** Check what npm, PyPI
  and crates.io serve before reporting a version shipped.
- **The bump is read off the public surface, and a green reading is only as good
  as a baseline that builds.** `semver_check = true` has release-plz diff the API
  against the last release with cargo-semver-checks, so a breaking change no
  longer depends on someone remembering the `!`. The trap is that release-plz
  reports a check it *could not run* as "API compatible" rather than as a failure,
  and cargo-semver-checks builds both sides through a generated manifest that
  never reads a lockfile — so a released manifest's open requirement resolves to
  whatever is newest, which for v0.3.3 is an SDK that no longer compiles. The
  release workflow therefore fetches what each side's lock pins and resolves
  offline, and runs the check itself first for its exit code alone: a run that
  returns no verdict fails the release rather than passing as compatible. A
  surprisingly compatible verdict is the first thing to disbelieve.
- **release-plz authenticates with `RELEASE_PLZ_TOKEN`, a PAT, not the default
  `GITHUB_TOKEN`.** A tag or Release created by `GITHUB_TOKEN` triggers no
  workflow, so `release.yml` would never run and the release would ship nothing.
  `gh-secrets.json` names every secret the workflows read.

## Invariants (non-negotiable)

- The gate is strict: no warnings-only mode anywhere. A diagnostic is an error or
  a suppression with a written reason at the narrowest scope the tool allows.
- **Coverage is enforced at 95% line coverage**; the gate fails below it. That
  is the Rust crate's floor, measured by `cargo llvm-cov`. The frontend is held
  to its journeys rather than to a number.
- **Tests are realistic, not mocked, and complete, not minimal.** Nothing under
  test is stubbed, and a change is not done until a real journey covers it —
  happy path and at least one failure a user can cause.
- **A filter shapes a response and never the run.** `?filter=` narrows the
  *events* a payload lists; every status, settlement, decision, count and timing
  beside them is folded from the whole journal whatever it said. A reader who
  narrowed their attention must be shown the same graph, in the same states, as
  one who asked for everything. It reaches the events a timeline span lists and
  the transcripts a detail lists, and nothing else.
- **Validate external input at its trust boundary.** Every `{...}` a route
  interpolates is a validated identifier newtype constructible only through
  `TryFrom`; a raw `String` must never reach storage, and a runs root is a
  `RunsRoot`, which exists only once the directory has been read. Both the CLI
  and a config file construct them the same way, so neither can carry a value
  the other would reject.
- **Exit codes are a contract**: `0` on success, `2` on a usage error, `70` when
  a command parsed but is not implemented. `scripts/smoke-published.sh` asserts
  all three against every published artifact, on every platform. Being asked to
  stop is a success too, and that one is the *wrapper's* contract as much as the
  binary's: a supervisor signals whatever it started, which for npm is the node
  launcher in front of the binary. `src/server.rs` is the one source for which
  stops are honoured and `tests/packaging.rs` holds the launcher and the
  journeys to it — v0.3.1 shipped exiting 143 with the binary already correct.
- Do not commit secrets. Values live in the platform secret store, referenced by
  name in `gh-secrets.json`; the allowlist in `.claude/settings.json` stays
  narrow, and keeping it current — rather than re-approving a routine command
  every session — is part of the work.
