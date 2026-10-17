//! ci.yml's four jobs as their recipes run them: `just ci-lint`,
//! `ci-test-linux`, `ci-test-windows` and `ci-test-macos`, over a scratch copy of
//! this workspace with a committed change, asked what they select and made to
//! run it.
//!
//! What a pull request pays for, and on which runner, is decided by these four
//! selections, and a mistake in one is silent in the direction of passing: a
//! target a job never selects is a check that never ran. So each journey commits
//! a change, drives the real recipe through the real Nx, and reads the recipe's
//! own output — its `ci-job: <job> runs N task(s): ...` line and Nx's `nx run`
//! line for every task that ran.
//!
//! Two programs are stood in for, in the journey that runs tasks: `cargo` and
//! `docker`, which refuse. The crate's targets are minutes of compiling each in a
//! fresh copy — the wheel's inside a manylinux image — and a refusing toolchain
//! is also what makes a selected target fail, which is the half of the contract
//! a passing run cannot show. The TypeScript targets the same run selects run
//! for real, which is what shows which tasks ran. The sibling CLI's releases are
//! an empty local mirror, so provisioning it asks no network either.
//!
//! The Windows and macOS recipes are driven on this host too: their selection
//! through `--plan`, which prints the tasks and runs none, and their run with
//! the same refusing `cargo`.
#![cfg(unix)]

use std::collections::BTreeSet;
use std::fs;
use std::process::{Command, Output};

use crate::stub_bin;
use crate::workspace_copy::Workspace;

/// The variable a push build names its base commit with.
const BASE_SHA: &str = "ONEPIPELINE_UI_NX_BASE_SHA";

/// The one project the committed change reaches directly: a shared package
/// nothing but the browser view imports.
const CHANGED: &str = "packages/timeline-categories/package.json";
const CHANGED_PROJECT: &str = "timeline-categories";

/// Packages the change does not reach: neither imports the changed one, and no
/// `implicitDependencies` joins them to it.
const UNREACHED: [&str; 3] = ["dag-layout", "telemetry-client", "pool-maintenance"];

/// The change the journey that runs tasks commits: a project with no dependents,
/// so what runs is the crate's targets — every change reaches the root project —
/// the browser view's that depend on it, and that project's own.
const RUN_CHANGED: &str = "pool-maintenance/measure.sh";
const RUN_UNREACHED: [&str; 3] = ["dag-layout", "telemetry-client", "timeline-categories"];

/// Strip the terminal colours Nx writes even to a pipe.
fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A recipe's run: its exit, and its stdout and stderr together, as a CI log
/// shows them.
struct Run {
    output: Output,
    log: String,
}

impl Run {
    /// The tasks the recipe said it selects, from its own first line.
    fn selected(&self, job: &str) -> BTreeSet<String> {
        let prefix = format!("ci-job: {job} runs ");
        let line = self
            .log
            .lines()
            .find(|line| line.starts_with(&prefix))
            .unwrap_or_else(|| panic!("the recipe did not say what {job} runs:\n{}", self.log));
        let (_, tasks) = line
            .split_once(": ")
            .and_then(|(_, rest)| rest.split_once(": "))
            .expect("a task list");
        tasks
            .split_whitespace()
            .filter(|task| *task != "none")
            .map(str::to_owned)
            .collect()
    }

    /// The tasks Nx says it ran, from its `> nx run <task>` lines.
    fn ran(&self) -> BTreeSet<String> {
        self.log
            .lines()
            .filter_map(|line| line.trim().strip_prefix("> nx run "))
            .map(|task| task.split_whitespace().next().unwrap_or(task).to_owned())
            .collect()
    }
}

/// A scratch workspace with `change` committed on top of its base: a path to
/// touch, or `None` for a commit that changes nothing.
fn workspace(change: Option<&str>) -> Workspace {
    let workspace = Workspace::new();
    match change {
        Some(path) => {
            workspace.change(path);
        }
        None => {
            workspace.git(&[
                "commit",
                "--quiet",
                "--no-verify",
                "--allow-empty",
                "-m",
                "nothing",
            ]);
        }
    }
    workspace
}

