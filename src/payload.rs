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

/// Which of those roles each member a run declares is read as.
///
/// The observing member is `monitor` and is served in the `orchestrator` lane
/// deliberately: it is the same lane a reader watches the run's own driving from,
/// and `agentRoleSchema` is a closed vocabulary a client switches on
/// exhaustively — so a word that means a lane the client already has is mapped
/// onto it rather than added beside it.
// llmlint: ignore[invalid_states_unrepresentable] the same reason as the array above: this maps one wire vocabulary onto another, and both halves are strings this crate reads off a record and writes back onto the wire.
const ROLE_MEMBERS: [(&str, &str); 5] = [
    ("worker", "worker"),
    ("judge", "judge"),
    ("pr-author", "pr-author"),
    ("check-in", "check-in"),
    ("monitor", "orchestrator"),
];

/// The kinds `onevcs` relays, as the wire strings that library writes.
///
/// The vocabulary is the sibling's rather than this crate's, so it is matched as
/// the strings the sibling emits rather than folded into an enum here — the same
/// reason the SDK keeps a relayed `EventKind` a wire string. What each payload
/// carries is `onevcs`'s own declaration, quoted where it is read.
///
/// That library's `event` module is private, but it re-exports `EventKind` from
/// its crate root, so the kinds below *are* reachable as a declaration and
/// `tests/contract.rs` holds this copy of them to it — a rename there fails
/// there, as it does for the `oneagentgraph` vocabulary beside this one. The
/// three payload *values* at the end of the module are the exception, and each
/// says so where it is declared.
pub mod vcs {
    /// `{token, identity, branch, base, worktree, clone, …}`.
    pub const SESSION_OPENED: &str = "session-opened";
    /// `{identity, elapsed, queue_position}` — one wait on one identity's lock.
    pub const LOCK_WAIT: &str = "lock-wait";
    /// `{verdict, command, output, preserved_log}`, with the log as an artifact.
    ///
    /// The one kind in this module with no variant behind it. `onevcs` **deleted**
    /// `gate-verdict` in its 0.11.0 rather than retiring it — its own `EventKind`
    /// documents both the deletion and what it cost — so there is no declaration
    /// left for `tests/contract.rs` to reconcile this copy against. It is still
    /// read here because the runs that recorded one are still runs an operator
    /// opens, and dropping the reading would take a verification span off every
    /// one of them. `tests/support/fixture_run.rs` writes the record as that
    /// library emitted it, which is the gate available.
    // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the producing library deleted this variant in 0.11.0 without retiring it, so — unlike every other kind in this module — no reachable declaration of it exists to be reconciled against, in this release or any later one. The wire is the only source left, and the fixture and goldens are the gate.
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
    /// The worktree a dispatch was given has been taken away again, which is the
    /// last thing that can be said about what it was doing on it.
    pub const SESSION_CLOSED: &str = "session-closed";
    /// `{identity, …}` — the clone this library keeps was brought up to date,
    /// which it does both to cut a worktree and to publish from one.
    pub const FETCH: &str = "fetch";

    /// `{identity, target, form, outcome, version, elapsed_ms}` — one look at one
    /// **automated** release target, and what the registry answered. A human-step
    /// target is never probed: nothing but a person can say it is done.
    pub const RELEASE_PROBED: &str = "release-probed";
    /// `{identity, target, version, landing_commit, actor, superseded}` — a person
    /// said the human step they owed had been performed, naming the commit the
    /// release carried. `superseded` is a later acknowledgement having replaced it.
    pub const RELEASE_ACKNOWLEDGED: &str = "release-acknowledged";
    /// `{identity, target, style, version, landing_commit}` — a release is out.
    ///
    /// The one record this crate joins a node to, and it is joined by
    /// `landing_commit` rather than by a node label: a release is observed long
    /// after the dispatch that produced the work ended and outside any session, so
    /// nothing stamps this envelope with a node at all. `release_of`, in this
    /// module's parent, is that join.
    pub const RELEASE_OBSERVED: &str = "release-observed";

    /// The relayed kinds that do not, on their own, say a publication began.
    ///
    /// A node that relayed nothing but these published nothing. Why the list is
    /// negative, and why a [`FETCH`] is on it, is in `src/AGENTS.md`.
    pub const SILENT_ON_PUBLICATION: [&str; 3] = [SESSION_OPENED, FETCH, SESSION_CLOSED];

    /// The command `onevcs` records for the gate that is git's own hook.
    ///
    /// A `pre-push` gate's verdict arrives as push output and nowhere else, so
    /// that library writes it under this exact command rather than a path; it is
    /// the only record of the hook having run at all.
    // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] unlike the kinds above, this is a payload *value* that library builds inline in a private `publish` module and re-exports nothing of, so there is no declaration a consumer can reach and nothing to reconcile a copy against. `tests/support/fixture_run.rs` writes the record as that library emits it and the goldens pin what this crate makes of it, which is the whole of the gate available.
    pub const PRE_PUSH_COMMAND: &str = "the repository's pre-push hook";

    /// The verdict word a gate that passed is recorded with.
    // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the same reason as the command above: `onevcs` renders this word from a private `gate::Ruling` it re-exports nothing of, so the wire is the only declaration reachable and the goldens are the gate available.
    pub const GATE_PASSED: &str = "pass";

    /// The conclusions `onevcs` reads as not blocking a merge, in its own words.
    // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the same reason again: this is a match arm in that library's private `host` module rather than a type, so nothing declares it to a consumer and the goldens are the gate available.
    pub const GREEN_CONCLUSIONS: [&str; 3] = ["success", "skipped", "neutral"];
}

/// The kinds `oneagentgraph` relays, and the keys the usage it relays is written
/// with, on the same terms as the `onevcs` vocabulary beside it: matched as the
/// wire strings that library writes, because the vocabulary is the sibling's.
///
/// Unlike `onevcs`, that library declares this vocabulary in a public module, so
/// `tests/contract.rs` holds the names here to the sibling's own types rather
/// than to a second reading of the wire. One of them it does not, and it says so
/// where it is declared.
pub mod graph {
    /// `{kind, name, detail, truncated, output, output_truncated, tool_call_id,
    /// index}` — one bounded tool summary, or the observation that answered one,
    /// published from inside a turn rather than after it.
    pub const TURN_ACTIVITY: &str = "turn-activity";
    /// A turn finished, carrying the [`USAGE`] it consumed and the interval it
    /// ran over.
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
    /// this payload inline, so `tests/contract.rs` holds the copy to the public
    /// `render::line` that reads it instead. Why a turn is joined by this number
    /// rather than by position is in `src/AGENTS.md`.
    pub const TURN: &str = "turn";
    /// `{member, delivered, input_bytes, reason}` — an operator asked a member's
    /// in-flight turn to do something else. Published for every interrupt,
    /// delivered or not, which is what makes "the lever was pulled and nothing
    /// happened" a thing a reader of the run can see.
    pub const TURN_INTERRUPTED: &str = "turn-interrupted";
    /// A member began: the first record of the session it is about to run, and
    /// the one moment a session has that its own messages cannot supply.
    pub const MEMBER_STARTED: &str = "member-started";
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

    /// `{turn, role, text, truncated}` — one party's own words for one turn,
    /// published as the turn happens rather than kept until it settles.
    ///
    /// The names from here to the end of this module are the ones the producer
    /// added when it corrected what a live turn publishes, and they are the whole
    /// of what a dispatch still in flight can be read from. Every one of them is
    /// a field of `oneagentgraph::event::TurnStarted`, `TurnMessage`,
    /// `TurnCompleted` or `TurnActivity`, so `tests/contract.rs` holds each to
    /// the payload type that writes it — a key renamed there fails on that gate
    /// rather than in a live transcript that quietly stops carrying a reply.
    pub const TURN_MESSAGE: &str = "turn-message";
    /// Which party a turn record is about: `assistant`, `user` or `system`.
    ///
    /// Read as half of the key a turn is joined by, never as a word this crate
    /// switches on: the two sides of a conversation number their turns
    /// independently, so a number alone reads one side's turn as the other's.
    pub const ROLE: &str = "role";
    /// The party whose words a transcript serves as a turn's reply.
    ///
    /// A `role` is a `String` on the wire; `oneagentgraph::event::Party` is the
    /// closed set the producer mints one from, and this word is that type's own
    /// spelling of it.
    pub const ASSISTANT_ROLE: &str = "assistant";
    /// A party's own words on a [`TURN_MESSAGE`].
    pub const TEXT: &str = "text";
    /// Whether [`TEXT`] was cut to the producer's bound.
    pub const TRUNCATED: &str = "truncated";
    /// The message a [`TURN_STARTED`] says its turn answers.
    pub const INSTRUCTION: &str = "instruction";
    /// Whether [`INSTRUCTION`] was cut to the producer's bound.
    pub const INSTRUCTION_TRUNCATED: &str = "instruction_truncated";
    /// When a turn began, on the record that opened it and again on the one that
    /// closed it.
    pub const STARTED_AT: &str = "started_at";
    /// When a turn ended.
    pub const FINISHED_AT: &str = "finished_at";
    /// A tool event's own kind: [`TOOL_RESULT`], or a call.
    pub const KIND: &str = "kind";
    /// The tool a call named; absent on the observation that answers one.
    pub const NAME: &str = "name";
    /// The bounded summary of what a call was given.
    pub const DETAIL: &str = "detail";
    /// The observation kind, which answers a call rather than making one.
    ///
    /// The one name in this module with no field or variant behind it:
    /// `TurnActivity::kind` is a `String`, because a *call's* kind is the
    /// producing harness's own word and is served through verbatim. This is the
    /// one word the producer closes, and it closes it inline.
    // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] `oneagentgraph::event::TurnActivity::kind` is a `String` rather than an enum — deliberately, so a call's kind can be the harness's own word — so this single closed spelling is declared by no type a consumer can reach. `tests/support/fixture_run.rs` writes the record as that library emits it and the goldens pin what this crate makes of it, which is the whole of the gate available.
    pub const TOOL_RESULT: &str = "tool_result";
    /// What a tool returned, on the observation that carries it.
    pub const OUTPUT: &str = "output";
    /// Whether [`OUTPUT`] was cut to the producer's bound.
    pub const OUTPUT_TRUNCATED: &str = "output_truncated";
    /// The harness's own identity for a call, which is what an observation is
    /// joined back to it by where both carry one.
    pub const TOOL_CALL_ID: &str = "tool_call_id";
    /// A tool event's position within its turn, which is what an observation is
    /// joined by where no identity was published.
    pub const INDEX: &str = "index";
}

