//! Projecting the onepipeline SDK's run records onto the wire shapes.
//!
//! The SDK owns the records — the launch record, the merged event store, the
//! folded run state, the run's plan and its one recorded result, and the
//! telemetry document
//! [`crate::telemetry`] reads. This module owns only the projection onto what
//! `docs/contract.md` serves: it renames nothing the SDK already names and
//! computes nothing the SDK already computes, and every place it does derive
//! something (a dispatch key, a session key, the time a turn spent in a model)
//! is listed in AGENTS.md as a computation proposed for the SDK, where the agent
//! reading the CLI would see it too.
//!
//! Everything here is a pure function of a [`RunView`], the run directory, and
//! that document, so a payload can be built and asserted without a server.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use oneharness_core::io::history;
// Under the name of the library that writes them. Three vocabularies here are
// spelled alike and mean different things: `judge::Role` is who wrote a message,
// `judge::TelemetryRole` is which side ran, and this module's `Party` is what a
// member is to the pipeline.
use onejudge as judge;
use onepipeline::event::{Envelope, PipelineKind, Source};
use onepipeline::plan::{Node, Plan};
use onepipeline::views::{liveness_word, RunView};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::contract::{
    ArtifactId, Confined, ConversationId, DispatchId, NamedStore, NodeId, PathSegment,
    ReferenceKind, StoreRoot, TIMELINE_SCHEMA_VERSION,
};
use crate::filter::EventFilter;
// The sibling's spending party is imported under a name of its own: this module
// also has a `Party`, and the two answer different questions — which side of a
// conversation produced a record, and whose tokens a run spent.
use crate::telemetry::{BucketName, Party as Spender, RunTelemetry};

/// The bound on an artifact body served in one response.
///
/// A tail rather than the whole file: an artifact is a recorded log, which has
/// no size a producer promised, and a read surface that streams an unbounded one
/// into a browser is a read surface that can be made to exhaust its own memory.
pub const ARTIFACT_TAIL_BYTES: usize = 64 * 1024;

/// The transport parties `transportRoleSchema` holds, and exactly those.
///
/// A session is served under a *pair*: the transport half is the side of the
/// conversation that produced the record, and the semantic half is what the
/// dispatch was for. Without the first half an agent chain that lost its provider
/// and a judge chain that lost its own read as the same sentence, which is the
/// diagnosis a whole night was once lost to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Party {
    /// The side that does the work, and the one side every dispatch has.
    Agent,
    /// The side that supervises it.
    Judge,
    /// The lint tier, which reads the work under the semantic role of whoever
    /// did it and is told apart from them by nothing else.
    Llmlint,
}

impl Party {
    /// The word the wire carries this party as.
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Judge => "judge",
            Self::Llmlint => "llmlint",
        }
    }

    /// The party one recorded word names, or `None` when it names none this
    /// crate can serve: the field is a closed vocabulary a client switches on,
    /// so a member called anything else is not a party at all.
    fn named(value: &str) -> Option<Self> {
        match value {
            "agent" => Some(Self::Agent),
            "judge" => Some(Self::Judge),
            "llmlint" => Some(Self::Llmlint),
            _ => None,
        }
    }
}

/// The semantic roles a client may be given, from `agentRoleSchema`.
///
/// A persona outside this set is not served as an `agent_role` at all: the field
/// is a closed vocabulary a client switches on, so a persona it does not know
/// must be absent rather than present and unmatched.
// llmlint: ignore[invalid_states_unrepresentable] this is a *filter* over what a run recorded, not a domain the crate reasons in: a persona the wire's vocabulary has no member for must be dropped rather than parsed, and an enum would have to be turned straight back into these strings to serve them.
const AGENT_ROLES: [&str; 5] = ["orchestrator", "worker", "judge", "check-in", "pr-author"];

/// The kinds `onevcs` relays, as the wire strings that library writes.
///
/// The vocabulary is the sibling's rather than this crate's, so it is matched as
/// the strings the sibling emits rather than folded into an enum here — the same
/// reason the SDK keeps a relayed `EventKind` a wire string. What each payload
/// carries is `onevcs`'s own declaration, quoted where it is read.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] `onevcs` declares this vocabulary in a private module in every published version, so there is no type to generate from and nothing to compare against: the wire is the only declaration a consumer can reach. `tests/support/fixture_run.rs` writes these records as that library emits them and the goldens pin what this crate makes of them, which is the whole of the gate available. The sibling that *does* publish its own — `oneagentgraph` — is gated in `tests/contract.rs`.
mod vcs {
    /// `{token, identity, branch, base, worktree, clone, …}`.
    pub const SESSION_OPENED: &str = "session-opened";
    /// `{identity, elapsed, queue_position}` — one wait on one identity's lock.
    pub const LOCK_WAIT: &str = "lock-wait";
    /// `{verdict, command, output, preserved_log}`, with the log as an artifact.
    pub const GATE_VERDICT: &str = "gate-verdict";
    /// `{branch, remote, accepted}`.
    pub const PUSH: &str = "push";
    /// `{url, host, id, base, author}`.
    pub const CHANGE_OPENED: &str = "change-opened";
    /// `{name, required, status, from_status, conclusion}`, with the settled
    /// check's log as an artifact.
    pub const CHANGE_CHECK: &str = "change-check";
    /// `{url, sha}`.
    pub const CHANGE_MERGED: &str = "change-merged";
    /// `{identity, sha, base}` — the merge the host had queued completed.
    pub const MERGE_COMPLETED: &str = "merge-completed";
    /// `{branch, sha, provenance}` — work committed onto a preserved branch.
    pub const COMMIT_PRESERVED: &str = "commit-preserved";
    /// `{branch, base, attempts}` — the bounded resolve-and-requeue gave up.
    pub const SYNC_CONFLICT: &str = "sync-conflict";

    /// The command `onevcs` records for the gate that is git's own hook.
    ///
    /// A `pre-push` gate's verdict arrives as push output and nowhere else, so
    /// that library writes it under this exact command rather than a path; it is
    /// the only record of the hook having run at all.
    pub const PRE_PUSH_COMMAND: &str = "the repository's pre-push hook";

    /// The verdict word a gate that passed is recorded with.
    pub const GATE_PASSED: &str = "pass";

    /// The conclusions `onevcs` reads as not blocking a merge, in its own words.
    pub const GREEN_CONCLUSIONS: [&str; 3] = ["success", "skipped", "neutral"];
}

/// The kinds `oneagentgraph` relays, and the keys the usage it relays is written
/// with, on the same terms as the `onevcs` vocabulary beside it: matched as the
/// wire strings that library writes, because the vocabulary is the sibling's.
///
/// Unlike `onevcs`, that library declares most of this vocabulary in a public
/// module, so `tests/contract.rs` holds those names here to the sibling's own
/// type rather than to a second reading of the wire. Two of them it does not,
/// and each says so where it is declared.
pub mod graph {
    /// `{kind, name, detail, truncated}` — one bounded tool summary, published
    /// from inside a turn rather than after it.
    pub const TURN_ACTIVITY: &str = "turn-activity";
    /// A turn finished, carrying the [`USAGE`] it consumed.
    pub const TURN_COMPLETED: &str = "turn-completed";
    /// Where that usage sits on the payload.
    pub const USAGE: &str = "usage";
    /// Input tokens.
    ///
    /// The five keys here are `onejudge::Usage`'s, not `oneagentgraph`'s own
    /// `event::Usage`, which nothing writes — see `src/AGENTS.md`.
    /// `tests/contract.rs` holds them to the type that writes them.
    pub const INPUT_TOKENS: &str = "input_tokens";
    /// Output tokens.
    pub const OUTPUT_TOKENS: &str = "output_tokens";
    /// Tokens read from the prompt cache.
    pub const CACHE_READ_TOKENS: &str = "cache_read_tokens";
    /// Tokens written to the prompt cache.
    pub const CACHE_WRITE_TOKENS: &str = "cache_write_tokens";
    /// What the turn cost.
    pub const COST_USD: &str = "cost_usd";

    /// A turn began on one side of a member's conversation.
    pub const TURN_STARTED: &str = "turn-started";
    /// The producer's own 1-based number for the turn a [`TURN_STARTED`] opens.
    ///
    /// The one name in this module with no type behind it: `oneagentgraph` builds
    /// this payload inline rather than from a declared struct, so — like the
    /// `onevcs` vocabulary — the wire is the only declaration a consumer can
    /// reach. It is read rather than counted because a turn that called no tool
    /// relays no `turn-started` at all, so the position of one among the records
    /// a session relayed is not the number the producer gave it. That number is
    /// the counter the stored report shares between its `telemetry.sessions` and
    /// its `telemetry.attribution`, which is what a turn is joined to its own
    /// measurements by.
    pub const TURN: &str = "turn";
    /// `{member, delivered, input_bytes, reason}` — an operator asked a member's
    /// in-flight turn to do something else. Published for every interrupt,
    /// delivered or not, which is what makes "the lever was pulled and nothing
    /// happened" a thing a reader of the run can see.
    pub const TURN_INTERRUPTED: &str = "turn-interrupted";
    /// A member's process died: whatever it was doing, it is not doing it now.
    pub const MEMBER_DIED: &str = "member-died";
    /// A member settled, which ends its turns.
    pub const MEMBER_SETTLED: &str = "member-settled";
    /// The member a record is about, on a [`TURN_INTERRUPTED`] payload as well as
    /// in the labels.
    pub const MEMBER: &str = "member";
    /// Whether the run took ownership of the redirection.
    pub const DELIVERED: &str = "delivered";
    /// How many bytes of redirection were offered.
    pub const INPUT_BYTES: &str = "input_bytes";
    /// Why the delivery did not land — carried exactly when it did not.
    pub const REASON: &str = "reason";
}

/// What one accepted live edit compiled to, as `onepipeline` writes it on an
/// `edit-committed` payload.
///
/// The SDK declares `edits::Operation` and `edits::Delivery` in a private module,
/// so — like the `onevcs` vocabulary above and unlike `oneagentgraph`'s — the wire
/// is the only declaration a consumer can reach. What is gated instead is the
/// *submitted* command: `onepipeline::channel::Command` is public, so
/// `tests/contract.rs` holds this crate's reading of a `context` edit to that
/// library's own type, and `tests/support/fixture_run.rs` writes the operations as
/// the reconciler compiles them.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] `onepipeline` declares `edits::Operation` and `edits::Delivery` in a private module in 0.1.7, so there is no type to generate from and nothing to compare a copy against. Making that module public is the proposal recorded in src/AGENTS.md; until it lands, the gate available is the public `channel::Command` beside it, which `tests/contract.rs` asserts, plus the goldens written from a real reconciler's output.
mod edits {
    /// The compiled mutations one accepted edit became.
    pub const OPERATIONS: &str = "operations";
    /// The tag each operation is discriminated by.
    pub const KIND: &str = "kind";
    /// `{node, note, delivery}` — a planner note reached a node.
    pub const CONTEXT_ADDED: &str = "context-added";
    /// The node the note was for.
    pub const NODE: &str = "node";
    /// Where the note actually went: [`LIVE`] or [`DEFERRED`].
    pub const DELIVERY: &str = "delivery";
    /// Into the turn that was running when the edit arrived.
    pub const LIVE: &str = "live";
    /// Onto the node's next dispatch. Also what a record written before delivery
    /// had modes means, which is why an absent `delivery` reads as this one.
    pub const DEFERRED: &str = "deferred";
}

/// The party a record names as its own, when it names one this crate serves.
///
/// Read in the order the producing libraries stamp it: `oneagentgraph` writes a
/// `role` on the records that carry one, the graph member is the party a graph
/// declared a member for, and a persona names the side the member runs under. A
/// word outside `transportRoleSchema` names no party at all, so it is dropped
/// rather than served for a client to fail on.
fn named_transport_role(event: &Envelope) -> Option<Party> {
    let named = |value: Option<&str>| Party::named(value?);
    named(event.payload.get("role").and_then(Value::as_str))
        .or_else(|| named(event.labels.extra.get("role").and_then(Value::as_str)))
        .or_else(|| named(event.labels.extra.get("member").and_then(Value::as_str)))
        .or_else(|| named(event.labels.persona.as_deref()))
}

/// The party that produced one record.
///
/// [`Party::Agent`] is the answer for a record that names none, and a default
/// rather than a stamp: it is the party that is left when nothing else was
/// named, and it is the one side every dispatch has.
fn transport_role(event: &Envelope) -> Party {
    named_transport_role(event).unwrap_or(Party::Agent)
}

/// The party a group of records belongs to: the first of them that names one.
///
/// A session is one party's side of a conversation, and only some of its records
/// say so — a tool summary carries no `role` where the settle that follows it
/// does. Taking the first answer rather than each record's own keeps every span
/// and every link of one session under the one party that ran it.
fn relayed_transport_role<'a>(events: impl IntoIterator<Item = &'a Envelope>) -> Party {
    events
        .into_iter()
        .find_map(named_transport_role)
        .unwrap_or(Party::Agent)
}

/// Now, as the envelope's `observed_at`.
#[must_use]
pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

/// Epoch milliseconds as the stamp every other record in the stream is written
/// as: RFC 3339, millisecond precision, UTC.
///
/// Spelled out rather than left to the default rendering, which drops trailing
/// zeros: a derived instant has to be the same shape as a recorded one, or a
/// client comparing two stamps is comparing two spellings.
fn rfc3339_of(millis: i128) -> Option<String> {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    OffsetDateTime::from_unix_timestamp_nanos(millis.checked_mul(1_000_000)?)
        .ok()?
        .format(&format)
        .ok()
}

/// An RFC 3339 timestamp as epoch milliseconds, or `None` if it is not one.
#[must_use]
pub fn millis_of(ts: &str) -> Option<i128> {
    OffsetDateTime::parse(ts, &Rfc3339)
        .ok()
        .map(|at| at.unix_timestamp_nanos() / 1_000_000)
}

/// The opaque, stable, irreversible name of the session that launched a run.
///
/// The raw launching session id may be sensitive and is never served; this is
/// what lets a client group runs by the planner that launched them without it.
fn session_key(session: &str) -> String {
    let digest = Sha256::digest(session.as_bytes());
    digest[..6].iter().fold(String::new(), |mut out, byte| {
        out.push_str(&format!("{byte:02x}"));
        out
    })
}

/// A launcher name from the closed vocabulary a client switches on.
fn launcher_word(launcher: &str) -> &'static str {
    match launcher {
        "claude-code" => "claude-code",
        "codex" => "codex",
        _ => "unknown",
    }
}

/// The per-node statuses the wire's vocabulary holds, and exactly those.
///
/// Closed because a client switches on it exhaustively: a word outside this set
/// has no rendering, and the run's recorded result can hold any word at all.
// llmlint: ignore-block[invalid_states_unrepresentable] the same filter, over a field the run's own result can hold any word at all in: `status_word` maps what the run wrote onto exactly this set, and `node_counts` still reports the raw word, which an enum would have destroyed.
const NODE_STATUSES: [&str; 11] = [
    "pending",
    "running",
    "waiting",
    "blocked",
    "skipped",
    "done",
    "not-completed",
    "failed",
    "parked",
    "cancelled",
    "unknown",
];
// llmlint: ignore-end[invalid_states_unrepresentable]

/// The status word a client renders, from whatever the run recorded.
///
/// One translation: the SDK's `ready` — eligible now, nothing dispatched — has
/// no member in the client's vocabulary, and `pending` is what that vocabulary
/// calls a node that has not started. Anything else the vocabulary does not hold
/// is `unknown`, rather than passed through for a client to fail on or mapped
/// onto a neighbouring meaning it does not have. The word itself is not lost:
/// `node_counts` reports what the run actually wrote.
fn status_word(status: &str) -> &str {
    if status == "ready" {
        return "pending";
    }
    if NODE_STATUSES.contains(&status) {
        status
    } else {
        "unknown"
    }
}

/// Whether a status is one the journal can record for a node, as opposed to one
/// derived on every read. Only recorded ones belong in `node_states`.
fn is_recorded_state(status: &str) -> bool {
    matches!(
        status,
        "running" | "done" | "failed" | "waiting" | "parked" | "cancelled"
    )
}

