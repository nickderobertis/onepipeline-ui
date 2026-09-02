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
/// The qualified onetaskgraph project the fixture runs were launched from.
///
/// `<source>:<project>` — what the engine records where it used to record a plan
/// path. The plan's definition lives in that store; what a run executes is the
/// graph projected from its own journal, so this names where the plan came from
/// and this crate never re-reads it.
pub const PLAN_PROJECT: &str = "authoring:contract-interface";

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
/// The release that carried the node's landed work, as `onevcs` observed it.
///
/// Never stamped with a node: a release is observed long after the dispatch that
/// produced the work has settled and outside any session of it, so what joins it
/// to a node is [`MERGE_SHA`] and nothing else. That is the whole point of the
/// record and the reason it is written here without one.
pub const RELEASE_VERSION: &str = "0.13.0";
/// The sibling whose release the node was held on before it could start.
pub const DEP_IDENTITY: &str = "github.com/nickderobertis/onepipeline";
/// The version of it the node was waiting for, on both of its targets.
pub const DEP_VERSION: &str = "0.7.3";
/// The commit that release carried, which is not this run's own merge.
pub const DEP_LANDING_SHA: &str = "3c1d5e7f9081a2b3c4d5e6f708192a3b4c5d6e7f";
/// What a person had to go and do before the node's second wait could clear.
pub const HUMAN_RELEASE_ACTION: &str = "publish the npm wrapper from the tagged release";
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

/// What the live run's dispatch was asked, which is what its one turn answers.
pub const LIVE_INSTRUCTION: &str = "Open the change request for this node's work.";

/// What the node still working was asked, what it has said back, and what its
/// tools returned — the reading a dispatch in flight has and a stored report
/// cannot supply, because nothing has settled to write one.
pub const WORKING_INSTRUCTION: &str = "Keep the docs in step with the read API.";
/// What it said back on the turn that finished.
pub const WORKING_REPLY: &str = "read the contract; its transcript section is the one to move";
/// The observation its first call came back with.
pub const WORKING_OBSERVATION: &str = "docs/contract.md: 49 lines";
/// The identity that harness minted for that call, which is what joins the two.
pub const WORKING_TOOL_CALL_ID: &str = "toolu_01WkQ2";
/// What the supervisor said next, which is what the turn now running answers.
pub const WORKING_NEXT_INSTRUCTION: &str = "Now write the paragraph, and keep it to the wire.";
/// The reply the turn in flight has produced so far, cut to the producer's bound.
pub const WORKING_CUT_REPLY: &str = "wrote the first half of it and then";
/// The observation its second call returned, cut to that bound as well.
pub const WORKING_CUT_OBSERVATION: &str = "…docs/contract.md | 12 +++++++-----";
/// What the node whose member died was asked, said, and saw before it went.
pub const DIED_INSTRUCTION: &str = "Run the gate and report what it says.";
/// The words it managed to publish.
pub const DIED_REPLY: &str = "the gate is running";
/// The observation its one call returned before the process went away.
pub const DIED_OBSERVATION: &str = "error: could not compile `onepipeline-ui`";
/// The identity that call was published under.
pub const DIED_TOOL_CALL_ID: &str = "toolu_01Rm7f";
/// What the node whose worktree was reclaimed was asked. Its own words are
/// nowhere: a single-sided member publishes none until it settles, and it never
/// did.
pub const RECLAIMED_INSTRUCTION: &str = "Draft the release note.";

/// The instant the fixture run started, as every payload renders it.
const START: &str = "2026-08-07T12:00:00.000Z";

/// A third run, whose lanes ran one after another and whose nodes were re-asked.
///
/// The other two fixtures each dispatch a node once, under a persona that is
/// also a role — so neither can say what a *second* attempt is served as, nor
/// what a session dispatched under a persona a host invented is read as. This
/// one is written the way the host that runs this stack really records: personas
/// are `engineer` and `docs-writer`, the role is the `member` beside them, and a
/// lifecycle node hands its branch from a worker to a drafting member before
/// `onevcs` publishes it.
pub const LANES_RUN_ID: &str = "run-20260807-7a8b9c";
/// That run's node the engine re-asked: its first attempt was abandoned mid-turn
/// and its second settled.
pub const RETRIED_NODE_ID: &str = "retried";
/// That run's node that worked, drafted a change, and published it.
pub const DRAFTED_NODE_ID: &str = "drafted";
/// That run's node whose gate refused it, so its branch was never published and
/// its worktree was simply taken away.
pub const REFUSED_NODE_ID: &str = "refused";
/// That run's node still working: dispatched, talking, and settled by nothing.
pub const WORKING_NODE_ID: &str = "working";
/// That run's node whose member died mid-turn, which the graph recorded before
/// anything else on that node ended.
pub const DIED_NODE_ID: &str = "died";
/// That run's node whose worktree was reclaimed while its member was still
/// talking, so nothing but the branch going away says when the session stopped.
pub const RECLAIMED_NODE_ID: &str = "reclaimed";
/// That run's node whose session the graph stamped with a member this wire has
/// no word for, under the one persona that reads like a role.
pub const UNNAMED_NODE_ID: &str = "unnamed";
/// That run's node whose dispatch relayed no session at all, under a persona
/// that is also a role: the one record it left stamps no member.
pub const SILENT_NODE_ID: &str = "silent";