/// Run `just <recipe> <arguments>` in the workspace the way a push build does —
/// scoped against the base commit — with nothing else from the host running the
/// suite deciding its selection, and with `cargo` and `docker` refusing when
/// `refuse_toolchain`.
fn recipe(workspace: &Workspace, recipe: &str, arguments: &[&str], refuse_toolchain: bool) -> Run {
    let mut command = Command::new("just");
    command
        .arg(recipe)
        .args(arguments)
        .current_dir(workspace.root());
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        if name.starts_with("NX_")
            || name.starts_with("GITHUB_")
            || ["CI", "ONEPIPELINE_UI_NX_BASE_REF", BASE_SHA].contains(&name.as_ref())
        {
            command.env_remove(name.as_ref());
        }
    }
    command
        .env("CI", "true")
        .env(BASE_SHA, &workspace.base)
        .env("NX_DAEMON", "false")
        .env("NO_COLOR", "1");
    let mirror = workspace.dir.path().join("no-releases");
    fs::create_dir_all(&mirror).expect("the empty release mirror");
    command.env("ONEPIPELINE_UI_SIBLING_RELEASES", &mirror);
    if refuse_toolchain {
        let stand_ins = workspace.dir.path().join("refusing-toolchain");
        // llmlint: ignore-block[e2e_not_mocked] the stand-ins are for `cargo` and
        // `docker`, below the layer under test: the recipe, its Nx selection and
        // every TypeScript target it runs are real, and the refusal is what makes
        // a selected target fail — the module header gives both reasons.
        stub_bin::install(
            &stand_ins,
            "docker",
            "#!/usr/bin/env bash\necho \"docker stand-in: refused $*\" >&2\nexit 1\n",
        );
        let path = stub_bin::install(
            &stand_ins,
            "cargo",
            "#!/usr/bin/env bash\necho \"cargo stand-in: refused $*\" >&2\nexit 1\n",
        );
        // llmlint: ignore-end[e2e_not_mocked]
        command.env("PATH", path);
    }
    let output = command.output().expect("just is on PATH");
    let log = plain(&output.stdout) + &plain(&output.stderr);
    Run { output, log }
}

fn tasks_of<'a>(tasks: &'a BTreeSet<String>, project: &str) -> Vec<&'a String> {
    tasks
        .iter()
        .filter(|task| task.split_once(':').map(|(p, _)| p) == Some(project))
        .collect()
}

/// What each job's selection owes the changed package, and what it must never
/// select at all on its platform.
fn expectations(job: &str) -> (Vec<&'static str>, Vec<&'static str>) {
    match job {
        // `dag-ui:build` is selected as the view the crate's lints embed; the
        // package's own build is not lint's.
        "lint" => (
            vec!["format-check", "lint", "typecheck"],
            vec![":test", ":check", "timeline-categories:build"],
        ),
        // Formatting, lints and type checks are `lint`'s, over the same set.
        "test-linux" => (
            vec!["test", "build"],
            vec![":format-check", ":lint", ":typecheck"],
        ),
        "test-windows" => (
            vec!["format-check", "lint"],
            vec![
                ":test-baseline",
                ":test-cost",
                ":coverage",
                ":wheel-smoke",
                "e2e:test-isolation",
            ],
        ),
        // `dag-ui:build` is selected as what the tiers' binary embeds; the
        // package's own build and type check are not macOS work.
        "test-macos" => (
            vec!["format-check", "lint"],
            vec![
                ":test-baseline",
                ":test-cost",
                ":coverage",
                ":wheel-smoke",
                "timeline-categories:build",
                "timeline-categories:typecheck",
            ],
        ),
        other => panic!("{other} is not one of the four jobs"),
    }
}

