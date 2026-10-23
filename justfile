# Canonical command surface for onepipeline-ui.
#
# `just bootstrap` works from a clean clone; `just check` is the full
# deterministic quality gate and fails on any issue (no warnings-only mode);
# `just gate` is `check` plus the llmlint LLM-judge tier — the complete
# pre-push bar. Recipes are quiet on success and specific on failure.
#
# This is a monorepo: the repo-wide verbs (bootstrap, check, lint, test, format,
# fmt-check, upgrade) delegate to Nx, which fans the uniformly-named target out
# across every project. They never loop over projects by hand. What a target
# *does* stays with its project — the `_crate-*` and `_tier-*` recipes below are
# the Rust crate's own tools and its test tiers', named by each `project.json`.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# llmlint: ignore-file[tool_output_is_signal] recipes that hand straight to cargo,
# clippy, rustdoc, or cargo-deny inherit those tools' diagnostics, which already
# name the exact problem and its fix; a wrapper message would bury them. Recipes
# whose failure needs project-level context (_crate-bootstrap, _tier-test-covered,
# _crate-coverage, _crate-msrv, _crate-fmt-check) add one explicitly.

# The MSRV has one source of truth — Cargo.toml's `rust-version` — so `just msrv`
# cannot promise a floor the manifest no longer declares. CI reads the same field.
msrv-version := `sed -n 's/^rust-version *= *"\([^"]*\)".*/\1/p' Cargo.toml`

# Keep the gate's own output to signal: successes are silent, failures are not.
export CARGO_TERM_QUIET := "true"

# The `onepipeline` build the journeys compare the read API against, pinned to
# the version the lock resolves its library to. The server runs no `onepipeline`
# binary itself — every verb it serves is a call into the SDK it links — so what
# this provisions is the CLI `tests/e2e/server.rs` holds the served answers to:
# the telemetry document, the rendered verbs, and whether a run is watched. A
# stray build on PATH prints a different release's document, which is exactly
# the comparison that would prove nothing. Provisioned into the tree rather than
# taken from PATH for that reason, and exported so every tier asks the same one.
onepipeline-version := `awk '/^name = "onepipeline"$/{found=1; next} found && /^version = /{gsub(/[",]/, "", $3); print $3; exit}' Cargo.lock`

# The extension `cargo install` gives the file it writes, so the name below is
# the one the platform actually produced. Derived rather than spelled out a
# second time: a Windows-only literal beside the portable one drifts the moment
# either changes, and the failure it drifts into is silent — `_ensure-sibling`
# probes a path nothing ever writes, never matches, and reinstalls on every run.
sibling-exe := if os_family() == "windows" { ".exe" } else { "" }
export ONEPIPELINE_UI_ONEPIPELINE_BIN := justfile_directory() / ".tools/bin/onepipeline" + sibling-exe

# The server this branch forked from, which `tests/e2e/baseline.rs` serves one
# runs root through beside this build's. Clone-local for the reason the sibling
# above is: it is built from another commit of *this* repository rather than
# installed, so nothing on PATH can be it.
export ONEPIPELINE_UI_BASELINE_BIN := justfile_directory() / ".tools/bin/onepipeline-api-baseline" + sibling-exe

# The release tools, pinned once: release-plz.yml installs release-plz at its
# RELEASE_PLZ_VERSION and release.yml cargo-cyclonedx, which
# `.github/tests/release.test.mjs` holds to these; the Python ones are installed
# from here by `release-python-tools`, and maturin is the one the manylinux
# build (scripts/build-linux-wheel.sh) pins too.
release-plz-version := "0.3.158"
cyclonedx-version := "0.5.7"
maturin-version := "1.14.1"
twine-version := "6.1.0"
packaging-version := "25.0"
python := if os_family() == "windows" { "python" } else { "python3" }
python-pins := "maturin==" + maturin-version + " twine==" + twine-version + " packaging==" + packaging-version

# The `cargo-prune-superseded` release `pool-maintenance` runs, pinned once here:
# `_ensure-pruner` installs exactly this and nothing else reads a version for it.
prune-superseded-version := "0.1.1"

# List available recipes.
default:
    @just --list

# Every project's `bootstrap` target, so one clean-clone command provisions the
# whole graph rather than the crate alone. Serialized: projects share installers,
# and two of them recreating the same tool directory at once race each other.
# Set up the project from a clean clone.
bootstrap:
    @bash scripts/nx.sh run-many -t bootstrap --parallel=1

