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

use onepipeline::event::Envelope;
use onepipeline::report;
use onepipeline::views::RunPaths;
use serde_json::{json, Map, Value};

/// The run every fixture is written for.
pub const RUN_ID: &str = "run-20260807-a1b2c3";
/// A second run, so the list has more than one row to page and sort.
pub const OTHER_RUN_ID: &str = "run-20260807-d4e5f6";
/// The session the fixture run was launched from. Never served raw.
pub const SESSION: &str = "claude-code-session-3f9a1c2e";
/// The agent-graph session one node's dispatch ran under.
///
/// Spelled the way `oneagentgraph` spells one: the emitting stream's id, a `.`,
/// and the member id, sanitised to this crate's own identifier rule. It is not
/// a uuid and nothing here may assume one — the label is a *pair*, which is what
/// keeps two members of one dispatch two conversations.
pub const CONVERSATION_ID: &str = "node-scope-1786925518098-3163646.worker";
/// The session the review node's judge member ran under, from that member's own
/// stream.
pub const REVIEW_CONVERSATION_ID: &str = "node-scope-1786925518102-3163741.judge";
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
/// The live run's in-flight node whose turn the planner redirected: it has a
/// controllable turn, and the note went into the turn that was already running.
pub const REDIRECTED_NODE_ID: &str = "docs";
/// The live run's other in-flight node, running on a harness with no
/// out-of-band turn control: the same note could only ride its next dispatch.
pub const UNCONTROLLED_NODE_ID: &str = "benchmark";
/// The agent-graph session the live run's dispatch ran under.
pub const LIVE_CONVERSATION_ID: &str = "8a1d3c07-4b2f-4e55-91aa-6d3e2f0b7c14";
/// The live run's own driving session, recorded at no node.
pub const DRIVING_CONVERSATION_ID: &str = "1b7c5a90-2d4e-4f11-93cc-8f5a2b0d9e36";
/// The session the lint member of that dispatch ran under.
pub const LINT_CONVERSATION_ID: &str = "2c9e4b71-6a83-4f20-97dd-1e6b4c2a8f37";
/// The session the redirected node's worker is talking in.
pub const REDIRECTED_CONVERSATION_ID: &str = "4d0f6b32-8c15-4a09-b2ee-7f1c3d5a6e28";
/// The session the node with no lever is talking in.
pub const UNCONTROLLED_CONVERSATION_ID: &str = "5e1a7c43-9d26-4b1a-83ff-8a2d4e6b7f39";
/// The live run's third in-flight node, and the trap this fixture exists to
/// spring: its *previous* dispatch settled with a onejudge report naming no
/// controllable turn, and its current one is a fresh turn nobody has interrupted.
/// The old report must not label the new turn — `provider.control` is asked for
/// per run and the provider's outcome is reset for the next one, so the earlier
/// answer is a fact about a dispatch that is over.
pub const REPORTED_NODE_ID: &str = "measure";
/// The session that node's worker is talking in.
pub const REPORTED_CONVERSATION_ID: &str = "6f2b8d54-0e37-4c2b-94aa-9b3e5f7c8a4b";
/// The words onejudge's own report gave for having no controllable turn, on the
/// `control_unavailable` that accompanies a `control: null`.
pub const REPORTED_NO_CONTROL: &str = "harness `qwen` has no out-of-band turn control";
/// What the sibling answered when the note could not reach a running turn. Its
/// words, not this repository's: `oneagentgraph` publishes the reason on the
/// `turn-interrupted` it emits for every interrupt, delivered or not.
pub const NO_CONTROL_REASON: &str =
    "the member's run has no out-of-band turn control to serve the request";
/// The note the planner delivered into a turn that was already running.
pub const LIVE_NOTE: &str = "document the read API's control field too";
/// The note the planner could only leave for the next dispatch.
pub const DEFERRED_NOTE: &str = "measure the cold start too";
/// The note the *monitor* left, under its own narrower op allowlist. Its author
/// is what tells an observer's self-applied fix from the planner's decision.
pub const MONITOR_NOTE: &str = "the benchmark node has been quiet for a while";
/// A note still owed to a node's next dispatch. A `context` note carries exactly
/// one dispatch and is consumed on delivery, so only a node that has not been
/// dispatched since still carries one.
pub const CARRIED_NOTE: &str = "the reviewer asked for a changelog entry";

/// The instant the fixture run started, as every payload renders it.
const START: &str = "2026-08-07T12:00:00.000Z";

