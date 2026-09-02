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
# *does* stays with its project — the `_crate-*` recipes below are the Rust
# crate's own tools, named by project.json.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# llmlint: ignore-file[tool_output_is_signal] recipes that hand straight to cargo,
# clippy, rustdoc, or cargo-deny inherit those tools' diagnostics, which already
# name the exact problem and its fix; a wrapper message would bury them. Recipes
# whose failure needs project-level context (_crate-bootstrap, _crate-test, msrv,
# _crate-fmt-check) add one explicitly.

# The MSRV has one source of truth — Cargo.toml's `rust-version` — so `just msrv`
# cannot promise a floor the manifest no longer declares. CI reads the same field.
msrv-version := `sed -n 's/^rust-version *= *"\([^"]*\)".*/\1/p' Cargo.toml`

# Keep the gate's own output to signal: successes are silent, failures are not.
export CARGO_TERM_QUIET := "true"

# The `onepipeline` build the read API asks for a run's telemetry, pinned to the
# version the lock resolves its library to. The two speak a versioned document
# and the producer refuses a mismatched one, so a stray build on PATH would serve
# every run with no clock at all. Provisioned into the tree rather than taken
# from PATH for exactly that reason, and exported so every tier — the crate's own
# suite and the browser tier's server alike — asks the same one.
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
    @just _ensure-sibling
    @cargo fetch --locked --quiet

# The sibling CLI, at the exact version the lock pins its library to. Unlike the
# test runners above this *is* a rule: it produces the telemetry document this
# server serves, and a different version of it is a different document.
#
# Not `bootstrap`'s alone: the test tiers that start the read API reach this recipe
# through the `onepipeline-ui:ensure-sibling` Nx target, because the binary they
# need is clone-local (`AGENTS.md`).
#
# The probe reads the exported variable instead of interpolating it: an
# interpolation is pasted into the shell line, and `justfile_directory()` is
# separated by backslashes on Windows, which that line would spend as escapes.
# Either way the path never resolves, and a probe that cannot resolve reinstalls
# on every run rather than failing — quietly, and only on that platform.
_ensure-sibling:
    @[ "$("$ONEPIPELINE_UI_ONEPIPELINE_BIN" --version 2>/dev/null)" = "onepipeline {{onepipeline-version}}" ] \
      || cargo install onepipeline --version {{onepipeline-version}} --locked --root .tools --quiet \
      || { echo "cannot provision onepipeline {{onepipeline-version}} — the read API serves no timing without it" >&2; exit 1; }

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

# The tiers run in fail-fast order as dependencies, each fanned across every
# project by Nx. The body then runs the per-project `check` aggregate — the same
# target `just check-affected` uses — which replays from the cache in a second
# and is what stops the full sweep and the affected sweep from ever covering
# different tiers.
# Full deterministic quality gate, every project.
check: fmt-check lint typecheck build test test-baseline test-browser doc
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
# drifting away from this file.
# The gate's platform-sensitive tiers, without the Linux-only coverage floor.
check-cross: fmt-check lint _ensure-sibling test-quick
    @echo "check-cross: ok"

# The complete pre-push bar: the deterministic gate, then the LLM-judge tier
# scoped to this branch's diff. `check` stays deterministic and credential-free
# on its own; this is where the non-deterministic tier joins it.
# Full gate: `check` plus the diff-scoped llmlint tier.
gate base="origin/main": check
    @just lint-llm-diff {{base}}
    @echo "gate: ok"

# `true` when this branch's diff can reach the Rust crate project, so CI can skip
# the cross-platform and install matrices on a change that cannot. Fails closed.
# Whether the Rust crate is affected by this branch.
affected-crate:
    @bash scripts/nx-affected.sh --affects onepipeline-ui

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

# Every project's unit and contract tests: the crate's suite under its coverage
# floor, and the frontend's components. The two tiers that start servers are
# `test-baseline` and `test-browser`, and `check` runs all three.
test:
    @bash scripts/nx.sh run-many -t test

# Only the crate declares this target, so this fans out to one project. It is a
# recipe of its own rather than a step inside `test` because provisioning the base
# commit's server is what it costs, and a reader iterating on the crate's own tests
# should not pay it — `check` and `gate` run both.
# The baseline comparison, which needs the base commit's server provisioned.
test-baseline:
    @bash scripts/nx.sh run-many -t test-baseline

# The browser journeys, which start five servers between them and take minutes
# where the unit tiers take seconds. Behind an edge of their own for the reason
# the baseline comparison is: what a reader iterating on a component owes is the
# tier that reads components, and `check` and `gate` run both regardless.
# Every project's browser journeys.
test-browser:
    @bash scripts/nx.sh run-many -t test-browser

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

# 95% line coverage is the gate; lower it only with a documented reason in
# AGENTS.md.
#
# The baseline comparison is the one thing this excludes, and `_crate-test-baseline`
# below is where it runs. The two filters partition the suite — this one is `not`
# what that one is — so every test runs under exactly one of them and the floor is
# still measured over everything this target executes. `tests/e2e/ensure_baseline.rs`
# holds both recipes to that partition, because a filter that drifted here would
# leave the comparison running nowhere rather than failing.
# The crate's test suite (contract + e2e) with coverage enforced, less the baseline.
_crate-test:
    @cargo llvm-cov nextest --locked --fail-under-lines 95 \
      -E 'not test(/^baseline::/)' \
      --status-level fail --final-status-level fail \
      || { echo "tests failed, or coverage fell below 95% — cover the lines the table above counts as missed" >&2; exit 1; }