# The Rust crate's own provisioning (the `onepipeline-ui:bootstrap` target).
_crate-bootstrap:
    @rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
    @rustup component add rustfmt clippy llvm-tools >/dev/null \
      || { echo "cannot add toolchain components — install rustup (https://rustup.rs/) and re-run" >&2; exit 1; }
    @just _ensure-tool cargo-nextest
    @just _ensure-tool cargo-llvm-cov
    @just _ensure-tool cargo-auditable
    @just _ensure-sibling
    @cargo fetch --locked --quiet

# The sibling CLI, at the exact version the lock pins its library to. Unlike the
# test runners above this *is* a rule: the journeys hold what the server serves
# to what it prints, and a different version of it prints a different document.
#
# Not `bootstrap`'s alone: the test tiers that start the read API reach this recipe
# through the `onepipeline-ui:ensure-sibling` Nx target, because the binary they
# need is clone-local (`AGENTS.md`).
#
# Fetched as the release's own archive for this host when that release publishes
# one, checked against its published checksum and version, and compiled only when
# it does not; `scripts/ensure-sibling.sh` holds the order and its refusals.
_ensure-sibling:
    @bash scripts/ensure-sibling.sh "{{onepipeline-version}}"

# The base commit's own server, for the journeys that compare what this build
# serves against what it served. Behind its own Nx target rather than inside the
# suite, because the comparison is cheap and compiling another commit's whole
# dependency graph is not: a change to a workflow, a script or a document must
# not make the root project's tests build a second server.
#
# Idempotent on `_ensure-sibling`'s terms — the binary is stamped with the commit
# it was built from — and the reasoning is in the script.
_ensure-baseline:
    @bash scripts/ensure-baseline-api.sh

# These are test runners, not rules: their version cannot change the gate's
# verdict, so both here and CI take the latest rather than keeping two pins that
# drift apart.
# Install a cargo dev tool if it is missing. Quiet when already present.
_ensure-tool tool:
    @command -v {{tool}} >/dev/null 2>&1 || cargo install {{tool}} --locked --quiet

# The `pool-maintenance` project's provisioning (its `bootstrap` target): the
# pinned pruner, onto PATH, where onevcs's maintenance of an idle slot runs it.
# Skipped when that release is already the one on PATH, so a second bootstrap
# installs nothing.
_ensure-pruner:
    @[ "$(cargo-prune-superseded --version 2>/dev/null)" = "cargo-prune-superseded {{prune-superseded-version}}" ] \
      || cargo install --locked cargo-prune-superseded --version {{prune-superseded-version}} --quiet \
      || { echo "cannot install cargo-prune-superseded {{prune-superseded-version}}, which 'just pool-maintenance' runs — fix the cargo error above (crates.io reachable, toolchain installed), then re-run 'just bootstrap'" >&2; exit 1; }

# What onevcs runs in each idle warm-pool slot of this repository (`onevcs.toml`).
# `target` is every directory this repository's cargo builds write to: the one
# `target-dir` `.cargo/config.toml` sets, resolved against this root as cargo
# resolves it, and every other build here (coverage, the wheels, semver-checks)
# nests under it. In each profile directory the pruner removes a unit's
# superseded builds older than the window and keeps its newest, so a slot stays
# warm. `pool-maintenance/measure.sh` times this same recipe for the budget.
# Remove superseded cargo builds older than 2 days, keeping each unit's newest.
pool-maintenance:
    @command -v cargo-prune-superseded >/dev/null \
      || { echo "cargo-prune-superseded is not on PATH — run 'just bootstrap'" >&2; exit 1; }
    @cargo-prune-superseded --keep-within 2d target

# The tiers run in fail-fast order as dependencies, each fanned across every
# project by Nx. The body then runs the per-project `check` aggregate — the same
# target `just check-affected` uses — which replays from the cache in a second
# and is what stops the full sweep and the affected sweep from ever covering
# different tiers.
# Full deterministic quality gate, every project.
check: fmt-check lint typecheck build test test-baseline test-cost doc
    @bash scripts/nx.sh run-many -t check
    @echo "check: ok"

# What PR CI runs: the same gate, scoped to the projects this branch's diff can
# reach. Fails closed — with no derivable merge base it runs everything.
# Full deterministic quality gate, affected projects only.
check-affected:
    @bash scripts/nx-affected.sh -t check
    @echo "check-affected: ok"

