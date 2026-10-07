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
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

use crate::stub_bin;

/// The suites that serve a run store through the base commit's binary, and so
/// cannot run before it is provisioned.
///
/// A project of its own rather than part of the crate's tests, because compiling
/// another commit of this repository is what the comparison costs and nothing else
/// in the suite owes it: the other tiers provision nothing for it, and this target
/// runs the comparison alone. What that split can break is the comparison running
/// *nowhere*, which is why [`the_gate_runs_the_comparison_beside_the_rest_of_the_suite`]
/// and [`the_tier_profiles_partition_the_suite`] are here beside it.
const SUITES_THAT_SERVE_THE_BASELINE: [&str; 1] = ["onepipeline-ui-baseline:test-baseline"];

/// The crate's test tiers: the Nx project and target each runs as, and the
/// nextest profile in `.config/nextest.toml` that selects its tests.
const TIERS: [(&str, &str, &str); 5] = [
    ("onepipeline-ui", "test", "unit"),
    ("onepipeline-ui-e2e", "test", "e2e"),
    ("onepipeline-ui-repo-tooling", "test", "repo-tooling"),
    ("onepipeline-ui-baseline", "test-baseline", "baseline"),
    ("onepipeline-ui-cost", "test-cost", "cost"),
];

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

/// What the two servers are called before the platform has its say.
///
/// The provisioned one and the one a build leaves behind are different files with
/// one suffix between them, so the suffix is derived once and each name is that
/// derivation over its own stem.
const PROVISIONED_STEM: &str = "onepipeline-api-baseline";
const BUILT_STEM: &str = "onepipeline-api";

