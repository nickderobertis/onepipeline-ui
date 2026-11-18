//! A run's surfaces, raised, taken and answered the way the engine does it, for
//! the journeys that hold what the timeline serves of a surface's state.
//!
//! Wherever the engine has a verb, the verb writes the records: a question is
//! asked through the pinned CLI's real `onepipeline ask`, which waits on its
//! answer over the run's channel; a finding is raised through `verbs::surface`;
//! `verbs::next` takes each surface on the channel and journals its
//! `planner-surfaced`; and `verbs::reply_as` answers the question under its
//! correlation, journalling `planner-replied`. The three surfaces only the
//! running driver raises — a quiet worker, a failed check and checks left
//! unfollowed — have no verb outside the driver's loop, so their records are
//! appended through the fixture writer in exactly the shapes the engine's
//! `schemas/events.json` declares for them.

use std::fs;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use onepipeline::views::RunPaths;
use serde_json::{json, Value};

use crate::live_journal;
use crate::sibling;

/// How long a journey waits for a record the engine is about to write.
const PATIENCE: Duration = Duration::from_secs(60);

/// The ids the driver-raised surfaces are appended under: past any the run's
/// channel hands out to the surfaces raised through it in one journey.
pub(crate) const QUIET_WORKER_SURFACE: u64 = 100;
pub(crate) const CHECK_FAILED_SURFACE: u64 = 101;
pub(crate) const CHECKS_UNFOLLOWED_SURFACE: u64 = 102;

/// A question the pinned CLI is asking about `node`, waiting on its answer.
pub(crate) struct Asked {
    child: Child,
    /// The question's id on the channel.
    pub(crate) id: u64,
    /// The correlation its answer is to echo.
    pub(crate) correlation: String,
}

