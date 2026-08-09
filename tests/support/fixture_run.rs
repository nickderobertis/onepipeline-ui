//! A real onepipeline run directory, written the way the SDK writes one.
//!
//! Shared by `tests/contract.rs` — which serves it and pins the result as the
//! checked-in goldens — and by the e2e journeys, which drive the compiled binary
//! against it over real HTTP. Nothing here is a stub of the SDK: these are the
//! files `onepipeline` itself records, so a build of the SDK that changed them
//! fails here rather than in production.
//!
//! Every timestamp is fixed and the graph completes, so what the server makes of
//! this directory does not depend on the clock or the host.

#![allow(dead_code)] // Each test binary uses the part of the builder it needs.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The run every fixture is written for.
pub const RUN_ID: &str = "run-20260807-a1b2c3";
/// A second run, so the list has more than one row to page and sort.
pub const OTHER_RUN_ID: &str = "run-20260807-d4e5f6";
/// The session the fixture run was launched from. Never served raw.
pub const SESSION: &str = "claude-code-session-3f9a1c2e";
/// The agent-graph session one node's dispatch ran under.
pub const CONVERSATION_ID: &str = "3f9a1c2e-0b77-4d21-9a6e-5c8f0a1b2c3d";
/// The artifact one relayed envelope recorded.
pub const ARTIFACT_ID: &str = "artifact-5c8f0a1b";
/// The node whose timeline the `scope=node` fixture is taken from.
pub const NODE_ID: &str = "contract-interface";
/// The node that depends on it.
pub const REVIEW_NODE_ID: &str = "review";
/// The lifecycle node of the live run, which runs steps on one branch.
pub const SHIP_NODE_ID: &str = "ship";
/// The live run's human action, which nothing but a person can finish.
pub const SIGNOFF_NODE_ID: &str = "signoff";
/// The live run's node gated by that human action.
pub const ANNOUNCE_NODE_ID: &str = "announce";
/// The agent-graph session the live run's dispatch ran under.
pub const LIVE_CONVERSATION_ID: &str = "8a1d3c07-4b2f-4e55-91aa-6d3e2f0b7c14";

/// The instant the fixture run started, as every payload renders it.
const START: &str = "2026-08-07T12:00:00.000Z";

/// One recorded run under `root`, complete and settled.
///
/// Returns the run's directory, so a test can append to its journal and watch
/// the server notice.
pub fn write(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(dir.join("channel")).expect("the run directory");
    fs::create_dir_all(dir.join("round-01")).expect("the round directory");
    fs::create_dir_all(dir.join("artifacts")).expect("the artifact directory");

    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            "launcher": "claude-code",
            "session": SESSION,
            // A pid recorded on another host means nothing here, which is what
            // keeps the liveness verdict off this machine's process table.
            "pid": 4242,
            "host": "a-recording-host",
            "started_at": START,
            "round_budget": 14_400,
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");

    let plan = plan();
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    fs::write(dir.join("round-01/plan.json"), pretty(&plan)).expect("the round's plan");
    fs::write(
        dir.join("round-01/result.json"),
        pretty(&json!({
            "run_id": run,
            "round": 1,
            "state": "complete",
            "ok": true,
            "nodes": [
                {
                    "id": NODE_ID,
                    "status": "done",
                    "outcome": "shipped",
                    "branch": "feature/contract-interface",
                    "change_url": "https://example.invalid/changes/1",
                },
                { "id": REVIEW_NODE_ID, "status": "done", "outcome": "approved" },
            ],
        })),
    )
    .expect("the round's result");

    fs::write(
        dir.join("artifacts").join(ARTIFACT_ID),
        "the gate ran and passed\n",
    )
    .expect("the artifact body");

    fs::write(dir.join("events.jsonl"), journal(run)).expect("the journal");
    dir
}

/// The plan the run executed.
fn plan() -> Value {
    json!({
        "schema_version": 1,
        "goal": { "text": "serve the read contract" },
        "name": "contract",
        "concurrency": 4,
        "tasks": [
            {
                "id": NODE_ID,
                "persona": "worker",
                "task": "## What\nLand the wire contract.",
                "done_when": "the routes serve",
            },
            {
                "id": REVIEW_NODE_ID,
                "persona": "judge",
                "task": "## What\nReview it.",
                "deps": [NODE_ID],
            },
        ],
    })
}

