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
//! What is under test in every one of them is the real script, recipe or binary,
//! over a real tree. Where a journey cannot let one of them reach a program for
//! real — because it bills a model call, rewrites a public Release, or compiles a
//! second CLI — the module that does so names it in its own header, beside the
//! directive that permits it and the reason it is the narrowest cut available.

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
