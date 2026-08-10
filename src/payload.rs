//! Projecting the onepipeline SDK's run records onto the wire shapes.
//!
//! The SDK owns the records — the launch record, the merged event store, the
//! folded run state, the per-round plan and result. This module owns only the
//! projection onto what `docs/contract.md` serves: it renames nothing the SDK
//! already names and computes nothing the SDK already computes, and every place
//! it does derive something (the timing buckets, a dispatch key, a session key)
//! is listed in AGENTS.md as a computation proposed for the SDK, where the agent
//! reading the CLI would see it too.
//!
//! Everything here is a pure function of a [`RunView`] plus the run directory,
//! so a payload can be built and asserted without a server.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use onepipeline::event::{Envelope, PipelineKind, Source};
use onepipeline::plan::{Node, Plan};
use onepipeline::views::{liveness_word, RunView};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::contract::{ArtifactId, ConversationId, DispatchId, NodeId, TIMELINE_SCHEMA_VERSION};

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
    /// `{command, comparison_remote, comparison_base}`.
    pub const GATE_STARTED: &str = "gate-started";
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

/// The kinds `oneagentgraph` relays, and the keys its own `Usage` is written
/// with, on the same terms as the `onevcs` vocabulary beside it: matched as the
/// wire strings that library writes, because the vocabulary is the sibling's.
///
/// Unlike `onevcs`, that library declares this vocabulary in a public module, so
/// `tests/contract.rs` holds every name here to the sibling's own type rather
/// than to a second reading of the wire.
pub mod graph {
    /// `{kind, name, detail, truncated}` — one bounded tool summary, published
    /// from inside a turn rather than after it.
    pub const TURN_ACTIVITY: &str = "turn-activity";
    /// A turn finished, carrying the [`USAGE`] it consumed.
    pub const TURN_COMPLETED: &str = "turn-completed";
    /// Where that usage sits on the payload.
    pub const USAGE: &str = "usage";
    /// Input tokens.
    pub const TOKENS_IN: &str = "tokens_in";
    /// Output tokens.
    pub const TOKENS_OUT: &str = "tokens_out";
    /// Tokens read from the prompt cache.
    pub const CACHE_READ: &str = "cache_read";
    /// Tokens written to the prompt cache.
    pub const CACHE_WRITE: &str = "cache_write";
    /// What the turn cost.
    pub const COST: &str = "cost";
    /// How long the turn took, in seconds.
    pub const DURATION: &str = "duration";
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
/// has no rendering, and one round's recorded result can hold any word at all.
// llmlint: ignore-block[invalid_states_unrepresentable] the same filter, over a field a round's own result can hold any word at all in: `status_word` maps what the run wrote onto exactly this set, and `node_counts` still reports the raw word, which an enum would have destroyed.
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

/// The key that groups the sessions of one node's dispatch within one round.
///
/// Derived rather than recorded: the SDK's journal stamps a dispatch with its
/// run, round, and node but mints no id for it, and schema 10 serves one. The
/// three together identify the dispatch exactly, so the derived key is stable
/// across reads and across processes.
///
/// A [`DispatchId`] rather than a bare `String`, and `None` when the run and
/// node on disk cannot form one: a client reads `dispatch_id` to ask about the
/// dispatch, so minting one the contract's own boundary would reject is the
/// drift the newtype exists to prevent.
fn dispatch_key(run: &str, round: u64, node: &str) -> Option<DispatchId> {
    DispatchId::try_from(format!("{run}.{round:02}.{node}")).ok()
}

/// Read one JSON document, or `None` if it is missing or unreadable.
///
/// A run directory is recorded, not curated: a half-written round result is a
/// file this read skips, not a run it refuses to serve.
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// One run, as `GET /api/v2/runs` lists it.
#[must_use]
pub fn run_summary(view: &RunView) -> Value {
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
    summary.insert("timing".into(), timing(view));
    summary.insert("node_counts".into(), json!(counts));
    summary.insert("launch".into(), launch(view));
    Value::Object(summary)
}

/// Every node's status as the run itself last wrote it, in the run's own words.
///
/// The same derivation the round payload renders from, so a list row and the
/// graph it opens cannot describe different graphs — the disagreement an
/// operator would otherwise see between the two. An *open* round is the live
/// fold; a closed one is its own recorded result, which is the only account of
/// it that survives the next round starting, and which is all a run predating
/// the journal ever had. The words are unmapped on purpose: a count reports what
/// the run wrote, where a status a client switches on cannot.
fn recorded_statuses(view: &RunView) -> BTreeMap<String, Recorded> {
    let folded = || -> BTreeMap<String, Recorded> {
        view.state
            .statuses()
            .into_iter()
            .map(|(node, status)| {
                let outcome = view.state.outcomes.get(&node).cloned();
                (
                    node,
                    Recorded {
                        status: status.as_str().to_owned(),
                        outcome,
                    },
                )
            })
            .collect()
    };
    if view.state.round_open {
        return folded();
    }
    // `max(1)` because a run predating the journal has no round-started event to
    // fold at all: its round number is zero and its result is still on disk.
    let recorded: BTreeMap<String, Recorded> =
        read_json(&view.paths.round_result(view.state.round.max(1)))
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
            .collect();
    if recorded.is_empty() {
        folded()
    } else {
        recorded
    }
}

/// What one node's last account of itself said: its status word, and the outcome
/// word beside it when it recorded one.
///
/// Both are the run's own words, unmapped. A round's recorded result can hold
/// any word at all in either field, and `node_counts` reports exactly what it
/// held; the mapping onto the vocabulary a client switches on happens where a
/// client is being served, in [`status_word`] and [`failure_class`].
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
fn phase_word(view: &RunView) -> &'static str {
    if view.state.stopped {
        return "finished";
    }
    if view.state.round_open {
        return "driving-round";
    }
    if view.state.round == 0 {
        return "starting";
    }
    if view.state.surfaces_queued > view.state.surfaces_read {
        return "surfacing";
    }
    "reviewing-results"
}