/// The release kinds `onepipeline` writes about a node's own dependencies, as the
/// wire strings that library writes.
///
/// A sibling module to [`vcs`] rather than a re-export of
/// `onepipeline::event::PipelineKind`, on the terms that module's own kinds are
/// declared under: the vocabulary belongs to the producer and this is the copy
/// each payload's shape is documented beside. They are what a node *waiting on a
/// release* records — the other half of the sequencing the `onevcs` kinds are the
/// first half of, and `tests/contract.rs` holds all three to that library's own
/// `PipelineKind`.
///
/// This crate reads none of these three for a payload it computes; they are here
/// so the six kinds are declared in one place with the payload each carries, and
/// `tests/contract.rs` holds every one of them to the browser's own category
/// corpus too. The timeline serves each record's own fields through
/// `release_facts`.
pub mod pipeline {
    /// `{node, awaiting: [{dep, identity, target, style, action, since,
    /// waited_seconds, last_answer}]}` — a node is held until a dependency's
    /// release is out, one entry per thing it is held on.
    ///
    /// `style` is `automated` or `human-step`, and `action` is carried only on a
    /// human-step entry, because only that one is a thing somebody has to be told
    /// to do. `last_answer` is that library's own word for what the last look
    /// found: `not-released`, `awaiting-human-step`, `not-answered` or
    /// `not-landed`.
    pub const RELEASE_WAIT: &str = "release-wait";
    /// `{node, dep, identity, target, style, version}` — the release a node was
    /// held on is out, and the wait is over.
    pub const RELEASE_ARRIVED: &str = "release-arrived";
    /// `{node, delivery, versions: [{identity, target, version}]}` — the versions
    /// that arrived were written into the node's own context, `live` into the turn
    /// already running or `deferred` onto its next dispatch.
    pub const RELEASE_ADOPTED: &str = "release-adopted";
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
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] `onepipeline` declares `edits::Operation` and `edits::Delivery` in a private module, in 0.18.3 as in every release before it, so there is no type to generate from and nothing to compare a copy against. Making that module public is the proposal recorded in src/AGENTS.md; until it lands, the gate available is the public `channel::Command` beside it, which `tests/contract.rs` asserts, plus the goldens written from a real reconciler's output.
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
    summary.insert("timing".into(), timing(telemetry, &measured(&view.events)));
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
/// document it aggregates — and this is what no fold of that clock can produce.
/// Every field is `None` until a record fills it, and `None` is not zero: a lane
/// nothing measured is a different fact from one measured at zero, and only the
/// second is a measurement.
#[derive(Debug, Default, Clone, Copy)]
struct Measured {
    /// Time inside a tool call. `turn-activity` reports *what* a turn did and
    /// carries no interval, so nothing measures this yet.
    tool_ms: Option<u64>,
    /// How many relayed records the lint party produced, so a party that
    /// recorded work with no timing on it is still visible as having run.
    lint_records: u64,
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

/// Everything the given records measured about their own turns, walked once.
fn measured<'a>(events: impl IntoIterator<Item = &'a Envelope>) -> Measured {
    let mut totals = Measured::default();
    for event in events {
        if event.source != Source::Agentgraph || event.kind.0 == graph::TURN_ACTIVITY {
            continue;
        }
        if transport_role(event) == Party::Llmlint {
            totals.lint_records += 1;
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
/// The rest of the lanes the wire carries are ones no producer in this stack
/// measures — the per-party model clocks [`model_lanes`] names, the time inside
/// a tool call, the run's idle orchestration — and every one of them is served
/// `null`, here and in the fractions, rather than as a zero. A zero is a
/// measurement, and reading one for an absence is how a run comes to look
/// cheaper than it was.
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
    timing.extend(model_lanes("_ms", &Value::Null));
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
    fractions.extend(model_lanes("", &Value::Null));
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

/// The wire's three per-party model-time lanes, each served as unmeasured.
///
/// Nothing in this stack measures how long a party spent inside a model, and
/// `src/AGENTS.md` lists that gap with the upstream change that would fill it —
/// including why a turn's own elapsed time may not be folded into these.
///
/// One function because the same three lanes are named four times — the timings,
/// their fractions, the presence flags beside them, and the node-level rollup —
/// and four copies of that naming are four chances for two of them to disagree.
/// `suffix` is what the wire appends to the lane: `_ms` for a measurement,
/// nothing for a fraction of the clock.
fn model_lanes(suffix: &str, unmeasured: &Value) -> Vec<(String, Value)> {
    ["agent", "judge", "llmlint"]
        .into_iter()
        .map(|party| (format!("{party}_model{suffix}"), unmeasured.clone()))
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
    let mut presence: Map<String, Value> = model_lanes("_ms", &json!(false)).into_iter().collect();
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
            if let Some(role) = first.and_then(event_agent_role) {
                link.insert("agent_role".into(), json!(role));
            }
            if let Some(event) = first {
                link.insert("started_at".into(), json!(event.ts));
            }
            Value::Object(link)
        })
        .collect()
}

/// The semantic role one record's session ran under.
fn event_agent_role(event: &Envelope) -> Option<&'static str> {
    agent_role(
        event
            .labels
            .extra
            .get(graph::MEMBER)
            .and_then(Value::as_str),
        event.labels.persona.as_deref(),
    )
}

/// The semantic role a run recorded for a session, from the member it named it
/// and — only where it named none — from the persona it ran under.
///
/// The member is the reading that survives a host naming its personas: a persona
/// is a *style* a host invented, so `engineer` and `docs-writer` are the ordinary
/// worker under two names, and reading a role off one drops every session a host
/// did not happen to name after a role. The member is the run's own word for what
/// the session *was*.
///
/// So a stamped member decides the reading whether or not this crate has a word
/// for it, and the persona beside it is never consulted: a record naming a member
/// outside [`ROLE_MEMBERS`] has said what the session was and said something this
/// vocabulary cannot carry, while a persona that happens to read like a role — the
/// literal word `pr-author` — would answer with a *style* over the run's own word
/// for it. The persona is the reading for a record that stamped no member at all,
/// which is what a `node-dispatched` is.
fn agent_role(member: Option<&str>, persona: Option<&str>) -> Option<&'static str> {
    match member {
        Some(member) => ROLE_MEMBERS
            .into_iter()
            .find_map(|(named, role)| (named == member).then_some(role)),
        None => {
            let persona = persona?;
            AGENT_ROLES.into_iter().find(|role| *role == persona)
        }
    }
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

/// How many turns a node — or the whole run — has had.
///
/// Counted off the same [`Transcripts`] fold [`conversations`] serves and
/// [`turn_ids`] numbers, so the count beside a node and the transcript a reader
/// opens from it cannot disagree. A turn the producer both opened and closed is
/// two records and one turn, and counting the records instead doubled the number
/// beside every node whose member had finished a turn — and a turn only the
/// settled member's report holds is a row of that transcript too, so it is
/// counted here rather than leaving a node reading `1 turn` above fifty of them.
///
/// Grouped **per session**, because a turn is numbered within its own session and
/// a member's close must never reach across to another member's open. The
/// supervisor's own invocations are not counted, for the reason they are not
/// served: they are the other half of the agent's turns rather than turns beside
/// them, and counting them read a four-turn dispatch as an eight-turn one.
///
/// A judge conversation adds nothing: it is a conversation of its own, and
/// folding its report-bounded turns in would put the count one dispatch ahead of
/// every transcript a reader opens from the node.
fn turns_of(transcripts: &Transcripts<'_>, node: Option<&str>) -> usize {
    transcripts
        .sessions
        .iter()
        .filter(|session| {
            node.is_none_or(|node| session.node.as_ref().is_some_and(|at| at.as_str() == node))
        })
        .map(|session| session.rows.len())
        .sum()
}

/// The session one relayed record names, or `None` for a record that names none
/// this API could serve a transcript for.
///
/// The producer stamps this label on its `turn-*` kinds and on no other, so it is
/// exactly the set a turn can be read from — and the partition every reading of a
/// turn is grouped by, because two members number their turns independently.
///
/// **Validated here, once, rather than at each reading.** The label is another
/// process's bytes and it is what a client addresses a transcript by, so a value
/// the conversation route would refuse must not reach a listing, a turn id or a
/// count either: a `turns` beside a node that folded in a session nobody can open
/// is exactly the disagreement [`turns_of`] exists to prevent.
fn session_label(event: &Envelope) -> Option<&str> {
    let session = event.labels.extra.get("session").and_then(Value::as_str)?;
    ConversationId::try_from(session).ok()?;
    Some(session)
}

/// The events one node recorded, whichever library produced them.
fn events_of<'a>(view: &'a RunView, node: &str) -> Vec<&'a Envelope> {
    view.events
        .iter()
        .filter(|event| event.labels.node.as_deref() == Some(node))
        .collect()
}