/// The key that groups the sessions of one node's dispatch.
///
/// Derived rather than recorded: the SDK's journal stamps a dispatch with its
/// run and node but mints no id for it, and schema 10 serves one. Execution is
/// continuous, so the pair is the whole of what identifies a dispatch — the
/// round that used to be its third part is not a thing any run has — and the
/// derived key is stable across reads and across processes.
///
/// A node that is re-dispatched keeps the key: the SDK re-asks a dispatch that
/// produced nothing and records each attempt as its own `node-dispatched`
/// carrying `attempt`, and every one of them is the same node's same work. The
/// key groups the sessions of a node's dispatch, which is what a reader telling
/// a worker's transcript from its judge's needs it for.
///
/// A [`DispatchId`] rather than a bare `String`, and `None` when the run and
/// node on disk cannot form one: a client reads `dispatch_id` to ask about the
/// dispatch, so minting one the contract's own boundary would reject is the
/// drift the newtype exists to prevent.
fn dispatch_key(run: &str, node: &str) -> Option<DispatchId> {
    DispatchId::try_from(format!("{run}.{node}")).ok()
}

/// Read one JSON document, or `None` if it is missing or unreadable.
///
/// A run directory is recorded, not curated: a half-written result is a file
/// this read skips, not a run it refuses to serve.
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// One run, as `GET /api/v2/runs` lists it.
///
/// `telemetry` is what the sibling aggregated for this run, or `None` when it
/// could not be asked — in which case every timing the row carries is absent,
/// which is what an unknown clock is.
#[must_use]
pub fn run_summary(view: &RunView, telemetry: Option<&RunTelemetry>) -> Value {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for recorded in recorded_statuses(view).values() {
        *counts.entry(recorded.status.clone()).or_insert(0) += 1;
    }
    let mut summary = Map::new();
    summary.insert("run_id".into(), json!(view.paths.run));
    summary.insert("state".into(), json!(state_word(view)));
    summary.insert("phase".into(), json!(phase_word(view)));
    summary.insert("last_event".into(), last_event(view));
    if let Some(at) = view.state.last_write_at {
        summary.insert("last_progress_at".into(), json!(at / 1_000));
    }
    summary.insert("timing_quality".into(), json!(timing_quality(view)));
    summary.insert("linkage_quality".into(), json!("labelled"));
    summary.insert(
        "timing".into(),
        timing(telemetry, &measured(view, &view.events)),
    );
    summary.insert("node_counts".into(), json!(counts));
    summary.insert("launch".into(), launch(view));
    Value::Object(summary)
}

/// Every node's status as the run itself last wrote it, in the run's own words.
///
/// The same derivation the graph payload renders from, so a list row and the
/// graph it opens cannot describe different graphs — the disagreement an
/// operator would otherwise see between the two.
///
/// Three accounts, in the order they are worth: **what the journal settled for
/// that node**, then **what the run's own recorded result held for it**, then
/// **what the graph derives for it**. Rounds are gone, and with them the reason
/// this used to prefer a recorded document wholesale — a closed round's result
/// was the only account of it that survived the *next* round starting, and
/// nothing overwrites the fold now.
///
/// The order is what the three *are*. The first two are records of the node; the
/// third is a gate recomputed from its dependencies on every read, so it is what
/// a node nothing has recorded reads as and never an overrule of something that
/// did. `result.json` — which the SDK rewrites whenever a driver closes out —
/// holds words no settlement carried, and is the whole account for a run whose
/// journal this host cannot fold.
///
/// It is the same precedence [`node_result`] keeps, so a node's status and its
/// result can never come from two different accounts of it.
///
/// The words are unmapped on purpose: a count reports what the run wrote, where
/// a status a client switches on cannot.
fn recorded_statuses(view: &RunView) -> BTreeMap<String, Recorded> {
    let document: BTreeMap<String, Recorded> = recorded_result(view).into_iter().collect();
    let mut statuses: BTreeMap<String, Recorded> = view
        .state
        .statuses()
        .into_iter()
        .map(|(node, derived)| {
            let outcome = || view.state.outcomes.get(&node).cloned();
            // What the journal settled for this node, which is an account of the
            // node itself rather than of the graph around it.
            let settled = view.state.recorded.get(&node).map(|status| Recorded {
                status: status.status().as_str().to_owned(),
                outcome: outcome(),
            });
            let recorded = settled
                .or_else(|| document.get(&node).cloned())
                .unwrap_or_else(|| Recorded {
                    status: derived.as_str().to_owned(),
                    outcome: outcome(),
                });
            (node, recorded)
        })
        .collect();
    // A node the document names and the graph does not: a run whose plan this
    // host cannot read at all still counts what its result recorded.
    for (node, recorded) in document {
        statuses.entry(node).or_insert(recorded);
    }
    statuses
}

/// Every node the run's own recorded result has an entry for, in its words.
fn recorded_result(view: &RunView) -> Vec<(String, Recorded)> {
    read_json(&view.paths.result())
        .and_then(|result| result["nodes"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|node| {
            Some((
                node["id"].as_str()?.to_owned(),
                Recorded {
                    status: node["status"].as_str()?.to_owned(),
                    outcome: node["outcome"].as_str().map(str::to_owned),
                },
            ))
        })
        .collect()
}

/// What one node's last account of itself said: its status word, and the outcome
/// word beside it when it recorded one.
///
/// Both are the run's own words, unmapped. The recorded result can hold any word
/// at all in either field, and `node_counts` reports exactly what it held; the
/// mapping onto the vocabulary a client switches on happens where a client is
/// being served, in [`status_word`] and [`failure_class`].
#[derive(Debug, Clone)]
// llmlint: ignore-block[invalid_states_unrepresentable] a narrower type here would refuse a word the run really did write, which is the one thing this must not do: it carries the account rather than deciding what it means.
struct Recorded {
    status: String,
    outcome: Option<String>,
}
// llmlint: ignore-end[invalid_states_unrepresentable]

/// The run's own attribution to the session that launched it.
fn launch(view: &RunView) -> Value {
    let mut record = Map::new();
    record.insert("launch_id".into(), json!(view.paths.run));
    record.insert(
        "launcher".into(),
        json!(launcher_word(&view.launch.launcher)),
    );
    if !view.launch.session.is_empty() {
        record.insert(
            "session_key".into(),
            json!(session_key(&view.launch.session)),
        );
    }
    Value::Object(record)
}

/// How the run is being driven, as one lowercase word.
fn state_word(view: &RunView) -> String {
    liveness_word(view).to_lowercase().replace(' ', "-")
}

/// Which part of its loop the run is in, derived from what it recorded.
///
/// The engine's loop is continuous, so these name what it is *doing* rather than
/// where in a batch it is. They are ordered by what a reader has to act on
/// soonest, and the first that holds wins: a stopped run is over whatever else it
/// records, a graph whose every node is done has nothing left to do, a decision
/// holds a subtree back until somebody answers it, an unread surface is a
/// question in a queue, and a run with work in flight is dispatching. `waiting`
/// is the honest last word — the loop is converging and nothing is dispatched
/// right now, which under rounds was a run between them and is now a run whose
/// frontier is empty. `starting` is the run that has no graph to converge on
/// yet, which is what a launch that has recorded nothing since really is.
fn phase_word(view: &RunView) -> &'static str {
    if view.state.stop_recorded() {
        return "finished";
    }
    let statuses = view.state.statuses();
    // A run with no graph yet has not begun converging on anything: a launch that
    // has recorded nothing since, or one whose plan this host cannot read.
    if statuses.is_empty() {
        return "starting";
    }
    if statuses.values().all(|status| status.as_str() == "done") {
        return "settled";
    }
    if !view.state.decisions_pending.is_empty() || view.state.awaiting_human_action() {
        return "deciding";
    }
    if view.state.surfaces_queued > view.state.surfaces_read {
        return "surfacing";
    }
    if statuses.values().any(|status| status.as_str() == "running") {
        return "dispatching";
    }
    "waiting"
}

/// The kind of the run's most recent event, or `null` for a run that has
/// recorded none — which is how a just-launched run reads on disk.
fn last_event(view: &RunView) -> Value {
    view.events
        .last()
        .map_or(Value::Null, |event| json!(event.kind.0))
}

/// How completely the run's own clock is accounted for.
///
/// A run still being driven is `partial` and one that has stopped driving is
/// `complete`, which is the same distinction the round-open flag used to draw:
/// what a run has not finished doing it has not finished measuring.
fn timing_quality(view: &RunView) -> &'static str {
    if view.events.is_empty() {
        "legacy"
    } else if view.state.stop_recorded() || graph_complete(view) {
        "complete"
    } else {
        "partial"
    }
}

/// Whether every node the run recorded has settled `done`.
fn graph_complete(view: &RunView) -> bool {
    let statuses = view.state.statuses();
    !statuses.is_empty() && statuses.values().all(|status| status.as_str() == "done")
}

/// What one node's own records *measured*, as against what the run's clock shows.
///
/// The wall clock is the sibling's to attribute — [`crate::telemetry`] reads the
/// document it aggregates — and these are the measurements no fold of that clock
/// can produce: how long each party's own harness invocations ran, which only the
/// invocation reports, and how much of a node's work each party did. Every field
/// is `None` until a record fills it, and `None` is not zero: a run whose judge
/// never settled a member has no judge time, where one whose judge answered
/// instantly has zero of it. Only the second is a measurement.
#[derive(Debug, Default, Clone, Copy)]
struct Measured {
    /// How long a party's own harness invocations ran, summed from every candidate
    /// that *ran* in a settled member's stored report.
    ///
    /// Named for what it holds: a report records `duration_ms` per invocation,
    /// which is the elapsed time of the harness process that ran the turn, and
    /// nothing on this wire carries a model's own clock. The wire calls these
    /// `*_model_ms` — a client-pinned key that does not move with the
    /// measurement, spelled once where they are served.
    agent_invocation_ms: Option<u64>,
    judge_invocation_ms: Option<u64>,
    llmlint_invocation_ms: Option<u64>,
    /// Time inside a tool call. `turn-activity` reports *what* a turn did and
    /// carries no interval, so nothing measures this yet.
    tool_ms: Option<u64>,
    /// How many relayed records the lint party produced, so a party that
    /// recorded work with no timing on it is still visible as having run.
    lint_records: u64,
}

/// Add one measured span to a slot, which is what turns it from unmeasured into
/// a measurement of zero or more.
fn measure(slot: &mut Option<u64>, ms: u64) {
    *slot = Some(slot.unwrap_or(0) + ms);
}

/// Seconds a record wrote as a float, as whole milliseconds.
fn seconds_as_ms(value: Option<&Value>) -> Option<u64> {
    let seconds = value?.as_f64()?;
    if seconds.is_finite() && seconds >= 0.0 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        // Bounded above by any run's own clock, and non-negative by the guard.
        Some((seconds * 1_000.0) as u64)
    } else {
        None
    }
}

/// How long the invocations one report's run really made took, summed.
///
/// Both of the report's roles count: both are invocations the member itself made,
/// and the party this is attributed to is the *member's* role in the pipeline.
fn invocation_ms(report: &judge::Report) -> Option<u64> {
    let mut total = None;
    for attribution in &report.telemetry.as_ref()?.attribution {
        for candidate in attribution.candidates.iter().filter(|c| c.ran) {
            if let Some(ms) = candidate.duration_ms {
                measure(&mut total, ms);
            }
        }
    }
    total
}

/// Everything the given records measured about their own turns, walked once.
///
/// The timing comes off each settled member's stored report rather than off a
/// record: a `turn-completed` carries the whole dispatch's usage and no interval
/// at all, and the one place an invocation's elapsed time is recorded is the
/// report's own attribution.
fn measured<'a>(view: &RunView, events: impl IntoIterator<Item = &'a Envelope>) -> Measured {
    let mut totals = Measured::default();
    for event in events {
        if event.source != Source::Agentgraph || event.kind.0 == graph::TURN_ACTIVITY {
            continue;
        }
        let party = transport_role(event);
        if party == Party::Llmlint {
            totals.lint_records += 1;
        }
        if event.kind.0 != graph::MEMBER_SETTLED {
            continue;
        }
        let Some(ms) = read_report(view, event).as_ref().and_then(invocation_ms) else {
            continue;
        };
        match party {
            Party::Judge => measure(&mut totals.judge_invocation_ms, ms),
            Party::Llmlint => measure(&mut totals.llmlint_invocation_ms, ms),
            Party::Agent => measure(&mut totals.agent_invocation_ms, ms),
        }
    }
    totals
}

/// The run's timing, in the eight-way breakdown the wire carries.
///
/// The eight are the sibling's own: `onepipeline` attributes a run's wall clock
/// into exactly these buckets, keeps the invariant that the measured ones sum to
/// the whole, and serves a bucket nothing measures as absent. This reads that
/// document rather than folding the clock again, so the two readings of where a
/// run's time went cannot come apart.
///
/// What it adds is the one thing that document does not carry: how long each
/// party's own harness invocations ran, which only an invocation reports. And
/// what it never adds is a zero — an unmeasured lane is served `null`, here and
/// in the fractions, because a zero is a measurement and reading one for an
/// absence is how a run comes to look cheaper than it was.
fn timing(document: Option<&RunTelemetry>, measured: &Measured) -> Value {
    let wall = document.map(|document| document.wall_ms);
    let bucket = |name| document.and_then(|document| document.bucket(name));
    let seconds = |ms: Option<u64>| ms.map(|ms| ms / 1_000);
    let fraction = |part: Option<u64>| match (part, wall) {
        (Some(part), Some(wall)) => Some(if wall == 0 {
            0.0
        } else {
            #[allow(clippy::cast_precision_loss)]
            // A millisecond count; f64 is exact well past any run's.
            let ratio = part as f64 / wall as f64;
            ratio
        }),
        _ => None,
    };
    let mut timing = Map::new();
    for (lane, name) in [
        ("agent_seconds", BucketName::Agent),
        ("judge_seconds", BucketName::Judge),
        ("llmlint_seconds", BucketName::Llmlint),
        ("gate_seconds", BucketName::Gate),
        ("publication_wait_seconds", BucketName::PublicationWait),
        ("lock_wait_seconds", BucketName::LockWait),
        ("setup_seconds", BucketName::Setup),
        ("scheduling_seconds", BucketName::Scheduling),
    ] {
        timing.insert(lane.into(), json!(seconds(bucket(name))));
    }
    timing.insert("wall_seconds".into(), json!(seconds(wall)));
    timing.extend(per_party(measured, "_ms", &|ms| json!(ms)));
    timing.insert("tool_ms".into(), json!(measured.tool_ms));
    // The wire keeps a lane for the run waiting on a planner or a person, and the
    // sibling's vocabulary folds both into `scheduling`. Nothing measures the two
    // apart, so this is absent rather than a share of a bucket that is not it.
    timing.insert("idle_orchestration_ms".into(), Value::Null);
    // What the wall clock has no measured home for. Computed from the document's
    // own invariant — its measured buckets sum exactly to the whole — so an
    // unmeasured bucket grows this rather than reading as a measured nothing.
    timing.insert(
        "unattributed_ms".into(),
        json!(document.map(|document| document.wall_ms.saturating_sub(document.measured_ms()))),
    );
    timing.insert("wall_ms".into(), json!(wall));

    let mut fractions = Map::new();
    fractions.extend(per_party(measured, "", &|ms| json!(fraction(ms))));
    fractions.insert("tool".into(), json!(fraction(measured.tool_ms)));
    fractions.insert("idle_orchestration".into(), Value::Null);
    for (lane, name) in [
        ("lock_wait", BucketName::LockWait),
        ("setup", BucketName::Setup),
        ("scheduling", BucketName::Scheduling),
    ] {
        fractions.insert(lane.into(), json!(fraction(bucket(name))));
    }
    timing.insert("fractions".into(), Value::Object(fractions));
    Value::Object(timing)
}

/// The wire's three per-party lanes, under the key it pins for each.
///
/// One function because the same three lanes are served four times — the timings,
/// their fractions, the presence flags beside them, and the node-level rollup —
/// and four copies of the mapping are four chances for two of them to disagree
/// about a party. `suffix` is what the wire appends to the lane: `_ms` for a
/// measurement, nothing for a fraction of the clock.
///
// llmlint: ignore[names_match_behavior] the `*_model` keys are the client's pinned contract — `timingSchema` requires them — and what this stack can measure per party is a report's invocation `duration_ms`. `Measured` names the value for what it is; `src/AGENTS.md` holds why the key does not move with it, and the upstream change that reconciles them.
fn per_party(
    measured: &Measured,
    suffix: &str,
    render: &dyn Fn(Option<u64>) -> Value,
) -> Vec<(String, Value)> {
    [
        ("agent", measured.agent_invocation_ms),
        ("judge", measured.judge_invocation_ms),
        ("llmlint", measured.llmlint_invocation_ms),
    ]
    .into_iter()
    .map(|(party, ms)| (format!("{party}_model{suffix}"), render(ms)))
    .collect()
}

