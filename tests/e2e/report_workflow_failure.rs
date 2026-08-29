//! `scripts/report-workflow-failure.sh`, driven the way the `report` job in
//! `.github/workflows/published-smoke.yml` drives it.
//!
//! The published smoke runs when a release finishes and when someone dispatches
//! it, and neither is a pull request: nothing turns red, nobody is waiting. This
//! reporter is the whole of the alarm, and the one time it matters is the one
//! time nobody is watching it work — so what it does on a failure is held here
//! rather than read off the workflow.
//!
//! The branch that carries all the weight is create-versus-comment. A reporter
//! that always creates turns a run of bad releases into a pile of issues nobody
//! reads; one that always comments needs an issue to already exist, and files
//! the first failure nowhere. Both halves are driven below, plus the two ways
//! commenting can go to the wrong place — a title that merely resembles this one,
//! and an issue id that is not a number.
//!
//! One thing is stood in for: `gh` on PATH. The real boundary here is filing
//! issues into this repository, so a journey that crossed it would open a real
//! issue on every run of the suite. The stand-in is a recording one (see
//! `support/stub_bin.rs`): the script under test is the real script, run with
//! the workflow's own environment and invoked the way the workflow invokes it,
//! and the stand-in is only what makes the requests it made readable.

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

/// The title this fixture files under, and therefore the title an already-open
/// thread has to be matched by. Which text the *workflow* passes is the
/// workflow's own business — the reporter takes the title as an input — and
/// `tests/packaging.rs` holds that text to a literal, because a title that
/// varied from run to run would start a new thread every time instead of finding
/// the one already open.
const TITLE: &str = "An unattended workflow is failing";

/// A body in the shape a caller passes one. The reporter carries it through
/// without reading it, so what it says is the caller's business and only its
/// arrival at `gh` is this suite's.
const BODY: &str = "The smoke failed. Open the run to see which legs failed.";

/// The run being reported. A reader's next click, and the thing that must
/// survive every way this script can go wrong.
const RUN_URL: &str = "https://example.invalid/runs/1";

/// The directory a runner with no temporary storage is pointed at. Nothing
/// creates it, and the refusal has to name it: a reporter that refused for some
/// other reason, or a `mktemp` that quietly captured somewhere else, would not.
const ABSENT_TMPDIR: &str = "no-such-directory";

struct Reporter {
    dir: TempDir,
    /// The PATH every run below is given: the stand-in's directory, then this
    /// process's own. Held rather than rebuilt per run, so the substitution
    /// happens once, where it is justified.
    search_path: OsString,
}

impl Reporter {
    /// A reporter facing a repository whose open issues are `listing`, one
    /// `number<TAB>title` per line the way `gh issue list --json … --jq` prints
    /// them. Empty means nothing open that resembles this failure.
    fn facing(listing: &str) -> Self {
        let dir = TempDir::new().expect("temp dir");
        fs::write(dir.path().join("open-issues"), listing).expect("write the open issues");
        // Records every request, answers `issue list` from the file above, and
        // refuses whatever `GH_REFUSE` names the way the real one refuses a
        // token that may not write issues.
        //
        // llmlint: ignore-block[e2e_not_mocked] the real `gh` opens issues on a
        // public repository, so it is the one thing this journey cannot drive:
        // a suite that crossed that boundary would file an issue on every run.
        // Standing in for the program on PATH is the narrowest cut available —
        // the script under test is the real script, spawned as the workflow
        // spawns it, and the stand-in is only what makes the requests it made
        // observable. This call is the whole of that substitution, so there is
        // one site to justify rather than one per run.
        let search_path = stub_bin::install(
            &dir.path().join("stub-bin"),
            "gh",
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$GH_CALLS\"\n\
             if [ -n \"${GH_REFUSE:-}\" ]; then\n\
               case \"$*\" in\n\
                 *\"$GH_REFUSE\"*)\n\
                   printf '%s\\n' \"$GH_ERROR\" >&2\n\
                   exit 1\n\
                   ;;\n\
               esac\n\
             fi\n\
             case \"${2:-}\" in\n\
               list) cat \"$GH_STATE/open-issues\" ;;\n\
               create) echo 'https://github.com/nickderobertis/onepipeline-ui/issues/7' ;;\n\
               comment) echo 'https://github.com/nickderobertis/onepipeline-ui/issues/7#issuecomment-1' ;;\n\
               *)\n\
                 echo \"the stand-in was asked for something it does not answer: $*\" >&2\n\
                 exit 1\n\
                 ;;\n\
             esac\n",
        );
        // llmlint: ignore-end[e2e_not_mocked]
        Self { dir, search_path }
    }