/// The merged event store, in merge order.
fn journal(run: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut seq = 0;
    let mut emit = |at: &str, source: &str, kind: &str, labels: Value, payload: Value| {
        let line = json!({
            "v": 1,
            "ts": at,
            "stream": "a-recording-host-4242",
            "seq": seq,
            "source": source,
            "kind": kind,
            "labels": labels,
            "payload": payload,
            "artifacts": if kind == "node-settled" && labels["node"] == json!(NODE_ID) {
                json!([{ "id": ARTIFACT_ID, "kind": "log", "bytes": 24 }])
            } else {
                json!([])
            },
        });
        seq += 1;
        lines.push(line.to_string());
    };

    emit(
        START,
        "pipeline",
        "run-started",
        json!({ "run_id": run }),
        json!({ "plan": plan() }),
    );
    emit(
        "2026-08-07T12:00:01.000Z",
        "pipeline",
        "round-started",
        json!({ "run_id": run, "round": 1 }),
        json!({}),
    );
    emit(
        "2026-08-07T12:00:02.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "round": 1, "node": NODE_ID, "persona": "worker" }),
        json!({ "persona": "worker" }),
    );
    emit(
        "2026-08-07T12:00:03.000Z",
        "agentgraph",
        "agent-turn",
        json!({
            "run_id": run,
            "round": 1,
            "node": NODE_ID,
            "persona": "worker",
            "session": CONVERSATION_ID,
        }),
        json!({ "message": "landed the route table", "model": "a-model" }),
    );
    emit(
        "2026-08-07T12:00:20.000Z",
        "pipeline",
        "node-settled",
        json!({ "run_id": run, "round": 1, "node": NODE_ID }),
        json!({
            "status": "done",
            "outcome": "shipped",
            "branch": "feature/contract-interface",
            "change_url": "https://example.invalid/changes/1",
        }),
    );
    emit(
        "2026-08-07T12:00:21.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "round": 1, "node": REVIEW_NODE_ID, "persona": "judge" }),
        json!({ "persona": "judge" }),
    );
    emit(
        "2026-08-07T12:00:30.000Z",
        "pipeline",
        "node-settled",
        json!({ "run_id": run, "round": 1, "node": REVIEW_NODE_ID }),
        json!({ "status": "done", "outcome": "approved" }),
    );
    emit(
        "2026-08-07T12:00:31.000Z",
        "pipeline",
        "round-finished",
        json!({ "run_id": run, "round": 1 }),
        json!({ "state": "complete", "ok": true }),
    );

    format!("{}\n", lines.join("\n"))
}

/// Append one event to a run's journal, the way a live round does.
pub fn append(dir: &Path, kind: &str, payload: Value) {
    let journal = dir.join("events.jsonl");
    let existing = fs::read_to_string(&journal).unwrap_or_default();
    let seq = existing.lines().count();
    let line = json!({
        "v": 1,
        "ts": "2026-08-07T12:01:00.000Z",
        "stream": "a-recording-host-4242",
        "seq": seq,
        "source": "pipeline",
        "kind": kind,
        "labels": { "run_id": dir.file_name().and_then(|n| n.to_str()), "round": 1 },
        "payload": payload,
        "artifacts": [],
    });
    fs::write(&journal, format!("{existing}{line}\n")).expect("append to the journal");
}

/// A run whose second round is still open: a lifecycle node with steps, a human
/// action nobody has taken, a node gated by it, and a surface the planner has
/// not read.
///
/// It is the other half of what the payloads have to describe — everything the
/// settled run above cannot show, because it is finished and everything in it
/// went well.
pub fn write_live(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(dir.join("round-01")).expect("the first round");
    fs::create_dir_all(dir.join("round-02")).expect("the second round");
    fs::create_dir_all(dir.join("artifacts")).expect("the artifact directory");
    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            "launcher": "codex",
            "session": "codex-session-7f3a91c0",
            "pid": 4243,
            "host": "a-recording-host",
            "started_at": START,
            "round_budget": 14_400,
            "heartbeat_interval": 1_800,
            "adoptions": 1,
        })),
    )
    .expect("the launch record");

    let first = plan();
    fs::write(dir.join("plan.json"), pretty(&first)).expect("the plan");
    fs::write(dir.join("round-01/plan.json"), pretty(&first)).expect("the first round's plan");
    fs::write(
        dir.join("round-01/result.json"),
        pretty(&json!({
            "run_id": run,
            "round": 1,
            "state": "waiting",
            "ok": false,
            "nodes": [
                { "id": NODE_ID, "status": "done", "outcome": "shipped" },
                {
                    "id": REVIEW_NODE_ID,
                    "status": "failed",
                    "outcome": "rejected",
                    // The two texts a failure records are written by different
                    // parts of the executor and mean different things: the
                    // lifecycle's own prose, and what the dispatch reported.
                    "detail": "the reviewer asked for a changelog entry",
                    "error": "review exited non-zero",
                    "exit_code": 2,
                    "ok": false,
                },
            ],
        })),
    )
    .expect("the first round's result");
    let second = live_plan();
    fs::write(dir.join("round-02/plan.json"), pretty(&second)).expect("the second round's plan");

    // Bigger than one response may carry, so the tail is a tail.
    fs::write(
        dir.join("artifacts").join("artifact-long-log"),
        format!("{}TAIL\n", "x".repeat(70_000)),
    )
    .expect("the long artifact");

    fs::write(dir.join("events.jsonl"), live_journal(run, &second)).expect("the journal");
    dir
}