/// The name the platform gives the provisioned server, derived here and by the
/// justfile separately — a literal in one of the two would drift into a probe
/// that matches nothing on the platform it is wrong for, and a rebuild every run.
fn provisioned() -> String {
    format!("{PROVISIONED_STEM}{}", std::env::consts::EXE_SUFFIX)
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
        Self::building(std::env::consts::EXE_SUFFIX)
    }

    /// A fixture whose stand-in build leaves its binary under `executable_suffix`.
    ///
    /// The suffix is a parameter rather than always this platform's because the
    /// script takes the built binary's name off the *destination* while the build
    /// gives it whatever the platform gives it — two derivations that agree on
    /// every real host and can only be told apart by driving a suffix this host
    /// does not have. [`the_build_is_installed_from_where_a_suffixed_platform_leaves_it`]
    /// is what drives it; every other journey takes this platform's.
    fn building(executable_suffix: &str) -> Self {
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
        // The marker stands in for a compiled binary, so nothing may rewrite its
        // bytes on the way out of version control — and `git archive` below is
        // exactly a way out of it. Declared here rather than left to the host,
        // because whether anything rewrites them is the host's own git
        // configuration: the Windows runners this suite runs on install git with
        // `core.autocrlf=true`, which turned the recipe's own output into a tree
        // the comparison read as a different one, on that leg alone.
        fs::write(root.join(".gitattributes"), format!("{MARKER} -text\n"))
            .expect("the scratch tree's attributes");
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
        // The conversion the attribute above exempts the marker from, turned on
        // for this scratch repository whatever the host's own setting is. It is
        // the Windows runners' default and it is off on every other host here, so
        // without it the exemption is unreachable from the platforms this suite
        // is developed on — which is how three journeys came to fail on that leg
        // and none here.
        git(&["config", "core.autocrlf", "true"]);
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
            // provisioned server says which commit it was built from. Under the
            // platform's own suffix, because that is the file `cargo` leaves and
            // the file the script then looks for; a bare name here is one the
            // script cannot find on any platform that has a suffix, which is a
            // failure no host without one can reach.
            &format!(
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
                 [ \"${{BUILD_STATUS:-0}}\" = 0 ] || exit \"$BUILD_STATUS\"\n\
                 mkdir -p \"$target/debug\"\n\
                 cp \"$(dirname \"$manifest\")/which-tree.txt\" \"$target/debug/{built}\"\n\
                 chmod +x \"$target/debug/{built}\"\n",
                built = format!("{BUILT_STEM}{executable_suffix}"),
            ),
        );
        // llmlint: ignore-end[tests_mirror_real_usage]
        // llmlint: ignore-end[e2e_not_mocked]

        Self {
            dir,
            search_path,
            base,
        }
    }

    fn binary(&self) -> PathBuf {
        self.dir.path().join(".tools/bin").join(provisioned())
    }

    fn stamp(&self) -> PathBuf {
        self.dir
            .path()
            .join(".tools/bin")
            .join(format!("{}.commit", provisioned()))
    }

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

    /// The script on its own, provisioning to a path of the caller's choosing.
    ///
    /// Driven at the script rather than through the recipe, because the recipe is
    /// where the one value comes from: `just` *exports* the path, so nothing a
    /// caller hands `just` reaches this guard. What can is somebody running the
    /// script directly, which is who its refusal's own ACTION line addresses.
    fn run_script_provisioning_to(&self, binary: &Path) -> Output {
        Command::new("bash")
            .arg("scripts/ensure-baseline-api.sh")
            .current_dir(self.dir.path())
            .env("PATH", &self.search_path)
            .env("CARGO_CALLS", self.dir.path().join("cargo-calls"))
            .env("ONEPIPELINE_UI_BASELINE_BIN", binary)
            .output()
            .expect("bash is on PATH")
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
    let fixture = Fixture::new();
    let another_directory = fixture.dir.path().join("elsewhere");
    fs::create_dir_all(&another_directory).expect("a directory that is not the clone's");
    // Two shapes, because the guard asks two questions and either alone lets a
    // path through. The file name is compared whole — a directory test on its own
    // admits `.tools/bin/../../something` — and the directory has to be the one
    // this clone provisions, which is the only thing that refuses the *right*
    // name written somewhere the caller chose.
    for elsewhere in [
        fixture.dir.path().join("somewhere-else"),
        another_directory.join(provisioned()),
    ] {
        let refused = fixture.run_script_provisioning_to(&elsewhere);

        assert_eq!(
            refused.status.code(),
            Some(2),
            "{elsewhere:?}: {}",
            stderr(&refused)
        );
        assert!(
            stderr(&refused).contains("not this clone's provisioning path"),
            "the refusal does not say why it stopped for {elsewhere:?}:\n{}",
            stderr(&refused)
        );
        assert!(
            !elsewhere.exists(),
            "the refused path {elsewhere:?} was written to anyway"
        );
        assert!(
            fixture.calls().is_empty(),
            "the recipe built a server for a path it was going to refuse"
        );
    }
}

/// The provisioning path is a place on disk, not one spelling of one.
///
/// The two sides of that guard are written by different programs, and they do not
/// agree how to spell a directory they both mean: `just` hands over a native path
/// where the script's own shell says something else, which on a Windows runner is
/// `C:\Users\RUNNER~1\...` against `/c/Users/runneradmin/...` and on macOS is
/// `$TMPDIR` with and without `/private`. Comparing them as strings refused the
/// one path the recipe exports, and it did so on the cross-platform legs alone —
/// invisible from a Linux tree, where the two spellings happen to coincide.
#[test]
fn the_provisioning_path_is_accepted_however_it_is_spelled() {
    let fixture = Fixture::new();
    // The same directory by another name. A real cross-platform run reaches it
    // through a drive letter or a symlinked `$TMPDIR` rather than through `..`,
    // neither of which a Linux tree can spell — what is portable is that the
    // filesystem, and not the string, decides.
    let spelled_otherwise = fixture
        .dir
        .path()
        .join(".tools/bin/../bin")
        .join(provisioned());

    let provisioning = fixture.run_script_provisioning_to(&spelled_otherwise);

    assert!(provisioning.status.success(), "{}", stderr(&provisioning));
    assert_eq!(
        fs::read_to_string(fixture.binary()).expect("the provisioned server"),
        AT_THE_BASE,
        "the script accepted the path but provisioned somewhere the suite does not read"
    );
}