# What the macOS and Windows legs run. They are here for what the platform can
# change — formatting, lints and the suite against a real binary — and not for
# what it cannot: coverage is instrumented on Linux alone (see `test-quick`),
# and the frontend's typecheck, build and docs are the same artifact on every
# OS. Naming that subset once is what keeps CI from re-listing tiers inline and
# drifting away from this file. Every part of it is an Nx target, so the
# sibling CLI and the browser view the suite's binary embeds arrive through the
# same `dependsOn` edges the Linux tiers declare rather than a second list here.
# The gate's platform-sensitive tiers, without the Linux-only coverage floor.
check-cross: fmt-check lint test-quick
    @echo "check-cross: ok"

# ci.yml's four jobs, each one recipe the job's step calls and a developer can run:
# `scripts/ci-job.sh` holds which Nx targets each runs and why it is one Nx
# invocation. All four are scoped to the projects this branch's diff can reach,
# failing closed as `check-affected` does; `--plan` prints the selection and runs
# nothing, which is how a Linux host reads what the Windows and macOS jobs select.
# The platform-independent checks: formatting, lints, type checks, MSRV, audit.
[positional-arguments]
ci-lint *args:
    @bash scripts/ci-job.sh lint "$@"

# `--tier broader`, `scripts/ci-tier.sh`'s answer on the release pull request,
# sweeps every project with the host-labelled budgets instead.
# The Linux gate with its packaging alongside: `check`, install, the x86_64 wheel.
[positional-arguments]
ci-test-linux *args:
    @bash scripts/ci-job.sh test-linux "$@"

# It compiles everything from nothing, so nothing runs it; the runs it made and
# their arguments are in docs/linux-cold-cache-timing.md.
# Time the Linux job's recipe on a cold Rust cache, in a clone of one commit.
[positional-arguments]
measure-cold-linux *args:
    @bash scripts/measure-cold-linux.sh "$@"

# The Windows job: the platform-sensitive tiers, the browser build, the install.
[positional-arguments]
ci-test-windows *args:
    @bash scripts/ci-job.sh test-windows "$@"

# The macOS job: the platform-sensitive tiers and the install.
[positional-arguments]
ci-test-macos *args:
    @bash scripts/ci-job.sh test-macos "$@"

# The documented install path, `cargo install --path .`, into a root under
# `target/` rather than the user's own, smoke-tested as every published artifact
# is. The dev profile shares the units `dag-ui:build-api-server` compiles. The
# release rehearsal and release jobs prove the release-profile binaries; see
# docs/release-sweep-timing.md for the measured cost of compiling both here.
# The bin directory is resolved by `cd`, so a root cargo did not write is named
# rather than read as a command missing from PATH, and the binary is handed to
# the smoke test by its path: the Windows leg's PATH lookup did not find it there.
# Compiled, when it has to be, at low priority: see `packaging-priority`.
# Its units go to this clone's build directory, `target` (cargo's
# `build.build-dir`), so the dependency graph is still shared, and its binary to a
# target directory of its own: `cargo install --path .` otherwise re-links
# `target/debug/onepipeline-api` with the install's features, replacing the file
# the test tiers running beside it in the same Nx run exec — the e2e tier's
# `cli::` journeys found no binary there on macOS.
# Install this revision the documented way and smoke-test the installed binary.
# llmlint: ignore-block[diagnostics_error_or_absent] `_crate-lint` denies all compiler warnings over this same dev build with `clippy --all-targets -- -D warnings` in every CI selection that runs this install. RUSTFLAGS here would rebuild its shared units under another flag set; the install adds no source or feature clippy did not check.
_crate-install-smoke:
    @{{packaging-priority}} cargo install --path . --locked --debug --quiet --root target/install-smoke \
      --target-dir target/install-smoke/target --config 'build.build-dir="target"'
    @bin="$(cd target/install-smoke/bin && pwd)" \
      || { echo "cargo install wrote no target/install-smoke/bin: $(ls target/install-smoke 2>&1)" >&2; exit 1; }; \
      PATH="$bin:$PATH" bash scripts/smoke-published.sh --command "$bin/onepipeline-api" \
      --expect-version "$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)" \
      --label "cargo install onepipeline-ui on ${RUNNER_OS:-$(uname -s)}/${RUNNER_ARCH:-$(uname -m)}" \
      || { echo "installed into $bin: $(ls -la "$bin" 2>&1)" >&2; exit 1; }

