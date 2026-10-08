//! Which tier of the gate a CI build owes: `scripts/ci-tier.sh`, and the ci.yml
//! wiring that obeys its answer.
//!
//! Releases here batch through release-plz's release pull request, so the broader
//! tier — one full `just check` over every project — runs on that pull request
//! and every other build runs the affected tier. The script is the one place a
//! build is told which side it is on; these journeys run it with the event a
//! release pull request, an ordinary pull request and a push to `main` each set,
//! and read the workflow for the jobs that act on what it said. A sweep wired to
//! nothing, or wired into the verdict branch protection reads, would both look
//! fine from inside a single run.
//!
//! The suppressions review comment is held here too: it is the other workflow
//! that must stay out of that verdict.
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
fn the_sweep_runs_on_what_the_script_answers_and_feeds_no_verdict() {
    let changes = job_block("ci.yml", "changes");
    assert!(
        changes.contains("tier: ${{ steps.tier.outputs.tier }}")
            && changes.contains("echo \"tier=$(bash scripts/ci-tier.sh)\" >> \"$GITHUB_OUTPUT\""),
        "the changes job does not publish the script's answer:\n{changes}"
    );

    let sweep = job_block("ci.yml", "sweep");
    assert!(
        sweep.contains("needs: changes")
            && sweep.contains("if: needs.changes.outputs.tier == 'broader'"),
        "the sweep does not run on the broader tier's answer:\n{sweep}"
    );
    assert!(
        sweep.lines().any(|line| line.trim() == "run: just check"),
        "the sweep does not run the full gate:\n{sweep}"
    );

    // The verdict branch protection reads is `gate`'s, ruled on by
    // scripts/gate-verdict.sh over the jobs it needs. The sweep is in neither.
    let gate = job_block("ci.yml", "gate");
    assert!(
        gate.contains("needs: [changes, quality, wheel, browser-windows]"),
        "the gate must require changes, quality, Linux wheels and the Windows browser build:\n{gate}"
    );
    assert!(
        !gate.contains("sweep"),
        "the release pull request's sweep feeds the gate:\n{gate}"
    );

    // Every other pull request and every push runs the affected tier, and only
    // that: no step of `quality` is conditional on the event any more.
    let quality = job_block("ci.yml", "quality");
    assert!(
        quality.contains("run: just check-affected") && !quality.contains("if:"),
        "the quality job no longer runs the affected tier on every build:\n{quality}"
    );
}

#[test]
fn a_push_build_hands_the_affected_tier_the_commit_before_the_push() {
    let workflow =
        fs::read_to_string(repo_root().join(".github/workflows/ci.yml")).expect("ci.yml reads");
    assert!(
        workflow.contains(
            "ONEPIPELINE_UI_NX_BASE_SHA: ${{ github.event_name == 'push' && github.event.before || '' }}"
        ),
        "ci.yml does not hand a push build its base commit, so a push to main runs \
         every project or none"
    );
    assert!(
        workflow.contains("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"),
        "a push build can be cancelled by the next push, leaving the commits it was \
         gating gated by nothing"
    );
}

#[test]
fn the_suppressions_comment_is_its_own_workflow_and_gates_nothing() {
    let path = repo_root().join(".github/workflows/notignored.yml");
    let workflow = fs::read_to_string(&path).expect("notignored.yml reads");
    for (line, what) in [
        ("  pull_request:", "runs on pull requests"),
        ("  contents: read", "reads the tree"),
        ("  pull-requests: write", "can write its comment"),
        (
            "    if: github.event.pull_request.head.repo.full_name == github.repository",
            "skips a fork's pull request, whose token cannot comment",
        ),
        (
            "      - uses: nickderobertis/notignored@v0",
            "runs notignored",
        ),
        (
            "          fetch-depth: 0",
            "has the base branch to diff against",
        ),
    ] {
        assert!(
            workflow.lines().any(|candidate| candidate == line),
            "notignored.yml no longer {what} (`{}`)",
            line.trim()
        );
    }
    let gate = job_block("ci.yml", "gate");
    assert!(
        !gate.contains("suppressions") && !gate.contains("notignored"),
        "the suppressions comment feeds the gate:\n{gate}"
    );
}

#[test]
fn a_draft_lifted_later_gets_a_run_of_every_required_check() {
    // GitHub's default `pull_request` types omit `ready_for_review`, so a change
    // request opened as a draft and lifted later gets no run on the lifted state,
    // and a merge path that waits for one waits on checks that never re-run.
    for file in ["ci.yml", "visual-docs.yml"] {
        let workflow = fs::read_to_string(repo_root().join(".github/workflows").join(file))
            .expect("workflow reads");
        let types = workflow
            .lines()
            .skip_while(|line| *line != "  pull_request:")
            .skip(1)
            .take_while(|line| line.starts_with("    "))
            .find_map(|line| line.trim().strip_prefix("types: "))
            .unwrap_or_else(|| panic!("{file} names no pull_request types"));
        for kind in ["opened", "synchronize", "reopened", "ready_for_review"] {
            assert!(
                types.contains(kind),
                "{file} no longer runs on a pull request's `{kind}` (types: {types})"
            );
        }
    }
}
