//! The release's reading of the public surface: `scripts/semver-check.sh`, the
//! script `just semver-check` — and so `.github/workflows/release-plz.yml` —
//! runs.
//!
//! What it guards is a release this repository was one merge away from: with the
//! baseline resolved against today's registry rather than the tag's lockfile,
//! cargo-semver-checks dies building v0.3.3 and release-plz reports that as "✓ API
//! compatible changes" — so a breaking change would have been versioned as a
//! compatible one on a reading nobody took. The journeys below are every answer
//! the reading can come back with, and what the release does about each — which
//! is decided by what the pending release claims: a baseline nobody can build
//! stops a release claiming compatibility with it, and is read past by one
//! claiming none.
//!
//! What the release claims is read off the commits release-plz versions it from,
//! which are the ones touching the crate's *packaged* files. So each case is a
//! real crate with a real `include`, in a real git repository, whose commits touch
//! a packaged file or an unpackaged one; the script runs there, the way the
//! release runs it in the repository it is releasing. `the_release_this_branch_is`
//! runs it through the recipe over this repository's own history instead.
//!
//! One thing is stood in for: the `cargo` that fetches two dependency trees and
//! reads two rustdocs out of them, which is neither offline nor deterministic and
//! is the release path's job rather than the gate's — and the `cargo-semver-checks`
//! the script probes for before asking for that. The stand-in hands `cargo
//! package --list` straight to the real cargo, because which files this crate
//! packages is exactly what these cases are about.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

/// The exit codes cargo-semver-checks answers with, named where they are used: a
/// surface a release is compatible with, one it broke, and a run that produced no
/// verdict at all.
const COMPATIBLE: &str = "0";
const BROKE: &str = "100";
const NO_VERDICT: &str = "101";

/// The tag the baseline is a checkout of, in the history each fixture builds, and
/// one naming the commit it is not — the pair whose correspondence the script
/// refuses to take on trust.
const BASELINE_REF: &str = "v-baseline";
const PENDING_REF: &str = "v-pending";

/// The fixture crate: one file its `include` selects and one it leaves out, which
/// is the split release-plz versions a release from.
const PACKAGED: &str = "src/lib.rs";
const UNPACKAGED: &str = "scripts/tool.sh";
const FIXTURE_MANIFEST: &str = r#"[workspace]

[package]
name = "fixture-crate"
version = "0.1.0"
edition = "2021"
description = "The crate whose packaged files decide which commits a release is made of."
license = "MIT"
include = ["/src/**/*.rs", "/Cargo.toml"]
"#;

/// A commit the pending release is made of: the message lines it carries, and the
/// file it touches.
struct Commit {
    messages: &'static [&'static str],
    file: &'static str,
}

/// The pending releases the cases are about. `feat!` and a `BREAKING CHANGE:`
/// footer are the two ways a conventional commit says the surface broke, and
/// release-plz reads both — but only on a commit it sees at all, which is one
/// that touched a packaged file.
const A_COMPATIBLE_RELEASE: &[Commit] = &[Commit {
    messages: &["fix: serve the empty timeline as an empty one"],
    file: PACKAGED,
}];
const A_BREAKING_RELEASE: &[Commit] = &[Commit {
    messages: &["feat!: drop the round from every payload"],
    file: PACKAGED,
}];
const A_BREAKING_RELEASE_BY_FOOTER: &[Commit] = &[Commit {
    messages: &[
        "feat: drop the round from every payload",
        "BREAKING CHANGE: a payload no longer carries a round",
    ],
    file: PACKAGED,
}];
/// A break announced by a commit release-plz never sees, beside the compatible
/// packaged change that is the whole of the release it does see.
const A_BREAK_OUTSIDE_THE_RELEASE: &[Commit] = &[
    Commit {
        messages: &["feat!: rewrite the gate's own runner"],
        file: UNPACKAGED,
    },
    Commit {
        messages: &["fix: serve the empty timeline as an empty one"],
        file: PACKAGED,
    },
];
/// A release with nothing in it: every commit since the tag is one release-plz
/// versions nothing from.
const NO_RELEASE_AT_ALL: &[Commit] = &[Commit {
    messages: &["ci: run the browser tier on the smaller runner"],
    file: UNPACKAGED,
}];