impl Asked {
    /// Wait for the asker to be handed its answer, and say what it printed.
    pub(crate) fn answered(self) -> String {
        let output = self.child.wait_with_output().expect("the asker ends");
        assert!(
            output.status.success(),
            "the asker was not answered: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
}

/// The run's journal records, in the order written.
pub(crate) fn records(root: &Path, run: &str) -> Vec<Value> {
    fs::read_to_string(root.join(run).join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Ask `question` about `node` through the real `onepipeline ask`, and wait
/// until its `planner-surface-queued` is journalled.
pub(crate) fn ask(root: &Path, run: &str, node: &str, question: &str) -> Asked {
    let child = Command::new(sibling::binary())
        .args(["ask", "--about", node, "--timeout", "120", question])
        .env(onepipeline_ui::store::RUNS_DIR_ENV, root)
        .env("ONEPIPELINE_RUN_ID", run)
        .env_remove(onepipeline_ui::cli::SESSION_ENV)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the pinned CLI starts");
    let deadline = Instant::now() + PATIENCE;
    let mut child = child;
    loop {
        if let Some(queued) = records(root, run).into_iter().find(|record| {
            record["kind"] == "planner-surface-queued" && record["payload"]["message"] == question
        }) {
            return Asked {
                child,
                id: queued["payload"]["surface"].as_u64().expect("a surface id"),
                correlation: queued["payload"]["correlation"]
                    .as_str()
                    .expect("a question's correlation")
                    .to_owned(),
            };
        }
        if Instant::now() >= deadline {
            // The asker this started is ended before the journey fails, so no
            // question outlives it.
            let _ = child.kill();
            let output = child.wait_with_output().expect("the asker ends");
            panic!(
                "the question was never journalled: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Raise a finding through the engine's own `surface` verb, answering its id.
pub(crate) fn raise_finding(root: &Path, run: &str, message: &str) -> u64 {
    onepipeline::verbs::surface(
        &RunPaths::under(root, run),
        onepipeline::channel::SurfaceKind::finding(),
        message.to_owned(),
    )
    .expect("the engine raises the finding")
    .surface
}

/// Take the next surface on the run's channel through the engine's own `next`,
/// answering the id it handed out.
pub(crate) fn take_next(root: &Path, run: &str) -> u64 {
    let next = onepipeline::verbs::next(
        &RunPaths::under(root, run),
        &onepipeline::filter::EventFilter::default(),
    )
    .expect("the engine hands the next surface out");
    next.surface.expect("a surface was waiting").id
}

/// Answer the question under `correlation` through the engine's own reply, in
/// the user's words.
pub(crate) fn answer(root: &Path, run: &str, correlation: &str, envelope: &Value) {
    let correlation: onemessagebus::Correlation =
        correlation.parse().expect("the question's correlation");
    onepipeline::verbs::reply_as(
        &RunPaths::under(root, run),
        Some(&correlation),
        &envelope.to_string(),
        onepipeline::provenance::Provenance::User,
    )
    .expect("the engine takes the answer");
}

/// The driver's three surfaces on `node` — a quiet worker, a failed check and
/// checks left unfollowed — each queued, its own record naming it, and taken,
/// appended in the engine's shapes.
pub(crate) fn driver_surfaces(root: &Path, run: &str, node: &str) {
    let labels = json!({ "run_id": run, "node": node });
    let queued = |id: u64, kind: &str, message: &str| {
        (
            "planner-surface-queued",
            json!({
                "surface": id, "kind": kind, "message": message,
                "source": "proposal", "blocking": false, "correlation": null,
            }),
        )
    };
    let surfaced = |id: u64, kind: &str, message: &str| {
        (
            "planner-surfaced",
            json!({
                "surface": id, "correlation": null, "kind": kind, "message": message,
                "source": "proposal", "blocking": false, "queued_at": 1_786_104_000_000_u64,
            }),
        )
    };
    let quiet = "quiet-worker: no activity for 900s (threshold 600s); last activity 900s ago.";
    let failed = "check-failed: lint failed on the change's head";
    let unfollowed = "checks-unfollowed: 1 check still running after the timeout";
    let records = [
        queued(QUIET_WORKER_SURFACE, "quiet-worker", quiet),
        (
            "quiet-worker",
            json!({
                "quiet_for_seconds": 900, "threshold_seconds": 600, "persona": "worker",
                "surface": QUIET_WORKER_SURFACE,
            }),
        ),
        queued(CHECK_FAILED_SURFACE, "check-failed", failed),
        (
            "check-failed",
            json!({
                "node": node, "change": "https://example.invalid/changes/1",
                "head": "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908", "check": "lint",
                "state": "failed", "conclusion": "failure", "required": true,
                "requirement": onepipeline::vocabulary::requirement_label(true),
                "url": "https://example.invalid/checks/lint",
                "surface": CHECK_FAILED_SURFACE,
            }),
        ),
        queued(CHECKS_UNFOLLOWED_SURFACE, "checks-unfollowed", unfollowed),
        (
            "checks-unfollowed",
            json!({
                "node": node, "change": "https://example.invalid/changes/1",
                "head": "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908", "reason": "timeout",
                "checks": [{
                    "check": "e2e", "required": false,
                    "requirement": onepipeline::vocabulary::requirement_label(false),
                }],
                "surface": CHECKS_UNFOLLOWED_SURFACE,
            }),
        ),
        surfaced(QUIET_WORKER_SURFACE, "quiet-worker", quiet),
        surfaced(CHECK_FAILED_SURFACE, "check-failed", failed),
        surfaced(CHECKS_UNFOLLOWED_SURFACE, "checks-unfollowed", unfollowed),
    ];
    let stream = format!("run-{run}.driver-surfaces");
    let base = time::OffsetDateTime::now_utc();
    let lines: Vec<String> = records
        .into_iter()
        .enumerate()
        .map(|(seq, (kind, payload))| {
            let at = base + time::Duration::milliseconds(i64::try_from(seq).expect("few"));
            json!({
                "v": 1,
                "ts": stamp(at),
                "stream": stream,
                "seq": seq,
                "source": "pipeline",
                "kind": kind,
                "labels": labels,
                "payload": payload,
                "artifacts": [],
            })
            .to_string()
        })
        .collect();
    live_journal::append_lines(&root.join(run).join("events.jsonl"), &lines);
}

/// An instant stamped the way a recorded record is: RFC 3339, milliseconds, UTC.
fn stamp(at: time::OffsetDateTime) -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    at.format(&format).expect("a stamp")
}

/// Every event of a timeline payload, across its spans.
pub(crate) fn events(timeline: &Value) -> Vec<Value> {
    timeline["spans"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|span| span["events"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// The events of a surface, by its id, as a timeline serves them.
pub(crate) fn of_surface(timeline: &Value, id: u64) -> Vec<Value> {
    events(timeline)
        .into_iter()
        .filter(|event| event["surface_state"]["id"] == id)
        .collect()
}
