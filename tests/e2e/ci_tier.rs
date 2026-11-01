//! Which tier of the gate a CI build owes: `scripts/ci-tier.sh`, and the ci.yml
//! wiring that obeys its answer.
//!
//! Releases here batch through release-plz's release pull request, so the broader
//! tier — one full `just check` over every project — runs on that pull request
//! and every other build runs the affected tier. The script is the one place a
//! build is told which side it is on; these journeys run it with the event a
//! release pull request, an ordinary pull request and a push to `main` each set,
//! and read the workflow for the job that acts on what it said: `test-linux`,
//! which sweeps every project on the broader tier. A sweep wired to nothing
//! would look fine from inside a single run.
//!
//! The suppressions review comment is held here too: a step of `lint` that
//! comments and decides nothing.
#![cfg(unix)]

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use crate::workflow::job_block;

/// The branch release-plz opens its release pull request from: its default
/// prefix and a timestamp.
const RELEASE_PR_BRANCH: &str = "release-plz-2026-10-07T12-00-00Z";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The script, run the way the `changes` job runs it, with only `environment`
/// for the variables Actions sets.
fn tier(environment: &[(&str, &str)]) -> Output {
    let mut command = Command::new("bash");
    command
        .arg("scripts/ci-tier.sh")
        .current_dir(repo_root())
        .env_remove("GITHUB_EVENT_NAME")
        .env_remove("GITHUB_HEAD_REF");
    for (name, value) in environment {
        command.env(name, value);
    }
    command.output().expect("bash is on PATH")
}

