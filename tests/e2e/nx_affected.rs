//! The affected tier's selection: `scripts/nx-affected.sh`, over a copy of this
//! workspace, asked about real commits.
//!
//! What a pull request and a push to `main` pay for is decided here — which
//! projects a diff reaches, and so which `check` aggregates run — and every
//! mistake in it is silent in the direction of passing: a project the selection
//! misses is a check that never ran and a green that looks like any other. So
//! these journeys commit a change to one file and ask the real script, through
//! the real Nx, what it would run.
//!
//! Nothing is stood in for. The workspace is every file this checkout carries —
//! every `project.json`, `nx.json`, the sources whose imports Nx reads edges from
//! — copied into a scratch git repository so its commits are this suite's own;
//! Nx is the one this workspace installed, borrowed rather than reinstalled, as
//! `llmlint_cache` borrows it. `--graph=stdout` is Nx's own answer to "what would
//! you run", so the selection is read without running any of it.
//!
//! Unix only for the reason `llmlint_cache` is: the borrowed install is a
//! symlink, and the script is bash. The macOS leg runs it.
#![cfg(unix)]

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

/// The variable a push build names its base commit with.
const BASE_SHA: &str = "ONEPIPELINE_UI_NX_BASE_SHA";

/// The four shared TypeScript packages. Each declares the targets below, and
/// before it declared a `check` aggregate too an affected `check` ran none of
/// them — a change to one surfaced only after the merge.
const PACKAGES: [&str; 4] = [
    "dag-layout",
    "dag-model",
    "telemetry-client",
    "timeline-categories",
];

/// What an affected `check` owes a package it reaches.
const PACKAGE_TIERS: [&str; 6] = [
    "format-check",
    "lint",
    "typecheck",
    "build",
    "test",
    "check",
];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A scratch copy of this workspace, committed once as the base a change is
/// measured from.
struct Workspace {
    dir: TempDir,
    base: String,
}

impl Workspace {
    fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let workspace = dir.path().join("workspace");
        // Every file a checkout of this branch carries, tracked or about to be,
        // read from the working tree so the graph asked about is this tree's.
        let listed = Command::new("git")
            .args([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ])
            .current_dir(repo_root())
            .output()
            .expect("git is on PATH");
        assert!(listed.status.success(), "git ls-files: {}", stderr(&listed));
        for name in listed.stdout.split(|byte| *byte == 0) {
            let name = std::str::from_utf8(name).expect("a utf-8 path");
            let source = repo_root().join(name);
            // A file deleted in the working tree is still in the index; what the
            // tree does not have, the copy does not need.
            if name.is_empty() || !source.is_file() {
                continue;
            }
            let destination = workspace.join(name);
            fs::create_dir_all(destination.parent().expect("a parent directory"))
                .expect("create the copy's directory");
            fs::copy(&source, &destination)
                .unwrap_or_else(|error| panic!("copy {name} into the scratch workspace: {error}"));
        }
        // The orchestrator, borrowed: `scripts/workspace-install.sh` sees its
        // shim and installs nothing, as it does in a bootstrapped clone.
        symlink(
            repo_root().join("node_modules"),
            workspace.join("node_modules"),
        )
        .expect("borrow the workspace's node_modules");