/// One recorded run under `root`, complete and settled.
///
/// Returns the run's directory, so a test can append to its journal and watch
/// the server notice.
pub fn write(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(dir.join("channel")).expect("the run directory");
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
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");

    let plan = plan();
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    fs::write(
        dir.join("result.json"),
        pretty(&json!({
            "schema_version": 3,
            "run_id": run,
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
    .expect("the run's result");

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
    // The dispatch's own settlement, and with it the report that holds what the
    // journal cannot: the prompts, the replies, what each tool call returned, and
    // what each turn alone spent and took. Relayed through the same writer the
    // engine ingests one with, so the copy the server reads is the copy that
    // promise makes.
    settle_member(
        &dir,
        &SettledMember {
            stream: WORKER_STREAM,
            node: NODE_ID,
            member: "worker",
            at: "2026-08-07T12:00:05.500Z",
            artifact: WORKER_REPORT_ARTIFACT,
            report: &worker_report(),
        },
        Produced::Report,
    );
    settle_member(
        &dir,
        &SettledMember {
            stream: REVIEWER_STREAM,
            node: REVIEW_NODE_ID,
            member: "judge",
            at: "2026-08-07T12:00:26.000Z",
            artifact: REVIEWER_REPORT_ARTIFACT,
            report: &reviewer_report(),
        },
        Produced::Report,
    );
    dir
}

/// The plan the run executed.
fn plan() -> Value {
    json!({
        "schema_version": 2,
        "goal": { "text": "serve the read contract" },
        "name": "contract",
        "concurrency": 4,
        "tasks": [
            {
                "id": NODE_ID,
                "persona": "worker",
                "task": "## What\nLand the wire contract.",
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
    let at_node = json!({ "run_id": run, "node": NODE_ID });
    // The labels every record of that node's dispatch carries, session included.
    let at_member = json!({
        "run_id": run,
        "node": NODE_ID,
        "member": "worker",
        "persona": "worker",
        "session": CONVERSATION_ID,
    });
    // And the other side of the pair: a member the graph runs as the judge
    // transport, which is what tells a judge chain's failure from an agent's.
    let at_reviewer = json!({
        "run_id": run,
        "node": REVIEW_NODE_ID,
        "member": "judge",
        "persona": "judge",
        "session": REVIEW_CONVERSATION_ID,
    });
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
        // Every dependency of this node has settled, so it may dispatch now —
        // which under the continuous engine is the moment a node starts, and
        // there is no batch it waited for.
        .emit(
            "2026-08-07T12:00:01.000Z",
            "pipeline",
            "node-ready",
            at_node.clone(),
            json!({}),
        )
        .emit(
            "2026-08-07T12:00:02.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": NODE_ID, "persona": "worker" }),
            json!({ "persona": "worker" }),
        )
        // Two turns, each opened by the producer's own 1-based number and each
        // followed by the summaries it published from inside itself. That order
        // is the producer's: `oneagentgraph` opens a turn *before* its
        // activities, which is why a summary belongs to the record before it.
        .emit(
            "2026-08-07T12:00:03.000Z",
            "agentgraph",
            "turn-started",
            at_member.clone(),
            json!({ "turn": 1 }),
        )
        .emit(
            "2026-08-07T12:00:03.500Z",
            "agentgraph",
            "turn-activity",
            at_member.clone(),
            json!({
                "kind": "tool_call",
                "name": "Read",
                "detail": "src/api.rs",
                "truncated": false,
            }),
        )
        .emit(
            "2026-08-07T12:00:04.000Z",
            "agentgraph",
            "turn-started",
            at_member.clone(),
            json!({ "turn": 2 }),
        )
        .emit(
            "2026-08-07T12:00:04.500Z",
            "agentgraph",
            "turn-activity",
            at_member.clone(),
            json!({
                "kind": "tool_call",
                "name": "Bash",
                "detail": "just gate",
                "truncated": false,
            }),
        )
        // What the *dispatch* consumed, which is what a `turn-completed` carries:
        // that library copies the settling member's usage verbatim out of its
        // onejudge report, so this is the report's own total over both sides and
        // is spelled the way that document spells it.
        .emit(
            "2026-08-07T12:00:05.000Z",
            "agentgraph",
            "turn-completed",
            at_member.clone(),
            json!({
                "usage": {
                    "input_tokens": 159_434,
                    "output_tokens": 1_564,
                    "cache_read_tokens": 187_430,
                    "cache_write_tokens": 712,
                    "cost_usd": 50.72,
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
        // The dependent node became ready the instant the node above settled
        // `done`: settlement triggers the frontier immediately, with nothing
        // between the two but the reconcile pass that observed it.
        .emit(
            "2026-08-07T12:00:20.500Z",
            "pipeline",
            "node-ready",
            json!({ "run_id": run, "node": REVIEW_NODE_ID }),
            json!({}),
        )
        .emit(
            "2026-08-07T12:00:21.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": REVIEW_NODE_ID, "persona": "judge" }),
            json!({ "persona": "judge" }),
        )
        // The other side of the pair: a member the graph runs as the judge
        // transport, which is what tells a judge chain's failure from an
        // agent chain's.
        .emit(
            "2026-08-07T12:00:22.000Z",
            "agentgraph",
            "turn-started",
            at_reviewer.clone(),
            json!({ "turn": 1 }),
        )
        .emit(
            "2026-08-07T12:00:25.000Z",
            "agentgraph",
            "turn-completed",
            at_reviewer.clone(),
            json!({
                "usage": {
                    "input_tokens": 400,
                    "output_tokens": 90,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "cost_usd": 0.11,
                },
            }),
        )
        // The last node settles and the graph is complete. Nothing follows it:
        // there is no round to close, and the run's own result is the document
        // the driver rewrites as it closes out.
        .emit(
            "2026-08-07T12:00:30.000Z",
            "pipeline",
            "node-settled",
            json!({ "run_id": run, "node": REVIEW_NODE_ID }),
            json!({ "status": "done", "outcome": "approved" }),
        );
    journal.text()
}

/// Append one event to a run's journal, the way the running loop does.
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
        "labels": { "run_id": dir.file_name().and_then(|n| n.to_str()) },
        "payload": payload,
        "artifacts": [],
    });
    fs::write(&journal, format!("{existing}{line}\n")).expect("append to the journal");
}

/// Append one event a *sibling* relayed, with labels of its own.
///
/// [`append`] writes this crate's own kind at the run's level, which is all a
/// live run's own progress needs. A relayed record is stamped with the node
/// and the member the producing library named, and a journey about what this
/// crate makes of one has to be able to write exactly that.
pub fn append_relayed(dir: &Path, source: &str, kind: &str, labels: Value, payload: Value) {
    let journal = dir.join("events.jsonl");
    let existing = fs::read_to_string(&journal).unwrap_or_default();
    let seq = existing.lines().count();
    let line = json!({
        "v": 1,
        "ts": "2026-08-07T12:01:00.000Z",
        "stream": "a-recording-host-4243",
        "seq": seq,
        "source": source,
        "kind": kind,
        "labels": labels,
        "payload": payload,
        "artifacts": [],
    });
    fs::write(&journal, format!("{existing}{line}\n")).expect("append to the journal");
}

/// One member's settlement, as the producing library relays it.
///
/// The stream is deliberately a parameter and deliberately unconstrained: it is
/// the producing process's own id, the envelope promises nothing about its
/// characters, and the name this run keeps the report under is what
/// `RunPaths::report_for` makes of it. A journey that only ever settled a member
/// on a stream that survives that name unchanged would prove the two sides agree
/// on half the streams there are.
pub struct SettledMember<'a> {
    /// The producing process's own stream id.
    pub stream: &'a str,
    /// The node whose dispatch it settled.
    pub node: &'a str,
    /// The member that settled. Named rather than assumed, because the session a
    /// settlement's report belongs to is the stream and *this* — a settlement
    /// carries no `session` label, and `{stream}.{member}` is how `oneagentgraph`
    /// mints one. It stands for the persona too: every member in these fixtures
    /// runs under a persona of its own name.
    pub member: &'a str,
    /// When it settled, so a settlement merges where it happened rather than
    /// after the node that settled because of it.
    pub at: &'a str,
    /// The artifact id the producer recorded for the report it stored.
    pub artifact: &'a str,
    /// The report that library wrote.
    pub report: &'a str,
}

impl SettledMember<'_> {
    /// The persona the member ran under, which in these fixtures is its own name.
    fn persona(&self) -> &str {
        self.member
    }
}

/// What the producing library left at the path its settlement names.
pub enum Produced {
    /// The report itself: a plain file under that library's own report file
    /// name, which is what [`report::retain`] accepts.
    Report,
    /// A symlink standing where the report should be. `retain` refuses it
    /// without following — a path that names one file and delivers another — so
    /// the run keeps no copy, and the settlement still names an artifact.
    SymlinkToReport,
}

/// Relay a settled member into a run exactly as the engine ingests one: the
/// envelope is appended to the journal, and the report it names is handed to
/// `onepipeline::report::retain`.
///
/// `retain` is the published writer and `RunPaths::report_for` is the published
/// name, so a store built this way is built by the same promise the server reads
/// it back through — and nothing here spells a report file name.
pub fn settle_member(dir: &Path, member: &SettledMember, produced: Produced) {
    // The producing library's own scratch, outside the run. Gone when this
    // returns: what the run keeps is the copy `retain` makes below, and every
    // reader opens only that.
    let scratch = tempfile::tempdir().expect("the producing library's scratch");
    let written = scratch.path().join(report::ACCEPTED_REPORT_FILE);
    let named = match produced {
        Produced::Report => {
            fs::write(&written, member.report).expect("the member's own report");
            written
        }
        Produced::SymlinkToReport => {
            let elsewhere = scratch.path().join("elsewhere.json");
            fs::write(&elsewhere, member.report).expect("the document behind the link");
            symlink(&elsewhere, &written);
            written
        }
    };
    let journal = dir.join("events.jsonl");
    let existing = fs::read_to_string(&journal).unwrap_or_default();
    // Monotonic per stream, which is what the envelope promises and what a
    // consumer detects loss through — not the file's line count, which counts
    // every other producer's records too.
    let seq = existing
        .lines()
        .filter_map(|line| serde_json::from_str::<Envelope>(line).ok())
        .filter(|event| event.stream == member.stream)
        .count();
    let line = json!({
        "v": 1,
        "ts": member.at,
        "stream": member.stream,
        "seq": seq,
        "source": "agentgraph",
        "kind": report::MEMBER_SETTLED,
        "labels": {
            "run_id": dir.file_name().and_then(|run| run.to_str()),
            "node": member.node,
            "member": member.member,
            "persona": member.persona(),
        },
        "payload": {
            "completed": true,
            "verdict": [],
            "completion_reason": Value::Null,
            "report_path": named,
        },
        "artifacts": [{
            "id": member.artifact,
            "kind": "report",
            "bytes": member.report.len(),
        }],
    });
    let settlement: Envelope = serde_json::from_value(line.clone()).expect("the settled envelope");
    fs::write(&journal, format!("{existing}{line}\n")).expect("append to the journal");
    report::retain(&paths_of(dir), &settlement);
}

/// The pointer at one oneharness invocation's conversation, as `oneagentgraph`
/// publishes one.
///
/// The three path fields are the three the producer publishes rather than one
/// path, and they are `&str` on purpose: a journey has to be able to name a
/// component the producer would never write, because refusing one rather than
/// joining it is the whole of what stands between a read API and an arbitrary
/// file on its host.
pub struct HarnessSession<'a> {
    /// The producing process's own stream id.
    pub stream: &'a str,
    /// The node whose dispatch made the invocation.
    pub node: &'a str,
    /// The member that made it.
    pub member: &'a str,
    /// The store the session file is in. `None` is a producer that named none,
    /// which the reader answers with oneharness's own default store.
    pub history_dir: Option<&'a Path>,
    /// The project directory inside that store.
    pub history_project: &'a str,
    /// The session file inside that project, by stem.
    pub history_session: &'a str,
    /// The record inside that file, which is also the artifact's id.
    pub history_id: &'a str,
    /// The session file's size, which is what the producer records.
    pub bytes: u64,
}

/// Relay one `oneharness-session` into a run exactly as `oneagentgraph`
/// publishes one: the pointer as the payload, and one artifact naming the
/// history record.
///
/// Nothing is copied into the run. The session's bytes stay in the store
/// [`crate::harness_history`] wrote them into, which is what the resolution
/// under test has to reach — and the envelope carries **no `session` label**,
/// because the producer stamps that on the four turn kinds and on nothing else,
/// including this one.
pub fn relay_harness_session(dir: &Path, session: &HarnessSession) {
    let mut payload = Map::new();
    payload.insert("role".into(), json!("agent"));
    payload.insert("turn".into(), json!(1));
    payload.insert("identity".into(), json!("claude-code:alternate"));
    payload.insert(
        "session_id".into(),
        json!("54e7ad34-ce6d-4979-8b4d-531b88026e15"),
    );
    payload.insert("history_id".into(), json!(session.history_id));
    if let Some(store) = session.history_dir {
        payload.insert("history_dir".into(), json!(store));
    }
    payload.insert("history_project".into(), json!(session.history_project));
    payload.insert("history_session".into(), json!(session.history_session));
    append_produced(
        dir,
        session.stream,
        json!({
            "v": 1,
            "ts": "2026-08-07T12:01:10.000Z",
            "stream": session.stream,
            "seq": Value::Null,
            "source": "agentgraph",
            "kind": "oneharness-session",
            "labels": {
                "run_id": dir.file_name().and_then(|run| run.to_str()),
                "node": session.node,
                "member": session.member,
                "persona": "worker",
            },
            "payload": Value::Object(payload),
            "artifacts": [{
                "id": session.history_id,
                "kind": "oneharness_session",
                "bytes": session.bytes,
            }],
        }),
    );
}

/// Append one already-shaped record to a run's journal, numbering it as its own
/// stream's next sequence.
///
/// Monotonic per stream, which is what the envelope promises and what a consumer
/// detects loss through — not the file's line count, which counts every other
/// producer's records too.
fn append_produced(dir: &Path, stream: &str, mut line: Value) {
    let journal = dir.join("events.jsonl");
    let existing = fs::read_to_string(&journal).unwrap_or_default();
    let seq = existing
        .lines()
        .filter_map(|line| serde_json::from_str::<Envelope>(line).ok())
        .filter(|event| event.stream == stream)
        .count();
    line["seq"] = json!(seq);
    // Parsed back through the SDK's own envelope before it is written: a record
    // this fixture shaped wrongly fails here rather than being served as one the
    // producing library never wrote.
    let _: Envelope = serde_json::from_value(line.clone()).expect("the relayed envelope");
    fs::write(&journal, format!("{existing}{line}\n")).expect("append to the journal");
}

/// The link `Produced::SymlinkToReport` leaves where the report should be.
#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("the link the producer left");
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link).expect("the link the producer left");
}

