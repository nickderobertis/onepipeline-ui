//! Which tier of the gate a CI build owes: `scripts/ci-tier.sh`, and what
//! `test-linux`'s recipe plans on its answer.
//!
//! Releases here batch through release-plz's release pull request, so the broader
//! tier — one full `just check` over every project — runs on that pull request
//! and every other build runs the affected tier. The script is the one place a
//! build is told which side it is on; these journeys run it with the event a
//! release pull request, an ordinary pull request and a push to `main` each set,
//! and plan the sweep its answer selects. `.github/tests/ci-shape.test.mjs` runs
//! the workflow's own tier step and resolves the recipe step it feeds, so a sweep
//! wired to nothing fails there.
#![cfg(unix)]

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

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

/// The sweep, as `test-linux`'s recipe plans it on the tier the script answers
/// for a release pull request, with the `budgets` job's `read-latency` plan,
/// which holds dag-ui-read-latency's timings: `scripts/ci-job.sh --plan` reads
/// Nx's own task graph and runs none of it. Every project's `check` is in one of
/// the two, which is the whole gate over every project. How ci.yml hands the
/// answer to the recipe is resolved from the workflow itself by
/// `.github/tests/ci-shape.test.mjs`.
#[test]
fn the_release_pull_request_tier_plans_every_projects_check() {
    let tier = answer(&[
        ("GITHUB_EVENT_NAME", "pull_request"),
        ("GITHUB_HEAD_REF", RELEASE_PR_BRANCH),
    ]);
    let mut planned: Vec<String> = Vec::new();
    for job in ["test-linux", "read-latency"] {
        let output = Command::new("bash")
            .args(["scripts/ci-job.sh", job, "--tier", &tier, "--plan"])
            .current_dir(repo_root())
            .output()
            .expect("bash is on PATH");
        assert!(
            output.status.success(),
            "ci-job.sh could not plan {job}'s sweep:\n{}",
            stderr(&output)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        planned.extend(
            stdout
                .lines()
                .find_map(|line| line.split_once(" task(s): ").map(|(_, tasks)| tasks))
                .expect("ci-job.sh names the tasks it planned")
                .split_whitespace()
                .map(str::to_owned),
        );
    }
    let listed = Command::new("bash")
        .args([
            "scripts/nx.sh",
            "show",
            "projects",
            "--with-target",
            "check",
            "--json",
        ])
        .current_dir(repo_root())
        .output()
        .expect("bash is on PATH");
    assert!(listed.status.success(), "{}", stderr(&listed));
    let projects: Vec<String> =
        serde_json::from_slice(&listed.stdout).expect("Nx lists the projects as JSON");
    assert!(!projects.is_empty(), "no project declares a check");
    for project in &projects {
        let task = format!("{project}:check");
        assert!(
            planned.contains(&task),
            "the release pull request's sweep does not run {task}: {planned:?}"
        );
    }
}
