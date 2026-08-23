//! End-to-end journeys: the compiled binary and the committed npm launcher,
//! driven the way a user drives them.
//!
//! Nothing here is stubbed. `cli` spawns the real binary as a subprocess and
//! asserts on its exit code, stdout, and stderr; `server` starts that binary on
//! a real port over a directory the onepipeline SDK itself writes and reads the
//! bytes it serves; `packaging` assembles the real npm packages with
//! `scripts/npm-build.mjs` and runs the real launcher under node, resolving the
//! platform package through node's own resolution; `lint_llm_diff` runs the
//! gate's own llmlint recipe over a real git repository, `llmlint_cache` runs
//! the memo around that recipe over a real Nx workspace, `release_status` runs
//! the release workflow's own last job over a real GitHub Release's notes,
//! `semver_check` runs the reading the release takes of this crate's public
//! surface, and `ensure_sibling` runs the recipe the gate provisions the sibling
//! CLI with, plus the task graph Nx itself builds for `test`.
//!
//! Those last five each stand in for exactly one program — `llmlint`, which
//! bills a model call and answers differently each time, `gh`, which rewrites a
//! public Release, and `cargo`, whose reading downloads and builds two dependency
//! trees and whose install compiles a second CLI. What is under test is the real
//! script or recipe in every one of them, and the stand-in only makes what it
//! asked for readable. `support/stub_bin.rs` is how four of them put it on PATH;
//! `llmlint_cache` installs its own inside the scratch `HOME` it hands the tier,
//! which is where `just setup-llmlint` installs the real one — so that
//! substitution also demonstrates the tier resolving its judge through its own
//! runtime environment rather than through the caller's.

mod cli;
mod ensure_sibling;
mod lint_llm_diff;
mod llmlint_cache;
mod packaging;
mod release_status;
mod semver_check;
mod server;

#[path = "../support/fixture_run.rs"]
mod fixture_run;
#[path = "../support/harness_history.rs"]
mod harness_history;
#[path = "../support/http.rs"]
mod http;
#[path = "../support/serving.rs"]
mod serving;
#[path = "../support/stub_bin.rs"]
mod stub_bin;