/// What each party spent, as the sibling's document reports it.
///
/// Present whether or not anything was recorded, because the shape is required
/// and a missing party would read as "no cost" rather than "unknown" — and every
/// field of a party nothing reported for stays `null` for the same reason. The
/// split is the SDK's: it reads each side's own onejudge report, which is a
/// document this server has no business opening.
fn usage(document: Option<&RunTelemetry>) -> Value {
    let party = |party: Spender| {
        let spent = document
            .map(|document| document.usage_of(party))
            .unwrap_or_default();
        json!({
            "input_tokens": spent.input,
            "output_tokens": spent.output,
            "cache_read_tokens": spent.cache_read,
            "cache_write_tokens": spent.cache_write,
            "cost_usd": spent.cost_usd,
        })
    };
    json!({
        "agent": party(Spender::Agent),
        "judge": party(Spender::Judge),
        "llmlint": party(Spender::Llmlint),
        "total": party(Spender::Total),
    })
}

/// Which measured timings the records actually carried.
///
/// Kept beside the timings themselves, which are now absent when unmeasured: a
/// conforming client reads either, and a producer that measures a real zero says
/// so here rather than being indistinguishable from one that measured nothing.
fn timing_presence(measured: &Measured) -> Value {
    let mut presence: Map<String, Value> = per_party(measured, "_ms", &|ms| json!(ms.is_some()))
        .into_iter()
        .collect();
    presence.insert("tool_ms".into(), json!(measured.tool_ms.is_some()));
    Value::Object(presence)
}

/// The sessions the merged event store shows doing one node's work.
///
/// A relayed agent-graph envelope carries the session it came from in its
/// labels; that is the whole of what the journal links, so a session appears
/// here exactly when one is recorded and never inferred from anything else.
fn sessions_of(view: &RunView, node: &str) -> Vec<Value> {
    let mut seen: BTreeMap<String, Vec<&Envelope>> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph || event.labels.node.as_deref() != Some(node) {
            continue;
        }
        let Some(session) = event
            .labels
            .extra
            .get("session")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        seen.entry(session.to_owned()).or_default().push(event);
    }
    seen.into_iter()
        .map(|(session, events)| {
            let first = events.first().copied();
            let mut link = Map::new();
            link.insert("session_id".into(), json!(session));
            // The party that ran this session, from the session's own records:
            // an agent chain that lost its provider and a judge chain that lost
            // its own are the same failure until this says which one it was.
            link.insert(
                "role".into(),
                json!(relayed_transport_role(events.iter().copied()).as_str()),
            );
            if let Some(role) = agent_role(first.and_then(|event| event.labels.persona.as_deref()))
            {
                link.insert("agent_role".into(), json!(role));
            }
            if let Some(event) = first {
                link.insert("started_at".into(), json!(event.ts));
            }
            Value::Object(link)
        })
        .collect()
}

/// The semantic role a persona names, when it names one the client knows.
fn agent_role(persona: Option<&str>) -> Option<&'static str> {
    let persona = persona?;
    AGENT_ROLES.into_iter().find(|role| *role == persona)
}

/// The statuses that mean this node's own work ran, or was cut short, without
/// finishing — the ones a reader is owed a reason for.
fn is_lost(status: &str) -> bool {
    matches!(status, "failed" | "not-completed" | "cancelled")
}

/// How a lost outcome failed, from the closed vocabulary a client switches on.
///
/// Derived from the outcome word the run recorded, because that is the only
/// classification a onepipeline journal carries: the categories a run can name
/// are what the wire's own `failureClassSchema` calls `gate`, `checks`,
/// `publication` and `timeout`. Anything else that ran and stopped is the
/// dispatch's own failure, and anything that never ran is `unknown` rather than
/// a category this crate picked for it.
///
/// This is one of the computations AGENTS.md proposes moving into the SDK: the
/// agent reading the CLI sees the outcome word and not the class.
fn failure_class(view: &RunView, node: &str, recorded: &Recorded) -> Option<&'static str> {
    if !is_lost(status_word(&recorded.status)) {
        return None;
    }
    Some(match recorded.outcome.as_deref() {
        Some("gate-failed") => "gate",
        Some("checks-failed") => "checks",
        Some("publication-failed") => "publication",
        Some("timed-out") => "timeout",
        _ if view.state.dispatched_at.contains_key(node) => "agent",
        _ => "unknown",
    })
}

/// Whether a relayed envelope is a turn of its session, rather than something
/// recorded from inside one.
///
/// `oneagentgraph` publishes a tool summary *during* a turn — that is the whole
/// point of `turn-activity`, which is streamed live rather than held back until
/// the turn is done — so counting one as a turn would report a turn that had not
/// happened. It is carried on the turn it belongs to instead; see
/// [`conversation_document`].
///
/// A `turn-interrupted` is published from inside a turn for exactly the same
/// reason and is excluded on exactly the same terms: it is the moment a planner
/// redirected the turn that was running, not a turn of its own, and counting one
/// would put a phantom turn in the transcript of every node anybody corrected.
/// It reaches a reader as the node's own timeline record instead, carrying the
/// redirection — see [`redirection`].
///
/// And a member's own lifecycle — its settlement, its death — is not a turn
/// either, which is a fact about the wire rather than a judgement: `oneagentgraph`
/// stamps a `session` label on the `turn-*` kinds and on no other, so a record
/// that is not one of those can never *be* a transcript turn. Admitting one here
/// counted a turn no transcript could show, and the count beside a node then
/// disagreed with the transcript a reader opens from it by one per settled
/// member. A settlement still reaches a reader — as the node's own evidence, and
/// as the report the transcript beside it is assembled from.
fn is_turn_record(event: &Envelope) -> bool {
    event.source == Source::Agentgraph
        && (event.kind.0 == graph::TURN_STARTED || event.kind.0 == graph::TURN_COMPLETED)
}

/// How many turns a node — or the whole run — has had relayed to it.
///
/// One relayed turn envelope is one turn: that is what [`conversations`] serves
/// as a transcript turn, so the count beside a node and the transcript a reader
/// opens from it cannot disagree.
fn turns_of(view: &RunView, node: Option<&str>) -> usize {
    view.events
        .iter()
        .filter(|event| is_turn_record(event))
        .filter(|event| node.is_none_or(|node| event.labels.node.as_deref() == Some(node)))
        .count()
}

/// The events one node recorded, whichever library produced them.
fn events_of<'a>(view: &'a RunView, node: &str) -> Vec<&'a Envelope> {
    view.events
        .iter()
        .filter(|event| event.labels.node.as_deref() == Some(node))
        .collect()
}

/// One node's telemetry row.
fn node_telemetry(view: &RunView, node: &str, recorded: &Recorded) -> Value {
    let measurements = measured(view, events_of(view, node));
    let mut row = Map::new();
    row.insert("node".into(), json!(node));
    row.insert("status".into(), json!(status_word(&recorded.status)));
    if let Some(outcome) = &recorded.outcome {
        row.insert("outcome".into(), json!(outcome));
    }
    if let Some(branch) = view.state.branches.get(node) {
        row.insert("branch".into(), json!(branch));
    }
    if let Some(class) = failure_class(view, node, recorded) {
        // The classification alone: onepipeline records no classified *detail*, so
        // serving one would be this crate writing the sentence. A client falls
        // through to the prose the settlement itself recorded instead.
        row.insert("failure".into(), json!({ "class": class }));
    }
    // No per-node usage: the sibling folds what a run spent, not what each of
    // its nodes did, and splitting it here would be this crate answering a
    // question with a second reading of the records the SDK already read.
    row.insert("sessions".into(), json!(sessions_of(view, node)));
    row.insert("turns".into(), json!(turns_of(view, Some(node))));
    // What the lint transport recorded here, which is a party of the pair rather
    // than a producer of its own: a member the graph ran under that transport
    // relays its records like any other.
    row.insert("lint".into(), json!(measurements.lint_records));
    row.insert("timing_quality".into(), json!(timing_quality(view)));
    row.insert("linkage_quality".into(), json!("labelled"));
    row.insert("timing_presence".into(), timing_presence(&measurements));
    Value::Object(row)
}

/// The run's own telemetry document, as `GET /api/v2/runs/{run}` serves it.
fn run_telemetry(view: &RunView, telemetry: Option<&RunTelemetry>) -> Value {
    let statuses = recorded_statuses(view);
    let nodes: Vec<Value> = statuses
        .iter()
        .map(|(node, recorded)| node_telemetry(view, node, recorded))
        .collect();
    let measurements = measured(view, &view.events);
    // What the run measured at a node, rather than across its whole clock: the
    // same records, filtered to the ones a node's own work produced.
    let at_nodes = measured(
        view,
        view.events
            .iter()
            .filter(|event| event.labels.node.is_some()),
    );
    let mut run = Map::new();
    run.insert("run_id".into(), json!(view.paths.run));
    run.insert("state".into(), json!(state_word(view)));
    run.insert("phase".into(), json!(phase_word(view)));
    run.insert("last_event".into(), last_event(view));
    if let Some(at) = view.state.last_write_at {
        run.insert("last_progress_at".into(), json!(at / 1_000));
    }
    run.insert("timing".into(), timing(telemetry, &measurements));
    run.insert("nodes".into(), Value::Array(nodes));
    run.insert("usage".into(), usage(telemetry));
    run.insert("timing_quality".into(), json!(timing_quality(view)));
    run.insert("linkage_quality".into(), json!("labelled"));
    run.insert("timing_presence".into(), timing_presence(&measurements));
    run.insert("sources".into(), json!(["events.jsonl", "launch.json"]));
    // The same discipline one level down: a party that reported no turn at a
    // node has no time there, which is not zero of it.
    let mut work: Map<String, Value> = per_party(&at_nodes, "_ms", &|ms| json!(ms))
        .into_iter()
        .collect();
    work.insert("tool_ms".into(), json!(at_nodes.tool_ms));
    work.insert(
        "wall_ms".into(),
        json!(telemetry.map(|document| document.wall_ms)),
    );
    run.insert("node_work_ms".into(), Value::Object(work));
    run.insert("turns".into(), json!(turns_of(view, None)));
    run.insert("lint".into(), json!(measurements.lint_records));
    Value::Object(run)
}

/// One plan node, projected onto the wire's plan-task shape.
///
/// Only the fields the wire's own schema names are carried across, and each is
/// carried as recorded. The SDK's node shape is wider than the wire's — a
/// `resume` there records a branch and the steps a continuation may skip, where
/// the wire's records a base branch and a change request too — so a field whose
/// recorded shape is not the wire's is left out rather than reshaped into a
/// claim the record does not make.
fn plan_task(node: &Node) -> Value {
    let mut task = Map::new();
    task.insert("id".into(), json!(node.id));
    task.insert("kind".into(), json!(kind_word(node)));
    if let Some(persona) = &node.persona {
        task.insert("persona".into(), json!(persona));
    }
    let prose = node.rendered_task();
    if !prose.is_empty() {
        task.insert("task".into(), json!(prose));
    }
    if !node.deps.is_empty() {
        task.insert("deps".into(), json!(node.deps));
    }
    // Deliberately absent: `done_when`. Plan schema 2 retired it — the per-node
    // bar is the task's own `## Acceptance criteria`, which the judge reads as
    // the first message of the transcript it is given, and a plan still carrying
    // the field is refused by name where it is read. There is no such field on a
    // node to serve, and a client rendering one would be showing a bar nothing
    // judges against.
    if let Some(max_turns) = node.max_turns.filter(|turns| *turns > 0) {
        task.insert("max_turns".into(), json!(max_turns));
    }
    if node.expects_no_diff {
        task.insert("expects_no_diff".into(), json!(true));
    }
    if let Some(repo) = &node.repo {
        task.insert("repo".into(), json!(repo));
    }
    if let Some(branch) = &node.branch {
        task.insert("branch".into(), json!(branch));
    }
    if let Some(base) = &node.base_branch {
        task.insert("base_branch".into(), json!(base));
    }
    if let Some(title) = &node.title {
        task.insert("title".into(), json!(title));
    }
    if let Some(checkout) = &node.execution_checkout {
        task.insert("execution_checkout".into(), json!(checkout));
    }
    if let Some(steps) = &node.steps {
        let rendered: Vec<Value> = steps
            .iter()
            .map(|step| {
                let mut out = Map::new();
                out.insert("id".into(), json!(step.id));
                out.insert(
                    "kind".into(),
                    json!(if matches!(
                        serde_json::to_value(step.kind)
                            .ok()
                            .as_ref()
                            .and_then(Value::as_str),
                        Some("human")
                    ) {
                        "human"
                    } else {
                        "agent"
                    }),
                );
                if let Some(persona) = &step.persona {
                    out.insert("persona".into(), json!(persona));
                }
                // The planner's note is about the work, so it is rendered into
                // an agent step and never into a human one: an action a person
                // takes is served as written.
                let prose = if kind_word_of_step(step) == "human" {
                    step.task.clone().unwrap_or_default()
                } else {
                    step.rendered_task(node.context.as_deref())
                };
                // The wire requires prose on every step; a step recorded without
                // any is named by its id rather than served as a blank panel.
                out.insert(
                    "task".into(),
                    json!(if prose.is_empty() {
                        step.id.clone()
                    } else {
                        prose
                    }),
                );
                if !step.deps.is_empty() {
                    out.insert("deps".into(), json!(step.deps));
                }
                Value::Object(out)
            })
            .collect();
        if !rendered.is_empty() {
            task.insert("steps".into(), Value::Array(rendered));
        }
    }
    // A node with neither prose nor steps is one the wire has no shape for; it
    // is named by its id so the graph still draws it.
    if !task.contains_key("task") && !task.contains_key("steps") {
        task.insert("task".into(), json!(node.id.clone()));
    }
    Value::Object(task)
}

fn kind_word(node: &Node) -> &'static str {
    match serde_json::to_value(node.kind)
        .ok()
        .as_ref()
        .and_then(Value::as_str)
    {
        Some("human") => "human",
        _ => "agent",
    }
}

/// The graph the run is converging toward, with every committed live edit
/// applied.
///
/// One plan rather than one per round: the desired graph *is* the run's plan as
/// it now stands, and the SDK's fold applies every accepted edit to it. The file
/// on disk is the fallback for a run whose journal this host cannot fold — it is
/// the plan the run was launched with, so it carries no edit committed since.
fn plan_of(view: &RunView) -> Option<Plan> {
    if let Some(source) = view.state.plan.as_ref() {
        return Some(view.state.graph.to_plan(source));
    }
    Plan::load(&view.paths.plan()).ok()
}

/// Whether one member is in a turn a planner's note could be delivered into.
///
/// The three records that end a member's turn and the three that can only have
/// been published from inside one, and nothing else: a heartbeat says the member
/// is alive rather than talking, and a fallback says which identity refused it.
/// Every name is one `oneagentgraph::event::EventKind` declares, so
/// `tests/contract.rs` gates each against that library's own vocabulary.
#[derive(Debug, Clone)]
enum TurnState {
    /// A turn is running and the run has an address for it.
    InFlight,
    /// There is nothing to redirect, and this is why — in the words of whoever
    /// said so, which for onejudge's own answer and for a refused delivery is
    /// the producing library's.
    Ended(String),
}

