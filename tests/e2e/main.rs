//! End-to-end journeys: the compiled binary and the committed npm launcher,
//! driven the way a user drives them.
//!
//! Nothing here is stubbed. `baseline` serves one runs root through the binary
//! this branch forked from and through this one, comparing what each answered;
//! `ensure_baseline` drives the recipe that provisions the first of those two;
//! `cost` counts what the real binary asks the kernel for while it serves, which
//! is how the bounds on what a read costs are held; `cli` spawns the real binary
//! as a subprocess and
//! asserts on its exit code, stdout, and stderr; `server` starts that binary on
//! a real port over a directory the onepipeline SDK itself writes and reads the
//! bytes it serves; `packaging` assembles the real npm packages with
//! `scripts/npm-build.mjs` and runs the real launcher under node, resolving the
//! platform package through node's own resolution; `lint_llm_diff` runs the
//! gate's own llmlint recipe over a real git repository, `llmlint_cache` runs
//! the memo around that recipe over a real Nx workspace, `release_status` runs
//! the release workflow's own last job over a real GitHub Release's notes,
//! `semver_check` runs the reading the release takes of this crate's public
//! surface, `release_probe` runs the probe a consumer waiting on a release of
//! this repository asks, `nx_affected` asks the affected tier's own selection
//! what a committed change would run, `ci_tier` runs the step that tells a CI
//! build which tier of the gate it owes beside the workflow wiring that obeys
//! it, `report_workflow_failure` runs the reporter that is the
//! only alarm on a published-smoke failure, `ensure_sibling` runs the recipe
//! the gate provisions the sibling CLI with, plus the task graph Nx itself builds
//! for `test`, `linux_wheel` runs the one Linux wheel build both workflows share
//! up to the container it hands that build to, `workspace_install` runs the
//! script every recipe installs the TypeScript workspace through over a fresh
//! copy of this checkout, and `ui` starts the binary with `--ui` and reads the browser view
//! it serves beside the API against the bundle it embedded.
//!
//! What is under test in every one of them is the real script, recipe or binary,
//! over a real tree. Where a journey cannot let one of them reach a program for
//! real — because it bills a model call, rewrites a public Release, or compiles a
//! second CLI — the module that does so names it in its own header, beside the
//! directive that permits it and the reason it is the narrowest cut available.

mod baseline;
mod ci_tier;
mod cli;
mod cost;
mod ensure_baseline;
mod ensure_sibling;
mod lint_llm_diff;
// llmlint: ignore-block[e2e_not_mocked] the real `docker run` is a manylinux
// image compiling the whole release binary, minutes per target, which ci.yml's
// `wheel` legs run for real — then install and smoke-test — on every pull request
// that reaches the crate. The module stands in for `docker` and the image's tools
// at the PATH boundary only, and drives the real recipe and script.
// llmlint: ignore-block[tests_mirror_real_usage] the same substitution read by
// the other rule that names it: with the runtime stood in for, what the script
// asked it to run is the only place the image and prerequisites can be read, and
// every journey still drives `just wheel-linux` and asserts on its exit and
// stderr. The module header states both reasons in full.
// llmlint: ignore[expensive_tests_stay_behind_their_own_edge] nothing in this suite is expensive: it never starts Docker or compiles anything, and all of it runs in well under a second (17 journeys, 0.11s under nextest). The expensive half — the real build in the manylinux image — is already behind an edge of its own: `just wheel-linux`, run by ci.yml's `wheel` job and never by `test`.
mod linux_wheel;
// llmlint: ignore-end[tests_mirror_real_usage]
// llmlint: ignore-end[e2e_not_mocked]
// llmlint: ignore-block[e2e_not_mocked] the real `llmlint` bills a model call
// and answers differently on each roll, so a journey that drove it could not
// tell a replayed verdict from a lucky reroll — which is the entire subject of
// the suite this line declares. It substitutes exactly one program at the PATH
// boundary and nothing above it: the recipe, the Nx target, the scripts and the
// workspace it drives are all real, and the module records that substitution and
// its reason at the constant that makes it.
mod llmlint_cache;
// llmlint: ignore-end[e2e_not_mocked]
mod nx_affected;
mod packaging;
mod release_probe;
mod release_status;
mod report_workflow_failure;
mod semver_check;
mod server;
mod ui;
mod workspace_install;

#[path = "../support/cost.rs"]
mod cost_support;
#[path = "../support/fixture_run.rs"]
mod fixture_run;
#[path = "../support/harness_history.rs"]
mod harness_history;
#[path = "../support/http.rs"]
mod http;
#[path = "../support/journal_schema.rs"]
mod journal_schema;
#[path = "../support/release_declaration.rs"]
mod release_declaration;
#[path = "../support/scratch_repo.rs"]
mod scratch_repo;
#[path = "../support/serving.rs"]
mod serving;
#[path = "../support/sibling.rs"]
mod sibling;
#[path = "../support/stub_bin.rs"]
mod stub_bin;
#[path = "../support/timeline_schema.rs"]
mod timeline_schema;
#[path = "../support/workflow.rs"]
mod workflow;