/// One node's telemetry row.
fn node_telemetry(
    view: &RunView,
    node: &str,
    recorded: &Recorded,
    transcripts: &Transcripts<'_>,
) -> Value {
    let measurements = measured(events_of(view, node));
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
    row.insert("turns".into(), json!(turns_of(transcripts, Some(node))));
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
fn run_telemetry(
    view: &RunView,
    telemetry: Option<&RunTelemetry>,
    transcripts: &Transcripts<'_>,
) -> Value {
    let statuses = recorded_statuses(view);
    let nodes: Vec<Value> = statuses
        .iter()
        .map(|(node, recorded)| node_telemetry(view, node, recorded, transcripts))
        .collect();
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
    run.insert("timing".into(), timing(telemetry, &measurements));
    run.insert("nodes".into(), Value::Array(nodes));
    run.insert("usage".into(), usage(telemetry));
    run.insert("timing_quality".into(), json!(timing_quality(view)));
    run.insert("linkage_quality".into(), json!("labelled"));
    run.insert("timing_presence".into(), timing_presence(&measurements));
    run.insert("sources".into(), json!(["events.jsonl", "launch.json"]));
    // The same discipline one level down: a party that reported no turn at a
    // node has no time there, which is not zero of it.
    let mut work: Map<String, Value> = model_lanes("_ms", &Value::Null).into_iter().collect();
    work.insert("tool_ms".into(), json!(at_nodes.tool_ms));
    work.insert(
        "wall_ms".into(),
        json!(telemetry.map(|document| document.wall_ms)),
    );
    run.insert("node_work_ms".into(), Value::Object(work));
    run.insert("turns".into(), json!(turns_of(transcripts, None)));
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
///
/// The file is deserialized here rather than through a loader of the SDK's:
/// `onepipeline` now reads its plans out of the onetaskgraph store and no longer
/// publishes one, but `RunPaths::plan()` still names the JSON document `start`
/// writes and `Plan` is still the published shape of it — so the deserialization
/// is this crate's while the *schema* stays the SDK's, which is the same terms
/// every other record here is read on.
fn plan_of(view: &RunView) -> Option<Plan> {
    if let Some(source) = view.state.plan.as_ref() {
        return Some(view.state.graph.to_plan(source));
    }
    let text = std::fs::read_to_string(view.paths.plan()).ok()?;
    serde_json::from_str(&text).ok()
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
    // The release that carried this node's work, beside the change request that
    // opened it — and absent, never null, for a node the run recorded no release
    // for, exactly as `pr` is absent for a node that opened no change request.
    // Joined through the commit the work landed as, which is the only thing a
    // `release-observed` and a node have in common; see [`release_of`].
    let mine: Vec<&Envelope> = view
        .events
        .iter()
        .filter(|event| event.labels.node.as_deref() == Some(node.id.as_str()))
        .collect();
    if let Some(release) = landing_commit(&mine).and_then(|commit| release_of(view, commit)) {
        item.insert("release".into(), release);
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
    // One fold of the run's transcripts, read before anything that counts,
    // numbers or lists a turn: the count beside a node and the transcript a
    // reader opens from it are two readings of it, and reading it twice is how
    // they come to disagree.
    let transcripts = Transcripts::of(view);
    // Everything below the transcripts is read from the whole journal, whatever
    // the filter said: the graph's statuses, the answer about each in-flight
    // node's turn, the evidence each node kept and the run's own clock are what
    // the *run* is, and a reader narrowing their attention must be shown the same
    // one. The transcripts are the detail's own event listing, and are the one
    // thing here a filter narrows.
    payload.insert("run".into(), run_telemetry(view, telemetry, &transcripts));
    payload.insert("graph".into(), graph_state(view).unwrap_or(Value::Null));
    payload.insert(
        "conversations".into(),
        Value::Array(if include_conversations {
            conversations_under(view, &transcripts, filter)
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

/// The records that say a node's work reached the default branch.
const MERGED: [&str; 2] = [vcs::CHANGE_MERGED, vcs::MERGE_COMPLETED];

/// The commit one node's work landed as: the merge the host completed, or — for
/// work that was preserved rather than published — the commit it was preserved
/// on.
///
/// One derivation with two readers. The publication serves it as the node's own
/// `commit`, and [`release_of`] joins the node to a release by it, so a node
/// whose publication names one commit can never be shown a release that carried
/// another.
fn landing_commit<'a>(events: &[&'a Envelope]) -> Option<&'a str> {
    last_recorded(events, &MERGED, "sha")
        .or_else(|| last_recorded(events, &[vcs::COMMIT_PRESERVED], "sha"))
}

/// The release that carried one node's landed work, or `None` for a node the run
/// recorded no release for.
///
/// Joined by the commit rather than by the node, because a node is not something
/// a [`vcs::RELEASE_OBSERVED`] can carry: the release is observed long after the
/// dispatch that produced the work has settled and outside any session of it, so
/// nothing is there to stamp the envelope with one. A label lookup would find
/// nothing on every run, and this key would be silently absent rather than wrong,
/// which is the worse of the two failures. Where such an envelope does happen to
/// carry a node label it is corroboration and nothing is filtered on it.
///
/// The newest wins: a target released twice for one commit is a version that was
/// yanked and cut again, and the later one is what a reader would go and install.
///
/// Served only when the record named the three things a release *is* — who
/// published it, what was published, and which version — because a release
/// object missing any of them is a row a reader cannot act on and this crate
/// inventing the rest is worse than serving none. `style` is the one optional
/// field: an envelope written before that field existed carries none, and the
/// schema the browser holds this to says so.
fn release_of(view: &RunView, commit: &str) -> Option<Value> {
    let observed = view.events.iter().rev().find(|event| {
        event.source == Source::Vcs
            && event.kind.0 == vcs::RELEASE_OBSERVED
            && event.payload.get("landing_commit").and_then(Value::as_str) == Some(commit)
    })?;
    let field = |key: &str| non_empty(observed.payload.get(key).and_then(Value::as_str));
    let mut release = Map::new();
    release.insert("identity".into(), json!(field("identity")?));
    release.insert("target".into(), json!(field("target")?));
    if let Some(style) = field("style") {
        release.insert("style".into(), json!(style));
    }
    release.insert("version".into(), json!(field("version")?));
    Some(Value::Object(release))
}

/// What one node's publication reached, from the records `onevcs` relayed for it.
///
/// `None` when the run recorded neither a branch for the node nor a publication
/// record of any kind: an absent publication is a node that published nothing,
/// where an empty one would read as a publication that reached nowhere.
fn publication_of(view: &RunView, node: &str, events: &[&Envelope]) -> Option<Value> {
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
    // The commit the work landed as, which is also what a release is joined to
    // this node by. Its *url* is the host's own and nothing records one, so none
    // is served.
    if let Some(sha) = landing_commit(events) {
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
/// A conversation is one agent-graph session's relayed envelopes, in order, with
/// what each turn said and spent folded onto the turn it belongs to — out of the
/// settled member's stored report where the run holds one, and out of the
/// session's own records where it does not.
#[must_use]
pub fn conversations(view: &RunView) -> Vec<Value> {
    conversations_under(view, &Transcripts::of(view), &EventFilter::default())
}

/// The transcripts a reader's filter admits, each as the whole session it is.
///
/// A session whose every record the filter excluded is not served at all — an
/// empty transcript would say the session recorded nothing, which is a different
/// fact from "this reading is not about it".
fn conversations_under(
    view: &RunView,
    transcripts: &Transcripts<'_>,
    filter: &EventFilter,
) -> Vec<Value> {
    transcripts
        .sessions
        .iter()
        .flat_map(|session| {
            // The listing the document is narrowed to; what each listed turn
            // *was* is read from the whole, below.
            let events: Vec<&Envelope> = session
                .records
                .iter()
                .copied()
                .filter(|event| filter.allows(event))
                .collect();
            if events.is_empty() {
                return Vec::new();
            }
            let mut served = vec![conversation_document(view, session, &events)];
            served.extend(session.stored.as_ref().and_then(|stored| {
                judge_conversation(
                    view,
                    session.session.as_str(),
                    &events,
                    stored.settlement,
                    &stored.report,
                )
            }));
            served
        })
        .collect()
}

/// Every session of one run, folded once into the rows its transcript serves.
///
/// **One fold, three readings.** The transcript route lists these rows,
/// [`turns_of`] counts them and [`turn_ids`] names the row a plotted record
/// belongs to; folding the same session twice is how the count beside a node, the
/// transcript opened from it and the id the timeline addresses it under come to
/// disagree. It is built once per read of a run, which is also the one place the
/// stored reports are read — a report is a file per settled member, and the
/// listing, the counting and the numbering all need what is in it.
struct Transcripts<'a> {
    sessions: Vec<SessionTranscript<'a>>,
}

/// One session, with everything any reading of its transcript is taken from.
struct SessionTranscript<'a> {
    /// The label the producer stamped, as the id a reader addresses it by —
    /// validated once, here, so no reading below can serve one a route refuses.
    session: ConversationId,
    /// The node it ran at, and `None` where its records name none this API could
    /// serve a timeline for.
    node: Option<NodeId>,
    /// Every record it relayed, whatever a reader's filter said.
    records: Vec<&'a Envelope>,
    /// What its settled member stored, where the run holds a readable report.
    stored: Option<StoredReport<'a>>,
    /// The rows its transcript serves, in the order it serves them.
    rows: Vec<TranscriptTurn<'a>>,
}

/// One settled member's report, with the settlement that stored it and the turns
/// read out of it.
///
/// The three arrive together or not at all — a report is located through its
/// settlement and its turns are read from the report — so they are one value
/// rather than three fields a reading could find half of.
struct StoredReport<'a> {
    /// The settlement that stored it, which is the only instant the report
    /// itself is stamped by.
    settlement: &'a Envelope,
    report: judge::Report,
    /// The turns it recorded, in the producer's own order.
    turns: Vec<ReportedTurn>,
}

impl<'a> Transcripts<'a> {
    /// Fold every session the run relayed, in the order it first relayed them.
    fn of(view: &'a RunView) -> Self {
        let mut order: Vec<&'a str> = Vec::new();
        let mut grouped: BTreeMap<&'a str, Vec<&'a Envelope>> = BTreeMap::new();
        for event in &view.events {
            if event.source != Source::Agentgraph {
                continue;
            }
            let Some(session) = session_label(event) else {
                continue;
            };
            if !grouped.contains_key(session) {
                order.push(session);
            }
            grouped.entry(session).or_default().push(event);
        }
        let sessions = order
            .into_iter()
            .filter_map(|session| {
                // Validated once here rather than at each reading: `session_label`
                // admits only what the conversation route resolves, and this is
                // the value every id, count and reference below is spelled from.
                let session_id = ConversationId::try_from(session).ok()?;
                let records = grouped.remove(session).unwrap_or_default();
                // Read once, used three times over: the report is a source of
                // this transcript's turns, it fills each of them, and it is the
                // whole of the judge conversation beside them.
                let stored = settlement_of(view, session).and_then(|settlement| {
                    let report = read_report(view, settlement)?;
                    let turns = reported_turns(&report);
                    Some(StoredReport {
                        settlement,
                        report,
                        turns,
                    })
                });
                // The report's presence, not its contents, is what decides which
                // reading a session gets.
                let rows = transcript_turns(
                    &records,
                    stored.as_ref().map(|stored| stored.turns.as_slice()),
                );
                Some(SessionTranscript {
                    session: session_id,
                    node: records
                        .first()
                        .and_then(|event| event.labels.node.as_deref())
                        .and_then(|node| NodeId::try_from(node).ok()),
                    records,
                    stored,
                    rows,
                })
            })
            .collect();
        Self { sessions }
    }
}

/// One row of a session's transcript, named for which account of the turn the
/// run holds.
///
/// The three variants are the three that exist, so a row with no account at all —
/// or a report-held turn with no place in the report — cannot be built.
enum TranscriptTurn<'a> {
    /// The journal's account alone: a turn no readable report says anything
    /// about, including a record that numbers no turn.
    Relayed {
        number: Option<u64>,
        turn: RelayedTurn<'a>,
    },
    /// Both accounts of one turn, joined on the producer's own number.
    Joined {
        number: u64,
        turn: RelayedTurn<'a>,
        /// Where the report's account of it sits among the report's turns.
        at: usize,
    },
    /// The report's account alone: a turn no record of the run ever named.
    Reported { number: u64, at: usize },
}

impl<'a> TranscriptTurn<'a> {
    /// The producer's own number for this turn, absent only for a relayed record
    /// that names none.
    fn number(&self) -> Option<u64> {
        match self {
            Self::Relayed { number, .. } => *number,
            Self::Joined { number, .. } | Self::Reported { number, .. } => Some(*number),
        }
    }

    /// What the journal relayed for this turn, and `None` for a row the report
    /// alone holds.
    fn relayed(&self) -> Option<&RelayedTurn<'a>> {
        match self {
            Self::Relayed { turn, .. } | Self::Joined { turn, .. } => Some(turn),
            Self::Reported { .. } => None,
        }
    }

    /// Where the report's account of this turn sits among the report's turns, and
    /// `None` for a row no report describes.
    fn reported(&self) -> Option<usize> {
        match self {
            Self::Relayed { .. } => None,
            Self::Joined { at, .. } | Self::Reported { at, .. } => Some(*at),
        }
    }

    /// The records that describe this row, and none at all for a row the report
    /// alone holds.
    fn records(&self) -> impl Iterator<Item = &'a Envelope> + '_ {
        self.relayed().into_iter().flat_map(RelayedTurn::records)
    }
}

/// The rows one session's transcript serves, in the order it serves them.
///
/// With no readable report, the session's own agent-side records are the whole
/// reading, in the order the journal relayed them. With one, the report is the
/// set of turns: every turn it recorded is a row, ordered by the producer's
/// 1-based number and joined to the relayed record that names that number — and
/// a record naming no turn is not one. `src/AGENTS.md` holds why each half is
/// that way.
///
/// The number is enough to join on **because [`relayed_turns`] has already
/// dropped the other party's records**: the two sides of a two-party member
/// number their turns independently, so joining the report by the number alone
/// over both sides matched each of the report's turns twice and served the
/// agent's prompt and reply on the supervisor's row as well as its own.
fn transcript_turns<'a>(
    records: &[&'a Envelope],
    reported: Option<&[ReportedTurn]>,
) -> Vec<TranscriptTurn<'a>> {
    let relayed = relayed_turns(records);
    let Some(reported) = reported else {
        return relayed
            .into_iter()
            .map(|turn| TranscriptTurn::Relayed {
                number: turn.numbered(),
                turn,
            })
            .collect();
    };
    let mut rows: Vec<TranscriptTurn<'a>> = Vec::new();
    for turn in relayed {
        let Some(number) = turn.numbered() else {
            continue;
        };
        rows.push(match reported_index(reported, number) {
            Some(at) => TranscriptTurn::Joined { number, turn, at },
            None => TranscriptTurn::Relayed {
                number: Some(number),
                turn,
            },
        });
    }
    // A turn the journal numbered is already a row; what is left is every turn
    // the report holds and no record of the run ever named.
    let claimed: BTreeSet<u64> = rows.iter().filter_map(TranscriptTurn::number).collect();
    for index in 0..reported.len() {
        let Ok(number) = u64::try_from(index + 1) else {
            continue;
        };
        if claimed.contains(&number) {
            continue;
        }
        rows.push(TranscriptTurn::Reported { number, at: index });
    }
    // Stable, so two rows a producer numbered the same — one party's turn and
    // the other's — keep the order the journal relayed them in.
    rows.sort_by_key(TranscriptTurn::number);
    rows
}

/// One turn as the settled member's stored report recorded it.
///
/// A turn is a prompt and the reply to it: the report's transcript alternates a
/// simulated user's message with the agent's, and its 1-based position is the
/// counter `telemetry.sessions` and `telemetry.attribution` both key on.
struct ReportedTurn {
    user: String,
    assistant: Option<String>,
    tools: Vec<Value>,
}

/// The settlement one session's member left, by the `{stream}.{member}` id that
/// spells the session.
///
/// Returned rather than consumed here because it is also the moment the report
/// was written, which is the only stamp [`judge_conclusion`] can carry.
fn settlement_of<'a>(view: &'a RunView, session: &str) -> Option<&'a Envelope> {
    view.events.iter().find(|event| {
        event.source == Source::Agentgraph
            && event.kind.0 == graph::MEMBER_SETTLED
            && event
                .labels
                .extra
                .get(graph::MEMBER)
                .and_then(Value::as_str)
                .is_some_and(|member| format!("{}.{member}", event.stream) == session)
    })
}