/// The kind of the run's most recent event, or `null` for a run that has
/// recorded none — which is how a just-launched run reads on disk.
fn last_event(view: &RunView) -> Value {
    view.events
        .last()
        .map_or(Value::Null, |event| json!(event.kind.0))
}

/// How completely the run's own clock is accounted for.
fn timing_quality(view: &RunView) -> &'static str {
    if view.events.is_empty() {
        "legacy"
    } else if view.state.round_open {
        "partial"
    } else {
        "complete"
    }
}

/// One span of the run's wall clock, named by what the run was doing across it.
#[derive(Debug, Default, Clone, Copy)]
struct Buckets {
    dispatching_ms: u64,
    awaiting_planner_ms: u64,
    awaiting_human_ms: u64,
    orchestrating_ms: u64,
    wall_ms: u64,
}

/// Attribute the run's wall clock, one span between consecutive events at a
/// time, so the parts add up to the whole.
///
/// This is the SDK's own `telemetry` fold, which is behind its contract surface
/// rather than on it. Recomputing it here is one of the computations AGENTS.md
/// proposes moving into the SDK; the mapping onto the wire's eight-way timing is
/// documented on [`timing`].
fn buckets(view: &RunView) -> Buckets {
    let stamps: Vec<(i128, &Envelope)> = view
        .events
        .iter()
        .filter_map(|event| millis_of(&event.ts).map(|ms| (ms, event)))
        .collect();
    let Some((first, _)) = stamps.first().copied() else {
        return Buckets::default();
    };
    let last = stamps.last().map_or(first, |(ms, _)| *ms);

    let mut totals = Buckets {
        wall_ms: u64::try_from(last.saturating_sub(first)).unwrap_or(0),
        ..Buckets::default()
    };
    let mut in_flight: u64 = 0;
    let mut awaiting_planner = false;
    let mut awaiting_human: u64 = 0;
    let mut previous = first;

    for (ms, event) in &stamps {
        let span = u64::try_from(ms.saturating_sub(previous)).unwrap_or(0);
        if in_flight > 0 {
            totals.dispatching_ms += span;
        } else if awaiting_planner {
            totals.awaiting_planner_ms += span;
        } else if awaiting_human > 0 {
            totals.awaiting_human_ms += span;
        } else {
            totals.orchestrating_ms += span;
        }
        previous = *ms;

        if event.source != Source::Pipeline {
            continue;
        }
        match PipelineKind::from_wire(&event.kind) {
            Some(PipelineKind::NodeDispatched) => in_flight += 1,
            Some(PipelineKind::NodeSettled) => {
                in_flight = in_flight.saturating_sub(1);
                if event.payload.get("status").and_then(Value::as_str) == Some("waiting") {
                    awaiting_human += 1;
                }
            }
            Some(PipelineKind::HumanAttested) => awaiting_human = awaiting_human.saturating_sub(1),
            Some(PipelineKind::PlannerSurfaced) => {
                awaiting_planner = event
                    .payload
                    .get("blocking")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
            Some(PipelineKind::PlannerReplied) => awaiting_planner = false,
            _ => {}
        }
    }

    // The invariant, enforced rather than asserted: any residue from a clock
    // that moved backwards between two events lands in `orchestrating`, so the
    // parts still add up to the whole.
    let counted = totals.dispatching_ms
        + totals.awaiting_planner_ms
        + totals.awaiting_human_ms
        + totals.orchestrating_ms;
    if let Some(residue) = totals.wall_ms.checked_sub(counted) {
        totals.orchestrating_ms += residue;
    } else {
        totals.orchestrating_ms = totals
            .orchestrating_ms
            .saturating_sub(counted - totals.wall_ms);
    }
    totals
}

/// What the run's records *measured*, as against what its wall clock shows.
///
/// Every field is `None` until a record fills it, and `None` is not zero: a run
/// whose judge chain never reported a turn has no judge time, where one whose
/// judge answered in no time at all has zero. Only the second is a measurement,
/// and [`timing_presence`] is where the wire lets the two be told apart.
#[derive(Debug, Default, Clone, Copy)]
struct Measured {
    /// Turn time, per party, from `turn-completed`'s own `usage.duration`.
    agent_model_ms: Option<u64>,
    judge_model_ms: Option<u64>,
    llmlint_model_ms: Option<u64>,
    /// Time inside a tool call. `turn-activity` reports *what* a turn did and
    /// carries no interval, so nothing measures this yet.
    tool_ms: Option<u64>,
    /// `gate-started` to `gate-verdict`, per node.
    gate_ms: Option<u64>,
    /// The waits on an identity's lock, from `lock-wait`'s own `elapsed`.
    lock_wait_ms: Option<u64>,
    /// Push or change opened, to the host's merge: the stretch a publication
    /// spent in the host's hands rather than the run's.
    publication_wait_ms: Option<u64>,
    /// Dispatch to the first thing the dispatch's own libraries recorded.
    setup_ms: Option<u64>,
    /// How many relayed records each party produced, so a party that recorded
    /// work with no timing on it is still visible as having run.
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

/// Everything the given records measured, walked once.
///
/// The intervals are closed by the record that ends them and dropped when nothing
/// does: an in-flight gate, an unmerged publication and a dispatch that recorded
/// nothing contribute no time rather than time running to the read.
fn measured<'a>(events: impl IntoIterator<Item = &'a Envelope>) -> Measured {
    /// Close an interval one node opened, and drop it if it never opened.
    fn close(slot: &mut Option<u64>, opened: &mut BTreeMap<&str, i128>, node: &str, at: i128) {
        if let Some(started) = opened.remove(node) {
            measure(slot, u64::try_from(at.saturating_sub(started)).unwrap_or(0));
        }
    }
    let mut totals = Measured::default();
    // One map per interval a record can open, keyed by the node that opened it:
    // nodes publish concurrently, so a second node's gate must not close the
    // first one's.
    let mut setup: BTreeMap<&'a str, i128> = BTreeMap::new();
    let mut gate: BTreeMap<&'a str, i128> = BTreeMap::new();
    let mut publication: BTreeMap<&'a str, i128> = BTreeMap::new();
    for event in events {
        let node: &'a str = event.labels.node.as_deref().unwrap_or_default();
        let Some(at) = millis_of(&event.ts) else {
            continue;
        };
        match event.source {
            Source::Agentgraph => {
                if event.kind.0 == graph::TURN_ACTIVITY {
                    continue;
                }
                let party = transport_role(event);
                if party == Party::Llmlint {
                    totals.lint_records += 1;
                }
                // A dispatch has reported: whatever ran between it and the
                // dispatch record was the graph getting itself ready.
                close(&mut totals.setup_ms, &mut setup, node, at);
                if event.kind.0 != graph::TURN_COMPLETED {
                    continue;
                }
                let Some(ms) = seconds_as_ms(
                    event
                        .payload
                        .get(graph::USAGE)
                        .and_then(|usage| usage.get(graph::DURATION)),
                ) else {
                    continue;
                };
                match party {
                    Party::Judge => measure(&mut totals.judge_model_ms, ms),
                    Party::Llmlint => measure(&mut totals.llmlint_model_ms, ms),
                    Party::Agent => measure(&mut totals.agent_model_ms, ms),
                }
            }
            Source::Vcs => {
                close(&mut totals.setup_ms, &mut setup, node, at);
                match event.kind.0.as_str() {
                    vcs::LOCK_WAIT => {
                        if let Some(ms) = seconds_as_ms(event.payload.get("elapsed")) {
                            measure(&mut totals.lock_wait_ms, ms);
                        }
                    }
                    vcs::GATE_STARTED => {
                        gate.insert(node, at);
                    }
                    vcs::GATE_VERDICT => close(&mut totals.gate_ms, &mut gate, node, at),
                    // The first hand-off wins: a change is pushed and then opened,
                    // and the wait on the host runs from the first of the two.
                    vcs::PUSH | vcs::CHANGE_OPENED => {
                        publication.entry(node).or_insert(at);
                    }
                    vcs::CHANGE_MERGED | vcs::MERGE_COMPLETED => {
                        close(&mut totals.publication_wait_ms, &mut publication, node, at);
                    }
                    _ => {}
                }
            }
            Source::Pipeline => {
                if PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched) {
                    setup.insert(node, at);
                }
            }
        }
    }
    totals
}