/// What the node's own relayed records say about redirecting its running turn.
///
/// This is the read-side answer to the question `onepipeline`'s reconciler
/// answers by pulling the lever: it keeps a `TurnAddress` per in-flight dispatch,
/// read off the sibling's relayed envelopes with the latest winning, and a
/// `context` note goes into a running turn only when there is one. A read surface
/// must not pull that lever — serving a run would then interrupt it — so what it
/// has instead is the same stream the engine reads the address from, plus the
/// record of every interrupt anybody has already pulled.
///
/// A recorded `turn-interrupted` is the strongest evidence there is, because it
/// is the lever's own account of itself: `oneagentgraph` publishes one for
/// **every** attempt, delivered or not, carrying its own reason — "the member's
/// run has no out-of-band turn control", "the member is between turns". Where
/// nobody has pulled it, the turn records say only whether a turn is running,
/// which is the whole of what this fold claims.
///
/// **It does not claim to know the harness's answer, and must not.** No published
/// component exposes an authoritative current-turn control state outside the
/// process running the turn — onejudge reports `control` only on the finished
/// run, its live provider accessor is in-process, `oneagentgraph`'s spawn-time
/// record is provisional for every member whatever its harness, and the control
/// protocol's only verb is `interrupt`, which costs the turn. `src/AGENTS.md`
/// walks each closed route and names the upstream change that opens one.
fn member_turn_states<'a>(view: &'a RunView, node: &str) -> Vec<(&'a str, TurnState)> {
    let mut order: Vec<&str> = Vec::new();
    let mut states: BTreeMap<&str, TurnState> = BTreeMap::new();
    let relayed = view.events.iter().filter(|event| {
        event.source == Source::Agentgraph && event.labels.node.as_deref() == Some(node)
    });
    for event in relayed {
        // The address the engine keeps is the sibling's own run id and member, and
        // a record naming neither addresses nothing.
        let Some(member) = event
            .labels
            .extra
            .get(graph::MEMBER)
            .and_then(Value::as_str)
            .or_else(|| event.payload.get(graph::MEMBER).and_then(Value::as_str))
            .filter(|member| !member.trim().is_empty())
        else {
            continue;
        };
        if event
            .labels
            .run_id
            .as_deref()
            .is_none_or(|run| run.trim().is_empty())
        {
            continue;
        }
        let state = match event.kind.0.as_str() {
            graph::TURN_STARTED | graph::TURN_ACTIVITY => TurnState::InFlight,
            graph::TURN_COMPLETED => TurnState::Ended(
                "its last turn completed, so the member is between turns".to_owned(),
            ),
            graph::MEMBER_DIED => TurnState::Ended("the member is no longer running".to_owned()),
            graph::MEMBER_SETTLED => TurnState::Ended("the member is no longer running".to_owned()),
            // A record that does not say whether it was delivered says nothing
            // about the turn either. Reading it as a refusal would report a node
            // as un-correctable on the strength of a record this build could not
            // read, and `delivered` is required on the sibling's own type.
            graph::TURN_INTERRUPTED => match delivered(event) {
                // A turn that has just taken a redirection is a controllable
                // turn, and is still running: that is what delivery means.
                Some(true) => TurnState::InFlight,
                Some(false) => TurnState::Ended(
                    // A reason the sibling wrote nothing into is no reason: the
                    // served `reason` is a sentence a planner reads, so an empty
                    // one is replaced by this crate's own account of the record.
                    non_empty(event.payload.get(graph::REASON).and_then(Value::as_str))
                        .unwrap_or("the last redirection this run offered it was not delivered")
                        .to_owned(),
                ),
                None => continue,
            },
            // Every other kind the sibling relays says something about the member
            // that is not about its turn, and must not be read as either answer.
            _ => continue,
        };
        if states.insert(member, state).is_none() {
            order.push(member);
        } else {
            order.retain(|seen| *seen != member);
            order.push(member);
        }
    }
    order
        .into_iter()
        .filter_map(|member| states.get(member).map(|state| (member, state.clone())))
        .collect()
}

/// One in-flight node's answer to "does this run have a turn it can address?".
///
/// Served for every node the run records as `running` and for no other:
/// `addressable` is never absent for a node in flight, and never present for a
/// node with no turn to have one. `reason` is carried exactly when `addressable`
/// is false, which is the discipline `turn-interrupted` itself keeps for its own.
///
/// The latest record wins, over the node's whole history rather than within a
/// round: a node that ran, was re-dispatched, and is running again is one node
/// with one current turn, and the records of the attempt that ended are exactly
/// the ones a later `turn-started` supersedes.
///
/// **`addressable`, not `interruptible`.** It says this run has a turn it can
/// address for the node — the engine's own precondition for delivering a note —
/// and that is the whole of what any of this can prove. Whether the harness will
/// take the redirection is onejudge's `control`, which no published component
/// exposes for a turn in flight; naming the field for the answer we cannot get
/// would be the overclaim a planner acts on.
fn node_control(view: &RunView, node: &str) -> Value {
    let states = member_turn_states(view, node);
    // The latest member to have spoken wins, exactly as the engine's address does:
    // that is the turn a note aimed at this node now would be correcting.
    if let Some((member, _)) = states
        .iter()
        .rev()
        .find(|(_, state)| matches!(state, TurnState::InFlight))
    {
        return json!({ "addressable": true, "member": member });
    }
    match states.last() {
        Some((member, TurnState::Ended(reason))) => {
            json!({ "addressable": false, "member": member, "reason": reason })
        }
        // The engine's own words for a node it has no address for: a dispatch
        // that has reported no member yet, or no dispatch at all.
        _ => json!({
            "addressable": false,
            "reason": "nothing of its dispatch has reported a member yet",
        }),
    }
}

/// The run's continuous graph state, as the detail payload carries it.
///
/// One object rather than an array of rounds. Execution is continuous: a node
/// dispatches the moment its dependencies settle, nothing batches them, and
/// there is exactly one desired graph and one recorded result. The fold is the
/// account of it — nothing overwrites the fold now that no next round starts —
/// and the recorded result is the fallback for a run whose journal folded to
/// nothing.
fn graph_state(view: &RunView) -> Option<Value> {
    let plan = plan_of(view)?;
    let task_ids: BTreeSet<&str> = plan.tasks.iter().map(|node| node.id.as_str()).collect();
    let result = read_json(&view.paths.result());

    // The same derivation the list row renders from — the fold per node, with the
    // recorded result filling the gaps — so a row and the graph it opens cannot
    // describe different graphs.
    let statuses: BTreeMap<String, String> = recorded_statuses(view)
        .into_iter()
        .map(|(node, recorded)| (node, status_word(&recorded.status).to_owned()))
        .collect();
    // Exactly one entry per plan task, so a client never invents a status for a
    // node or renders one for a node the graph does not carry.
    let node_status: Map<String, Value> = plan
        .tasks
        .iter()
        .map(|node| {
            let status = statuses
                .get(&node.id)
                .map_or("unknown", String::as_str)
                .to_owned();
            (node.id.clone(), json!(status))
        })
        .collect();

    let node_states: Map<String, Value> = statuses
        .iter()
        .filter(|(id, status)| task_ids.contains(id.as_str()) && is_recorded_state(status))
        .map(|(id, status)| (id.clone(), json!(status)))
        .collect();

    let node_gated_by: Map<String, Value> = plan
        .tasks
        .iter()
        .filter(|node| matches!(node_status[&node.id].as_str(), Some("blocked" | "skipped")))
        .map(|node| {
            let blockers: Vec<&String> = node
                .deps
                .iter()
                .filter(|dep| task_ids.contains(dep.as_str()))
                .collect();
            (node.id.clone(), json!(blockers))
        })
        .filter(|(_, blockers)| !blockers.as_array().is_some_and(Vec::is_empty))
        .collect();

    let node_results: Map<String, Value> = plan
        .tasks
        .iter()
        .filter_map(|node| node_result(view, node, result.as_ref()))
        .collect();

    // Only work in flight has a turn to redirect, so this is one entry per node
    // the run records as `running` and none for any other.
    let node_control: Map<String, Value> = plan
        .tasks
        .iter()
        .filter(|node| node_status[&node.id].as_str() == Some("running"))
        .map(|node| (node.id.clone(), self::node_control(view, &node.id)))
        .collect();

    let mut out = Map::new();
    out.insert("run_id".into(), json!(view.paths.run));
    out.insert("plan".into(), plan_document(&plan));
    out.insert("node_states".into(), Value::Object(node_states));
    out.insert("node_status".into(), Value::Object(node_status));
    out.insert("node_gated_by".into(), Value::Object(node_gated_by));
    out.insert("node_control".into(), Value::Object(node_control));
    out.insert("node_results".into(), Value::Object(node_results));
    out.insert("decisions".into(), Value::Array(decisions(view)));
    out.insert(
        "attestations".into(),
        json!(view.state.attestations.iter().collect::<Vec<_>>()),
    );
    out.insert("result".into(), run_result(result.as_ref()));
    out.insert("last_seq".into(), json!(last_seq(view)));
    Some(Value::Object(out))
}

/// The decision points holding subtrees back, in the run's own words.
///
/// The continuous engine pauses **only** at a decision point, and only the
/// subtree that depends on it: a blocking surface, or a ready human action
/// nobody has attested. Everything else keeps running beside it. That is the one
/// thing a reader of a stalled run has to be able to see, and under rounds there
/// was no such record to serve — a paused run read as a round that had not
/// finished.
///
/// Each entry is the decision's own kind and the nodes it unblocks when it is
/// cleared, which is exactly what `decision-pending` carries and what
/// `decision-cleared` will release.
fn decisions(view: &RunView) -> Vec<Value> {
    view.state
        .decisions_pending
        .iter()
        .map(|(id, pending)| {
            json!({
                "id": id,
                "kind": pending.kind,
                "unblocks": pending.unblocks,
            })
        })
        .collect()
}

/// The plan document the graph carries, in the wire's shape.
fn plan_document(plan: &Plan) -> Value {
    let mut document = Map::new();
    document.insert(
        "tasks".into(),
        Value::Array(plan.tasks.iter().map(plan_task).collect()),
    );
    document.insert("schema_version".into(), json!(plan.schema_version));
    if plan.concurrency > 0 {
        document.insert("concurrency".into(), json!(plan.concurrency));
    }
    if let Some(name) = plan.name.as_ref().filter(|name| !name.is_empty()) {
        document.insert("name".into(), json!(name));
    }
    if let Some(goal) = plan.goal.as_ref().filter(|goal| !goal.text.is_empty()) {
        // The wire's goal is identified as well as stated; the SDK records the
        // words alone, so the id is the digest of them — stable for the same
        // goal, and different for a goal the planner rewrote.
        document.insert(
            "goal".into(),
            json!({ "id": session_key(&goal.text), "text": goal.text }),
        );
    }
    Value::Object(document)
}

/// The fields of a recorded node result the wire carries, each as recorded.
///
/// Deliberately an allowlist rather than a passthrough: the run's result is a
/// wider record than `graphResultItemSchema` describes, and serving a key the
/// client has no meaning for would be this crate inventing contract.
const RESULT_FIELDS: &[&str] = &[
    "status",
    "outcome",
    "branch",
    "blocked_by",
    "unblocks",
    "human_actions",
    "detail",
    "error",
    "exit_code",
    "ok",
];

/// The payload of the settlement the run last recorded for `node`.
///
/// The last one wins: a node that settled more than once is a node that was
/// retried or replaced, and the latest settlement is what happened.
fn settlement(view: &RunView, node: &str) -> Option<Map<String, Value>> {
    view.events
        .iter()
        .rev()
        .find(|event| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
                && event.labels.node.as_deref() == Some(node)
        })
        .map(|event| event.payload.clone())
}

/// One node's result: what the live fold says, or — for a node the fold has
/// nothing for — what the run's own recorded result document held.
///
/// The fold leads, in the same order [`recorded_statuses`] reads them. There is
/// no closed round whose fold has moved on, so the fold is always the current
/// account; the recorded document is what a run whose journal this host cannot
/// fold still has, and it holds words no settlement carried. A node in neither is
/// a node the run has nothing to say about, and it is served no entry at all.
fn node_result(view: &RunView, node: &Node, result: Option<&Value>) -> Option<(String, Value)> {
    let mut item = Map::new();
    item.insert("kind".into(), json!(kind_word(node)));
    if let Some(status) = view.state.recorded.get(&node.id) {
        let word = status_word(status.status().as_str());
        item.insert("status".into(), json!(word));
        item.insert("completed".into(), json!(word == "done"));
        // The words the settlement itself carried. The SDK's fold keeps a node's
        // status, outcome and branch but not the prose beside them, and a node
        // that stopped without them is a card that says only "failed" — which
        // tells a reader less than the run already knows.
        if let Some(settled) = settlement(view, &node.id) {
            for field in RESULT_FIELDS {
                if item.contains_key(*field) {
                    continue;
                }
                if let Some(value) = settled.get(*field) {
                    item.insert((*field).to_owned(), value.clone());
                }
            }
        }
        if let Some(outcome) = view.state.outcomes.get(&node.id) {
            item.insert("outcome".into(), json!(outcome));
        }
        if let Some(branch) = view.state.branches.get(&node.id) {
            item.insert("branch".into(), json!(branch));
        }
        if let Some(url) = view.state.change_urls.get(&node.id) {
            item.insert("pr".into(), json!(url));
        }
    } else {
        // The document a driver wrote as it closed out, for a node the journal
        // this host can read says nothing about. It holds words no settlement
        // carried, which for a run predating the journal is the whole account —
        // and a node in neither is one the run has nothing to say about, which is
        // served no entry rather than an empty one.
        let recorded = result
            .and_then(|r| r["nodes"].as_array())
            .and_then(|nodes| nodes.iter().find(|entry| entry["id"] == json!(node.id)))?;
        for field in RESULT_FIELDS {
            if let Some(value) = recorded.get(field) {
                item.insert((*field).to_owned(), value.clone());
            }
        }
        if let Some(url) = recorded.get("change_url").and_then(Value::as_str) {
            item.insert("pr".into(), json!(url));
        }
        if let Some(status) = item.get("status").and_then(Value::as_str) {
            let word = status_word(status).to_owned();
            item.insert("completed".into(), json!(word == "done"));
            item.insert("status".into(), json!(word));
        }
    }
    if let Some(finished) = view.state.completed_steps.get(&node.id) {
        let steps: Vec<Value> = node
            .steps
            .iter()
            .flatten()
            .map(|step| {
                json!({
                    "id": step.id,
                    "kind": if matches!(kind_word_of_step(step), "human") { "human" } else { "agent" },
                    "persona": step.persona,
                    "status": if finished.contains(&step.id) { "done" } else { "pending" },
                })
            })
            .collect();
        if !steps.is_empty() {
            item.insert("steps".into(), Value::Array(steps));
        }
    }
    Some((node.id.clone(), Value::Object(item)))
}

fn kind_word_of_step(step: &onepipeline::plan::Step) -> &'static str {
    match serde_json::to_value(step.kind)
        .ok()
        .as_ref()
        .and_then(Value::as_str)
    {
        Some("human") => "human",
        _ => "agent",
    }
}

/// The run's own recorded result document, or `null` before a driver has closed
/// out and written one.
fn run_result(result: Option<&Value>) -> Value {
    let Some(result) = result else {
        return Value::Null;
    };
    let mut out = Map::new();
    if let Some(ok) = result.get("ok") {
        out.insert("ok".into(), ok.clone());
    }
    if let Some(state) = result.get("state") {
        out.insert("state".into(), state.clone());
    }
    if let Some(nodes) = result["nodes"].as_array() {
        out.insert(
            "started_order".into(),
            json!(nodes
                .iter()
                .filter_map(|node| node["id"].as_str())
                .collect::<Vec<_>>()),
        );
    }
    Value::Object(out)
}

/// The highest per-stream sequence number the run recorded.
fn last_seq(view: &RunView) -> u64 {
    view.events.iter().map(|event| event.seq).max().unwrap_or(0)
}

/// The whole of `GET /api/v2/runs/{run}`'s payload.
///
/// `graph` is one object, not an array: the run has one continuous graph state,
/// and a client that used to index `rounds` is reading a schema this no longer
/// serves.
#[must_use]
pub fn run_detail(
    view: &RunView,
    include_conversations: bool,
    telemetry: Option<&RunTelemetry>,
    filter: &EventFilter,
) -> Value {
    let mut payload = Map::new();
    // Everything below the transcripts is read from the whole journal, whatever
    // the filter said: the graph's statuses, the answer about each in-flight
    // node's turn, the evidence each node kept and the run's own clock are what
    // the *run* is, and a reader narrowing their attention must be shown the same
    // one. The transcripts are the detail's own event listing, and are the one
    // thing here a filter narrows.
    payload.insert("run".into(), run_telemetry(view, telemetry));
    payload.insert("graph".into(), graph_state(view).unwrap_or(Value::Null));
    payload.insert(
        "conversations".into(),
        Value::Array(if include_conversations {
            conversations_under(view, filter)
        } else {
            Vec::new()
        }),
    );
    payload.insert("node_details".into(), node_details(view));
    payload.insert("launch".into(), launch(view));
    Value::Object(payload)
}

/// One piece of evidence a node's work stored beside the stream.
///
/// onepipeline's own event vocabulary is closed and names no verification, so
/// what a node verified is read from what it *kept*: an [`ArtifactRef`] on the
/// event that reported the work. The reporting event supplies the verdict and
/// the bounded prose; the artifact id is how a reader — or `onepipeline`'s own
/// CLI — asks for the whole log.
///
/// `since` is the last thing the node recorded before it — the stretch of its
/// own record the evidence closes. The run stamps evidence at one instant and
/// never records when producing it began, and the two neighbouring events are
/// the tightest bracket it does record; widening that to the whole dispatch
/// would draw every node's evidence across the whole of its work.
///
/// This is one of the derivations AGENTS.md proposes moving into the SDK.
///
/// [`ArtifactRef`]: onepipeline::event::ArtifactRef
struct Evidence<'a> {
    artifact: &'a str,
    since: &'a str,
    at: &'a str,
    // llmlint: ignore[invalid_states_unrepresentable] the wire's own `verificationRecordSchema.ok` is a required bool, so there is no third state to carry: this says "nothing the run recorded reported a failure", which is the whole of what a journal with no verification kind can answer.
    ok: bool,
    output_tail: String,
}