/// The report one settlement stored, refused unless the contract it was written
/// under is one this binary links and the bounds it carries are ones this crate
/// can order.
///
/// **Do not tighten this to equality.** onejudge bumps its version for an added
/// field, so every report stored before this binary was built is older than it
/// and reads perfectly well; only a document *ahead* of the linked contract may
/// mean something else by the fields the two share.
///
/// This is the trust boundary for a report: another process wrote it, and every
/// reading below takes what it says as fact. So the values are checked here and
/// nowhere else — a caller holding a `judge::Report` is holding one whose stamps
/// parse.
fn read_report(view: &RunView, settlement: &Envelope) -> Option<judge::Report> {
    let bytes = fs::read(report_path(view, settlement)).ok()?;
    let report: judge::Report = serde_json::from_slice(&bytes).ok()?;
    (report.schema_version <= judge::SCHEMA_VERSION && well_stamped(&report)).then_some(report)
}

/// Whether every bound a report's session rows carry is a stamp this crate can
/// order.
///
/// The version above vouches for the document's *shape* and for nothing in it: a
/// `SessionLink`'s bounds are `String`s in onejudge's contract, so a report that
/// deserializes and versions cleanly can still spell an instant as anything at
/// all. This crate serves them as a turn's `startedAt`, `finishedAt` and
/// `timestamp`, and folds them into the interval the judge's lane is drawn over
/// — so a value that is not a timestamp becomes a duration no client can compute
/// and an ordering it renders wrong, which is worse than the absence the wire
/// already has a spelling for.
///
/// Refused whole rather than row by row, and for both sides' rows rather than the
/// ones a given reading happens to join: the rows are one document written by one
/// process, and a report half of whose clock is unreadable is not a clock. An
/// unobserved finish is `null` here and stays a readable report — that is the
/// contract's own way of saying a bound was never seen, and not a malformed one.
fn well_stamped(report: &judge::Report) -> bool {
    let Some(telemetry) = report.telemetry.as_ref() else {
        return true;
    };
    telemetry.sessions.iter().all(|link| {
        millis_of(&link.started_at).is_some()
            && link
                .finished_at
                .as_deref()
                .is_none_or(|finished| millis_of(finished).is_some())
    })
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

/// Where the report's account of one numbered turn sits among the turns it
/// recorded, and `None` where it recorded none for that number.
///
/// The producer's counter is 1-based and the report's turns are in its order, so
/// the number is the position — which is the join `docs/contract.md` states, and
/// the reason a turn the journal numbered can be read out of a report that never
/// mentions the journal.
fn reported_index(turns: &[ReportedTurn], turn: u64) -> Option<usize> {
    let index = usize::try_from(turn).ok()?.checked_sub(1)?;
    (index < turns.len()).then_some(index)
}

/// The invocation one turn actually ran, out of the chain of identities its
/// attribution records.
///
/// This is where a turn's own usage and a turn's own elapsed time are, for either
/// side — the report's top-level `usage` is the whole dispatch's total over both
/// of them. The candidates beside the one that ran are identities the chain fell
/// through, and none of them happened.
fn ran_candidate(
    report: &judge::Report,
    role: judge::TelemetryRole,
    turn: u32,
) -> Option<&judge::CandidateAttempt> {
    attributed(report, role, turn)?
        .candidates
        .iter()
        .find(|candidate| candidate.ran)
}

/// The chain of identities one side's `turn` invocation recorded, or `None` where
/// the report attributes none to it.
///
/// The role is asked for rather than assumed: a report's `telemetry` keys both
/// its sessions and its attribution on the *pair* of a side and a turn number,
/// and the two sides number their turns independently — so a lookup by index
/// alone reads one side's invocation as the other's.
fn attributed(
    report: &judge::Report,
    role: judge::TelemetryRole,
    turn: u32,
) -> Option<&judge::HarnessAttribution> {
    report
        .telemetry
        .as_ref()?
        .attribution
        .iter()
        .find(|attribution| attribution.role == role && attribution.turn_index == turn)
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

/// The tool calls one turn published, each carrying the observation that
/// answered it.
///
/// `turn-activity` is streamed from inside a turn: a call carries the tool's kind
/// and name and a bounded summary of what it was given, and the observation that
/// answers it is a record of its own, carrying the output and naming no tool.
/// This folds the second onto the first, so a reader of a turn still running sees
/// what its calls came back with — which is the whole of what a settled member's
/// report would have told them later.
///
/// **A call is joined to its observation by what the producer published and never
/// by position in the served array.** The identity the harness minted is the
/// join where both sides carry one; where neither does, it is the recorded
/// ordering index — the last call still unanswered that the producer recorded
/// before this observation. An observation that answers no call this turn
/// published is served as an entry of its own rather than dropped: it is a thing
/// the run recorded, and the whole point of reading a live turn is that nothing
/// else holds it yet.
fn live_tools(summaries: &[&Envelope]) -> Vec<Value> {
    let mut served: Vec<Value> = Vec::new();
    // Where each unanswered call landed in `served`, with the two things an
    // observation is joined by. Only calls are registered here: an observation
    // answers a call and is never answered itself.
    let mut open: Vec<(usize, Option<String>, Option<u64>)> = Vec::new();
    for (position, event) in summaries.iter().enumerate() {
        let field = |name: &str| event.payload.get(name).and_then(Value::as_str);
        let recorded = event.payload.get(graph::INDEX).and_then(Value::as_u64);
        let identity = field(graph::TOOL_CALL_ID);
        // `tool_result` is the one word the producer closes: it declares the
        // observation and leaves a *call's* kind open, because that word is the
        // harness's own (`tool_use` on one, `tool_call` on the next) and this
        // crate serves it through to a reader verbatim. So the test is for the
        // observation and everything else is the call it is — holding calls to a
        // closed set here would drop every call from a harness nobody enumerated,
        // and enumerating them would be this crate declaring a record vocabulary
        // it does not own.
        // llmlint: ignore[boundary_inputs_validated] `oneagentgraph::event::TurnActivity::kind` is a `String` and not an enum, so there is no closed vocabulary to validate a call's kind against; the one closed word, the observation's, is what this branches on.
        // llmlint: ignore[invalid_states_unrepresentable] same reason: a call's kind is the producing harness's own word, served through verbatim, and a closed enum here would be a second declaration of a vocabulary this crate does not own — see the module note above `TURN_MESSAGE`.
        if field(graph::KIND) == Some(graph::TOOL_RESULT) {
            if let Some(at) = answered(&open, identity, recorded) {
                let entry = open.remove(at).0;
                served[entry][graph::OUTPUT] = json!(field(graph::OUTPUT));
                if truthy(event, graph::OUTPUT_TRUNCATED) {
                    served[entry][graph::OUTPUT_TRUNCATED] = json!(true);
                }
                continue;
            }
        } else {
            open.push((served.len(), identity.map(str::to_owned), recorded));
        }
        let mut entry = json!({
            "index": recorded.map_or_else(|| json!(position), |index| json!(index)),
            "kind": field(graph::KIND).unwrap_or_default(),
            "name": field(graph::NAME),
            "input": field(graph::DETAIL),
            "output": field(graph::OUTPUT),
        });
        if truthy(event, graph::OUTPUT_TRUNCATED) {
            entry[graph::OUTPUT_TRUNCATED] = json!(true);
        }
        served.push(entry);
    }
    served
}

/// Which unanswered call one observation answers, as a position in `open`.
///
/// The two joins the producer offers, in the order it offers them: the harness's
/// own identity for the call, and — where neither side carries one — the ordering
/// index it recorded, which makes the answer the last call published before this
/// observation. `None` where the turn published no call this can be said to
/// answer.
fn answered(
    open: &[(usize, Option<String>, Option<u64>)],
    identity: Option<&str>,
    recorded: Option<u64>,
) -> Option<usize> {
    if let Some(identity) = identity {
        return open
            .iter()
            .position(|(_, call, _)| call.as_deref() == Some(identity));
    }
    let recorded = recorded?;
    open.iter()
        .enumerate()
        .rfind(|(_, (_, call, index))| call.is_none() && index.is_some_and(|at| at < recorded))
        .map(|(at, _)| at)
}

/// One bound a record stamped, and `None` unless it is an instant this crate can
/// order.
///
/// The trust boundary a live turn's clock crosses: these values are another
/// process's bytes, they are served as a turn's `startedAt` and `finishedAt` and
/// folded into its elapsed time, and a value that is not a timestamp would be a
/// duration no client can compute and an ordering it renders wrong. Held to the
/// same rule a stored report's bounds are held to — served absent, which is what
/// the wire already spells for a bound nobody observed.
fn instant<'a>(event: &'a Envelope, field: &str) -> Option<&'a str> {
    event
        .payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|stamp| millis_of(stamp).is_some())
}

/// Whether one record flagged a field of its own true.
///
/// The producer omits every one of these flags rather than writing a `false`, so
/// an absent flag and a `false` one say the same thing and both read as "not
/// cut".
fn truthy(event: &Envelope, field: &str) -> bool {
    event.payload.get(field).and_then(Value::as_bool) == Some(true)
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

/// The usage figures one relayed record carries, in the wire's own spelling.
///
/// What they are an account *of* is the producer's answer and not this crate's.
/// The producer that corrected what a live turn publishes carries one turn's own
/// accounting on the `turn-completed` that closed it, keyed by the turn number
/// and the party beside it; the producer before it copied a settling member's
/// usage verbatim out of its report, so what reached the journal was the whole
/// dispatch's total over both sides. Either way this is served only where the
/// report's attribution says nothing about the turn — the journal's account is
/// then all the run holds.
///
/// A figure the provider never reported is `null` rather than a zero, which is
/// the difference between a turn nothing measured and a turn that cost nothing.
fn relayed_usage(event: &Envelope) -> Value {
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
/// The same five figures [`relayed_usage`] reads off a record, from the one place
/// they are recorded per turn rather than per dispatch: a report's own `usage` is
/// that dispatch's total, and serving it on a turn would repeat one total on
/// every one of them.
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

/// One turn of a session as its own journal records describe it.
///
/// **Two records describe one turn, not two.** The corrected producer opens a
/// turn and closes it, keyed by the same pair, and serving a row for each hands a
/// reader one turn twice — the same instruction, the same reply, and the same
/// interval drawn as two spans lying over each other, which is a plot nothing can
/// be hovered or opened on. So the pair is grouped here and the turn is served
/// once, whichever of its records the run holds.
struct RelayedTurn<'a> {
    /// The record the journal opened this turn with: its `turn-started`, or the
    /// `turn-completed` where no start ever reached the journal.
    opened: &'a Envelope,
    /// The `turn-completed` that closed it, and `None` for a turn still running —
    /// which serves its usage and its end bound absent, because a turn nothing has
    /// measured yet is not a turn that measured zero.
    completed: Option<&'a Envelope>,
    /// The `turn-activity` summaries published from inside it.
    summaries: Vec<&'a Envelope>,
}

impl<'a> RelayedTurn<'a> {
    /// The state the run last recorded this turn in, which is the kind of the
    /// last of its records to reach the journal.
    fn status(&self) -> &'a str {
        self.completed.unwrap_or(self.opened).kind.0.as_str()
    }

    /// The producer's own number for this turn, from whichever of its records
    /// carries one.
    fn numbered(&self) -> Option<u64> {
        self.records()
            .find_map(|event| event.payload.get(graph::TURN).and_then(Value::as_u64))
    }

    /// The pair this turn is keyed by, or `None` where neither of its records
    /// names one — see [`turn_key`] for why half a key joins nothing.
    fn key(&self) -> Option<(u64, String)> {
        self.records().find_map(turn_key)
    }

    /// One field, from whichever of this turn's records carries it.
    fn field(&self, name: &str) -> Option<&'a str> {
        self.records()
            .find_map(|event| event.payload.get(name).and_then(Value::as_str))
    }

    /// The records that describe this turn, the one that opened it first.
    fn records(&self) -> impl Iterator<Item = &'a Envelope> {
        std::iter::once(self.opened).chain(self.completed)
    }
}