/// The install reads the build where a platform that suffixes its executables
/// leaves it.
///
/// Three parties name one file and each derives the suffix its own way: the
/// justfile gives the destination the platform's, the script takes the built
/// binary's from that destination, and the build gives its output whatever the
/// platform gives it. On a host with no suffix all three are the empty string, so
/// a stand-in that wrote the bare name agreed with everything here and disagreed
/// with `cargo` on Windows — where the script looked for `onepipeline-api.exe`
/// and the build had left `onepipeline-api`, taking down three journeys on that
/// leg alone and none here. Driving the suffixed shape is the only way that
/// disagreement is reachable from a platform that has no suffix of its own; it is
/// [`the_provisioning_path_is_accepted_however_it_is_spelled`]'s reason, for the
/// other half of the same file name.
#[test]
fn the_build_is_installed_from_where_a_suffixed_platform_leaves_it() {
    const SUFFIXED: &str = ".exe";
    let fixture = Fixture::building(SUFFIXED);
    let destination = fixture
        .dir
        .path()
        .join(".tools/bin")
        .join(format!("{PROVISIONED_STEM}{SUFFIXED}"));

    let provisioning = fixture.run_script_provisioning_to(&destination);

    assert!(provisioning.status.success(), "{}", stderr(&provisioning));
    assert_eq!(
        fs::read_to_string(&destination).expect("the provisioned server"),
        AT_THE_BASE,
        "the script installed something other than the tree the build laid out"
    );
}