/// Whether one record reported the work it describes as having gone well, in
/// the vocabulary of the library that wrote it.
///
/// Each producer has its own word for a verdict, and none of them is the
/// pipeline's `status`: `onevcs` rules a gate `pass` or `fail`, says whether a
/// push was `accepted`, and gives a host check a `conclusion` it reads three
/// values of as not blocking a merge. Reading a check's `completed` as a
/// pipeline status is how every passing check came to look like a failure.
fn verdict_of(event: &Envelope) -> bool {
    if event.source == Source::Vcs {
        return match event.kind.0.as_str() {
            vcs::CHANGE_CHECK => event
                .payload
                .get("conclusion")
                .and_then(Value::as_str)
                .is_none_or(|conclusion| {
                    vcs::GREEN_CONCLUSIONS.contains(&conclusion.to_ascii_lowercase().as_str())
                }),
            vcs::GATE_VERDICT => {
                event.payload.get("verdict").and_then(Value::as_str) == Some(vcs::GATE_PASSED)
            }
            vcs::PUSH => event
                .payload
                .get("accepted")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            vcs::SYNC_CONFLICT => false,
            _ => true,
        };
    }
    event
        .payload
        .get("status")
        .and_then(Value::as_str)
        .is_none_or(|status| status_word(status) == "done")
}

/// Every artifact one node's events stored, oldest first.
fn evidence<'a>(view: &'a RunView, node: &str) -> Vec<Evidence<'a>> {
    let mine: Vec<&Envelope> = view
        .events
        .iter()
        .filter(|event| event.labels.node.as_deref() == Some(node))
        .collect();
    mine.iter()
        .enumerate()
        .flat_map(|(position, event)| {
            // The event before this one, or this one itself when it is the first
            // thing the node recorded: a zero-length bracket is the honest answer
            // for evidence that arrived with nothing before it.
            let since = mine
                .get(position.saturating_sub(1))
                .map_or(event.ts.as_str(), |before| before.ts.as_str());
            let prose = event
                .payload
                .get("detail")
                .or_else(|| event.payload.get("error"))
                // `onevcs` keeps a gate's own output under the word that library
                // writes it as, which is the prose a reader of a failed gate
                // came for.
                .or_else(|| event.payload.get("output"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let ok = verdict_of(event);
            event.artifacts.iter().map(move |artifact| Evidence {
                artifact: artifact.id.0.as_str(),
                since,
                at: event.ts.as_str(),
                ok,
                output_tail: prose.clone(),
            })
        })
        .collect()
}

/// The checks a host observed on one node's publication, latest state per check.
///
/// `onevcs` reports every transition of every check it waits on — a check that
/// queued, started and finished is three records of the same name — so what is
/// served is the last account of each, in the order the run first saw them.
/// `state` is the check's conclusion once it reached one and its host status
/// while it has not, which is the one word a reader is asking for; the word it
/// moved from is beside it, and the log the settled check stored is named so a
/// failed one can be read rather than only counted.
fn observed_checks(events: &[&Envelope]) -> Vec<Value> {
    let mut order: Vec<&str> = Vec::new();
    let mut latest: BTreeMap<&str, Value> = BTreeMap::new();
    for event in events {
        if event.source != Source::Vcs || event.kind.0 != vcs::CHANGE_CHECK {
            continue;
        }
        let Some(name) = event.payload.get("name").and_then(Value::as_str) else {
            continue;
        };
        let status = event.payload.get("status").and_then(Value::as_str);
        let conclusion = event.payload.get("conclusion").and_then(Value::as_str);
        let mut check = Map::new();
        check.insert("name".into(), json!(name));
        check.insert(
            "state".into(),
            json!(conclusion.or(status).unwrap_or("unknown")),
        );
        check.insert(
            "required".into(),
            json!(event
                .payload
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)),
        );
        if let Some(from) = event.payload.get("from_status").and_then(Value::as_str) {
            check.insert("from_state".into(), json!(from));
        }
        if let Some(status) = status {
            check.insert("status".into(), json!(status));
        }
        if let Some(artifact) = event.artifacts.first() {
            check.insert("artifact_id".into(), json!(artifact.id.0));
        }
        if latest.insert(name, Value::Object(check)).is_none() {
            order.push(name);
        }
    }
    order
        .into_iter()
        .filter_map(|name| latest.remove(name))
        .collect()
}

/// The last value one of a node's records carried under `key`.
fn last_recorded<'a>(events: &[&'a Envelope], kinds: &[&str], key: &str) -> Option<&'a str> {
    events
        .iter()
        .rev()
        .filter(|event| event.source == Source::Vcs && kinds.contains(&event.kind.0.as_str()))
        .find_map(|event| event.payload.get(key).and_then(Value::as_str))
}

/// Whether any of a node's records is one of `kinds`.
fn recorded_any(events: &[&Envelope], kinds: &[&str]) -> bool {
    events
        .iter()
        .any(|event| event.source == Source::Vcs && kinds.contains(&event.kind.0.as_str()))
}

/// What one node's publication reached, from the records `onevcs` relayed for it.
///
/// `None` when the run recorded neither a branch for the node nor a publication
/// record of any kind: an absent publication is a node that published nothing,
/// where an empty one would read as a publication that reached nowhere.
fn publication_of(view: &RunView, node: &str, events: &[&Envelope]) -> Option<Value> {
    const MERGED: [&str; 2] = [vcs::CHANGE_MERGED, vcs::MERGE_COMPLETED];
    const OPENED: [&str; 2] = [vcs::CHANGE_OPENED, vcs::CHANGE_MERGED];
    let branch = view
        .state
        .branches
        .get(node)
        .map(String::as_str)
        .or_else(|| last_recorded(events, &[vcs::SESSION_OPENED], "branch"));
    let merged = recorded_any(events, &MERGED)
        || view
            .state
            .outcomes
            .get(node)
            .is_some_and(|outcome| outcome == "merged");
    if branch.is_none() && !recorded_any(events, &[vcs::SESSION_OPENED, vcs::CHANGE_OPENED]) {
        return None;
    }
    let mut publication = Map::new();
    if let Some(branch) = branch {
        publication.insert("branch".into(), json!(branch));
    }
    publication.insert("merged".into(), json!(merged));
    if let Some(url) = view
        .state
        .change_urls
        .get(node)
        .map(String::as_str)
        .or_else(|| last_recorded(events, &OPENED, "url"))
    {
        publication.insert("pr_url".into(), json!(url));
    }
    // The commit the work landed as: the merge the host completed, or — for work
    // that was preserved rather than published — the commit it was preserved on.
    // Its *url* is the host's own and nothing records one, so none is served.
    if let Some(sha) = last_recorded(events, &MERGED, "sha")
        .or_else(|| last_recorded(events, &[vcs::COMMIT_PRESERVED], "sha"))
    {
        publication.insert("commit".into(), json!(sha));
    }
    if let Some(base) = last_recorded(events, &[vcs::MERGE_COMPLETED], "base")
        .or_else(|| last_recorded(events, &[vcs::SESSION_OPENED, vcs::CHANGE_OPENED], "base"))
    {
        publication.insert("base_branch".into(), json!(base));
    }
    Some(Value::Object(publication))
}

/// The publication and verification evidence each node left behind.
fn node_details(view: &RunView) -> Value {
    let mut details: Map<String, Value> = Map::new();
    let mut nodes: BTreeSet<&str> = view
        .state
        .branches
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    nodes.extend(
        view.events
            .iter()
            .filter(|event| !event.artifacts.is_empty() || event.source == Source::Vcs)
            .filter_map(|event| event.labels.node.as_deref()),
    );
    for node in nodes {
        let mine: Vec<&Envelope> = view
            .events
            .iter()
            .filter(|event| event.labels.node.as_deref() == Some(node))
            .collect();
        let records: Vec<Value> = evidence(view, node)
            .into_iter()
            .map(|record| {
                json!({
                    "ok": record.ok,
                    "output_tail": record.output_tail,
                    "artifact_id": record.artifact,
                })
            })
            .collect();
        let mut verification = Map::new();
        let checks = observed_checks(&mine);
        let required: Vec<&Value> = checks
            .iter()
            .filter(|check| check["required"] == json!(true))
            .collect();
        if !required.is_empty() {
            verification.insert(
                "required_checks".into(),
                json!(required
                    .iter()
                    .map(|check| &check["name"])
                    .collect::<Vec<_>>()),
            );
        }
        // Recorded rather than defaulted: the hook leaves one trace, a gate
        // verdict under the command `onevcs` writes for it, and a node with no
        // such record says nothing here rather than saying the hook did not run.
        if mine.iter().any(|event| {
            event.source == Source::Vcs
                && event.kind.0 == vcs::GATE_VERDICT
                && event.payload.get("command").and_then(Value::as_str)
                    == Some(vcs::PRE_PUSH_COMMAND)
        }) {
            verification.insert("pre_push_hook".into(), json!(true));
        }
        if !checks.is_empty() {
            verification.insert("checks".into(), Value::Array(checks));
        }
        verification.insert("records".into(), Value::Array(records));
        let mut detail = Map::new();
        detail.insert("verification".into(), Value::Object(verification));
        if let Some(publication) = publication_of(view, node, &mine) {
            detail.insert("publication".into(), publication);
        }
        details.insert(node.to_owned(), Value::Object(detail));
    }
    Value::Object(details)
}

/// Every transcript the merged event store records for the run.
///
/// A conversation is one agent-graph session's relayed envelopes, in order. The
/// journal records what each envelope reported, not the turn text a harness
/// stored, so a turn here carries the event that produced it rather than a
/// transcript body — the body lives with the producing library, which is where
/// AGENTS.md proposes the read for it should land.
#[must_use]
pub fn conversations(view: &RunView) -> Vec<Value> {
    conversations_under(view, &EventFilter::default())
}

/// The transcripts a reader's filter admits, each as the whole session it is.
///
/// A session whose every record the filter excluded is not served at all — an
/// empty transcript would say the session recorded nothing, which is a different
/// fact from "this reading is not about it".
fn conversations_under(view: &RunView, filter: &EventFilter) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: BTreeMap<String, Vec<&Envelope>> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph || !filter.allows(event) {
            continue;
        }
        let Some(session) = event
            .labels
            .extra
            .get("session")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if ConversationId::try_from(session).is_err() {
            continue;
        }
        if !grouped.contains_key(session) {
            order.push(session.to_owned());
        }
        grouped.entry(session.to_owned()).or_default().push(event);
    }
    order
        .into_iter()
        .filter_map(|session| {
            let events = grouped.get(&session)?;
            Some(conversation_document(view, &session, events))
        })
        .collect()
}

/// One turn as the settled member's stored report recorded it.
///
/// A turn is a prompt and the reply to it: the report's transcript alternates a
/// simulated user's message with the agent's, and its 1-based position is the
/// counter `telemetry.sessions` and `telemetry.attribution` both key on.
struct ReportedTurn {
    /// The prompt the simulated user gave, verbatim.
    user: String,
    /// The reply the agent wrote, or `None` for a turn that recorded none.
    assistant: Option<String>,
    /// The calls it made and what they returned.
    tools: Vec<Value>,
}

/// The report one settled member stored, read from the copy the run keeps.
///
/// `member-settled` carries no `session` label and does not need one: a session
/// id is the emitting stream and the member that ran on it, which is exactly how
/// `oneagentgraph` mints one — so the settlement a session belongs to is the one
/// whose `stream` and `labels.member` spell it. The bytes are located the one way
/// `docs/contract.md` allows, through the SDK's own [`RunPaths::report_for`].
///
/// `None` for a session whose member has not settled, whose copy the run does not
/// hold, and for a document this crate cannot read as a report — all three are
/// "the report says nothing", and each leaves the transcript as the journal
/// relayed it rather than emptying it.
///
/// [`RunPaths::report_for`]: onepipeline::views::RunPaths::report_for
fn stored_report(view: &RunView, session: &str) -> Option<judge::Report> {
    let settlement = view.events.iter().find(|event| {
        event.source == Source::Agentgraph
            && event.kind.0 == graph::MEMBER_SETTLED
            && event
                .labels
                .extra
                .get(graph::MEMBER)
                .and_then(Value::as_str)
                .is_some_and(|member| format!("{}.{member}", event.stream) == session)
    })?;
    read_report(view, settlement)
}

/// The report one settlement stored, refused unless the contract it was written
/// under is one this binary links.
///
/// **Do not tighten this to equality.** onejudge bumps its version for an added
/// field, so every report stored before this binary was built is older than it
/// and reads perfectly well; only a document *ahead* of the linked contract may
/// mean something else by the fields the two share.
fn read_report(view: &RunView, settlement: &Envelope) -> Option<judge::Report> {
    let bytes = fs::read(report_path(view, settlement)).ok()?;
    let report: judge::Report = serde_json::from_slice(&bytes).ok()?;
    (report.schema_version <= judge::SCHEMA_VERSION).then_some(report)
}

/// The turns one report's transcript recorded, in the producer's own order.
///
/// Keyed on the user's messages rather than the agent's, so a prompt whose reply
/// never came is still a turn — with the prompt it gave and no reply — instead of
/// vanishing from the transcript. A `system` message is neither party's turn and
/// opens none.
fn reported_turns(report: &judge::Report) -> Vec<ReportedTurn> {
    let mut turns: Vec<ReportedTurn> = Vec::new();
    for message in &report.transcript.messages {
        match message.role {
            judge::Role::User => turns.push(ReportedTurn {
                user: message.content.clone(),
                assistant: None,
                tools: reported_tools(message),
            }),
            judge::Role::Assistant => {
                // A reply with no prompt before it is still the agent's turn; it
                // opens one rather than joining the turn before it, which was
                // answered already.
                let open = match turns.last_mut() {
                    Some(open) if open.assistant.is_none() => open,
                    _ => {
                        turns.push(ReportedTurn {
                            user: String::new(),
                            assistant: None,
                            tools: Vec::new(),
                        });
                        turns.last_mut().expect("the turn just pushed")
                    }
                };
                open.assistant = Some(message.content.clone());
                open.tools.extend(reported_tools(message));
            }
            judge::Role::System => {}
        }
    }
    turns
}

/// The reported turn one relayed turn number names, if the report holds it.
fn turn_of(turns: &[ReportedTurn], turn: u64) -> Option<&ReportedTurn> {
    turns.get(usize::try_from(turn).ok()?.checked_sub(1)?)
}

/// The invocation one **agent** turn actually ran, out of the chain of identities
/// its attribution records.
///
/// This is where a turn's own usage and a turn's own elapsed time are, for either
/// side — the report's top-level `usage` is the whole dispatch's total over both
/// of them. The candidates beside the one that ran are identities the chain fell
/// through, and none of them happened.
fn ran_candidate(report: &judge::Report, turn: u64) -> Option<&judge::CandidateAttempt> {
    let turn = u32::try_from(turn).ok()?;
    report
        .telemetry
        .as_ref()?
        .attribution
        .iter()
        .find(|attribution| {
            attribution.role == judge::TelemetryRole::Agent && attribution.turn_index == turn
        })?
        .candidates
        .iter()
        .find(|candidate| candidate.ran)
}

/// The wall-clock bounds one **agent** turn's invocation was observed between.
///
/// Held to `role: agent` deliberately and not as a formality: a `SessionLink` is
/// recorded only for an invocation that reported both a session id and a start,
/// and a start comes from a provider-measured telemetry the judge side of this
/// host reports and the agent side does not. So the rows a report really holds
/// are the judge's, and matching an agent turn by its index alone would put the
/// judge's clock on the agent's turn. A turn with no row of its own is served
/// both bounds absent, which is what the report says about it.
fn agent_session(report: &judge::Report, turn: u64) -> Option<&judge::SessionLink> {
    let turn = u32::try_from(turn).ok()?;
    report
        .telemetry
        .as_ref()?
        .sessions
        .iter()
        .find(|link| link.role == judge::TelemetryRole::Agent && link.turn_index == turn)
}

/// One tool call a turn reported while it was still running.
///
/// `turn-activity` carries the tool's kind and name and a summary of what it was
/// given, bounded by the producing library; that summary is the call's input as
/// far as the journal is concerned, and nothing records what it returned. A
/// session whose member settled is served [`reported_tools`] instead, which is
/// the same calls with the observations they returned.
fn tool_call(index: usize, event: &Envelope) -> Value {
    json!({
        "index": index,
        "kind": event.payload.get("kind").and_then(Value::as_str).unwrap_or_default(),
        "name": event.payload.get("name").and_then(Value::as_str),
        "input": event.payload.get("detail").and_then(Value::as_str),
        "output": Value::Null,
    })
}