/// The run's timing, in the eight-way breakdown the wire carries.
///
/// Two readings of one clock, and they answer different questions. The wall clock
/// is attributed by the SDK's own fold — dispatching, the two waits, orchestrating
/// — and `agent_seconds`, `idle_orchestration_ms` and `scheduling_seconds` are
/// those buckets. Everything else is *measured* by a record: the model time each
/// party's `turn-completed` reported, the gate's own interval, the waits `onevcs`
/// timed on a lock, and the stretch a publication spent with the host.
///
/// `unattributed_ms` is what is left of the wall clock once every lane the wire
/// names a fraction for has taken its share, which is where a run's unmeasured
/// time goes — so an unmeasured lane makes the residue grow rather than reading
/// as a measured zero.
fn timing(view: &RunView) -> Value {
    let totals = buckets(view);
    let measured = measured(&view.events);
    timing_document(&totals, &measured)
}

/// The timing document one wall-clock fold and one set of measurements make.
fn timing_document(totals: &Buckets, measured: &Measured) -> Value {
    let idle_ms = totals.awaiting_planner_ms + totals.awaiting_human_ms;
    let wall = totals.wall_ms;
    let fraction = |part: u64| {
        if wall == 0 {
            0.0
        } else {
            #[allow(clippy::cast_precision_loss)]
            // A millisecond count; f64 is exact well past any run's.
            let ratio = part as f64 / wall as f64;
            ratio
        }
    };
    let seconds = |ms: u64| ms / 1_000;
    let measured_ms = |slot: Option<u64>| slot.unwrap_or(0);
    let agent_model_ms = measured_ms(measured.agent_model_ms);
    let judge_model_ms = measured_ms(measured.judge_model_ms);
    let llmlint_model_ms = measured_ms(measured.llmlint_model_ms);
    let tool_ms = measured_ms(measured.tool_ms);
    let lock_wait_ms = measured_ms(measured.lock_wait_ms);
    let setup_ms = measured_ms(measured.setup_ms);
    let attributed = agent_model_ms
        + judge_model_ms
        + llmlint_model_ms
        + tool_ms
        + idle_ms
        + lock_wait_ms
        + setup_ms
        + totals.orchestrating_ms;
    json!({
        "agent_seconds": seconds(totals.dispatching_ms),
        "judge_seconds": seconds(judge_model_ms),
        "llmlint_seconds": seconds(llmlint_model_ms),
        "gate_seconds": seconds(measured_ms(measured.gate_ms)),
        "publication_wait_seconds": seconds(measured_ms(measured.publication_wait_ms)),
        "lock_wait_seconds": seconds(lock_wait_ms),
        "setup_seconds": seconds(setup_ms),
        "scheduling_seconds": seconds(totals.orchestrating_ms),
        "wall_seconds": seconds(wall),
        "agent_model_ms": agent_model_ms,
        "judge_model_ms": judge_model_ms,
        "llmlint_model_ms": llmlint_model_ms,
        "tool_ms": tool_ms,
        "idle_orchestration_ms": idle_ms,
        "unattributed_ms": wall.saturating_sub(attributed),
        "wall_ms": wall,
        "fractions": {
            "agent_model": fraction(agent_model_ms),
            "judge_model": fraction(judge_model_ms),
            "llmlint_model": fraction(llmlint_model_ms),
            "tool": fraction(tool_ms),
            "idle_orchestration": fraction(idle_ms),
            "lock_wait": fraction(lock_wait_ms),
            "setup": fraction(setup_ms),
            "scheduling": fraction(totals.orchestrating_ms),
        },
    })
}