#[test]
fn every_suite_that_serves_the_baseline_depends_on_the_provisioning() {
    // The binary is clone-local and a publication clone is disposable, so a suite
    // that reached the comparison without this target would fail on a fresh clone
    // — which is exactly the tree the gate is asked to rule in.
    let (provider, provision) = PROVISIONING.split_once(':').expect("a project:target");
    for suite in SUITES_THAT_SERVE_THE_BASELINE {
        let (name, target) = suite.split_once(':').expect("a project:target");
        let project = project_definition(name);
        let depends = project["targets"][target]["dependsOn"]
            .as_array()
            .unwrap_or_else(|| panic!("{suite} declares no dependencies"));
        // Either spelling Nx reads: a target of the suite's own project by name,
        // or another project's named in full.
        let provisions = |edge: &Value| match edge {
            Value::String(own) => name == provider && own == provision,
            Value::Object(_) => {
                edge["target"] == provision
                    && edge["projects"]
                        .as_array()
                        .is_some_and(|projects| projects.iter().any(|p| p == provider))
            }
            _ => false,
        };
        assert!(
            depends.iter().any(provisions),
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
    // Every tier's own target, and the floor measured over the instrumented ones.
    let owed = TIERS
        .iter()
        .map(|(_, target, _)| *target)
        .chain(["coverage"]);
    for tier in owed {
        assert!(
            depends
                .iter()
                .any(|edge| edge == &Value::String(tier.into())),
            "`check` does not depend on `{tier}`, so the gate rules without running it"
        );
    }
}

/// The comparison is re-run when the commit it compares against moves.
///
/// `test-baseline` is cached on a narrow set of inputs, so a change to a document,
/// a workflow or the frontend replays its verdict instead of paying for the
/// comparison — which is the whole point of it having an edge of its own. What no
/// file input can state is which commit this branch forked from: a rebase moves the
/// baseline while touching none of them, and a replayed verdict would then be about
/// a commit this branch no longer forks from. The runtime input is what closes that,
/// and this holds it to the resolution the journeys themselves use rather than to a
/// second reading of it.
#[test]
fn the_comparison_is_keyed_by_the_commit_it_compares_against() {
    let project = project_definition("onepipeline-ui-baseline");
    let resolution = project["targets"]["test-baseline"]["inputs"]
        .as_array()
        .expect("the comparison declares its inputs")
        .iter()
        .find_map(|input| input.get("runtime")?.as_str())
        .expect("the comparison declares a runtime input naming its baseline");

    let resolved = Command::new("sh")
        .arg("-c")
        .arg(resolution)
        .current_dir(repo_root())
        .output()
        .expect("the runtime input runs");
    assert!(
        resolved.status.success(),
        "the runtime input `{resolution}` failed in this checkout: {}",
        String::from_utf8_lossy(&resolved.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&resolved.stdout).trim(),
        crate::baseline::base_commit(),
        "the comparison is cached against a commit that is not the one it compares \
         against, so a moved base would replay a verdict about the old one"
    );
}

/// Every leg that runs the gate checks out the history the gate resolves.
///
/// [`the_comparison_is_keyed_by_the_commit_it_compares_against`] reads version
/// control rather than a file, and `test-quick` deliberately does not exclude
/// `ensure_baseline::` from the cross-platform legs — these journeys stub the
/// build and are as platform-sensitive as any other recipe here. What that costs
/// is a checkout: at `actions/checkout`'s default depth there is no `origin/main`
/// and no `main`, so the resolution fails for want of history on a runner that
/// got nothing wrong. That failure is loud but unreadable — a red macOS leg
/// naming a git object — and it is invisible from here, because every local tree
/// has the refs it wants.
///
/// Every workflow, rather than `ci.yml`: the gate is re-run on the release path
/// as well, over a checkout of its own, and a guard that read one file said
/// nothing about the other. That is not hypothetical — `release.yml` ran `just
/// check` at the default depth while this was scoped to `ci.yml`, so the branch
/// that put the resolution in the gate would have reddened the release the first
/// time it cut one, in the same way and for the same reason, with the check that
/// exists to prevent it passing.
#[test]
fn every_leg_running_the_gate_checks_out_the_history_it_resolves() {
    let mut legs = 0_usize;
    for workflow in workflows() {
        let name = workflow
            .file_name()
            .expect("a workflow file name")
            .to_string_lossy()
            .into_owned();
        let text = fs::read_to_string(&workflow)
            .unwrap_or_else(|error| panic!("{}: {error}", workflow.display()));
        for (job, block) in jobs_in(&text) {
            if !block.contains("run: just check") {
                continue;
            }
            legs += 1;
            assert!(
                block.contains("fetch-depth: 0"),
                "the `{job}` job in {name} runs the gate over a shallow checkout, which \
                 resolves neither `origin/main` nor `main`, so every journey that reads \
                 the base commit fails there for want of history"
            );
        }
    }
    assert!(
        legs > 0,
        "no job in any workflow runs a `just check` recipe, so this is guarding nothing"
    );
}

/// Every workflow this repository declares, in a stable order.
///
/// Read off the directory rather than listed here, so a workflow added later is
/// guarded by being a workflow rather than by somebody remembering this test.
fn workflows() -> Vec<PathBuf> {
    let directory = repo_root().join(".github/workflows");
    let mut found: Vec<PathBuf> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("{}: {error}", directory.display()))
        .map(|entry| entry.expect("a workflow directory entry").path())
        .filter(|path| {
            matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("yml" | "yaml")
            )
        })
        .collect();
    assert!(
        !found.is_empty(),
        "{} holds no workflow, so this is guarding nothing",
        directory.display()
    );
    found.sort();
    found
}

/// The workflow's job ids, each paired with the block that follows it.
///
/// A YAML parser would be a dependency for one assertion, and the shape being
/// read is a fixed two-level one: job ids are the keys indented by exactly two
/// spaces under the top-level `jobs:`.
fn jobs_in(workflow: &str) -> Vec<(String, String)> {
    let mut jobs: Vec<(String, String)> = Vec::new();
    let mut inside = false;
    for line in workflow.lines() {
        if !line.starts_with([' ', '\t', '#']) && !line.is_empty() {
            inside = line.starts_with("jobs:");
            continue;
        }
        if !inside {
            continue;
        }
        match line
            .strip_prefix("  ")
            .filter(|rest| !rest.starts_with([' ', '#']))
            .and_then(|rest| rest.strip_suffix(':'))
        {
            Some(id) => jobs.push((id.to_owned(), String::new())),
            None => {
                if let Some((_, block)) = jobs.last_mut() {
                    block.push_str(line);
                    block.push('\n');
                }
            }
        }
    }
    jobs
}

