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
- **Languages:** Rust (crate), TypeScript/JavaScript (the npm launcher and the
  frontend workspace), Bash, and YAML/JSON/TOML config.
- **Composed:** `base` + `ci` + `shapes/{cli,web-app,react}` +
  `languages/{rust,typescript}` + `intersections/rust-cli` + `releasing` +
  `project-graph` (the skill's former `monorepo`), plus the `llmlint` judge tier.
  Nx owns the project graph, affected selection, and caching; the language-native
  tools remain the source of each check.
- **Package manager:** bun, the skill's default — nothing here rules it out.
  One `bun.lock` pins `apps/*` and `packages/*`; `scripts/workspace-install.sh`
  installs it with `--frozen-lockfile` and refuses a bun older than
  `package.json`'s `packageManager`, the one pin, which every CI job's
  `oven-sh/setup-bun` reads too. Node still runs what bun installs (Nx, Vite,
  Vitest, Playwright; the targets' `npx` only runs those installed binaries),
  and the same script holds it to `engines.node`.
  npm stays where the registry is the subject rather than this workspace:
  `npm pack`/`npm publish` of what `scripts/npm-build.mjs` assembles, the
  release jobs' `test-install` and `verify` installs that prove what an npm
  user gets, and global installs of harness CLIs and of bun itself in the
  visual-docs container. Siblings are named `workspace:*`; none of those
  manifests is published.
- **Excluded:** asdf/direnv — `rust-toolchain.toml` and the lockfiles already
  pin reproducibly. A second Nx project for the npm launcher — it is a committed
  shim with no build step, driven end to end by `tests/e2e/packaging.rs`; the
  frontend brings the second project. No invariant is excluded.

## Command surface

`just --list` is the index; do not hand-roll equivalents. **`just gate` is the
pre-push bar.** `just bootstrap` also provisions the `onepipeline` CLI at the
version the lock pins its library to, into `.tools/`, and it is **only the
journeys that need it**: the server itself runs no `onepipeline` binary, for
anything — every verb it serves, the telemetry fold included, is a call into the
SDK it links — so the CLI is there for the comparisons in `tests/e2e/server.rs`
that hold what the server served to what `onepipeline telemetry`, `results`,
`goals`, `transcript` and `unwatched` print over the same run. The two speak
one document because they are one library at one version, which is why the
sibling is pinned to the lock rather than taken from `PATH`. `/healthz` reports
that release from `onepipeline::VERSION`, so a host pinning the engine that
writes a run store and this reader of it separately can *prove* the two match
rather than assume it. The SDK pin and `tests/fixtures/healthz.json` move
together.

**The binary embeds the browser view, so the crate's test tiers build the
frontend first.** `build.rs` compiles whatever `apps/dag-ui/dist` holds into
`onepipeline-api` for `serve --ui`, and the `ui::` journeys read that view back
off a port against the bundle on disk — so every tier of the crate's suite and
`dag-ui:build-api-server` depend on `dag-ui:build` through Nx, `check-cross`
reaches the same build through the tiers' `test-quick` targets, and
`tests/e2e/ensure_sibling.rs` holds that graph. A binary
compiled before the bundle exists carries nothing and refuses `--ui`, which is
the right answer for a `cargo install` from crates.io and the wrong one for a
test tier or a release: the `bundled-ui` feature makes a missing bundle a build
error, every release job that compiles the binary turns it on after `just
build`, and `tests/packaging.rs` reads each of those jobs for both halves.

**`just check` needs one tool no lockfile can pin: `strace`, on Linux.** The
cost journeys count what the server asks the kernel for, and fail rather than
skip without it; a bare `just test` does not need it. `ci.yml`'s `test-linux`
installs it.
The judged tier's journeys likewise need the real `llmlint`, which `just
setup-llmlint` installs; every CI job that can run them calls that recipe.

**The tier that needs that CLI provisions it; `bootstrap` is not the only path to
it.** Everything else a tier needs lands in a user-wide cache that outlives any
one clone, so `.tools/` is the one thing a fresh clone lacks — and a fresh clone
is where the gate is asked to rule, because `onevcs publish-branch` cuts one.
A new project whose tests start the read API joins that dependency. Reaching the
recipe from more places must never soften it: falling back to a build on PATH is
the failure the pin exists to prevent. It is fetched as that release's own
archive for the host, held to the `.sha256` published beside it and to its
`--version`, and compiled only when the release ships no archive for the host
(`scripts/ensure-sibling.sh`); an archive that fails either check is refused, never
compiled around. A git pin (fast adoption of an unreleased engine commit) is
compiled from that exact commit and never fetched, because the commit still
reports the last release's version: the binary is stamped with the lock's source
and its own digest, and a same-version build from anywhere else is replaced.

**Pull-request CI is four jobs, each one recipe, and a report job after them.**
`lint`, `test-linux`, `test-windows` and `test-macos`, and their caps (36 minutes
for Linux, 30 for the others), are an interface other work builds against
(`.github/tests/ci-jobs.test.mjs`); speed a job up by cutting its work, never by
splitting one suite across more jobs. `docs/release-sweep-timing.md` records the
measurements and margin behind Linux’s cap. No other workflow runs on a pull
request's `opened`, `synchronize` or `reopened` — `visual-docs.yml` runs on its
`closed` only, to delete a preview (idle while `lint`'s `VISUAL_DOCS_PUBLISH`
is off, which keeps that job inside its cap: no pull request gets a gallery
preview or the visual-docs comment, though the capture and both gates still
block) — and `.github/tests/ci-shape.test.mjs`
resolves every workflow to hold that, and what a push to `main` and the release
commit start. The fifth, `budgets`, is the released `onebudgetspec-github-action`
under `needs` and `if: always()`, on every pull request and alone of `ci.yml` on
every push to `main`: it builds and tests nothing, gives each production budget one
row, and fails only on an ordinary budget verdict. A budget whose input the job
lacks reads as unavailable because its `command` names that input, so name a
budget's saved telemetry or required file there, or its absence reads as a broken
measurement; `release-tail` and `host-variable` are report-only here
(`enforcement-exclude-labels`) because they measure elsewhere.
`.github/reporting` holds the job's journeys and its own budget. A base push saves
rolling history even when the job's own budget is its only measurement, and a pull
request reads it back as that budget's baseline samples.

**A security advisory blocks only the change that brings it in.** A database
update publishes advisories against versions `main` already resolves, and an
audit that failed on any of them held every change and release until someone
merged past it by hand (RUSTSEC-2026-0433, pulldown-cmark 0.13.5). So `lint`'s
audit blocks on an advisory only when the base's `Cargo.lock` did not resolve
that version, and every advisory is reported, red until fixed, as the
informational `advisories` status that nothing may require or wait on.
`scripts/deps-audit.mjs` says how and `.github/required-contexts.mjs` is the
check contract. A fork's pull request gets the report only in `lint`'s summary
and log: the manager ruled out a privileged `workflow_run` job to post it. Never
ignore an advisory in `deny.toml` to get a change through.

**The four jobs share Nx test results separately from the Rust build cache.**
`scripts/nx-remote-cache.mjs` records trusted same-repository PR entries and
promotes them in the existing release-plz job before it updates the release PR.
Fork and Dependabot PRs read only. The script and version-free manifest digests
are upstream-owned copies; the workflow suite holds their bytes to create-repo.
Formatters and linters keep raw manifests where they check their text; semantic
consumers use version-free manifest digests. Runtime manifest consumers carry an uncached
`manifest-inputs-for-affected` no-op target: its raw file inputs preserve Nx
selection without changing the cached targets’ semantic hashes. CI never runs it. Version/changelog edits retain source
and dependency hashes; the `versions`,
npm-launcher and release tiers keep the version where their tests read it.
Rust coverage producers and the aggregate stay uncached: LLVM profiles cannot
cross a package-version rebuild. The 95% floor still applies. Cached outputs
name reports, never build directories; release rehearsal and frontend/package
builds also stay uncached. Reports and promotion receipts feed the
release-tail cache-use figure; missing evidence never counts as replay. Nested Nx
fixtures isolate their cache and telemetry context from the outer CI run. Every
release PR runs all four jobs through the same steps as any other PR; no
branch-name or version-only classifier bypasses its macOS lane.

**The four jobs restore `main`'s Rust build and save none.** `ci-cache.yml` is
the producer: on every push to `main` one build-only job per OS
(`scripts/ci-warm.sh`, `just ci-warm-<os>`) compiles what that OS's jobs compile
and saves it under the key they restore, with the sibling CLI and the base
server. Its compile list is held to the tasks the four jobs reach in the real Nx
graph (`.github/tests/ci-warm.test.mjs`), so a recipe whose cargo arguments or
target directory change must change its warm line too. Its macOS job is the one
Mac run a merge adds, which the macOS runs-per-change budget accounts for.

**`.tools/` holds a second clone-local binary, and it is the server this branch
forked from.** `tests/e2e/baseline.rs` asks whether every field the base commit
served is served now — a question no fixture on a branch can answer, because a
fixture is editable by the change it is meant to hold. Compiling another commit
of this repository is the expensive half of that, so it lives behind
`onepipeline-ui:ensure-baseline` rather than inside the suite: an unrelated change
to a workflow, a script or a document must not rebuild a second server. **The
journeys sit behind an edge of their own for the same reason**, so that nothing
but the comparison pays for the comparison. Splitting a tier out that way is what
lets it run *nowhere*, and caching one is what lets it replay a verdict about a
commit this branch no longer forks from — no file says which commit that is, and
no reading of the payload can tell you it was the wrong one. The binary
is stamped with the commit it was built from and the journeys refuse a stamp that
names anything but this branch's base, because a stale server answers every
request and reports that nothing was dropped between a pair it was never asked
about. The cross-platform legs skip that comparison on the terms they skip
coverage — it is a property of the payload, not of the platform.

**`oneagentgraph` is not pinned here: the SDK's requirement decides it and the
lock follows.** Cargo unifies one version of it across this crate and
`onepipeline`, and that library has shipped a breaking field in a *patch*
release, so `cargo update` on it can hand the pinned SDK a sibling it does not
compile against. Move it only by moving the SDK. Sharing one resolution is also
what lets `tests/contract.rs` hold this crate's copy of the shared filter grammar
to `oneagentgraph`'s own declaration of it rather than to a second reading of the
wire. `just deps-check` is deliberately outside the gate: it needs a network
advisory database, and the gate stays offline and deterministic.

**Budget reports.** Approved budget thresholds alone decide failures: the required
`budgets` check goes red only on an ordinary budget verdict, and the budget stays the
requirement. CI artifacts retain the base branch's recent measurements for informational
comparison, and each report states their provenance, retention and coverage. A stored
measurement is never a line to hold.

1. When a performance problem appears that a failing budget check does not already identify (for example a CI timeout), read the PR report first through `onevcs change comments` or the host PR view. If the failing check already identifies it, skip the duplicate read. Read earlier PR comments and job results when several changes may contribute.
2. Never time base versus branch on a shared host. Profile to investigate, and use CI comparisons through the repository's existing publication path.
3. When reading a report or seeing a failing budget check, fix the regression as part of the work. For an adverse change of at least one standard deviation shown in a report being read (a `max` budget rising, a `min` budget falling), make the change cheaper or make room in existing code, profiling to find where. Improvements show numbers without flags, in a row's history too, and are no reason to optimize further, and other figures need no work. Informational flags do not fail a check or start other work.
4. Stay inside existing budgets. Make room for new tests and code by speeding up existing work; never raise limits or timeouts.
5. Suspect the current change first when something degrades, before intermittent slowness or the outside world.

**Bootstrap installs no Git hooks.** Local pushes run no capture or classification;
CI owns verification. Existing `core.hooksPath` settings are left alone so unrelated
hooks remain active. `just gate` remains a deliberate manual check.

**The judged tier is plain llmlint under Nx's cache, with no wrapper of ours.**
A pass is replayed only for the tree, base commit and judge digest that produced
it and a failure is always re-judged; a gap in that belongs in llmlint, Nx or the
recipe's run configuration, never in a script here.

Adding a project means adding its `project.json` and its `CODEOWNERS` line; Nx
fans one uniformly-named target across all of them.

## Commits, releases, and merging

- **Squash-merge only, via PR, with auto-merge.** The default branch is
  protected: merge and rebase merging are off, so one PR is one squash commit
  whose subject is the PR title. Queue with `gh pr merge --auto --squash`. Admins
  may bypass in a break-glass.
- **Branch protection requires exactly the five jobs** — `lint`, `test-linux`,
  `test-windows`, `test-macos`, `budgets` (`.github/required-contexts.mjs`, which also names
  the informational `advisories` status that must never be required) — and does not
  require a branch to be up to date (the user's decision of 2026-10-18). There is
  no verdict job ruling on others: a check that must block a merge is a step of
  one of them, which is why `test-linux` builds the release's x86_64 wheel
  (v0.16.0's wheels failed with every required check green). The trade is that
  nothing re-runs the tests on a push to `main`, so two merges that pass apart
  can break together; `ci-cache.yml`'s warm jobs, which fail when `main` does not
  build, are what catch a merge that breaks the build. Nothing follows a release
  on `workflow_run`: what a published artifact does when installed is proven
  inside the release job that published it (below), whose failure demotes the
  Release rather than going unread.
- **Releases are fully automated; the only human action is merging a PR.**
  release-plz is the single version driver — it computes the version, writes
  `CHANGELOG.md` and the manifests, tags `vX.Y.Z`, and cuts the Release, which
  fires `release.yml`. Pre-1.0: `feat` → minor, `fix`/`perf`/`refactor`/`build`
  → patch, `!`/`BREAKING` → minor; `chore`/`docs`/`ci`/`test`/`style` do not
  release.
- **Releases batch, so the full sweep runs on the release pull request.**
  release-plz keeps one release PR open and every merge to `main` adds to it, so
  the commit that ships is that PR's head. On that pull request alone
  `test-linux` runs the broader tier — `just check`'s tiers over every project,
  with the host-labelled budgets — and on every other the affected one;
  `scripts/ci-tier.sh` tells the two apart. It is the last whole-gate run a
  release gets: `release.yml` re-runs no tests. A Release made by hand naming a
  commit no sweep covered therefore gets only the artifact proofs below — every
  file installed and run before it publishes, and read back from its registry
  after.
<!-- llmlint: ignore-block[agents_md_durable_and_terse] the budgets' ids and labels are named here on purpose: this is where a maintainer learns which label decides where each budget is checked (publish's last step or the gate) and that the release-tail ones block nothing, which budgets.yaml's entries cannot say about each other. -->
- **Nine budgets hold CI, CD and the local gate to their lines** (root
  `budgets.yaml`, read from telemetry). The eight `release-tail` ones —
  `onepipeline-ui-ci-check-time`, `-cd-job-time`, `-release-cycle-time`,
  `-ci-job-count`, `-cd-job-count`, `-release-read-requests` and
  `-pr-read-requests` and `-nx-cache-use` — are reported by `publish`'s last step and read by
  nothing, so an overrun turns that step red and never blocks, demotes or reverts
  a release. `onepipeline-ui-gate-time` (`host-variable`) is checked by `just
  gate` itself, whose whole body runs inside `scripts/gate-time.sh`: over is a
  warning, an unmeasurable budget fails the gate. At pull-request time a job's
  `timeout-minutes` is the line; any other check of the root file excludes both
  labels. The seven host figures reach GitHub through `onevcs host`; cache-use reads
  CI reports and promotion receipts through GitHub's API directly. Both use
  `scripts/actions-budget-figures.sh`, a copy of dero-skills' create-repo source
  that is edited only there.
<!-- llmlint: ignore-end[agents_md_durable_and_terse] -->
- **Each release job's work is one recipe, and two rules hold the release
  together** (`scripts/release.mjs` says what each phase does): every target is
  compiled **once**, and the archive, wheel and npm package are packed from that
  binary and installed and run before anything publishes; and nothing
  platform-independent (the crate, the npm launcher and frontend, the SBOM)
  publishes until every platform's files are served. So **a failed platform job
  leaves the other platforms published and the platform-independent artifacts
  unpublished** until it is re-run — and a re-run finishes the release, because
  every upload publishes only what its registry does not already serve. A
  rebuild is not byte-identical, so a re-run keeps what PyPI and npm took from
  an earlier attempt rather than uploading over it, waits for a version npm
  holds and does not serve yet, and the Release's archive and checksum follow
  them as a pair (`upload github` in `scripts/release.mjs` says how); `verify`
  then installs and runs what the registries serve, and names a target they
  serve as more than one build. v0.41.2's build-windows could not be finished
  by re-running it before that. A
  target is changed in `scripts/release.mjs`'s table and nowhere else. The
  platform jobs are `build-linux`, `build-linux-arm64` (on the
  `ubuntu-24.04-arm` runner, so the arm64 binary is built and run natively),
  `build-macos` (Apple Silicon only; Intel macOS is not released) and
  `build-windows`, which with release-plz and `publish` make six CD jobs.
  Pull-request CI builds no arm64 Linux leg.
- **npm serves a publish minutes after `npm publish` returns, and names a
  version before it serves the tarball** — longer than a platform job has
  left after compiling — **and PyPI's JSON API can omit a wheel uploaded
  seconds before.** So no platform job waits for npm; `publish`'s `check`
  fetches every platform package by version and re-reads PyPI until it lists
  every wheel, within one deadline, before the launcher that pins them goes
  out. A registry that has not answered yet is late, never missing: only a
  failed job or a missing Release asset is reported without the wait.
  v0.41.1's check read two late wheels as missing, so waited for nothing and
  failed in six seconds over five files both registries served minutes later.
  `verify` likewise asks npm for the frontend only through its retried
  install: v0.41.0's one `npm view` refused a frontend npm listed 97 seconds
  after its upload. npm also installs a launcher whose platform package it
  cannot fetch and exits 0, so an install that lacks the platform package is
  retried, never counted.
- **An `npm publish` that exits 0 may have been staged, not published**, and
  an upload fails on one. A staged version is served by nothing until a
  maintainer approves it (`npm stage approve <id>`), and a re-run cannot publish
  over it: it waits `RELEASE_NPM_HELD_BUDGET` seconds (five minutes) for npm to
  serve it, naming the stage id, so approve, then re-run — or approve while the
  re-run waits. A release that is to publish unattended
  needs a credential npm lets publish directly — a registry setting, not code
  here.
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
- **A release that did not publish must not look like one.** The `publish` job's
  last step runs `scripts/release-status.sh` over the platform jobs' results and
  its own steps': if one the operator's switches say had to succeed did not, the
  GitHub Release is demoted to a prerelease with a banner naming them, and the
  job fails. The job runs `if: always()`, so a failed platform job demotes too. The
  tag is never touched — tags here are immutable — so the recovery for any
  stranded version is the next patch version, never a re-run of its tag, whose
  tree is the one that failed. v0.2.0 and v0.3.0 are stranded that way and stay
  unpublished.
- **A tag is not evidence of a release; the registry is.** Check what npm, PyPI
  and crates.io serve before reporting a version shipped.
- **`release-targets.toml` declares what this repository publishes, and
  `scripts/release-probe.sh` answers what a registry currently serves for one of
  those names.** That is how a repository downstream of this one waits for a
  dependency to actually ship rather than launching on a merged commit. That file
  is the list — do not restate it here, or the copy becomes a second source.
  Identifiers are registry-qualified (`npm:…`, `pypi:…`, `crate:…`) because a
  bare name cannot say which registry served it, and a per-platform package a
  launcher resolves at its own exact version is covered by that launcher's target
  rather than being one, because nothing depends on it by name.
  **Its shape is not this repository's to choose, and conformance to it is not
  this repository's to judge.** The schema is `onevcs`'s — defined in that
  repository's `docs/contract.md` and enforced by its own reader — because six
  repositories write one of these and a consumer parses all six with a standard
  TOML parser and no knowledge of any of them.
  `tests/support/release_declaration.rs` is deliberately *not* a copy of that
  schema, which would be a second definition of a contract with one source and
  nothing offline to hold it to the original: it reads what this repository's own
  machinery reads and refuses only what would leave one of its callers with no
  answer. When a release of `onevcs` carries `validate_release_declaration`,
  that module becomes a call to it.
  The probe's three answers are a version, nothing at all (no release yet), and a
  non-zero exit (**not answered**), and the third is never the second: a consumer
  holds forever on it, so an unreachable registry must never read as an
  unreleased artifact. `tests/packaging.rs` derives the published set from
  `release.yml`, each release recipe's plan and the manifests, and fails on
  either kind of drift — a new job it cannot read is a panic, not an omission. A
  new artifact means a new entry there; the `publish` job's `verify` step is what
  asks a real registry, on every release.
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
- **A baseline nobody can build stops only a release that claims compatibility
  with it.** Tightening this crate's own requirements does not always reach it:
  v0.4.0 pins `onepipeline` exactly, and it is *that* crate's caret on
  `oneagentgraph` that drifted, which no manifest writable here can bind. So
  `scripts/semver-check.sh` reads the commits release-plz versions from — the
  ones touching a file `cargo package --list` names — and when they announce a
  break, or there are none, a baseline it could not read is a warning rather than
  a failure. Every other release still fails on a reading that did not happen,
  which is the accidental incompatibility the check exists for. That is the whole
  of the exception; do not widen it to make a patch release go through.
- **Moving the linked `onepipeline` is a break of this crate's own surface, and
  the same script refuses one nothing announced.** This crate's public items
  carry the engine's types — `ApiError::from_engine` takes an
  `onepipeline::Error` — so a `0.x` minor move stops a consumer compiling
  however this crate's own signatures read, and the reading cannot see it:
  both sides' rustdoc spells the same path while the type behind it changed
  identity. `scripts/semver-check.sh` reads the requirement off both manifests
  and fails a release that moved it while the packaged commits announce no
  break; announcing the break is what clears it. v0.11.2's `=0.42.0` became
  `=0.44.2` with nothing said, and the release stopped instead on the
  unbuildable baseline above, which says nothing about the move.
- **release-plz authenticates with `RELEASE_PLZ_TOKEN`, a PAT, not the default
  `GITHUB_TOKEN`.** A tag or Release created by `GITHUB_TOKEN` triggers no
  workflow, so `release.yml` would never run and the release would ship nothing.
  `gh-secrets.json` names every secret the workflows read.

## Invariants (non-negotiable)

- The gate is strict: no warnings-only mode anywhere. A diagnostic is an error or
  a suppression with a written reason at the narrowest scope the tool allows.
  Every tool is told so in the way it needs telling: clippy takes `-D warnings`,
  rustdoc `RUSTDOCFLAGS`, and ESLint `--max-warnings 0`, which is the one of the
  three that otherwise exits `0` with its findings printed.
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
  binary's: a supervisor signals whatever it started, which for npm is the
  binary on Linux and macOS (the node launcher execs it) and the node launcher
  in front of it on Windows. `src/server.rs` is the one source for which
  stops are honoured and `tests/packaging.rs` holds the launcher and the
  journeys to it — v0.3.1 shipped exiting 143 with the binary already correct.
- Do not commit secrets. Values live in the platform secret store, referenced by
  name in `gh-secrets.json`; the allowlist in `.claude/settings.json` stays
  narrow, and keeping it current — rather than re-approving a routine command
  every session — is part of the work.