#[test]
fn each_job_selects_the_changed_project_and_its_dependents_and_no_unreached_package() {
    let workspace = workspace(Some(CHANGED));
    for job in ["lint", "test-linux", "test-windows", "test-macos"] {
        let run = recipe(&workspace, &format!("ci-{job}"), &["--plan"], false);
        assert!(
            run.output.status.success(),
            "ci-{job} --plan failed:\n{}",
            run.log
        );
        let selected = run.selected(job);
        let (owed, never) = expectations(job);
        for target in owed {
            let task = format!("{CHANGED_PROJECT}:{target}");
            assert!(
                selected.contains(&task),
                "ci-{job} does not select {task}: {selected:?}"
            );
        }
        // The browser view imports the package, so its tasks are selected too.
        assert!(
            !tasks_of(&selected, "dag-ui").is_empty(),
            "ci-{job} skips a dependent: {selected:?}"
        );
        for project in UNREACHED {
            assert!(
                tasks_of(&selected, project).is_empty(),
                "ci-{job} selects {project}, which the change does not reach: {selected:?}"
            );
        }
        for fragment in never {
            assert!(
                !selected.iter().any(|task| task.contains(fragment)),
                "ci-{job} selects a `{fragment}` task its job does not run: {selected:?}"
            );
        }
        assert!(run.ran().is_empty(), "--plan ran tasks: {:?}", run.ran());
    }
}

/// `test-linux` lists its targets rather than reaching them through `check`,
/// so that it leaves formatting, lints and type checks to `lint`; this holds
/// the list to `check`'s own selection, so a target a project's `check` gains
/// is not silently dropped from the job.
#[test]
fn the_linux_job_runs_what_check_selects_less_what_lint_runs() {
    let workspace = workspace(Some("src/lib.rs"));
    let linux = recipe(&workspace, "ci-test-linux", &["--plan"], false);
    assert!(linux.output.status.success(), "{}", linux.log);
    let output = Command::new("bash")
        .args(["scripts/nx-affected.sh", "-t", "check", "--graph=stdout"])
        .current_dir(workspace.root())
        .env_remove("GITHUB_BASE_REF")
        .env("CI", "true")
        .env(BASE_SHA, &workspace.base)
        .env("NX_DAEMON", "false")
        .output()
        .expect("bash is on PATH");
    assert!(output.status.success(), "{}", plain(&output.stderr));
    let text = plain(&output.stdout);
    let graph: serde_json::Value =
        serde_json::from_str(&text[text.find('{').expect("a graph")..]).expect("a JSON graph");
    let lint_owned = [":format-check", ":lint", ":typecheck", ":check"];
    let owed: BTreeSet<String> = graph["tasks"]["tasks"]
        .as_object()
        .expect("a task map")
        .keys()
        .filter(|task| !lint_owned.iter().any(|suffix| task.ends_with(suffix)))
        .cloned()
        .collect();
    let packaging = ["onepipeline-ui:install-smoke", "onepipeline-ui:wheel-smoke"];
    let selected: BTreeSet<String> = linux
        .selected("test-linux")
        .into_iter()
        .filter(|task| !packaging.contains(&task.as_str()))
        .collect();
    assert_eq!(
        selected, owed,
        "test-linux's targets and `check`'s selection less lint's have parted"
    );
}

#[test]
fn the_jobs_platform_split_is_what_each_selects_for_a_crate_change() {
    let workspace = workspace(Some("src/lib.rs"));
    let plan = |job: &str| {
        let run = recipe(&workspace, &format!("ci-{job}"), &["--plan"], false);
        assert!(
            run.output.status.success(),
            "ci-{job} --plan failed:\n{}",
            run.log
        );
        run.selected(job)
    };
    let linux = plan("test-linux");
    for task in [
        "onepipeline-ui:test",
        "onepipeline-ui:install-smoke",
        "onepipeline-ui:wheel-smoke",
        "onepipeline-ui-coverage:coverage",
        "onepipeline-ui-baseline:test-baseline",
        "onepipeline-ui-cost:test-cost",
        "dag-ui-e2e:test",
    ] {
        assert!(
            linux.contains(task),
            "test-linux does not select {task}: {linux:?}"
        );
    }
    for job in ["test-windows", "test-macos"] {
        let selected = plan(job);
        for task in [
            "onepipeline-ui:test-quick",
            "onepipeline-ui:install-smoke",
            "onepipeline-ui:lint",
        ] {
            assert!(
                selected.contains(task),
                "{job} does not select {task}: {selected:?}"
            );
        }
        assert!(
            !selected.contains("onepipeline-ui:test"),
            "{job} runs the instrumented tier: {selected:?}"
        );
    }
    assert!(
        plan("test-windows").contains("dag-ui:build"),
        "test-windows skips the browser build"
    );
    let lint = plan("lint");
    for task in [
        "onepipeline-ui:msrv",
        "onepipeline-ui:deps-check",
        "onepipeline-ui:lint",
    ] {
        assert!(lint.contains(task), "lint does not select {task}: {lint:?}");
    }
}