    /// Nothing open: the first failure of a thread.
    fn facing_no_open_issue() -> Self {
        Self::facing("")
    }

    /// Run it the way the workflow's step does.
    fn run(&self) -> Output {
        self.command(TITLE).output().expect("bash is on PATH")
    }

    /// The same run with `gh` refusing every request whose argv contains
    /// `refuse`, answering with `error` — the shape a token that may not write
    /// issues, or a rejected query, produces.
    fn run_refused(&self, refuse: &str, error: &str) -> Output {
        self.command(TITLE)
            .env("GH_REFUSE", refuse)
            .env("GH_ERROR", error)
            .output()
            .expect("bash is on PATH")
    }

    /// The same run with a refusal, and with no `RUN_URL` — a caller that passed
    /// one fewer `env:` than the workflow does.
    fn run_refused_without_a_run_url(&self, refuse: &str, error: &str) -> Output {
        let mut command = self.command(TITLE);
        command.env_remove("RUN_URL");
        command
            .env("GH_REFUSE", refuse)
            .env("GH_ERROR", error)
            .output()
            .expect("bash is on PATH")
    }

    /// The same run with `absent` never set, so a workflow step that resolved
    /// one of its `env:` expressions to nothing can be driven for each of them.
    fn run_without(&self, absent: &str) -> Output {
        self.command(TITLE)
            .env_remove(absent)
            .output()
            .expect("bash is on PATH")
    }

    /// The same run on a runner whose `TMPDIR` does not exist, which is the one
    /// way this cannot capture what `gh` says.
    ///
    /// `TMPDIR` is the whole of the signal, and it has to be, because the three
    /// runners this suite runs on do not agree about what an absent one means to
    /// `mktemp`: GNU mktemp refuses, and the BSD mktemp on a macOS runner
    /// resolves into `/tmp` and succeeds. So the assertion below is that the
    /// *script* read this directory and refused, which is a claim every runner
    /// answers the same way.
    fn run_without_a_tmpdir(&self) -> Output {
        self.command(TITLE)
            .env("TMPDIR", self.dir.path().join(ABSENT_TMPDIR))
            .output()
            .expect("bash is on PATH")
    }

    /// The same run filing against `repo`, which is where this writes and so the
    /// one input worth handing something malformed.
    fn run_filing_against(&self, repo: &str) -> Output {
        self.command(TITLE)
            .env("REPO", repo)
            .output()
            .expect("bash is on PATH")
    }

    fn command(&self, title: &str) -> Command {
        let mut command = Command::new("bash");
        command
            .arg(repo_root().join("scripts/report-workflow-failure.sh"))
            .current_dir(self.dir.path())
            .env("PATH", &self.search_path)
            .env("GH_STATE", self.dir.path())
            .env("GH_CALLS", self.dir.path().join("calls.log"))
            .env("REPO", "nickderobertis/onepipeline-ui")
            .env("TITLE", title)
            .env("BODY", BODY)
            .env("RUN_URL", RUN_URL);
        command
    }

    /// Everything the stand-in was asked, verbatim. A body carrying newlines
    /// lands as continuation lines, so a value is looked for in the whole
    /// recording and a *branch* is read off the leading words with
    /// [`Self::asked`].
    fn calls(&self) -> String {
        fs::read_to_string(self.dir.path().join("calls.log")).unwrap_or_default()
    }