/// The tool calls and results one reported turn recorded, in the report's own
/// numbering.
///
/// `output` is `null` for a call rather than empty: the trace exposed no
/// observation for it, and a `tool_result` beside it is where the observation
/// is. `name` is `null` on a result for the same reason — that is what the
/// producing library records, and a result renamed after its call would claim a
/// pairing this crate did not read.
fn reported_tools(message: &judge::Message) -> Vec<Value> {
    message
        .events
        .iter()
        .map(|event| {
            json!({
                "index": event.index,
                "kind": event.kind,
                "name": event.name,
                "input": event.input,
                "output": event.output,
            })
        })
        .collect()
}

/// What one turn consumed, in the wire's own spelling of the record's fields.
fn turn_usage(event: &Envelope) -> Value {
    let Some(usage) = event
        .payload
        .get(graph::USAGE)
        .filter(|usage| usage.is_object())
    else {
        return Value::Object(Map::new());
    };
    let count = |key: &str| usage.get(key).and_then(Value::as_u64);
    json!({
        "inputTokens": count(graph::INPUT_TOKENS),
        "outputTokens": count(graph::OUTPUT_TOKENS),
        "cacheReadTokens": count(graph::CACHE_READ_TOKENS),
        "cacheWriteTokens": count(graph::CACHE_WRITE_TOKENS),
        "costUsd": usage.get(graph::COST_USD).and_then(Value::as_f64),
    })
}

/// What one *turn* consumed, as the invocation that ran it reported it.
///
/// The same five figures [`turn_usage`] serves off a record, from the one place
/// they are recorded per turn rather than per run: a report's `usage` is the
/// whole dispatch's total over both sides, and serving it on a turn would repeat
/// one total on every one of them.
fn candidate_usage(usage: Option<&judge::Usage>) -> Value {
    let Some(usage) = usage else {
        return Value::Object(Map::new());
    };
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cacheReadTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
        "costUsd": usage.cost_usd,
    })
}

/// The turn records one session relayed, each with the tool summaries published
/// from inside it.
///
/// `oneagentgraph` opens a turn *before* its activities and streams each summary
/// live, so a summary belongs to the turn record that precedes it — carrying one
/// on the next record instead put every journal-derived turn's tools one turn
/// late. A redirection is published from inside a turn too and is skipped for the
/// reason [`is_turn_record`] skips it, and it must be skipped in *both*, because
/// a turn's id is its position in this list and the timeline numbers the same
/// session by the same rule.
///
/// Summaries relayed before the session relayed any turn join the first turn it
/// does relay: they were published from inside a turn whose start never reached
/// the journal, and dropping them would lose the only record of it.
fn relayed_turns<'a>(events: &[&'a Envelope]) -> Vec<(&'a Envelope, Vec<&'a Envelope>)> {
    let mut turns: Vec<(&Envelope, Vec<&Envelope>)> = Vec::new();
    let mut open: Vec<&Envelope> = Vec::new();
    for event in events {
        if event.kind.0 == graph::TURN_ACTIVITY {
            open.push(event);
            continue;
        }
        if !is_turn_record(event) {
            continue;
        }
        if let Some((_, running)) = turns.last_mut() {
            running.append(&mut open);
        }
        turns.push((event, std::mem::take(&mut open)));
    }
    if let Some((_, running)) = turns.last_mut() {
        running.append(&mut open);
    }
    turns
}

/// One conversation and its attribution.
fn conversation_document(view: &RunView, session: &str, events: &[&Envelope]) -> Value {
    let first = events.first().copied();
    let last = events.last().copied();
    let started_at = first.map_or_else(now_rfc3339, |event| event.ts.clone());
    let node = first.and_then(|event| event.labels.node.clone());
    // What the journal cannot answer: the prompt each turn was given, the prose
    // it wrote back, what its tool calls returned, and what that turn alone spent
    // and took. A session whose member has not settled has no report yet and is
    // served as the journal relayed it.
    let reported = stored_report(view, session);
    let transcript = reported.as_ref().map(reported_turns).unwrap_or_default();
    let turns: Vec<Value> = relayed_turns(events)
        .into_iter()
        .enumerate()
        .map(|(index, (event, summaries))| {
            // The producer's own number for this turn, which is the counter the
            // report shares between its sessions and its attribution. A record
            // that names no turn — a settlement, a death — is not one of the
            // conversation's turns and takes nothing from the report.
            let numbered = event.payload.get(graph::TURN).and_then(Value::as_u64);
            let recorded = numbered.and_then(|turn| turn_of(&transcript, turn));
            let ran = numbered
                .zip(reported.as_ref())
                .and_then(|(turn, report)| ran_candidate(report, turn));
            let bounds = numbered
                .zip(reported.as_ref())
                .and_then(|(turn, report)| agent_session(report, turn));
            json!({
                "assistant": match recorded {
                    // Explicitly absent rather than empty: the report holds this
                    // turn and it recorded no reply.
                    Some(turn) => json!(turn.assistant),
                    None => json!(event.payload.get("message").and_then(Value::as_str)),
                },
                "durationMs": ran.and_then(|candidate| candidate.duration_ms),
                "failureKind": Value::Null,
                "finishedAt": bounds.and_then(|link| link.finished_at.clone()),
                "harness": "oneagentgraph",
                "id": format!("{session}.{index}"),
                "model": event.payload.get("model").and_then(Value::as_str),
                "reasoning": Value::Null,
                "startedAt": bounds.map(|link| link.started_at.clone()),
                "status": event.kind.0,
                "timestamp": event.ts,
                "tools": match recorded {
                    Some(turn) => Value::Array(turn.tools.clone()),
                    None => Value::Array(
                        summaries
                            .iter()
                            .enumerate()
                            .map(|(index, summary)| tool_call(index, summary))
                            .collect(),
                    ),
                },
                "unknown": Map::new(),
                "usage": match ran {
                    Some(candidate) => candidate_usage(candidate.usage.as_ref()),
                    None => turn_usage(event),
                },
                // The prompt the simulated user gave, which is what the turn
                // answered. Never the dispatch's persona name, which is who was
                // asked and not what they were asked.
                "user": recorded.map(|turn| turn.user.clone()).unwrap_or_default(),
            })
        })
        .collect();
    let mut attribution = Map::new();
    attribution.insert("runId".into(), json!(view.paths.run));
    if let Some(step) = first.and_then(|event| event.labels.step.clone()) {
        // The step within a node that runs several in sequence on one branch —
        // which is what a continuous graph has where a round-numbered stack used
        // to be, and the one addressing a transcript of a lifecycle node needs.
        attribution.insert("stepId".into(), json!(step));
    }
    if let Some(node) = &node {
        attribution.insert("nodeId".into(), json!(node));
    }
    attribution.insert("launchId".into(), json!(view.paths.run));
    attribution.insert(
        "launcher".into(),
        json!(launcher_word(&view.launch.launcher)),
    );
    attribution.insert(
        "transportRole".into(),
        json!(relayed_transport_role(events.iter().copied()).as_str()),
    );
    attribution.insert(
        "agentRole".into(),
        json!(
            agent_role(first.and_then(|event| event.labels.persona.as_deref())).unwrap_or("worker")
        ),
    );
    if let Some(persona) = first.and_then(|event| event.labels.persona.clone()) {
        attribution.insert("persona".into(), json!(persona));
    }
    attribution.insert(
        "finishedAt".into(),
        last.map_or(Value::Null, |event| json!(event.ts)),
    );
    json!({
        "conversation": {
            "canContinue": false,
            "harnesses": ["oneagentgraph"],
            "id": session,
            "name": node.clone().unwrap_or_else(|| view.paths.run.clone()),
            "project": view.paths.run,
            "startedAt": started_at,
            "state": last.map_or("unknown", |event| event.kind.0.as_str()),
            "turns": turns,
        },
        "attribution": Value::Object(attribution),
    })
}

/// One conversation by id, or `None` when the run records none by that name.
#[must_use]
pub fn conversation(view: &RunView, id: &ConversationId) -> Option<Value> {
    conversations(view)
        .into_iter()
        .find(|document| document["conversation"]["id"] == json!(id.as_str()))
}

/// One recorded artifact's bounded tail, or `None` when the run records none.
///
/// The id has already crossed the trust boundary as an [`ArtifactId`], so it is
/// a bare path segment; it is still resolved only against the ids the run's own
/// envelopes recorded, so a well-formed id naming a file the run never produced
/// reads nothing.
#[must_use]
pub fn artifact(view: &RunView, id: &ArtifactId) -> Option<Value> {
    let (event, recorded) = view.events.iter().find_map(|event| {
        event
            .artifacts
            .iter()
            .find(|artifact| artifact.id.0 == id.as_str())
            .map(|artifact| (event, artifact))
    })?;
    let kind = ReferenceKind::of(&recorded.kind);
    let bytes = artifact_bytes(view, event, id, kind)?;
    let truncated = bytes.len() > ARTIFACT_TAIL_BYTES;
    let tail = &bytes[bytes.len().saturating_sub(ARTIFACT_TAIL_BYTES)..];
    Some(json!({
        "id": id.as_str(),
        "kind": kind.as_str(),
        "content": String::from_utf8_lossy(tail),
        "truncated": truncated,
    }))
}

/// One recorded artifact's bytes, read from wherever the producing library said
/// it stored them.
///
/// A settled member's report is the one kind this run holds a copy of: the SDK
/// copies it into the run's own storage as the settlement is ingested, and
/// [`RunPaths::report_for`] is the published name of that copy — derived from
/// the envelope the artifact was recorded on, because **the artifact id names
/// the stream and not the seq**, so nothing about the id alone locates the file.
/// The sanitiser behind that name is private to `onepipeline` on purpose and is
/// never restated here: writer and reader share one implementation of it rather
/// than two that happen to agree.
///
/// A oneharness session is the kind whose bytes are *not* a file this crate
/// picks: they are one record inside the history store oneharness itself keeps,
/// read through that library — see [`harness_session`].
///
/// Everything else is a log the producing library stored beside the run, under
/// its own id.
///
/// [`RunPaths::report_for`]: onepipeline::views::RunPaths::report_for
fn artifact_bytes(
    view: &RunView,
    event: &Envelope,
    id: &ArtifactId,
    kind: ReferenceKind,
) -> Option<Vec<u8>> {
    // Listed rather than defaulted: where a kind's bytes live is a decision, and
    // a kind added to the vocabulary must be made to answer it rather than
    // inheriting an answer that happens to compile.
    let path = match kind {
        ReferenceKind::WorkerReport => report_path(view, event),
        ReferenceKind::OneharnessSession => return harness_session(event, id),
        ReferenceKind::Conversation | ReferenceKind::GateLog | ReferenceKind::Pr => {
            view.paths.dir.join("artifacts").join(id.as_str())
        }
    };
    fs::read(&path).ok()
}

/// Where the run keeps its copy of the report one settlement stored.
///
/// The SDK's own published name for that copy, called on the envelope the report
/// was recorded on and never restated: **the artifact id names the stream and not
/// the seq**, so nothing about the id alone locates the file, and the sanitiser
/// behind the name is private to `onepipeline` on purpose. One function because
/// two readers want it — the artifact route serves its bytes, and a transcript
/// reads the document inside it.
fn report_path(view: &RunView, settlement: &Envelope) -> std::path::PathBuf {
    view.paths.report_for(&settlement.stream, settlement.seq)
}

/// The oneharness conversation one `oneharness_session` artifact names, rendered
/// as the reader reads it.
///
/// The one artifact resolved outside the run directory: `oneagentgraph` publishes
/// a pointer and nothing is copied. `src/AGENTS.md` holds why the record alone
/// names the store, why this reads without locking, and why every component is
/// checked; [`Confined`] holds what each outcome of the check means.
///
// llmlint: ignore[comments_earn_their_place] the paragraph the rule objects to is the one the manager required survive: the checks are on how a record *spelled* a path, and a bare name that climbs nowhere still lands anywhere if a component is a symlink, so the resolved path is proved under a `StoreRoot` before it is opened. That sentence is what stops a future reader relaxing the confinement this change exists to add. The design it links to is in `src/AGENTS.md` and is not repeated here.
/// **The one thing that must not be relaxed here:** those checks are on how a
/// record *spelled* a path, and a bare name that climbs nowhere still lands
/// anywhere if a component of it is a symlink, so the resolved path is proved
/// under a [`StoreRoot`] before it is opened.
///
/// What is served is [`history::read_session_display`]'s record rather than the
/// file's bytes, which is what `docs/contract.md` names this artifact as.
// llmlint: ignore-block[authorization_enforced_server_side] there is no principal to authorize: `docs/contract.md` defines an unauthenticated read-only server, so a check here would be an access model this crate invented for itself. Nothing a reader sends reaches this path — the id must be one the run's own envelopes recorded, and the store, project and session are read off that envelope — and what the record names is confined below before it is opened.
fn harness_session(event: &Envelope, id: &ArtifactId) -> Option<Vec<u8>> {
    let field = |name: &str| event.payload.get(name).and_then(Value::as_str);
    // An empty value names no store, which is what oneharness itself reads
    // `history_dir = ""` as, so it falls back rather than being refused.
    let named = match field("history_dir").filter(|value| !value.is_empty()) {
        Some(named) => Some(NamedStore::try_from(named).ok()?),
        None => None,
    };
    let dir = history::resolve_dir(named.as_ref().map(NamedStore::as_str))?;
    let store = StoreRoot::read(&dir)?;
    let project = PathSegment::try_from(field("history_project")?).ok()?;
    let session = PathSegment::try_from(field("history_session")?).ok()?;
    let listed = history::find_session_path(&dir, Some(project.as_str()), session.as_str())
        .ok()
        .flatten()?;
    let path = match store.confine(&listed) {
        Confined::Under(path) => path,
        // The artifact id and not the pointer: an id has crossed the identifier
        // boundary and is safe to print, where every field of the pointer is a
        // record's own bytes and one of them could otherwise write a line of
        // this log itself. Where it landed is deliberately absent — an operator
        // needs to know their journal carries a pointer that escapes, and a
        // reader must not be told what is on the host by reading the answer.
        Confined::Escaped => {
            eprintln!(
                "onepipeline-api: artifact {}: refusing a oneharness session that resolves outside the store its record named",
                id.as_str()
            );
            return None;
        }
        Confined::Missing => return None,
    };
    let record = history::read_session_display(path.as_path())
        .ok()?
        .into_iter()
        .find(|record| record["history_id"] == json!(id.as_str()))?;
    serde_json::to_vec_pretty(&record).ok()
}
// llmlint: ignore-end[authorization_enforced_server_side]

/// The scope a timeline request asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope<'a> {
    /// The run and the nodes under it.
    Run,
    /// One node's own work.
    Node(&'a NodeId),
}

/// What a span's event list is built through: the turn numbering, and the
/// reader's filter.
///
/// The filter reaches exactly here and nowhere else in the timeline. **Which
/// spans exist, where they start and end, and what status each carries are what
/// the run recorded**, and a filter must not be able to hide a node from its own
/// timeline or move the ends of a dispatch — that would be a reader's attention
/// deciding what the run did. What it narrows is the records listed inside them.
///
/// The turn numbering is likewise built over the whole store: a turn's id is its
/// position in its session's transcript, so numbering a filtered store would
/// hand a client an id that names a different turn than the one the transcript
/// route serves under it.
struct Lens<'a> {
    turns: &'a [Option<Turn>],
    filter: &'a EventFilter,
}

impl Lens<'_> {
    /// The events of one span, as the reader asked for them.
    fn items(&self, events: &[(usize, &Envelope)]) -> Vec<Value> {
        events
            .iter()
            .filter(|(_, event)| self.filter.allows(event))
            .map(|(index, event)| timeline_event(*index, event, self.turns))
            .collect()
    }
}

/// The whole of `GET /api/v2/runs/{run}/timeline`'s payload.
#[must_use]
pub fn timeline(view: &RunView, scope: &Scope<'_>, filter: &EventFilter) -> Value {
    let turns = turn_ids(view);
    let lens = Lens {
        turns: &turns,
        filter,
    };
    let spans = match scope {
        Scope::Run => run_spans(view, &lens),
        Scope::Node(node) => node_spans(view, node.as_str(), &lens),
    };
    json!({
        "timeline_schema_version": TIMELINE_SCHEMA_VERSION,
        "run_id": view.paths.run,
        "spans": spans,
    })
}

/// The transcript turn one relayed envelope became.
struct Turn {
    session: ConversationId,
    id: String,
}