#[test]
fn a_change_to_nothing_runs_no_task_and_passes() {
    let workspace = workspace(None);
    for job in ["lint", "test-linux", "test-windows", "test-macos"] {
        let run = recipe(&workspace, &format!("ci-{job}"), &[], false);
        assert!(
            run.output.status.success(),
            "ci-{job} failed on an empty change:\n{}",
            run.log
        );
        assert!(
            run.selected(job).is_empty(),
            "ci-{job} selected tasks for nothing:\n{}",
            run.log
        );
        assert!(
            run.ran().is_empty(),
            "ci-{job} ran tasks for nothing: {:?}",
            run.ran()
        );
    }
}

/// A TypeScript task each job selects for the run journey's change, which runs
/// for real while the crate's toolchain refuses: `test-linux` builds the view,
/// the other three lint it.
fn real_task(job: &str) -> &'static str {
    if job == "test-linux" {
        "dag-ui:build"
    } else {
        "dag-ui:lint"
    }
}

/// Every recipe runs what it selected, nothing of an unreached project, and
/// exits non-zero when a selected target fails — here every crate target, whose
/// toolchain refuses, while the TypeScript targets run for real.
#[test]
fn a_job_runs_what_it_selects_and_a_failing_target_fails_it() {
    let workspace = workspace(Some(RUN_CHANGED));
    for job in ["lint", "test-windows", "test-macos", "test-linux"] {
        let run = recipe(&workspace, &format!("ci-{job}"), &[], true);
        assert!(
            !run.output.status.success(),
            "ci-{job} passed although its crate targets failed:\n{}",
            run.log
        );
        assert!(
            run.log.contains("cargo stand-in: refused"),
            "ci-{job} never reached cargo:\n{}",
            run.log
        );
        let ran = run.ran();
        let selected = run.selected(job);
        assert!(
            ran.iter().all(|task| selected.contains(task)),
            "ci-{job} ran a task it did not select: ran {ran:?}, selected {selected:?}"
        );
        assert!(
            ran.contains(real_task(job)),
            "ci-{job} did not run {}:\n{}",
            real_task(job),
            run.log
        );
        for project in RUN_UNREACHED {
            assert!(
                tasks_of(&ran, project).is_empty(),
                "ci-{job} ran {project}'s tasks: {ran:?}"
            );
        }
    }
}

/// The release pull request's tier is the sweep: every project, whatever the
/// diff reached, with the host-labelled budgets `just budgets` runs.
#[test]
fn the_broader_tier_sweeps_every_project_with_the_budgets() {
    let workspace = workspace(None);
    let run = recipe(
        &workspace,
        "ci-test-linux",
        &["--tier", "broader", "--plan"],
        false,
    );
    assert!(
        run.output.status.success(),
        "the broader plan failed:\n{}",
        run.log
    );
    let selected = run.selected("test-linux");
    for task in [
        "dag-layout:check",
        "telemetry-client:test",
        "pool-maintenance:check",
        "pool-maintenance:budgets-host",
        "github-workflows:budgets",
        "dag-ui-build-cache:test",
        "onepipeline-ui:check",
        "onepipeline-ui:install-smoke",
        "onepipeline-ui:wheel-smoke",
        "onepipeline-ui-coverage:coverage",
    ] {
        assert!(
            selected.contains(task),
            "the sweep does not select {task}: {selected:?}"
        );
    }
    assert!(run.ran().is_empty(), "--plan ran tasks: {:?}", run.ran());
}