# llmlint: ignore-end[diagnostics_error_or_absent]

# The release's x86_64 Linux wheel, built by the one definition release.yml's
# `build-linux` job runs (`wheel-linux`), then installed into a fresh virtualenv
# and smoke-tested. Needs Docker and the browser view `dag-ui:build` writes.
# Build the x86_64 Linux wheel as the release does, install it, smoke-test it.
_crate-wheel-smoke:
    @rm -rf target/wheel-smoke
    @just wheel-linux x86_64-unknown-linux-gnu target/wheel-smoke
    @python3 -m venv target/wheel-smoke/venv
    @target/wheel-smoke/venv/bin/pip install --quiet --no-index target/wheel-smoke/*.whl
    @PATH="$PWD/target/wheel-smoke/venv/bin:$PATH" bash scripts/smoke-published.sh \
      --expect-version "$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n1)" \
      --label "onepipeline-api-cli wheel on ${RUNNER_OS:-$(uname -s)}/${RUNNER_ARCH:-$(uname -m)}"

# An install whose units nothing has compiled yet is a long batch compile that
# `ci-test-linux` runs beside the test tiers, and the cost journeys count a
# subscriber's poll ticks, which a starved server misses: at a lower priority it
# takes only the CPU the tiers leave, and every core once they are done. `nice`
# where the host has it; where it does not, the command runs as it is.
packaging-priority := `command -v nice >/dev/null 2>&1 && echo "nice -n 10" || true`

# The complete pre-push bar: the deterministic gate, then the LLM-judge tier
# scoped to this branch's diff. `check` stays deterministic and credential-free
# on its own; this is where the non-deterministic tier joins it.
# Full gate: `check` plus the diff-scoped llmlint tier.
gate base="origin/main": check
    @just lint-llm-diff {{base}}
    @echo "gate: ok"

# `true` when this branch's diff can reach the crate, so CI can skip the
# cross-platform and install matrices on a change that cannot. The crate is the
# one Cargo package, and it is several Nx projects — its sources and unit tier,
# and each test tier, which are its `[[test]]` targets — each tagged `lang:rust`,
# so a change reaching any of them reaches the crate. A test-only change is one
# that does: those matrices compile and run the suites it touched. Fails closed.
# Whether the crate — any of its `lang:rust` projects — is affected by this branch.
affected-crate:
    @bash scripts/nx-affected.sh --affects tag:lang:rust

# Escape hatch for Nx itself, e.g. `just nx show projects` or `just nx graph`.
# Run an arbitrary Nx command against this workspace.
nx *ARGS:
    @bash scripts/nx.sh {{ARGS}}

# Verify formatting without modifying files.
fmt-check:
    @bash scripts/nx.sh run-many -t format-check

# Format the codebase in place.
format:
    @bash scripts/nx.sh run-many -t format

# Lint every project with its own linter; any warning is an error.
lint:
    @bash scripts/nx.sh run-many -t lint

# The Rust crate's compiler type-checks inside `lint`, so only the TypeScript
# projects carry this target.
# Type-check every project that has a type checker.
typecheck:
    @bash scripts/nx.sh run-many -t typecheck

# The crate's own build is covered by `lint` and `test`, so this is the frontend
# bundle and the packages' declarations.
# Build every project that produces a distributable artifact.
build:
    @bash scripts/nx.sh run-many -t build

# Shared by the release's `build-linux` and `build-linux-arm64` jobs (through
# `release-linux build` and `release-linux-arm64 build`) and ci.yml's `wheel`
# job, so a pull request meets the prerequisites and maturin invocation a
# release does. Needs Docker, and the browser view `just build` writes.
# Build the onepipeline-api-cli wheel for one Linux target in the release's image.
[positional-arguments]
wheel-linux target out="dist":
    @bash scripts/build-linux-wheel.sh --target "$1" --out "$2"

# One recipe per release job in `.github/workflows/release.yml`; the phases
# each takes are in scripts/release.mjs's header. `build` needs `just build`
# first, and the Linux ones Docker on their own architecture, the macOS and
# Windows ones maturin.
# The build-linux release job: build, install, publish and verify Linux.
[positional-arguments]
release-linux *args:
    @node scripts/release.mjs linux "$@"

# The build-linux-arm64 release job: build, install, publish and verify arm64 Linux.
[positional-arguments]
release-linux-arm64 *args:
    @node scripts/release.mjs linux-arm64 "$@"

# The build-macos release job: build, install, publish and verify Apple Silicon.
[positional-arguments]
release-macos *args:
    @node scripts/release.mjs macos "$@"

# The build-windows release job: build, install, publish and verify Windows.
[positional-arguments]
release-windows *args:
    @node scripts/release.mjs windows "$@"

# The publish release job: the platform-independent artifacts and the verdict.
[positional-arguments]
release-publish *args:
    @node scripts/release.mjs publish "$@"

# The Python tools the release jobs run, at their pins, into the Python on PATH
# (`just python=… release-python-tools` names another): maturin for the macOS
# and Windows builds, twine for `upload pypi`, and packaging for reading a
# wheel's version.
# Install the release jobs' Python tools.
release-python-tools:
    @{{python}} -m pip install --quiet --disable-pip-version-check {{python-pins}}

# The tools the release recipes reach that no lockfile pins, at the versions the
# release workflows install, into `.tools`: release-plz and cargo-cyclonedx, and
# a Python environment with `release-python-tools`. The release journeys
# (tests/release) put `.tools/bin` and `.tools/release-venv/bin` first on PATH.
# One already on PATH that reports exactly the pin — what ci.yml's
# taiki-e/install-action step unpacks from the tool's checksummed release
# archive — is copied in rather than compiled again: compiling release-plz was
# most of what test-linux waited on before these journeys could start. Any
# other version on PATH is passed over and the pin compiled.
# Provision the release recipes' tools into .tools.
release-tools:
    @[ "$(.tools/bin/release-plz --version 2>/dev/null)" = "release-plz {{release-plz-version}}" ] \
      || { [ "$(release-plz --version 2>/dev/null)" = "release-plz {{release-plz-version}}" ] \
           && mkdir -p .tools/bin && cp "$(command -v release-plz)" .tools/bin/release-plz; } \
      || cargo install release-plz --version {{release-plz-version}} --locked --root .tools --quiet \
      || { echo "cannot install release-plz {{release-plz-version}} into .tools — fix the cargo error above, then re-run" >&2; exit 1; }
    @[ "$(.tools/bin/cargo-cyclonedx cyclonedx --version 2>/dev/null | cut -d' ' -f2)" = "{{cyclonedx-version}}" ] \
      || { [ "$(cargo-cyclonedx cyclonedx --version 2>/dev/null | cut -d' ' -f2)" = "{{cyclonedx-version}}" ] \
           && mkdir -p .tools/bin && cp "$(command -v cargo-cyclonedx)" .tools/bin/cargo-cyclonedx; } \
      || cargo install cargo-cyclonedx --version {{cyclonedx-version}} --locked --root .tools --quiet \
      || { echo "cannot install cargo-cyclonedx {{cyclonedx-version}} into .tools — fix the cargo error above, then re-run" >&2; exit 1; }
    @just _release-venv

# The release journeys' Python environment, rebuilt from nothing whenever any
# pin differs from the ones its stamp records, so a changed pin never leaves an
# old tool installed beside it. It installs with no index, from a wheelhouse in
# `.tools` that is fetched from PyPI only when its own stamp names other pins:
# rebuilding the environment is offline, which is what lets the journey in
# tests/release/tools.test.mjs rebuild one inside the affected tier.
_release-venv:
    @[ "$(cat .tools/release-wheels/pins 2>/dev/null)" = "{{python-pins}}" ] \
      || { { [ -x .tools/release-venv/bin/python ] || python3 -m venv .tools/release-venv; } \
           && .tools/release-venv/bin/python -m pip download --quiet --disable-pip-version-check --dest .tools/release-wheels {{python-pins}} \
           && echo "{{python-pins}}" > .tools/release-wheels/pins; } \
      || { echo "cannot fetch {{python-pins}} into .tools/release-wheels — check that python3 has venv and PyPI is reachable" >&2; exit 1; }
    @[ "$(cat .tools/release-venv/pins 2>/dev/null)" = "{{python-pins}}" ] \
      || { rm -rf .tools/release-venv && python3 -m venv .tools/release-venv \
           && .tools/release-venv/bin/python -m pip install --quiet --disable-pip-version-check --no-index --find-links .tools/release-wheels {{python-pins}} \
           && echo "{{python-pins}}" > .tools/release-venv/pins; } \
      || { echo "cannot install {{python-pins}} into .tools/release-venv from .tools/release-wheels — delete .tools/release-wheels/pins and re-run to fetch them again" >&2; exit 1; }

# Every project's own test target — the crate's unit, e2e and repo-tooling tiers,
# the frontend's components, and the browser journeys — and the coverage floor
# measured over the crate's tiers together. `test-baseline` and `test-cost` are
# the two tiers outside this, each for what it needs that nothing else does.
# Every project's tests, and the crate's coverage floor over its tiers.
test:
    @bash scripts/nx.sh run-many -t test coverage

# Only `onepipeline-ui-baseline` declares this target, so this fans out to one
# project. It is a recipe of its own rather than a step inside `test` because provisioning the base
# commit's server is what it costs, and a reader iterating on the crate's own tests
# should not pay it — `check` and `gate` run both.
# The baseline comparison, which needs the base commit's server provisioned.
test-baseline:
    @bash scripts/nx.sh run-many -t test-baseline

# Only `onepipeline-ui-cost` declares this target. A recipe of its own because
# these need a syscall tracer on the machine, and nothing else here does
# (`tests/AGENTS.md`).
# The bounds on what a read costs, which need `strace` installed.
test-cost:
    @bash scripts/nx.sh run-many -t test-cost

# Every project's onebudgetspec budgets, the host-labelled ones included. Not in
# `check` or `gate`, and no per-change run reaches it: the host budgets measure
# this machine rather than a diff — `pool-maintenance:budgets-host` builds the
# crate twice to time one pool-maintenance pass — so ci.yml's `sweep` runs this
# after the full gate, on the release pull request alone.
# Check every project's budgets, host-labelled ones included.
budgets:
    @bash scripts/nx.sh run-many -t budgets budgets-host

# Build every project's docs with warnings denied.
doc:
    @bash scripts/nx.sh run-many -t doc

# Verify the crate's formatting without modifying files.
_crate-fmt-check:
    @cargo fmt --all -- --check || { echo "formatting drift above — run 'just format'" >&2; exit 1; }

# Format the crate in place.
_crate-format:
    @cargo fmt --all

# Lint the crate with clippy; any warning is an error.
_crate-lint:
    @cargo clippy --all-targets --locked --quiet -- -D warnings

# The crate's suite runs as nine Nx projects, one per tier, each selecting its
# tests through the nextest profile of the same name in `.config/nextest.toml`,
# which is where the nine filters are written and partition the suite. Three
# tiers are instrumented and run here; the baseline comparison, the cost
# journeys, the linked-report journeys, the judged tier's journeys and the CI
# jobs' recipes run through `_tier-test` below, for what each needs that the rest
# do not — another commit of this repository compiled, a syscall tracer, a second
# build of this one with `cargo auditable`, an installed llmlint, and inputs that
# are the project graph rather than the crate.
#
# Each instrumented tier leaves its raw profiles under `target/llvm-cov-target`
# named for the tier, and reports nothing: `_crate-coverage` merges every tier's
# into one report and holds that to the floor. The name is what lets them share
# one instrumented build and still be told apart — `cargo llvm-cov` would
# otherwise name every tier's files alike, and Nx restores a tier replayed from
# its cache by exactly that glob (the `outputs` its `project.json` declares). A
# tier's own earlier profiles are cleared first, because a report merges every
# file it finds and a stale run's would count lines this run never reached.
# `--no-report` is also what stops `cargo llvm-cov` from cleaning the directory,
# which would delete the other tiers' profiles mid-sweep.
# One instrumented tier of the crate's suite, profiles kept for `coverage`.
[positional-arguments]
_tier-test-covered profile:
    @rm -f target/llvm-cov-target/"$1"-*.profraw
    @LLVM_PROFILE_FILE_NAME="$1-%p-%m.profraw" NEXTEST_PROFILE="$1" cargo llvm-cov nextest --locked --no-report \
      || { echo "the $1 tier failed — the failing tests are listed above" >&2; exit 1; }

# 95% line coverage is the gate; lower it only with a documented reason in
# AGENTS.md. Measured over the union of the three instrumented tiers, which is the
# suite less the baseline and cost tiers — the same lines the floor was measured
# over when one target ran all three. `onepipeline-ui-coverage:coverage` depends
# on each tier's `test`, so a tier with nothing new to say replays its profiles
# from the cache rather than leaving a hole in the report.
# Merge every instrumented tier's profiles and hold them to the coverage floor.
_crate-coverage:
    @cargo llvm-cov report --locked --fail-under-lines 95 \
      || { echo "coverage fell below 95% — cover the lines the table above counts as missed" >&2; exit 1; }

# A tier without instrumentation: the baseline comparison, the cost journeys and
# the linked-report journeys, which ask what two binaries serve, what a read asks
# the kernel for and what a build links rather than which lines ran, and `test-quick` on the platforms coverage is not measured
# on.
# One tier of the crate's suite, uninstrumented.
# llmlint: ignore-block[diagnostics_error_or_absent] the compiler's diagnostics over these tests are denied by `_crate-lint` — `clippy --all-targets --locked -- -D warnings`, which compiles this very test target and denies rustc's own lints as well as its own. `RUSTFLAGS` here would deny them a second time at the price of rebuilding the shared `target/debug` under a second flag set every time a test recipe alternates with `build`, `lint` or `msrv`, which is minutes per alternation and buys no diagnostic the gate does not already fail on. The cross-platform legs this recipe serves run `_crate-lint` beside it, so the deny reaches these tests on every platform the gate rules on.
[positional-arguments]
_tier-test profile:
    @NEXTEST_PROFILE="$1" cargo nextest run --locked
# llmlint: ignore-end[diagnostics_error_or_absent]

# Build the docs with warnings denied (kept in the gate so doc links don't rot).
_crate-doc:
    @RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet

# Coverage instrumentation is measured on Linux only, so the cross-platform CI
# legs run the same tiers through this instead of `test`: every Rust project's
# `test-quick` target, which is its tier without the instrumentation.
#
# The cost journeys have no such target — they need a tracer the machine has to
# have, and the suite is compiled away on the two platforms this recipe exists
# for. Nor does the baseline comparison, which is excluded on the same terms
# coverage is: it asks whether *this crate* still serves what the commit it forked
# from served, a property of the payload rather than of the platform, and paying
# for a whole second server on each of the two cross legs would triple what the
# gate spends to learn one thing. The Linux `test-baseline` tier runs it, behind
# the `onepipeline-ui:ensure-baseline` target that provisions what it serves
# through. `ensure_baseline::` *is* here, in the repo-tooling tier: those journeys
# stub the build and are as platform-sensitive as any other recipe here.
# Every Rust tier without coverage instrumentation.
test-quick:
    @bash scripts/nx.sh run-many -t test-quick

# Drives the compiled binary and the committed npm launcher — never a stub. The
# whole e2e binary, which six tiers share between them (`.config/nextest.toml`):
# that split is about what each change pays for and what the gate provisions for
# which tier, and reaching for the journeys themselves should not have to know it.
# The whole `e2e` test binary in one run, every tier's share of it together.
test-e2e: _ensure-baseline
    @cargo nextest run --locked -E 'binary(e2e)' --status-level fail

# Run the CLI, e.g. `just run serve --runs-root ./runs`.
run *ARGS:
    cargo run --locked --quiet -- {{ARGS}}

# The operator iterates on this UI visually and cannot otherwise see it while a
# change is being made, and these are also the pictures README.md carries. The
# script's own header explains the container, the per-invocation destination and the
# two halves. Not in `check` and not in `gate`: it asserts nothing, it writes images,
# and it wants Docker.
# Photograph the DAG Observatory at every viewport, reproducibly.
dag-ui-screens *ARGS:
    @bash scripts/visual-capture.sh {{ARGS}}

# Reads the floor from Cargo.toml's `rust-version`; that toolchain must be
# installed (`rustup toolchain install <version>`). Warnings are errors here too.
# The `onepipeline-ui:msrv` target, which no `check` depends on: the floor needs a
# second toolchain installed, so CI's `msrv` job is where it is proven.
# Build under the declared MSRV.
msrv:
    @bash scripts/nx.sh run onepipeline-ui:msrv

# The crate's MSRV build (the `onepipeline-ui:msrv` target).
_crate-msrv:
    @RUSTFLAGS="-D warnings" cargo +{{msrv-version}} check --locked --all-targets --quiet \
      || { echo "the {{msrv-version}} floor no longer builds — install that toolchain, or raise rust-version in Cargo.toml (and clippy.toml)" >&2; exit 1; }

# Separate from `check` for the same reason `deps-check` is: it fetches both
# sides' dependency trees, and needs a checkout of the previous release to read
# against. `.github/workflows/release-plz.yml` runs this before release-plz makes
# the same reading, so a check that cannot run fails the release instead of
# passing as compatible — while that release claims compatibility at all, which
# is what the tag is for. `git worktree add --detach <dir> <tag>` makes a baseline.
# Diff the crate's public API against a release checkout, as the release does.
# The workflow interpolates a path and a tag it was handed into this call, so the
# recipe passes them as arguments rather than pasting them into the command line.
# llmlint: ignore-block[diagnostics_error_or_absent] the recipe exposes what the script decides; `scripts/semver-check.sh` holds why a release announcing a break succeeds on a warning.
[positional-arguments]
semver-check baseline ref:
    @bash scripts/semver-check.sh "$1" "$2"
# llmlint: ignore-end[diagnostics_error_or_absent]

# Separate from `check`: `cargo deny` needs a network-fetched advisory DB, so the
# `onepipeline-ui:deps-check` target is one no `check` depends on.
# Advisory + license audit and unused-dependency check.
deps-check:
    @bash scripts/nx.sh run onepipeline-ui:deps-check

# The crate's supply-chain audit (the `onepipeline-ui:deps-check` target).
_crate-deps-check:
    @command -v cargo-deny >/dev/null || { echo "cargo-deny not installed: cargo install cargo-deny --locked" >&2; exit 1; }
    @command -v cargo-machete >/dev/null || { echo "cargo-machete not installed: cargo install cargo-machete --locked" >&2; exit 1; }
    @cargo deny --log-level error check
    @# machete prints the unused deps it finds on stdout, so keep it: hiding
    @# them would leave a failing gate with no actionable detail.
    @cargo machete

# Upgrade dependencies, then re-run the full deterministic gate.
upgrade:
    @cargo update --quiet
    @bun update --silent
    @just check

# Ensures `just`, verifies the rest, then runs setup-llmlint. Runs automatically
# via the Claude Code SessionStart hook; this is the manual entry point.
# Provision the dev toolchain for a session. Idempotent, no-ops in CI.
session-setup:
    ./scripts/session-setup.sh

# Install/refresh the llmlint toolchain (oneharness + llmlint). Idempotent.
setup-llmlint:
    ./scripts/setup-llmlint.sh

# Kept OUT of `check` on purpose: the deterministic gate stays offline and
# credential-free. Config is the composed `llmlint.yml`.
# LLM-judge lint — the non-deterministic, harness-backed tier.
lint-llm *paths:
    @command -v llmlint >/dev/null 2>&1 || { echo "llmlint not installed — run 'just setup-llmlint'"; exit 1; }
    llmlint {{paths}}

# CI runs this before the model tier so a broken config fails in milliseconds
# instead of spending a harness call.
# Fast, deterministic llmlint gate — no model calls, no harness credential.
lint-llm-validate *args:
    @command -v llmlint >/dev/null 2>&1 || { echo "llmlint not installed — run 'just setup-llmlint'"; exit 1; }
    llmlint validate {{args}}

# The blocking `llmlint` PR check; `just gate` runs it before you push.
#
# Runs the cached Nx target `onepipeline-ui-judged-diff:lint-llm-diff`, which is llmlint
# itself keyed on the tracked tree, the resolved base commit and `llmlint
# fingerprint`: a pass is replayed only for that tree, base and judge, and a
# failure is never cached. Trailing arguments are Nx's — `--skip-nx-cache`
# forces a fresh roll.
# llmlint scoped to the files this branch changed since it forked from main.
[positional-arguments]
lint-llm-diff base="origin/main" *nx_args:
    #!/usr/bin/env bash
    set -euo pipefail
    sha="$(git rev-parse --verify --quiet "$1^{commit}")" \
      || { echo "lint-llm-diff: base '$1' does not resolve to a commit in this checkout" >&2; exit 2; }
    echo "lint-llm-diff: judging against base $sha"
    shift
    # Nx resolves a run-commands task on the child's `exit` before reading its
    # pipes, so a fast failure's whole output is lost when Nx's stdout is not a
    # terminal (the spike-nx-output-loss report). Remove once Nx collects
    # run-commands output on `close`.
    export NX_RUN_COMMANDS_DIRECTLY=false
    LLMLINT_DIFF_BASE_SHA="$sha" exec bash scripts/nx.sh run onepipeline-ui-judged-diff:lint-llm-diff "$@"
