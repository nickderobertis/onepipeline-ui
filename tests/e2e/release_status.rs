//! The release's last word: `scripts/release-status.sh`, driven the way the
//! `release-status` job in `.github/workflows/release.yml` drives it.
//!
//! What it guards is a state this repository has actually been left in twice: a
//! red job skips every publish job, and the tag, the GitHub Release and its
//! assets are left looking exactly like a version that shipped, while npm and
//! PyPI still serve an older one. So the journeys below are the shapes that
//! produced it — a failed gate, a failed publish, a registry switched off, and a
//! re-run that finishes the job — and each asserts what the Release ends up
//! saying.
//!
//! One thing is stood in for: `gh` on PATH, because the real one rewrites a
//! public GitHub Release. It is a recording stand-in (see `support/stub_bin.rs`),
//! so the script is the real script and every edit it asked for is readable here.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

/// The notes release-plz writes. Whatever this script does to a Release, the
/// changelog a reader came for has to survive it.
const NOTES: &str = "### Fixed\n\n- build the read API before the browser tier ([#7](https://github.com/nickderobertis/onepipeline-ui/pull/7))\n\n### Other\n\n- release v0.3.1\n";

const TAG: &str = "v0.3.1";

/// Every job the workflow reports, in the order it reports them. A test names
/// only the ones it is bending, so a new job here does not rewrite every case.
const ALL_JOBS: &[&str] = &[
    "test",
    "upload",
    "verify-assets",
    "publish-crate",
    "build-wheels",
    "publish-pypi",
    "verify-pypi",
    "build-npm",
    "publish-npm",
    "verify-npm",
];

/// Which registries the operator has switched on, as the workflow passes them.
struct Switches {
    krate: &'static str,
    pypi: &'static str,
    npm: &'static str,
}

/// Everything on, which is how this repository is configured to release.
const ALL_ON: Switches = Switches {
    krate: "true",
    pypi: "true",
    npm: "true",
};

struct Fixture {
    dir: TempDir,
}

impl Fixture {
    /// A Release whose notes are `body`, which GitHub currently reports as a
    /// prerelease or not.
    fn new(body: &str, is_prerelease: bool) -> Self {
        let fixture = Self {
            dir: TempDir::new().expect("temp dir"),
        };
        fs::write(fixture.path("body"), body).expect("write the release body");
        fs::write(
            fixture.path("is-prerelease"),
            if is_prerelease { "true" } else { "false" },
        )
        .expect("write the prerelease flag");
        // Records what it was asked, answers from the two files above, keeps the
        // notes of any edit — which is the whole of what this script does to a
        // Release — and refuses whatever `GH_REFUSE` names, the way the real one
        // refuses a token that cannot read or write the Release.
        //
        // llmlint: ignore-block[e2e_not_mocked] the real `gh` rewrites a public
        // GitHub Release, so it is the one thing a journey cannot drive. Standing
        // in for the program on PATH is the narrowest cut available: the script
        // under test is the real script, run with the workflow's own environment,
        // and the stand-in is only what makes the edits it asked for readable.
        stub_bin::install(
            &fixture.path("stub-bin"),
            "gh",
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$GH_CALLS\"\n\
             if [ -n \"${GH_REFUSE:-}\" ]; then\n\
               case \"$*\" in\n\
                 *\"$GH_REFUSE\"*)\n\
                   echo 'HTTP 403: Resource not accessible by integration' >&2\n\
                   exit 1\n\
                   ;;\n\
               esac\n\
             fi\n\
             case \"${2:-}\" in\n\
               view)\n\
                 case \"$*\" in\n\
                   *--jq*) cat \"$GH_STATE/body\" ;;\n\
                   *) printf '{\"isPrerelease\":%s}\\n' \"$(cat \"$GH_STATE/is-prerelease\")\" ;;\n\
                 esac\n\
                 ;;\n\
               edit)\n\
                 previous=\"\"\n\
                 for argument in \"$@\"; do\n\
                   if [ \"$previous\" = \"--notes-file\" ]; then cp \"$argument\" \"$GH_STATE/edited-body\"; fi\n\
                   previous=\"$argument\"\n\
                 done\n\
                 ;;\n\
               *)\n\
                 echo \"the stand-in was asked for something it does not answer: $*\" >&2\n\
                 exit 1\n\
                 ;;\n\
             esac\n",
        );
        // llmlint: ignore-end[e2e_not_mocked]
        fixture
    }