/// What one party spent, from the `turn-completed` records it produced.
///
/// Each field is its own `Option`: a harness that reports tokens and no cost
/// leaves the cost unknown rather than free, and the wire's own `null` is what
/// says so.
#[derive(Debug, Default, Clone, Copy)]
struct Spend {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    cost_usd: Option<f64>,
}

impl Spend {
    /// Whether any record filled any field of this party.
    fn recorded(self) -> bool {
        self.input_tokens.is_some()
            || self.output_tokens.is_some()
            || self.cache_read_tokens.is_some()
            || self.cache_write_tokens.is_some()
            || self.cost_usd.is_some()
    }

    /// The two parties added field by field, each field still `None` until one
    /// of them measured it.
    fn plus(self, other: Self) -> Self {
        let add = |left: Option<u64>, right: Option<u64>| match (left, right) {
            (None, None) => None,
            (left, right) => Some(left.unwrap_or(0) + right.unwrap_or(0)),
        };
        Self {
            input_tokens: add(self.input_tokens, other.input_tokens),
            output_tokens: add(self.output_tokens, other.output_tokens),
            cache_read_tokens: add(self.cache_read_tokens, other.cache_read_tokens),
            cache_write_tokens: add(self.cache_write_tokens, other.cache_write_tokens),
            cost_usd: match (self.cost_usd, other.cost_usd) {
                (None, None) => None,
                (left, right) => Some(left.unwrap_or(0.0) + right.unwrap_or(0.0)),
            },
        }
    }

    /// Fold one `turn-completed`'s `usage` into this party.
    ///
    /// The keys are `oneagentgraph`'s own — `tokens_in`, `tokens_out`,
    /// `cache_read`, `cache_write`, `cost` — renamed onto the wire's rather than
    /// recomputed, so a field that library did not record stays unknown here.
    fn record(&mut self, usage: &Value) {
        let count = |key: &str| usage.get(key).and_then(Value::as_u64);
        let add = |slot: &mut Option<u64>, value: Option<u64>| {
            if let Some(value) = value {
                *slot = Some(slot.unwrap_or(0) + value);
            }
        };
        add(&mut self.input_tokens, count(graph::TOKENS_IN));
        add(&mut self.output_tokens, count(graph::TOKENS_OUT));
        add(&mut self.cache_read_tokens, count(graph::CACHE_READ));
        add(&mut self.cache_write_tokens, count(graph::CACHE_WRITE));
        if let Some(cost) = usage
            .get(graph::COST)
            .and_then(Value::as_f64)
            .filter(|cost| cost.is_finite() && *cost >= 0.0)
        {
            self.cost_usd = Some(self.cost_usd.unwrap_or(0.0) + cost);
        }
    }

    /// This party as the wire carries it: every field it never measured `null`.
    fn document(self) -> Value {
        json!({
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "cost_usd": self.cost_usd,
        })
    }
}

/// What each party of a set of records consumed, and the three of them together.
///
/// Present whether or not anything was recorded: the shape is required, and a
/// missing party would read as "no cost" rather than "unknown" — which is why
/// every field of a party nothing reported stays `null`.
fn usage<'a>(events: impl IntoIterator<Item = &'a Envelope>) -> (Value, bool) {
    let (mut agent, mut judge, mut llmlint) =
        (Spend::default(), Spend::default(), Spend::default());
    for event in events {
        if event.source != Source::Agentgraph || event.kind.0 != graph::TURN_COMPLETED {
            continue;
        }
        let Some(recorded) = event
            .payload
            .get(graph::USAGE)
            .filter(|usage| usage.is_object())
        else {
            continue;
        };
        match transport_role(event) {
            Party::Judge => judge.record(recorded),
            Party::Llmlint => llmlint.record(recorded),
            Party::Agent => agent.record(recorded),
        }
    }
    let total = agent.plus(judge).plus(llmlint);
    (
        json!({
            "agent": agent.document(),
            "judge": judge.document(),
            "llmlint": llmlint.document(),
            "total": total.document(),
        }),
        total.recorded(),
    )
}