    /// Whether `gh` was asked to do something whose argv opens with `request`.
    fn asked(&self, request: &str) -> bool {
        self.calls().lines().any(|call| call.starts_with(request))
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The first failure of a thread: there is nowhere to say it, so somewhere is
/// made.
#[test]
fn a_failure_with_nothing_open_opens_the_issue() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run();

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        reporter.asked("issue create "),
        "nothing was filed, so the failure was reported nowhere: {}",
        reporter.calls()
    );
    assert!(
        !reporter.asked("issue comment "),
        "there was no open issue to comment on: {}",
        reporter.calls()
    );
    // The issue is only worth opening if it leads back to the run that failed.
    assert!(
        reporter.calls().contains(RUN_URL),
        "the run never reached the issue body: {}",
        reporter.calls()
    );
    assert!(reporter.calls().contains(TITLE), "{}", reporter.calls());
    // And the log has to say where it went, for whoever is reading the red run.
    assert!(
        stdout(&output).contains("opened a new issue"),
        "{}",
        stdout(&output)
    );
}

/// The second failure, and every one after it: the thread already exists, so it
/// is added to. A release that strands a registry can fail this smoke for days,
/// and a reporter that opened one issue a day would bury the finding it filed.
#[test]
fn a_further_failure_comments_on_the_issue_already_open() {
    let reporter = Reporter::facing(&format!("41\t{TITLE}\n"));
    let output = reporter.run();

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        reporter.asked("issue comment 41 "),
        "the open thread was not added to: {}",
        reporter.calls()
    );
    assert!(
        !reporter.asked("issue create "),
        "a second issue was opened for the same failure: {}",
        reporter.calls()
    );
    // A comment that does not carry its own run is worse than none: a thread of
    // them would be indistinguishable from one failure repeated.
    assert!(
        reporter.calls().contains(RUN_URL),
        "the run never reached the comment: {}",
        reporter.calls()
    );
    assert!(
        stdout(&output).contains("commented on #41"),
        "{}",
        stdout(&output)
    );
}

/// `--search "<title> in:title"` is fuzzy, so it answers with issues whose title
/// merely resembles this one. Commenting a smoke failure onto somebody else's
/// issue is worse than opening a second one, so a near miss opens its own.
#[test]
fn an_issue_that_only_resembles_this_one_is_not_commented_on() {
    let reporter = Reporter::facing(&format!("41\t{TITLE} on Windows\n"));
    let output = reporter.run();

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        reporter.asked("issue create "),
        "a differently titled issue was treated as this thread: {}",
        reporter.calls()
    );
    assert!(!reporter.asked("issue comment "), "{}", reporter.calls());
}

/// An id that is not an issue number is drift in `gh issue list`, and a comment
/// addressed at it is a request against whatever it happens to name.
#[test]
fn an_issue_id_that_is_not_a_number_is_refused_rather_than_addressed() {
    let reporter = Reporter::facing(&format!("not-a-number\t{TITLE}\n"));
    let output = reporter.run();

    assert!(
        !output.status.success(),
        "an unusable listing was reported as a filed issue: {}",
        stdout(&output)
    );
    assert!(!reporter.asked("issue comment "), "{}", reporter.calls());
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
}

/// A workflow step whose `env:` expression resolved to nothing. An issue with
/// no title starts a thread nothing can ever find again, one with no body says
/// nothing to whoever opens it, and one with no repository has nowhere to go —
/// so each is refused, and each refusal names *which* input, because the caller
/// is a workflow step somebody has to edit.
#[test]
fn a_missing_input_is_refused_by_name_before_anything_is_filed() {
    for absent in ["REPO", "TITLE", "BODY"] {
        let reporter = Reporter::facing_no_open_issue();
        let output = reporter.run_without(absent);

        assert_eq!(
            output.status.code(),
            Some(2),
            "a missing {absent} did not exit 2: {}",
            stderr(&output)
        );
        assert!(
            reporter.calls().is_empty(),
            "a run refused for a missing {absent} still asked gh for something: {}",
            reporter.calls()
        );
        let said = stderr(&output);
        assert!(
            said.contains(absent),
            "the refusal does not say it was {absent} that was missing: {said}"
        );
        assert!(said.contains("ACTION:"), "{said}");
    }
}

