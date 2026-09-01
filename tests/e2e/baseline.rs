//! What this branch's base commit served, served again.
//!
//! Adopting an engine eleven minors ahead moves a great deal under this crate at
//! once, and the failure mode that would not show up anywhere else is a *quiet*
//! one: a field that stopped being served because the record it was read from
//! moved, on a route whose golden nobody thought to look at. A fixture cannot
//! catch that, because a fixture is editable by the change it is meant to hold —
//! so the baseline here is read from version control.
//!
//! The journeys start the base commit's own `onepipeline-api` beside this build's
//! over **one** runs root and ask both the same questions. What they compare is
//! what the criterion is about: every route the older binary answered is answered
//! now, and every field it served on each of them is served now. Values are
//! deliberately not compared — repairing what a conversation is *read from* is
//! the whole point of the adoption, and a value that improved is a change this
//! branch's own record states rather than one a comparison should refuse.
//!
//! **Neither journey builds anything.** Compiling another commit's whole
//! dependency graph is the expensive half of this, and it lives behind the
//! `onepipeline-ui:ensure-baseline` Nx target — the same arrangement the sibling
//! CLI has, and for the same reason: a change to a workflow, a script or a
//! document must not make the root project's tests build a second server. What
//! reaches here is a provisioned binary and the commit it was stamped with, and a
//! stamp naming anything but this branch's base fails the journey rather than
//! comparing this build against something that is not what it replaced.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::fixture_run;
use crate::http;
use crate::serving::{ForeignServing, Serving};

/// The environment variable naming the provisioned baseline server.
///
/// Exported by the justfile beside the sibling CLI's, so every tier that runs
/// this suite reaches the one binary the `ensure-baseline` target built rather
/// than whatever a checkout happens to hold.
const BASELINE_BIN_ENV: &str = "ONEPIPELINE_UI_BASELINE_BIN";

/// This repository's own checkout, which is where the base commit is read from.
fn repository() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// One `git` invocation in this checkout, or the reason it could not be made.
fn git(arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository())
        .args(arguments)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|answer| !answer.is_empty())
}

/// The commit this branch forked from, as version control records it.
///
/// `origin/main` first and `main` after it: a clone made by the harness has the
/// remote ref and a working checkout has both, and a merge base against either is
/// the same commit. Not `HEAD~`, which is this branch's previous commit rather
/// than its base, and would compare a change against itself the moment the branch
/// carried two.
fn base_commit() -> String {
    ["origin/main", "main"]
        .into_iter()
        .find_map(|reference| git(&["merge-base", "HEAD", reference]))
        .unwrap_or_else(|| {
            panic!(
                "this checkout resolves neither `origin/main` nor `main`, so there is no base \
                 commit to compare against and this journey is guarding nothing"
            )
        })
}

/// The base commit's own server binary, as `just _ensure-baseline` provisioned
/// it, and the commit it was built from.
///
/// The stamp is read rather than trusted: the recipe rebuilds when the base
/// moves, and a stamp that names something else means this journey is about to
/// compare against a commit that is not the one this branch forked from — which
/// says nothing while looking exactly like a comparison that did.
fn baseline_binary(base: &str) -> PathBuf {
    let binary = std::env::var_os(BASELINE_BIN_ENV).map_or_else(
        || {
            repository().join(".tools/bin").join(format!(
                "onepipeline-api-baseline{}",
                std::env::consts::EXE_SUFFIX
            ))
        },
        PathBuf::from,
    );
    assert!(
        binary.is_file(),
        "{} is not provisioned: run `just _ensure-baseline`, which is the \
         `onepipeline-ui:ensure-baseline` target every test tier depends on",
        binary.display()
    );
    let stamp = fs::read_to_string(format!("{}.commit", binary.display()))
        .unwrap_or_else(|err| panic!("{}.commit: {err}", binary.display()));
    assert_eq!(
        stamp.trim(),
        base,
        "the provisioned baseline was built from another commit; run \
         `just _ensure-baseline`"
    );
    binary
}

/// The runs root both servers are asked about.
///
/// Five recorded runs between them — a settled one with reports and artifacts, a
/// re-asked node's lanes, a publication that never landed, a run with no journal
/// at all, and a driver stopped mid-flight — so the comparison covers the payload
/// rather than a corner of it.
///
/// Every launch record in it is rewritten into the shape the base commit's engine
/// could read. That is not a convenience: that engine refused a record naming a
/// project or carrying any key it had no field for, so the runs it can serve at
/// all are these, and a store it refuses would compare two empty lists.
fn shared_store(root: &Path) {
    fixture_run::write(root, fixture_run::RUN_ID);
    fixture_run::write_lanes(root, fixture_run::LANES_RUN_ID);
    fixture_run::write_preserved(root, "run-baseline-preserved");
    fixture_run::write_recorded_only(root, "run-baseline-recorded");
    fixture_run::write_stopped_mid_flight(root, "run-baseline-stopped");
    for run in fs::read_dir(root).expect("the runs root") {
        fixture_run::make_launch_record_legacy(&run.expect("a run directory").path());
    }
}

/// Every path a run is asked for, with the selections the contract requires.
fn asked(run: &str) -> Vec<String> {
    vec![
        "/healthz".to_owned(),
        "/api/v2/runs?include_settled=true".to_owned(),
        format!("/api/v2/runs/{run}"),
        format!("/api/v2/runs/{run}?include_conversations=true"),
        format!("/api/v2/runs/{run}/timeline?scope=run"),
        format!(
            "/api/v2/runs/{run}/timeline?scope=node&node={}",
            fixture_run::NODE_ID
        ),
        format!(
            "/api/v2/runs/{run}/conversations/{}",
            fixture_run::CONVERSATION_ID
        ),
        format!("/api/v2/runs/{run}/artifacts/{}", fixture_run::ARTIFACT_ID),
    ]
}