/// A run still being driven: a node that failed and was replaced, a lifecycle
/// node with steps, a human action nobody has taken, a node gated by it, a
/// decision that held a subtree back and was cleared, and a surface the planner
/// has not read.
///
/// It is the other half of what the payloads have to describe — everything the
/// settled run above cannot show, because it is finished and everything in it
/// went well. Under rounds this was "a second round, still open"; the engine has
/// no such thing, and what makes this run live is that nodes are in flight.
pub fn write_live(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
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
            "heartbeat_interval": 1_800,
            "adoptions": 1,
        })),
    )
    .expect("the launch record");

    let plan = live_plan();
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    // Deliberately no `result.json`: the SDK rewrites that document whenever a
    // driver closes out, and this run is still being driven. What a reader is told
    // about it comes from the fold alone.

    // Bigger than one response may carry, so the tail is a tail.
    fs::write(
        dir.join("artifacts").join("artifact-long-log"),
        format!("{}TAIL\n", "x".repeat(70_000)),
    )
    .expect("the long artifact");

    // Where the settled member left its report: the producing library's own
    // scratch, outside this run, under that library's own report file name. It
    // is what the settlement names and what the engine copies from, and it is
    // gone by the time anything reads this run — the copy `retain` made below is
    // the only file any reader opens.
    let produced = tempfile::tempdir().expect("the producing library's scratch");
    let report_path = produced.path().join(report::ACCEPTED_REPORT_FILE);
    fs::write(&report_path, reported_control_report()).expect("the member's own report");

    let journal = live_journal(run, &plan, &report_path);
    fs::write(dir.join("events.jsonl"), &journal).expect("the journal");
    retain_reported_control(&dir, &journal);
    // The lint member settled with a report of its own, which is the only place
    // the time it spent in a harness is recorded: a `turn-completed` carries the
    // dispatch's usage and no interval at all.
    settle_member(
        &dir,
        &SettledMember {
            stream: LINT_STREAM,
            node: SHIP_NODE_ID,
            member: "llmlint",
            at: "2026-08-07T12:00:28.960Z",
            artifact: LINT_REPORT_ARTIFACT,
            report: &lint_report(),
        },
        Produced::Report,
    );
    dir
}