        let fixture = Self {
            dir,
            base: String::new(),
        };
        fixture.git(&["init", "--quiet"]);
        fixture.git(&["add", "-A"]);
        fixture.git(&["commit", "--quiet", "--no-verify", "-m", "the base"]);
        let base = fixture.git(&["rev-parse", "HEAD"]);
        Self { base, ..fixture }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().join("workspace")
    }

    /// Run git in the workspace under a configuration of its own, so nothing
    /// this host signs commits with or hooks into them reaches it.
    fn git(&self, arguments: &[&str]) -> String {
        let config = self.dir.path().join("gitconfig");
        if !config.exists() {
            fs::write(
                &config,
                "[user]\n\tname = the suite\n\temail = suite@example.invalid\n\
                 [commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
            )
            .expect("the scratch git config");
        }
        let output = Command::new("git")
            .args(arguments)
            .current_dir(self.root())
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git is on PATH");
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            stderr(&output)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// Commit an edit to `path` on top of the base: a line appended to a file
    /// that exists, which changes its bytes and nothing it means to a reader that
    /// parses it — a JSON document still parses, a script still runs.
    fn change(&self, path: &str) -> &Self {
        let file = self.root().join(path);
        let mut bytes = fs::read(&file).unwrap_or_else(|error| panic!("read {path}: {error}"));
        bytes.push(b'\n');
        fs::write(&file, bytes).unwrap_or_else(|error| panic!("write {path}: {error}"));
        self.git(&["commit", "--quiet", "--no-verify", "-am", "the change"]);
        self
    }

    /// The script, run the way CI runs it, with only `environment` deciding its
    /// base: everything that could otherwise reach it from the host running the
    /// suite — a CI flag, a base branch, a base commit, Nx's own settings, which
    /// an outer Nx run sets for its tasks — is removed first.
    fn script(&self, arguments: &[&str], environment: &[(&str, &str)]) -> Output {
        let mut command = Command::new("bash");
        command
            .arg("scripts/nx-affected.sh")
            .args(arguments)
            .current_dir(self.root());
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy();
            if name.starts_with("NX_")
                || [
                    "CI",
                    "GITHUB_BASE_REF",
                    "ONEPIPELINE_UI_NX_BASE_REF",
                    BASE_SHA,
                ]
                .contains(&name.as_ref())
            {
                command.env_remove(name.as_ref());
            }
        }
        command.env("NX_DAEMON", "false");
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("bash is on PATH")
    }

    /// What an affected `check` would run on a push build based on this
    /// workspace's base commit — the tasks Nx planned, read off its own graph.
    fn planned(&self, environment: &[(&str, &str)]) -> (BTreeSet<String>, String) {
        let output = self.script(&["-t", "check", "--graph=stdout"], environment);
        assert!(
            output.status.success(),
            "the affected selection failed ({}):\n{}",
            output.status,
            stderr(&output)
        );
        let graph: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "Nx did not answer with a task graph ({error}):\n{}",
                String::from_utf8_lossy(&output.stdout)
            )
        });
        let tasks = graph["tasks"]["tasks"]
            .as_object()
            .expect("the graph lists its tasks")
            .keys()
            .cloned()
            .collect();
        (tasks, stderr(&output))
    }

    /// The tasks a push build whose `before` is the base would run.
    fn on_push(&self) -> BTreeSet<String> {
        let (tasks, notices) = self.planned(&[("CI", "true"), (BASE_SHA, &self.base)]);
        assert!(
            notices.is_empty(),
            "a push build with a base it can resolve fell back or complained:\n{notices}"
        );
        tasks
    }

    /// Answer `--affects` for `pattern`, on a push build based on the base.
    fn affects(&self, pattern: &str, environment: &[(&str, &str)]) -> (String, String) {
        let output = self.script(&["--affects", pattern], environment);
        assert!(
            output.status.success(),
            "--affects {pattern} failed ({}):\n{}",
            output.status,
            stderr(&output)
        );
        (
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
            stderr(&output),
        )
    }
}

fn selected(tasks: &BTreeSet<String>, project: &str) -> bool {
    tasks.contains(&format!("{project}:check"))
}

#[test]
fn a_change_to_a_shared_package_checks_it_and_its_dependents_and_no_unrelated_package() {
    // Each package with one it does not reach: neither imports the other, and no
    // `implicitDependencies` joins them.
    let unrelated = [
        ("dag-layout", "timeline-categories"),
        ("dag-model", "dag-layout"),
        ("telemetry-client", "timeline-categories"),
        ("timeline-categories", "dag-layout"),
    ];
    for package in PACKAGES {
        let workspace = Workspace::new();
        let tasks = workspace
            .change(&format!("packages/{package}/src/index.ts"))
            .on_push();
        for tier in PACKAGE_TIERS {
            assert!(
                tasks.contains(&format!("{package}:{tier}")),
                "a change to packages/{package} does not run its `{tier}`, so it is \
                 checked only after the merge: {tasks:?}"
            );
        }
        assert!(
            selected(&tasks, "dag-ui"),
            "a change to packages/{package} does not check the app built from it: {tasks:?}"
        );
        let (_, other) = unrelated
            .iter()
            .find(|(changed, _)| *changed == package)
            .expect("an unrelated package for each package");
        assert!(
            !selected(&tasks, other),
            "a change to packages/{package} checks {other}, which it cannot reach: {tasks:?}"
        );
    }
}