/// Every field one response carries, as a path from its root.
///
/// An array index is written `[]` rather than as its position, so a field only
/// one element of a list carries is still a field the response served — which is
/// what a comparison of *fields* has to mean when the two sides may hold
/// different numbers of turns or spans.
///
/// `observed_at` is dropped: it is when the response was read, so the two sides
/// carry different values for it by construction and neither is a fact about the
/// run.
fn fields(body: &Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    walk(body, String::new(), &mut found);
    found.remove("observed_at");
    found
}

fn walk(value: &Value, at: String, found: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let path = if at.is_empty() {
                    key.clone()
                } else {
                    format!("{at}.{key}")
                };
                found.insert(path.clone());
                walk(child, path, found);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, format!("{at}[]"), found);
            }
        }
        _ => {}
    }
}

#[test]
fn every_field_the_base_commit_served_is_served_by_this_build() {
    let base = base_commit();
    let baseline = baseline_binary(&base);

    let serving = Serving::start(shared_store);
    // Both servers ask the same provisioned `onepipeline` for a run's clock, so a
    // difference in what they serve is this crate's rather than the sibling's.
    // The document's own version has not moved across the adoption, so the older
    // binary reads the newer CLI's document exactly as this one does.
    let sibling = std::env::var(onepipeline_ui::telemetry::BINARY_ENV).unwrap_or_default();
    let older = ForeignServing::start(
        &baseline,
        serving.runs_root(),
        &[(onepipeline_ui::telemetry::BINARY_ENV, sibling.as_str())],
    );

    let mut compared = 0;
    for run in [
        fixture_run::RUN_ID,
        fixture_run::LANES_RUN_ID,
        "run-baseline-preserved",
        "run-baseline-recorded",
        "run-baseline-stopped",
    ] {
        for path in asked(run) {
            let before = http::get(older.address, &path);
            let after = http::get(serving.address, &path);
            if before.status != 200 {
                // A route the base commit did not answer for this run says
                // nothing about what this build must serve; the ones it did are
                // the whole of the baseline.
                continue;
            }
            assert_eq!(
                after.status, 200,
                "{path}: the base commit answered it and this build does not: {}",
                after.body
            );
            if path == "/healthz" {
                // The one response whose *value* is meant to have moved: it names
                // the engine the binary links, which is the whole subject of this
                // branch.
                assert_eq!(before.json()["status"], after.json()["status"]);
                assert_ne!(
                    before.json()["onepipeline_version"],
                    after.json()["onepipeline_version"],
                    "the adoption did not move the release /healthz reports"
                );
                compared += 1;
                continue;
            }
            let dropped: Vec<String> = fields(&before.json())
                .difference(&fields(&after.json()))
                .cloned()
                .collect();
            assert!(
                dropped.is_empty(),
                "{path} served {dropped:?} at {base} and does not now"
            );
            compared += 1;
        }
    }
    assert!(
        compared > 20,
        "{compared} responses is fewer than the base commit answers for this store; this \
         journey is comparing almost nothing"
    );

    // And the stream, which opens on a snapshot of every run rather than on one.
    let mut before = http::stream(older.address, "/api/v2/events", None);
    let mut after = http::stream(serving.address, "/api/v2/events", None);
    assert_eq!(before.status, 200);
    assert_eq!(after.status, 200);
    let dropped: Vec<String> = fields(&before.frames(1).remove(0).json())
        .difference(&fields(&after.frames(1).remove(0).json()))
        .cloned()
        .collect();
    assert!(
        dropped.is_empty(),
        "the event stream's snapshot served {dropped:?} at {base} and does not now"
    );
}

#[test]
fn the_runs_the_base_commit_could_not_read_are_read_now() {
    // The other direction, and the one the adoption is *for*. The comparison
    // above asks that nothing was dropped; this asks what was gained, against the
    // same baseline and over the same five launch-record shapes — because "a run
    // that used to be invisible is visible" is a claim about two builds, and no
    // fixture on this branch can make it about anything but one.
    let base = base_commit();
    let baseline = baseline_binary(&base);

    let mut shapes = Vec::new();
    let serving = Serving::start(|root| {
        shapes = fixture_run::write_launch_shapes(root);
    });
    let older = ForeignServing::start(&baseline, serving.runs_root(), &[]);

    let listed = |address| -> BTreeSet<String> {
        http::get(address, "/api/v2/runs?include_settled=true").json()["runs"]
            .as_array()
            .expect("the rows")
            .iter()
            .filter_map(|row| row["run_id"].as_str().map(str::to_owned))
            .collect()
    };
    let before = listed(older.address);
    let after = listed(serving.address);

    // Every shape, now. Exactly one of them then — the plan path and nothing else:
    // that engine's launch record *required* a plan and refused every key it had
    // no field for, so even the record written across the change, which names a
    // plan path as well as a project, did not deserialize.
    for (run, shape) in &shapes {
        assert!(after.contains(run), "{shape} is not listed: {after:?}");
    }
    assert_eq!(
        before,
        ["launch-plan-only"]
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<String>>(),
        "the base commit read a shape this journey says it could not, so the gap this branch \
         closes is not the gap being measured"
    );
    assert_eq!(
        after.difference(&before).count(),
        4,
        "four of the five shapes were invisible at {base} and are served now: {after:?}"
    );

    // And they are not merely rows: each opens, which is what an operator does
    // with the run they came looking for.
    for run in after.difference(&before) {
        let response = http::get(serving.address, &format!("/api/v2/runs/{run}"));
        assert_eq!(response.status, 200, "{run}: {}", response.body);
    }
}
