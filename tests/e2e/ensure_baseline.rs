//! The provisioning behind `tests/e2e/baseline.rs`: `just _ensure-baseline`, and
//! the task graph that reaches it.
//!
//! The comparison those journeys make is cheap; compiling another commit of this
//! repository is not. So the build lives behind the `onepipeline-ui:ensure-baseline`
//! target rather than inside the suite, on the terms `ensure-sibling` already sets
//! for the clone-local binary beside it. What is owed here is what the recipe does
//! with a tree that has no baseline, one already stamped with this branch's base,
//! and one stamped with some other commit — because the last of those is the only
//! failure that is silent: a stale server answers every request, and a comparison
//! against the wrong commit says nothing while looking exactly like one that did.
//!
//! One thing is stood in for: `cargo` on PATH. The real provisioning compiles a
//! whole dependency graph a generation old, which is neither quick nor offline.
//! The recipe under test is the real one, run out of a copy of the real justfile
//! over the real script, against a real git repository with a real base commit —
//! so what it asked cargo to build, and which commit it laid out to build it
//! from, are both readable here. The copy is the point rather than a shortcut:
//! the recipe writes into `justfile_directory()`, and a journey that let it write
//! into the repository would provision over the binary the rest of the suite
//! reads.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

use crate::stub_bin;

/// The suites that serve a run store through the base commit's binary, and so
/// cannot run before it is provisioned.
///
/// One target rather than the whole crate's `test`, because compiling another
/// commit of this repository is what the comparison costs and nothing else in the
/// suite owes it: `onepipeline-ui:test` runs everything but the comparison and
/// provisions nothing for it, and this target runs the comparison alone. What that
/// split can break is the comparison running *nowhere*, which is why
/// [`the_gate_runs_the_comparison_beside_the_rest_of_the_suite`] and
/// [`the_two_test_recipes_partition_the_suite`] are here beside it.
const SUITES_THAT_SERVE_THE_BASELINE: [&str; 1] = ["onepipeline-ui:test-baseline"];

const PROVISIONING: &str = "onepipeline-ui:ensure-baseline";

/// What the scratch repository's base commit holds, and what its branch commit
/// replaced it with. The stand-in copies this file where a real build would leave
/// its binary, so which of the two the provisioned server carries is which tree
/// the recipe laid out.
const AT_THE_BASE: &str = "the base commit's tree\n";
const ON_THE_BRANCH: &str = "the branch's tree\n";

/// The file that carries them, at the root of the tree the recipe lays out.
///
/// The stand-in `cargo` below spells this name again, in shell, where it cannot
/// read a constant declared here. The two are one file: move either alone and the
/// stand-in copies nothing, so the provisioned server says nothing about which
/// tree it was built from and every journey below reads the same empty answer.
const MARKER: &str = "which-tree.txt";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The name the platform gives the provisioned server, derived here and by the
/// justfile separately — a literal in one of the two would drift into a probe
/// that matches nothing on the platform it is wrong for, and a rebuild every run.
fn provisioned() -> String {
    format!("onepipeline-api-baseline{}", std::env::consts::EXE_SUFFIX)
}

/// A scratch git repository carrying the real recipe and the real script, with a
/// `main` to fork from, a branch commit on top of it, and a `cargo` that records
/// rather than builds.
struct Fixture {
    dir: TempDir,
    search_path: std::ffi::OsString,
    /// The commit `main` is at, which is what the recipe must resolve as the base.
    base: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path();
        fs::copy(repo_root().join("justfile"), root.join("justfile")).expect("copy the justfile");
        fs::create_dir_all(root.join("scripts")).expect("the scripts directory");
        fs::copy(
            repo_root().join("scripts/ensure-baseline-api.sh"),
            root.join("scripts/ensure-baseline-api.sh"),
        )
        .expect("copy the script");
        // The justfile reads the pinned sibling's version out of the lockfile at
        // parse time, so the tree needs one to be a tree `just` can read at all.
        for name in ["Cargo.lock", "Cargo.toml"] {
            fs::copy(repo_root().join(name), root.join(name)).unwrap_or_else(|error| {
                panic!("copy {name} into the scratch tree: {error}");
            });
        }
        fs::write(root.join(MARKER), AT_THE_BASE).expect("the base commit's marker");