#[test]
fn a_fixture_belongs_to_its_readers_and_to_no_project_of_its_own() {
    let workspace = Workspace::new();
    let listed = Command::new("bash")
        .args(["scripts/nx.sh", "show", "projects", "--json"])
        .current_dir(workspace.root())
        .env("NX_DAEMON", "false")
        .output()
        .expect("bash is on PATH");
    assert!(listed.status.success(), "{}", stderr(&listed));
    let names: Vec<String> = serde_json::from_slice(&listed.stdout).expect("a JSON list");
    assert!(
        !names.iter().any(|name| name == "contract"),
        "Nx still reads tests/fixtures/project.json as a project of its own: {names:?}"
    );

    // The served project body itself: the fixture discovery no longer sees is
    // still one a change to reaches — the crate's contract tests and the model
    // package's journeys both read it.
    let tasks = workspace.change("tests/fixtures/project.json").on_push();
    for reader in ["onepipeline-ui", "dag-model"] {
        assert!(
            tasks.contains(&format!("{reader}:test")),
            "a change to tests/fixtures/project.json does not run {reader}'s tests, \
             which read it: {tasks:?}"
        );
    }
    assert!(
        !tasks.iter().any(|task| task.starts_with("contract:")),
        "a change to tests/fixtures/ runs a project made of the fixture: {tasks:?}"
    );
}

#[test]
fn a_fixture_change_re_runs_a_cached_reader_rather_than_replaying_it() {
    // Hidden from Nx's file walker so discovery skips it, the fixture is hidden
    // from its hashes too — and a cached reader would replay a verdict about the
    // old bytes. The runtime input in `servedGoldens` is what keys it instead.
    let workspace = Workspace::new();
    let run = || {
        let output = Command::new("bash")
            .args([
                "scripts/nx.sh",
                "run",
                "dag-model:test",
                "--outputStyle=static",
            ])
            .current_dir(workspace.root())
            .env("NX_DAEMON", "false")
            .env_remove("NX_SKIP_NX_CACHE")
            .env_remove("NX_DISABLE_NX_CACHE")
            .output()
            .expect("bash is on PATH");
        assert!(
            output.status.success(),
            "dag-model:test failed:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            stderr(&output)
        );
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            stderr(&output)
        )
    };
    // What Nx's summary says when it replayed the task instead of running it.
    let replayed = |report: &str| report.contains("read the output from the cache");
    assert!(
        !replayed(&run()),
        "the first run replayed a cache it never wrote"
    );
    assert!(
        replayed(&run()),
        "an unchanged tree re-ran dag-model:test, so this cannot tell a replay from a run"
    );
    workspace.change("tests/fixtures/project.json");
    assert!(
        !replayed(&run()),
        "dag-model:test replayed its verdict after the fixture it reads changed"
    );
}

#[test]
fn a_change_to_the_repository_machinery_selects_its_tier_and_not_the_journeys() {
    for path in ["scripts/nx.sh", ".github/workflows/ci.yml"] {
        let workspace = Workspace::new();
        let tasks = workspace.change(path).on_push();
        assert!(
            selected(&tasks, "onepipeline-ui-repo-tooling"),
            "a change to {path} does not run the suites that drive it: {tasks:?}"
        );
        for tier in ["onepipeline-ui-e2e", "onepipeline-ui-coverage"] {
            assert!(
                !selected(&tasks, tier),
                "a change to {path} runs {tier}, which reads nothing it changed: {tasks:?}"
            );
        }
    }
}

#[test]
fn a_change_to_a_journey_selects_its_tier_and_not_the_repository_machinery() {
    let workspace = Workspace::new();
    let tasks = workspace.change("tests/e2e/server.rs").on_push();
    assert!(
        selected(&tasks, "onepipeline-ui-e2e"),
        "a change to the server journeys does not run them: {tasks:?}"
    );
    assert!(
        selected(&tasks, "onepipeline-ui-coverage"),
        "a change to an instrumented tier's tests does not re-measure the floor: {tasks:?}"
    );
    for tier in [
        "onepipeline-ui-repo-tooling",
        "onepipeline-ui-baseline",
        "onepipeline-ui-cost",
    ] {
        assert!(
            !selected(&tasks, tier),
            "a change to the server journeys selects {tier}: {tasks:?}"
        );
    }
}

