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
    @cargo fetch --locked --quiet

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
check: fmt-check lint typecheck build test doc
    @bash scripts/nx.sh run-many -t check
    @echo "check: ok"

# What PR CI runs: the same gate, scoped to the projects this branch's diff can
# reach. Fails closed — with no derivable merge base it runs everything.
# Full deterministic quality gate, affected projects only.
check-affected:
    @bash scripts/nx-affected.sh -t check
    @echo "check-affected: ok"

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

# Every project's test suite; the crate's enforces its coverage floor.
test:
    @bash scripts/nx.sh run-many -t test

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
# The crate's full test suite (contract + e2e) with coverage enforced.
_crate-test:
    @cargo llvm-cov nextest --locked --fail-under-lines 95 \
      --status-level fail --final-status-level fail \
      || { echo "tests failed, or coverage fell below 95% — cover the lines the table above counts as missed" >&2; exit 1; }

# Build the docs with warnings denied (kept in the gate so doc links don't rot).
_crate-doc:
    @RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked --quiet

# Coverage instrumentation is measured on Linux only, so the cross-platform CI
# legs run the same suite through this instead of `test`.
# Full test suite without coverage instrumentation.
test-quick:
    @cargo nextest run --locked --status-level fail

# Drives the compiled binary and the committed npm launcher — never a stub.
# The end-to-end journeys in isolation (also run by `test`/`check`).
test-e2e:
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
# llmlint scoped to the files this branch changed since it forked from main.
lint-llm-diff base="origin/main" *args:
    @command -v llmlint >/dev/null 2>&1 || { echo "llmlint not installed — run 'just setup-llmlint'"; exit 1; }
    llmlint --diff --diff-base "{{base}}" {{args}}