/// The runner has no temporary storage. What `gh` writes is the only thing that
/// tells this script's failures apart, so a run that cannot capture it cannot
/// diagnose anything — and it is already reporting a failure, so dying on
/// `mktemp`'s own one-liner would take that finding with it.
///
/// The refusal is required to name the directory it was pointed at, because
/// that is what says the script decided this rather than `mktemp` — and
/// `mktemp` decides it differently on each of the three runners this suite runs
/// on, so a reporter that delegated would refuse on ubuntu and file an issue on
/// macOS from the same run.
#[test]
fn a_runner_with_no_temporary_storage_says_so_and_keeps_the_run_findable() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_without_a_tmpdir();

    assert!(
        !output.status.success(),
        "a run that captured nothing reported a filed issue: {}",
        stdout(&output)
    );
    let said = stderr(&output);
    assert!(said.contains("temporary storage"), "{said}");
    assert!(
        said.contains(ABSENT_TMPDIR),
        "the refusal does not name the storage it was pointed at: {said}"
    );
    assert!(said.contains("ACTION:"), "{said}");
    assert!(said.contains(RUN_URL), "{said}");
    assert!(
        reporter.calls().is_empty(),
        "it asked gh for something it could not have read the answer to: {}",
        reporter.calls()
    );
}

/// The path this script exists to survive being on. It runs only when something
/// is already broken, so a `gh` that fails takes a real finding down with it
/// unless it says what it was doing, repeats what `gh` said, and leaves the run
/// findable.
#[test]
fn a_gh_that_cannot_write_says_what_broke_and_keeps_the_run_findable() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused(
        "issue create",
        "HTTP 403: Resource not accessible by integration",
    );

    assert!(
        !output.status.success(),
        "a refused write was reported as a filed issue: {}",
        stdout(&output)
    );
    let said = stderr(&output);
    assert!(said.contains("opening an issue"), "{said}");
    assert!(said.contains("HTTP 403"), "{said}");
    // The answer that particular refusal calls for, rather than a generic one.
    assert!(said.contains("issues: write"), "{said}");
    // Whatever went wrong here, the failure being reported must not be lost.
    assert!(said.contains(RUN_URL), "{said}");
}

/// The other end of the same problem: no usable credential, which reads
/// nothing like a permission and needs a different answer.
#[test]
fn a_gh_with_no_credential_is_told_apart_from_one_without_permission() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused(
        "issue list",
        "gh: To get started with GitHub CLI, please run: gh auth login",
    );

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("looking for an open issue"), "{said}");
    assert!(said.contains("GH_TOKEN"), "{said}");
    assert!(said.contains(RUN_URL), "{said}");
}

/// Commenting fails its own way, and it may not be silent either: a thread that
/// stopped being added to looks exactly like a smoke that started passing.
#[test]
fn a_refused_comment_is_not_reported_as_a_filed_one() {
    let reporter = Reporter::facing(&format!("41\t{TITLE}\n"));
    let output = reporter.run_refused(
        "issue comment",
        "HTTP 403: Resource not accessible by integration",
    );

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("commenting on #41"), "{said}");
    assert!(said.contains(RUN_URL), "{said}");
}

/// The other input a workflow step can resolve wrong, and the only one that
/// says *where* this writes. A repository that is not `owner/name` would file
/// the failure somewhere nobody is looking, or hand `gh` an argument it reads as
/// an option, so it is refused at the boundary rather than passed on.
#[test]
fn a_repository_that_is_not_owner_slash_name_is_refused() {
    for repo in [
        "onepipeline-ui",
        "nickderobertis/onepipeline-ui/extra",
        "--repo=elsewhere",
        "nickderobertis/onepipeline ui",
        "/onepipeline-ui",
    ] {
        let reporter = Reporter::facing_no_open_issue();
        let output = reporter.run_filing_against(repo);

        assert_eq!(
            output.status.code(),
            Some(2),
            "`{repo}` was accepted as somewhere to file against: {}",
            stderr(&output)
        );
        assert!(
            reporter.calls().is_empty(),
            "`{repo}` still reached gh: {}",
            reporter.calls()
        );
        assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    }
}

/// `gh` failing without saying anything is the worst case for a reporter that
/// only has what `gh` wrote to work with, so it has to say that it said nothing
/// rather than print an empty line and leave the reader guessing.
#[test]
fn a_gh_that_says_nothing_is_reported_as_having_said_nothing() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused("issue create", "");

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("(said nothing)"), "{said}");
    assert!(said.contains("ACTION:"), "{said}");
    assert!(said.contains(RUN_URL), "{said}");
}