/// Which measured timings the records actually carried.
///
/// The wire's own answer to a number that is zero because nothing measured it:
/// a client reading `false` here knows the zero beside it is an absence.
fn timing_presence(measured: &Measured) -> Value {
    json!({
        "agent_model_ms": measured.agent_model_ms.is_some(),
        "judge_model_ms": measured.judge_model_ms.is_some(),
        "llmlint_model_ms": measured.llmlint_model_ms.is_some(),
        "tool_ms": measured.tool_ms.is_some(),
    })
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
fn is_turn_record(event: &Envelope) -> bool {
    event.source == Source::Agentgraph && event.kind.0 != graph::TURN_ACTIVITY
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
    let mine = events_of(view, node);
    let measurements = measured(mine.iter().copied());
    let (spent, recorded_usage) = usage(mine.iter().copied());
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
    // Absent rather than four null parties: the field is optional here, so a node
    // that reported nothing says nothing instead of reporting an unknown cost.
    if recorded_usage {
        row.insert("usage".into(), spent);
    }
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
fn run_telemetry(view: &RunView) -> Value {
    let statuses = recorded_statuses(view);
    let nodes: Vec<Value> = statuses
        .iter()
        .map(|(node, recorded)| node_telemetry(view, node, recorded))
        .collect();
    let totals = buckets(view);
    let measurements = measured(&view.events);
    // What the run measured at a node, rather than across its whole clock: the
    // same records, filtered to the ones a node's own work produced.
    let at_nodes = measured(
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
    run.insert("timing".into(), timing_document(&totals, &measurements));
    run.insert("nodes".into(), Value::Array(nodes));
    run.insert("usage".into(), usage(&view.events).0);
    run.insert("timing_quality".into(), json!(timing_quality(view)));
    run.insert("linkage_quality".into(), json!("labelled"));
    run.insert("timing_presence".into(), timing_presence(&measurements));
    run.insert("sources".into(), json!(["events.jsonl", "launch.json"]));
    run.insert(
        "node_work_ms".into(),
        json!({
            "agent_model_ms": at_nodes.agent_model_ms.unwrap_or(0),
            "judge_model_ms": at_nodes.judge_model_ms.unwrap_or(0),
            "llmlint_model_ms": at_nodes.llmlint_model_ms.unwrap_or(0),
            "tool_ms": at_nodes.tool_ms.unwrap_or(0),
            "wall_ms": totals.wall_ms,
        }),
    );
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
    if let Some(done_when) = &node.done_when {
        task.insert("done_when".into(), json!(done_when));
    }
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

/// The plan a round executed, with every committed live edit applied.
fn round_plan(view: &RunView, round: u64) -> Option<Plan> {
    if round == view.state.round {
        let source = view.state.plan.clone()?;
        return Some(view.state.graph.to_plan(&source));
    }
    Plan::load(&view.paths.round_plan(round)).ok()
}

/// One round of the run, as the detail payload carries it.
fn round(view: &RunView, number: u64) -> Option<Value> {
    let plan = round_plan(view, number)?;
    let task_ids: BTreeSet<&str> = plan.tasks.iter().map(|node| node.id.as_str()).collect();
    let result = read_json(&view.paths.round_result(number));
    // Only an *open* round is described by the live fold. Once it closes, its own
    // recorded result is the sole account of it that survives the next round
    // starting — and it holds outcomes the fold never saw, because a status a
    // round records at its end was never journalled as a settlement.
    let current = number == view.state.round && view.state.round_open;

    // The current round's statuses are the live fold; a finished round's are
    // what its own result recorded, which is the only account of it that
    // survives the next round starting.
    let mut statuses: BTreeMap<String, String> = BTreeMap::new();
    if current {
        for (node, status) in view.state.statuses() {
            statuses.insert(node, status_word(status.as_str()).to_owned());
        }
    } else if let Some(nodes) = result.as_ref().and_then(|r| r["nodes"].as_array()) {
        for node in nodes {
            if let (Some(id), Some(status)) = (node["id"].as_str(), node["status"].as_str()) {
                statuses.insert(id.to_owned(), status_word(status).to_owned());
            }
        }
    }
    // A round that closed without writing a result — a driver that died mid-round,
    // a stop — still has the fold behind it, and that is what the run's own
    // telemetry reports. Falling through to it is what keeps the graph a reader
    // opens from describing a different run than the row they opened it from.
    if statuses.is_empty() {
        for (node, status) in view.state.statuses() {
            statuses.insert(node, status_word(status.as_str()).to_owned());
        }
    }
    // Exactly one entry per plan task, so a client never invents a status for a
    // node or renders one for a node the round did not carry.
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
        .filter_map(|node| node_result(view, node, current, result.as_ref()))
        .collect();

    let mut out = Map::new();
    out.insert("run_id".into(), json!(view.paths.run));
    out.insert("round".into(), json!(number));
    out.insert("plan".into(), plan_document(&plan));
    out.insert("node_states".into(), Value::Object(node_states));
    out.insert("node_status".into(), Value::Object(node_status));
    out.insert("node_gated_by".into(), Value::Object(node_gated_by));
    out.insert("node_results".into(), Value::Object(node_results));
    out.insert(
        "attestations".into(),
        json!(view.state.attestations.iter().collect::<Vec<_>>()),
    );
    out.insert("result".into(), round_result(number, result.as_ref()));
    out.insert("last_seq".into(), json!(last_seq(view, number)));
    Some(Value::Object(out))
}

/// The plan document a round carries, in the wire's shape.
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
/// Deliberately an allowlist rather than a passthrough: a round's result is a
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

/// The payload of the settlement the current round recorded for `node`.
///
/// The last one wins: a node that settled more than once in a round is a node
/// that was retried, and the retry is what happened.
fn settlement(view: &RunView, node: &str) -> Option<Map<String, Value>> {
    view.events
        .iter()
        .rev()
        .find(|event| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
                && event.labels.round == Some(view.state.round)
                && event.labels.node.as_deref() == Some(node)
        })
        .map(|event| event.payload.clone())
}

/// One node's recorded result within a round, when the round recorded one.
fn node_result(
    view: &RunView,
    node: &Node,
    current: bool,
    result: Option<&Value>,
) -> Option<(String, Value)> {
    let mut item = Map::new();
    item.insert("kind".into(), json!(kind_word(node)));
    if let Some(recorded) = result
        .and_then(|r| r["nodes"].as_array())
        .and_then(|nodes| nodes.iter().find(|entry| entry["id"] == json!(node.id)))
    {
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
    } else if current {
        let status = view.state.recorded.get(&node.id)?;
        item.insert("status".into(), json!(status_word(status.as_str())));
        item.insert(
            "completed".into(),
            json!(status_word(status.as_str()) == "done"),
        );
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
        return None;
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

/// The round's own recorded result document, or `null` while it is still open.
fn round_result(number: u64, result: Option<&Value>) -> Value {
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
    out.insert("round".into(), json!(number));
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

/// The highest per-stream sequence number the round recorded.
fn last_seq(view: &RunView, number: u64) -> u64 {
    view.events
        .iter()
        .filter(|event| event.labels.round == Some(number))
        .map(|event| event.seq)
        .max()
        .unwrap_or(0)
}

/// The whole of `GET /api/v2/runs/{run}`'s payload.
#[must_use]
pub fn run_detail(view: &RunView, include_conversations: bool) -> Value {
    let rounds: Vec<Value> = (1..=view.state.round.max(1))
        .filter_map(|number| round(view, number))
        .collect();
    let mut payload = Map::new();
    payload.insert("run".into(), run_telemetry(view));
    payload.insert("rounds".into(), Value::Array(rounds));
    payload.insert(
        "conversations".into(),
        Value::Array(if include_conversations {
            conversations(view)
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

/// Every artifact one node's events stored in `round`, oldest first.
fn evidence<'a>(view: &'a RunView, round: u64, node: &str) -> Vec<Evidence<'a>> {
    let mine: Vec<&Envelope> = view
        .events
        .iter()
        .filter(|event| {
            event.labels.round == Some(round) && event.labels.node.as_deref() == Some(node)
        })
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
    let round = view.state.round.max(1);
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
            .filter(|event| event.labels.round == Some(round))
            .filter(|event| !event.artifacts.is_empty() || event.source == Source::Vcs)
            .filter_map(|event| event.labels.node.as_deref()),
    );
    for node in nodes {
        let mine: Vec<&Envelope> = view
            .events
            .iter()
            .filter(|event| event.labels.node.as_deref() == Some(node))
            .collect();
        let records: Vec<Value> = evidence(view, round, node)
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
    let mut order: Vec<String> = Vec::new();
    let mut grouped: BTreeMap<String, Vec<&Envelope>> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph {
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

/// One tool call a turn reported while it was still running.
///
/// `turn-activity` carries the tool's kind and name and a summary of what it was
/// given, bounded by the producing library; that summary is the call's input as
/// far as the journal is concerned, and nothing records what it returned.
fn tool_call(index: usize, event: &Envelope) -> Value {
    json!({
        "index": index,
        "kind": event.payload.get("kind").and_then(Value::as_str).unwrap_or_default(),
        "name": event.payload.get("name").and_then(Value::as_str),
        "input": event.payload.get("detail").and_then(Value::as_str),
        "output": Value::Null,
    })
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
        "inputTokens": count(graph::TOKENS_IN),
        "outputTokens": count(graph::TOKENS_OUT),
        "cacheReadTokens": count(graph::CACHE_READ),
        "cacheWriteTokens": count(graph::CACHE_WRITE),
        "costUsd": usage.get(graph::COST).and_then(Value::as_f64),
    })
}

/// One conversation and its attribution.
fn conversation_document(view: &RunView, session: &str, events: &[&Envelope]) -> Value {
    let first = events.first().copied();
    let last = events.last().copied();
    let started_at = first.map_or_else(now_rfc3339, |event| event.ts.clone());
    let node = first.and_then(|event| event.labels.node.clone());
    // A tool summary is published from inside a turn, so it is carried on the
    // turn it belongs to — the next one relayed — rather than served as a turn of
    // its own. Summaries with no turn behind them yet are the turn in flight, and
    // they join the last turn the session did relay rather than being dropped.
    let mut turns: Vec<Value> = Vec::new();
    let mut tools: Vec<Value> = Vec::new();
    for event in events {
        if event.kind.0 == graph::TURN_ACTIVITY {
            tools.push(tool_call(tools.len(), event));
            continue;
        }
        let index = turns.len();
        turns.push(json!({
            "assistant": event.payload.get("message").and_then(Value::as_str),
            "durationMs": seconds_as_ms(
                event
                    .payload
                    .get(graph::USAGE)
                    .and_then(|usage| usage.get(graph::DURATION)),
            ),
            "failureKind": Value::Null,
            "harness": "oneagentgraph",
            "id": format!("{session}.{index}"),
            "model": event.payload.get("model").and_then(Value::as_str),
            "reasoning": Value::Null,
            "status": event.kind.0,
            "timestamp": event.ts,
            "tools": std::mem::take(&mut tools),
            "unknown": Map::new(),
            "usage": turn_usage(event),
            "user": event.labels.persona.clone().unwrap_or_default(),
        }));
    }
    if !tools.is_empty() {
        if let Some(open) = turns.last_mut() {
            open["tools"] = Value::Array(tools);
        }
    }
    let mut attribution = Map::new();
    attribution.insert("runId".into(), json!(view.paths.run));
    if let Some(round) = first.and_then(|event| event.labels.round) {
        attribution.insert("round".into(), json!(round));
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
    let recorded = view.events.iter().find_map(|event| {
        event
            .artifacts
            .iter()
            .find(|artifact| artifact.id.0 == id.as_str())
    })?;
    let path = view.paths.dir.join("artifacts").join(id.as_str());
    let bytes = fs::read(&path).ok()?;
    let truncated = bytes.len() > ARTIFACT_TAIL_BYTES;
    let tail = &bytes[bytes.len().saturating_sub(ARTIFACT_TAIL_BYTES)..];
    Some(json!({
        "id": id.as_str(),
        "kind": reference_kind(&recorded.kind),
        "content": String::from_utf8_lossy(tail),
        "truncated": truncated,
    }))
}

/// The wire's closed reference vocabulary, from the producing library's own word
/// for the artifact. Anything unrecognized is a log, which is what the producing
/// libraries store.
fn reference_kind(kind: &str) -> &'static str {
    match kind {
        "conversation" => "conversation",
        "worker_report" | "report" => "worker_report",
        "oneharness_session" | "session" => "oneharness_session",
        "pr" => "pr",
        _ => "gate_log",
    }
}

/// The scope a timeline request asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope<'a> {
    /// Every round of the run and the nodes under them.
    Run,
    /// One node's own work.
    Node(&'a NodeId),
}

/// The whole of `GET /api/v2/runs/{run}/timeline`'s payload.
#[must_use]
pub fn timeline(view: &RunView, scope: &Scope<'_>) -> Value {
    let turns = turn_ids(view);
    let spans = match scope {
        Scope::Run => run_spans(view, &turns),
        Scope::Node(node) => node_spans(view, node.as_str(), &turns),
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
    if let Some(round) = event.labels.round {
        item.insert("round".into(), json!(round));
    }
    if let Some(status) = event.payload.get("status").and_then(Value::as_str) {
        item.insert("status".into(), json!(status));
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
            json!({ "kind": reference_kind(&artifact.kind), "value": artifact.id.0 }),
        );
    }
    Value::Object(item)
}

/// The rounds of the run, each with the nodes it carried beneath it.
fn run_spans(view: &RunView, turns: &[Option<Turn>]) -> Vec<Value> {
    let mut spans: Vec<Value> = Vec::new();
    for number in 1..=view.state.round.max(1) {
        let events: Vec<(usize, &Envelope)> = view
            .events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.labels.round == Some(number))
            .collect();
        let Some((_, first)) = events.first() else {
            continue;
        };
        let round_id = format!("round-{number:02}");
        let closed = events.iter().any(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::RoundFinished)
        });
        let ended = if closed {
            events.last().map_or(Value::Null, |(_, e)| json!(e.ts))
        } else {
            Value::Null
        };
        spans.push(json!({
            "id": round_id,
            "kind": "round",
            "label": format!("round {number}"),
            "started_at": first.ts,
            "ended_at": ended,
            "round": number,
            "phase": if closed { "reviewing-results" } else { "driving-round" },
            // What the round itself recorded: the relayed turns belong to the
            // sessions below, and carrying them here too would draw every one
            // of them on the run's row twice.
            "events": events
                .iter()
                .filter(|(_, event)| {
                    event.labels.node.is_none() && event.source != Source::Agentgraph
                })
                .map(|(index, event)| timeline_event(*index, event, turns))
                .collect::<Vec<_>>(),
        }));
        // The sessions the round relayed at no node: the run's own driving
        // conversations, which belong to the run rather than to any of its work.
        // Left open until the round closes, because a session that has stopped
        // talking has not necessarily stopped.
        let unattached: Vec<(usize, &Envelope)> = events
            .iter()
            .filter(|(_, event)| event.labels.node.is_none())
            .copied()
            .collect();
        for (session, relayed) in relayed_sessions(&unattached) {
            let mut span = Map::new();
            span.insert("id".into(), json!(format!("run.{number:02}.{session}")));
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
            span.insert("parent_id".into(), json!(round_id));
            span.insert("round".into(), json!(number));
            // Running for as long as the round it is driving is: nothing closes a
            // run-level session of its own, so the round's own end is the only
            // thing that can speak for it, and "unknown" would be this crate
            // declining to say what the round already said.
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
            span.insert(
                "events".into(),
                json!(relayed
                    .iter()
                    .map(|(index, event)| timeline_event(*index, event, turns))
                    .collect::<Vec<_>>()),
            );
            spans.push(Value::Object(span));
        }

        let mut nodes: Vec<&str> = events
            .iter()
            .filter_map(|(_, event)| event.labels.node.as_deref())
            .collect();
        nodes.dedup();
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for node in nodes {
            if !seen.insert(node) {
                continue;
            }
            spans.push(node_span(view, number, node, Some(&round_id), turns));
            // What that node did, as categories rather than as records: the graph
            // draws one lane per category and opens the node for the rest.
            let node_id = format!("node.{number:02}.{node}");
            let mine: Vec<(usize, &Envelope)> = events
                .iter()
                .filter(|(_, event)| event.labels.node.as_deref() == Some(node))
                .copied()
                .collect();
            let settled = mine.iter().find(|(_, event)| {
                event.source == Source::Pipeline
                    && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
            });
            spans.extend(waiting_span(view, settled, &node_id, node, number));
            spans.extend(role_rollups(&mine, &node_id, node, number));
            spans.extend(kept_spans(view, &mine, &node_id, node, number));
        }
    }
    spans
}

/// One node's span within a round.
fn node_span(
    view: &RunView,
    round: u64,
    node: &str,
    parent: Option<&str>,
    turns: &[Option<Turn>],
) -> Value {
    let events: Vec<(usize, &Envelope)> = view
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.labels.round == Some(round) && event.labels.node.as_deref() == Some(node)
        })
        .collect();
    let started = events
        .first()
        .map_or_else(now_rfc3339, |(_, event)| event.ts.clone());
    let settled = events.iter().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
    });
    let mut span = Map::new();
    span.insert("id".into(), json!(format!("node.{round:02}.{node}")));
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
    span.insert("round".into(), json!(round));
    if let Some(status) = settled
        .and_then(|(_, event)| event.payload.get("status"))
        .and_then(Value::as_str)
    {
        span.insert("status".into(), json!(status_word(status)));
    }
    span.insert(
        "events".into(),
        json!(events
            .iter()
            .map(|(index, event)| timeline_event(*index, event, turns))
            .collect::<Vec<_>>()),
    );
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
/// is recorded rather than derived. A node whose round opened no session
/// contributes none, and one that opened a session nothing closed is served
/// open-ended, which is what an in-flight publication is.
fn publication_span(
    events: &[(usize, &Envelope)],
    parent: &str,
    node: &str,
    round: u64,
) -> Option<Value> {
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
    span.insert("id".into(), json!(format!("publication.{round:02}.{node}")));
    span.insert("kind".into(), json!("publication"));
    span.insert("label".into(), json!(branch));
    span.insert("started_at".into(), json!(opened.ts));
    span.insert(
        "ended_at".into(),
        closed.map_or(Value::Null, |event| json!(event.ts)),
    );
    span.insert("parent_id".into(), json!(parent));
    span.insert("node_id".into(), json!(node));
    span.insert("round".into(), json!(round));
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
fn lock_wait_rollup(
    events: &[(usize, &Envelope)],
    parent: &str,
    node: &str,
    round: u64,
) -> Option<Value> {
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
        "id": format!("rollup.{round:02}.{node}.lock-wait"),
        "kind": "rollup",
        // The kind it summarizes, which is how a client reads its lane: a rollup
        // is never named for being one.
        "label": vcs::LOCK_WAIT,
        "started_at": started,
        "ended_at": last.0.ts,
        "parent_id": parent,
        "node_id": node,
        "round": round,
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
    round: u64,
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
        "id": format!("human-wait.{round:02}.{node}"),
        "kind": "human-wait",
        "label": format!("{node} awaiting a person"),
        "started_at": wait_start.ts,
        "ended_at": attested.map_or(Value::Null, |event| json!(event.ts)),
        "parent_id": parent,
        "node_id": node,
        "round": round,
        "events": Vec::<Value>::new(),
    }))
}