struct Fixture {
    dir: TempDir,
    repo: PathBuf,
    baseline: String,
    stub_dir: PathBuf,
    search_path: OsString,
}

/// Run `git` in `repo`, failing the test with what it said if it will not.
fn git(repo: &Path, arguments: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=semver-check suite",
            "-c",
            "user.email=suite@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(arguments)
        .current_dir(repo)
        .output()
        .expect("git is on PATH");
    assert!(
        output.status.success(),
        "git {arguments:?} failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The cargo running this suite, which is the one the stand-in hands `cargo
/// package --list` to. Taken from the environment rather than from PATH, where
/// the stand-in itself is.
fn real_cargo() -> String {
    std::env::var("CARGO").expect("cargo sets CARGO for the test binaries it runs")
}

impl Fixture {
    /// A pending release that claims compatibility with the baseline.
    fn new() -> Self {
        Self::of(A_COMPATIBLE_RELEASE)
    }

    /// A crate whose `include` packages one of its two files, released once as the
    /// baseline tag and then carried forward by `pending` — beside the worktree of
    /// that tag the workflow hands the reading.
    fn of(pending: &[Commit]) -> Self {
        let dir = TempDir::new().expect("temp dir");
        let repo = dir.path().join("history");
        fs::create_dir_all(repo.join("src")).expect("create the crate's sources");
        fs::create_dir_all(repo.join("scripts")).expect("create what it does not package");
        fs::write(repo.join("Cargo.toml"), FIXTURE_MANIFEST).expect("write the manifest");
        fs::write(repo.join(PACKAGED), "pub fn read() {}\n").expect("write the packaged file");
        fs::write(repo.join(UNPACKAGED), "echo tool\n").expect("write the unpackaged file");
        // The script lists the packaged files with `--locked`, which is a lockfile
        // this crate has not got until one is resolved for it.
        let locked = Command::new(real_cargo())
            .args(["generate-lockfile", "--offline", "--quiet"])
            .current_dir(&repo)
            .output()
            .expect("cargo is on PATH");
        assert!(
            locked.status.success(),
            "cargo generate-lockfile failed:\n{}",
            String::from_utf8_lossy(&locked.stderr)
        );

        git(&repo, &["init", "--quiet", "--initial-branch=main"]);
        git(&repo, &["add", "--all"]);
        git(&repo, &["commit", "--quiet", "-m", "chore: release"]);
        git(&repo, &["tag", BASELINE_REF]);

        // The worktree of the tag the workflow hands over, made the way the
        // workflow makes it, so the script can ask the checkout which release it
        // is rather than take the pair of arguments on trust.
        let baseline = dir.path().join("release-baseline");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "--detach",
                baseline.to_str().expect("utf-8 path"),
                BASELINE_REF,
            ],
        );

        for commit in pending {
            let touched = repo.join(commit.file);
            let mut carried = fs::read_to_string(&touched).expect("read the file to carry forward");
            carried.push_str("// carried forward\n");
            fs::write(&touched, carried).expect("carry the file forward");
            git(&repo, &["add", "--all"]);
            let mut arguments = vec!["commit", "--quiet"];
            for message in commit.messages {
                arguments.extend(["-m", message]);
            }
            git(&repo, &arguments);
        }
        git(&repo, &["tag", PENDING_REF]);

        // Records every call, answers the reading with the status the case under
        // test is about, and hands the packaged-file list to the real cargo.
        //
        // llmlint: ignore-block[e2e_not_mocked] the real reading builds two
        // rustdocs from two downloaded dependency trees, so it is the one thing a
        // gate that is offline and deterministic cannot drive; the release
        // workflow runs the real one, and fails when it returns no verdict. The
        // script under test is the real script, run with the workflow's own
        // arguments over a real git history and a real crate, whose packaged files
        // the real cargo lists. This call is the whole of that substitution.
        let stub_dir = dir.path().join("stub-bin");
        stub_bin::install(
            &stub_dir,
            "cargo",
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$CARGO_CALLS\"\n\
             case \"${1:-}\" in\n\
               fetch)\n\
                 case \"$*\" in\n\
                   *--manifest-path*) exit \"${BASELINE_FETCH_STATUS:-0}\" ;;\n\
                   *) exit \"${TREE_FETCH_STATUS:-0}\" ;;\n\
                 esac\n\
                 ;;\n\
               package)\n\
                 exec \"$REAL_CARGO\" \"$@\"\n\
                 ;;\n\
               semver-checks)\n\
                 printf 'offline=%s\\n' \"${CARGO_NET_OFFLINE:-unset}\" >> \"$CARGO_CALLS\"\n\
                 exit \"${SEMVER_STATUS:-0}\"\n\
                 ;;\n\
               *)\n\
                 echo \"the stand-in was asked for something it does not answer: $*\" >&2\n\
                 exit 1\n\
                 ;;\n\
             esac\n",
        );
        // The script refuses to read anything when cargo-semver-checks is not
        // installed, which is a probe of PATH rather than a call: what answers it
        // never runs.
        let search_path = stub_bin::install(
            &stub_dir,
            "cargo-semver-checks",
            "#!/usr/bin/env bash\nexit 1\n",
        );
        // llmlint: ignore-end[e2e_not_mocked]

        Self {
            baseline: baseline.to_str().expect("utf-8 path").to_owned(),
            repo,
            stub_dir,
            dir,
            search_path,
        }
    }

    /// Run the script over this fixture's own repository, the way the release runs
    /// it over the one it is releasing, with the reading answering `status`.
    fn run(&self, status: &str) -> Output {
        self.run_with(&self.baseline.clone(), &[("SEMVER_STATUS", status)])
    }

    fn run_with(&self, baseline: &str, environment: &[(&str, &str)]) -> Output {
        self.run_arguments(&[baseline, BASELINE_REF], environment)
    }

    fn run_arguments(&self, arguments: &[&str], environment: &[(&str, &str)]) -> Output {
        self.run_arguments_on(arguments, environment, &self.search_path)
    }

    /// The same again, over a search path the case decides — which is how a run
    /// that never provisioned the reading tool is driven.
    fn run_arguments_on(
        &self,
        arguments: &[&str],
        environment: &[(&str, &str)],
        search_path: &OsStr,
    ) -> Output {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/semver-check.sh");
        let mut command = Command::new("bash");
        command.arg(script).args(arguments).current_dir(&self.repo);
        self.finish(command, environment, search_path)
    }

    /// Run the recipe, which is how the workflow's step reaches the script, over
    /// this repository — the one the justfile is in, and whose own history the
    /// pending release is made of.
    fn run_recipe(&self, arguments: &[&str], environment: &[(&str, &str)]) -> Output {
        let mut command = Command::new("just");
        command
            .arg("semver-check")
            .args(arguments)
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")));
        self.finish(command, environment, &self.search_path)
    }

    fn finish(
        &self,
        mut command: Command,
        environment: &[(&str, &str)],
        search_path: &OsStr,
    ) -> Output {
        command
            .env("PATH", search_path)
            .env("REAL_CARGO", real_cargo())
            .env("CARGO_CALLS", self.dir.path().join("cargo-calls"));
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("the program is on PATH")
    }

    /// Leave the history with no commit on HEAD, so the range between the tag and
    /// it cannot be read at all — the shape a checkout given too little history
    /// arrives in.
    fn forget_head(&self) {
        git(
            &self.repo,
            &["checkout", "--quiet", "--orphan", "nothing-committed"],
        );
    }

    /// The same search path with nothing on it called `cargo-semver-checks` —
    /// the stand-in taken back out, and any directory a machine running the suite
    /// really installed the tool into dropped, so the probe is answered the way a
    /// runner that never provisioned it answers.
    fn without_the_reading_tool(&self) -> OsString {
        fs::remove_file(self.stub_dir.join("cargo-semver-checks")).expect("remove the stand-in");
        std::env::join_paths(
            std::env::split_paths(&self.search_path)
                .filter(|directory| !directory.join("cargo-semver-checks").exists()),
        )
        .expect("join PATH")
    }

    /// Everything the script asked `cargo` for, in order.
    fn calls(&self) -> String {
        fs::read_to_string(self.dir.path().join("cargo-calls")).unwrap_or_default()
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A compatible surface releases, and the reading it releases on is the tag's own
/// dependencies rather than today's registry.
#[test]
fn a_compatible_surface_passes_on_a_reading_of_the_baselines_own_lockfile() {
    let fixture = Fixture::new();
    let output = fixture.run(COMPATIBLE);

    assert!(
        output.status.success(),
        "a clean reading failed the release:\n{}",
        stderr(&output)
    );
    let calls = fixture.calls();
    let fetches: Vec<&str> = calls
        .lines()
        .filter(|call| call.starts_with("fetch ") && call.contains("--locked"))
        .collect();
    assert!(
        fetches
            .iter()
            .any(|call| call.contains(&format!("--manifest-path {}/Cargo.toml", fixture.baseline))),
        "the baseline's own locked dependencies were never fetched:\n{calls}"
    );
    assert!(
        fetches.iter().any(|call| !call.contains("--manifest-path")),
        "this tree's locked dependencies were never fetched:\n{calls}"
    );
    assert!(
        calls.contains("offline=true"),
        "the reading was taken with a resolver that could reach the registry, so it \
         is a reading of today's dependencies rather than the ones each side pins:\n{calls}"
    );
    assert!(
        calls.contains(&format!(
            "semver-checks --baseline-root {}",
            fixture.baseline
        )),
        "the reading was taken against something other than the baseline:\n{calls}"
    );
}

/// A broken surface is a verdict, not a failure: release-plz is what turns it
/// into the bigger version, and stopping here would stop releasing it.
#[test]
fn a_broken_surface_is_handed_on_to_release_plz_rather_than_failing_the_run() {
    let fixture = Fixture::new();
    let output = fixture.run(BROKE);

    assert!(
        output.status.success(),
        "a surface that broke stopped the release instead of raising the bump:\n{}",
        stderr(&output)
    );
    assert!(
        stdout(&output).contains("broke"),
        "the run does not say the surface broke:\n{}",
        stdout(&output)
    );
}

/// A reading that did not happen fails a release that claims compatibility,
/// because the alternative is release-plz calling it compatible.
#[test]
fn a_reading_that_produced_no_verdict_fails_a_release_claiming_compatibility() {
    let fixture = Fixture::new();
    let output = fixture.run(NO_VERDICT);

    assert!(
        !output.status.success(),
        "a check that produced no verdict released anyway:\n{}",
        stdout(&output)
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("::error::") && stderr.contains(NO_VERDICT),
        "the failure does not say the check returned no verdict, or which status it \
         returned:\n{stderr}"
    );
}

/// Dependencies that no longer resolve stop a release that claims compatibility,
/// and say which side could not be fetched.
///
/// This is the shape the whole arrangement exists for: it is exactly what an
/// unfetched baseline does inside cargo-semver-checks, where it reads as a clean
/// surface. Out here it is a failed release with somewhere to go.
#[test]
fn a_side_whose_dependencies_cannot_be_fetched_fails_a_release_claiming_compatibility() {
    for (side, variable, named) in [
        ("the baseline", "BASELINE_FETCH_STATUS", true),
        ("this tree", "TREE_FETCH_STATUS", false),
    ] {
        let fixture = Fixture::new();
        let output = fixture.run_with(
            &fixture.baseline.clone(),
            &[(variable, "1"), ("SEMVER_STATUS", COMPATIBLE)],
        );

        assert!(
            !output.status.success(),
            "{side} could not be fetched and the release went ahead anyway:\n{}",
            stdout(&output)
        );
        let stderr = stderr(&output);
        assert!(
            stderr.contains("::error::") && stderr.contains("ACTION:"),
            "the failure for {side} does not say what happened, or what to do about \
             it:\n{stderr}"
        );
        assert_eq!(
            stderr.contains(&fixture.baseline),
            named,
            "the failure does not name {side} as the side that could not be \
             fetched:\n{stderr}"
        );
        assert!(
            !fixture.calls().contains("semver-checks"),
            "a surface was read against dependencies that were never fetched"
        );
    }
}

/// Any number of arguments but two is a usage error — the boundary for the caller
/// the usage line itself addresses, someone running the script by hand, since the
/// recipe's parameters can only ever hand over two.
#[test]
fn a_call_that_names_anything_but_a_baseline_and_its_ref_is_a_usage_error() {
    let fixture = Fixture::new();
    for arguments in [
        vec![],
        vec![fixture.baseline.as_str()],
        vec![fixture.baseline.as_str(), BASELINE_REF, "extra"],
    ] {
        let output = fixture.run_arguments(&arguments, &[]);

        assert_eq!(
            output.status.code(),
            Some(2),
            "{} argument(s) was not a usage error:\n{}",
            arguments.len(),
            stderr(&output)
        );
        assert!(
            stderr(&output).contains("usage:"),
            "the failure does not say how to call it:\n{}",
            stderr(&output)
        );
    }
    assert!(
        fixture.calls().is_empty(),
        "a surface was read for a call that was never valid"
    );
}

/// A baseline that is not a checkout is a usage error, not a silent pass — the
/// workflow interpolates a path, and an empty or wrong one would otherwise read
/// as a release with nothing to compare against.
#[test]
fn a_baseline_that_is_not_a_checkout_is_a_usage_error() {
    let fixture = Fixture::new();
    // The workflow hands over a path it was given, so this is also the shape that
    // must reach the script as one argument rather than as more shell.
    let missing = fixture
        .dir
        .path()
        .join("no-such-baseline\" || touch injected || echo \"");
    let output = fixture.run_recipe(
        &[missing.to_str().expect("utf-8 path"), BASELINE_REF],
        &[("SEMVER_STATUS", COMPATIBLE)],
    );

    assert!(
        !Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("injected")
            .exists(),
        "the baseline was pasted into a command line rather than passed as an \
         argument, so a path can carry shell of its own"
    );
    assert_eq!(
        output.status.code(),
        Some(2),
        "a baseline with no manifest did not fail as a usage error:\n{}",
        stderr(&output)
    );
    assert!(
        fixture.calls().is_empty(),
        "the script read a surface against a baseline that does not exist"
    );
}

/// A ref that names no commit is a usage error, for the same reason a baseline
/// that is not a checkout is: the workflow interpolates it, and a tag it could
/// not resolve would otherwise decide what the pending release claims by
/// default — the answer that reads past an unbuildable baseline.
#[test]
fn a_ref_that_names_no_commit_is_a_usage_error() {
    let fixture = Fixture::new();
    // Interpolated by the workflow just as the baseline path is, so it has to
    // reach the script as one argument rather than as more shell.
    let output = fixture.run_recipe(
        &[
            fixture.baseline.as_str(),
            "v-no-such-tag\" || touch injected-ref || echo \"",
        ],
        &[("SEMVER_STATUS", COMPATIBLE)],
    );

    assert!(
        !Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("injected-ref")
            .exists(),
        "the ref was pasted into a command line rather than passed as an argument, \
         so a tag can carry shell of its own"
    );
    assert_eq!(
        output.status.code(),
        Some(2),
        "a ref naming no commit did not fail as a usage error:\n{}",
        stderr(&output)
    );
    assert!(
        fixture.calls().is_empty(),
        "the script read a surface without knowing what the release claims"
    );
}

/// A release that claims compatibility with nothing is released on a reading that
/// could not be taken — the one thing this branch lets through.
///
/// The reading catches an *accidental* incompatibility, so it has something to
/// protect only while a release claims compatibility. `v0.4.0`'s baseline stopped
/// compiling because the `onepipeline` it pins requires `oneagentgraph ^0.2.12`
/// and 0.2.13 added a required field to a struct it builds; no requirement
/// writable here reaches it, and the tag is not ours to edit. Without this, a
/// breaking release waits forever on a verdict that could only have agreed with
/// the bump it was already taking.
#[test]
fn a_reading_that_produced_no_verdict_is_read_past_by_a_breaking_release() {
    for pending in [A_BREAKING_RELEASE, A_BREAKING_RELEASE_BY_FOOTER] {
        let fixture = Fixture::of(pending);
        let output = fixture.run(NO_VERDICT);

        assert!(
            output.status.success(),
            "a breaking release was held back by a reading it did not need:\n{}",
            stderr(&output)
        );
        let stderr = stderr(&output);
        assert!(
            stderr.contains("::warning::") && !stderr.contains("::error::"),
            "reading past the baseline was not reported as a warning, or was \
             reported as a failure anyway:\n{stderr}"
        );
        assert!(
            stderr.contains(BASELINE_REF),
            "the warning does not name the release the commits were read against, so \
             nobody can check the claim it rests on:\n{stderr}"
        );
        assert!(
            stderr.contains("just semver-check"),
            "a release went past a reading with nowhere for its operator to go if \
             they wanted it taken:\n{stderr}"
        );
    }
}

/// The same for a baseline that cannot even be fetched: nothing about a release
/// claiming no compatibility turns on it.
#[test]
fn a_baseline_that_cannot_be_fetched_is_read_past_by_a_breaking_release() {
    let fixture = Fixture::of(A_BREAKING_RELEASE);
    let output = fixture.run_with(
        &fixture.baseline.clone(),
        &[
            ("BASELINE_FETCH_STATUS", "1"),
            ("SEMVER_STATUS", COMPATIBLE),
        ],
    );

    assert!(
        output.status.success(),
        "a breaking release was held back by a baseline it claims nothing \
         against:\n{}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains("::warning::"),
        "reading past the baseline was not reported at all:\n{}",
        stderr(&output)
    );
    assert!(
        !fixture.calls().contains("semver-checks"),
        "a surface was read against dependencies that were never fetched"
    );
}

/// A breaking release does not stop the reading being taken: a surface that broke
/// is still reported, and a compatible one still passes.
#[test]
fn a_breaking_release_still_takes_the_reading_when_the_baseline_builds() {
    let fixture = Fixture::of(A_BREAKING_RELEASE);
    for (status, said) in [(COMPATIBLE, "compatible"), (BROKE, "broke")] {
        let output = fixture.run(status);

        assert!(
            output.status.success(),
            "a reading that returned a verdict failed the release:\n{}",
            stderr(&output)
        );
        assert!(
            stdout(&output).contains(said),
            "the run does not report the verdict it was given:\n{}",
            stdout(&output)
        );
    }
    assert!(
        fixture.calls().contains("semver-checks"),
        "the reading was skipped for a breaking release rather than taken:\n{}",
        fixture.calls()
    );
}

/// This tree's own lockfile is this repository's problem whatever the release
/// claims, so a fetch it cannot do stays fatal.
#[test]
fn this_trees_dependencies_failing_to_fetch_fails_even_a_breaking_release() {
    let fixture = Fixture::of(A_BREAKING_RELEASE);
    let output = fixture.run_with(
        &fixture.baseline.clone(),
        &[("TREE_FETCH_STATUS", "1"), ("SEMVER_STATUS", COMPATIBLE)],
    );

    assert!(
        !output.status.success(),
        "a lockfile this repository cannot fetch released anyway:\n{}",
        stdout(&output)
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("::error::") && stderr.contains("ACTION:"),
        "the failure does not say what happened, or what to do about it:\n{stderr}"
    );
}

/// A baseline and a ref that name different releases is a usage error: the
/// reading and the claim it is judged by would be about different tags, and one
/// of the two would decide the release on history the other never produced.
#[test]
fn a_baseline_that_is_not_the_checkout_of_the_ref_is_a_usage_error() {
    let fixture = Fixture::of(A_BREAKING_RELEASE);
    let output = fixture.run_arguments(
        &[fixture.baseline.as_str(), PENDING_REF],
        &[("SEMVER_STATUS", COMPATIBLE)],
    );

    assert_eq!(
        output.status.code(),
        Some(2),
        "a baseline and a ref naming different releases were taken on trust:\n{}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains(PENDING_REF),
        "the failure does not name the ref the checkout turned out not to be \
         of:\n{}",
        stderr(&output)
    );
    assert!(
        fixture.calls().is_empty(),
        "a surface was read for a pair that describes no one release"
    );
}

/// A missing cargo-semver-checks fails every release, breaking or not: it says
/// nothing about the baseline, so there is nothing about it to read past.
#[test]
fn a_reading_tool_that_is_not_installed_fails_even_a_breaking_release() {
    let fixture = Fixture::of(A_BREAKING_RELEASE);
    let output = fixture.run_arguments_on(
        &[fixture.baseline.as_str(), BASELINE_REF],
        &[("SEMVER_STATUS", COMPATIBLE)],
        &fixture.without_the_reading_tool(),
    );

    assert!(
        !output.status.success(),
        "a release went ahead on a reading no installed tool could take:\n{}",
        stdout(&output)
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("::error::") && stderr.contains("cargo-semver-checks"),
        "the failure does not say the tool that takes the reading is missing:\n{stderr}"
    );
    assert!(
        stderr.contains("ACTION:") && stderr.contains("install"),
        "the failure does not say how to install it:\n{stderr}"
    );
    assert!(
        fixture.calls().is_empty(),
        "the script fetched dependencies for a reading it could not take"
    );
}

/// A range that cannot be read fails every release, breaking or not: what the
/// commits announce is unknown, and an unknown claim is not one to read past.
#[test]
fn a_history_the_range_cannot_be_read_from_fails_even_a_breaking_release() {
    let fixture = Fixture::of(A_BREAKING_RELEASE);
    fixture.forget_head();
    let output = fixture.run(NO_VERDICT);

    assert!(
        !output.status.success(),
        "a release went ahead on a claim nothing could be read from:\n{}",
        stdout(&output)
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("::error::") && stderr.contains("ACTION:"),
        "the failure does not say the range could not be read, or what to do about \
         it:\n{stderr}"
    );
    assert!(
        !fixture.calls().contains("semver-checks"),
        "a surface was read for a release whose claim was never established"
    );
}

/// A break announced outside the release still fails a reading that produced no
/// verdict: release-plz never sees that commit, so the release it *does* version
/// is the compatible packaged one, and a compatible release is what the reading
/// exists for.
///
/// This is the hole a range read whole leaves: any `!` anywhere between the tags
/// would otherwise excuse a reading the packaged release still needs.
#[test]
fn a_break_outside_the_release_still_fails_a_reading_that_produced_no_verdict() {
    let fixture = Fixture::of(A_BREAK_OUTSIDE_THE_RELEASE);
    let output = fixture.run(NO_VERDICT);

    assert!(
        !output.status.success(),
        "a commit release-plz never sees excused the reading a compatible release \
         needs:\n{}",
        stdout(&output)
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("::error::") && stderr.contains(NO_VERDICT),
        "the failure does not say the check returned no verdict, or which status it \
         returned:\n{stderr}"
    );
    assert!(
        !stderr.contains("::warning::"),
        "the release was read past as well as failed:\n{stderr}"
    );
}

/// A range whose commits touched no packaged file is read past: release-plz opens
/// no release PR for it at all, so there is no version for a verdict to hold.
#[test]
fn a_range_that_versions_no_release_is_read_past() {
    let fixture = Fixture::of(NO_RELEASE_AT_ALL);
    let output = fixture.run(NO_VERDICT);

    assert!(
        output.status.success(),
        "a push that releases nothing was failed over a baseline nothing was \
         released against:\n{}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains("packaged"),
        "the warning does not say why there was no release to hold:\n{}",
        stderr(&output)
    );
}

/// This repository's own pending release, through the recipe, against a real
/// worktree of the tag it is being read against.
///
/// `4af0647` is a `feat!` that touched packaged files, so the release is breaking
/// and a `v0.4.0` baseline that no longer compiles is read past — while every
/// commit after it here touched nothing packaged, and so changes that not at all.
/// The reading is the one thing stood in for; everything it is decided from is
/// this repository.
#[test]
fn the_release_this_branch_is_reads_past_a_baseline_it_cannot_build() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = Fixture::new();
    let checkout = TempDir::new().expect("temp dir");
    let baseline = checkout.path().join("release-baseline");
    git(root, &["worktree", "prune"]);
    git(
        root,
        &[
            "worktree",
            "add",
            "--detach",
            baseline.to_str().expect("utf-8 path"),
            "v0.4.0",
        ],
    );

    let output = fixture.run_recipe(
        &[baseline.to_str().expect("utf-8 path"), "v0.4.0"],
        &[("SEMVER_STATUS", NO_VERDICT)],
    );

    git(
        root,
        &[
            "worktree",
            "remove",
            "--force",
            baseline.to_str().expect("utf-8 path"),
        ],
    );
    assert!(
        output.status.success(),
        "the release this branch is stayed blocked behind a reading it does not \
         need:\n{}",
        stderr(&output)
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("::warning::") && stderr.contains("announce a break"),
        "the run does not say the packaged commits announce a break:\n{stderr}"
    );
    assert!(
        fixture.calls().contains("package --list"),
        "the packaged files release-plz versions from were never listed:\n{}",
        fixture.calls()
    );
}