/// The run's paths, as the SDK's own nameable type.
///
/// A fixture directory is `<root>/<run>`, which is what `RunPaths::under` takes,
/// so a journey holds the same handle the engine writes a run through and the
/// server reads one back through.
fn paths_of(dir: &Path) -> RunPaths {
    RunPaths::under(
        dir.parent()
            .expect("a run directory sits under a runs root"),
        dir.file_name()
            .and_then(|run| run.to_str())
            .expect("the run id names the directory"),
    )
}

/// The settlement one node's member left behind, as the SDK's own envelope.
///
/// Read back off the journal rather than kept beside it: the report's name is
/// derived from the settlement — its stream and its sequence — so the settlement
/// is the whole of what locates it, here as in the server.
fn settlement_of(journal: &str, node: &str) -> Envelope {
    journal
        .lines()
        .filter_map(|line| serde_json::from_str::<Envelope>(line).ok())
        .find(|event| {
            event.kind.0 == report::MEMBER_SETTLED && event.labels.node.as_deref() == Some(node)
        })
        .expect("the settlement that stored a report")
}

/// Where the run's own copy of the reported node's report is, from the SDK's own
/// `RunPaths::report_for` and from nothing else.
///
/// Exposed so a journey can put something else there — a document too large,
/// bytes that are not a report — and drive what this crate makes of a copy it
/// cannot read. Nothing in this repository spells that name: the sanitiser
/// behind it is `onepipeline`'s, and one implementation of it is the point.
pub fn retained_report(dir: &Path) -> PathBuf {
    let journal = fs::read_to_string(dir.join("events.jsonl")).expect("the journal");
    let settlement = settlement_of(&journal, REPORTED_NODE_ID);
    paths_of(dir).report_for(&settlement.stream, settlement.seq)
}

/// The onejudge report that settlement named, copied into the run's own storage
/// exactly as the engine copies one: through `onepipeline::report::retain`.
///
/// Retention and resolution are one published promise, so the fixture store is
/// built by the writer the server reads back through rather than by a test
/// author's belief about where the file goes. `retain` is called at the moment
/// the engine calls it — as the envelope is ingested, when the path it names
/// still carries the producing process's authority — and it derives the copy's
/// name itself.
fn retain_reported_control(dir: &Path, journal: &str) {
    report::retain(&paths_of(dir), &settlement_of(journal, REPORTED_NODE_ID));
    assert!(
        retained_report(dir).is_file(),
        "the published writer refused the fixture's own report, so no reader could serve it"
    );
}

/// The onejudge report the reported node's member settled with.
///
/// The whole of what this crate reads out of one: `control: null` is the
/// contract's no-controllable-turn case, and `control_unavailable` says why the
/// ask could not be honoured.
pub fn reported_control_report() -> String {
    pretty(&json!({
        "schema_version": 8,
        "control": Value::Null,
        "control_unavailable": REPORTED_NO_CONTROL,
        "verdicts": [],
        "usage": {},
    }))
}