/// The plan the live run's second round is converging toward.
fn live_plan() -> Value {
    json!({
        "schema_version": 1,
        "goal": { "text": "get it shipped" },
        "name": "ship",
        "concurrency": 2,
        "tasks": [
            {
                "id": SHIP_NODE_ID,
                "persona": "pr-author",
                "task": "## What\nShip it.",
                "context": "the reviewer asked for a changelog entry",
                "done_when": "the change request is open",
                "max_turns": 12,
                "expects_no_diff": false,
                "repo": "nickderobertis/onepipeline-ui",
                "branch": "feature/ship",
                "base_branch": "main",
                "title": "Ship it",
                "execution_checkout": "primary",
                "steps": [
                    { "id": "build", "persona": "worker", "task": "## What\nBuild it." },
                    { "id": "hand-over", "kind": "human" },
                ],
            },
            { "id": SIGNOFF_NODE_ID, "kind": "human", "task": "Approve the change." },
            {
                "id": ANNOUNCE_NODE_ID,
                "persona": "check-in",
                "task": "## What\nAnnounce it.",
                "deps": [SIGNOFF_NODE_ID],
            },
        ],
    })
}

/// Two rounds of events, the second still open.
fn live_journal(run: &str, second: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut seq = 0;
    let mut emit = |at: &str, source: &str, kind: &str, labels: Value, payload: Value| {
        lines.push(
            json!({
                "v": 1,
                "ts": at,
                "stream": "a-recording-host-4243",
                "seq": seq,
                "source": source,
                "kind": kind,
                "labels": labels,
                "payload": payload,
                "artifacts": if kind == "node-settled" && labels["node"] == json!(SHIP_NODE_ID) {
                    json!([{ "id": "artifact-long-log", "kind": "report", "bytes": 70_005 }])
                } else {
                    json!([])
                },
            })
            .to_string(),
        );
        seq += 1;
    };

    emit(
        START,
        "pipeline",
        "run-started",
        json!({ "run_id": run }),
        json!({ "plan": plan() }),
    );
    emit(
        "2026-08-07T12:00:01.000Z",
        "pipeline",
        "round-started",
        json!({ "run_id": run, "round": 1 }),
        json!({}),
    );
    emit(
        "2026-08-07T12:00:09.000Z",
        "pipeline",
        "round-finished",
        json!({ "run_id": run, "round": 1 }),
        json!({ "state": "waiting", "ok": false }),
    );
    // A surface the planner has been sent but has not read: the run is waiting
    // on a decision, and that wait is its own bucket of the wall clock.
    emit(
        "2026-08-07T12:00:10.000Z",
        "pipeline",
        "planner-surface-queued",
        json!({ "run_id": run, "round": 1 }),
        json!({ "kind": "decision", "message": "retry or park?", "blocking": true }),
    );
    emit(
        "2026-08-07T12:00:11.000Z",
        "pipeline",
        "planner-surfaced",
        json!({ "run_id": run, "round": 1 }),
        json!({ "blocking": true }),
    );
    emit(
        "2026-08-07T12:00:25.000Z",
        "pipeline",
        "planner-replied",
        json!({ "run_id": run, "round": 1 }),
        json!({}),
    );
    emit(
        "2026-08-07T12:00:26.000Z",
        "pipeline",
        "round-started",
        json!({ "run_id": run, "round": 2 }),
        json!({ "plan": second }),
    );
    emit(
        "2026-08-07T12:00:27.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID, "persona": "pr-author" }),
        json!({ "persona": "pr-author" }),
    );
    emit(
        "2026-08-07T12:00:28.000Z",
        "agentgraph",
        "agent-turn",
        json!({
            "run_id": run,
            "round": 2,
            "node": SHIP_NODE_ID,
            "step": "build",
            "persona": "pr-author",
            "session": LIVE_CONVERSATION_ID,
        }),
        json!({ "message": "opened the change request" }),
    );
    // The branch `onevcs` opened for this node and the change it published from
    // it, relayed into the merged store under that library's own vocabulary.
    // Two recorded ends, which is the only publication interval a journal holds.
    emit(
        "2026-08-07T12:00:29.000Z",
        "vcs",
        "session-opened",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "token": "a-vcs-session-token",
            "branch": "feature/ship",
            "base": "main",
            "worktree": "/a/recorded/worktree",
        }),
    );
    emit(
        "2026-08-07T12:00:38.000Z",
        "vcs",
        "published",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "branch": "feature/ship",
            "url": "https://example.invalid/changes/2",
            "id": "2",
            "outcome": "published",
        }),
    );
    emit(
        "2026-08-07T12:00:40.000Z",
        "pipeline",
        "node-settled",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "status": "done",
            "outcome": "published",
            "branch": "feature/ship",
            "change_url": "https://example.invalid/changes/2",
            "completed_steps": ["build"],
            "detail": "the change request is open",
        }),
    );
    // Waiting on a person: real recorded time, drawn as its own span rather
    // than as silence.
    emit(
        "2026-08-07T12:00:41.000Z",
        "pipeline",
        "node-settled",
        json!({ "run_id": run, "round": 2, "node": SIGNOFF_NODE_ID }),
        json!({ "status": "waiting" }),
    );
    format!("{}\n", lines.join("\n"))
}