/// The turns one session relayed, each with the tool summaries published from
/// inside it.
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
///
/// **Only the agent's own turns are rows of this transcript.** A two-party member
/// relays both sides, and the supervisor's records are its own invocation: what
/// it was *asked* is the reply it is answering and what it *said* is the next
/// instruction, so serving one as a row put the agent's reply on the user side of
/// a row of its own and doubled every count folded off this list. Its words reach
/// a reader where they belong — as the `user` of the agent turn they opened — and
/// a summary published from inside it is dropped rather than folded onto the
/// agent turn before it, which would bill one party's tools to the other. See
/// [`agent_turn`] for why a record naming no party is the agent's.
fn relayed_turns<'a>(events: &[&'a Envelope]) -> Vec<RelayedTurn<'a>> {
    let mut turns: Vec<RelayedTurn<'a>> = Vec::new();
    let mut open: Vec<&'a Envelope> = Vec::new();
    // The turn record a summary arriving now was published from inside, which is
    // the last one the producer relayed — and `None` until it has relayed any, so
    // a summary that arrived before the session's first turn record still joins
    // it. Kept as the record rather than as a flag read off it, because it is
    // what says *whose* turn the summary was published from.
    let mut published_from: Option<&'a Envelope> = None;
    for event in events.iter().copied() {
        if event.kind.0 == graph::TURN_ACTIVITY {
            // The supervisor's own tool calls are not the agent's turn's, and
            // there is no row of its own for them to land on.
            if published_from.is_none_or(agent_turn) {
                open.push(event);
            }
            continue;
        }
        if !is_turn_record(event) {
            continue;
        }
        // Flushed on every turn record, the other party's included: the summaries
        // held here were published from inside the turn before this one, and
        // holding them across a supervisor's turn would land them one turn late.
        if let Some(turn) = turns.last_mut() {
            turn.summaries.append(&mut open);
        }
        published_from = Some(event);
        if !agent_turn(event) {
            continue;
        }
        match closes(&turns, event) {
            Some(at) => turns[at].completed = Some(event),
            None => turns.push(RelayedTurn {
                opened: event,
                completed: None,
                summaries: std::mem::take(&mut open),
            }),
        }
    }
    if let Some(turn) = turns.last_mut() {
        turn.summaries.append(&mut open);
    }
    turns
}

/// Which turn already relayed a record closes, as a position in `turns`.
///
/// **The producer's own join and nothing else**: the pair of the turn number and
/// the party, which is what tells the supervisor's third turn from the agent's.
/// The producer that predates that pair publishes one `turn-completed` per
/// *dispatch* rather than per turn — it is emitted beside the settlement, and the
/// usage on it is the member's whole total — so a record carrying no pair closes
/// nothing and is served as the record it is, exactly as it always has been.
/// Guessing by proximity there would hand one turn a bill for all of them.
///
/// `None` for a `turn-completed` whose start never reached the journal too, which
/// makes it a turn of its own: a member that died mid-turn still had the turn.
fn closes(turns: &[RelayedTurn<'_>], event: &Envelope) -> Option<usize> {
    if event.kind.0 != graph::TURN_COMPLETED {
        return None;
    }
    let key = turn_key(event)?;
    turns.iter().rposition(|turn| {
        turn.opened.kind.0 == graph::TURN_STARTED
            && turn.completed.is_none()
            && turn.key().as_ref() == Some(&key)
    })
}

/// What one session's own journal records say about one turn of it.
///
/// The live half of a transcript: a dispatch that is still running has no stored
/// report and a dispatch whose member died never writes one, so for both of them
/// these records are the whole of what any reader can be shown — the instruction
/// the turn is answering, the reply it has produced, and that turn's own cost and
/// bounds.
struct LiveTurn<'a> {
    /// `turn-started`: the message this turn answers, and when it began.
    started: Option<&'a Envelope>,
    /// `turn-completed`: what the turn consumed, and the interval it ran over.
    completed: Option<&'a Envelope>,
    /// The `turn-message` records this party published for this turn.
    said: Vec<&'a Envelope>,
}

impl LiveTurn<'_> {
    /// The message this turn was given to answer, or `None` where the record that
    /// opened it never reached the journal.
    fn instruction(&self) -> Option<&str> {
        self.started?
            .payload
            .get(graph::INSTRUCTION)
            .and_then(Value::as_str)
    }

    /// This party's own words for this turn, or `None` where it published none.
    ///
    /// `None` rather than an empty string on purpose: a session that captured no
    /// text still has to read as having captured none, and a single-sided member
    /// publishes no `turn-message` at all — its words are in the report it leaves
    /// when it settles, and nowhere else while it runs.
    ///
    /// Both member kinds publish at most one of these per turn per party. A
    /// producer that published several wrote one reply in parts, so they are
    /// joined in the order it published them: serving one part would drop the
    /// rest, which is the one thing a transcript may not do.
    fn text(&self) -> Option<String> {
        if self.said.is_empty() {
            return None;
        }
        Some(
            self.said
                .iter()
                .filter_map(|event| event.payload.get(graph::TEXT).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    }

    /// When this turn began: the instant the producer stamped, from whichever of
    /// its two records carries one this crate can order.
    ///
    /// Both records stamp it, so one unreadable stamp is not a reason to serve a
    /// turn with no start when the other record stamped a readable one.
    fn started_at(&self) -> Option<&str> {
        self.completed
            .and_then(|event| instant(event, graph::STARTED_AT))
            .or_else(|| instant(self.started?, graph::STARTED_AT))
    }

    /// When this turn ended, or `None` for one still running.
    fn finished_at(&self) -> Option<&str> {
        instant(self.completed?, graph::FINISHED_AT)
    }

    /// How long this turn took, in whole milliseconds.
    ///
    /// The difference between the two instants the producer stamped, and absent
    /// unless the turn has both — an unmeasured turn is served without an elapsed
    /// time rather than with a zero. A finish before its own start is not a
    /// duration and is served as none.
    fn duration_ms(&self) -> Option<u64> {
        let started = millis_of(self.started_at()?)?;
        let finished = millis_of(self.finished_at()?)?;
        u64::try_from(finished.checked_sub(started)?).ok()
    }

    /// The producer's own flags for the two texts this turn serves, exactly where
    /// it flagged one.
    ///
    /// They ride the `unknown` map every turn has always carried, because the
    /// turn shape declares no field for them and this reading adds none. A text
    /// the producer cut is served cut — the rest of it is in the report the member
    /// stores when it settles — and a reader has to be able to tell that from a
    /// reply that was simply short.
    fn cut(&self) -> Map<String, Value> {
        let mut flags = Map::new();
        if self
            .started
            .is_some_and(|event| truthy(event, graph::INSTRUCTION_TRUNCATED))
        {
            flags.insert(graph::INSTRUCTION_TRUNCATED.into(), json!(true));
        }
        if self
            .said
            .iter()
            .any(|event| truthy(event, graph::TRUNCATED))
        {
            flags.insert(graph::TRUNCATED.into(), json!(true));
        }
        flags
    }
}

/// The turns one session's journal records, keyed the way the producer numbers
/// them.
///
/// **By the pair of the turn number and the party**, never by the number alone:
/// the two sides of a conversation number their turns independently, so a lookup
/// by index reads the supervisor's turn as the agent's. It is the same pair the
/// stored report keys its own rows on.
///
/// Built over the session's **whole** record set rather than the listing a
/// reader's filter admitted, for the reason a report is read whole: a filter
/// narrows which turns a transcript lists and never what one of them said.
fn live_transcript<'a>(events: &[&'a Envelope]) -> BTreeMap<(u64, String), LiveTurn<'a>> {
    let mut turns: BTreeMap<(u64, String), LiveTurn<'a>> = BTreeMap::new();
    for event in events {
        let Some(key) = turn_key(event) else {
            continue;
        };
        let turn = turns.entry(key).or_insert_with(|| LiveTurn {
            started: None,
            completed: None,
            said: Vec::new(),
        });
        match event.kind.0.as_str() {
            graph::TURN_STARTED => turn.started = Some(event),
            graph::TURN_COMPLETED => turn.completed = Some(event),
            graph::TURN_MESSAGE => turn.said.push(event),
            _ => {}
        }
    }
    turns
}

/// Whether one turn record is a turn of this transcript — the agent's own.
///
/// The party is read off the record rather than assumed, because a two-party
/// member relays both sides' turns into one session. The agent's side is the
/// transcript: its turns are the rows, its words are their replies, and the
/// supervisor's own invocation beside it is not a turn a reader is shown — its
/// instruction is the agent's last reply and its reply is the agent's next
/// instruction, both of which reach a reader on the agent's turns already.
///
/// A record naming **no** party is the agent's. The producer that predates the
/// party runs one side and relays it, so there is no other side for such a record
/// to belong to — and refusing it would empty the transcript of every session
/// recorded before that correction, which those runs still have to serve.
// llmlint: ignore-block[invalid_states_unrepresentable] the closed vocabulary is
// `oneagentgraph::event::Party`, and it belongs to the producer: that library
// publishes the field as a `String` on purpose — "that is the shape the wire has
// and a consumer reads" — mints one only where it writes a record, and exposes no
// parse back, so there is no type at this pin to parse into. Declaring one here
// would be this crate owning a record's vocabulary, which `AGENTS.md` forbids in
// as many words; `graph::ASSISTANT_ROLE` is that type's own spelling and
// `tests/contract.rs` holds it to the producer's declaration. It is the same
// answer `turn_key` below already carries for the same field, and an unrecognised
// party is not an invalid state here — it is a party this transcript has no rows
// for, which is what a reading that cannot know the producer's next word owes it.
fn agent_turn(event: &Envelope) -> bool {
    match event.payload.get(graph::ROLE).and_then(Value::as_str) {
        Some(role) => role == graph::ASSISTANT_ROLE,
        None => true,
    }
}
// llmlint: ignore-end[invalid_states_unrepresentable]

/// The turn one record belongs to, or `None` for a record that names none.
///
/// A record from the producer that predates the pair — it numbers a turn and says
/// nothing about who is taking it — joins nothing: half a key cannot be matched
/// to the other side's records without guessing which side wrote it, and a
/// transcript that guessed would put one party's words on the other's turn.
///
/// The party is carried as the producer's own word rather than as a vocabulary
/// this crate declares. It is only ever compared to another record's — two
/// records of one turn, or a turn's own words against it — and a word this crate
/// did not expect groups those records with each other exactly as one it did.
/// Holding it to a closed set instead would ungroup a party the producer added,
/// which is a worse answer than the same turn under an unfamiliar name.
// llmlint: ignore[boundary_inputs_validated] this is not a value that reaches storage, a path or a client: it is half a grouping key, compared only against another record's, and there is no type at this pin to validate it against — `oneagentgraph` 0.2 publishes no role at all (see the module note above `TURN_MESSAGE`).
// llmlint: ignore[invalid_states_unrepresentable] the closed vocabulary belongs to the producer, and declaring it here would be this crate owning a record's fields, which `AGENTS.md` forbids in as many words; an unrecognised party groups a turn with itself rather than becoming an invalid state.
fn turn_key(event: &Envelope) -> Option<(u64, String)> {
    if event.source != Source::Agentgraph {
        return None;
    }
    let turn = event.payload.get(graph::TURN).and_then(Value::as_u64)?;
    let role = event.payload.get(graph::ROLE).and_then(Value::as_str)?;
    Some((turn, role.to_owned()))
}