# The baseline comparison, behind an edge of its own because it is the one tier
# here that cannot run until another commit of this repository has been compiled.
# `onepipeline-ui:test-baseline` is what declares that dependency; `check` runs
# this target beside `test`, so the gate's verdict still covers it and only a
# `test` run on its own is spared the provisioning.
#
# No coverage instrumentation: these journeys ask what two *binaries* serve rather
# than which lines of this one ran, and the floor above is measured over the
# partition that excludes them.
# The base commit's server against this one — the comparison `test` leaves out.
# llmlint: ignore[diagnostics_error_or_absent] the compiler's diagnostics over these tests are denied by `_crate-lint`, which is `clippy --all-targets -- -D warnings` and reads this very journey; `RUSTFLAGS` here would deny them a second time at the price of rebuilding the shared `target/debug` under different flags every time this recipe alternates with `build` or `lint`, which is the cost the edge this target sits behind exists to avoid. `_crate-test` beside it is denied the same way and for the same reason.
_crate-test-baseline:
    @cargo nextest run --locked -E 'test(/^baseline::/)' --status-level fail --final-status-level fail

# Build the docs with warnings denied (kept in the gate so doc links don't rot).
_crate-doc:
    @RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet

# Coverage instrumentation is measured on Linux only, so the cross-platform CI
# legs run the same suite through this instead of `test`.
#
# The baseline comparison is excluded on the same terms coverage is. It asks
# whether *this crate* still serves what the commit it forked from served, which
# is a property of the payload rather than of the platform — and paying for a
# whole second server on each of the two cross legs would triple what the gate
# spends to learn one thing. The Linux `test-baseline` tier runs it, behind the
# `onepipeline-ui:ensure-baseline` target that provisions what it serves through.
# `ensure_baseline::` is *not* excluded: those journeys stub the build and are as
# platform-sensitive as any other recipe here.
# Full test suite without coverage instrumentation.
test-quick:
    @cargo nextest run --locked -E 'not test(/^baseline::/)' --status-level fail

# Drives the compiled binary and the committed npm launcher — never a stub. The
# whole e2e binary, which is `test` and `test-baseline` together: that split is
# about what the gate provisions for which tier, and reaching for the journeys
# themselves should not have to know it.
# The end-to-end journeys in isolation (all of them, unlike `test`).
test-e2e: _ensure-baseline
    @cargo nextest run --locked -E 'binary(e2e)' --status-level fail

# Run the CLI, e.g. `just run serve --runs-root ./runs`.
run *ARGS:
    cargo run --locked --quiet -- {{ARGS}}

# The operator iterates on this UI visually and cannot otherwise see it while a
# change is being made; the script's own header explains the per-invocation
# gallery. Not in `check`: it asserts nothing and writes images.
# Photograph the DAG Observatory at every viewport into a fresh gallery.
dag-ui-screens *ARGS:
    @bash scripts/dag-ui-screens.sh {{ARGS}}

# Reads the floor from Cargo.toml's `rust-version`; that toolchain must be
# installed (`rustup toolchain install <version>`). Warnings are errors here too.
# Build under the declared MSRV.
msrv:
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

# Separate from `check`: `cargo deny` needs a network-fetched advisory DB.
# Advisory + license audit and unused-dependency check.
deps-check:
    @command -v cargo-deny >/dev/null || { echo "cargo-deny not installed: cargo install cargo-deny --locked" >&2; exit 1; }
    @command -v cargo-machete >/dev/null || { echo "cargo-machete not installed: cargo install cargo-machete --locked" >&2; exit 1; }
    @cargo deny --log-level error check
    @# machete prints the unused deps it finds on stdout, so keep it: hiding
    @# them would leave a failing gate with no actionable detail.
    @cargo machete

# Upgrade dependencies, then re-run the full deterministic gate.
upgrade:
    @cargo update --quiet
    @npm update --silent --no-audit --no-fund
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
# Memoized: the judge is non-deterministic, so this runs the cached Nx target
# `onepipeline-ui:lint-llm-diff` rather than llmlint directly, and one tree judged
# against one base with one judge configuration gets one verdict — a second run
# over an unchanged tree replays the first run's report instead of rolling again.
# `scripts/llmlint-cached-diff.sh` holds what is keyed and why; only a clean run
# is replayed, because Nx caches successful tasks only.
#
# The name and the argument shape are what they always were, so the CI job and
# the operator calling `just lint-llm-diff origin/main` are unaffected. What the
# trailing arguments reach changed: they are Nx's now, not llmlint's, which is
# what makes `just lint-llm-diff origin/main --skip-nx-cache` the one supported
# way to force a fresh roll. Reach llmlint's own flags through `just lint-llm`,
# or `scripts/lint-llm-diff.sh` for the diff-scoped run without the memo.
# llmlint scoped to the files this branch changed since it forked from main.
lint-llm-diff base="origin/main" *nx_args:
    @./scripts/llmlint-cached-diff.sh "{{base}}" {{nx_args}}