/// What a node kept: one span per artifact it stored, and the branch it published.
fn kept_spans(
    view: &RunView,
    events: &[(usize, &Envelope)],
    parent: &str,
    node: &str,
    round: u64,
) -> Vec<Value> {
    let mut kept: Vec<Value> = evidence(view, round, node)
        .into_iter()
        .map(|record| {
            json!({
                "id": format!("verification.{round:02}.{node}.{}", record.artifact),
                "kind": "verification",
                "label": record.artifact,
                "started_at": record.since,
                "ended_at": record.at,
                "parent_id": parent,
                "node_id": node,
                "round": round,
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
    kept.extend(publication_span(events, parent, node, round));
    kept.extend(lock_wait_rollup(events, parent, node, round));
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
fn role_rollups(events: &[(usize, &Envelope)], parent: &str, node: &str, round: u64) -> Vec<Value> {
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
                "id": format!("rollup.{round:02}.{node}.{}.{role}", transport.as_str()),
                "kind": "rollup",
                "label": "dispatch",
                "started_at": start.ts,
                "ended_at": settled.map_or(Value::Null, |(_, event)| json!(event.ts)),
                "parent_id": parent,
                "node_id": node,
                "round": round,
                "count": count,
                "agent_role": role,
                "transport_role": transport.as_str(),
                "events": Vec::<Value>::new(),
            })
        })
        .collect()
}

/// One node's own work: the node span, then a dispatch span per attempt.
fn node_spans(view: &RunView, node: &str, turns: &[Option<Turn>]) -> Vec<Value> {
    let mut spans: Vec<Value> = Vec::new();
    for number in 1..=view.state.round.max(1) {
        let events: Vec<(usize, &Envelope)> = view
            .events
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                event.labels.round == Some(number) && event.labels.node.as_deref() == Some(node)
            })
            .collect();
        if events.is_empty() {
            continue;
        }
        let node_id = format!("node.{number:02}.{node}");
        spans.push(node_span(view, number, node, None, turns));
        let settled = events.iter().find(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
        });

        spans.extend(waiting_span(view, settled, &node_id, node, number));

        // The evidence the node kept and the branch it published: both sit inside
        // the dispatch they were recorded during, so both are appended after it.
        // The plot paints in the order it is given, and a segment underneath one
        // that covers it is a segment no pointer can reach.
        let mut inside = kept_spans(view, &events, &node_id, node, number);

        let dispatched = events.iter().find(|(_, event)| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched)
        });
        let Some((_, start)) = dispatched else {
            spans.append(&mut inside);
            continue;
        };
        let key = dispatch_key(&view.paths.run, number, node);
        // A dispatch the node has not settled is running, which is a state the
        // run is asserting rather than one this crate is guessing: the node was
        // dispatched and nothing has closed it. Leaving it absent would leave a
        // reader with "unknown" for the one case they can see is in flight.
        let status = settled
            .and_then(|(_, event)| event.payload.get("status"))
            .and_then(Value::as_str)
            .map_or("running", status_word);

        // One span per session the dispatch ran under, all carrying the same
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
            span.insert(
                "id".into(),
                json!(format!("dispatch.{number:02}.{session}")),
            );
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
                settled.map_or(Value::Null, |(_, event)| json!(event.ts)),
            );
            span.insert("parent_id".into(), json!(node_id));
            span.insert("node_id".into(), json!(node));
            span.insert("round".into(), json!(number));
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
            span.insert(
                "events".into(),
                json!(relayed
                    .iter()
                    .map(|(index, event)| timeline_event(*index, event, turns))
                    .collect::<Vec<_>>()),
            );
            spans.push(Value::Object(span));
        }
        spans.append(&mut inside);
    }
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
/// crate must not offer.
#[must_use]
pub fn live_activity(view: &RunView) -> Vec<Value> {
    let mut order: Vec<(String, u64)> = Vec::new();
    let mut latest: BTreeMap<(String, u64), (i128, Value)> = BTreeMap::new();
    for event in &view.events {
        if event.source != Source::Agentgraph || event.kind.0 != graph::TURN_ACTIVITY {
            continue;
        }
        let (Some(node), Some(round), Some(at)) = (
            event
                .labels
                .node
                .as_deref()
                .and_then(|node| NodeId::try_from(node).ok()),
            event.labels.round,
            millis_of(&event.ts),
        ) else {
            continue;
        };
        let node = node.as_str().to_owned();
        let key = (node.clone(), round);
        let counted = latest
            .get(&key)
            .and_then(|(_, seen)| seen["events"].as_u64())
            .unwrap_or(0);
        #[allow(clippy::cast_precision_loss)]
        // Epoch milliseconds, which f64 carries exactly past any date a run
        // records; the client reads this as its own clock.
        let stamp = at as f64;
        if latest.insert(
            key.clone(),
            (
                at,
                json!({
                    "round": round.to_string(),
                    "node": node,
                    "at": stamp,
                    "kind": event.payload.get("kind").and_then(Value::as_str).unwrap_or_default(),
                    "name": event.payload.get("name").and_then(Value::as_str).unwrap_or_default(),
                    "detail": event.payload.get("detail").and_then(Value::as_str).unwrap_or_default(),
                    "events": counted + 1,
                }),
            ),
        )
        .is_none()
        {
            order.push(key);
        }
    }
    let mut activity: Vec<(i128, Value)> = order
        .into_iter()
        .filter_map(|key| latest.remove(&key))
        .collect();
    activity.sort_by_key(|(at, _)| *at);
    activity.into_iter().map(|(_, entry)| entry).collect()
}

/// A change token for one run: what a poll compares to decide it moved.
#[must_use]
pub fn signature(view: &RunView) -> (u64, usize, u64) {
    (
        view.state.round,
        view.events.len(),
        view.state.last_write_at.unwrap_or(0),
    )
}

/// A change token for one run's transcripts, so a watcher can tell an edited
/// turn from a new one.
#[must_use]
pub fn conversation_signature(view: &RunView) -> String {
    let mut hasher = Sha256::new();
    for document in conversations(view) {
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