/// The turn each envelope of the run became, indexed by its place in the merged
/// store, and `None` for anything that is not a relayed turn.
///
/// [`conversations`] numbers a session's turns by their order *within that
/// session*, so a timeline event naming one has to carry the same id: that
/// pairing is the whole of how a client opens a plotted moment and finds the turn
/// behind it. Computed once per timeline rather than per event, because the
/// number is a position in the run and not a property of the envelope.
fn turn_ids(view: &RunView) -> Vec<Option<Turn>> {
    let mut counted: BTreeMap<&str, usize> = BTreeMap::new();
    let mut ids: Vec<Option<Turn>> = Vec::with_capacity(view.events.len());
    for event in &view.events {
        let named = is_turn_record(event)
            .then(|| {
                event
                    .labels
                    .extra
                    .get("session")
                    .and_then(Value::as_str)
                    .and_then(|session| {
                        ConversationId::try_from(session)
                            .ok()
                            .map(|id| (session, id))
                    })
            })
            .flatten();
        ids.push(named.map(|(session, id)| {
            let index = counted.entry(session).or_insert(0);
            let turn = Turn {
                session: id,
                id: format!("{session}.{index}"),
            };
            *index += 1;
            turn
        }));
    }
    ids
}

/// The redirection one record was, when it was one.
///
/// Two records in the merged store describe the same act from the two sides that
/// know different halves of it, and both are served under one shape so a reader
/// does not have to know which producer they are looking at:
///
/// - `oneagentgraph`'s `turn-interrupted` is the lever itself. It is published
///   for **every** interrupt, delivered or not, and says which member was
///   addressed, how many bytes were offered, and — exactly when the running turn
///   did not take them — why it did not.
/// - `onepipeline`'s `edit-committed` carries the compiled `context-added`
///   operation, whose `delivery` is that library's own word for where the note
///   ended up: into the running turn, or onto the node's next dispatch.
///
/// `delivered` is the field both fill, because it is the one thing a reader of a
/// turn that changed behaviour is asking: did this note reach the turn that was
/// running. `reason` is carried only beside a `false`, which is the discipline
/// `TurnInterrupted` itself keeps — a served redirection can never be read as
/// having had a reason to fail.
///
/// Both readings are validated before anything is served, and a record that
/// fails either is served as **no redirection at all** rather than as a
/// redirection that did not land: `delivered` is required on the sibling's own
/// type, and `delivery` is a closed pair. A malformed record read as `false`
/// would tell a planner their note is still owed to a node it may already have
/// reached, which is worse than the record being absent.
fn redirection(event: &Envelope) -> Option<Value> {
    let mut record = Map::new();
    match (event.source, event.kind.0.as_str()) {
        (Source::Agentgraph, graph::TURN_INTERRUPTED) => {
            let delivered = delivered(event)?;
            record.insert("delivered".into(), json!(delivered));
            // Each of the three strings below is served only when the record
            // actually carries one: the wire types them non-empty, so a blank
            // field is a record that said nothing and must be absent rather than
            // present and empty.
            if let Some(member) =
                non_empty(event.payload.get(graph::MEMBER).and_then(Value::as_str)).or_else(|| {
                    non_empty(
                        event
                            .labels
                            .extra
                            .get(graph::MEMBER)
                            .and_then(Value::as_str),
                    )
                })
            {
                record.insert("member".into(), json!(member));
            }
            if let Some(bytes) = event
                .payload
                .get(graph::INPUT_BYTES)
                .and_then(Value::as_u64)
            {
                record.insert("input_bytes".into(), json!(bytes));
            }
            if !delivered {
                if let Some(reason) =
                    non_empty(event.payload.get(graph::REASON).and_then(Value::as_str))
                {
                    record.insert("reason".into(), json!(reason));
                }
            }
        }
        (Source::Pipeline, _)
            if PipelineKind::from_wire(&event.kind) == Some(PipelineKind::EditCommitted) =>
        {
            let context = context_added(event)?;
            // Absent is `deferred`, which is what a record written before
            // delivery had modes means and the only thing those records did. A
            // word outside the pair is a record this build cannot read, and is
            // dropped rather than relayed for a client to fail on.
            let delivery = match context.get(edits::DELIVERY).and_then(Value::as_str) {
                None | Some(edits::DEFERRED) => edits::DEFERRED,
                Some(edits::LIVE) => edits::LIVE,
                Some(_) => return None,
            };
            record.insert("delivered".into(), json!(delivery == edits::LIVE));
            record.insert("delivery".into(), json!(delivery));
            if let Some(node) = non_empty(context.get(edits::NODE).and_then(Value::as_str)) {
                record.insert("node_id".into(), json!(node));
            }
        }
        _ => return None,
    }
    Some(Value::Object(record))
}

/// One recorded string, or `None` when what was recorded is blank.
///
/// Every string the redirection and the control reading serve is typed non-empty
/// on the wire, so a producer that wrote a field and left it blank has said
/// nothing rather than said something empty — and absent is what nothing is.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|recorded| !recorded.trim().is_empty())
}

/// Whether one `turn-interrupted` says the running turn took the redirection.
///
/// `None` when the record does not say — which is not the same as saying no.
/// `TurnInterrupted::delivered` is a required `bool` on the sibling's own type,
/// so a record missing it, or carrying anything else there, is one this build
/// cannot read; both readers of it treat that as the record having said nothing
/// rather than as a delivery that failed.
fn delivered(event: &Envelope) -> Option<bool> {
    event.payload.get(graph::DELIVERED)?.as_bool()
}

/// The `context-added` operation one `edit-committed` compiled to, if it did.
///
/// The first is the whole of it: the reconciler emits one `edit-committed` per
/// submitted command, and only a `context` command compiles to this operation.
/// The note itself is deliberately not read — it is the planner's prose, it is
/// bounded by nothing this crate can promise, and what a reader of the timeline
/// is asking is *whether* the turn took it rather than what it said.
fn context_added(event: &Envelope) -> Option<&Map<String, Value>> {
    event
        .payload
        .get(edits::OPERATIONS)?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .find(|operation| {
            operation.get(edits::KIND).and_then(Value::as_str) == Some(edits::CONTEXT_ADDED)
        })
}

/// One journal envelope as a timeline event.
fn timeline_event(index: usize, event: &Envelope, turns: &[Option<Turn>]) -> Value {
    let turn = turns.get(index).and_then(Option::as_ref);
    let mut item = Map::new();
    item.insert(
        "id".into(),
        json!(turn.map_or_else(|| format!("e{index}"), |turn| turn.id.clone())),
    );
    item.insert("kind".into(), json!(event.kind.0));
    item.insert("at".into(), json!(event.ts));
    if let Some(node) = &event.labels.node {
        item.insert("node_id".into(), json!(node));
    }
    if let Some(step) = &event.labels.step {
        item.insert("step_id".into(), json!(step));
    }
    if let Some(status) = event.payload.get("status").and_then(Value::as_str) {
        item.insert("status".into(), json!(status));
    }
    // Who submitted an accepted live edit. The SDK carries an `author` on every
    // `edit-committed`, and the run enforces a per-author op allowlist — the
    // planner may issue every op and the monitor a narrower set — so an edit that
    // changed the graph and an edit the monitor self-applied are two different
    // facts about the same run, and a reader that could not tell them apart was
    // reading the second as the planner's own decision.
    if let Some(author) = event.payload.get("author").and_then(Value::as_str) {
        item.insert("author".into(), json!(author));
    }
    if let Some(redirection) = redirection(event) {
        item.insert("redirection".into(), redirection);
    }
    // Where the event's own heavy content lives, never inlined: the transcript it
    // is a turn of, the change it published, or the first evidence it stored. A
    // reader opens the record and the client fetches that one thing.
    if let Some(turn) = turn {
        item.insert(
            "reference".into(),
            json!({ "kind": "conversation", "value": turn.session }),
        );
    } else if let Some(url) = event.payload.get("url").and_then(Value::as_str) {
        item.insert("reference".into(), json!({ "kind": "pr", "value": url }));
    } else if let Some(artifact) = event.artifacts.first() {
        item.insert(
            "reference".into(),
            json!({ "kind": ReferenceKind::of(&artifact.kind).as_str(), "value": artifact.id.0 }),
        );
    }
    Value::Object(item)
}

/// The run, with the nodes it is executing beneath it.
///
/// One root span, not one per round. Execution is continuous, so what the run is
/// doing is one unbroken stretch from its first record to its last, and the
/// nodes under it overlap freely: a node dispatches the moment its dependencies
/// settle and independent branches proceed beside a decision that is holding
/// another subtree back. Under rounds the top of this list was a stack of
/// batches, which is a shape nothing in the engine has any more.
fn run_spans(view: &RunView, lens: &Lens<'_>) -> Vec<Value> {
    let mut spans: Vec<Value> = Vec::new();
    let events: Vec<(usize, &Envelope)> = view.events.iter().enumerate().collect();
    let Some((_, first)) = events.first() else {
        return spans;
    };
    let run_id = format!("run.{}", view.paths.run);
    // A run ends when it stops being driven, and only then. A graph that has
    // completed and a run that recorded a stop are both over; anything else is
    // still open, however quiet it has gone.
    let closed = view.state.stop_recorded() || graph_complete(view);
    let ended = if closed {
        events.last().map_or(Value::Null, |(_, e)| json!(e.ts))
    } else {
        Value::Null
    };
    spans.push(json!({
        "id": run_id,
        "kind": "run",
        "label": view.paths.run,
        "started_at": first.ts,
        "ended_at": ended,
        "phase": phase_word(view),
        // What the run itself recorded: the relayed turns belong to the
        // sessions below, and carrying them here too would draw every one
        // of them on the run's row twice.
        "events": lens.items(
            &events
                .iter()
                .filter(|(_, event)| {
                    event.labels.node.is_none() && event.source != Source::Agentgraph
                })
                .copied()
                .collect::<Vec<_>>(),
        ),
    }));
    // The sessions relayed at no node: the run's own driving conversations,
    // which belong to the run rather than to any of its work. Left open until
    // the run closes, because a session that has stopped talking has not
    // necessarily stopped.
    let unattached: Vec<(usize, &Envelope)> = events
        .iter()
        .filter(|(_, event)| event.labels.node.is_none())
        .copied()
        .collect();
    for (session, relayed) in relayed_sessions(&unattached) {
        let mut span = Map::new();
        span.insert("id".into(), json!(format!("run-session.{session}")));
        span.insert("kind".into(), json!("dispatch"));
        span.insert("label".into(), json!(session));
        span.insert(
            "started_at".into(),
            json!(relayed.first().map(|(_, event)| &event.ts)),
        );
        span.insert(
            "ended_at".into(),
            if closed {
                json!(relayed.last().map(|(_, event)| &event.ts))
            } else {
                Value::Null
            },
        );
        span.insert("parent_id".into(), json!(run_id));
        // Running for as long as the run it is driving is: nothing closes a
        // run-level session of its own, so the run's own end is the only thing
        // that can speak for it, and "unknown" would be this crate declining to
        // say what the run already said.
        span.insert(
            "status".into(),
            json!(if closed { "done" } else { "running" }),
        );
        span.insert(
            "transport_role".into(),
            json!(relayed_transport_role(relayed.iter().map(|(_, event)| *event)).as_str()),
        );
        if let Some(role) = agent_role(
            relayed
                .first()
                .and_then(|(_, event)| event.labels.persona.as_deref()),
        ) {
            span.insert("agent_role".into(), json!(role));
        }
        span.insert(
            "reference".into(),
            json!({ "kind": "conversation", "value": session }),
        );
        span.insert("events".into(), json!(lens.items(&relayed)));
        spans.push(Value::Object(span));
    }

    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for node in events
        .iter()
        .filter_map(|(_, event)| event.labels.node.as_deref())
    {
        if !seen.insert(node) {
            continue;
        }
        spans.push(node_span(view, node, Some(&run_id), lens));
        // What that node did, as categories rather than as records: the graph
        // draws one lane per category and opens the node for the rest.
        let node_id = format!("node.{node}");
        let mine: Vec<(usize, &Envelope)> = events
            .iter()
            .filter(|(_, event)| event.labels.node.as_deref() == Some(node))
            .copied()
            .collect();
        let settled = mine.iter().find(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
        });
        spans.extend(waiting_span(view, settled, &node_id, node));
        spans.extend(role_rollups(&mine, &node_id, node));
        spans.extend(kept_spans(view, &mine, &node_id, node));
    }
    spans
}

/// One node's span.
fn node_span(view: &RunView, node: &str, parent: Option<&str>, lens: &Lens<'_>) -> Value {
    let events: Vec<(usize, &Envelope)> = view
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.labels.node.as_deref() == Some(node))
        .collect();
    let started = events
        .first()
        .map_or_else(now_rfc3339, |(_, event)| event.ts.clone());
    // The *last* settlement, not the first: a node the planner retried settles
    // more than once, and the span has to close where the node's work actually
    // ended rather than where its superseded attempt did.
    let settled = events.iter().rev().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
    });
    let mut span = Map::new();
    span.insert("id".into(), json!(format!("node.{node}")));
    span.insert("kind".into(), json!("node"));
    span.insert("label".into(), json!(node));
    span.insert("started_at".into(), json!(started));
    span.insert(
        "ended_at".into(),
        settled.map_or(Value::Null, |(_, event)| json!(event.ts)),
    );
    if let Some(parent) = parent {
        span.insert("parent_id".into(), json!(parent));
    }
    span.insert("node_id".into(), json!(node));
    if let Some(status) = settled
        .and_then(|(_, event)| event.payload.get("status"))
        .and_then(Value::as_str)
    {
        span.insert("status".into(), json!(status_word(status)));
    }
    span.insert("events".into(), json!(lens.items(&events)));
    Value::Object(span)
}

/// The agent-graph sessions a slice of a run's events relayed, each with its own
/// envelopes, in the order the slice first mentioned them.
///
/// A session id that could not survive a round trip through a route is dropped
/// rather than served: the client fetches a transcript by it, so an id it cannot
/// ask for is an id this crate must not offer.
fn relayed_sessions<'a>(
    events: &[(usize, &'a Envelope)],
) -> Vec<(&'a str, Vec<(usize, &'a Envelope)>)> {
    let mut sessions: Vec<(&str, Vec<(usize, &Envelope)>)> = Vec::new();
    for (index, event) in events {
        if event.source != Source::Agentgraph {
            continue;
        }
        let Some(session) = event
            .labels
            .extra
            .get("session")
            .and_then(Value::as_str)
            .filter(|session| ConversationId::try_from(*session).is_ok())
        else {
            continue;
        };
        match sessions.iter_mut().find(|(name, _)| *name == session) {
            Some((_, relayed)) => relayed.push((*index, event)),
            None => sessions.push((session, vec![(*index, event)])),
        }
    }
    sessions
}

/// The branch a node opened and what became of it, from the records `onevcs`
/// relayed for it.
///
/// This is the publication interval the journal actually holds: the session open
/// and whatever closed it are separate relayed records, so the span between them
/// is recorded rather than derived. A node that opened no session contributes
/// none, and one that opened a session nothing closed is served open-ended,
/// which is what an in-flight publication is.
fn publication_span(events: &[(usize, &Envelope)], parent: &str, node: &str) -> Option<Value> {
    let relayed = |kinds: &[&str]| {
        events
            .iter()
            .find(|(_, event)| {
                event.source == Source::Vcs && kinds.contains(&event.kind.0.as_str())
            })
            .map(|(_, event)| *event)
    };
    let last_relayed = |kinds: &[&str]| {
        events
            .iter()
            .rev()
            .find(|(_, event)| {
                event.source == Source::Vcs && kinds.contains(&event.kind.0.as_str())
            })
            .map(|(_, event)| *event)
    };
    let opened = relayed(&[vcs::SESSION_OPENED])?;
    let merged = last_relayed(&[vcs::CHANGE_MERGED, vcs::MERGE_COMPLETED]);
    let conflicted = last_relayed(&[vcs::SYNC_CONFLICT]);
    let change = last_relayed(&[vcs::CHANGE_MERGED, vcs::CHANGE_OPENED]);
    // What closed the publication, in the order those records mean: a merge ends
    // it, a conflict ends it without one, and a change left open ends the run's
    // part in it. Nothing closing it is an in-flight publication, not an error.
    let closed = merged.or(conflicted).or(change);
    let branch = opened
        .payload
        .get("branch")
        .and_then(Value::as_str)
        .unwrap_or(node);
    let mut span = Map::new();
    span.insert("id".into(), json!(format!("publication.{node}")));
    span.insert("kind".into(), json!("publication"));
    span.insert("label".into(), json!(branch));
    span.insert("started_at".into(), json!(opened.ts));
    span.insert(
        "ended_at".into(),
        closed.map_or(Value::Null, |event| json!(event.ts)),
    );
    span.insert("parent_id".into(), json!(parent));
    span.insert("node_id".into(), json!(node));
    if closed.is_some() {
        span.insert(
            "status".into(),
            json!(if merged.is_some() {
                "merged"
            } else if conflicted.is_some() {
                "conflict"
            } else {
                "open"
            }),
        );
    }
    if let Some(url) = change
        .and_then(|event| event.payload.get("url"))
        .and_then(Value::as_str)
    {
        span.insert("reference".into(), json!({ "kind": "pr", "value": url }));
    }
    span.insert("events".into(), Value::Array(Vec::new()));
    Some(Value::Object(span))
}