/// A repository that did not resolve. The credential and the permission are
/// fine; the input naming where to file is not, and pointing the reader at
/// `gh auth` instead would send them somewhere there is nothing to find.
#[test]
fn a_repository_that_did_not_resolve_sends_the_reader_to_the_input() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused("issue list", "HTTP 404: Not Found");

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("HTTP 404"), "{said}");
    assert!(said.contains("$REPO"), "{said}");
}

/// GitHub rejecting the request itself rather than the caller. The title is
/// interpolated into a search query, so it is the first thing to look at — and
/// the refusal hands over the query to reproduce it with.
#[test]
fn a_request_github_rejected_names_the_title_it_was_built_from() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused("issue list", "HTTP 422: Validation Failed");

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("HTTP 422"), "{said}");
    assert!(said.contains("$TITLE"), "{said}");
    assert!(said.contains("gh issue list --repo"), "{said}");
}

/// The answer nobody predicted. A reporter that recognised only what it was
/// written for would be silent on exactly the failure worth reading, so an
/// unclassified one still repeats what `gh` said and names something to try.
#[test]
fn an_unclassified_gh_failure_still_repeats_it_and_says_what_to_try() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused("issue create", "the moon was in the wrong phase");

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("the moon was in the wrong phase"), "{said}");
    assert!(said.contains("ACTION:"), "{said}");
    assert!(said.contains("gh auth status"), "{said}");
}

/// A caller that passed no run to point at. The reporter cannot invent one, and
/// the thing it must not do is imply there is a run behind a blank — so it says
/// outright that it was given none, rather than trailing off after "the red run
/// at".
#[test]
fn a_failure_reported_without_a_run_url_says_it_was_given_none() {
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter.run_refused_without_a_run_url("issue create", "HTTP 500: Server Error");

    assert!(!output.status.success(), "{}", stdout(&output));
    let said = stderr(&output);
    assert!(said.contains("no RUN_URL was passed"), "{said}");
    // And nothing that reads as a run, which is what a bare "at" would.
    assert!(!said.contains("the red run at\n"), "{said}");
}

/// The same absence on the way in: with no run to link, the body is filed as the
/// caller wrote it rather than with an empty `Run:` line under it.
#[test]
fn a_body_filed_without_a_run_url_carries_no_empty_run_line() {
    let reporter = Reporter::facing_no_open_issue();
    let mut command = reporter.command(TITLE);
    command.env_remove("RUN_URL");
    let output = command.output().expect("bash is on PATH");

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(reporter.asked("issue create "), "{}", reporter.calls());
    assert!(
        !reporter.calls().contains("Run:"),
        "an empty run link was filed anyway: {}",
        reporter.calls()
    );
    assert!(reporter.calls().contains(BODY), "{}", reporter.calls());
}

/// A `RUN_URL` that is not a run URL — the shape an `env:` expression takes when
/// it resolved to something other than a link. It reaches the filed issue as the
/// reader's next click and every failure below repeats it as where the finding
/// still lives, so it is checked rather than trusted for being non-empty.
///
/// It is content rather than an address this writes to, so the report is still
/// filed: refusing here would lose the failure being reported, which is the one
/// thing this script exists not to do. What it must not do is publish a
/// non-link as one.
#[test]
fn a_run_url_that_is_not_a_run_url_is_marked_rather_than_published_as_one() {
    const NOT_A_URL: &str = "${{ github.server_url }}";
    let reporter = Reporter::facing_no_open_issue();
    let output = reporter
        .command(TITLE)
        .env("RUN_URL", NOT_A_URL)
        .output()
        .expect("bash is on PATH");

    assert!(
        output.status.success(),
        "the failure went unreported over its run link: {}",
        stderr(&output)
    );
    assert!(reporter.asked("issue create "), "{}", reporter.calls());
    assert!(
        reporter.calls().contains("not a run URL"),
        "an unusable run link was filed as though it were one: {}",
        reporter.calls()
    );
    let said = stderr(&output);
    assert!(said.contains(NOT_A_URL), "{said}");
    assert!(said.contains("ACTION:"), "{said}");
}