/// One relayed session's transcript, from the report its member stored where the
/// run holds one and from the session's own journal records where it does not.
///
/// **Where a session has both, the report wins and the live records below are not
/// read at all.** A report is complete and unbounded where the journal is
/// bounded, and a reading that merged the two could disagree with itself about
/// the same turn — a text the journal cut against the whole of it, a total the
/// producer copied against that turn's own. So the live transcript is built only
/// for a session no readable report was found for, which is what makes that rule
/// a property of this function rather than a habit of its callers.
///
/// `docs/contract.md` states the same precedence for a reader of the wire.
fn conversation_document(
    view: &RunView,
    transcript: &SessionTranscript<'_>,
    events: &[&Envelope],
) -> Value {
    let session = transcript.session.as_str();
    let stored = transcript.stored.as_ref();
    let reported = stored.map(|stored| &stored.report);
    let first = events.first().copied();
    let last = events.last().copied();
    let started_at = first.map_or_else(now_rfc3339, |event| event.ts.clone());
    let node = first.and_then(|event| event.labels.node.clone());
    let live = match reported {
        Some(_) => BTreeMap::new(),
        None => live_transcript(&transcript.records),
    };
    // Which turn records the reader's filter admitted, named the way one record is
    // named in a merged store. It decides which turns are **listed** and nothing
    // else: every turn below is grouped and read from the session's whole record
    // set, for the reason a report is read whole — a filter narrows which turns a
    // transcript lists and never what one of them was.
    let listed: BTreeSet<(&str, u64)> = events
        .iter()
        .filter(|event| is_turn_record(event))
        .map(|event| (event.stream.as_str(), event.seq))
        .collect();
    let turns: Vec<Value> = transcript
        .rows
        .iter()
        // Numbered over the whole session before the listing narrows it, which is
        // the numbering [`turn_ids`] hands a client from the timeline: an id that
        // moved with the reader's filter would name a different turn than the one
        // the transcript route serves under it.
        .enumerate()
        .filter(|(_, row)| match row.relayed() {
            // A turn the report alone holds carries no record for a filter to
            // rule on, so it is listed wherever the session itself is: excluding
            // it would let a reading narrowed to a kind change what the report
            // says the dispatch did.
            None => true,
            Some(_) => row
                .records()
                .any(|record| listed.contains(&(record.stream.as_str(), record.seq))),
        })
        .map(|(index, row)| {
            let turn = row.relayed();
            let event = turn.map(|turn| turn.opened);
            // The producer's own number for this turn, which is the counter the
            // report shares between its sessions and its attribution. A record
            // that names no turn — a settlement, a death — is not one of the
            // conversation's turns and takes nothing from the report.
            let numbered = row.number();
            let recorded = row
                .reported()
                .and_then(|at| stored.and_then(|stored| stored.turns.get(at)));
            // The same turn as the journal recorded it, for a session the run
            // holds no report for. Empty whenever there is a report, so nothing
            // below can mix the two readings of one turn.
            let relayed = turn
                .and_then(RelayedTurn::key)
                .and_then(|key| live.get(&key));
            let ran = numbered
                .and_then(|turn| u32::try_from(turn).ok())
                .zip(reported)
                .and_then(|(turn, report)| {
                    ran_candidate(report, judge::TelemetryRole::Agent, turn)
                });
            let bounds = numbered
                .zip(reported)
                .and_then(|(turn, report)| agent_session(report, turn));
            json!({
                "assistant": match recorded {
                    // Explicitly absent rather than empty: the report holds this
                    // turn and it recorded no reply.
                    Some(turn) => json!(turn.assistant),
                    // A turn's reply is what its own party published for it, and
                    // only the agent's words are a transcript's reply — the
                    // supervisor's reach a reader as the next turn's prompt,
                    // which is what it was asked rather than what it said.
                    None => json!(relayed.filter(|_| event.is_some_and(agent_turn)).and_then(LiveTurn::text)),
                },
                "durationMs": match ran {
                    Some(candidate) => json!(candidate.duration_ms),
                    None => json!(relayed.and_then(LiveTurn::duration_ms)),
                },
                "failureKind": Value::Null,
                "finishedAt": match bounds {
                    Some(link) => json!(link.finished_at),
                    None => json!(relayed.and_then(LiveTurn::finished_at)),
                },
                "harness": "oneagentgraph",
                "id": format!("{session}.{index}"),
                // The identity the report attributes to the invocation that ran
                // this turn, and the producer's own field where the report
                // attributes none: a turn the journal never bracketed has no
                // record to read one off, and the report is the whole of what
                // the run holds about it.
                "model": match ran.and_then(|candidate| candidate.model.as_deref()) {
                    Some(model) => json!(model),
                    None => json!(turn.and_then(|turn| turn.field("model"))),
                },
                "reasoning": Value::Null,
                "startedAt": match bounds {
                    Some(link) => json!(link.started_at),
                    None => json!(relayed.and_then(LiveTurn::started_at)),
                },
                // The state the run last recorded the turn in, not the kind of
                // one of the two records that describe it. A turn the journal
                // never recorded is served the status oneharness gave the
                // invocation that ran it, and `unknown` where the report
                // attributes none — the same word every other unrecorded state
                // here is served as.
                "status": match turn {
                    Some(turn) => turn.status(),
                    None => ran.map_or("unknown", |candidate| candidate.status.as_str()),
                },
                // The record that describes this turn stamps it. A turn only the
                // report holds is stamped by its own observed bounds, and — where
                // the report observed none — by the settlement that stored the
                // report, which is the one instant any run holds for it.
                "timestamp": match event {
                    Some(event) => json!(event.ts),
                    None => json!(bounds
                        .and_then(|link| link.finished_at.clone().or_else(|| Some(link.started_at.clone())))
                        .or_else(|| stored.map(|stored| stored.settlement.ts.clone()))
                        .unwrap_or_else(|| started_at.clone())),
                },
                "tools": match recorded {
                    Some(turn) => Value::Array(turn.tools.clone()),
                    None => Value::Array(live_tools(turn.map_or(&[], |turn| &turn.summaries))),
                },
                "unknown": relayed.map(LiveTurn::cut).unwrap_or_default(),
                "usage": match ran {
                    Some(candidate) => candidate_usage(candidate.usage.as_ref()),
                    // The record that closed this turn: a turn's cost is
                    // recorded once, on the `turn-completed`, and a turn nothing
                    // has closed yet is served without one. Read from the whole
                    // session ahead of the reader's own listing, for the reason
                    // every other figure on this row is. A turn no record and no
                    // attribution measured is served no figures at all rather
                    // than zeroes.
                    None => match relayed
                        .and_then(|live| live.completed)
                        .or_else(|| turn.and_then(|turn| turn.completed))
                        .or(event)
                    {
                        Some(record) => relayed_usage(record),
                        None => Value::Object(Map::new()),
                    },
                },
                // The prompt the simulated user gave, which is what the turn
                // answered. Never the dispatch's persona name, which is who was
                // asked and not what they were asked.
                "user": match recorded {
                    Some(turn) => turn.user.clone(),
                    None => relayed
                        .and_then(LiveTurn::instruction)
                        .unwrap_or_default()
                        .to_owned(),
                },
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
        json!(first.and_then(event_agent_role).unwrap_or("worker")),
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

/// The member word both closed role vocabularies spell the judge with.
///
/// Resolved through [`agent_role`] and [`Party::named`] rather than written onto
/// the wire, so a vocabulary that stopped carrying it fails to resolve here
/// instead of serving a word no client switches on.
const JUDGE_MEMBER: &str = "judge";

/// The report's own rows for the side that supervised a dispatch, ordered by the
/// producer's 1-based turn counter — the join [`agent_session`] makes on the
/// other side, and not position, because a report lists the two interleaved.
fn judge_links(report: &judge::Report) -> Vec<&judge::SessionLink> {
    let Some(telemetry) = report.telemetry.as_ref() else {
        return Vec::new();
    };
    let mut links: Vec<&judge::SessionLink> = telemetry
        .sessions
        .iter()
        .filter(|link| link.role == judge::TelemetryRole::Judge)
        .collect();
    links.sort_by_key(|link| link.turn_index);
    links
}

/// The interval a settled dispatch's judge ran over, from [`judge_links`] and
/// nothing else — no record brackets it. `None` where the report holds no row.
///
/// A row whose end was never observed leaves the lane open, which is the rule
/// [`Category`] folds a category of sessions by.
fn judge_interval(report: &judge::Report) -> Option<(Moment, Option<Moment>)> {
    let links = judge_links(report);
    let opened = links
        .iter()
        .filter_map(|link| moment_at(&link.started_at))
        .min_by_key(|moment| moment.at)?;
    let mut ends: Vec<Moment> = Vec::with_capacity(links.len());
    for link in &links {
        let Some(ended) = link.finished_at.as_deref().and_then(moment_at) else {
            // One row the run never saw finish leaves the whole lane open,
            // whatever the rows beside it did.
            ends.clear();
            break;
        };
        ends.push(ended);
    }
    Some((opened, ends.into_iter().max_by_key(|moment| moment.at)))
}

/// The judge's own conversation for one settled dispatch, or `None` where the
/// report holds no `role: judge` row to serve one from.
///
/// Why the report is the only source, and why that gate rather than another:
/// `src/AGENTS.md`, under the report a settled member left.
fn judge_conversation(
    view: &RunView,
    session: &str,
    events: &[&Envelope],
    settlement: &Envelope,
    report: &judge::Report,
) -> Option<Value> {
    let links = judge_links(report);
    let (opened, closed) = judge_interval(report)?;
    let agent_role = agent_role(Some(JUDGE_MEMBER), None)?;
    let transport = Party::named(JUDGE_MEMBER)?;
    let id = judge_session(session);
    let first = events.first().copied();
    let node = first.and_then(|event| event.labels.node.clone());

    let mut turns: Vec<Value> = links
        .iter()
        .enumerate()
        .map(|(index, link)| judge_turn(&id, index, report, link))
        .collect();
    turns.push(judge_conclusion(&id, links.len(), settlement, report));

    // The harnesses the judge's turns ran on, in the order it ran them. The
    // relayed side of a dispatch can only name the library that relayed it; a
    // report names the canonical harness each invocation actually ran, which is
    // what this field is for.
    let mut harnesses: Vec<Value> = Vec::new();
    for link in &links {
        let Some(ran) = ran_candidate(report, judge::TelemetryRole::Judge, link.turn_index) else {
            continue;
        };
        let named = json!(ran.harness);
        if !harnesses.contains(&named) {
            harnesses.push(named);
        }
    }

    let mut attribution = Map::new();
    attribution.insert("runId".into(), json!(view.paths.run));
    if let Some(step) = first.and_then(|event| event.labels.step.clone()) {
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
    attribution.insert("transportRole".into(), json!(transport.as_str()));
    attribution.insert("agentRole".into(), json!(agent_role));
    // The dispatch this conversation supervised. It is what names the two sides
    // one dispatch rather than two rows of equal weight, and a reader who opened
    // the judge has to be able to see which work it ruled on.
    attribution.insert("parentConversationId".into(), json!(session));
    attribution.insert(
        "finishedAt".into(),
        closed
            .as_ref()
            .map_or(Value::Null, |moment| json!(moment.ts)),
    );
    // No persona: a persona is the style the *dispatched member* was asked in,
    // and the judge was not dispatched.
    Some(json!({
        "conversation": {
            "canContinue": false,
            "harnesses": harnesses,
            "id": id,
            "name": node.unwrap_or_else(|| view.paths.run.clone()),
            "project": view.paths.run,
            "startedAt": opened.ts,
            // The record that makes this conversation readable at all: the
            // settlement stored the report every turn of it is read from.
            "state": graph::MEMBER_SETTLED,
            "turns": turns,
        },
        "attribution": Value::Object(attribution),
    }))
}

/// The id one settled dispatch's judge conversation is served under: the worker
/// session's own with `.judge` after it, which `check_segment` admits as a bare
/// identifier, so the route resolves it through the same lookup as any other.
fn judge_session(session: &str) -> String {
    format!("{session}.{JUDGE_MEMBER}")
}

/// One judge turn: bounded and measured, and not transcribed — see
/// `src/AGENTS.md` for why no text may be keyed to one.
fn judge_turn(id: &str, index: usize, report: &judge::Report, link: &judge::SessionLink) -> Value {
    let entry = attributed(report, judge::TelemetryRole::Judge, link.turn_index);
    let ran = ran_candidate(report, judge::TelemetryRole::Judge, link.turn_index);
    json!({
        "assistant": Value::Null,
        "durationMs": ran.and_then(|candidate| candidate.duration_ms),
        "failureKind": ran.and_then(|candidate| candidate.failure_kind.clone()),
        "finishedAt": link.finished_at,
        // The identity that ran this turn, as the report's own attribution
        // composed it. Empty where no candidate ran, which the report says by
        // recording none.
        "harness": entry.and_then(|entry| entry.ran.clone()).unwrap_or_default(),
        "id": format!("{id}.{index}"),
        "model": ran.and_then(|candidate| candidate.model.clone()),
        "reasoning": Value::Null,
        "startedAt": link.started_at,
        // oneharness's own status token for the invocation, which is the only
        // account of how this turn ended that any record holds. `unknown` where
        // the report attributes no candidate to it — the same word this crate
        // serves for a state nothing recorded.
        "status": ran.map_or("unknown", |candidate| candidate.status.as_str()),
        "timestamp": link.finished_at.clone().unwrap_or_else(|| link.started_at.clone()),
        // Nothing: `turn-activity` is relayed per *relayed* session and the judge
        // relays none, so no run holds a tool call of the judge's.
        "tools": Vec::<Value>::new(),
        "unknown": Map::new(),
        "usage": candidate_usage(ran.and_then(|candidate| candidate.usage.as_ref())),
        "user": "",
    })
}

/// The turn a judge conversation closes on: what the report keys to the
/// *dispatch* rather than to any turn of it.
///
/// Served whole — a report-backed read is not bounded the way an artifact's bytes
/// are — with bounds and usage absent, because a verdict call is not one of the
/// invocations the telemetry attributes to a turn.
fn judge_conclusion(
    id: &str,
    index: usize,
    settlement: &Envelope,
    report: &judge::Report,
) -> Value {
    let verdicts: Vec<Value> = report
        .verdicts
        .iter()
        .map(|named| {
            json!({
                "criterion": named.criterion,
                "kind": named.kind.as_str(),
                "value": named.verdict.value,
                "reason": named.verdict.reason,
            })
        })
        .collect();
    json!({
        "assistant": report.assessment,
        "durationMs": Value::Null,
        "failureKind": Value::Null,
        "finishedAt": Value::Null,
        "harness": "onejudge",
        "id": format!("{id}.{index}"),
        "model": Value::Null,
        "reasoning": Value::Null,
        "startedAt": Value::Null,
        "status": graph::MEMBER_SETTLED,
        // The moment the report was written, which is the settlement's own: the
        // conclusion is stamped by nothing else, and the field is required.
        "timestamp": settlement.ts,
        "tools": Vec::<Value>::new(),
        "unknown": json!({
            "verdicts": verdicts,
            "completionReason": report.completion_reason,
            "stoppedEarly": report.stopped_early,
        }),
        "usage": Map::new(),
        "user": "",
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
    /// The run's transcripts, folded once: the judge lane is drawn over the same
    /// stored report the turns beside it were read from.
    transcripts: &'a Transcripts<'a>,
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
    let transcripts = Transcripts::of(view);
    let turns = turn_ids(view, &transcripts);
    let lens = Lens {
        turns: &turns,
        filter,
        transcripts: &transcripts,
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
fn turn_ids(view: &RunView, transcripts: &Transcripts<'_>) -> Vec<Option<Turn>> {
    // The turn each of a session's records belongs to, taken from the fold
    // [`conversations`] serves: **both** records of one turn name the same turn,
    // so a reader who opened the moment the turn closed and one who opened the
    // moment it began are handed the same transcript row — and a row the stored
    // report alone holds shifts the ones after it here exactly as it does there.
    let mut named: BTreeMap<(&str, u64), String> = BTreeMap::new();
    for session in &transcripts.sessions {
        for (index, row) in session.rows.iter().enumerate() {
            for record in row.records() {
                named.insert(
                    (record.stream.as_str(), record.seq),
                    format!("{}.{index}", session.session),
                );
            }
        }
    }
    view.events
        .iter()
        .map(|event| {
            let id = named.get(&(event.stream.as_str(), event.seq))?;
            Some(Turn {
                session: ConversationId::try_from(session_label(event)?).ok()?,
                id: id.clone(),
            })
        })
        .collect()
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

/// The release facts one record carried, when it is one of the six that carry any.
///
/// The six are two producers' halves of one sequencing: `onepipeline` records a
/// node being **held** on a dependency's release, the release **arriving**, and
/// the versions being **adopted** into the node's context; `onevcs` records the
/// **probe** of an automated target, a person **acknowledging** a human step, and
/// the release being **observed**. A reader meets them in one timeline, in order,
/// so they are served under one shape rather than six.
///
/// Every field is optional and each is present exactly when the record carried
/// it — the same discipline the redirection above keeps, and for the same reason:
/// the two producers know different halves, and a field defaulted here would be
/// this crate saying something no record did. What decides the shape is which of
/// the six the record is, and each kind's own payload is quoted where it is
/// declared, in [`vcs`] and [`pipeline`].
///
/// A record that carried none of them is served **no release at all** rather than
/// an empty object: an empty one would read as a release nobody could name.
fn release_facts(event: &Envelope) -> Option<Value> {
    let recognized: &[&str] = match (event.source, event.kind.0.as_str()) {
        (Source::Vcs, vcs::RELEASE_PROBED) => &["identity", "target", "form", "outcome", "version"],
        (Source::Vcs, vcs::RELEASE_ACKNOWLEDGED) => {
            &["identity", "target", "version", "landing_commit", "actor"]
        }
        (Source::Vcs, vcs::RELEASE_OBSERVED) => {
            &["identity", "target", "style", "version", "landing_commit"]
        }
        (Source::Pipeline, pipeline::RELEASE_WAIT) => &[],
        (Source::Pipeline, pipeline::RELEASE_ARRIVED) => {
            &["dep", "identity", "target", "style", "version"]
        }
        (Source::Pipeline, pipeline::RELEASE_ADOPTED) => &["delivery"],
        _ => return None,
    };
    let mut record = Map::new();
    for key in recognized {
        if let Some(value) = non_empty(event.payload.get(*key).and_then(Value::as_str)) {
            record.insert((*key).to_owned(), json!(value));
        }
    }
    // The two numbers and the flag, each read as what its own type is so a
    // recorded string can never reach a client that types them.
    if let Some(elapsed) = event.payload.get("elapsed_ms").and_then(Value::as_u64) {
        record.insert("elapsed_ms".into(), json!(elapsed));
    }
    if let Some(superseded) = event.payload.get("superseded").and_then(Value::as_bool) {
        record.insert("superseded".into(), json!(superseded));
    }
    // What the node is held on, one entry per thing. A wait with no readable
    // entry is a wait this build cannot describe, so it serves none rather than
    // an empty list that would read as a node held on nothing.
    let awaiting: Vec<Value> = event
        .payload
        .get("awaiting")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(awaited).collect())
        .unwrap_or_default();
    if !awaiting.is_empty() {
        record.insert("awaiting".into(), Value::Array(awaiting));
    }
    // The versions an adoption wrote into the node's context, under the
    // producer's own name for the list.
    let versions: Vec<Value> = event
        .payload
        .get("versions")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(released_version).collect())
        .unwrap_or_default();
    if !versions.is_empty() {
        record.insert("versions".into(), Value::Array(versions));
    }
    (!record.is_empty()).then(|| Value::Object(record))
}

/// One thing a node is being held on, from a [`pipeline::RELEASE_WAIT`] entry.
///
/// `action` is served exactly where the record carried one, which is exactly the
/// **human-step** entries: it is what somebody has to go and do, and it is the
/// difference between a wait that will clear itself and a wait that needs a
/// person told. An entry naming nothing it waits on is dropped.
fn awaited(entry: &Value) -> Option<Value> {
    let entry = entry.as_object()?;
    // Served in the order the record declares them, so a reader of the wire meets
    // the entry the way the producer's own contract spells it.
    let mut waited = Map::new();
    for key in ["dep", "identity", "target", "style", "action"] {
        if let Some(value) = non_empty(entry.get(key).and_then(Value::as_str)) {
            waited.insert(key.to_owned(), json!(value));
        }
    }
    // The one string here that is not free text: `since` is when the wait began,
    // the wire types it as an instant, and a client that types it refuses the
    // whole timeline over one entry a producer wrote a word into. So it is served
    // only where it parses as one, and a wait whose start this crate cannot read
    // is served without it rather than with something no reader can plot.
    if let Some(since) = non_empty(entry.get("since").and_then(Value::as_str))
        .filter(|since| millis_of(since).is_some())
    {
        waited.insert("since".into(), json!(since));
    }
    if let Some(seconds) = entry.get("waited_seconds").and_then(Value::as_u64) {
        waited.insert("waited_seconds".into(), json!(seconds));
    }
    if let Some(answer) = non_empty(entry.get("last_answer").and_then(Value::as_str)) {
        waited.insert("last_answer".into(), json!(answer));
    }
    waited.contains_key("dep").then(|| Value::Object(waited))
}

/// One `{identity, target, version}` an adoption wrote, or `None` when the entry
/// names no version — which is an entry a reader could not go and look up.
fn released_version(entry: &Value) -> Option<Value> {
    let entry = entry.as_object()?;
    let field = |key: &str| non_empty(entry.get(key).and_then(Value::as_str));
    Some(json!({
        "identity": field("identity")?,
        "target": field("target")?,
        "version": field("version")?,
    }))
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
    // What one release record said about itself. A node held on a release, the
    // person who ended that wait, the release arriving and the versions being
    // adopted are four different facts, and without the record's own fields a
    // reader meets four rows that differ only in the word at the front.
    if let Some(release) = release_facts(event) {
        item.insert("release".into(), release);
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
        if let Some(role) = relayed
            .first()
            .and_then(|(_, event)| event_agent_role(event))
        {
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

/// One recorded moment: the epoch milliseconds a reading orders by, and the stamp
/// the wire is served.
#[derive(Clone)]
struct Moment {
    at: i128,
    ts: String,
}

impl Moment {
    /// The moment one record was written, or `None` for a stamp this crate cannot
    /// order — which is a record it must not draw a span from.
    fn of(event: &Envelope) -> Option<Self> {
        moment_at(&event.ts)
    }
}

/// One stamp as a moment, or `None` where it cannot be ordered.
///
/// From a string rather than an envelope, because a report's `SessionLink` rows
/// are bounds no record carries and a span is drawn over them all the same.
fn moment_at(ts: &str) -> Option<Moment> {
    millis_of(ts).map(|at| Moment {
        at,
        ts: ts.to_owned(),
    })
}

/// Whether one record is a session's own.
///
/// A session id is `{stream}.{member}`, so the records that spell it are its own
/// — which is the one join this contract allows, because `oneagentgraph` stamps
/// no `session` label on the records that open and close a member.
fn belongs_to(event: &Envelope, session: &str) -> bool {
    event
        .labels
        .extra
        .get(graph::MEMBER)
        .and_then(Value::as_str)
        .is_some_and(|member| format!("{}.{member}", event.stream) == session)
}

fn ordered(events: &[(usize, &Envelope)], matching: &dyn Fn(&Envelope) -> bool) -> Vec<Moment> {
    let mut found: Vec<Moment> = events
        .iter()
        .filter(|(_, event)| matching(event))
        .filter_map(|(_, event)| Moment::of(event))
        .collect();
    found.sort_by_key(|moment| moment.at);
    found
}

fn dispatches(events: &[(usize, &Envelope)]) -> Vec<Moment> {
    ordered(events, &|event| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeDispatched)
    })
}

/// Where the run said one session began, and where it said nothing, where the
/// session first spoke.
fn session_appeared(
    events: &[(usize, &Envelope)],
    session: &str,
    relayed: &[(usize, &Envelope)],
) -> Option<Moment> {
    ordered(events, &|event| {
        event.source == Source::Agentgraph
            && event.kind.0 == graph::MEMBER_STARTED
            && belongs_to(event, session)
    })
    .into_iter()
    .next()
    .or_else(|| {
        relayed
            .iter()
            .filter_map(|(_, event)| Moment::of(event))
            .min_by_key(|moment| moment.at)
    })
}

/// The attempt at a node that ran a session appearing at one moment: the latest
/// `node-dispatched` at or before it, or the node's first where the session
/// appeared before any of them.
fn attempt_of<'a>(dispatched: &'a [Moment], appeared: Option<&Moment>) -> Option<&'a Moment> {
    appeared
        .and_then(|appeared| {
            dispatched
                .iter()
                .rev()
                .find(|moment| moment.at <= appeared.at)
        })
        .or_else(|| dispatched.first())
}

/// When one dispatched session ran, inside the attempt of its node that ran it.
///
/// `src/AGENTS.md` states the bracketing rule and why a node's own window cannot
/// stand in for it. Nothing here may close a session before the last thing it
/// said, and one nothing has ended yet is returned open.
fn session_interval(
    events: &[(usize, &Envelope)],
    session: &str,
    relayed: &[(usize, &Envelope)],
) -> (Moment, Option<Moment>) {
    let dispatched = dispatches(events);
    let appeared = session_appeared(events, session, relayed);
    let started = attempt_of(&dispatched, appeared.as_ref())
        // Never after the session's own first word: a node that relayed
        // something before it was ever dispatched has no attempt to hand this
        // one, and a span that does not contain its own events is one no pointer
        // into it can reach.
        .filter(|dispatch| {
            appeared
                .as_ref()
                .is_none_or(|appeared| dispatch.at <= appeared.at)
        })
        .or(appeared.as_ref())
        .cloned()
        .or_else(|| relayed.first().and_then(|(_, event)| Moment::of(event)))
        .unwrap_or_else(|| Moment {
            at: 0,
            ts: now_rfc3339(),
        });
    // The last thing the session said, which nothing may close it before: a
    // session that spoke again after a record that would have ended it outlived
    // that record, and a span that does not contain its own events is one no
    // pointer into it can reach.
    let last_said = relayed
        .iter()
        .filter_map(|(_, event)| millis_of(&event.ts))
        .max()
        .unwrap_or(started.at);
    let after = |moments: Vec<Moment>| {
        moments
            .into_iter()
            .find(|moment| moment.at > started.at && moment.at >= last_said)
    };
    let ended = [
        after(dispatched),
        after(ordered(events, &|event| {
            event.source == Source::Pipeline
                && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
        })),
        after(ordered(events, &|event| {
            event.source == Source::Vcs && event.kind.0 == vcs::SESSION_CLOSED
        })),
        after(ordered(events, &|event| {
            event.source == Source::Agentgraph
                && [graph::MEMBER_SETTLED, graph::MEMBER_DIED].contains(&event.kind.0.as_str())
                && belongs_to(event, session)
        })),
    ]
    .into_iter()
    .flatten()
    .min_by_key(|moment| moment.at);
    (started, ended)
}

/// The branch a node opened and what became of it, from the records `onevcs`
/// relayed for it.
///
/// Both ends are relayed records, so the interval is recorded rather than
/// derived. A node that did no publication work contributes none, and one
/// nothing closed is served open-ended. It opens at publication work rather than
/// at the worktree the dispatch was cut into — see [`vcs::SILENT_ON_PUBLICATION`]
/// and `src/AGENTS.md`.
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
    let opened = events
        .iter()
        .find(|(_, event)| {
            event.source == Source::Vcs
                && !vcs::SILENT_ON_PUBLICATION.contains(&event.kind.0.as_str())
        })
        .map(|(_, event)| *event)?;
    let merged = last_relayed(&[vcs::CHANGE_MERGED, vcs::MERGE_COMPLETED]);
    let conflicted = last_relayed(&[vcs::SYNC_CONFLICT]);
    let change = last_relayed(&[vcs::CHANGE_MERGED, vcs::CHANGE_OPENED]);
    // What closed the publication, in the order those records mean: a merge ends
    // it, a conflict ends it without one, a change left open ends the run's part
    // in it, and the worktree going away ends it whatever became of the branch —
    // last, because it says only that nothing more can happen on it. Nothing
    // closing it is an in-flight publication, not an error.
    let closed = merged
        .or(conflicted)
        .or(change)
        .or_else(|| last_relayed(&[vcs::SESSION_CLOSED]));
    let branch = relayed(&[vcs::SESSION_OPENED])
        .unwrap_or(opened)
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
    // What became of the branch, and served only where a record said: a
    // publication whose worktree simply went away is over without the run having
    // ruled on it, and a status invented for that would be this crate answering
    // a question nothing asked.
    if let Some(status) = merged
        .map(|_| "merged")
        .or_else(|| conflicted.map(|_| "conflict"))
        .or_else(|| change.map(|_| "open"))
    {
        span.insert("status".into(), json!(status));
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
    // The *last* settlement, for the same reason [`node_span`] takes it: a node
    // the planner retried settles more than once, and a category still running
    // under the attempt in flight is not closed by the record that closed the
    // attempt it superseded.
    let settled = events.iter().rev().find(|(_, event)| {
        event.source == Source::Pipeline
            && PipelineKind::from_wire(&event.kind) == Some(PipelineKind::NodeSettled)
    });
    let mut counted: Vec<Category> = Vec::new();
    for (session, relayed) in relayed_sessions(events) {
        let Some(role) = relayed
            .first()
            .and_then(|(_, event)| event_agent_role(event))
            .or_else(|| event_agent_role(start))
        else {
            continue;
        };
        let pair = (
            relayed_transport_role(relayed.iter().map(|(_, e)| *e)),
            role,
        );
        // A category runs for as long as the sessions in it did, and not for as
        // long as the node that ran them: a drafting turn inside a node that
        // worked for four hours took a minute, and a lane drawn over the node's
        // window says the drafting was what the node was doing all along.
        let (began, over) = session_interval(events, session, &relayed);
        match counted.iter_mut().find(|category| category.pair == pair) {
            Some(category) => category.fold(began, over),
            None => counted.push(Category::of(pair, began, over)),
        }
    }
    if counted.is_empty() {
        // Dispatched and nothing relayed: still one category, because the node
        // was dispatched and the row has to say so. Nothing bounds it but the
        // node's own window, which is all the run said about it.
        if let Some(role) = event_agent_role(start) {
            counted.extend(Moment::of(start).map(|began| {
                Category::of(
                    (transport_role(start), role),
                    began,
                    settled.and_then(|(_, event)| Moment::of(event)),
                )
            }));
        }
    }
    counted
        .into_iter()
        .map(|category| {
            let (transport, role) = category.pair;
            let (started, count) = (category.started.ts.clone(), category.count);
            let ended = category.ended();
            json!({
                "id": format!("rollup.{node}.{}.{role}", transport.as_str()),
                "kind": "rollup",
                "label": "dispatch",
                "started_at": started,
                "ended_at": ended.map_or(Value::Null, |moment| json!(moment.ts)),
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

/// How far a category of sessions has got.
///
/// The two states are exclusive by construction rather than by agreement between
/// a flag and a moment: a category holding a session the run has not ended has no
/// latest end to serve, whatever the sessions beside it did. Where every session
/// ended, what [`Reach::Ended`] carries is the latest of their ends.
enum Reach {
    Ended(Moment),
    Running,
}

/// One category of a node's sessions, and the interval they ran over between
/// them: the transport-and-semantic pair that names it, the earliest start
/// among them, and how far their ends have got.
struct Category {
    pair: (Party, &'static str),
    count: usize,
    started: Moment,
    reach: Reach,
}

impl Category {
    fn of(pair: (Party, &'static str), started: Moment, ended: Option<Moment>) -> Self {
        Self {
            pair,
            count: 1,
            started,
            reach: ended.map_or(Reach::Running, Reach::Ended),
        }
    }

    fn fold(&mut self, started: Moment, ended: Option<Moment>) {
        self.count += 1;
        if started.at < self.started.at {
            self.started = started;
        }
        self.reach = match (std::mem::replace(&mut self.reach, Reach::Running), ended) {
            (Reach::Running, _) | (Reach::Ended(_), None) => Reach::Running,
            (Reach::Ended(latest), Some(moment)) => Reach::Ended(if moment.at > latest.at {
                moment
            } else {
                latest
            }),
        };
    }

    fn ended(self) -> Option<Moment> {
        match self.reach {
            Reach::Ended(moment) => Some(moment),
            Reach::Running => None,
        }
    }
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
        // What this session ran over, and not what the node did: a node dispatched
        // three times ran three of these and a lifecycle node runs several in
        // sequence, so the node's window is the window of all of them and answers
        // nothing about any one. A dispatch that relayed no session is the one
        // exception — there is nothing to bracket, so the node's own window is
        // all the run said about it.
        let (began, over) = if named.is_some() {
            (
                Moment::of(start),
                (!redispatched)
                    .then(|| settled.and_then(|(_, event)| Moment::of(event)))
                    .flatten(),
            )
        } else {
            let (began, over) = session_interval(&events, session, &relayed);
            (Some(began), over)
        };
        span.insert(
            "started_at".into(),
            began.map_or_else(|| json!(start.ts), |moment| json!(moment.ts)),
        );
        span.insert(
            "ended_at".into(),
            over.map_or(Value::Null, |moment| json!(moment.ts)),
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
        if let Some(role) = relayed
            .first()
            .and_then(|(_, event)| event_agent_role(event))
            .or_else(|| event_agent_role(start))
        {
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
        let sibling = judge_span(lens.transcripts, session, &span);
        spans.push(Value::Object(span));
        // Pushed straight after the dispatch it supervised, and as its sibling
        // rather than its child: a client gathers a judge lane under the most
        // recent agent session opened in the same scope, which is exactly this
        // pairing.
        spans.extend(sibling);
    }
    spans.append(&mut inside);
    spans
}

/// The judge's lane beside one dispatch, or `None` where the report holds no
/// judge turn to draw it over.
///
/// Everything but the interval, the party and the events is the worker's span:
/// the two ran under one dispatch, at one node, in one step, and a lane that
/// disagreed about any of those would be an unrelated row beside it.
fn judge_span(
    transcripts: &Transcripts<'_>,
    session: &str,
    dispatch: &Map<String, Value>,
) -> Option<Value> {
    let report = transcripts
        .sessions
        .iter()
        .find(|folded| folded.session.as_str() == session)?
        .stored
        .as_ref()
        .map(|stored| &stored.report)?;
    let (opened, closed) = judge_interval(report)?;
    let agent_role = agent_role(Some(JUDGE_MEMBER), None)?;
    let transport = Party::named(JUDGE_MEMBER)?;
    let id = judge_session(session);
    let mut span = dispatch.clone();
    span.insert("id".into(), json!(format!("dispatch.{id}")));
    span.insert("label".into(), json!(id));
    span.insert("started_at".into(), json!(opened.ts));
    span.insert(
        "ended_at".into(),
        closed.map_or(Value::Null, |moment| json!(moment.ts)),
    );
    span.insert("transport_role".into(), json!(transport.as_str()));
    span.insert("agent_role".into(), json!(agent_role));
    span.insert(
        "reference".into(),
        json!({ "kind": "conversation", "value": id }),
    );
    span.insert("events".into(), json!(Vec::<Value>::new()));
    Some(Value::Object(span))
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
    for document in conversations_under(view, &Transcripts::of(view), filter) {
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