/// The contention one node met on the locks its publication had to take, as one
/// summary rather than as one span per wait.
///
/// `onevcs` times every wait itself and relays it with the identity it queued on
/// — a real publication takes thousands of them, and a graph that drew one span
/// each would be a download rather than a reading. What is served is the count
/// and the total the run actually waited, which is the pair the client's own
/// aggregate lane plots; a reader who wants the individual waits opens the node,
/// where each `lock-wait` is still an event of its own.
///
/// The interval is the recorded one read backwards: the record is written when
/// the turn came, and carries how long it had been waiting for it.
fn lock_wait_rollup(events: &[(usize, &Envelope)], parent: &str, node: &str) -> Option<Value> {
    let waits: Vec<(&Envelope, u64)> = events
        .iter()
        .filter(|(_, event)| event.source == Source::Vcs && event.kind.0 == vcs::LOCK_WAIT)
        .filter_map(|(_, event)| seconds_as_ms(event.payload.get("elapsed")).map(|ms| (*event, ms)))
        .collect();
    let first = waits.first()?;
    let last = waits.last()?;
    let total: u64 = waits.iter().map(|(_, ms)| *ms).sum();
    let started = millis_of(&first.0.ts)
        .map(|at| at.saturating_sub(i128::from(first.1)))
        .and_then(rfc3339_of)
        .unwrap_or_else(|| first.0.ts.clone());
    Some(json!({
        "id": format!("rollup.{node}.lock-wait"),
        "kind": "rollup",
        // The kind it summarizes, which is how a client reads its lane: a rollup
        // is never named for being one.
        "label": vcs::LOCK_WAIT,
        "started_at": started,
        "ended_at": last.0.ts,
        "parent_id": parent,
        "node_id": node,
        "count": waits.len(),
        "total_duration_ms": total,
        "events": Vec::<Value>::new(),
    }))
}

/// The wait on a person a node's settlement records, when it recorded one.
///
/// Real recorded time, drawn as its own span rather than as silence — including
/// for a human action, which is never dispatched at all and would otherwise
/// contribute no span but its own settlement.
fn waiting_span(
    view: &RunView,
    settled: Option<&(usize, &Envelope)>,
    parent: &str,
    node: &str,
) -> Option<Value> {
    let (_, wait_start) = settled.filter(|(_, event)| {
        event.payload.get("status").and_then(Value::as_str) == Some("waiting")
    })?;
    let attested = view.events.iter().find(|event| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::HumanAttested)
            && event.labels.node.as_deref() == Some(node)
    });
    Some(json!({
        "id": format!("human-wait.{node}"),
        "kind": "human-wait",
        "label": format!("{node} awaiting a person"),
        "started_at": wait_start.ts,
        "ended_at": attested.map_or(Value::Null, |event| json!(event.ts)),
        "parent_id": parent,
        "node_id": node,
        "events": Vec::<Value>::new(),
    }))
}

/// What a node kept: one span per artifact it stored, and the branch it published.
fn kept_spans(
    view: &RunView,
    events: &[(usize, &Envelope)],
    parent: &str,
    node: &str,
) -> Vec<Value> {
    let mut kept: Vec<Value> = evidence(view, node)
        .into_iter()
        .map(|record| {
            json!({
                "id": format!("verification.{node}.{}", record.artifact),
                "kind": "verification",
                "label": record.artifact,
                "started_at": record.since,
                "ended_at": record.at,
                "parent_id": parent,
                "node_id": node,
                "status": if record.ok { "ok" } else { "failed" },
                "detail": {
                    "ok": record.ok,
                    "output_tail": record.output_tail,
                    "artifact_id": record.artifact,
                },
                "events": Vec::<Value>::new(),
            })
        })
        .collect();
    kept.extend(publication_span(events, parent, node));
    kept.extend(lock_wait_rollup(events, parent, node));
    kept
}

/// One node's dispatched sessions, summarized one span per category.
///
/// The graph-level reading of a run is a reading rather than a download: a node
/// that dispatched two hundred sessions is two hundred spans at node scope and
/// one per category here, carrying the pair that names the category and the count
/// it stands for. No events, no references, no bodies — a reader who wants those
/// opens the node.
///
/// The category is the *pair* and not either half of it, which is what tells a
/// lint run from the worker whose semantic role it borrows: both are `worker`
/// work, and only the transport half says which of them ran.
fn role_rollups(events: &[(usize, &Envelope)], parent: &str, node: &str) -> Vec<Value> {
    let dispatched = events.iter().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched)
    });
    let Some((_, start)) = dispatched else {
        return Vec::new();
    };
    let settled = events.iter().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
    });
    let mut counted: Vec<((Party, &'static str), usize)> = Vec::new();
    for (_, relayed) in relayed_sessions(events) {
        let persona = relayed
            .first()
            .and_then(|(_, event)| event.labels.persona.as_deref())
            .or(start.labels.persona.as_deref());
        let Some(role) = agent_role(persona) else {
            continue;
        };
        let pair = (
            relayed_transport_role(relayed.iter().map(|(_, e)| *e)),
            role,
        );
        match counted.iter_mut().find(|(named, _)| *named == pair) {
            Some((_, count)) => *count += 1,
            None => counted.push((pair, 1)),
        }
    }
    if counted.is_empty() {
        // Dispatched and nothing relayed: still one category, because the node
        // was dispatched and the row has to say so.
        if let Some(role) = agent_role(start.labels.persona.as_deref()) {
            counted.push(((transport_role(start), role), 1));
        }
    }
    counted
        .into_iter()
        .map(|((transport, role), count)| {
            json!({
                "id": format!("rollup.{node}.{}.{role}", transport.as_str()),
                "kind": "rollup",
                "label": "dispatch",
                "started_at": start.ts,
                "ended_at": settled.map_or(Value::Null, |(_, event)| json!(event.ts)),
                "parent_id": parent,
                "node_id": node,
                "count": count,
                "agent_role": role,
                "transport_role": transport.as_str(),
                "events": Vec::<Value>::new(),
            })
        })
        .collect()
}

/// One node's own work: the node span, then a dispatch span per session.
///
/// One pass rather than one per round. A node's records are its records: the
/// engine dispatches it when its dependencies settle and re-asks a dispatch that
/// produced nothing, and every attempt is the same node doing the same work, so
/// the node has one span and the sessions under it are all of the sessions it
/// ran.
fn node_spans(view: &RunView, node: &str, lens: &Lens<'_>) -> Vec<Value> {
    let mut spans: Vec<Value> = Vec::new();
    let events: Vec<(usize, &Envelope)> = view
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.labels.node.as_deref() == Some(node))
        .collect();
    if events.is_empty() {
        return spans;
    }
    let node_id = format!("node.{node}");
    spans.push(node_span(view, node, None, lens));
    // The last settlement, for the same reason [`node_span`] takes it: a node the
    // planner retried settled once already, and the attempt that is running now
    // is not closed by the record that closed the one it superseded.
    let settled = events.iter().rev().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
    });

    spans.extend(waiting_span(view, settled, &node_id, node));

    // The evidence the node kept and the branch it published: both sit inside
    // the dispatch they were recorded during, so both are appended after it.
    // The plot paints in the order it is given, and a segment underneath one
    // that covers it is a segment no pointer can reach.
    let mut inside = kept_spans(view, &events, &node_id, node);

    let dispatched = events.iter().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched)
    });
    let Some((_, start)) = dispatched else {
        spans.append(&mut inside);
        return spans;
    };
    let key = dispatch_key(&view.paths.run, node);
    // A node whose latest settlement is older than its latest dispatch was
    // re-asked and is running again; one the run has not settled at all is
    // running for the first time. Both are a state the run is asserting rather
    // than one this crate is guessing, and leaving it absent would leave a reader
    // with "unknown" for the one case they can see is in flight.
    let settled_position = settled.map(|(index, _)| *index);
    let redispatched = events
        .iter()
        .rev()
        .find(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched)
        })
        .is_some_and(|(index, _)| settled_position.is_none_or(|settled| *index > settled));
    let status = if redispatched {
        "running"
    } else {
        settled
            .and_then(|(_, event)| event.payload.get("status"))
            .and_then(Value::as_str)
            .map_or("running", status_word)
    };

    // One span per session the node ran under, all carrying the same
    // `dispatch_id`: that key is what groups them back into the one dispatch
    // they are, and a node that ran a worker, a judge and a check-in at once
    // is three transcripts an operator has to be able to tell apart. A
    // dispatch that relayed no session at all is still one span, because the
    // node was dispatched and that is a fact of its own.
    let mut sessions = relayed_sessions(&events);
    if sessions.is_empty() {
        sessions.push((node, Vec::new()));
    }

    for (session, relayed) in sessions {
        let named = relayed.is_empty().then(|| format!("{node} dispatch"));
        let mut span = Map::new();
        span.insert("id".into(), json!(format!("dispatch.{session}")));
        span.insert("kind".into(), json!("dispatch"));
        span.insert(
            "label".into(),
            json!(named.clone().unwrap_or_else(|| session.to_owned())),
        );
        // The dispatch, and the settlement that closed it. A session's own
        // first and last envelopes are the first and last things it *said*,
        // not its ends: a session says nothing while it works, so bracketing
        // it by its own messages would draw a dispatch that ran for minutes
        // as the instant between two of them — and would put the node's own
        // dispatch record outside the window drawn for it.
        span.insert("started_at".into(), json!(start.ts));
        span.insert(
            "ended_at".into(),
            if redispatched {
                Value::Null
            } else {
                settled.map_or(Value::Null, |(_, event)| json!(event.ts))
            },
        );
        span.insert("parent_id".into(), json!(node_id));
        span.insert("node_id".into(), json!(node));
        if let Some(step) = relayed
            .first()
            .and_then(|(_, event)| event.labels.step.as_deref())
        {
            // Which step of a lifecycle node this session ran: the node runs
            // several in sequence on one branch, and the label is the only thing
            // that tells one of their transcripts from the next.
            span.insert("step_id".into(), json!(step));
        }
        if let Some(key) = &key {
            span.insert("dispatch_id".into(), json!(key));
        }
        // The party that ran this session, not the party the node was
        // dispatched under: the two differ exactly when the dispatch ran a
        // supervising or a lint chain beside its worker, which is the pair a
        // reader needs to tell three concurrent transcripts apart.
        span.insert(
            "transport_role".into(),
            json!(if relayed.is_empty() {
                transport_role(start).as_str()
            } else {
                relayed_transport_role(relayed.iter().map(|(_, event)| *event)).as_str()
            }),
        );
        let persona = relayed
            .first()
            .and_then(|(_, event)| event.labels.persona.as_deref())
            .or(start.labels.persona.as_deref());
        if let Some(role) = agent_role(persona) {
            span.insert("agent_role".into(), json!(role));
        }
        span.insert("status".into(), json!(status));
        if named.is_none() {
            span.insert(
                "reference".into(),
                json!({ "kind": "conversation", "value": session }),
            );
        }
        span.insert("events".into(), json!(lens.items(&relayed)));
        spans.push(Value::Object(span));
    }
    spans.append(&mut inside);
    spans
}

/// What each of a run's nodes was last seen doing from inside a turn.
///
/// `oneagentgraph` publishes a bounded tool summary while the turn is still
/// running — that is what `turn-activity` is for, and it is streamed rather than
/// held back — so a run being watched has something in flight to report between
/// turns. One entry per node, carrying its latest summary and how many it has
/// recorded, oldest first: a reader takes the last of them as what the run is
/// doing now.
///
/// A summary stamped at no node is not served, and neither is one whose node is
/// a name a route would refuse: the client's own record requires the node, and it
/// reads the node's timeline by it — so a node it cannot ask for is a node this
/// crate must not offer. Neither is one the reader's filter excluded: an activity
/// summary is a record like any other, and this is the listing of them.
#[must_use]
pub fn live_activity(view: &RunView, filter: &EventFilter) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: BTreeMap<String, (i128, Value)> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph
            || event.kind.0 != graph::TURN_ACTIVITY
            || !filter.allows(event)
        {
            continue;
        }
        // One entry per node, keyed by the node alone: a node is dispatched once
        // per readiness and re-asked in place, so what it is doing now is one
        // answer rather than one per batch it belonged to.
        let (Some(node), Some(at)) = (
            event
                .labels
                .node
                .as_deref()
                .and_then(|node| NodeId::try_from(node).ok()),
            millis_of(&event.ts),
        ) else {
            continue;
        };
        let node = node.as_str().to_owned();
        let counted = latest
            .get(&node)
            .and_then(|(_, seen)| seen["events"].as_u64())
            .unwrap_or(0);
        #[allow(clippy::cast_precision_loss)]
        // Epoch milliseconds, which f64 carries exactly past any date a run
        // records; the client reads this as its own clock.
        let stamp = at as f64;
        let mut entry = Map::new();
        entry.insert("node".into(), json!(node));
        // The step within a lifecycle node, when the record names one: the node
        // runs several in sequence on one branch, and which of them is talking is
        // what a reader watching it needs.
        if let Some(step) = event.labels.step.as_deref() {
            entry.insert("step".into(), json!(step));
        }
        entry.insert("at".into(), json!(stamp));
        for field in ["kind", "name", "detail"] {
            entry.insert(
                field.into(),
                json!(event
                    .payload
                    .get(field)
                    .and_then(Value::as_str)
                    .unwrap_or_default()),
            );
        }
        entry.insert("events".into(), json!(counted + 1));
        if latest
            .insert(node.clone(), (at, Value::Object(entry)))
            .is_none()
        {
            order.push(node);
        }
    }
    let mut activity: Vec<(i128, Value)> = order
        .into_iter()
        .filter_map(|key| latest.remove(&key))
        .collect();
    activity.sort_by_key(|(at, _)| *at);
    activity.into_iter().map(|(_, entry)| entry).collect()
}

/// A change token for one run, as one connection sees it.
///
/// How many events the run has recorded that this connection is watching for,
/// and when it last wrote. The round it was in used to lead this tuple, and there
/// is no round — which costs the token nothing, because a run that moved recorded
/// something and both remaining halves say so.
///
/// The filter is what makes this token the *connection's*: the stream
/// invalidates rather than restating state, so a run whose only new records this
/// reader excluded has not moved as far as they are concerned and is not
/// announced.
///
/// **Both halves have to come from the admitted events, not one of them.** The
/// run's own `last_write_at` moves on every record it writes, admitted or not, so
/// a token that kept it would change on the very events the filter exists to
/// suppress — and the filter would narrow the payloads while announcing every
/// movement anyway. A filtered connection is therefore keyed on how many records
/// it admitted and when the last of them was stamped.
#[must_use]
pub fn signature(view: &RunView, filter: &EventFilter) -> Signature {
    if filter.admits_everything() {
        return (view.events.len(), view.state.last_write_at.unwrap_or(0));
    }
    let admitted: Vec<&Envelope> = view
        .events
        .iter()
        .filter(|event| filter.allows(event))
        .collect();
    let last = admitted
        .last()
        .and_then(|event| millis_of(&event.ts))
        .and_then(|at| u64::try_from(at).ok())
        .unwrap_or(0);
    (admitted.len(), last)
}

/// What [`signature`] compares: how much the run has recorded, and when it last
/// did.
pub type Signature = (usize, u64);

/// A change token for one run's transcripts, so a watcher can tell an edited
/// turn from a new one.
///
/// Taken over the transcripts this reader is being *served*, for the same reason
/// [`signature`] counts only admitted events: a connection narrowed to decisions
/// is served no transcripts at all, so a turn arriving in one is not a change to
/// anything it is watching — and a digest over the whole store would wake it on
/// every tool call the filter exists to keep out of its way.
#[must_use]
pub fn conversation_signature(view: &RunView, filter: &EventFilter) -> String {
    let mut hasher = Sha256::new();
    for document in conversations_under(view, filter) {
        hasher.update(document.to_string().as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .take(8)
        .fold(String::new(), |mut out, byte| {
            out.push_str(&format!("{byte:02x}"));
            out
        })
}
