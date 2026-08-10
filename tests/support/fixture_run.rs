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
/// The session the review node's judge member ran under.
pub const REVIEW_CONVERSATION_ID: &str = "6b4d2a08-1e35-4c77-88ff-2a9c7b3e5d16";
/// The artifact one relayed envelope recorded: the gate's own log.
pub const ARTIFACT_ID: &str = "artifact-5c8f0a1b";
/// The log the host's failing check stored, which is how a reader reads it.
pub const CHECK_LOG_ARTIFACT: &str = "artifact-published-smoke";
/// The commit the change merged as. No url: the host owns that and records none.
pub const MERGE_SHA: &str = "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908";
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
/// The live run's own driving session, recorded at no node.
pub const DRIVING_CONVERSATION_ID: &str = "1b7c5a90-2d4e-4f11-93cc-8f5a2b0d9e36";
/// The session the lint member of that dispatch ran under.
pub const LINT_CONVERSATION_ID: &str = "2c9e4b71-6a83-4f20-97dd-1e6b4c2a8f37";

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
    fs::write(
        dir.join("artifacts").join(CHECK_LOG_ARTIFACT),
        "the published-smoke check failed\n",
    )
    .expect("the failing check's log");
    fs::write(
        dir.join("artifacts").join("artifact-gate-check"),
        "the gate check passed\n",
    )
    .expect("the passing check's log");

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

/// A merged event store being written, one record at a time.
///
/// The sequence is per stream and the merge order is `(ts, stream, seq)`, which
/// is what the SDK's own reader merges on — so a fixture writes its records in
/// the order they happened and lets the numbering follow.
struct Journal {
    stream: String,
    lines: Vec<String>,
}

impl Journal {
    fn new(stream: &str) -> Self {
        Self {
            stream: stream.to_owned(),
            lines: Vec::new(),
        }
    }

    /// One record, with the evidence its producer stored beside the stream.
    fn kept(
        &mut self,
        at: &str,
        source: &str,
        kind: &str,
        labels: Value,
        payload: Value,
        artifacts: Value,
    ) -> &mut Self {
        self.lines.push(
            json!({
                "v": 1,
                "ts": at,
                "stream": self.stream,
                "seq": self.lines.len(),
                "source": source,
                "kind": kind,
                "labels": labels,
                "payload": payload,
                "artifacts": artifacts,
            })
            .to_string(),
        );
        self
    }

    /// One record that stored nothing.
    fn emit(
        &mut self,
        at: &str,
        source: &str,
        kind: &str,
        labels: Value,
        payload: Value,
    ) -> &mut Self {
        self.kept(at, source, kind, labels, payload, json!([]))
    }

    fn text(&self) -> String {
        format!("{}\n", self.lines.join("\n"))
    }
}

