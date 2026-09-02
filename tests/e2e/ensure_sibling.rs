//! The gate's own provisioning: `just _ensure-sibling`, and the task graph that
//! reaches it.
//!
//! `.tools/` is the one thing the tiers need that lives inside the clone rather
//! than in a user-wide cache, so it is the one thing a fresh clone lacks — and a
//! gate is asked to rule in exactly such a tree, because a publication clone is
//! disposable and nobody bootstraps it by hand. These journeys are the two halves
//! of that: what the recipe does with a tree that has no sibling, a stray one, or
//! the pinned one, and whether the suites that start the read API reach the recipe
//! at all.
//!
//! One thing is stood in for: `cargo` on PATH, because the real provisioning
//! downloads and compiles the sibling CLI, which is neither offline nor quick.
//! The recipe under test is the real one, run out of a copy of the real justfile
//! over the real `Cargo.lock`, so the version it pins to is the version this
//! tree resolves — and what it asked cargo for is readable here. The copy is the
//! point rather than a shortcut: the recipe writes into `justfile_directory()`,
//! and a journey that let it write into the repository would provision over the
//! very binary the rest of the suite is reading.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

use onepipeline_ui::contract::Release;

use crate::stub_bin;

/// The tasks that start the read API, and so cannot run before the sibling is
/// provisioned: the crate's own suite, the baseline comparison, which starts two
/// servers rather than one, and the browser tier, whose Playwright journeys drive
/// a real server over a fixture runs root.
///
/// Three targets and not one, because each of them is a tier a reader can ask for
/// by name — that is what having an edge of their own means — and a tier reached
/// on its own is exactly the one whose provisioning nothing else has done.
const SUITES_THAT_START_THE_READ_API: [&str; 3] = [
    "onepipeline-ui:test",
    "onepipeline-ui:test-baseline",
    "dag-ui:test-browser",
];

/// The targets those tasks are reached through, which is what Nx is asked for.
const TIERS: &str = "test,test-baseline,test-browser";

const PROVISIONING: &str = "onepipeline-ui:ensure-sibling";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// A scratch tree carrying the real recipe, the real pin, and a `cargo` that
/// records rather than installs.
struct Fixture {
    dir: TempDir,
    search_path: std::ffi::OsString,
}

impl Fixture {
    /// A tree with no `.tools/` at all — a clone nobody has bootstrapped.
    fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        for name in ["justfile", "Cargo.lock", "Cargo.toml"] {
            fs::copy(repo_root().join(name), dir.path().join(name))
                .unwrap_or_else(|error| panic!("copy {name} into the scratch tree: {error}"));
        }

        // Records what the recipe asked for, and answers with the status the case
        // under test is about.
        //
        // llmlint: ignore-block[e2e_not_mocked] the real call downloads and
        // compiles the sibling CLI, which is the one thing an offline,
        // deterministic gate cannot drive — `just bootstrap` and this recipe in
        // the gate both run the real one. The recipe under test is the real
        // recipe, out of the real justfile, pinning off the real `Cargo.lock`;
        // standing in for the program on PATH is what makes the version it asked
        // to install readable. This call is the whole of that substitution.
        let stub_dir = dir.path().join("stub-bin");
        let search_path = stub_bin::install(
            &stub_dir,
            "cargo",
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$CARGO_CALLS\"\n\
             exit \"${INSTALL_STATUS:-0}\"\n",
        );
        // llmlint: ignore-end[e2e_not_mocked]