/// The streams that run's members ran on, one per member.
///
/// A stream is the producing *process*, so a second attempt of one node is a
/// second stream and a lifecycle node's drafting member is a stream of its own.
/// Every session id below is `{stream}.{member}`, which is how `oneagentgraph`
/// mints one — the pair has to agree or nothing joins a session to the records
/// that opened and closed it.
const LANE_STREAMS: [&str; 9] = [
    "node-scope-1786925520001-4311",
    "node-scope-1786925520002-4311",
    "node-scope-1786925520003-4311",
    "pr-author-1786925520004-4311",
    "node-scope-1786925520005-4311",
    "node-scope-1786925520006-4311",
    "node-scope-1786925520008-4311",
    "node-scope-1786925520009-4311",
    "node-scope-1786925520010-4311",
];
/// The session the re-asked node's abandoned first attempt ran under.
pub const RETRIED_FIRST_CONVERSATION_ID: &str = "node-scope-1786925520001-4311.worker";
/// The session its second attempt ran under.
pub const RETRIED_SECOND_CONVERSATION_ID: &str = "node-scope-1786925520002-4311.worker";
/// The session the published node's worker ran under.
pub const DRAFTED_WORK_CONVERSATION_ID: &str = "node-scope-1786925520003-4311.worker";
/// The session its drafting turn ran under — a member of its own, on a stream of
/// its own, after the worker it drafted for had settled.
pub const DRAFTED_DRAFTING_CONVERSATION_ID: &str = "pr-author-1786925520004-4311.pr-author";
/// The session the refused node ran under.
pub const REFUSED_CONVERSATION_ID: &str = "node-scope-1786925520005-4311.worker";
/// The session the node still working is talking in.
pub const WORKING_CONVERSATION_ID: &str = "node-scope-1786925520006-4311.worker";
/// The session the graph lost: it ran under this one and died in it.
pub const DIED_CONVERSATION_ID: &str = "node-scope-1786925520008-4311.worker";
/// The session whose worktree was taken away while it was still talking.
pub const RECLAIMED_CONVERSATION_ID: &str = "node-scope-1786925520009-4311.worker";
/// The session the graph ran under a `reviewer`: a member `agentRoleSchema` has
/// no word for, beside a persona that is the literal word `pr-author`.
pub const UNNAMED_CONVERSATION_ID: &str = "node-scope-1786925520010-4311.reviewer";
/// The run's own observer, recorded at no node and under no role word: the
/// `monitor` member is the run's watching side, and it is served in the
/// `orchestrator` lane it shares rather than as a member of its own.
pub const WATCHING_CONVERSATION_ID: &str = "dag-scope-1786925520007-4311.monitor";
/// The stream that observer runs on.
const WATCHING_STREAM: &str = "dag-scope-1786925520007-4311";

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
            // The shape every run the engine launches now has: a plan's
            // definition lives in the onetaskgraph store, and the launch record
            // names the **project** it came from rather than a file. The runs
            // this repository serves are overwhelmingly these, so this is the
            // ordinary fixture; `write_launch_shapes` holds the four other
            // shapes a reader of a real runs root still meets.
            "project": PLAN_PROJECT,
            "dir": "/a-recording-host/workspace",
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
            at: WORKER_SETTLED_AT,
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
        // Ready, and then held: this node needs the *released* sibling rather
        // than the work in it, so the run records what it is waiting on. Two
        // entries, because the two waits are not the same wait — the crate
        // publishes itself and the npm wrapper needs a person, and only the
        // second one carries the `action` somebody has to be told about.
        .emit(
            "2026-08-07T12:00:01.200Z",
            "pipeline",
            "release-wait",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "awaiting": [
                    {
                        "dep": "sdk",
                        "identity": DEP_IDENTITY,
                        "target": "crate",
                        "style": "automated",
                        "since": "2026-08-07T12:00:01.000Z",
                        "waited_seconds": 12,
                        "last_answer": "not-released",
                    },
                    {
                        "dep": "sdk",
                        "identity": DEP_IDENTITY,
                        "target": "npm",
                        "style": "human-step",
                        "action": HUMAN_RELEASE_ACTION,
                        "since": "2026-08-07T12:00:01.000Z",
                        "waited_seconds": 12,
                        "last_answer": "awaiting-human-step",
                    },
                ],
            }),
        )
        // The automated half answers itself: `onevcs` asks the registry, and the
        // answer is the release. Neither record carries a node — the release is
        // the sibling's, and no session of this run is open on it.
        .emit(
            "2026-08-07T12:00:01.300Z",
            "vcs",
            "release-probed",
            json!({ "run_id": run }),
            json!({
                "identity": DEP_IDENTITY,
                "target": "crate",
                "form": "registry-index",
                "outcome": "released",
                "version": DEP_VERSION,
                "elapsed_ms": 412,
            }),
        )
        .emit(
            "2026-08-07T12:00:01.350Z",
            "vcs",
            "release-observed",
            json!({ "run_id": run }),
            json!({
                "identity": DEP_IDENTITY,
                "target": "crate",
                "style": "automated",
                "version": DEP_VERSION,
                "landing_commit": DEP_LANDING_SHA,
            }),
        )
        .emit(
            "2026-08-07T12:00:01.400Z",
            "pipeline",
            "release-arrived",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "dep": "sdk",
                "identity": DEP_IDENTITY,
                "target": "crate",
                "style": "automated",
                "version": DEP_VERSION,
            }),
        )
        // The human half ends the only way it can: somebody did it and said so.
        .emit(
            "2026-08-07T12:00:01.500Z",
            "vcs",
            "release-acknowledged",
            json!({ "run_id": run }),
            json!({
                "identity": DEP_IDENTITY,
                "target": "npm",
                "version": DEP_VERSION,
                "landing_commit": DEP_LANDING_SHA,
                "actor": "a-recording-host",
                "superseded": false,
            }),
        )
        .emit(
            "2026-08-07T12:00:01.550Z",
            "vcs",
            "release-observed",
            json!({ "run_id": run }),
            json!({
                "identity": DEP_IDENTITY,
                "target": "npm",
                "style": "human-step",
                "version": DEP_VERSION,
                "landing_commit": DEP_LANDING_SHA,
            }),
        )
        .emit(
            "2026-08-07T12:00:01.600Z",
            "pipeline",
            "release-arrived",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "dep": "sdk",
                "identity": DEP_IDENTITY,
                "target": "npm",
                "style": "human-step",
                "version": DEP_VERSION,
            }),
        )
        // Both waits are over, so the versions go into the node's own context
        // before it is dispatched: nothing is running yet, so the note rides the
        // dispatch rather than a turn.
        .emit(
            "2026-08-07T12:00:01.800Z",
            "pipeline",
            "release-adopted",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "delivery": "deferred",
                "versions": [
                    { "identity": DEP_IDENTITY, "target": "crate", "version": DEP_VERSION },
                    { "identity": DEP_IDENTITY, "target": "npm", "version": DEP_VERSION },
                ],
            }),
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
                    "input_tokens": 159_810,
                    "output_tokens": 1_728,
                    "cache_read_tokens": 231_481,
                    "cache_write_tokens": 1_068,
                    "cost_usd": 53.79,
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
        // And the release that carried this node's own work, observed after the
        // fact and stamped with **no node at all** — which is why the served
        // node item is joined to it by the commit it landed as and never by a
        // label. A label lookup would find nothing here, exactly as it finds
        // nothing on a real run.
        .emit(
            "2026-08-07T12:00:19.500Z",
            "vcs",
            "release-observed",
            json!({ "run_id": run }),
            json!({
                "identity": identity,
                "target": "crate",
                "style": "automated",
                "version": RELEASE_VERSION,
                "landing_commit": MERGE_SHA,
            }),
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
            "project": PLAN_PROJECT,
            "dir": "/a-recording-host/workspace",
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

/// One recorded run whose work ran in sequence, still being driven.
///
/// Written to be read as a *timeline*: every lane in it is a lane that was the
/// only thing happening while it ran, so a reading that widens any of them to
/// the node's own window shows up as two lanes overlapping where the run says
/// they could not have. It carries the four shapes the other fixtures have none
/// of — a node the engine re-asked, a lifecycle node handing its branch to a
/// drafting member, a publication the gate refused, and a node still working.
pub fn write_lanes(root: &Path, run: &str) -> PathBuf {
    let dir = root.join(run);
    fs::create_dir_all(dir.join("artifacts")).expect("the artifact directory");
    fs::write(
        dir.join("launch.json"),
        pretty(&json!({
            "run_id": run,
            "plan": "plan.json",
            "graph": "graphs/dag-scope.yaml",
            "launcher": "claude-code",
            "session": "claude-code-session-7a8b9c0d",
            "pid": 4311,
            "host": "a-recording-host",
            "started_at": START,
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    let plan = lanes_plan();
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    // Deliberately no `result.json`: a node of this run is still working, and the
    // SDK rewrites that document only when a driver closes out.
    fs::write(dir.join("events.jsonl"), lanes_journal(run, &plan)).expect("the journal");
    dir
}

fn lanes_plan() -> Value {
    json!({
        "schema_version": 2,
        "goal": { "text": "land the workstream" },
        "name": "lanes",
        "concurrency": 4,
        "tasks": [
            { "id": RETRIED_NODE_ID, "persona": "engineer", "task": "## What\nRe-ask me." },
            {
                "id": DRAFTED_NODE_ID,
                "persona": "engineer",
                "task": "## What\nWork, draft, publish.",
                "branch": "feature/drafted",
                "base_branch": "main",
            },
            { "id": REFUSED_NODE_ID, "persona": "docs-writer", "task": "## What\nFail the gate." },
            { "id": WORKING_NODE_ID, "persona": "docs-writer", "task": "## What\nKeep working." },
            { "id": DIED_NODE_ID, "persona": "engineer", "task": "## What\nDie mid-turn." },
            {
                "id": RECLAIMED_NODE_ID,
                "persona": "engineer",
                "task": "## What\nLose the worktree.",
            },
            { "id": UNNAMED_NODE_ID, "persona": "docs-writer", "task": "## What\nBe stamped." },
            { "id": SILENT_NODE_ID, "persona": "check-in", "task": "## What\nSay nothing." },
        ],
    })
}

/// That run's merged event store, in merge order.
///
/// The personas are the ones this host really dispatches under — `engineer` and
/// `docs-writer` — and the role beside each is the `member` `oneagentgraph`
/// stamps, which is the only thing in the record that says what a session *was*.
///
/// Each member's records go on the member's own stream, because that is where
/// the producing process writes them and because `{stream}.{member}` is the
/// session id they belong to. The streams are merged on `(ts, stream, seq)`, the
/// way the SDK's own reader merges them.
fn lanes_journal(run: &str, plan: &Value) -> String {
    let mut driver = Journal::new("a-recording-host-4311");
    let mut members: Vec<Journal> = LANE_STREAMS
        .into_iter()
        .chain([WATCHING_STREAM])
        .map(Journal::new)
        .collect();
    let at_node = |node: &str| json!({ "run_id": run, "node": node });

    driver.emit(
        START,
        "pipeline",
        "run-started",
        json!({ "run_id": run }),
        json!({ "plan": plan }),
    );

    // The run's own observer, at no node: a `monitor` member, which is neither a
    // node's work nor a word `agentRoleSchema` has.
    let watching = Lane {
        run,
        stream: WATCHING_STREAM,
        session: WATCHING_CONVERSATION_ID,
        node: None,
        member: "monitor",
        persona: "monitor",
    };
    watching.turn(&mut members, "2026-08-07T12:00:00.500Z");

    // The node the engine re-asked. `oneagentgraph` opens a member before the
    // session says anything, which is the one record that says when a session
    // began — and the first attempt's member never settles, because that attempt
    // was abandoned where the dispatch superseding it began.
    let abandoned = Lane {
        run,
        stream: LANE_STREAMS[0],
        session: RETRIED_FIRST_CONVERSATION_ID,
        node: Some(RETRIED_NODE_ID),
        member: "worker",
        persona: "engineer",
    };
    let reasked = Lane {
        run,
        stream: LANE_STREAMS[1],
        session: RETRIED_SECOND_CONVERSATION_ID,
        node: Some(RETRIED_NODE_ID),
        member: "worker",
        persona: "engineer",
    };
    driver.emit(
        "2026-08-07T12:00:01.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": RETRIED_NODE_ID, "persona": "engineer" }),
        json!({ "persona": "engineer" }),
    );
    abandoned.started(&mut members, "2026-08-07T12:00:02.000Z");
    abandoned.turn(&mut members, "2026-08-07T12:00:03.000Z");
    driver.emit(
        "2026-08-07T12:01:00.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": RETRIED_NODE_ID, "persona": "engineer" }),
        json!({ "persona": "engineer" }),
    );
    reasked.started(&mut members, "2026-08-07T12:01:01.000Z");
    reasked.turn(&mut members, "2026-08-07T12:01:02.000Z");
    reasked.settled(&mut members, "2026-08-07T12:01:30.000Z", true);
    driver.emit(
        "2026-08-07T12:01:31.000Z",
        "pipeline",
        "node-settled",
        at_node(RETRIED_NODE_ID),
        json!({ "status": "done", "outcome": "shipped" }),
    );

    // The lifecycle node: a worker on the worktree, then a drafting member on the
    // same branch once it had settled, then `onevcs` publishing what they left.
    // The three ran one after another and nothing about them overlaps.
    let working_on_it = Lane {
        run,
        stream: LANE_STREAMS[2],
        session: DRAFTED_WORK_CONVERSATION_ID,
        node: Some(DRAFTED_NODE_ID),
        member: "worker",
        persona: "engineer",
    };
    let drafting = Lane {
        run,
        stream: LANE_STREAMS[3],
        session: DRAFTED_DRAFTING_CONVERSATION_ID,
        node: Some(DRAFTED_NODE_ID),
        member: "pr-author",
        persona: "pr-author",
    };
    driver
        .emit(
            "2026-08-07T12:02:00.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": DRAFTED_NODE_ID, "persona": "engineer" }),
            json!({ "persona": "engineer" }),
        )
        // The worktree the dispatch was given, which is where the *work* begins
        // and not where publishing does.
        .emit(
            "2026-08-07T12:02:01.000Z",
            "vcs",
            "session-opened",
            at_node(DRAFTED_NODE_ID),
            json!({
                "token": "a-vcs-session-token",
                "identity": IDENTITY,
                "branch": "feature/drafted",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        )
        // `onevcs` brings its clone up to date to cut that worktree. It fetches
        // to publish from one too and the record says nothing about which this
        // was, which is why neither can open a publication.
        .emit(
            "2026-08-07T12:02:01.500Z",
            "vcs",
            "fetch",
            at_node(DRAFTED_NODE_ID),
            json!({ "identity": IDENTITY }),
        );
    working_on_it.started(&mut members, "2026-08-07T12:02:02.000Z");
    working_on_it.turn(&mut members, "2026-08-07T12:02:03.000Z");
    working_on_it.settled(&mut members, "2026-08-07T12:20:00.000Z", true);
    drafting.started(&mut members, "2026-08-07T12:20:01.000Z");
    drafting.turn(&mut members, "2026-08-07T12:20:02.000Z");
    drafting.settled(&mut members, "2026-08-07T12:20:40.000Z", true);
    // And only now the publication. It begins with the same fetch the worktree
    // began with — this one to publish from — so the span opens at the gate a
    // second later, which is the first record only publishing writes.
    driver
        .emit(
            "2026-08-07T12:20:40.500Z",
            "vcs",
            "fetch",
            at_node(DRAFTED_NODE_ID),
            json!({ "identity": IDENTITY }),
        )
        .emit(
            "2026-08-07T12:20:41.000Z",
            "vcs",
            "gate-started",
            at_node(DRAFTED_NODE_ID),
            json!({ "command": "just gate", "comparison_remote": "origin" }),
        )
        .emit(
            "2026-08-07T12:21:30.000Z",
            "vcs",
            "gate-verdict",
            at_node(DRAFTED_NODE_ID),
            json!({ "verdict": "pass", "command": "just gate", "output": "the gate passed" }),
        )
        .emit(
            "2026-08-07T12:21:31.000Z",
            "vcs",
            "push",
            at_node(DRAFTED_NODE_ID),
            json!({ "branch": "feature/drafted", "remote": "origin", "accepted": true }),
        )
        .emit(
            "2026-08-07T12:21:35.000Z",
            "vcs",
            "change-merged",
            at_node(DRAFTED_NODE_ID),
            json!({ "url": "https://example.invalid/changes/3", "sha": MERGE_SHA }),
        )
        .emit(
            "2026-08-07T12:21:36.000Z",
            "vcs",
            "session-closed",
            at_node(DRAFTED_NODE_ID),
            json!({ "identity": IDENTITY }),
        )
        .emit(
            "2026-08-07T12:21:37.000Z",
            "pipeline",
            "node-settled",
            at_node(DRAFTED_NODE_ID),
            json!({
                "status": "done",
                "outcome": "shipped",
                "branch": "feature/drafted",
                "change_url": "https://example.invalid/changes/3",
            }),
        );

    // The node whose gate refused it: publication work happened and nothing came
    // of it, so the branch's span ends where the worktree was taken away and the
    // run never ruled on what became of the branch.
    let refused = Lane {
        run,
        stream: LANE_STREAMS[4],
        session: REFUSED_CONVERSATION_ID,
        node: Some(REFUSED_NODE_ID),
        member: "worker",
        persona: "docs-writer",
    };
    driver
        .emit(
            "2026-08-07T12:03:00.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": REFUSED_NODE_ID, "persona": "docs-writer" }),
            json!({ "persona": "docs-writer" }),
        )
        .emit(
            "2026-08-07T12:03:01.000Z",
            "vcs",
            "session-opened",
            at_node(REFUSED_NODE_ID),
            json!({
                "token": "a-vcs-session-token",
                "identity": IDENTITY,
                "branch": "feature/refused",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        );
    refused.started(&mut members, "2026-08-07T12:03:02.000Z");
    refused.turn(&mut members, "2026-08-07T12:03:03.000Z");
    refused.settled(&mut members, "2026-08-07T12:09:00.000Z", false);
    driver
        .emit(
            "2026-08-07T12:09:01.000Z",
            "vcs",
            "gate-started",
            at_node(REFUSED_NODE_ID),
            json!({ "command": "just gate", "comparison_remote": "origin" }),
        )
        .emit(
            "2026-08-07T12:09:50.000Z",
            "vcs",
            "gate-verdict",
            at_node(REFUSED_NODE_ID),
            json!({ "verdict": "fail", "command": "just gate", "output": "the gate refused it" }),
        )
        .emit(
            "2026-08-07T12:09:51.000Z",
            "vcs",
            "session-closed",
            at_node(REFUSED_NODE_ID),
            json!({ "identity": IDENTITY }),
        )
        .emit(
            "2026-08-07T12:09:52.000Z",
            "pipeline",
            "node-settled",
            at_node(REFUSED_NODE_ID),
            json!({ "status": "failed", "outcome": "gate-failed" }),
        );

    // The node still working, on a worktree nothing has published from: the run
    // has said when it began and nothing at all about when it ends.
    let still_working = Lane {
        run,
        stream: LANE_STREAMS[5],
        session: WORKING_CONVERSATION_ID,
        node: Some(WORKING_NODE_ID),
        member: "worker",
        persona: "docs-writer",
    };
    driver
        .emit(
            "2026-08-07T12:04:00.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": WORKING_NODE_ID, "persona": "docs-writer" }),
            json!({ "persona": "docs-writer" }),
        )
        .emit(
            "2026-08-07T12:04:01.000Z",
            "vcs",
            "session-opened",
            at_node(WORKING_NODE_ID),
            json!({
                "token": "a-vcs-session-token",
                "identity": IDENTITY,
                "branch": "feature/working",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        )
        .emit(
            "2026-08-07T12:04:01.500Z",
            "vcs",
            "fetch",
            at_node(WORKING_NODE_ID),
            json!({ "identity": IDENTITY }),
        );
    // Everything a dispatch still in flight publishes about itself, in the shape
    // the corrected producer publishes it: one turn that finished, the
    // supervisor's own turn answering it — numbered `1` as well, because the two
    // sides count their turns apart — and the turn that is running now, which no
    // report anywhere holds and never will unless this member settles.
    still_working.started(&mut members, "2026-08-07T12:04:02.000Z");
    still_working.opened(
        &mut members,
        "2026-08-07T12:04:03.000Z",
        (1, "assistant"),
        (WORKING_INSTRUCTION, false),
    );
    still_working.called(
        &mut members,
        "2026-08-07T12:04:04.000Z",
        0,
        ("Read", "docs/contract.md"),
        Some(WORKING_TOOL_CALL_ID),
    );
    still_working.observed(
        &mut members,
        "2026-08-07T12:04:05.000Z",
        1,
        (WORKING_OBSERVATION, false),
        Some(WORKING_TOOL_CALL_ID),
    );
    still_working.said(
        &mut members,
        "2026-08-07T12:04:06.000Z",
        (1, "assistant"),
        (WORKING_REPLY, false),
    );
    still_working.closed(
        &mut members,
        "2026-08-07T12:04:07.000Z",
        (1, "assistant"),
        json!({
            "input_tokens": 4_210,
            "output_tokens": 320,
            "cache_read_tokens": 1_100,
            "cache_write_tokens": 90,
            "cost_usd": 0.42,
        }),
        "2026-08-07T12:04:03.000Z",
    );
    // The supervisor's own turn: what it was asked is the reply it is answering,
    // and what it said is the next instruction rather than this transcript's
    // reply. Its accounting is its own and must never land on the agent's turn 1.
    still_working.opened(
        &mut members,
        "2026-08-07T12:04:07.500Z",
        (1, "user"),
        (WORKING_REPLY, false),
    );
    still_working.said(
        &mut members,
        "2026-08-07T12:04:08.000Z",
        (1, "user"),
        (WORKING_NEXT_INSTRUCTION, false),
    );
    still_working.closed(
        &mut members,
        "2026-08-07T12:04:08.500Z",
        (1, "user"),
        json!({
            "input_tokens": 51,
            "output_tokens": 12,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "cost_usd": 0.01,
        }),
        "2026-08-07T12:04:07.500Z",
    );
    // The turn in flight: opened, answered in part, and closed by nothing. Both
    // of its texts were cut to the producer's bound and both say so, and its
    // observation is joined to its call by the recorded ordering index because
    // this harness exposed no identity for either.
    still_working.opened(
        &mut members,
        "2026-08-07T12:04:09.000Z",
        (2, "assistant"),
        (WORKING_NEXT_INSTRUCTION, true),
    );
    still_working.called(
        &mut members,
        "2026-08-07T12:04:10.000Z",
        0,
        ("Edit", "docs/contract.md"),
        None,
    );
    still_working.observed(
        &mut members,
        "2026-08-07T12:04:11.000Z",
        1,
        (WORKING_CUT_OBSERVATION, true),
        None,
    );
    still_working.said(
        &mut members,
        "2026-08-07T12:04:12.000Z",
        (2, "assistant"),
        (WORKING_CUT_REPLY, true),
    );

    // The node whose member died mid-turn. Three records could end its session
    // and the graph's own is the earliest of them, which is the ranking a span
    // is bounded by: the run's account of the node never overrides the graph's
    // account of the session inside it.
    let lost = Lane {
        run,
        stream: LANE_STREAMS[6],
        session: DIED_CONVERSATION_ID,
        node: Some(DIED_NODE_ID),
        member: "worker",
        persona: "engineer",
    };
    driver
        .emit(
            "2026-08-07T12:05:00.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": DIED_NODE_ID, "persona": "engineer" }),
            json!({ "persona": "engineer" }),
        )
        .emit(
            "2026-08-07T12:05:00.500Z",
            "vcs",
            "session-opened",
            at_node(DIED_NODE_ID),
            json!({
                "token": "a-vcs-session-token",
                "identity": IDENTITY,
                "branch": "feature/died",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        );
    // What it managed to say before it went. A member that dies writes no report,
    // so these records are the only account of this dispatch there will ever be.
    lost.started(&mut members, "2026-08-07T12:05:01.000Z");
    lost.opened(
        &mut members,
        "2026-08-07T12:05:02.000Z",
        (1, "assistant"),
        (DIED_INSTRUCTION, false),
    );
    lost.called(
        &mut members,
        "2026-08-07T12:05:03.000Z",
        0,
        ("Bash", "just gate"),
        Some(DIED_TOOL_CALL_ID),
    );
    lost.observed(
        &mut members,
        "2026-08-07T12:05:04.000Z",
        1,
        (DIED_OBSERVATION, false),
        Some(DIED_TOOL_CALL_ID),
    );
    lost.said(
        &mut members,
        "2026-08-07T12:05:05.000Z",
        (1, "assistant"),
        (DIED_REPLY, false),
    );
    lost.died(&mut members, "2026-08-07T12:05:30.000Z");
    driver
        .emit(
            "2026-08-07T12:05:40.000Z",
            "vcs",
            "session-closed",
            at_node(DIED_NODE_ID),
            json!({ "identity": IDENTITY }),
        )
        .emit(
            "2026-08-07T12:05:41.000Z",
            "pipeline",
            "node-settled",
            at_node(DIED_NODE_ID),
            json!({ "status": "failed", "outcome": "member-died" }),
        );

    // And the node whose worktree was reclaimed while its member was still
    // talking: the graph never ended that session at all, so the branch going
    // away is the only thing that says when it stopped — ahead of the run's own
    // settlement a second later.
    let reclaimed = Lane {
        run,
        stream: LANE_STREAMS[7],
        session: RECLAIMED_CONVERSATION_ID,
        node: Some(RECLAIMED_NODE_ID),
        member: "worker",
        persona: "engineer",
    };
    driver
        .emit(
            "2026-08-07T12:06:00.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": RECLAIMED_NODE_ID, "persona": "engineer" }),
            json!({ "persona": "engineer" }),
        )
        .emit(
            "2026-08-07T12:06:01.000Z",
            "vcs",
            "session-opened",
            at_node(RECLAIMED_NODE_ID),
            json!({
                "token": "a-vcs-session-token",
                "identity": IDENTITY,
                "branch": "feature/reclaimed",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        );
    // A single-sided member, which is the one kind that publishes no
    // `turn-message` at all: what it was asked and when it began, and its own
    // words only in the report it never got to write.
    reclaimed.started(&mut members, "2026-08-07T12:06:02.000Z");
    reclaimed.opened(
        &mut members,
        "2026-08-07T12:06:03.000Z",
        (1, "assistant"),
        (RECLAIMED_INSTRUCTION, false),
    );
    driver
        .emit(
            "2026-08-07T12:06:30.000Z",
            "vcs",
            "session-closed",
            at_node(RECLAIMED_NODE_ID),
            json!({ "identity": IDENTITY }),
        )
        .emit(
            "2026-08-07T12:06:31.000Z",
            "pipeline",
            "node-settled",
            at_node(RECLAIMED_NODE_ID),
            json!({ "status": "failed", "outcome": "worktree-reclaimed" }),
        );

    // The node the graph ran under a member no vocabulary here has a word for.
    // The persona beside it is the literal word `pr-author`, which is the one a
    // host really dispatches under and the one a reading off personas mistook a
    // whole lane for — so this session says what it was, and what it said is not
    // servable.
    let unnamed = Lane {
        run,
        stream: LANE_STREAMS[8],
        session: UNNAMED_CONVERSATION_ID,
        node: Some(UNNAMED_NODE_ID),
        member: "reviewer",
        persona: "pr-author",
    };
    driver.emit(
        "2026-08-07T12:07:00.000Z",
        "pipeline",
        "node-dispatched",
        json!({ "run_id": run, "node": UNNAMED_NODE_ID, "persona": "docs-writer" }),
        json!({ "persona": "docs-writer" }),
    );
    unnamed.started(&mut members, "2026-08-07T12:07:01.000Z");
    unnamed.turn(&mut members, "2026-08-07T12:07:02.000Z");
    unnamed.settled(&mut members, "2026-08-07T12:07:30.000Z", true);
    driver.emit(
        "2026-08-07T12:07:31.000Z",
        "pipeline",
        "node-settled",
        at_node(UNNAMED_NODE_ID),
        json!({ "status": "done", "outcome": "shipped" }),
    );

    // And the dispatch that relayed no session at all — the kind the engine
    // re-asks. Its `node-dispatched` stamps a persona and no member, which is
    // the record the persona is the reading for.
    driver
        .emit(
            "2026-08-07T12:08:00.000Z",
            "pipeline",
            "node-dispatched",
            json!({ "run_id": run, "node": SILENT_NODE_ID, "persona": "check-in" }),
            json!({ "persona": "check-in" }),
        )
        .emit(
            "2026-08-07T12:08:30.000Z",
            "pipeline",
            "node-settled",
            at_node(SILENT_NODE_ID),
            json!({ "status": "failed", "outcome": "nothing-reported" }),
        );

    merged(std::iter::once(driver).chain(members))
}

/// The repository every session of the lanes run publishes to.
const IDENTITY: &str = "github.com/nickderobertis/onepipeline-ui";

/// One member of the lanes run, and the records `oneagentgraph` writes for it.
///
/// It exists so a lane is written as the three things a lane *is* — it began, it
/// spoke, it settled — rather than as nine near-identical `emit` calls whose
/// stream and labels a reader has to check against each other by eye.
struct Lane<'a> {
    /// The run it belongs to, which every record in the merged store carries.
    run: &'a str,
    /// The producing process's own stream, which the session id is spelled from.
    stream: &'a str,
    /// That session id: `{stream}.{member}`, and nothing else.
    session: &'a str,
    /// The node it ran for, or `None` for the run's own observer.
    node: Option<&'a str>,
    /// The member the graph declared, which is what says what the session was.
    member: &'a str,
    /// The persona it ran under, which on this host names a style and not a role.
    persona: &'a str,
}