    /// A Release the workflow has just cut: real notes, not a prerelease.
    fn fresh() -> Self {
        Self::new(NOTES, false)
    }

    /// Make `gh` answer the prerelease query with `raw` in place of a boolean —
    /// the shape a version that no longer serves the field would produce.
    fn gh_answers_the_flag_with(&self, raw: &str) {
        fs::write(self.path("is-prerelease"), raw).expect("write the prerelease flag");
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Run the script the way the `release-status` job does. `bent` overrides
    /// the result of the jobs it names; everything else succeeded.
    fn run(&self, bent: &[(&str, &str)], switches: &Switches) -> Output {
        self.run_with(&reported(bent), switches)
    }

    /// The same run, with `gh` refusing every call whose argv contains `refuse` —
    /// the shape a token without access to the Release produces.
    fn run_refused(&self, refuse: &str, bent: &[(&str, &str)], switches: &Switches) -> Output {
        self.command(&reported(bent), switches)
            .env("GH_REFUSE", refuse)
            .output()
            .expect("bash is on PATH")
    }

    fn run_with(&self, job_results: &str, switches: &Switches) -> Output {
        self.command(job_results, switches)
            .output()
            .expect("bash is on PATH")
    }

    /// The same run on a runner whose `TMPDIR` does not exist, which is the one
    /// way the notes this rewrites a Release with cannot be assembled.
    fn run_without_a_tmpdir(&self, bent: &[(&str, &str)], switches: &Switches) -> Output {
        self.command(&reported(bent), switches)
            .env("TMPDIR", self.path("no-such-directory"))
            .output()
            .expect("bash is on PATH")
    }

    fn command(&self, job_results: &str, switches: &Switches) -> Command {
        let mut command = Command::new("bash");
        command
            .arg(repo_root().join("scripts/release-status.sh"))
            .current_dir(self.dir.path())
            .env("PATH", stub_bin::path_with(&self.path("stub-bin")))
            .env("GH_STATE", self.dir.path())
            .env("GH_CALLS", self.path("calls.log"))
            .env("RELEASE_TAG", TAG)
            .env("JOB_RESULTS", job_results)
            .env("EXPECT_CRATE", switches.krate)
            .env("EXPECT_PYPI", switches.pypi)
            .env("EXPECT_NPM", switches.npm);
        command
    }

    /// The `gh release edit` invocations the script made, argv per line.
    fn edits(&self) -> Vec<String> {
        fs::read_to_string(self.path("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|call| call.starts_with("release edit "))
            .map(str::to_owned)
            .collect()
    }

    /// The notes the Release ended up with, or `None` if it was never edited.
    fn edited_body(&self) -> Option<String> {
        fs::read_to_string(self.path("edited-body")).ok()
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `JOB_RESULTS` as the workflow writes it: every job in `ALL_JOBS`, succeeding
/// unless `bent` overrides it.
fn reported(bent: &[(&str, &str)]) -> String {
    ALL_JOBS
        .iter()
        .map(|job| {
            let result = bent
                .iter()
                .find(|(name, _)| name == job)
                .map_or("success", |(_, result)| result);
            format!("{job}={result}")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A release that published: nothing to say, and nothing touched.
#[test]
fn a_release_whose_every_required_job_succeeded_is_left_alone() {
    let fixture = Fixture::fresh();
    let output = fixture.run(&[], &ALL_ON);

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("published"), "{}", stdout(&output));
    assert!(
        fixture.edits().is_empty(),
        "a successful release rewrote its own Release: {:?}",
        fixture.edits()
    );
}

/// The shape v0.2.0 and v0.3.0 were left in: the gate went red, so every publish
/// job was *skipped* rather than failed, and nothing about the Release said so.
#[test]
fn a_gate_failure_that_skips_every_publish_demotes_the_release() {
    let fixture = Fixture::fresh();
    let skipped: Vec<(&str, &str)> = ALL_JOBS
        .iter()
        .map(|job| (*job, if *job == "test" { "failure" } else { "skipped" }))
        .collect();
    let output = fixture.run(&skipped, &ALL_ON);

    assert!(
        !output.status.success(),
        "a release that published nothing exited 0"
    );
    let edits = fixture.edits();
    assert_eq!(edits.len(), 1, "{edits:?}");
    assert!(
        edits[0].contains("--prerelease") && !edits[0].contains("--prerelease=false"),
        "the stranded release was not demoted: {}",
        edits[0]
    );

    // The banner has to name what went wrong; a reader who only has the Release
    // is the person this exists for.
    let body = fixture.edited_body().expect("the notes were rewritten");
    assert!(body.contains("did not publish"), "{body}");
    assert!(body.contains("test (failure)"), "{body}");
    assert!(body.contains("publish-npm (skipped)"), "{body}");
    assert!(body.contains("verify-pypi (skipped)"), "{body}");
    // And it must not cost the reader the changelog they came for.
    assert!(body.contains(NOTES.trim()), "the notes were lost: {body}");

    assert!(stderr(&output).contains("::error::"), "{}", stderr(&output));
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
}

/// One registry publishing while another fails is the same stranded version:
/// half a release is not a release.
#[test]
fn a_single_failed_publish_leg_demotes_the_release() {
    let fixture = Fixture::fresh();
    let output = fixture.run(&[("verify-npm", "failure")], &ALL_ON);

    assert!(!output.status.success(), "{}", stdout(&output));
    let body = fixture.edited_body().expect("the notes were rewritten");
    assert!(body.contains("verify-npm (failure)"), "{body}");
    // Only the leg that failed is named — a banner that blamed everything would
    // send the next reader looking in nine wrong places.
    assert!(!body.contains("publish-npm ("), "{body}");
}

/// A publish job the operator has switched off is not a job the release was
/// waiting for. Only the switches decide that, so a repository that publishes
/// nowhere still gets a truthful Release.
#[test]
fn a_registry_that_is_switched_off_is_not_a_stranded_release() {
    let fixture = Fixture::fresh();
    let output = fixture.run(
        &[
            ("publish-pypi", "skipped"),
            ("verify-pypi", "skipped"),
            ("publish-crate", "skipped"),
        ],
        &Switches {
            krate: "false",
            pypi: "false",
            npm: "true",
        },
    );

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(fixture.edits().is_empty(), "{:?}", fixture.edits());
}

/// The recovery path. Someone re-runs the release after fixing the failure; the
/// Release stops claiming it never published, and goes back to being the latest
/// release with the notes it was cut with.
#[test]
fn a_re_run_that_finishes_the_publish_restores_the_release() {
    let stranded = Fixture::fresh();
    assert!(!stranded
        .run(&[("publish-npm", "failure")], &ALL_ON)
        .status
        .success());
    let demoted = stranded.edited_body().expect("the notes were rewritten");

    let fixture = Fixture::new(&demoted, true);
    let output = fixture.run(&[], &ALL_ON);

    assert!(output.status.success(), "{}", stderr(&output));
    let edits = fixture.edits();
    assert_eq!(edits.len(), 1, "{edits:?}");
    assert!(
        edits[0].contains("--prerelease=false") && edits[0].contains("--latest"),
        "the recovered release was not promoted back: {}",
        edits[0]
    );
    let body = fixture.edited_body().expect("the notes were rewritten");
    assert!(
        !body.contains("did not publish"),
        "the banner survived: {body}"
    );
    assert_eq!(
        body.trim_end(),
        NOTES.trim_end(),
        "the recovered notes are not the notes release-plz wrote"
    );
}

/// A tag that was a prerelease on purpose stays one when it recovers: demoting
/// must not be a way to promote an `-rc` to Latest.
#[test]
fn a_deliberate_prerelease_is_not_promoted_by_recovering() {
    let stranded = Fixture::new(NOTES, true);
    assert!(!stranded
        .run(&[("upload", "failure")], &ALL_ON)
        .status
        .success());

    let fixture = Fixture::new(&stranded.edited_body().expect("rewritten"), true);
    assert!(fixture.run(&[], &ALL_ON).status.success());
    let edits = fixture.edits();
    assert_eq!(edits.len(), 1, "{edits:?}");
    assert!(
        !edits[0].contains("--prerelease=false") && !edits[0].contains("--latest"),
        "a deliberate prerelease was promoted to Latest: {}",
        edits[0]
    );
}

/// Re-running a release that still fails must not stack a second banner on the
/// notes, or grow the Release by one caution block per attempt.
#[test]
fn demoting_an_already_demoted_release_writes_nothing_further() {
    let stranded = Fixture::fresh();
    assert!(!stranded
        .run(&[("test", "failure")], &ALL_ON)
        .status
        .success());

    let fixture = Fixture::new(&stranded.edited_body().expect("rewritten"), true);
    let output = fixture.run(&[("test", "failure")], &ALL_ON);

    assert!(!output.status.success());
    assert!(
        fixture.edits().is_empty(),
        "the banner was written twice: {:?}",
        fixture.edits()
    );
    assert!(
        stderr(&output).contains("did not publish"),
        "{}",
        stderr(&output)
    );
}

/// A job the workflow never reported is a hole in this gate, not a pass: it means
/// release.yml grew a publish job nothing holds the Release to.
#[test]
fn a_job_the_workflow_never_reported_strands_the_release() {
    let fixture = Fixture::fresh();
    let reported: Vec<String> = ALL_JOBS
        .iter()
        .filter(|job| **job != "verify-assets")
        .map(|job| format!("{job}=success"))
        .collect();
    let output = fixture.run_with(&reported.join(" "), &ALL_ON);

    assert!(!output.status.success(), "{}", stdout(&output));
    assert!(
        stderr(&output).contains("verify-assets (not reported)"),
        "{}",
        stderr(&output)
    );
}

/// Run without the workflow's environment, this is a usage error and not a
/// verdict: exit 2, the code the CLI contract reserves for one.
#[test]
fn no_release_to_hold_is_a_usage_error() {
    let fixture = Fixture::fresh();
    let output = Command::new("bash")
        .arg(repo_root().join("scripts/release-status.sh"))
        .current_dir(fixture.dir.path())
        .env("PATH", stub_bin::path_with(&fixture.path("stub-bin")))
        .env_remove("RELEASE_TAG")
        .env("JOB_RESULTS", "test=success")
        .output()
        .expect("bash is on PATH");

    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
}

/// A Release this cannot read is the failure mode that would make the gate
/// itself silent, so it is a loud failure rather than a pass — and nothing is
/// written to a Release whose current state was never established.
#[test]
fn a_release_it_cannot_read_fails_rather_than_passing() {
    let fixture = Fixture::fresh();
    let output = fixture.run_refused("--json isPrerelease", &[("test", "failure")], &ALL_ON);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("cannot read the GitHub Release"),
        "{}",
        stderr(&output)
    );
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    assert!(fixture.edits().is_empty(), "{:?}", fixture.edits());
}

/// The notes are read separately from the prerelease flag, and they are what a
/// demotion rewrites: reading them has to fail loudly too, or the banner would
/// be published over an empty changelog.
#[test]
fn notes_it_cannot_read_fail_rather_than_being_republished_empty() {
    let fixture = Fixture::fresh();
    let output = fixture.run_refused("--json body", &[("test", "failure")], &ALL_ON);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("cannot read the notes of the GitHub Release"),
        "{}",
        stderr(&output)
    );
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    assert!(
        fixture.edited_body().is_none(),
        "notes that were never read were written back: {:?}",
        fixture.edited_body()
    );
}

/// A token that can read but not write leaves the exact state this gate exists
/// to prevent — a stranded release still marked Latest — so the job says which
/// grant is missing instead of exiting on the demotion it did not make.
#[test]
fn a_release_it_cannot_demote_names_the_grant_it_is_missing() {
    let fixture = Fixture::fresh();
    let output = fixture.run_refused("release edit", &[("publish-npm", "failure")], &ALL_ON);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("cannot edit the GitHub Release"),
        "{}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains("contents:write"),
        "{}",
        stderr(&output)
    );
    assert!(
        fixture.edited_body().is_none(),
        "the refused edit was recorded as made"
    );
}

/// The prerelease flag is the one fact demoting a Release destroys, so an answer
/// this cannot read must not become a `false`: that `false` is what a later
/// recovery would use to promote a deliberate `-rc` to Latest.
#[test]
fn a_prerelease_flag_it_cannot_read_is_not_read_as_false() {
    let fixture = Fixture::fresh();
    fixture.gh_answers_the_flag_with("null");
    let output = fixture.run(&[("test", "failure")], &ALL_ON);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("no isPrerelease flag"),
        "{}",
        stderr(&output)
    );
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    assert!(fixture.edits().is_empty(), "{:?}", fixture.edits());
}

/// A switch the operator misspelled must not read as "off". `PYPI_PUBLISH` is a
/// repository variable typed by hand, and a `yes` silently treated as `false`
/// would leave this gate asking nothing at all of the registry it was set for.
#[test]
fn a_switch_that_is_not_a_boolean_is_a_usage_error() {
    let fixture = Fixture::fresh();
    let output = fixture.run(
        &[],
        &Switches {
            krate: "true",
            pypi: "yes",
            npm: "true",
        },
    );

    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("EXPECT_PYPI must be 'true', 'false' or unset, not 'yes'"),
        "{}",
        stderr(&output)
    );
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    assert!(fixture.edits().is_empty(), "{:?}", fixture.edits());
}

/// The banner is assembled in a temporary file, so a runner with no usable
/// `TMPDIR` is the last way this job could go quiet about a stranded release.
#[test]
fn notes_it_cannot_assemble_fail_rather_than_leaving_the_release_alone() {
    let fixture = Fixture::fresh();
    let output = fixture.run_without_a_tmpdir(&[("test", "failure")], &ALL_ON);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("cannot create a temporary file"),
        "{}",
        stderr(&output)
    );
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    assert!(
        fixture.edited_body().is_none(),
        "a Release was rewritten with notes that were never assembled"
    );
}

/// The gate is only as complete as the list of jobs the workflow hands it, so
/// the workflow must report every job it runs.
#[test]
fn the_workflow_reports_every_job_it_runs_to_this_gate() {
    let workflow = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("read release.yml");
    for job in jobs_in(&workflow) {
        // `guard` decides whether a publish was expected and `release-status` is
        // this gate itself; every other job is one the release depends on.
        if job == "guard" || job == "release-status" {
            continue;
        }
        assert!(
            ALL_JOBS.contains(&job.as_str()),
            "release.yml runs a job called {job} that release-status.sh is never told about"
        );
        assert!(
            workflow.contains(&format!("{job}=${{{{ needs.{job}.result }}}}")),
            "release.yml does not report {job}'s result to release-status.sh"
        );
    }
}

/// The job ids under the workflow's top-level `jobs:` key — the lines indented
/// by exactly two spaces after it. A YAML parser would be a dependency for one
/// assertion, and the shape being read is a fixed two-level one.
fn jobs_in(workflow: &str) -> Vec<String> {
    let mut jobs = Vec::new();
    let mut inside = false;
    for line in workflow.lines() {
        if !line.starts_with([' ', '\t', '#']) && !line.is_empty() {
            inside = line.starts_with("jobs:");
            continue;
        }
        if !inside {
            continue;
        }
        let Some(rest) = line.strip_prefix("  ") else {
            continue;
        };
        if rest.starts_with(' ') || rest.starts_with('#') {
            continue;
        }
        if let Some(job) = rest.strip_suffix(':') {
            jobs.push(job.to_owned());
        }
    }
    assert!(!jobs.is_empty(), "release.yml declares no jobs");
    jobs
}

/// The stand-in must be the only `gh` this suite reaches, or a machine with a
/// real one would edit a real Release.
#[test]
fn the_stand_in_is_what_the_script_calls() {
    let fixture = Fixture::fresh();
    fixture.run(&[], &ALL_ON);
    let calls = fs::read_to_string(fixture.path("calls.log")).expect("the stand-in was called");
    assert!(
        calls.contains(&format!("release view {TAG}")),
        "the script read some other release: {calls}"
    );
}