        Self { dir, search_path }
    }

    /// Put a build of the sibling where the recipe looks, reporting `version`.
    fn sibling_in_the_tree(&self, version: &str) {
        self.write_stub_sibling(&self.dir.path().join(".tools/bin"), version);
    }

    /// Put a build of the sibling on PATH — where the recipe must never look.
    fn sibling_on_path(&self, version: &str) {
        self.write_stub_sibling(&self.dir.path().join("stub-bin"), version);
    }

    // llmlint: ignore[e2e_not_mocked] this stands in for the *provisioned
    // artifact*, not for the recipe under test: what the journeys need is a
    // program that answers `--version`, and building the real CLI to ask it that
    // is the download this suite exists without.
    fn write_stub_sibling(&self, dir: &Path, version: &str) {
        stub_bin::install(
            dir,
            &provisioned_sibling(),
            &format!("#!/usr/bin/env bash\nprintf 'onepipeline {version}\\n'\n"),
        );
    }

    /// Run the recipe the way `bootstrap` and the `ensure-sibling` target run it.
    fn run(&self) -> Output {
        self.run_with(&[])
    }

    /// The same, with `environment` deciding what the stand-in answers.
    fn run_with(&self, environment: &[(&str, &str)]) -> Output {
        let mut command = Command::new("just");
        command
            .arg("_ensure-sibling")
            .current_dir(self.dir.path())
            .env("PATH", &self.search_path)
            .env("CARGO_CALLS", self.dir.path().join("cargo-calls"));
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("just is on PATH")
    }

    /// Everything the recipe asked `cargo` for, in order.
    fn calls(&self) -> String {
        fs::read_to_string(self.dir.path().join("cargo-calls")).unwrap_or_default()
    }
}