/// The merged event store, in merge order.
///
/// The `vcs` and `agentgraph` records are the ones those two libraries really
/// write: `onevcs` opens a session, runs the repository's gate, pushes, opens a
/// change, reports every transition of every check the host runs on it, queues
/// on the identity's lock, and merges — and `oneagentgraph` closes a turn with
/// the usage that turn consumed. What this crate makes of them is the whole of
/// what the goldens pin.
fn journal(run: &str) -> String {
    let round = json!({ "run_id": run, "round": 1 });
    let at_node = json!({ "run_id": run, "round": 1, "node": NODE_ID });
    let identity = "github.com/nickderobertis/onepipeline-ui";
    let mut journal = Journal::new("a-recording-host-4242");
    journal
        .emit(
            START,
            "pipeline",
            "run-started",
            json!({ "run_id": run }),
            json!({ "plan": plan() }),
        )
        .emit(
            "2026-08-07T12:00:01.000Z",
            "pipeline",
            "round-started",
            round.clone(),
            json!({}),
        )
        .emit(
            "2026-08-07T12:00:02.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "round": 1, "node": NODE_ID, "persona": "worker" }),
            json!({ "persona": "worker" }),
        )
        .emit(
            "2026-08-07T12:00:03.000Z",
            "agentgraph",
            "agent-turn",
            json!({
                "run_id": run,
                "round": 1,
                "node": NODE_ID,
                "member": "worker",
                "persona": "worker",
                "session": CONVERSATION_ID,
            }),
            json!({ "message": "landed the route table", "model": "a-model" }),
        )
        // What the turn consumed, as `oneagentgraph` reports it when the turn is
        // done: the only measurement of model time and cost anything in the
        // stack records.
        .emit(
            "2026-08-07T12:00:05.000Z",
            "agentgraph",
            "turn-completed",
            json!({
                "run_id": run,
                "round": 1,
                "node": NODE_ID,
                "member": "worker",
                "persona": "worker",
                "session": CONVERSATION_ID,
            }),
            json!({
                "usage": {
                    "tokens_in": 1_200,
                    "tokens_out": 340,
                    "cache_read": 800,
                    "cache_write": 120,
                    "cost": 0.42,
                    "duration": 2.5,
                },
            }),
        )
        .emit(
            "2026-08-07T12:00:06.000Z",
            "vcs",
            "session-opened",
            at_node.clone(),
            json!({
                "token": "a-vcs-session-token",
                "identity": identity,
                "branch": "feature/contract-interface",
                "base": "main",
                "worktree": "/a/recorded/worktree",
                "clone": "/a/recorded/clone",
            }),
        )
        .emit(
            "2026-08-07T12:00:07.000Z",
            "vcs",
            "gate-started",
            at_node.clone(),
            json!({
                "command": "just gate",
                "comparison_remote": "origin",
                "comparison_base": "main",
            }),
        )
        // The gate's own log, which is the evidence a reader opens from the
        // verification record this becomes.
        .kept(
            "2026-08-07T12:00:09.000Z",
            "vcs",
            "gate-verdict",
            at_node.clone(),
            json!({
                "verdict": "pass",
                "command": "just gate",
                "output": "the gate ran and passed",
                "preserved_log": "/a/recorded/clone/gate.log",
            }),
            json!([{ "id": ARTIFACT_ID, "kind": "log", "bytes": 24 }]),
        )
        .emit(
            "2026-08-07T12:00:10.000Z",
            "vcs",
            "push",
            at_node.clone(),
            json!({ "branch": "feature/contract-interface", "remote": "origin", "accepted": true }),
        )
        .emit(
            "2026-08-07T12:00:11.000Z",
            "vcs",
            "change-opened",
            at_node.clone(),
            json!({
                "url": "https://example.invalid/changes/1",
                "host": "github",
                "id": "1",
                "base": "main",
                "author": "a-recording-host",
            }),
        )
        // Every transition of every check, which is what `onevcs` reports while
        // it waits: the required one queues and then passes, and the advisory
        // one fails without blocking the merge.
        .emit(
            "2026-08-07T12:00:12.000Z",
            "vcs",
            "change-check",
            at_node.clone(),
            json!({
                "name": "gate",
                "required": true,
                "status": "queued",
                "from_status": Value::Null,
                "conclusion": Value::Null,
            }),
        )
        .kept(
            "2026-08-07T12:00:13.000Z",
            "vcs",
            "change-check",
            at_node.clone(),
            json!({
                "name": "published-smoke",
                "required": false,
                "status": "completed",
                "from_status": "in_progress",
                "conclusion": "failure",
            }),
            json!([{ "id": CHECK_LOG_ARTIFACT, "kind": "log", "bytes": 39 }]),
        )
        .kept(
            "2026-08-07T12:00:14.000Z",
            "vcs",
            "change-check",
            at_node.clone(),
            json!({
                "name": "gate",
                "required": true,
                "status": "completed",
                "from_status": "queued",
                "conclusion": "success",
            }),
            json!([{ "id": "artifact-gate-check", "kind": "log", "bytes": 18 }]),
        )
        // The contention the merge met, timed by `onevcs` itself: the record is
        // written when the turn came and says how long it had been waiting.
        .emit(
            "2026-08-07T12:00:15.000Z",
            "vcs",
            "lock-wait",
            at_node.clone(),
            json!({ "identity": identity, "elapsed": 0.75, "queue_position": 1 }),
        )
        .emit(
            "2026-08-07T12:00:15.100Z",
            "vcs",
            "lock-acquired",
            at_node.clone(),
            json!({ "identity": identity }),
        )
        .emit(
            "2026-08-07T12:00:16.000Z",
            "vcs",
            "merge-queued",
            at_node.clone(),
            json!({
                "identity": identity,
                "queue_position": 1,
                "url": "https://example.invalid/changes/1",
            }),
        )
        .emit(
            "2026-08-07T12:00:17.000Z",
            "vcs",
            "lock-wait",
            at_node.clone(),
            json!({ "identity": identity, "elapsed": 2.25, "queue_position": 2 }),
        )
        .emit(
            "2026-08-07T12:00:18.000Z",
            "vcs",
            "change-merged",
            at_node.clone(),
            json!({ "url": "https://example.invalid/changes/1", "sha": MERGE_SHA }),
        )
        .emit(
            "2026-08-07T12:00:19.000Z",
            "vcs",
            "merge-completed",
            at_node.clone(),
            json!({ "identity": identity, "sha": MERGE_SHA, "base": "main" }),
        )
        .emit(
            "2026-08-07T12:00:20.000Z",
            "pipeline",
            "node-settled",
            at_node,
            json!({
                "status": "done",
                "outcome": "shipped",
                "branch": "feature/contract-interface",
                "change_url": "https://example.invalid/changes/1",
            }),
        )
        .emit(
            "2026-08-07T12:00:21.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "round": 1, "node": REVIEW_NODE_ID, "persona": "judge" }),
            json!({ "persona": "judge" }),
        )
        // The other side of the pair: a member the graph runs as the judge
        // transport, which is what tells a judge chain's failure from an
        // agent chain's.
        .emit(
            "2026-08-07T12:00:22.000Z",
            "agentgraph",
            "agent-turn",
            json!({
                "run_id": run,
                "round": 1,
                "node": REVIEW_NODE_ID,
                "member": "judge",
                "persona": "judge",
                "session": REVIEW_CONVERSATION_ID,
            }),
            json!({ "message": "the contract reads", "model": "a-model" }),
        )
        .emit(
            "2026-08-07T12:00:25.000Z",
            "agentgraph",
            "turn-completed",
            json!({
                "run_id": run,
                "round": 1,
                "node": REVIEW_NODE_ID,
                "member": "judge",
                "persona": "judge",
                "session": REVIEW_CONVERSATION_ID,
            }),
            json!({
                "usage": {
                    "tokens_in": 400,
                    "tokens_out": 90,
                    "cache_read": 0,
                    "cache_write": 0,
                    "cost": 0.11,
                    "duration": 3.0,
                },
            }),
        )
        .emit(
            "2026-08-07T12:00:30.000Z",
            "pipeline",
            "node-settled",
            json!({ "run_id": run, "round": 1, "node": REVIEW_NODE_ID }),
            json!({ "status": "done", "outcome": "approved" }),
        )
        .emit(
            "2026-08-07T12:00:31.000Z",
            "pipeline",
            "round-finished",
            round,
            json!({ "state": "complete", "ok": true }),
        );
    journal.text()
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
    // The run's own driving session, recorded at no node: what starts the run
    // rather than any of the work in it.
    emit(
        "2026-08-07T12:00:05.000Z",
        "agentgraph",
        "agent-turn",
        json!({
            "run_id": run,
            "round": 1,
            "persona": "orchestrator",
            "session": DRIVING_CONVERSATION_ID,
        }),
        json!({ "message": "driving the first round", "model": "a-model" }),
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
        "2026-08-07T12:00:26.500Z",
        "agentgraph",
        "agent-turn",
        json!({
            "run_id": run,
            "round": 2,
            "persona": "orchestrator",
            "session": DRIVING_CONVERSATION_ID,
        }),
        json!({ "message": "driving the second round", "model": "a-model" }),
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
    // What the dispatch reported from *inside* that turn: `oneagentgraph`
    // publishes a bounded tool summary as the turn runs rather than when it is
    // done, which is what a watcher is told about over the stream.
    emit(
        "2026-08-07T12:00:28.500Z",
        "agentgraph",
        "turn-activity",
        json!({
            "run_id": run,
            "round": 2,
            "node": SHIP_NODE_ID,
            "step": "build",
            "member": "worker",
            "persona": "pr-author",
            "session": LIVE_CONVERSATION_ID,
        }),
        json!({
            "kind": "tool_use",
            "name": "Bash",
            "detail": "just gate",
            "truncated": false,
        }),
    );
    emit(
        "2026-08-07T12:00:28.800Z",
        "agentgraph",
        "turn-completed",
        json!({
            "run_id": run,
            "round": 2,
            "node": SHIP_NODE_ID,
            "step": "build",
            "member": "worker",
            "persona": "pr-author",
            "session": LIVE_CONVERSATION_ID,
        }),
        json!({
            "usage": {
                "tokens_in": 900,
                "tokens_out": 210,
                "cache_read": 300,
                "cache_write": 60,
                "cost": 0.19,
                "duration": 1.5,
            },
        }),
    );
    // The lint tier the graph runs as a member of its own: the same semantic
    // role as the work it is checking, told apart from it by its transport.
    emit(
        "2026-08-07T12:00:28.900Z",
        "agentgraph",
        "agent-turn",
        json!({
            "run_id": run,
            "round": 2,
            "node": SHIP_NODE_ID,
            "member": "llmlint",
            "persona": "pr-author",
            "session": LINT_CONVERSATION_ID,
        }),
        json!({ "message": "the diff reads", "model": "a-model" }),
    );
    emit(
        "2026-08-07T12:00:28.950Z",
        "agentgraph",
        "turn-completed",
        json!({
            "run_id": run,
            "round": 2,
            "node": SHIP_NODE_ID,
            "member": "llmlint",
            "persona": "pr-author",
            "session": LINT_CONVERSATION_ID,
        }),
        json!({
            "usage": {
                "tokens_in": 120,
                "tokens_out": 40,
                "cache_read": 0,
                "cache_write": 0,
                "cost": 0.03,
                "duration": 0.5,
            },
        }),
    );
    // The branch `onevcs` opened for this node and what it did with it, relayed
    // into the merged store under that library's own vocabulary: a change left
    // open with a required check still running is a publication in flight.
    emit(
        "2026-08-07T12:00:29.000Z",
        "vcs",
        "session-opened",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "token": "a-vcs-session-token",
            "identity": "github.com/nickderobertis/onepipeline-ui",
            "branch": "feature/ship",
            "base": "main",
            "worktree": "/a/recorded/worktree",
        }),
    );
    emit(
        "2026-08-07T12:00:33.000Z",
        "vcs",
        "lock-wait",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "identity": "github.com/nickderobertis/onepipeline-ui",
            "elapsed": 4.5,
            "queue_position": 3,
        }),
    );
    emit(
        "2026-08-07T12:00:35.000Z",
        "vcs",
        "push",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({ "branch": "feature/ship", "remote": "origin", "accepted": true }),
    );
    emit(
        "2026-08-07T12:00:38.000Z",
        "vcs",
        "change-opened",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "url": "https://example.invalid/changes/2",
            "host": "github",
            "id": "2",
            "base": "main",
            "author": "a-recording-host",
        }),
    );
    emit(
        "2026-08-07T12:00:39.000Z",
        "vcs",
        "change-check",
        json!({ "run_id": run, "round": 2, "node": SHIP_NODE_ID }),
        json!({
            "name": "gate",
            "required": true,
            "status": "in_progress",
            "from_status": "queued",
            "conclusion": Value::Null,
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

/// The run id of the stopped-mid-round fixture below.
pub const STOPPED_RUN_ID: &str = "run-20260807-5c4b3a";

/// A run whose driver stopped part way through a round it never wrote a result for.
///
/// The one shape where the round's own account and the run's fold could disagree:
/// the round is not open, so a reader that only ever consults a result finds
/// nothing, while the fold still knows exactly what the run got to.
pub fn write_stopped_mid_round(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(dir.join("round-01")).expect("the round directory");
    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            "launcher": "codex",
            "session": SESSION,
            "pid": 4250,
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
        "name": "stopped",
        "concurrency": 1,
        "tasks": [
            { "id": NODE_ID, "persona": "worker", "task": "## What\nStart it." },
        ],
    });
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    fs::write(dir.join("round-01/plan.json"), pretty(&plan)).expect("the round's plan");
    let lines = [
        json!({
            "v": 1, "ts": START, "stream": "a-recording-host-4250", "seq": 0,
            "source": "pipeline", "kind": "run-started",
            "labels": { "run_id": run }, "payload": { "plan": plan }, "artifacts": [],
        }),
        json!({
            "v": 1, "ts": "2026-08-07T12:00:01.000Z", "stream": "a-recording-host-4250",
            "seq": 1, "source": "pipeline", "kind": "round-started",
            "labels": { "run_id": run, "round": 1 }, "payload": {}, "artifacts": [],
        }),
        json!({
            "v": 1, "ts": "2026-08-07T12:00:02.000Z", "stream": "a-recording-host-4250",
            "seq": 2, "source": "pipeline", "kind": "node-dispatched",
            "labels": { "run_id": run, "round": 1, "node": NODE_ID, "persona": "worker" },
            "payload": {}, "artifacts": [],
        }),
        json!({
            "v": 1, "ts": "2026-08-07T12:00:03.000Z", "stream": "a-recording-host-4250",
            "seq": 3, "source": "pipeline", "kind": "run-stopped",
            "labels": { "run_id": run }, "payload": {}, "artifacts": [],
        }),
    ];
    let journal: Vec<String> = lines.iter().map(ToString::to_string).collect();
    fs::write(
        dir.join("events.jsonl"),
        format!("{}\n", journal.join("\n")),
    )
    .expect("the journal");
    dir
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
