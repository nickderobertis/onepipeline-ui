//! End-to-end journeys: the compiled binary and the committed npm launcher,
//! driven the way a user drives them.
//!
//! Nothing here is stubbed. `cli` spawns the real binary as a subprocess and
//! asserts on its exit code, stdout, and stderr; `server` starts that binary on
//! a real port over a directory the onepipeline SDK itself writes and reads the
//! bytes it serves; `packaging` assembles the real npm packages with
//! `scripts/npm-build.mjs` and runs the real launcher under node, resolving the
//! platform package through node's own resolution.

mod cli;
mod packaging;
mod server;

#[path = "../support/fixture_run.rs"]
mod fixture_run;
#[path = "../support/http.rs"]
mod http;
#[path = "../support/serving.rs"]
mod serving;
