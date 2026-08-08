//! End-to-end journeys: the compiled binary and the committed npm launcher,
//! driven the way a user drives them.
//!
//! Nothing here is stubbed. `cli` spawns the real binary as a subprocess and
//! asserts on its exit code, stdout, and stderr; `packaging` assembles the real
//! npm packages with `scripts/npm-build.mjs` and runs the real launcher under
//! node, resolving the platform package through node's own resolution.

mod cli;
mod packaging;