        let git = |arguments: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(arguments)
                .output()
                .expect("git is on PATH");
            assert!(
                output.status.success(),
                "git {arguments:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        git(&["init", "--initial-branch=main", "--quiet"]);
        git(&["config", "user.email", "suite@example.invalid"]);
        git(&["config", "user.name", "the suite"]);
        git(&["add", "-A"]);
        git(&["commit", "--quiet", "-m", "the base commit"]);
        let base = git(&["rev-parse", "HEAD"]);

        // A branch commit on top, so the base the recipe must find is the merge
        // base rather than `HEAD` — which is what it is on every real branch, and
        // the marker is what tells the two trees apart once one is laid out.
        git(&["checkout", "--quiet", "-b", "a-branch"]);
        fs::write(root.join(MARKER), ON_THE_BRANCH).expect("the branch's marker");
        git(&["add", "-A"]);
        git(&["commit", "--quiet", "-m", "work in progress"]);

        // llmlint: ignore-block[e2e_not_mocked] the real call compiles the base
        // commit's whole dependency graph, which is the one thing an offline,
        // quick suite cannot drive — the gate and `just test` both run the real
        // one. The recipe under test is the real recipe out of the real justfile,
        // driving the real script over a real git repository; standing in for the
        // program on PATH is what makes the tree it laid out readable. This call
        // is the whole of that substitution.
        // llmlint: ignore-block[tests_mirror_real_usage] the same substitution
        // read by the other rule that names it, on the same terms and at the same
        // site: `cargo` is a program on PATH rather than a layer of this
        // repository, and every part of the recipe a user runs — the justfile,
        // the script, the git repository, the provisioning path, the stamp — is
        // the real one here. `tests/e2e/ensure_sibling.rs` stands in for the same
        // program for the same reason.
        let stub_dir = root.join("stub-bin");
        let search_path = stub_bin::install(
            &stub_dir,
            "cargo",
            // Records what it was asked for, and writes where a real build would
            // leave its binary — copying the laid-out tree's own marker, so the
            // provisioned server says which commit it was built from.
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$CARGO_CALLS\"\n\
             manifest=\"\"; target=\"\"\n\
             while [ \"$#\" -gt 0 ]; do\n\
               case \"$1\" in\n\
                 --manifest-path) manifest=\"$2\"; shift 2 ;;\n\
                 --target-dir) target=\"$2\"; shift 2 ;;\n\
                 *) shift ;;\n\
               esac\n\
             done\n\
             [ -n \"$target\" ] && [ -n \"$manifest\" ] || exit 1\n\
             [ \"${BUILD_STATUS:-0}\" = 0 ] || exit \"$BUILD_STATUS\"\n\
             mkdir -p \"$target/debug\"\n\
             cp \"$(dirname \"$manifest\")/which-tree.txt\" \"$target/debug/onepipeline-api\"\n\
             chmod +x \"$target/debug/onepipeline-api\"\n",
        );
        // llmlint: ignore-end[tests_mirror_real_usage]
        // llmlint: ignore-end[e2e_not_mocked]

        Self {
            dir,
            search_path,
            base,
        }
    }

    /// Where the recipe provisions to.
    fn binary(&self) -> PathBuf {
        self.dir.path().join(".tools/bin").join(provisioned())
    }

    fn stamp(&self) -> PathBuf {
        self.dir
            .path()
            .join(".tools/bin")
            .join(format!("{}.commit", provisioned()))
    }

    /// Run the recipe the way the `ensure-baseline` target runs it.
    fn run(&self) -> Output {
        self.run_with(&[])
    }

