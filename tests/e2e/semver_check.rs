//! The release's reading of the public surface: `scripts/semver-check.sh`,
//! driven the way `.github/workflows/release-plz.yml` drives it.
//!
//! What it guards is a release this repository was one merge away from: with the
//! baseline resolved against today's registry rather than the tag's lockfile,
//! cargo-semver-checks dies building v0.3.3 and release-plz reports that as "✓ API
//! compatible changes" — so a breaking change would have been versioned as a
//! compatible one on a reading nobody took. The journeys below are the three
//! answers the script can get, and each asserts what the release ends up doing.
//!
//! One thing is stood in for: `cargo` on PATH, because the real reading builds two
//! rustdocs out of two dependency trees it downloads, which is neither offline nor
//! deterministic and is the release path's job rather than the gate's. The script
//! is the real script, and what it asked cargo for is readable here.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

/// The exit codes cargo-semver-checks answers with, named where they are used:
/// a clean surface, a broken one, and a run that produced no verdict at all.
const CLEAN: &str = "0";
const BROKE: &str = "100";
const NO_VERDICT: &str = "101";

struct Fixture {
    dir: TempDir,
    baseline: String,
    search_path: std::ffi::OsString,
}

impl Fixture {
    /// A baseline that looks like a checkout of the previous release — the
    /// worktree of the tag the workflow hands over.
    fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let baseline = dir.path().join("release-baseline");
        fs::create_dir_all(&baseline).expect("create the baseline");
        fs::write(
            baseline.join("Cargo.toml"),
            "[package]\nname = \"onepipeline-ui\"\n",
        )
        .expect("write the baseline manifest");

        // Records every call, and answers the reading with the status the case
        // under test is about.
        //
        // llmlint: ignore-block[e2e_not_mocked] the real reading builds two
        // rustdocs from two downloaded dependency trees, so it is the one thing a
        // gate that is offline and deterministic cannot drive; the release
        // workflow runs the real one, and fails when it returns no verdict. The
        // script under test is the real script, run with the workflow's own
        // argument, and standing in for the program on PATH is what makes the
        // fetches and the offline resolve it asked for readable. This call is the
        // whole of that substitution.
        let search_path = stub_bin::install(
            &dir.path().join("stub-bin"),
            "cargo",
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$CARGO_CALLS\"\n\
             case \"${1:-}\" in\n\
               fetch)\n\
                 exit 0\n\
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
        // llmlint: ignore-end[e2e_not_mocked]

        Self {
            baseline: baseline.to_str().expect("utf-8 path").to_owned(),
            dir,
            search_path,
        }
    }

    /// Run the script the way the workflow's step runs it, with the reading
    /// answering `status`.
    fn run(&self, status: &str) -> Output {
        self.run_with(&self.baseline.clone(), status)
    }

    fn run_with(&self, baseline: &str, status: &str) -> Output {
        Command::new("bash")
            .arg("scripts/semver-check.sh")
            .arg(baseline)
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
            .env("PATH", &self.search_path)
            .env("CARGO_CALLS", self.dir.path().join("cargo-calls"))
            .env("SEMVER_STATUS", status)
            .output()
            .expect("bash is on PATH")
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

/// A clean surface releases, and the reading it releases on is the tag's own
/// dependencies rather than today's registry.
#[test]
fn an_unchanged_surface_passes_on_a_reading_of_the_baselines_own_lockfile() {
    let fixture = Fixture::new();
    let output = fixture.run(CLEAN);

    assert!(
        output.status.success(),
        "a clean reading failed the release:\n{}",
        stderr(&output)
    );
    let calls = fixture.calls();
    assert!(
        calls.contains(&format!(
            "fetch --locked --manifest-path {}/Cargo.toml",
            fixture.baseline
        )),
        "the baseline's own locked dependencies were never fetched:\n{calls}"
    );
    assert!(
        calls.contains("fetch --locked\n"),
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

/// A reading that did not happen fails the release, because the alternative is
/// release-plz calling it compatible.
#[test]
fn a_reading_that_produced_no_verdict_fails_the_release() {
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

/// A baseline that is not a checkout is a usage error, not a silent pass — the
/// workflow interpolates a path, and an empty or wrong one would otherwise read
/// as a release with nothing to compare against.
#[test]
fn a_baseline_that_is_not_a_checkout_is_a_usage_error() {
    let fixture = Fixture::new();
    let missing = fixture.dir.path().join("no-such-baseline");
    let output = fixture.run_with(missing.to_str().expect("utf-8 path"), CLEAN);

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