impl Lane<'_> {
    /// The labels every record of it carries. `session` is stamped on the turn
    /// kinds and on no other, exactly as that library stamps it.
    fn labels(&self, session: bool) -> Value {
        let mut labels = json!({
            "run_id": self.run,
            "member": self.member,
            "persona": self.persona,
        });
        if let Some(node) = self.node {
            labels["node"] = json!(node);
        }
        if session {
            labels["session"] = json!(self.session);
        }
        labels
    }

    /// Its own journal, by the stream that names it.
    fn journal<'j>(&self, members: &'j mut [Journal]) -> &'j mut Journal {
        members
            .iter_mut()
            .find(|journal| journal.stream == self.stream)
            .expect("a lane writes on the stream its session is spelled from")
    }

    /// `member-started`: the one record that says when a session began, and the
    /// one a session with a single turn in it could not otherwise supply.
    fn started(&self, members: &mut [Journal], at: &str) {
        self.journal(members).emit(
            at,
            "agentgraph",
            "member-started",
            self.labels(false),
            json!({}),
        );
    }

    /// `turn-started`, as the producer that predates the corrected turn contract
    /// publishes one: a number and nothing else.
    ///
    /// Kept, and kept in use, because it is what every run recorded before that
    /// correction holds and those runs are still read — a lane written this way
    /// is the reading with no instruction, no party and no clock to join by, and
    /// it has to keep serving what it always did.
    fn turn(&self, members: &mut [Journal], at: &str) {
        self.journal(members).emit(
            at,
            "agentgraph",
            "turn-started",
            self.labels(true),
            json!({ "turn": 1 }),
        );
    }

    /// `turn-started`, as the corrected producer publishes one: the turn's own
    /// number, the party taking it, the message it is answering and when it
    /// began.
    ///
    /// `instruction_truncated` says the producer cut the message to its own
    /// bound, and is omitted rather than written `false` — which is what that
    /// library's own payload does with it.
    fn opened(
        &self,
        members: &mut [Journal],
        at: &str,
        turn: (u64, &str),
        instruction: (&str, bool),
    ) {
        let mut payload = json!({
            "turn": turn.0,
            "role": turn.1,
            "instruction": instruction.0,
            "started_at": at,
        });
        if instruction.1 {
            payload["instruction_truncated"] = json!(true);
        }
        self.journal(members)
            .emit(at, "agentgraph", "turn-started", self.labels(true), payload);
    }

    /// `turn-message`: one party's own words for one turn, published as the turn
    /// happens rather than kept until the member settles.
    fn said(&self, members: &mut [Journal], at: &str, turn: (u64, &str), text: (&str, bool)) {
        let mut payload = json!({ "turn": turn.0, "role": turn.1, "text": text.0 });
        if text.1 {
            payload["truncated"] = json!(true);
        }
        self.journal(members)
            .emit(at, "agentgraph", "turn-message", self.labels(true), payload);
    }

    /// `turn-activity`: one tool call, with the harness's own identity for it
    /// where the harness exposed one.
    fn called(
        &self,
        members: &mut [Journal],
        at: &str,
        index: u64,
        tool: (&str, &str),
        identity: Option<&str>,
    ) {
        let mut payload = json!({
            "kind": "tool_call",
            "name": tool.0,
            "detail": tool.1,
            "index": index,
        });
        if let Some(identity) = identity {
            payload["tool_call_id"] = json!(identity);
        }
        self.journal(members).emit(
            at,
            "agentgraph",
            "turn-activity",
            self.labels(true),
            payload,
        );
    }

    /// `turn-activity`: the observation that answered a call. It names no tool —
    /// it answers one already named — and carries the output, tail-bounded, with
    /// the flag beside it saying whether that bound cut anything off.
    fn observed(
        &self,
        members: &mut [Journal],
        at: &str,
        index: u64,
        output: (&str, bool),
        identity: Option<&str>,
    ) {
        let mut payload = json!({
            "kind": "tool_result",
            "name": Value::Null,
            "detail": "",
            "output": output.0,
            "index": index,
        });
        if output.1 {
            payload["output_truncated"] = json!(true);
        }
        if let Some(identity) = identity {
            payload["tool_call_id"] = json!(identity);
        }
        self.journal(members).emit(
            at,
            "agentgraph",
            "turn-activity",
            self.labels(true),
            payload,
        );
    }

    /// `turn-completed`, as the corrected producer publishes one: **that one
    /// turn's** own accounting and the interval it ran over, keyed by the same
    /// pair the record that opened it carried.
    fn closed(
        &self,
        members: &mut [Journal],
        at: &str,
        turn: (u64, &str),
        usage: Value,
        started_at: &str,
    ) {
        self.journal(members).emit(
            at,
            "agentgraph",
            "turn-completed",
            self.labels(true),
            json!({
                "turn": turn.0,
                "role": turn.1,
                "usage": usage,
                "started_at": started_at,
                "finished_at": at,
            }),
        );
    }

    /// `member-died`: what ends a session the graph lost rather than one that
    /// reported. It is a settlement for the purpose of bounding a span and is
    /// nothing else — no verdict is recorded and none is served.
    fn died(&self, members: &mut [Journal], at: &str) {
        self.journal(members).emit(
            at,
            "agentgraph",
            "member-died",
            self.labels(false),
            json!({ "reason": "the member's process exited" }),
        );
    }

    /// `member-settled`: what ends a session, whatever the node it ran for does.
    fn settled(&self, members: &mut [Journal], at: &str, completed: bool) {
        self.journal(members).emit(
            at,
            "agentgraph",
            "member-settled",
            self.labels(false),
            json!({
                "completed": completed,
                "verdict": [],
                "completion_reason": Value::Null,
            }),
        );
    }
}