#[test]
fn a_push_build_is_scoped_to_the_commit_before_the_push() {
    let workspace = Workspace::new();
    let tasks = workspace.change("docs/dag-ui.md").on_push();
    assert!(
        !tasks.is_empty(),
        "a push build ran nothing for a change it was handed"
    );
    for project in PACKAGES {
        assert!(
            !selected(&tasks, project),
            "a push changing one document checks {project}, so it was not scoped to the \
             commit before the push: {tasks:?}"
        );
    }
}

#[test]
fn the_base_commit_outranks_the_base_branch() {
    let workspace = Workspace::new();
    workspace.change("docs/dag-ui.md");
    // A branch that does not exist here: were it consulted, there would be no
    // merge base, and the build would fall back to every project.
    let (tasks, notices) = workspace.planned(&[
        ("CI", "true"),
        ("ONEPIPELINE_UI_NX_BASE_REF", "no-such-branch"),
        (BASE_SHA, &workspace.base),
    ]);
    assert!(
        notices.is_empty(),
        "the base branch was consulted beside the base commit:\n{notices}"
    );
    assert!(
        !selected(&tasks, "dag-layout"),
        "a base commit beside a base branch did not scope the build: {tasks:?}"
    );
}

#[test]
fn a_base_commit_that_does_not_resolve_runs_everything_and_says_which_variable() {
    let workspace = Workspace::new();
    workspace.change("docs/dag-ui.md");
    // A commit id this repository has never held, and one that is no commit id
    // at all: both are refused rather than passed over to the branch fallback.
    for unresolvable in ["0000000000000000000000000000000000000000", "HEAD~1; true"] {
        let (tasks, notices) = workspace.planned(&[("CI", "true"), (BASE_SHA, unresolvable)]);
        assert!(
            notices.contains(BASE_SHA),
            "an unresolvable base commit was refused without naming {BASE_SHA}:\n{notices}"
        );
        assert!(
            notices.contains("running every project"),
            "an unresolvable base commit did not say it ran everything:\n{notices}"
        );
        for project in PACKAGES {
            assert!(
                selected(&tasks, project),
                "an unresolvable base commit ran a scoped selection without {project}, \
                 rather than every project: {tasks:?}"
            );
        }
    }
}

#[test]
fn a_ci_build_with_no_base_runs_everything() {
    let workspace = Workspace::new();
    workspace.change("docs/dag-ui.md");
    let (tasks, notices) = workspace.planned(&[("CI", "true")]);
    assert!(
        notices.contains("running every project"),
        "a build with no base did not say it ran everything:\n{notices}"
    );
    for project in PACKAGES {
        assert!(
            selected(&tasks, project),
            "a build with no base left {project} out: {tasks:?}"
        );
    }
}

#[test]
fn a_test_only_change_still_reaches_the_rust_matrices() {
    // `just affected-crate` asks `--affects tag:lang:rust`, and `cross`, `msrv`,
    // `deny`, `install` and `wheel` run on its `true`. A change to a tier's tests
    // alone is one those matrices must run on: they run that tier.
    let workspace = Workspace::new();
    workspace.change("tests/e2e/server.rs");
    let push = [("CI", "true"), (BASE_SHA, workspace.base.as_str())];
    for (pattern, expected) in [
        ("tag:lang:rust", "true"),
        ("onepipeline-ui-e2e", "true"),
        ("onepipeline-ui-cost", "false"),
    ] {
        let (answer, notices) = workspace.affects(pattern, &push);
        assert!(
            notices.is_empty(),
            "--affects {pattern} complained:\n{notices}"
        );
        assert_eq!(
            answer, expected,
            "--affects {pattern} for a change to tests/e2e/server.rs"
        );
    }
    let (answer, notices) = workspace.affects(
        "onepipeline-ui-cost",
        &[
            ("CI", "true"),
            (BASE_SHA, "0000000000000000000000000000000000000000"),
        ],
    );
    assert_eq!(
        answer, "true",
        "an unresolvable base answered a project unaffected"
    );
    assert!(
        notices.contains(BASE_SHA),
        "an unresolvable base was refused without naming {BASE_SHA}:\n{notices}"
    );
}