fn answer(environment: &[(&str, &str)]) -> String {
    let output = tier(environment);
    assert!(
        output.status.success(),
        "ci-tier failed for {environment:?} ({}):\n{}",
        output.status,
        stderr(&output)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[test]
fn the_release_pull_request_owes_the_broader_tier() {
    assert_eq!(
        answer(&[
            ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_HEAD_REF", RELEASE_PR_BRANCH),
        ]),
        "broader"
    );
}

#[test]
fn an_ordinary_pull_request_and_a_push_owe_the_affected_tier() {
    for (environment, what) in [
        (
            &[
                ("GITHUB_EVENT_NAME", "pull_request"),
                ("GITHUB_HEAD_REF", "nick/a-feature"),
            ][..],
            "an ordinary pull request",
        ),
        (
            &[
                ("GITHUB_EVENT_NAME", "pull_request"),
                // The prefix somewhere other than the start is not the release
                // pull request's branch.
                ("GITHUB_HEAD_REF", "fix/release-plz-config"),
            ][..],
            "a pull request whose branch merely mentions release-plz",
        ),
        (&[("GITHUB_EVENT_NAME", "push")][..], "a push to main"),
    ] {
        assert_eq!(answer(environment), "affected", "{what}");
    }
}

#[test]
fn an_event_nobody_placed_is_refused_rather_than_given_a_tier() {
    let output = tier(&[("GITHUB_EVENT_NAME", "workflow_dispatch")]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "a build of an event ci.yml is not triggered by was given a tier:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.stdout.is_empty(),
        "the refusal still answered a tier on stdout, which the workflow would read"
    );
    assert!(
        stderr(&output).contains("workflow_dispatch") && stderr(&output).contains("ACTION:"),
        "the refusal does not say which event it does not know and what to do:\n{}",
        stderr(&output)
    );
}

#[test]
fn a_run_outside_actions_is_refused() {
    let output = tier(&[]);
    assert_eq!(
        output.status.code(),
        Some(2),
        "ci-tier answered without knowing the event:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        stderr(&output).contains("GITHUB_EVENT_NAME"),
        "the refusal does not name what is missing:\n{}",
        stderr(&output)
    );
}

#[test]
fn release_plz_names_its_branch_the_way_the_script_expects() {
    // The script matches release-plz's default branch prefix. A `pr_branch_prefix`
    // set anywhere in its configuration would move the branch out from under it,
    // and every release pull request would quietly get the affected tier alone.
    let config: toml::Table = fs::read_to_string(repo_root().join("release-plz.toml"))
        .expect("release-plz.toml reads")
        .parse()
        .expect("release-plz.toml parses");
    let mut tables = vec![&config];
    while let Some(table) = tables.pop() {
        assert!(
            !table.contains_key("pr_branch_prefix"),
            "release-plz.toml sets pr_branch_prefix, so scripts/ci-tier.sh no longer \
             recognises the release pull request"
        );
        for value in table.values() {
            match value {
                toml::Value::Table(inner) => tables.push(inner),
                toml::Value::Array(items) => {
                    tables.extend(items.iter().filter_map(toml::Value::as_table));
                }
                _ => {}
            }
        }
    }
    let script = fs::read_to_string(repo_root().join("scripts/ci-tier.sh")).expect("the script");
    let prefix = RELEASE_PR_BRANCH
        .split_once("plz-")
        .map(|(head, _)| format!("{head}plz-"))
        .expect("a release-plz branch");
    assert!(
        script.contains(&format!("RELEASE_PR_PREFIX=\"{prefix}\"")),
        "scripts/ci-tier.sh no longer matches release-plz's `{prefix}` branches"
    );
}

#[test]
fn the_sweep_runs_on_what_the_script_answers_inside_test_linux() {
    let job = job_block("ci.yml", "test-linux");
    let tier = job
        .find("run: echo \"tier=$(bash scripts/ci-tier.sh)\" >> \"$GITHUB_OUTPUT\"")
        .unwrap_or_else(|| panic!("test-linux does not ask the script for its tier:\n{job}"));
    let sweep = job
        .find("run: just ci-test-linux --tier \"${{ steps.tier.outputs.tier }}\"")
        .unwrap_or_else(|| {
            panic!("test-linux does not run its recipe on the script's answer:\n{job}")
        });
    assert!(
        tier < sweep,
        "test-linux runs its recipe before asking its tier"
    );
    // The broader tier is the sweep: `just check`'s tiers over every project.
    let script = fs::read_to_string(repo_root().join("scripts/ci-job.sh")).expect("ci-job.sh");
    assert!(
        script.contains("bash scripts/nx.sh run-many -t \"$targets\""),
        "the broader tier no longer runs every project"
    );
    // The four jobs are the whole of ci.yml: no separate sweep, and no verdict
    // job ruling on others for branch protection to read.
    let workflow =
        fs::read_to_string(repo_root().join(".github/workflows/ci.yml")).expect("ci.yml reads");
    let jobs: Vec<&str> = workflow
        .lines()
        .skip_while(|line| *line != "jobs:")
        .skip(1)
        .filter_map(|line| line.strip_prefix("  "))
        .filter(|inner| !inner.starts_with([' ', '#']) && inner.ends_with(':'))
        .map(|inner| inner.trim_end_matches(':'))
        .collect();
    assert_eq!(jobs, ["lint", "test-linux", "test-windows", "test-macos"]);
}

#[test]
fn no_push_re_runs_the_pull_request_checks() {
    let workflow =
        fs::read_to_string(repo_root().join(".github/workflows/ci.yml")).expect("ci.yml reads");
    let triggers: Vec<&str> = workflow
        .lines()
        .skip_while(|line| *line != "on:")
        .skip(1)
        .take_while(|line| line.starts_with(' ') || line.is_empty() || line.starts_with('#'))
        .filter(|line| {
            line.starts_with("  ")
                && !line.starts_with("   ")
                && !line.trim_start().starts_with('#')
        })
        .map(str::trim)
        .collect();
    assert_eq!(
        triggers,
        ["pull_request:"],
        "ci.yml runs on more than pull requests: the warmer, not a push re-run, catches a merge that breaks main"
    );
    assert!(
        workflow.contains("cancel-in-progress: true"),
        "a pull request's superseded run is not cancelled"
    );
}

#[test]
fn the_suppressions_comment_is_a_step_of_lint_and_gates_nothing() {
    let lint = job_block("ci.yml", "lint");
    let step = lint
        .split("\n      - ")
        .find(|step| step.contains("uses: nickderobertis/notignored@v0"))
        .unwrap_or_else(|| panic!("lint does not run notignored:\n{lint}"));
    assert!(
        step.contains(
            "if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && !cancelled()"
        ),
        "the suppressions comment does not skip a fork's pull request, whose token cannot comment:\n{step}"
    );
    assert!(
        lint.contains("pull-requests: write") && lint.contains("fetch-depth: 0"),
        "lint cannot write the comment or diff against the base branch:\n{lint}"
    );
    assert!(
        !repo_root()
            .join(".github/workflows/notignored.yml")
            .exists(),
        "notignored.yml is back, running a second job on every pull request"
    );
}

#[test]
fn lifting_a_draft_does_not_rerun_the_required_checks() {
    // A draft's runs report on its head commit, and lifting it changes no
    // commit, so those runs are the ones the merge path reads. Triggering on
    // `ready_for_review` would only run every required check a second time.
    // visual-docs.yml runs on a pull request only once it closes, to delete its
    // preview; ci.yml carries every check a pull request owes.
    for file in ["ci.yml"] {
        let workflow = fs::read_to_string(repo_root().join(".github/workflows").join(file))
            .expect("workflow reads");
        let types = workflow
            .lines()
            .skip_while(|line| *line != "  pull_request:")
            .skip(1)
            .take_while(|line| line.starts_with("    "))
            .find_map(|line| line.trim().strip_prefix("types: "))
            .unwrap_or_else(|| panic!("{file} names no pull_request types"));
        for kind in ["opened", "synchronize", "reopened"] {
            assert!(
                types.contains(kind),
                "{file} no longer runs on a pull request's `{kind}` (types: {types})"
            );
        }
        assert!(
            !types.contains("ready_for_review"),
            "{file} re-runs when a draft is lifted, repeating its draft's runs (types: {types})"
        );
    }
}