/// Several streams as one store, in the order the SDK's own reader merges them.
fn merged(streams: impl IntoIterator<Item = Journal>) -> String {
    let mut lines: Vec<(String, String, usize, String)> = Vec::new();
    for journal in streams {
        for (seq, line) in journal.lines.iter().enumerate() {
            let record: Value = serde_json::from_str(line).expect("a record this module wrote");
            lines.push((
                record["ts"].as_str().expect("a stamp").to_owned(),
                journal.stream.clone(),
                seq,
                line.clone(),
            ));
        }
    }
    lines.sort_by(|left, right| (&left.0, &left.1, left.2).cmp(&(&right.0, &right.1, right.2)));
    let text: Vec<&str> = lines.iter().map(|(_, _, _, line)| line.as_str()).collect();
    format!("{}\n", text.join("\n"))
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
        json!({
            "turn": 1,
            "role": "assistant",
            "instruction": "Drive the run.",
            "started_at": "2026-08-07T12:00:05.000Z",
            "model": "a-model",
        }),
    );
    emit(
        "2026-08-07T12:00:05.500Z",
        "agentgraph",
        "turn-message",
        json!({
            "run_id": run,
            "persona": "orchestrator",
            "session": DRIVING_CONVERSATION_ID,
        }),
        json!({ "turn": 1, "role": "assistant", "text": "driving the run" }),
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
        json!({
            "turn": 2,
            "role": "assistant",
            "instruction": "Reconcile the frontier.",
            "started_at": "2026-08-07T12:00:26.500Z",
            "model": "a-model",
        }),
    );
    emit(
        "2026-08-07T12:00:26.700Z",
        "agentgraph",
        "turn-message",
        json!({
            "run_id": run,
            "persona": "orchestrator",
            "session": DRIVING_CONVERSATION_ID,
        }),
        json!({ "turn": 2, "role": "assistant", "text": "reconciling the frontier" }),
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
        json!({
            "turn": 1,
            "role": "assistant",
            "instruction": LIVE_INSTRUCTION,
            "started_at": "2026-08-07T12:00:28.000Z",
        }),
    );
    emit(
        "2026-08-07T12:00:28.200Z",
        "agentgraph",
        "turn-message",
        json!({
            "run_id": run,
            "node": SHIP_NODE_ID,
            "step": "build",
            "member": "worker",
            "persona": "pr-author",
            "session": LIVE_CONVERSATION_ID,
        }),
        json!({
            "turn": 1,
            "role": "assistant",
            "text": "opened the change request",
        }),
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
            "turn": 1,
            "role": "assistant",
            "usage": {
                "input_tokens": 900,
                "output_tokens": 210,
                "cache_read_tokens": 300,
                "cache_write_tokens": 60,
                "cost_usd": 0.19,
            },
            "started_at": "2026-08-07T12:00:28.000Z",
            "finished_at": "2026-08-07T12:00:28.800Z",
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
        json!({
            "turn": 1,
            "role": "assistant",
            "instruction": "Read the diff for what it says.",
            "started_at": "2026-08-07T12:00:28.900Z",
            "model": "a-model",
        }),
    );
    emit(
        "2026-08-07T12:00:28.920Z",
        "agentgraph",
        "turn-message",
        json!({
            "run_id": run,
            "node": SHIP_NODE_ID,
            "member": "llmlint",
            "persona": "pr-author",
            "session": LINT_CONVERSATION_ID,
        }),
        json!({ "turn": 1, "role": "assistant", "text": "the diff reads" }),
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
            "turn": 1,
            "role": "assistant",
            "usage": {
                "input_tokens": 120,
                "output_tokens": 40,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "cost_usd": 0.03,
            },
            "started_at": "2026-08-07T12:00:28.900Z",
            "finished_at": "2026-08-07T12:00:28.950Z",
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

/// The five launch-record shapes a real runs root holds, one run each.
///
/// A run's launch record is the first thing this server reads and the one thing
/// that can stop it reading the run at all, and the shape of it has moved: the
/// engine used to name a **plan file** and now names the onetaskgraph **project**
/// the plan came from. Both spellings are on every host that has been running
/// for a while, along with the two edges either side of them — a record written
/// across the change that carries both, and one that carries neither because the
/// launcher recorded no source at all.
///
/// The fifth is the rule the whole group is really about: a record carrying a
/// key **this** build has no reading for. A reader that refuses one refuses every
/// run a later engine launches, which is how a third of this host's runs went
/// missing from the list rather than appearing in it wrong.
///
/// Checked in as fixtures rather than read off whatever the host happens to
/// hold, so the property is a property of this tree. Returns the run ids in the
/// order written, each paired with what its record says about where the plan came
/// from.
pub fn write_launch_shapes(root: &Path) -> Vec<(String, &'static str)> {
    let shapes: [(&str, &str, Value); 5] = [
        (
            "launch-project-only",
            "a plan-store project and no plan path",
            json!({ "project": PLAN_PROJECT }),
        ),
        (
            "launch-plan-only",
            "a plan path and no project",
            json!({ "plan": "plan.json" }),
        ),
        (
            "launch-both",
            "both, as a record written across the change carries",
            json!({ "project": PLAN_PROJECT, "plan": "plan.json" }),
        ),
        ("launch-neither", "neither", json!({})),
        (
            "launch-unknown-key",
            "a key this build has no reading for",
            // Deliberately not a misspelling of a key this build *does* read: the
            // thing under test is a record from a build that records more than
            // this one knows about, which is every future engine.
            json!({ "project": PLAN_PROJECT, "a_key_recorded_by_a_later_engine": 3 }),
        ),
    ];
    shapes
        .into_iter()
        .map(|(run, shape, source)| {
            let dir = root.join(run);
            fs::create_dir_all(&dir).expect("the run directory");
            let mut record = json!({
                "run_id": run,
                "dir": "/a-recording-host/workspace",
                "graph": "graphs/dag-scope.yaml",
                "launcher": "claude-code",
                "session": SESSION,
                "pid": 4290,
                "host": "a-recording-host",
                "started_at": START,
                "heartbeat_interval": 1_800,
                "adoptions": 0,
            });
            let fields = record.as_object_mut().expect("a mapping");
            for (key, value) in source.as_object().expect("a mapping") {
                fields.insert(key.clone(), value.clone());
            }
            fs::write(dir.join("launch.json"), pretty(&record)).expect("the launch record");
            fs::write(
                dir.join("events.jsonl"),
                format!(
                    "{}\n",
                    json!({
                        "v": 1,
                        "ts": START,
                        "stream": "a-recording-host-4290",
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
            (run.to_owned(), shape)
        })
        .collect()
}

/// Rewrite a run's launch record into the shape an engine before the plan store
/// wrote.
///
/// The record named a **plan file**, and nothing else: that engine's own
/// `LaunchRecord` was `deny_unknown_fields` with a required `plan`, so a record
/// naming a project — or carrying any key it had no field for — did not
/// deserialize and the run was not readable at all. The runs on a long-lived host
/// are still full of these, and the baseline comparison needs a store *both*
/// builds can read, which is this shape and only this shape.
///
/// Written by rewriting what the fixtures wrote rather than by a second copy of
/// each of them, so a fixture that grows a record grows it here too.
pub fn make_launch_record_legacy(dir: &Path) {
    /// The keys that engine's launch record declared. Anything else it refused.
    const DECLARED: [&str; 13] = [
        "run_id",
        "plan",
        "dir",
        "graph",
        "graph_run",
        "node_graph",
        "pr_author_graph",
        "launcher",
        "session",
        "pid",
        "host",
        "started",
        "started_at",
    ];
    const ALSO_DECLARED: [&str; 4] = ["heartbeat_interval", "dag_sets", "node_sets", "adoptions"];

    let path = dir.join("launch.json");
    let mut record: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("the launch record"))
            .expect("the launch record parses");
    let fields = record.as_object_mut().expect("a mapping");
    fields
        .retain(|key, _| DECLARED.contains(&key.as_str()) || ALSO_DECLARED.contains(&key.as_str()));
    fields.insert("plan".into(), json!("plan.json"));
    fs::write(&path, pretty(&record)).expect("the launch record");
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

/// When that member settled, which is when its report was written — and so the
/// only instant any run holds for a turn the report kept and the journal never
/// opened.
pub const WORKER_SETTLED_AT: &str = "2026-08-07T12:00:05.500Z";

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
/// The third thing it was asked — and the turn **the journal never opened**.
///
/// `oneagentgraph` relays a `turn-started` for the turns it brackets and nothing
/// at all for the rest, so a settled dispatch's report regularly holds turns no
/// record of the run names. This is that turn: the report has it, its
/// attribution measures it, and no envelope of this fixture mentions it.
pub const THIRD_PROMPT: &str = "One more: say what the contract now serves.";
pub const THIRD_REPLY: &str = "It serves the transcript the dispatch really had.";
/// What that turn's one call came back with.
pub const UNRELAYED_OBSERVATION: &str = "docs/contract.md: schema 14";
/// The identity the report attributes to the invocation that ran it, which is
/// the only account of that turn's model any run holds.
pub const UNRELAYED_MODEL: &str = "claude-opus-5";
/// What that turn alone cost and took, so a figure served against it can only
/// have come from its own attribution.
pub const UNRELAYED_COST: f64 = 3.07;
pub const UNRELAYED_MS: u64 = 2_600;

/// The onejudge report the settled run's worker member stored, built from that
/// library's own types.
///
/// Nothing here is a stub of the report contract: these are `onejudge`'s structs
/// serialized by `onejudge`'s own derives, so a release that renamed a field
/// fails the suite that reads it rather than serving a transcript with holes.
///
/// It is shaped to hold four things the served transcript must get right. The
/// turns cost and take **different** amounts, so serving the report's own
/// `usage` — the run total over both sides — on any of them is visible. The
/// judge's figures are larger than the agent's on turn 2, so a reading that
/// crossed the two role vocabularies would show up as a number rather than as a
/// subtlety. And `telemetry.sessions` holds an `agent` row for the first turn
/// only, so the second is served bounds-absent rather than handed the row beside
/// it. And its **third** turn is one the journal never opened — no `turn-started`
/// of this fixture names it — so a transcript that read the report only where a
/// relayed record already stood would drop it, prose, tools, cost and all. The
/// judge's own rows are [`reviewer_report`]'s, which is where the trap they
/// spring is driven from.
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
        tool_call_id: None,
    };
    let result = ToolEvent {
        kind: "tool_result".into(),
        name: None,
        input: None,
        output: Some(TOOL_OBSERVATION.into()),
        index: 1,
        tool_call_id: None,
    };
    // The unrelayed turn's own call and what it returned, so a turn the journal
    // never opened is still served with what its tools did.
    let unrelayed_call = ToolEvent {
        kind: "tool_call".into(),
        name: Some("Read".into()),
        input: Some(json!({ "file_path": "docs/contract.md" })),
        output: None,
        index: 0,
        tool_call_id: None,
    };
    let unrelayed_result = ToolEvent {
        kind: "tool_result".into(),
        name: None,
        input: None,
        output: Some(UNRELAYED_OBSERVATION.into()),
        index: 1,
        tool_call_id: None,
    };
    let gate_call = ToolEvent {
        kind: "tool_call".into(),
        name: Some("Bash".into()),
        input: Some(json!({ "command": "just gate" })),
        output: None,
        index: 0,
        tool_call_id: None,
    };
    // A call the trace exposed no observation for, which is a different fact from
    // one that returned nothing: `output` is absent rather than empty.
    let gate_result = ToolEvent {
        kind: "tool_result".into(),
        name: None,
        input: None,
        output: None,
        index: 1,
        tool_call_id: None,
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
    // Read off the candidate rather than named twice, or the judge's attribution
    // would carry the agent's identity and no reading could tell them apart.
    let attributed = |role, turn_index, candidates: Vec<CandidateAttempt>| HarnessAttribution {
        role,
        turn_index,
        ran: candidates
            .iter()
            .find(|candidate| candidate.ran)
            .map(|candidate| candidate.harness_id.clone()),
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
                // The turn no `turn-started` ever named. It is the report's
                // third, and the transcript has to serve it as one.
                Message::user(THIRD_PROMPT),
                Message::assistant(THIRD_REPLY).with_events(vec![unrelayed_call, unrelayed_result]),
            ],
        },
        verdicts: Vec::new(),
        assessment: None,
        completion_reason: Some("the acceptance criteria were met".into()),
        settled_reason: None,
        // The whole dispatch's total over both sides, which is what no turn
        // spent: 29.71 + 1.51 + 3.07 + 9.75 + 9.75.
        usage: Some(Usage {
            input_tokens: Some(159_810),
            output_tokens: Some(1_728),
            cache_read_tokens: Some(231_481),
            cache_write_tokens: Some(1_068),
            cost_usd: Some(53.79),
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
            sessions: vec![SessionLink {
                session_id: "01a01f4c-685b-75e2-8281-e8937fd20d47".into(),
                role: TelemetryRole::Agent,
                turn_index: 1,
                started_at: "2026-08-07T12:00:03.000Z".into(),
                finished_at: Some("2026-08-07T12:00:03.900Z".into()),
                history_id: None,
            }],
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
                // What the unrelayed turn spent and took, and the identity that
                // ran it. Nothing else in this run records any of the three.
                attributed(
                    TelemetryRole::Agent,
                    3,
                    vec![CandidateAttempt {
                        model: Some(UNRELAYED_MODEL.to_owned()),
                        ..ran("claude-code", UNRELAYED_MS, agent_usage(UNRELAYED_COST))
                    }],
                ),
            ],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
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

/// The judge that supervised the review dispatch, served under that session's own
/// id with `.judge` after it. No session relays it; the stored report holds it.
pub const REVIEW_JUDGE_CONVERSATION_ID: &str = "node-scope-1786925518102-3163741.judge.judge";
/// What that judge ruled, and the words it ruled it in.
pub const JUDGE_CRITERIA: [(&str, &str); 2] = [
    (
        "every route the contract lists is served",
        "the route table answers each of them end to end",
    ),
    (
        "the gate is green over the finished tree",
        "the run recorded one green gate and no rerun after it",
    ),
];
/// The numeric criterion beside them, so the kind is read rather than assumed.
pub const JUDGE_SCORED: (&str, f64, &str) = (
    "how completely the acceptance criteria were met",
    4.5,
    "one follow-up was surfaced rather than done",
);
/// Its closing assessment, which the report keys to the dispatch.
pub const JUDGE_ASSESSMENT: &str = "The dispatch met its bar. The route table is \
landed, the gate ran green over the finished tree, and the one follow-up it \
surfaced is recorded rather than silently dropped.";
/// The model the judge side ran on; the agent side of this report names none.
pub const JUDGE_MODEL: &str = "gpt-5-codex";
/// The instants that report observed the judge between, one pair per turn. None
/// of them may reach a turn of the transcript the agent side of it had.
pub const JUDGE_BOUNDS: [(&str, &str); 2] = [
    ("2026-08-07T12:00:22.400Z", "2026-08-07T12:00:22.900Z"),
    ("2026-08-07T12:00:24.100Z", "2026-08-07T12:00:24.600Z"),
];

/// The report the review node's judge member stored.
///
/// A member the graph runs as the *judge* transport, whose own report still has
/// an `agent` side — the side that did the reviewing. Its measurements are
/// attributed to the party the member is, which is what makes this the second
/// party the run's timing can measure and not a second reading of the first.
///
/// It is also the run's one report that records the side onejudge ran *inside*
/// this member: `role: judge` rows for both turns, an `agent` row for neither,
/// and a conclusion keyed to the dispatch. So it springs the trap the other
/// report cannot — matching a turn to a row by index alone would put this clock
/// on the reviewer's own turn — and it is the settled data the judge journeys
/// read.
#[must_use]
pub fn reviewer_report() -> String {
    use onejudge::{
        CandidateAttempt, HarnessAttribution, JudgeKind, JudgeValue, JudgeVerdict, Message,
        NamedVerdict, PartyTelemetry, Report, SessionLink, Telemetry, TelemetryRole, Transcript,
        Usage,
    };

    let usage = Usage {
        input_tokens: Some(400),
        output_tokens: Some(90),
        cache_read_tokens: Some(0),
        cache_write_tokens: Some(0),
        cost_usd: Some(0.11),
    };
    // What the judge side of this dispatch consumed. No cache write and no cost:
    // the provider it ran on reports neither, and both are absences rather than
    // zeroes wherever they are served.
    let judge_usage = Usage {
        input_tokens: Some(51_204),
        output_tokens: Some(311),
        cache_read_tokens: Some(20_480),
        cache_write_tokens: None,
        cost_usd: None,
    };
    let judged = |turn: u32, ms| HarnessAttribution {
        role: TelemetryRole::Judge,
        turn_index: turn,
        ran: Some("codex:judge".into()),
        fell_through: Vec::new(),
        candidates: vec![CandidateAttempt {
            harness: "codex".into(),
            harness_id: "codex:judge".into(),
            variant: Some("judge".into()),
            model: Some(JUDGE_MODEL.to_owned()),
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
            usage: Some(judge_usage.clone()),
        }],
        history_file: None,
    };
    let observed = |turn: usize| SessionLink {
        session_id: format!("01a01f5{turn}-6168-72d1-b946-2251794e2fce"),
        role: TelemetryRole::Judge,
        turn_index: u32::try_from(turn).expect("a turn number"),
        started_at: JUDGE_BOUNDS[turn - 1].0.to_owned(),
        finished_at: Some(JUDGE_BOUNDS[turn - 1].1.to_owned()),
        history_id: None,
    };
    let report = Report {
        schema_version: onejudge::SCHEMA_VERSION,
        transcript: Transcript {
            messages: vec![
                Message::user(REVIEW_PROMPT),
                Message::assistant(REVIEW_REPLY),
            ],
        },
        verdicts: JUDGE_CRITERIA
            .into_iter()
            .map(|(criterion, reason)| {
                NamedVerdict::new(
                    criterion,
                    JudgeKind::Boolean,
                    JudgeVerdict {
                        value: JudgeValue::Bool(true),
                        reason: reason.to_owned(),
                        usage: None,
                    },
                )
            })
            .chain(std::iter::once(NamedVerdict::new(
                JUDGE_SCORED.0,
                JudgeKind::Numeric,
                JudgeVerdict {
                    value: JudgeValue::Number(JUDGE_SCORED.1),
                    reason: JUDGE_SCORED.2.to_owned(),
                    usage: None,
                },
            )))
            .collect(),
        assessment: Some(JUDGE_ASSESSMENT.to_owned()),
        completion_reason: Some("the change is approved".into()),
        settled_reason: None,
        usage: Some(usage.clone()),
        telemetry: Some(Telemetry {
            wall_ms: 3_000,
            agent: PartyTelemetry {
                usage: Some(usage.clone()),
                ..PartyTelemetry::default()
            },
            judge: PartyTelemetry {
                usage: Some(judge_usage.clone()),
                ..PartyTelemetry::default()
            },
            orchestration_ms: 100,
            sessions: vec![observed(1), observed(2)],
            attribution: vec![
                HarnessAttribution {
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
                },
                judged(1, 500),
                judged(2, 400),
            ],
        }),
        processes: Vec::new(),
        control: None,
        control_unavailable: None,
        supervisor_control: None,
        supervisor_control_unavailable: None,
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
        supervisor_control: None,
        supervisor_control_unavailable: None,
        stopped_early: false,
    };
    format!(
        "{}\n",
        serde_json::to_string(&report).expect("the report serializes")
    )
}

/// The run id of the malformed-releases fixture below.
pub const MALFORMED_RELEASE_RUN_ID: &str = "run-20260807-b6a5c4";

/// A run whose release records are each broken in one of the ways a producer can
/// break one.
///
/// A read surface reads what a producer wrote, and a producer that wrote a field
/// and left it blank, or wrote a stamp as a word, has said nothing rather than
/// said something wrong. Every record here is a plausible near-miss rather than
/// nonsense, and what the crate makes of each is the observable behaviour
/// `tests/e2e/server.rs` holds:
///
/// - a `release-observed` for the commit this node landed as that names no
///   `version`, so the node item is served no release rather than a nameless one;
/// - a `release-arrived` whose every field is blank, so the event carries no
///   `release` key rather than an empty object;
/// - a `release-wait` whose one entry names nothing it waits on, on the same
///   terms;
/// - a second `release-wait` whose entry began at a word rather than an instant,
///   which is served without a `since` and with everything else intact;
/// - a `release-adopted` whose version entries are each missing one of the three
///   things a version *is*, so no `versions` are served and the delivery still is.
pub fn write_malformed_releases(root: &Path, run: &str) -> PathBuf {
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
            "pid": 4260,
            "host": "a-recording-host",
            "started_at": START,
            "heartbeat_interval": 1_800,
            "adoptions": 0,
        })),
    )
    .expect("the launch record");
    let plan = json!({
        "schema_version": 2,
        "name": "malformed-releases",
        "concurrency": 1,
        "tasks": [
            { "id": NODE_ID, "persona": "worker", "task": "## What\nLand it." },
        ],
    });
    fs::write(dir.join("plan.json"), pretty(&plan)).expect("the plan");
    let at_node = json!({ "run_id": run, "node": NODE_ID });
    let at_run = json!({ "run_id": run });
    let mut journal = Journal::new("a-recording-host-4260");
    journal
        .emit(
            START,
            "pipeline",
            "run-started",
            at_run.clone(),
            json!({ "plan": plan }),
        )
        .emit(
            "2026-08-07T12:00:01.000Z",
            "pipeline",
            "release-wait",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "awaiting": [{ "identity": DEP_IDENTITY, "target": "crate" }],
            }),
        )
        .emit(
            "2026-08-07T12:00:02.000Z",
            "pipeline",
            "release-wait",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "awaiting": [{
                    "dep": "sdk",
                    "identity": DEP_IDENTITY,
                    "target": "crate",
                    "style": "automated",
                    "since": "a little while ago",
                    "last_answer": "not-released",
                }],
            }),
        )
        .emit(
            "2026-08-07T12:00:03.000Z",
            "pipeline",
            "release-arrived",
            at_node.clone(),
            json!({ "dep": "", "identity": "", "target": "  ", "version": "" }),
        )
        .emit(
            "2026-08-07T12:00:04.000Z",
            "pipeline",
            "release-adopted",
            at_node.clone(),
            json!({
                "node": NODE_ID,
                "delivery": "deferred",
                "versions": [
                    { "target": "crate", "version": DEP_VERSION },
                    { "identity": DEP_IDENTITY, "version": DEP_VERSION },
                    { "identity": DEP_IDENTITY, "target": "npm" },
                ],
            }),
        )
        .emit(
            "2026-08-07T12:00:05.000Z",
            "pipeline",
            "node-dispatched",
            at_node.clone(),
            json!({ "persona": "worker" }),
        )
        .emit(
            "2026-08-07T12:00:05.500Z",
            "vcs",
            "session-opened",
            at_node.clone(),
            json!({
                "token": "a-vcs-session-token",
                "identity": "github.com/nickderobertis/onepipeline-ui",
                "branch": "feature/malformed-releases",
                "base": "main",
                "worktree": "/a/recorded/worktree",
            }),
        )
        .emit(
            "2026-08-07T12:00:06.000Z",
            "vcs",
            "merge-completed",
            at_node.clone(),
            json!({
                "identity": "github.com/nickderobertis/onepipeline-ui",
                "sha": MERGE_SHA,
                "base": "main",
            }),
        )
        // The commit this node landed as, released — and the record names no
        // version, which is one of the three things a release is.
        .emit(
            "2026-08-07T12:00:07.000Z",
            "vcs",
            "release-observed",
            at_run,
            json!({
                "identity": "github.com/nickderobertis/onepipeline-ui",
                "target": "crate",
                "style": "automated",
                "landing_commit": MERGE_SHA,
            }),
        )
        .emit(
            "2026-08-07T12:00:08.000Z",
            "pipeline",
            "node-settled",
            at_node,
            json!({ "status": "done", "outcome": "shipped" }),
        );
    fs::write(dir.join("events.jsonl"), journal.text()).expect("the journal");
    dir
}