/// A run that recorded its launch and nothing since — how a just-started run
/// reads on disk, and the only shape with no round at all.
pub fn write_launched(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(&dir).expect("the run directory");
    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            // A launcher outside the closed vocabulary a client switches on.
            "launcher": "a-plain-shell",
            "session": "",
            "pid": 4244,
            "host": "a-recording-host",
            "started_at": START,
            "round_budget": 14_400,
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    fs::write(
        dir.join("events.jsonl"),
        format!(
            "{}\n",
            json!({
                "v": 1,
                "ts": START,
                "stream": "a-recording-host-4244",
                "seq": 0,
                "source": "pipeline",
                "kind": "run-started",
                "labels": { "run_id": run },
                "payload": {},
                "artifacts": [],
            })
        ),
    )
    .expect("the journal");
    dir
}

fn pretty(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).expect("serialize")
    )
}

/// The run id of the recorded-only fixture below.
pub const RECORDED_ONLY_RUN_ID: &str = "run-20260807-9f8e7d";

/// A run whose round recorded a result and whose journal never existed.
///
/// This is what a run predating the journal looks like on an operator's machine,
/// permanently: there is nothing to fold, so the round's own result is the only
/// account of it — and that result holds words no journal settlement can carry,
/// including a status outside the vocabulary a client switches on and a failure
/// with an outcome but no prose.
pub fn write_recorded_only(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(dir.join("round-01")).expect("the round directory");
    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            "launcher": "claude-code",
            "session": SESSION,
            "pid": 4245,
            "host": "a-recording-host",
            "started_at": START,
            "round_budget": 14_400,
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    let plan = json!({
        "schema_version": 1,
        "name": "recorded",
        "concurrency": 1,
        "tasks": [
            { "id": NODE_ID, "persona": "worker", "task": "## What\nConvert it." },
            { "id": REVIEW_NODE_ID, "persona": "judge", "task": "## What\nCheck it." },
        ],
    });
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    fs::write(dir.join("round-01/plan.json"), pretty(&plan)).expect("the round's plan");
    fs::write(
        dir.join("round-01/result.json"),
        pretty(&json!({
            "run_id": run,
            "round": 1,
            "state": "failed",
            "ok": false,
            "nodes": [
                // A word the served vocabulary does not hold.
                { "id": NODE_ID, "status": "improvised" },
                // A failure whose only recorded explanation is its outcome word.
                { "id": REVIEW_NODE_ID, "status": "failed", "outcome": "gate-failed" },
            ],
        })),
    )
    .expect("the round's result");
    fs::write(dir.join("events.jsonl"), "").expect("the empty journal");
    dir
}