/// A lockfile the checkout no longer matches fails `test-linux` and names what
/// to do, even when the diff selected nothing to run; the other jobs leave that
/// question to it.
#[test]
fn a_lockfile_the_checkout_rewrote_fails_the_linux_job_alone() {
    let workspace = workspace(None);
    let lock = workspace.root().join("Cargo.lock");
    let mut bytes = fs::read(&lock).expect("read Cargo.lock");
    bytes.extend_from_slice(b"\n");
    fs::write(&lock, bytes).expect("rewrite Cargo.lock");

    let linux = recipe(&workspace, "ci-test-linux", &[], false);
    assert!(
        !linux.output.status.success(),
        "a rewritten lockfile passed:\n{}",
        linux.log
    );
    assert!(
        linux.log.contains("a committed lockfile differs") && linux.log.contains("ACTION:"),
        "the failure does not say a lockfile drifted and what to do:\n{}",
        linux.log
    );
    let lint = recipe(&workspace, "ci-lint", &[], false);
    assert!(
        lint.output.status.success(),
        "ci-lint judged the lockfile:\n{}",
        lint.log
    );
}

/// A project graph Nx cannot read stops a job before it runs anything, saying
/// so, rather than leaving it to pass on whatever it could plan.
#[test]
fn a_project_graph_nx_cannot_read_refuses_the_job() {
    let workspace = workspace(None);
    fs::write(
        workspace.root().join("packages/dag-layout/project.json"),
        "{ this is not JSON",
    )
    .expect("break a project definition");
    workspace.git(&[
        "commit",
        "--quiet",
        "--no-verify",
        "-am",
        "a broken project",
    ]);

    for job in ["lint", "test-linux"] {
        let run = recipe(&workspace, &format!("ci-{job}"), &[], false);
        assert!(
            !run.output.status.success(),
            "ci-{job} ran over a broken graph:\n{}",
            run.log
        );
        assert!(
            run.log.contains("Nx could not plan") && run.log.contains("ACTION:"),
            "ci-{job} did not say it could not plan:\n{}",
            run.log
        );
        assert!(run.ran().is_empty(), "ci-{job} ran tasks: {:?}", run.ran());
    }
}

/// The selection is read off a graph whose task map has to be there: a
/// document of any other shape is refused, never read as "nothing selected".
#[test]
fn a_graph_without_a_task_map_is_refused_not_read_as_an_empty_selection() {
    let decode = |document: &str| {
        let mut child = Command::new("node")
            .arg("scripts/ci-job-tasks.mjs")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("node is on PATH");
        std::io::Write::write_all(child.stdin.as_mut().expect("stdin"), document.as_bytes())
            .expect("hand over the document");
        child.wait_with_output().expect("the decoder ends")
    };
    for (document, says) in [
        ("Nx printed this instead", "no JSON task graph"),
        ("{\"tasks\": {}}", "no task map"),
        ("{\"tasks\": {\"tasks\": []}}", "no task map"),
    ] {
        let output = decode(document);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{document:?} was read as a selection"
        );
        assert!(
            plain(&output.stderr).contains(says),
            "{document:?}: {}",
            plain(&output.stderr)
        );
    }
    let output = decode("warming up\n{\"tasks\": {\"tasks\": {\"b:test\": {}, \"a:lint\": {}}}}");
    assert!(output.status.success(), "{}", plain(&output.stderr));
    assert_eq!(plain(&output.stdout), "a:lint b:test");
}

#[test]
fn a_job_or_tier_the_script_does_not_know_is_refused_with_its_usage() {
    let workspace = workspace(None);
    for arguments in [
        &["build"][..],
        &["lint", "--tier", "broader"],
        &["test-linux", "--tier", "all"],
    ] {
        let output = Command::new("bash")
            .arg("scripts/ci-job.sh")
            .args(arguments)
            .current_dir(workspace.root())
            .output()
            .expect("bash is on PATH");
        assert_eq!(
            output.status.code(),
            Some(2),
            "{arguments:?} was not refused as usage"
        );
        let stderr = plain(&output.stderr);
        assert!(stderr.contains("ACTION:"), "{arguments:?}: {stderr}");
    }
}