/// Every module a tier's journeys read is one of the files that tier is keyed on.
///
/// A tier's inputs are the modules that decide what it runs rather than the whole
/// suite — which is also what decides whether a change selects it at all, since a
/// tier is a project of its own and Nx reaches it through those inputs alone. What
/// that costs is a list: a helper a tier starts reading and nobody adds to it is
/// one whose edits neither select the tier nor invalidate its cache, silently and
/// in the direction of passing. So the list is read back off the journeys
/// themselves: the modules the tier's nextest profile selects, the file that
/// declares them, and every module those reach for in turn.
#[test]
fn every_tier_is_keyed_by_every_module_its_journeys_read() {
    let declared = e2e_modules();
    let profiles = tier_profiles();
    for (name, target, profile) in TIERS {
        // The crate's own tier is the root project, keyed on everything it owns,
        // which is every file under `tests/` no tier project claims.
        if name == "onepipeline-ui" {
            continue;
        }
        let keyed = target_inputs(name, target);
        let selection = &profiles[profile];
        let selected = selection.modules.iter().cloned().chain(
            // The `e2e` profile is the complement of the others, so its modules
            // are every journey module the others leave.
            (profile == "e2e")
                .then(|| {
                    declared
                        .keys()
                        .filter(|module| declared[*module].starts_with("tests/e2e/"))
                        .filter(|module| !selection.excluded.contains(*module))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .into_iter()
                .flatten(),
        );
        let mut pending: Vec<String> = selected.collect();
        let mut files = vec!["tests/e2e/main.rs".to_owned()];
        if selection
            .binaries
            .iter()
            .any(|binary| binary == "packaging")
        {
            files.push("tests/packaging.rs".to_owned());
            files.extend(path_modules("tests/packaging.rs"));
        }
        let mut seen = std::collections::BTreeSet::new();
        while let Some(module) = pending.pop() {
            if !seen.insert(module.clone()) {
                continue;
            }
            let file = declared.get(&module).unwrap_or_else(|| {
                panic!("`{profile}` selects `{module}`, which main.rs does not declare")
            });
            files.push(file.clone());
            let text = fs::read_to_string(repo_root().join(file))
                .unwrap_or_else(|error| panic!("{file}: {error}"));
            pending.extend(
                text.split("crate::")
                    .skip(1)
                    .filter_map(|rest| {
                        rest.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                            .next()
                    })
                    .filter(|used| declared.contains_key(*used))
                    .map(str::to_owned),
            );
        }
        for file in files {
            assert!(
                keyed.iter().any(|input| input == &file),
                "`{name}:{target}` is not keyed on `{file}`, which its journeys read, so an \
                 edit to it neither selects the tier nor re-runs it"
            );
        }
    }
}

/// Every test runs under exactly one tier.
///
/// The suite is five Nx projects, each running its own nextest profile, and the
/// five filters are the halves of one partition: `unit` is every binary but the
/// two the other tiers draw on, and inside `e2e` the `e2e` profile is `not` what
/// the other three select. They are written as module lists in two places, so
/// nothing but this holds them to each other — and either side drifting alone is
/// silent: widen an exclusion and tests stop running under the coverage floor,
/// narrow an inclusion and a whole tier is declared for and runs nowhere. The
/// tier projects are held to the profiles too, since a target naming the wrong
/// profile runs another tier's tests twice and its own never.
// llmlint: ignore-block[tests_mirror_real_usage] there is no command surface to drive here:
// the property is that five *declarations* in one file partition one name space, and the
// only way to observe it through the recipes would be to run all five tiers and see which
// tests executed — which means compiling the base commit's server and provisioning a syscall
// tracer to learn something about five strings. Asking `cargo nextest list` what each
// profile selects is the real interface, and is refused here for a different reason: a nested
// cargo inside a running suite contends for the target-directory lock, which is a hang rather
// than a verdict. Every other test in this module drives the real recipe.
#[test]
fn the_tier_profiles_partition_the_suite() {
    let declared = e2e_modules();
    let journeys: std::collections::BTreeSet<&String> = declared
        .iter()
        .filter(|(_, file)| file.starts_with("tests/e2e/"))
        .map(|(module, _)| module)
        .collect();
    let profiles = tier_profiles();

    // Inside the `e2e` binary: the three selections are disjoint, and the `e2e`
    // profile excludes exactly their union.
    let mut drawn = std::collections::BTreeSet::new();
    for profile in ["repo-tooling", "baseline", "cost"] {
        for module in &profiles[profile].modules {
            assert!(
                journeys.contains(module),
                "the `{profile}` profile selects `{module}`, which is no module of the e2e binary"
            );
            assert!(
                drawn.insert(module.clone()),
                "`{module}` is selected by two tiers, so it runs twice"
            );
        }
    }
    assert_eq!(
        profiles["e2e"].excluded, drawn,
        "the `e2e` profile does not exclude exactly what the other tiers select, so a \
         module runs in two tiers or in none"
    );

    // Across binaries: `unit` is every binary but the ones the others draw on.
    let others: std::collections::BTreeSet<String> = ["e2e", "repo-tooling", "baseline", "cost"]
        .iter()
        .flat_map(|profile| profiles[*profile].binaries.iter().cloned())
        .collect();
    assert_eq!(
        profiles["unit"].excluded_binaries, others,
        "the `unit` profile does not exclude exactly the binaries the other tiers run"
    );

    // Each tier's project runs its own profile, through the recipe that names it.
    for (name, target, profile) in TIERS {
        let command = project_definition(name)["targets"][target]["command"]
            .as_str()
            .unwrap_or_else(|| panic!("`{name}:{target}` has no command"))
            .to_owned();
        assert!(
            [
                format!("just _tier-test-covered {profile}"),
                format!("just _tier-test {profile}")
            ]
            .contains(&command),
            "`{name}:{target}` runs `{command}`, not the `{profile}` profile"
        );
    }
    let recipes = fs::read_to_string(repo_root().join("justfile")).expect("the justfile");
    for recipe in ["_tier-test-covered profile:", "_tier-test profile:"] {
        let body = recipes
            .split_once(&format!("\n{recipe}\n"))
            .map(|(_, rest)| rest.split("\n\n").next().unwrap_or(""))
            .unwrap_or_else(|| panic!("the justfile has no `{recipe}` recipe"));
        assert!(
            body.contains("NEXTEST_PROFILE=\"$1\""),
            "`{recipe}` does not select its tests by the profile it is handed:\n{body}"
        );
    }
}
// llmlint: ignore-end[tests_mirror_real_usage]

/// What one nextest profile selects, read off its `default-filter`.
#[derive(Default)]
struct Selection {
    /// Binaries the filter selects (`binary(=…)` outside a `not`).
    binaries: Vec<String>,
    /// Binaries it excludes (`not binary(=…)`).
    excluded_binaries: std::collections::BTreeSet<String>,
    /// Modules of the e2e binary it selects (`test(/^(…)::/)`).
    modules: Vec<String>,
    /// Modules it excludes (`not test(/^(…)::/)`).
    excluded: std::collections::BTreeSet<String>,
}

/// Every profile in `.config/nextest.toml`, by name.
///
/// The filters are a fixed shape — conjunctions and one disjunction of
/// `binary(=NAME)` and `test(/^(A|B)::/)`, each optionally negated — so they are
/// read by that shape rather than by a filterset parser, and a filter outside it
/// fails here rather than being half-read.
fn tier_profiles() -> std::collections::BTreeMap<String, Selection> {
    let config: toml::Table = fs::read_to_string(repo_root().join(".config/nextest.toml"))
        .expect("the nextest configuration reads")
        .parse()
        .expect("the nextest configuration parses");
    let profiles = config["profile"].as_table().expect("nextest profiles");
    TIERS
        .iter()
        .map(|(_, _, profile)| {
            let filter = profiles
                .get(*profile)
                .and_then(|table| table.get("default-filter"))
                .and_then(toml::Value::as_str)
                .unwrap_or_else(|| panic!("no `{profile}` profile with a default-filter"));
            let mut selection = Selection::default();
            for (offset, _) in filter.match_indices("binary(=") {
                let name = filter[offset + "binary(=".len()..]
                    .split(')')
                    .next()
                    .expect("a binary name")
                    .to_owned();
                if filter[..offset].ends_with("not ") {
                    selection.excluded_binaries.insert(name);
                } else {
                    selection.binaries.push(name);
                }
            }
            for (offset, _) in filter.match_indices("test(/^") {
                let rest = &filter[offset + "test(/^".len()..];
                let alternation = rest
                    .split("::/)")
                    .next()
                    .expect("a module selection")
                    .trim_start_matches('(')
                    .trim_end_matches(')');
                assert!(
                    alternation
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '_' || c == '|'),
                    "the `{profile}` filter selects modules by a pattern this test cannot \
                     read: {filter}"
                );
                let modules = alternation.split('|').map(str::to_owned);
                if filter[..offset].ends_with("not ") {
                    selection.excluded.extend(modules);
                } else {
                    selection.modules.extend(modules);
                }
            }
            ((*profile).to_owned(), selection)
        })
        .collect()
}

/// Every module the e2e binary declares, with the file it is read from.
fn e2e_modules() -> std::collections::BTreeMap<String, String> {
    let main = fs::read_to_string(repo_root().join("tests/e2e/main.rs")).expect("main.rs reads");
    let mut modules = std::collections::BTreeMap::new();
    let mut path: Option<String> = None;
    for line in main.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("#[path = \"") {
            path = rest.split('"').next().map(str::to_owned);
        } else if let Some(name) = line
            .strip_prefix("mod ")
            .and_then(|rest| rest.strip_suffix(';'))
        {
            let file = match path.take() {
                Some(relative) => format!("tests/{}", relative.trim_start_matches("../")),
                None => format!("tests/e2e/{name}.rs"),
            };
            modules.insert(name.to_owned(), file);
        }
    }
    modules
}