    fn run_with(&self, environment: &[(&str, &str)]) -> Output {
        let mut command = Command::new("just");
        command
            .arg("_ensure-baseline")
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

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn a_tree_with_no_baseline_gets_one_built_from_this_branchs_base() {
    let fixture = Fixture::new();

    let provisioning = fixture.run();
    assert!(provisioning.status.success(), "{}", stderr(&provisioning));
    assert!(
        fixture.binary().is_file(),
        "the recipe left no server where the suite reads one"
    );
    // The commit it was built from, twice over: the marker the laid-out tree
    // carried, and the stamp the recipe wrote beside the binary. Both are read
    // because the stamp is what the suite trusts and the marker is what the
    // recipe really compiled.
    assert_eq!(
        fs::read_to_string(fixture.binary()).expect("the provisioned server"),
        AT_THE_BASE,
        "the recipe built from this branch's own tree rather than from the commit \
         it forked from, which compares this build against itself"
    );
    assert_eq!(
        fs::read_to_string(fixture.stamp())
            .expect("the stamp")
            .trim(),
        fixture.base
    );
    assert!(
        fixture.calls().contains("--locked"),
        "the base commit's own lockfile decides its graph: {}",
        fixture.calls()
    );
}

#[test]
fn a_baseline_already_stamped_with_this_base_is_not_built_again() {
    let fixture = Fixture::new();

    assert!(fixture.run().status.success());
    let first = fixture.calls();
    let again = fixture.run();

    assert!(again.status.success(), "{}", stderr(&again));
    assert_eq!(
        fixture.calls(),
        first,
        "the recipe rebuilt a baseline it had already provisioned; every tier \
         that depends on this target would pay for a whole second server"
    );
}

#[test]
fn a_baseline_stamped_with_another_commit_is_built_again() {
    // The one failure that is silent if it is not caught here. A stale server
    // answers every request the comparison makes, so a journey run against it
    // reports that nothing was dropped between two commits neither of which is
    // the pair it was asked about.
    let fixture = Fixture::new();
    assert!(fixture.run().status.success());
    fs::write(
        fixture.stamp(),
        "0000000000000000000000000000000000000000\n",
    )
    .expect("restamp the provisioned server");
    let calls = fixture.calls();

    let again = fixture.run();

    assert!(again.status.success(), "{}", stderr(&again));
    assert_ne!(
        fixture.calls(),
        calls,
        "a baseline built from another commit was left in place"
    );
    assert_eq!(
        fs::read_to_string(fixture.stamp())
            .expect("the stamp")
            .trim(),
        fixture.base
    );
}

#[test]
fn a_build_that_failed_leaves_no_baseline_a_stamp_vouches_for() {
    // The stamp is what the suite reads to decide a provisioned server is the
    // right one, so a half-provisioned tree must read as "not provisioned"
    // rather than as a server with no commit behind it.
    let fixture = Fixture::new();

    let broken = fixture.run_with(&[("BUILD_STATUS", "1")]);

    assert!(!broken.status.success());
    assert!(
        stderr(&broken).contains("could not build the server at"),
        "the failure does not say what it could not do:\n{}",
        stderr(&broken)
    );
    assert!(!fixture.stamp().exists(), "a failed build left a stamp");
}

#[test]
fn a_checkout_with_no_default_branch_is_refused_rather_than_guessed() {
    let fixture = Fixture::new();
    let root = fixture.dir.path();
    // A checkout that resolves neither `origin/main` nor `main`: the base is not
    // knowable, and a baseline resolved to the wrong commit compares this build
    // against something that is not what it replaced.
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["branch", "-D", "main"])
        .output()
        .expect("git is on PATH");

    let refused = fixture.run();

    assert!(!refused.status.success());
    assert_eq!(refused.status.code(), Some(2));
    assert!(
        stderr(&refused).contains("resolves neither"),
        "the refusal does not say why it stopped:\n{}",
        stderr(&refused)
    );
}

#[test]
fn a_provisioning_path_outside_this_clone_is_refused() {
    // The path arrives from the environment and the script *deletes* at it before
    // installing, so a caller that could name any path could have the recipe
    // remove a file of its own choosing. The recipe exports exactly one value,
    // and anything else is refused rather than written to.
    // Driven at the script rather than through the recipe, because the recipe is
    // where the one value comes from: `just` *exports* the path, so a caller
    // cannot reach this guard through it. What can is a caller running the script
    // directly, which is exactly who the refusal's own ACTION line is addressed
    // to.
    let fixture = Fixture::new();
    let elsewhere = fixture.dir.path().join("somewhere-else");

    let refused = Command::new("bash")
        .arg("scripts/ensure-baseline-api.sh")
        .current_dir(fixture.dir.path())
        .env("PATH", &fixture.search_path)
        .env("CARGO_CALLS", fixture.dir.path().join("cargo-calls"))
        .env("ONEPIPELINE_UI_BASELINE_BIN", &elsewhere)
        .output()
        .expect("bash is on PATH");

    assert_eq!(refused.status.code(), Some(2), "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains("not this clone's provisioning path"),
        "the refusal does not say why it stopped:\n{}",
        stderr(&refused)
    );
    assert!(
        !elsewhere.exists(),
        "the refused path was written to anyway"
    );
    assert!(
        fixture.calls().is_empty(),
        "the recipe built a server for a path it was going to refuse"
    );
}

#[test]
fn every_suite_that_serves_the_baseline_depends_on_the_provisioning() {
    // The binary is clone-local and a publication clone is disposable, so a suite
    // that reached the comparison without this target would fail on a fresh clone
    // — which is exactly the tree the gate is asked to rule in.
    let project: Value = serde_json::from_str(
        &fs::read_to_string(repo_root().join("project.json")).expect("the project definition"),
    )
    .expect("the project definition parses");
    for suite in SUITES_THAT_SERVE_THE_BASELINE {
        let target = suite.rsplit(':').next().expect("a target name");
        let depends = project["targets"][target]["dependsOn"]
            .as_array()
            .unwrap_or_else(|| panic!("{suite} declares no dependencies"));
        assert!(
            depends
                .iter()
                .any(|edge| edge == &Value::String("ensure-baseline".into())),
            "{suite} serves a run store through the base commit's binary and does not \
             depend on {PROVISIONING}, so it fails on a clone nobody bootstrapped"
        );
    }
}

/// The comparison is reached by the gate, and not only by whoever asks for it.
///
/// The edge that makes the provisioning cheap — `test` no longer depending on it —
/// is the same edge that could leave the comparison running nowhere. `check` is
/// what every gate here fans out (`just check`, `just check-affected`, and `gate`
/// through the first of them), so a target missing from its dependencies is a tier
/// that silently stops running rather than one that fails.
#[test]
fn the_gate_runs_the_comparison_beside_the_rest_of_the_suite() {
    let workspace: Value = serde_json::from_str(
        &fs::read_to_string(repo_root().join("nx.json")).expect("the workspace definition"),
    )
    .expect("the workspace definition parses");
    let depends = workspace["targetDefaults"]["check"]["dependsOn"]
        .as_array()
        .expect("the check aggregate declares dependencies");
    for tier in ["test", "test-baseline"] {
        assert!(
            depends
                .iter()
                .any(|edge| edge == &Value::String(tier.into())),
            "`check` does not depend on `{tier}`, so the gate rules without running it"
        );
    }
}

/// Every test runs under exactly one of the two recipes the split leaves.
///
/// The filters are two halves of one partition — `_crate-test` is `not` what
/// `_crate-test-baseline` is — and they are written in two places, so nothing but
/// this holds them to each other. Either half drifting alone is silent: widen the
/// exclusion and tests stop running under the coverage floor, narrow the inclusion
/// and the comparison stops running at all.
#[test]
fn the_two_test_recipes_partition_the_suite() {
    let recipes = fs::read_to_string(repo_root().join("justfile")).expect("the justfile");
    let selection = "test(/^baseline::/)";
    let covered = format!("-E 'not {selection}'");
    let compared = format!("-E '{selection}'");
    assert!(
        recipes.contains(&covered),
        "`_crate-test` does not exclude the baseline journeys with `{covered}`, so the \
         floor is measured over a suite that needs the base commit's server"
    );
    assert!(
        recipes.contains(&compared),
        "no recipe selects the baseline journeys with `{compared}`, so the comparison \
         `onepipeline-ui:test-baseline` is declared for runs nowhere"
    );
}

/// The recipe writes where the suite reads, and neither restates the other's path.
#[test]
fn the_recipe_and_the_suite_name_one_provisioned_server() {
    let justfile = fs::read_to_string(repo_root().join("justfile")).expect("the justfile");
    let exported = justfile
        .lines()
        .find(|line| line.starts_with("export ONEPIPELINE_UI_BASELINE_BIN"))
        .expect("the justfile exports no baseline binary path");
    assert!(
        exported.contains(".tools/bin/onepipeline-api-baseline"),
        "the recipe provisions somewhere the suite does not read: {exported}"
    );
    assert!(
        exported.contains("sibling-exe"),
        "the exported path carries no platform extension, so the probe matches \
         nothing on Windows and rebuilds every run: {exported}"
    );
    let suite = fs::read_to_string(repo_root().join("tests/e2e/baseline.rs")).expect("the suite");
    assert!(
        suite.contains("ONEPIPELINE_UI_BASELINE_BIN"),
        "the suite does not read the variable the recipe exports"
    );
}