/// The file a `cargo install` of the sibling leaves in `.tools/bin`, named the
/// way the platform running this suite names an executable.
///
/// Read from Rust's own executable extension — the one cargo appends to the
/// binary it writes — so this journey derives that name from the platform and
/// the recipe derives it from the platform, separately. A recipe that probed the
/// extensionless name on Windows would find nothing here either, which is the
/// reinstall-every-run these journeys are here to refuse.
fn provisioned_sibling() -> String {
    format!("onepipeline{}", std::env::consts::EXE_SUFFIX)
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The install the recipe must ask for, spelled out: the release this build
/// links, from the SDK's own package version rather than a second reading of the
/// lockfile, and into the tree rather than onto the machine.
fn pinned_install() -> String {
    format!(
        "install onepipeline --version {} --locked --root .tools --quiet",
        Release::linked().as_str()
    )
}

/// A tree nobody bootstrapped provisions the sibling itself, at the version this
/// tree's lockfile resolves.
///
/// This is the whole reason the recipe is on the gate's path: `just check` in a
/// fresh clone used to fail every journey that starts the read API on a missing
/// binary.
#[test]
fn a_tree_with_no_sibling_provisions_the_pinned_one() {
    let fixture = Fixture::new();
    let output = fixture.run();

    assert!(
        output.status.success(),
        "provisioning a fresh tree failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        pinned_install(),
        "the recipe did not install the release this build links, into the tree"
    );
}

/// A sibling already at the pin is left alone, so the gate pays the version probe
/// and nothing else on every run after the first.
#[test]
fn a_sibling_already_at_the_pin_is_not_reinstalled() {
    let fixture = Fixture::new();
    fixture.sibling_in_the_tree(Release::linked().as_str());

    let output = fixture.run();

    assert!(
        output.status.success(),
        "a provisioned tree failed the check:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the pinned sibling was reinstalled, so every gate run pays for a build"
    );
}

/// A sibling at any other release is refused rather than used. It speaks a
/// different telemetry document, and reading one as the other is how a run gets
/// served with no clock at all.
#[test]
fn a_sibling_at_another_release_is_refused_and_replaced() {
    let fixture = Fixture::new();
    fixture.sibling_in_the_tree("0.0.1-stray");

    let output = fixture.run();

    assert!(
        output.status.success(),
        "replacing a stray build failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        pinned_install(),
        "a build at another release was accepted instead of replaced"
    );
}

/// A build on PATH is not the provisioned one, whatever release it reports. The
/// recipe looks at one path and PATH is not it.
#[test]
fn a_sibling_on_path_is_never_taken_for_the_provisioned_one() {
    let fixture = Fixture::new();
    fixture.sibling_on_path(Release::linked().as_str());

    let output = fixture.run();

    assert!(
        output.status.success(),
        "provisioning past a build on PATH failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        pinned_install(),
        "a build on PATH was taken for the provisioned sibling"
    );
}

/// Provisioning that could not happen stops the run and says what is missing,
/// because the alternative is every journey after it failing on a missing file
/// with no reason attached — which is what sent this change.
#[test]
fn provisioning_that_fails_says_which_release_could_not_be_installed() {
    let fixture = Fixture::new();
    let output = fixture.run_with(&[("INSTALL_STATUS", "1")]);

    assert!(
        !output.status.success(),
        "an install that failed reported success"
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains(Release::linked().as_str()) && stderr.contains("onepipeline"),
        "the failure does not name the release that could not be provisioned:\n{stderr}"
    );
}

/// Every suite that starts the read API reaches the provisioning through Nx's
/// own task graph.
///
/// Asked of Nx rather than of the files it reads, because a `dependsOn` naming
/// another project is resolved rather than copied: an entry Nx does not
/// understand is dropped silently, and the tier goes back to failing in a clean
/// clone with the configuration still looking correct.
#[test]
fn every_suite_that_starts_the_read_api_provisions_the_sibling_first() {
    // Through `just nx`, this workspace's one way in to Nx, rather than either
    // hand-rolled equivalent: `scripts/nx.sh` is a `.sh` file, which is not a
    // program on Windows, and a bare `bash` is not the shell there either — the
    // system directory outranks PATH, and the `bash` in it is a Windows
    // Subsystem for Linux launcher with nothing installed behind it.
    //
    // Answered onto stdout rather than into a file the journey names: a recipe
    // pastes its arguments into a shell line, and a Windows temporary directory
    // is separated by backslashes, which that line would spend as escapes — so
    // Nx would write the graph somewhere nobody is reading and exit happily.
    // `--graph=stdout` is the same document with no path to lose.
    let output = Command::new("just")
        .args(["nx", "run-many", "-t", TIERS, "--graph=stdout"])
        .current_dir(repo_root())
        .output()
        .expect("just is on PATH");
    assert!(
        output.status.success(),
        "Nx could not build the task graph for `{TIERS}` ({}):\n{}{}",
        output.status,
        stderr(&output),
        String::from_utf8_lossy(&output.stdout)
    );

    let dependencies = task_dependencies(&output.stdout);
    for suite in SUITES_THAT_START_THE_READ_API {
        assert!(
            dependencies.contains_key(suite),
            "{suite} is not in the graph `{TIERS}` runs; the list here names a \
             project that no longer has that test target"
        );
        assert!(
            reaches(&dependencies, suite, PROVISIONING),
            "{suite} starts the read API and does not depend on {PROVISIONING}, so \
             it fails in a tree nobody bootstrapped"
        );
    }
    assert_eq!(
        dependencies
            .keys()
            .filter(|task| *task == PROVISIONING)
            .count(),
        1,
        "the provisioning is more than one task, so two of them can install into \
         `.tools/` at once"
    );
}

/// The graph's `task -> its dependencies` edges, as Nx answered them.
fn task_dependencies(graph: &[u8]) -> BTreeMap<String, Vec<String>> {
    let document: Value =
        serde_json::from_slice(graph).expect("Nx answered with the graph as JSON");
    document["tasks"]["dependencies"]
        .as_object()
        .expect("the graph names each task's dependencies")
        .iter()
        .map(|(task, dependencies)| {
            let edges = dependencies
                .as_array()
                .expect("a task's dependencies are a list")
                .iter()
                .map(|edge| edge.as_str().expect("a task name").to_owned())
                .collect();
            (task.clone(), edges)
        })
        .collect()
}

/// Whether `target` is reachable from `from` along those edges, so a dependency
/// declared one hop away counts as much as a direct one.
fn reaches(dependencies: &BTreeMap<String, Vec<String>>, from: &str, target: &str) -> bool {
    let mut seen = BTreeSet::new();
    let mut pending = vec![from.to_owned()];
    while let Some(task) = pending.pop() {
        if task == target {
            return true;
        }
        if !seen.insert(task.clone()) {
            continue;
        }
        pending.extend(dependencies.get(&task).into_iter().flatten().cloned());
    }
    false
}