/// The files a test binary's root pulls in through `#[path]`.
///
/// Joined with `/` rather than through a `PathBuf`: the result is compared with
/// the repository-relative inputs Nx declares, which a Windows separator never
/// matches.
fn path_modules(root: &str) -> Vec<String> {
    let text = fs::read_to_string(repo_root().join(root)).expect("the binary's root reads");
    let directory: Vec<&str> = root.split('/').collect();
    let directory = &directory[..directory.len() - 1];
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("#[path = \""))
        .filter_map(|rest| rest.split('"').next())
        .map(|relative| {
            let mut joined = directory.to_vec();
            for part in relative.split('/') {
                match part {
                    ".." => {
                        joined.pop();
                    }
                    part => joined.push(part),
                }
            }
            joined.join("/")
        })
        .collect()
}

/// A project's definition, found by name among the `project.json` files Nx reads.
fn project_definition(name: &str) -> Value {
    let mut candidates = vec![repo_root().join("project.json")];
    for directory in ["apps", "packages", "tests/tiers"] {
        if let Ok(entries) = fs::read_dir(repo_root().join(directory)) {
            candidates
                .extend(entries.map(|entry| entry.expect("an entry").path().join("project.json")));
        }
    }
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| {
            serde_json::from_str::<Value>(&fs::read_to_string(&path).expect("a project definition"))
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
        })
        .find(|project| project["name"] == name)
        .unwrap_or_else(|| panic!("no project is named `{name}`"))
}

/// The files a target is keyed on, with named inputs — the project's own and the
/// workspace's — expanded, as paths relative to the workspace root.
fn target_inputs(project: &str, target: &str) -> Vec<String> {
    let definition = project_definition(project);
    let workspace: Value = serde_json::from_str(
        &fs::read_to_string(repo_root().join("nx.json")).expect("the workspace definition"),
    )
    .expect("the workspace definition parses");
    let mut pending: Vec<Value> = definition["targets"][target]["inputs"]
        .as_array()
        .unwrap_or_else(|| panic!("`{project}:{target}` declares no inputs"))
        .clone();
    let mut files = Vec::new();
    while let Some(input) = pending.pop() {
        let Some(input) = input.as_str() else {
            continue;
        };
        if let Some(path) = input.strip_prefix("{workspaceRoot}/") {
            files.push(path.to_owned());
        } else if let Some(named) = definition["namedInputs"][input]
            .as_array()
            .or_else(|| workspace["namedInputs"][input].as_array())
        {
            pending.extend(named.iter().cloned());
        }
    }
    files
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
