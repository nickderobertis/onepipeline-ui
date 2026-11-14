//! The server's own report of the libraries it links: the dependency record
//! `cargo auditable` embeds in the executable it builds, read back with the
//! `auditable-info` reader an auditor's tooling uses, beside the engine release
//! the same server answers over `/healthz`.
//!
//! The read API copies no plans itself, so what a host can prove about the plan
//! store behind it is which release that is. Both reports are read off one
//! binary, built from this tree under the lock, and held to the
//! `onepipeline`/`onetaskgraph-*` releases a `Cargo.lock` resolves — exactly, so
//! a member of the plan-store family left behind, or a second copy of one at
//! another release, is a disagreement rather than a pass.
//!
//! Beside them, the server built against that engine reads a run the engine
//! itself drove: the pinned sibling CLI adopts a run of `kind: command` nodes,
//! which the engine runs with no agent, and the read API serves the nodes and
//! settlements it wrote.
//!
//! A tier of its own (`onepipeline-ui-linked-report`), because the second build
//! is what it costs and only a change that can move the linked set owes it.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::http;
use crate::serving::Serving;

/// One linked crate, as `(name, version)`.
type Release = (String, String);

/// The engine and the plan-store family whose releases this tier holds.
fn in_family(name: &str) -> bool {
    name == "onepipeline" || name.starts_with("onetaskgraph-")
}

fn repo_lock() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock")
}

fn locked_releases(lock: &Path) -> BTreeSet<Release> {
    let lock: toml::Table = fs::read_to_string(lock)
        .unwrap_or_else(|err| panic!("{}: {err}", lock.display()))
        .parse()
        .expect("the lock parses");
    lock["package"]
        .as_array()
        .expect("the lock lists packages")
        .iter()
        .filter_map(|package| {
            let name = package["name"].as_str()?;
            in_family(name).then(|| {
                (
                    name.to_owned(),
                    package["version"].as_str().expect("a version").to_owned(),
                )
            })
        })
        .collect()
}

