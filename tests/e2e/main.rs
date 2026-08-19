//! End-to-end journeys: the compiled binary and the committed npm launcher,
//! driven the way a user drives them.
//!
//! Nothing here is stubbed. `cli` spawns the real binary as a subprocess and
//! asserts on its exit code, stdout, and stderr; `server` starts that binary on
//! a real port over a directory the onepipeline SDK itself writes and reads the
//! bytes it serves; `packaging` assembles the real npm packages with
//! `scripts/npm-build.mjs` and runs the real launcher under node, resolving the
//! platform package through node's own resolution; `lint_llm_diff` runs the
//! gate's own llmlint recipe over a real git repository, `release_status` runs
//! the release workflow's own last job over a real GitHub Release's notes, and
//! `semver_check` runs the reading the release takes of this crate's public
//! surface.
//!
//! Those last three each stand in for exactly one program on PATH — `llmlint`,
//! which bills a model call, `gh`, which rewrites a public Release, and `cargo`,
//! whose reading downloads and builds two dependency trees. The script under test
//! is the real one in each, and `support/stub_bin.rs` is what makes what it asked
//! for readable.

mod cli;
mod lint_llm_diff;
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