/// The graph the live run is converging toward, with its committed edits applied.
fn live_plan() -> Value {
    json!({
        "schema_version": 2,
        "goal": { "text": "get it shipped" },
        "name": "ship",
        "concurrency": 4,
        "tasks": [
            {
                "id": SHIP_NODE_ID,
                "persona": "pr-author",
                "task": "## What\nShip it.",
                "context": "the reviewer asked for a changelog entry",
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
            // A planner note nothing has delivered yet: this node is blocked
            // behind a human action, so the note is still owed to its next
            // dispatch and still reaches a reader. The note on `ship` above was
            // consumed when `ship` was dispatched, which is the other half.
            {
                "id": ANNOUNCE_NODE_ID,
                "persona": "check-in",
                "task": "## What\nAnnounce it.",
                "context": CARRIED_NOTE,
                "deps": [SIGNOFF_NODE_ID],
            },
            // The two nodes still working, and the whole reason a planner asks
            // whether a node can be corrected: one of them
            // took the correction into the turn it was already running, and the
            // other is on a harness with no lever to offer.
            {
                "id": REDIRECTED_NODE_ID,
                "persona": "worker",
                "task": "## What\nWrite the docs.",
            },
            {
                "id": UNCONTROLLED_NODE_ID,
                "persona": "worker",
                "task": "## What\nMeasure it.",
            },
            {
                "id": REPORTED_NODE_ID,
                "persona": "worker",
                "task": "## What\nProfile it.",
            },
        ],
    })
}

/// One continuous stream of events, with work still in flight at the end of it.
fn live_journal(run: &str, plan: &Value, report_path: &Path) -> String {
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
                    json!([{ "id": "artifact-long-log", "kind": "log", "bytes": 70_005 }])
                } else {
                    json!([])
                },
            })
            .to_string(),
        );
        seq += 1;
    };

    // One `run-started`, carrying the graph the run is converging toward. Under
    // rounds a second plan arrived with the second `round-started`; there is no
    // such record, and a live edit is what changes the graph now.
    emit(
        START,
        "pipeline",
        "run-started",
        json!({ "run_id": run }),
        json!({ "plan": plan }),
    );
    // The run's own driving session, recorded at no node: what starts the run
    // rather than any of the work in it.
    emit(
        "2026-08-07T12:00:05.000Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
            "persona": "orchestrator",
            "session": DRIVING_CONVERSATION_ID,
        }),
        json!({ "message": "driving the run", "model": "a-model" }),
    );
    // The node that is re-dispatched further down. Its member settled here, and
    // the onejudge report that settlement stored is the authoritative answer
    // about *that* dispatch's turn control: `control: null`, with
    // `control_unavailable`'s own words beside it.
    emit(
        "2026-08-07T12:00:06.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": REPORTED_NODE_ID, "persona": "worker" }),
        json!({ "persona": "worker" }),
    );
    emit(
        "2026-08-07T12:00:07.000Z",
        "agentgraph",
        "member-settled",
        json!({
            "run_id": run,
            "node": REPORTED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": REPORTED_CONVERSATION_ID,
        }),
        // The payload `oneagentgraph` writes, `report_path` included: this crate
        // never opens that path — `onepipeline` copied the document into the run's
        // own storage at ingest, and the copy is what is read.
        json!({
            "completed": false,
            "verdict": [],
            "completion_reason": Value::Null,
            "report_path": report_path,
        }),
    );
    // The two texts a failure records are written by different parts of the
    // executor and mean different things: the lifecycle's own prose, and what the
    // dispatch reported. Both ride the settlement envelope, which is the only
    // account of them — the SDK's fold keeps a node's status, outcome and branch
    // and none of the prose beside them.
    emit(
        "2026-08-07T12:00:08.000Z",
        "pipeline",
        "node-settled",
        json!({ "run_id": run, "node": REPORTED_NODE_ID }),
        json!({
            "status": "failed",
            "outcome": "rejected",
            "detail": "the profile did not finish",
            "error": "profile exited non-zero",
            "exit_code": 2,
            "ok": false,
        }),
    );
    // A blocking surface the planner has been sent but has not read. This is the
    // one thing that pauses anything in a continuous engine, and it pauses only
    // the subtree that depends on it — so it is recorded as a decision that began
    // holding dependents back, named by the surface it is.
    emit(
        "2026-08-07T12:00:10.000Z",
        "pipeline",
        "planner-surface-queued",
        json!({ "run_id": run }),
        json!({ "kind": "decision", "message": "retry or park?", "blocking": true }),
    );
    emit(
        "2026-08-07T12:00:10.500Z",
        "pipeline",
        "decision-pending",
        json!({ "run_id": run, "node": "surface:retry-or-park" }),
        json!({
            "reference": "surface:retry-or-park",
            "kind": "decision",
            "unblocks": [SHIP_NODE_ID],
        }),
    );
    emit(
        "2026-08-07T12:00:11.000Z",
        "pipeline",
        "planner-surfaced",
        json!({ "run_id": run }),
        json!({ "blocking": true }),
    );
    emit(
        "2026-08-07T12:00:25.000Z",
        "pipeline",
        "planner-replied",
        json!({ "run_id": run }),
        json!({}),
    );
    // Answered, so the subtree it held is released and the loop resumes it —
    // inside the running loop, with no external driver action.
    emit(
        "2026-08-07T12:00:25.500Z",
        "pipeline",
        "decision-cleared",
        json!({ "run_id": run, "node": "surface:retry-or-park" }),
        json!({
            "reference": "surface:retry-or-park",
            "kind": "decision",
            "released": [SHIP_NODE_ID],
        }),
    );
    // The reply's own edit, attributed to the author that submitted it: a
    // planner may issue every op, and a monitor a narrower set, so who asked for
    // a change is a fact about the change.
    emit(
        "2026-08-07T12:00:25.700Z",
        "pipeline",
        "edit-committed",
        json!({ "run_id": run }),
        json!({
            "author": "planner",
            "command": { "op": "retry", "id": REPORTED_NODE_ID },
            "operations": [{ "kind": "node-added", "node": REPORTED_NODE_ID }],
        }),
    );
    emit(
        "2026-08-07T12:00:26.000Z",
        "pipeline",
        "node-ready",
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
        json!({}),
    );
    emit(
        "2026-08-07T12:00:26.500Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
            "persona": "orchestrator",
            "session": DRIVING_CONVERSATION_ID,
        }),
        json!({ "message": "reconciling the frontier", "model": "a-model" }),
    );
    emit(
        "2026-08-07T12:00:27.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": SHIP_NODE_ID, "persona": "pr-author" }),
        json!({ "persona": "pr-author" }),
    );
    emit(
        "2026-08-07T12:00:28.000Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
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
            "node": SHIP_NODE_ID,
            "step": "build",
            "member": "worker",
            "persona": "pr-author",
            "session": LIVE_CONVERSATION_ID,
        }),
        json!({
            "usage": {
                "input_tokens": 900,
                "output_tokens": 210,
                "cache_read_tokens": 300,
                "cache_write_tokens": 60,
                "cost_usd": 0.19,
            },
        }),
    );
    // The lint tier the graph runs as a member of its own: the same semantic
    // role as the work it is checking, told apart from it by its transport.
    emit(
        "2026-08-07T12:00:28.900Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
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
            "node": SHIP_NODE_ID,
            "member": "llmlint",
            "persona": "pr-author",
            "session": LINT_CONVERSATION_ID,
        }),
        json!({
            "usage": {
                "input_tokens": 120,
                "output_tokens": 40,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "cost_usd": 0.03,
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
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
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
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
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
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
        json!({ "branch": "feature/ship", "remote": "origin", "accepted": true }),
    );
    emit(
        "2026-08-07T12:00:38.000Z",
        "vcs",
        "change-opened",
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
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
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
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
        json!({ "run_id": run, "node": SHIP_NODE_ID }),
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
        json!({ "run_id": run, "node": SIGNOFF_NODE_ID }),
        json!({ "status": "waiting" }),
    );
    // The second form a decision point takes, and the one still outstanding: a
    // ready human action nobody has attested. It holds only what depends on it,
    // which is why `announce` is blocked while everything else keeps running.
    emit(
        "2026-08-07T12:00:41.500Z",
        "pipeline",
        "decision-pending",
        json!({ "run_id": run, "node": SIGNOFF_NODE_ID }),
        json!({
            "reference": SIGNOFF_NODE_ID,
            "kind": "human-action",
            "unblocks": [ANNOUNCE_NODE_ID],
        }),
    );

    // Two nodes still working, and the planner correcting both of them. The
    // records are the ones a real run writes: `oneagentgraph` relays a
    // `turn-interrupted` for every interrupt the reconciler pulls — delivered or
    // not — and `onepipeline` records where the note actually went as the
    // `delivery` on the `context-added` operation its `edit-committed` compiled.
    emit(
        "2026-08-07T12:00:42.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": REDIRECTED_NODE_ID, "persona": "worker" }),
        json!({ "persona": "worker" }),
    );
    emit(
        "2026-08-07T12:00:43.000Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
            "node": REDIRECTED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": REDIRECTED_CONVERSATION_ID,
        }),
        json!({ "turn": 1 }),
    );
    emit(
        "2026-08-07T12:00:44.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": UNCONTROLLED_NODE_ID, "persona": "worker" }),
        json!({ "persona": "worker" }),
    );
    emit(
        "2026-08-07T12:00:45.000Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
            "node": UNCONTROLLED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": UNCONTROLLED_CONVERSATION_ID,
        }),
        json!({ "turn": 1 }),
    );
    // The correction that landed: the running turn took it, so the note is not
    // also owed to the node's next dispatch.
    emit(
        "2026-08-07T12:00:50.000Z",
        "agentgraph",
        "turn-interrupted",
        json!({
            "run_id": run,
            "node": REDIRECTED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": REDIRECTED_CONVERSATION_ID,
        }),
        json!({ "member": "worker", "delivered": true, "input_bytes": LIVE_NOTE.len() }),
    );
    emit(
        "2026-08-07T12:00:50.100Z",
        "pipeline",
        "edit-committed",
        json!({ "run_id": run }),
        json!({
            // `deliver` is absent because it was `auto`, which is what the
            // sibling's own `Command` omits: an edit that says nothing about
            // delivery is exactly the edit the live-edit table always described.
            "command": { "op": "context", "id": REDIRECTED_NODE_ID, "note": LIVE_NOTE },
            "operations": [{
                "kind": "context-added",
                "node": REDIRECTED_NODE_ID,
                "note": LIVE_NOTE,
                "delivery": "live",
            }],
        }),
    );
    // The same lever pulled at a node whose harness has none. The verb answers
    // with the fact rather than a failure, and the note rides the next dispatch.
    emit(
        "2026-08-07T12:00:51.000Z",
        "agentgraph",
        "turn-interrupted",
        json!({
            "run_id": run,
            "node": UNCONTROLLED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": UNCONTROLLED_CONVERSATION_ID,
        }),
        json!({
            "member": "worker",
            "delivered": false,
            "input_bytes": DEFERRED_NOTE.len(),
            "reason": NO_CONTROL_REASON,
        }),
    );
    emit(
        "2026-08-07T12:00:51.100Z",
        "pipeline",
        "edit-committed",
        json!({ "run_id": run }),
        json!({
            "command": { "op": "context", "id": UNCONTROLLED_NODE_ID, "note": DEFERRED_NOTE },
            "operations": [{
                "kind": "context-added",
                "node": UNCONTROLLED_NODE_ID,
                "note": DEFERRED_NOTE,
                "delivery": "deferred",
            }],
        }),
    );
    // The third in-flight node, and the trap: its *earlier* dispatch settled with
    // a onejudge report naming no controllable turn, and this is a *fresh* turn
    // in a *re-asked* dispatch. `provider.control` is asked for per run and the
    // provider's outcome is reset for the next, so the old report says nothing
    // about this turn — and the reading must not borrow it. Under rounds the two
    // dispatches were told apart by their round labels; here they are told apart
    // by nothing but their order, which is exactly what makes this worth pinning.
    emit(
        "2026-08-07T12:00:44.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": REPORTED_NODE_ID, "persona": "worker" }),
        json!({ "persona": "worker" }),
    );
    emit(
        "2026-08-07T12:00:45.000Z",
        "agentgraph",
        "turn-started",
        json!({
            "run_id": run,
            "node": REPORTED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": REPORTED_CONVERSATION_ID,
        }),
        json!({ "turn": 1 }),
    );
    // What the redirected turn did next, which is the whole reason the moment
    // above has to be readable: the worker changed task mid-turn.
    emit(
        "2026-08-07T12:00:52.000Z",
        "agentgraph",
        "turn-activity",
        json!({
            "run_id": run,
            "node": REDIRECTED_NODE_ID,
            "member": "worker",
            "persona": "worker",
            "session": REDIRECTED_CONVERSATION_ID,
        }),
        json!({
            "kind": "tool_use",
            "name": "Edit",
            "detail": "docs/contract.md",
            "truncated": false,
        }),
    );
    // An edit the *monitor* self-applied. Its op allowlist is narrower than the
    // planner's, and a reader that could not tell the two apart would be reading
    // an observer's fix as the planner's own decision.
    emit(
        "2026-08-07T12:00:53.000Z",
        "pipeline",
        "edit-committed",
        json!({ "run_id": run }),
        json!({
            "author": "monitor",
            "command": { "op": "context", "id": UNCONTROLLED_NODE_ID, "note": MONITOR_NOTE },
            "operations": [{
                "kind": "context-added",
                "node": UNCONTROLLED_NODE_ID,
                "note": MONITOR_NOTE,
                "delivery": "deferred",
            }],
        }),
    );
    format!("{}\n", lines.join("\n"))
}