/// Build `onepipeline-api` from this tree with `cargo auditable`, under the
/// lock, and answer the binary.
///
/// Its binary goes to a target directory of its own under this clone's
/// `target`, so the one it reads is never one a plain build of the suite has
/// uplifted over it. Its intermediate artifacts go to the clone's own build
/// directory, `target` (cargo's `build.build-dir`): the wrapper only reaches this
/// crate, whose units it keys apart from the suite's, so every dependency is one
/// the suite's debug build already compiled rather than a whole second graph
/// compiled cold. Whatever the suite's own compile was told — coverage
/// instrumentation above all — is not what a release compiles with, so it is
/// cleared here. So is what cargo tells a test process about the package it
/// belongs to, which no build of the crate runs with: a dependency's build script
/// that reads it — ring's reads `CARGO_MANIFEST_DIR` and `OUT_DIR` — would run
/// again, and rebuild its crate and every dependent over the suite's own.
fn an_auditable_build() -> PathBuf {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/auditable");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let mut build = std::process::Command::new(cargo);
    build.current_dir(env!("CARGO_MANIFEST_DIR"));
    for variable in [
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_BUILD_RUSTFLAGS",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "LLVM_PROFILE_FILE",
    ] {
        build.env_remove(variable);
    }
    for (variable, _) in std::env::vars_os() {
        let name = variable.to_string_lossy();
        if name.starts_with("CARGO_PKG_")
            || name.starts_with("CARGO_MANIFEST_")
            || name.starts_with("CARGO_BIN_EXE_")
            || [
                "CARGO_CRATE_NAME",
                "CARGO_PRIMARY_PACKAGE",
                "CARGO_TARGET_TMPDIR",
                "OUT_DIR",
            ]
            .contains(&name.as_ref())
        {
            build.env_remove(&variable);
        }
    }
    build
        .args([
            "auditable",
            "build",
            "--offline",
            "--locked",
            "--bin",
            "onepipeline-api",
            "--config",
            "build.build-dir=\"target\"",
            "--target-dir",
        ])
        .arg(&target);
    let output = build
        .output()
        .unwrap_or_else(|err| panic!("cargo auditable build could not start: {err}"));
    assert!(
        output.status.success(),
        "cargo auditable build failed — `just bootstrap` provisions cargo-auditable:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    target
        .join("debug")
        .join(format!("onepipeline-api{}", std::env::consts::EXE_SUFFIX))
}

fn reported_releases(binary: &Path) -> BTreeSet<Release> {
    let report = auditable_info::audit_info_from_file(binary, auditable_info::Limits::default())
        .unwrap_or_else(|err| {
            panic!(
                "{} carries no readable dependency record: {err}",
                binary.display()
            )
        });
    report
        .packages
        .iter()
        .filter(|package| in_family(&package.name))
        .map(|package| (package.name.clone(), package.version.to_string()))
        .collect()
}

/// Every way `binary`'s dependency record and the releases `lock` resolves
/// disagree, as a reader would be told them.
fn disagreements(binary: &Path, lock: &Path) -> Vec<String> {
    let reported = reported_releases(binary);
    let expected = locked_releases(lock);
    let unexpected = reported
        .difference(&expected)
        .map(|(name, version)| format!("links {name} {version}, which the lock does not resolve"));
    let missing = expected
        .difference(&reported)
        .map(|(name, version)| format!("does not link {name} {version}, which the lock resolves"));
    unexpected.chain(missing).collect()
}

/// A server built under the lock reports linking exactly the engine and
/// plan-store releases the lock resolves, and answers that engine release over
/// `/healthz` — the release the checked-in golden pins.
#[test]
fn a_built_server_reports_linking_the_engine_and_plan_store_the_lock_resolves() {
    let expected = locked_releases(&repo_lock());
    let engine = expected
        .iter()
        .find(|(name, _)| name == "onepipeline")
        .expect("the lock resolves onepipeline")
        .1
        .clone();
    assert!(
        expected
            .iter()
            .any(|(name, _)| name.starts_with("onetaskgraph-")),
        "the lock resolves no onetaskgraph crate"
    );

    let binary = an_auditable_build();
    let disagrees = disagreements(&binary, &repo_lock());
    assert!(
        disagrees.is_empty(),
        "the built server's dependency record disagrees with Cargo.lock: it {}",
        disagrees.join("; ")
    );

    let serving = Serving::start_binary_with_args(&binary, |_| {}, &[]);
    let response = http::get(serving.address, "/healthz");
    assert_eq!(response.status, 200);
    let served = response.json()["onepipeline_version"].clone();
    let golden: Value = serde_json::from_str(include_str!("../fixtures/healthz.json"))
        .expect("tests/fixtures/healthz.json parses");
    assert_eq!(served, Value::String(engine));
    assert_eq!(served, golden["onepipeline_version"]);
}

/// A lock moved one release past the server built from it — the engine and a
/// plan-store crate each — is a disagreement naming both releases, not a pass:
/// the stale build a host would otherwise be serving.
#[test]
fn a_lock_moved_past_the_built_server_disagrees_naming_both_releases() {
    let binary = an_auditable_build();
    let lock = fs::read_to_string(repo_lock()).expect("Cargo.lock");
    let locked = locked_releases(&repo_lock());
    let scratch = tempfile::tempdir().expect("a scratch directory");
    let mut moved = lock.clone();
    let mut expected = Vec::new();
    for name in ["onepipeline", "onetaskgraph-core"] {
        let (_, version) = locked
            .iter()
            .find(|(candidate, _)| candidate == name)
            .unwrap_or_else(|| panic!("the lock resolves {name}"));
        let mut parts: Vec<u64> = version
            .split('.')
            .map(|part| part.parse().expect("a numeric release"))
            .collect();
        *parts.last_mut().expect("a patch number") += 1;
        let next = parts
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(".");
        let entry = format!("name = \"{name}\"\nversion = \"{version}\"\n");
        assert_eq!(moved.matches(&entry).count(), 1, "one {name} entry");
        moved = moved.replace(
            &entry,
            &format!("name = \"{name}\"\nversion = \"{next}\"\n"),
        );
        expected.push(format!(
            "links {name} {version}, which the lock does not resolve"
        ));
        expected.push(format!(
            "does not link {name} {next}, which the lock resolves"
        ));
    }
    let moved_lock = scratch.path().join("Cargo.lock");
    fs::write(&moved_lock, moved).expect("write the moved lock");

    let mut disagrees = disagreements(&binary, &moved_lock);
    disagrees.sort();
    expected.sort();
    assert_eq!(disagrees, expected);
}

/// How long [`until`] waits for the adopted driver before calling it failed: a
/// ceiling on a failure, which a passing journey never pays, generous because
/// the driver is a process a loaded host schedules.
#[cfg(unix)]
const DRIVER_PATIENCE: std::time::Duration = std::time::Duration::from_secs(60);

/// Wait until `condition` holds, or fail naming what never happened.
#[cfg(unix)]
fn until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + DRIVER_PATIENCE;
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "{what} never happened within {DRIVER_PATIENCE:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// **A run the linked engine drove is served with its nodes and settlements.**
/// The pinned engine CLI adopts a launched run of two `kind: command` nodes and
/// runs them itself, so every record the server built against the linked engine
/// reads back is one that engine wrote. The plan's nodes are served with the
/// settlements the engine reached — `done` for the command that exited 0,
/// `failed` with `command-failed` for the one that exited 1 — the run as
/// ended, and the results route as what the linked engine's own `onepipeline
/// results` prints over the same records. A run nothing launched is refused.
#[cfg(unix)]
#[test]
fn a_run_the_linked_engine_drove_is_served_with_its_nodes_and_settlements() {
    use crate::fixture_run;
    use serde_json::json;

    let (workspace, root) = fixture_run::workspace();
    let dir = workspace.path().to_path_buf();
    let run = fixture_run::RUN_ID;
    let done = fixture_run::COMMAND_DONE_NODE_ID;
    let failed = fixture_run::COMMAND_FAILED_NODE_ID;
    fixture_run::write_awaiting_commands(&root, run, &dir);
    // What this suite's own dispatch exported for *its* run, which the driver
    // this journey adopts must meet none of.
    let inherited: Vec<String> = std::env::vars()
        .map(|(name, _)| name)
        .filter(|name| {
            ["ONEPIPELINE_", "ONEAGENTGRAPH_", "ONEHARNESS_"]
                .iter()
                .any(|prefix| name.starts_with(prefix))
        })
        .collect();
    let serving = Serving::start_in_as_with_env_removing(
        workspace,
        fixture_run::SESSION,
        &[
            ("ONEPIPELINE_PROJECT_DIR", &dir.display().to_string()),
            (
                "XDG_STATE_HOME",
                &dir.join("xdg-state").display().to_string(),
            ),
        ],
        &inherited,
    );
    let address = serving.address;
    let detail = move || http::get(address, &format!("/api/v2/runs/{run}")).json();

    serving.drive_fixture(run);
    // `ended-failed`: the engine settled both nodes, one of them `failed`,
    // and its driver let go of the run.
    until("the adopted run to end", || {
        detail()["run"]["state"] == json!("ended-failed")
    });

    let settled = detail();
    assert_eq!(
        settled["run"]["last_event"],
        json!("driver-exited"),
        "{settled}"
    );
    let graph = &settled["graph"];
    let tasks: Vec<&str> = graph["plan"]["tasks"]
        .as_array()
        .expect("the plan's tasks")
        .iter()
        .filter_map(|task| task["id"].as_str())
        .collect();
    assert_eq!(tasks, vec![done, failed], "{graph}");
    assert_eq!(graph["node_status"][done], json!("done"), "{graph}");
    assert_eq!(graph["node_status"][failed], json!("failed"), "{graph}");
    let results = &graph["node_results"];
    assert_eq!(results[done]["kind"], json!("command"), "{graph}");
    assert_eq!(results[done]["status"], json!("done"), "{graph}");
    assert_eq!(results[failed]["status"], json!("failed"), "{graph}");
    assert_eq!(
        results[failed]["outcome"],
        json!("command-failed"),
        "{graph}"
    );
    assert_eq!(graph["result"]["state"], json!("failed"), "{graph}");
    assert_eq!(graph["result"]["ok"], json!(false), "{graph}");

    let served = http::get(address, &format!("/api/v2/runs/{run}/results"));
    assert_eq!(served.status, 200, "{}", served.body);
    let printed = crate::sibling::run(&serving.runs_root(), None, &["results", run]);
    assert!(
        printed.status.success(),
        "{}",
        String::from_utf8_lossy(&printed.stderr)
    );
    assert_eq!(
        served.json()["rendered"],
        json!(String::from_utf8_lossy(&printed.stdout)),
        "the results route is not what the linked engine's `onepipeline results` prints"
    );

    let missing = http::get(address, "/api/v2/runs/no-run-launched-this");
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert_eq!(
        missing.json()["error"]["code"],
        json!("run_not_found"),
        "{}",
        missing.body
    );
}