/// A run that recorded its launch and nothing since — how a just-started run
/// reads on disk: the one shape with no work at all.
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

/// Define a named filter profile on a run's launch record.
///
/// `onepipeline start --set filters.NAME=SPEC` forwards the override opaquely to
/// the dag-scope launch and the SDK retains it verbatim, which is where a
/// run-specific decision this crate can read lives. Written by rewriting the
/// record the same way a relaunch would, so what the server reads is a launch
/// record and not a fixture shape of its own.
pub fn define_filter_profile(dir: &Path, name: &str, spec: &str) {
    let path = dir.join("launch.json");
    let mut record: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("the launch record"))
            .expect("the launch record parses");
    let sets = record
        .as_object_mut()
        .expect("a mapping")
        .entry("dag_sets")
        .or_insert_with(|| json!([]));
    sets.as_array_mut()
        .expect("the retained overrides")
        .push(json!(format!("filters.{name}={spec}")));
    fs::write(&path, pretty(&record)).expect("the launch record");
}

fn pretty(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).expect("serialize")
    )
}

/// The run id of the stopped-mid-flight fixture below.
pub const STOPPED_RUN_ID: &str = "run-20260807-5c4b3a";

/// A run whose driver was stopped with a node still dispatched, and which never
/// wrote a result.
///
/// The one shape where a recorded account and the run's fold could disagree: no
/// driver closed out, so a reader that only ever consults `result.json` finds
/// nothing, while the fold still knows exactly what the run got to.
pub fn write_stopped_mid_flight(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(&dir).expect("the run directory");
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
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    let plan = json!({
        "schema_version": 2,
        "name": "stopped",
        "concurrency": 1,
        "tasks": [
            { "id": NODE_ID, "persona": "worker", "task": "## What\nStart it." },
        ],
    });
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    let lines = [
        json!({
            "v": 1, "ts": START, "stream": "a-recording-host-4250", "seq": 0,
            "source": "pipeline", "kind": "run-started",
            "labels": { "run_id": run }, "payload": { "plan": plan }, "artifacts": [],
        }),
        json!({
            "v": 1, "ts": "2026-08-07T12:00:01.000Z", "stream": "a-recording-host-4250",
            "seq": 1, "source": "pipeline", "kind": "node-ready",
            "labels": { "run_id": run, "node": NODE_ID }, "payload": {}, "artifacts": [],
        }),
        json!({
            "v": 1, "ts": "2026-08-07T12:00:02.000Z", "stream": "a-recording-host-4250",
            "seq": 2, "source": "pipeline", "kind": "node-dispatched",
            "labels": { "run_id": run, "node": NODE_ID, "persona": "worker" },
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

/// A run whose driver closed out and whose journal never existed.
///
/// This is what a run predating the journal looks like on an operator's machine,
/// permanently: there is nothing to fold, so the run's own recorded result is the
/// only account of it — and that result holds words no journal settlement can
/// carry, including a status outside the vocabulary a client switches on and a
/// failure with an outcome but no prose.
pub fn write_recorded_only(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(&dir).expect("the run directory");
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
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    let plan = json!({
        "schema_version": 2,
        "name": "recorded",
        "concurrency": 1,
        "tasks": [
            { "id": NODE_ID, "persona": "worker", "task": "## What\nConvert it." },
            { "id": REVIEW_NODE_ID, "persona": "judge", "task": "## What\nCheck it." },
        ],
    });
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    fs::write(
        dir.join("result.json"),
        pretty(&json!({
            "schema_version": 3,
            "run_id": run,
            "state": "failed",
            "ok": false,
            "nodes": [
                // A word the served vocabulary does not hold.
                { "id": NODE_ID, "status": "improvised" },
                // A failure and everything the document recorded about it. The
                // two texts are written by different parts of the executor and
                // mean different things — the lifecycle's own prose, and what the
                // dispatch reported — and with no journal to fold, this document
                // is the only account of either.
                {
                    "id": REVIEW_NODE_ID,
                    "status": "failed",
                    "outcome": "gate-failed",
                    "detail": "the reviewer asked for a changelog entry",
                    "error": "review exited non-zero",
                    "exit_code": 2,
                    "ok": false,
                },
            ],
        })),
    )
    .expect("the run's result");
    fs::write(dir.join("events.jsonl"), "").expect("the empty journal");
    dir
}

/// The run id of the preserved-work fixture below.
pub const PRESERVED_RUN_ID: &str = "run-20260807-7e6d5c";
/// The commit that run's work was preserved on, rather than published as.
pub const PRESERVED_SHA: &str = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

/// A run whose publication never landed: the base moved under it, the bounded
/// resolve did not converge, and the work was preserved on its branch instead.
///
/// The other half of what `onevcs` records about a publication — everything the
/// merged fixture above cannot show, because that one went through.
pub fn write_preserved(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(&dir).expect("the run directory");
    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            "launcher": "claude-code",
            "session": SESSION,
            "pid": 4251,
            "host": "a-recording-host",
            "started_at": START,
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    let plan = json!({
        "schema_version": 2,
        "name": "preserved",
        "concurrency": 1,
        "tasks": [
            { "id": NODE_ID, "persona": "worker", "task": "## What\nLand it." },
        ],
    });
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    let at_node = json!({ "run_id": run, "node": NODE_ID });
    let mut journal = Journal::new("a-recording-host-4251");
    journal
        .emit(
            START,
            "pipeline",
            "run-started",
            json!({ "run_id": run }),
            json!({ "plan": plan }),
        )
        .emit(
            "2026-08-07T12:00:01.000Z",
            "pipeline",
            "node-ready",
            json!({ "run_id": run, "node": NODE_ID }),
            json!({}),
        )
        .emit(
            "2026-08-07T12:00:02.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": NODE_ID, "persona": "worker" }),
            json!({ "persona": "worker" }),
        )
        .emit(
            "2026-08-07T12:00:03.000Z",
            "vcs",
            "session-opened",
            at_node.clone(),
            json!({
                "token": "a-third-vcs-session-token",
                "identity": "github.com/nickderobertis/onepipeline-ui",
                "branch": "feature/preserved",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        )
        // Work committed onto the branch that is being kept, with the provenance
        // word that library writes beside it.
        .emit(
            "2026-08-07T12:00:06.000Z",
            "vcs",
            "commit-preserved",
            at_node.clone(),
            json!({
                "branch": "feature/preserved",
                "sha": PRESERVED_SHA,
                "provenance": "agent",
            }),
        )
        // The base moved and the bounded resolve-and-requeue gave up, which is
        // how a publication ends without one.
        .emit(
            "2026-08-07T12:00:09.000Z",
            "vcs",
            "sync-conflict",
            at_node.clone(),
            json!({ "branch": "feature/preserved", "base": "main", "attempts": 3 }),
        )
        .emit(
            "2026-08-07T12:00:10.000Z",
            "pipeline",
            "node-settled",
            at_node,
            json!({
                "status": "failed",
                "outcome": "publication-failed",
                "branch": "feature/preserved",
                "detail": "the base moved under the publication",
            }),
        );
    fs::write(dir.join("events.jsonl"), journal.text()).expect("the journal");
    dir
}

/// The stream the settled run's worker member ran on, and the one its session id
/// is spelled from.
///
/// A settlement carries no `session` label; a session id is `{stream}.{member}`,
/// which is how `oneagentgraph` mints one, so this and [`CONVERSATION_ID`] have
/// to agree or nothing joins a transcript to the report that holds it.
pub const WORKER_STREAM: &str = "node-scope-1786925518098-3163646";
/// The artifact id that settlement recorded for the report it stored.
pub const WORKER_REPORT_ARTIFACT: &str = "report-node-scope-1786925518098-3163646";

/// The prompt the simulated user opened the dispatch with — the dispatch's own
/// task prose, which is what a turn's `user` is and what its persona name is not.
pub const FIRST_PROMPT: &str = "## What\nLand the wire contract.";
pub const FIRST_REPLY: &str = "Landed the route table; every route answers.";
/// The second thing it was asked, so a transcript has more than one turn to
/// attribute a cost to.
pub const SECOND_PROMPT: &str = "Run the repository's gate once, end to end.";
pub const SECOND_REPLY: &str = "The gate ran green over the finished tree.";
/// What the tool the first turn called gave back. Nothing in the journal records
/// this: `turn-activity` reports the call and never the observation.
pub const TOOL_OBSERVATION: &str = "pub fn routes() -> Router { /* … */ }";

/// The onejudge report the settled run's worker member stored, built from that
/// library's own types.
///
/// Nothing here is a stub of the report contract: these are `onejudge`'s structs
/// serialized by `onejudge`'s own derives, so a release that renamed a field
/// fails the suite that reads it rather than serving a transcript with holes.
///
/// It is shaped to hold three things the served transcript must get right. The
/// two turns cost and take **different** amounts, so serving the report's own
/// `usage` — the run total over both sides — on either of them is visible. The
/// judge's figures are larger than the agent's on turn 2, so a reading that
/// crossed the two role vocabularies would show up as a number rather than as a
/// subtlety. And `telemetry.sessions` holds a `judge` row for *both* turns and an
/// `agent` row for only the first, which is the trap: matching a turn to a row by
/// its index alone puts the judge's clock on the agent's turn.
#[must_use]
pub fn worker_report() -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, Message, PartyTelemetry, Report, SessionLink,
        Telemetry, TelemetryRole, ToolEvent, Transcript, Usage,
    };

    let call = ToolEvent {
        kind: "tool_call".into(),
        name: Some("Read".into()),
        input: Some(json!({ "file_path": "src/api.rs" })),
        output: None,
        index: 0,
    };
    let result = ToolEvent {
        kind: "tool_result".into(),
        name: None,
        input: None,
        output: Some(TOOL_OBSERVATION.into()),
        index: 1,
    };
    let gate_call = ToolEvent {
        kind: "tool_call".into(),
        name: Some("Bash".into()),
        input: Some(json!({ "command": "just gate" })),
        output: None,
        index: 0,
    };
    // A call the trace exposed no observation for, which is a different fact from
    // one that returned nothing: `output` is absent rather than empty.
    let gate_result = ToolEvent {
        kind: "tool_result".into(),
        name: None,
        input: None,
        output: None,
        index: 1,
    };
    let agent_usage = |cost| Usage {
        input_tokens: Some(376),
        output_tokens: Some(164),
        cache_read_tokens: Some(44_051),
        cache_write_tokens: Some(356),
        cost_usd: Some(cost),
    };
    let judge_usage = Usage {
        input_tokens: Some(79_341),
        output_tokens: Some(618),
        cache_read_tokens: Some(49_664),
        cache_write_tokens: None,
        cost_usd: Some(9.75),
    };
    let ran = |harness: &str, ms, usage| CandidateAttempt {
        harness: harness.to_owned(),
        harness_id: format!("{harness}:default"),
        variant: None,
        model: None,
        status: "ok".into(),
        available: true,
        ran: true,
        failure_kind: None,
        failure_kind_source: None,
        exit_code: Some(0),
        duration_ms: Some(ms),
        error: None,
        session_id: None,
        history_id: None,
        usage: Some(usage),
    };
    // The identity the chain fell through before the one that ran. It reports a
    // duration of its own, which is how long finding out took and is not the
    // turn's, so a reading that took the first candidate rather than the one that
    // ran would serve this number.
    let fell_through = CandidateAttempt {
        ran: false,
        available: false,
        status: "unavailable".into(),
        exit_code: None,
        duration_ms: Some(4_364),
        usage: None,
        ..ran("claude-code", 0, agent_usage(0.0))
    };
    let attributed = |role, turn_index, candidates| HarnessAttribution {
        role,
        turn_index,
        ran: Some("claude-code:default".into()),
        fell_through: Vec::new(),
        candidates,
        history_file: None,
    };

    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user(FIRST_PROMPT),
                Message::assistant(FIRST_REPLY).with_events(vec![call, result]),
                Message::user(SECOND_PROMPT),
                Message::assistant(SECOND_REPLY).with_events(vec![gate_call, gate_result]),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: Some("the acceptance criteria were met".into()),
        settled_reason: None,
        // The whole dispatch's total over both sides, which is what neither turn
        // spent: 29.71 + 1.51 + 9.75 + 9.75.
        usage: Some(Usage {
            input_tokens: Some(159_434),
            output_tokens: Some(1_564),
            cache_read_tokens: Some(187_430),
            cache_write_tokens: Some(712),
            cost_usd: Some(50.72),
        }),
        telemetry: Some(Telemetry {
            wall_ms: 30_000,
            agent: PartyTelemetry {
                usage: Some(agent_usage(31.22)),
                ..PartyTelemetry::default()
            },
            // The asymmetry this host really records: the judge side reports a
            // provider-measured start and the agent side does not, which is why
            // the session rows below are the judge's.
            judge: PartyTelemetry {
                model_ms: Some(18_000),
                time_to_first_token_ms: Some(900),
                usage: Some(judge_usage.clone()),
                ..PartyTelemetry::default()
            },
            orchestration_ms: 1_200,
            sessions: vec![
                SessionLink {
                    session_id: "01a01f4c-685b-75e2-8281-e8937fd20d47".into(),
                    role: TelemetryRole::Agent,
                    turn_index: 1,
                    started_at: "2026-08-07T12:00:03.000Z".into(),
                    finished_at: Some("2026-08-07T12:00:03.900Z".into()),
                    history_id: None,
                },
                SessionLink {
                    session_id: "01a01f4c-ace8-7a73-86b7-3c747c7bd78a".into(),
                    role: TelemetryRole::Judge,
                    turn_index: 1,
                    started_at: "2026-08-07T12:00:03.910Z".into(),
                    finished_at: Some("2026-08-07T12:00:03.980Z".into()),
                    history_id: None,
                },
                SessionLink {
                    session_id: "01a01f4f-6168-72d1-b946-2251794e2fce".into(),
                    role: TelemetryRole::Judge,
                    turn_index: 2,
                    started_at: "2026-08-07T12:00:04.800Z".into(),
                    finished_at: Some("2026-08-07T12:00:04.900Z".into()),
                    history_id: None,
                },
            ],
            attribution: vec![
                attributed(
                    TelemetryRole::Agent,
                    1,
                    vec![fell_through, ran("claude-code", 900, agent_usage(29.71))],
                ),
                attributed(
                    TelemetryRole::Judge,
                    1,
                    vec![ran("codex", 70, judge_usage.clone())],
                ),
                attributed(
                    TelemetryRole::Agent,
                    2,
                    vec![ran("claude-code", 100, agent_usage(1.51))],
                ),
                attributed(TelemetryRole::Judge, 2, vec![ran("codex", 60, judge_usage)]),
            ],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// The stream the review node's judge member ran on, which [`REVIEW_CONVERSATION_ID`]
/// is spelled from.
pub const REVIEWER_STREAM: &str = "node-scope-1786925518102-3163741";
/// The artifact id that settlement recorded for the report it stored.
pub const REVIEWER_REPORT_ARTIFACT: &str = "report-node-scope-1786925518102-3163741";
/// What the reviewer was asked, and what it said.
pub const REVIEW_PROMPT: &str = "## What\nReview it.";
pub const REVIEW_REPLY: &str = "The contract reads; every route it lists is served.";

/// The report the review node's judge member stored.
///
/// A member the graph runs as the *judge* transport, whose own report still has
/// an `agent` side — the side that did the reviewing. Its measurements are
/// attributed to the party the member is, which is what makes this the second
/// party the run's timing can measure and not a second reading of the first.
#[must_use]
pub fn reviewer_report() -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, Message, PartyTelemetry, Report, Telemetry,
        TelemetryRole, Transcript, Usage,
    };

    let usage = Usage {
        input_tokens: Some(400),
        output_tokens: Some(90),
        cache_read_tokens: Some(0),
        cache_write_tokens: Some(0),
        cost_usd: Some(0.11),
    };
    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user(REVIEW_PROMPT),
                Message::assistant(REVIEW_REPLY),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: Some("the change is approved".into()),
        settled_reason: None,
        usage: Some(usage.clone()),
        telemetry: Some(Telemetry {
            wall_ms: 3_000,
            agent: PartyTelemetry {
                usage: Some(usage.clone()),
                ..PartyTelemetry::default()
            },
            judge: PartyTelemetry::default(),
            orchestration_ms: 100,
            sessions: Vec::new(),
            attribution: vec![HarnessAttribution {
                role: TelemetryRole::Agent,
                turn_index: 1,
                ran: Some("codex:default".into()),
                fell_through: Vec::new(),
                candidates: vec![CandidateAttempt {
                    harness: "codex".into(),
                    harness_id: "codex:default".into(),
                    variant: None,
                    model: None,
                    status: "ok".into(),
                    available: true,
                    ran: true,
                    failure_kind: None,
                    failure_kind_source: None,
                    exit_code: Some(0),
                    duration_ms: Some(2_800),
                    error: None,
                    session_id: None,
                    history_id: None,
                    usage: Some(usage),
                }],
                history_file: None,
            }],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// The stream the live run's lint member ran on, and the artifact its settlement
/// recorded for the report it stored.
pub const LINT_STREAM: &str = "node-scope-1786925518110-3163812";
pub const LINT_REPORT_ARTIFACT: &str = "report-node-scope-1786925518110-3163812";

/// The report the lint member stored, which is where the time it spent is.
///
/// A third party beside the agent and the judge, told apart from them by the
/// member label alone — so a run whose lint tier ran is measurable as having run
/// rather than as having reported nothing.
#[must_use]
pub fn lint_report() -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, Message, PartyTelemetry, Report, Telemetry,
        TelemetryRole, Transcript, Usage,
    };

    let usage = Usage {
        input_tokens: Some(120),
        output_tokens: Some(40),
        cache_read_tokens: Some(0),
        cache_write_tokens: Some(0),
        cost_usd: Some(0.03),
    };
    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user("Read the diff for the rules the repository declares."),
                Message::assistant("The diff reads; no rule it declares is broken."),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: None,
        settled_reason: None,
        usage: Some(usage.clone()),
        telemetry: Some(Telemetry {
            wall_ms: 600,
            agent: PartyTelemetry {
                usage: Some(usage.clone()),
                ..PartyTelemetry::default()
            },
            judge: PartyTelemetry::default(),
            orchestration_ms: 20,
            sessions: Vec::new(),
            attribution: vec![HarnessAttribution {
                role: TelemetryRole::Agent,
                turn_index: 1,
                ran: Some("codex:default".into()),
                fell_through: Vec::new(),
                candidates: vec![CandidateAttempt {
                    harness: "codex".into(),
                    harness_id: "codex:default".into(),
                    variant: None,
                    model: None,
                    status: "ok".into(),
                    available: true,
                    ran: true,
                    failure_kind: None,
                    failure_kind_source: None,
                    exit_code: Some(0),
                    duration_ms: Some(500),
                    error: None,
                    session_id: None,
                    history_id: None,
                    usage: Some(usage),
                }],
                history_file: None,
            }],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}
