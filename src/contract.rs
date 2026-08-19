//! The wire contract: route table, response envelope, identifiers, and queries.
//!
//! Every item here is named by `docs/contract.md`. `tests/contract.rs`
//! reconciles the two, so a route added to one and not the other fails the gate.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;
use crate::filter::FilterSpec;

/// The API version every path under `/api/v2` and every envelope carries.
pub const API_VERSION: u32 = 2;

/// The telemetry schema version every payload is served at.
///
/// Schema-version discipline: a payload shape change bumps this, and the
/// envelope carries it on every response so a client can refuse a version it
/// does not understand rather than mis-read it. Schema 10 was the version that
/// began carrying `dispatch_id` (see [`DispatchId`]).
///
/// **Schema 11 made every unmeasured timing absent.** Under 10 each of the eight
/// `*_seconds`, the four `*_model_ms`, `idle_orchestration_ms`,
/// `unattributed_ms`, `wall_ms` and every fraction was a required number, so a
/// lane nothing measured was served `0` and read as a measurement — a run whose
/// judge chain never reported looked like one whose judge cost nothing. Under 11
/// each of them is `null` when no record measured it, which is a breaking change
/// in the only direction that matters: a client that read a number now finds a
/// null, and one that reads 11 knows the difference between free and unknown.
///
/// **Schema 12 says, per node in flight, whether its turn can be redirected.**
/// `node_control` carries one entry for every node recorded as `running` and for
/// no other — so a planner deciding between correcting a node and cancelling it
/// reads the answer instead of assuming the expensive one. Under 11 there was no
/// entry to read and the safe reading of an absent one was "cannot", which is
/// the wrong default for every node that can.
///
/// **Schema 13 is the removal of rounds.** Execution in the onepipeline SDK is
/// continuous and dependency-driven: a node dispatches the moment its
/// dependencies settle, nothing batches them, and the deprecated `round` label
/// is stamped by nothing. So the payload's `rounds` array — with its per-round
/// `round` number, per-round plan and per-round result — is replaced by one
/// [`graph`](https://github.com/nickderobertis/onepipeline-ui/blob/main/docs/contract.md)
/// object describing the run's whole continuous state, no `round` field survives
/// anywhere in a response, and `phase` names a continuous phase rather than
/// `driving-round`. A client reading 12 must not read a 13 payload: the array it
/// indexed is gone, not renamed.
pub const TELEMETRY_SCHEMA_VERSION: u32 = 13;

/// The timeline payload's own schema version, carried beside the API's.
///
/// It moves independently of [`TELEMETRY_SCHEMA_VERSION`] because it says which
/// *meaning* of the span list this is: version 1 served the role pair only on a
/// `dispatch` span, so a client could read "carries roles" as "is a dispatch".
/// Version 2 served it on a `scope=run` rollup too, naming the category the
/// rollup summarizes, and that inference no longer held.
///
/// **Version 3 serves a rollup that is not a dispatch at all.** A `rollup` span
/// may now carry no roles and stand for the waits a node's publication spent
/// blocked on a lock, named by the kind it summarizes — so under 2 a client
/// could read every rollup as a category of dispatches, and under 3 it must read
/// the label.
///
/// **Version 4 carries the redirection a record was.** A timeline event produced
/// by a `turn-interrupted` or by an `edit-committed` that added context to a node
/// carries `redirection`, which says whether the running turn took the note and
/// why it did not. Under 3 the event was served as its kind and its stamp alone,
/// so a turn whose behaviour changed mid-flight read as a worker inexplicably
/// switching tasks.
///
/// **Version 5 is continuous.** Under 4 the top of a `scope=run` timeline was one
/// span per round, every span carried the `round` it belonged to, and every span
/// id was numbered by one. There are no rounds: the run itself is the single root
/// span, no span carries a `round`, and every id is keyed by what it identifies —
/// `node.ID`, `dispatch.SESSION`, `publication.ID` — rather than by a round that
/// does not exist. Version 5 is also where a span may be **filtered**: the events
/// a span carries are the ones `?filter=` admitted, while the span itself, its
/// bounds and its status stay what the run recorded.
pub const TIMELINE_SCHEMA_VERSION: u32 = 5;

/// The largest run-list page any request can ask for.
///
/// A bound rather than a limit anyone will meet: it exists so a crafted `limit`
/// cannot turn one request into an unbounded read of every recorded run.
pub const RUNS_PAGE_LIMIT: usize = 50;

/// The routes `docs/contract.md` defines, as axum path templates.
pub mod routes {
    /// Liveness that never touches run storage.
    pub const HEALTHZ: &str = "/healthz";
    /// The run list, with session attribution.
    pub const RUNS: &str = "/api/v2/runs";
    /// One run's detail.
    pub const RUN: &str = "/api/v2/runs/{run}";
    /// One run's timeline, at run or node scope.
    pub const RUN_TIMELINE: &str = "/api/v2/runs/{run}/timeline";
    /// One conversation of one run.
    pub const RUN_CONVERSATION: &str = "/api/v2/runs/{run}/conversations/{id}";
    /// One recorded artifact of one run.
    pub const RUN_ARTIFACT: &str = "/api/v2/runs/{run}/artifacts/{id}";
    /// The server-sent event stream; every connection opens with a fresh snapshot.
    pub const EVENTS: &str = "/api/v2/events";

    /// Every route above, in the order `docs/contract.md` lists them.
    pub const ALL: [&str; 7] = [
        HEALTHZ,
        RUNS,
        RUN,
        RUN_TIMELINE,
        RUN_CONVERSATION,
        RUN_ARTIFACT,
        EVENTS,
    ];
}

/// The response body of `GET /healthz`.
///
/// Deliberately not an [`Envelope`]: liveness must answer without reading run
/// storage, so it carries no schema version to read one from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    /// The one state a served `/healthz` can be in.
    pub status: HealthStatus,
    /// The `onepipeline` release this binary links, from that crate's own
    /// `VERSION` and never from a literal here.
    ///
    /// A host that pins the engine writing a run store and separately pins this
    /// reader of it has nothing else to prove the two are the same release, so
    /// the reader says which one it is rather than leaving it assumed.
    pub onepipeline_version: Release,
}

/// A validated release identifier: `MAJOR.MINOR.PATCH`, with the pre-release and
/// build metadata cargo allows after it.
///
/// Constructed only through [`TryFrom<&str>`], so a `Health` a client parses
/// cannot carry a release nobody could have published — the comparison a host
/// makes against it is only worth making if both sides are releases.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Release(String);

impl Release {
    /// The `onepipeline` release this binary links.
    ///
    /// The SDK's own package version, which cargo will not build without, so the
    /// check cannot fail — the same footing [`POLL_INTERVAL_MS`] is on.
    ///
    /// [`POLL_INTERVAL_MS`]: crate::store::POLL_INTERVAL_MS
    #[must_use]
    pub fn linked() -> Self {
        Self::try_from(onepipeline::VERSION).expect("the SDK's own package version is a release")
    }

    /// The release as it is served.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for Release {
    type Error = InvalidRelease;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match check_release(value) {
            Ok(()) => Ok(Self(value.to_owned())),
            Err(reason) => Err(InvalidRelease(reason)),
        }
    }
}

impl TryFrom<String> for Release {
    type Error = InvalidRelease;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_from(value.as_str())
    }
}

impl From<Release> for String {
    fn from(value: Release) -> Self {
        value.0
    }
}

/// What a string that is not a [`Release`] is refused with.
///
/// Its own type rather than an [`ApiError`] arm: no route parses one, so a
/// refusal here is not a status a client is served.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("not a release: {0}")]
pub struct InvalidRelease(String);

/// The longest release identifier this crate accepts.
const RELEASE_MAX_LEN: usize = 64;

/// Whether a string is a release, by the semantic-version grammar cargo
/// publishes under: `MAJOR.MINOR.PATCH`, each a number without a leading zero,
/// then optional `-PRE` and `+BUILD` metadata of dot-separated identifiers.
///
/// Strict rather than permissive on purpose. The point of the type is that a
/// host comparing two of these is comparing releases, and a validator that
/// admitted `01.2.3` would have this crate assert an invariant its name claims
/// and its values do not keep.
fn check_release(value: &str) -> Result<(), String> {
    if value.len() > RELEASE_MAX_LEN {
        return Err(format!("must be at most {RELEASE_MAX_LEN} characters"));
    }
    // Build metadata comes off first: it is the last part and it may itself
    // contain `-`, so a pre-release cannot be found until it is gone.
    let (rest, build) = match value.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (value, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let components: Vec<&str> = core.split('.').collect();
    if components.len() != 3 {
        return Err("must be MAJOR.MINOR.PATCH".to_owned());
    }
    if !components.iter().copied().all(is_numeric_identifier) {
        return Err(
            "every component of MAJOR.MINOR.PATCH must be a number without a leading zero"
                .to_owned(),
        );
    }
    if let Some(pre) = pre {
        for identifier in pre.split('.') {
            if !is_alphanumeric_identifier(identifier) {
                return Err(
                    "every pre-release identifier must be ASCII letters, digits or '-'".to_owned(),
                );
            }
            if identifier.chars().all(|c| c.is_ascii_digit()) && !is_numeric_identifier(identifier)
            {
                return Err(
                    "a numeric pre-release identifier must not have a leading zero".to_owned(),
                );
            }
        }
    }
    if let Some(build) = build {
        for identifier in build.split('.') {
            if !is_alphanumeric_identifier(identifier) {
                return Err(
                    "every build identifier must be ASCII letters, digits or '-'".to_owned(),
                );
            }
        }
    }
    Ok(())
}

/// A semantic-version numeric identifier: digits, and no leading zero unless the
/// whole of it is one.
fn is_numeric_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| c.is_ascii_digit())
        && (value.len() == 1 || !value.starts_with('0'))
}

/// A semantic-version metadata identifier: non-empty, ASCII letters, digits and
/// `-`. A second `+` fails here, which is what keeps `1.2.3+one+two` out.
fn is_alphanumeric_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The only status `/healthz` reports: a process that could not answer serves
/// nothing at all, so "not ok" is unrepresentable rather than unhandled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    /// The process is serving.
    Ok,
}

/// A successful response: the schema-version preamble plus the payload.
///
/// The payload is flattened, so `{"api_version": 2, ..., "runs": [...]}` is one
/// object rather than a nested envelope — the shape the existing v2 clients
/// already read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// The major API version, always [`API_VERSION`] when this crate serves it.
    // llmlint: ignore-block[invalid_states_unrepresentable] this type parses as well as serves, and a version it does not know must survive being read to be named in the refusal.
    pub api_version: u32,
    /// The payload's telemetry schema version, always [`TELEMETRY_SCHEMA_VERSION`]
    /// when this crate serves it.
    pub telemetry_schema_version: u32,
    // llmlint: ignore-end[invalid_states_unrepresentable]
    /// When the server read the state this payload describes, as RFC 3339.
    // llmlint: ignore[invalid_states_unrepresentable] a date-time type re-renders the instant, and the fixtures pin this envelope byte for byte.
    pub observed_at: String,
    /// The endpoint's own payload, sourced from the onepipeline SDK.
    #[serde(flatten)]
    pub payload: T,
}

/// A failed response. Every route serves this shape on every non-2xx status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    /// The machine-readable code and the human-readable message.
    pub error: ErrorBody,
}

/// The body of an [`ErrorEnvelope`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    /// A stable code a client can branch on, e.g. `run_not_found`.
    // llmlint: ignore[invalid_states_unrepresentable] [`ApiError`] is the enum tying a code to its status; this is the wire form, where a code a newer server introduced must survive parsing.
    pub code: String,
    /// A message safe to show a user: never a path or record contents.
    pub message: String,
}

/// The closed `event:` vocabulary `GET /api/v2/events` names its frames with.
///
/// Closed because a client dispatches on it: an event name it does not know is
/// a frame it silently drops, so a name added here has to be added there too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SseEvent {
    /// The run list, as it stands right now. The first frame of every
    /// connection, so a reconnecting client never sits on state it missed.
    #[serde(rename = "snapshot")]
    Snapshot,
    /// One run's recorded state moved; the client refetches its detail.
    #[serde(rename = "run.changed")]
    RunChanged,
    /// One watched run's transcripts moved.
    #[serde(rename = "conversation.changed")]
    ConversationChanged,
    /// A watched run reported from *inside* a turn: `oneagentgraph` publishes a
    /// bounded tool summary as the turn runs rather than when it is done, so
    /// there is something in flight to say.
    #[serde(rename = "activity.changed")]
    ActivityChanged,
    /// A run left the runs root; the client stops polling it.
    #[serde(rename = "run.removed")]
    RunRemoved,
}

impl SseEvent {
    /// The name this event is written as in an SSE `event:` line.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::RunChanged => "run.changed",
            Self::ConversationChanged => "conversation.changed",
            Self::ActivityChanged => "activity.changed",
            Self::RunRemoved => "run.removed",
        }
    }
}

/// One frame of `GET /api/v2/events`.
///
/// The first frame of every connection is a fresh snapshot, so a client that
/// reconnects never has to reconcile against state it missed. `data` is a bare
/// [`Value`] because only the snapshot carries an [`Envelope`]: an invalidation
/// names the run that moved and nothing else, so the client refetches rather
/// than reconciling a second copy of the state model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    /// The server-issued cursor, monotonically increasing from zero within a
    /// connection; a client resumes with it as `Last-Event-ID`.
    pub id: u64,
    /// Which kind of frame this is.
    pub event: SseEvent,
    /// The frame's payload.
    pub data: Value,
}

/// The query of `GET /api/v2/runs`.
///
/// `docs/contract.md` names no query on this route. These three are the paging
/// and filtering surface the copied frontend already reads, kept here so the
/// server's answer is bounded whatever a caller asks for; see AGENTS.md for the
/// amendment they are proposed under.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RunsQuery {
    /// Whether to list runs whose graph has completed. Off by default: the list
    /// is a supervision surface, and finished work is not what needs attention.
    #[serde(default)]
    pub include_settled: bool,
    /// How many rows to serve.
    #[serde(default)]
    pub limit: PageLimit,
    /// The `next_cursor` of the previous page; the list resumes after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<RunId>,
}

impl RunsQuery {
    /// The page size this query actually gets: never zero, never unbounded.
    #[must_use]
    pub fn page(&self) -> usize {
        self.limit.get()
    }
}

/// A run-list page size: never zero, never more than [`RUNS_PAGE_LIMIT`].
///
/// A bare `usize` would let a query carry a page size the server never serves,
/// leaving whoever reads `limit` next as the only thing between a caller and an
/// unbounded read. Constructed only by clamping, so the bound is the type's and
/// an out-of-range `?limit=` is still answered with a page rather than refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "usize", into = "usize")]
pub struct PageLimit(usize);

impl PageLimit {
    /// The page size a caller asking for `requested` rows actually gets.
    #[must_use]
    pub fn clamping(requested: usize) -> Self {
        Self(requested.clamp(1, RUNS_PAGE_LIMIT))
    }

    /// How many rows this page serves.
    #[must_use]
    pub fn get(self) -> usize {
        self.0
    }
}

impl Default for PageLimit {
    fn default() -> Self {
        Self(RUNS_PAGE_LIMIT)
    }
}

impl From<usize> for PageLimit {
    fn from(requested: usize) -> Self {
        Self::clamping(requested)
    }
}

impl From<PageLimit> for usize {
    fn from(limit: PageLimit) -> Self {
        limit.0
    }
}

/// The query of `GET /api/v2/events`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EventsQuery {
    /// Watch one run rather than the whole root. Only a watched run's
    /// transcripts are polled — each poll is a separate read, affordable for one
    /// detail view and not for every run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    /// Continue the cursor sequence from a frame this process already issued.
    ///
    /// It only continues the numbering: the connection still opens with a fresh
    /// snapshot, because no event history is retained to replay from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    /// Which events this connection is watching for; see [`FilterSpec`].
    ///
    /// The stream *invalidates* rather than restating state, so a filter here
    /// decides which movements are worth announcing: a run whose only new
    /// records the filter excludes has not moved as far as this connection is
    /// concerned, and its subscriber is not woken to refetch a detail that would
    /// come back unchanged. What the connection then refetches is filtered by
    /// the same spec on the detail route, which is what keeps the two agreeing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
}

/// The query of `GET /api/v2/runs/{run}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunQuery {
    /// Whether to serve the run's transcripts.
    ///
    /// Defaults to `true`. Opting out is a size lever, not a schema change: the
    /// `conversations` field stays present and required, just empty, for a
    /// client that reads the timeline instead of refetching every transcript.
    #[serde(default = "yes")]
    pub include_conversations: bool,
    /// Which events this reading carries; see [`FilterSpec`].
    ///
    /// It shapes the response and never the run: the node statuses, settlements
    /// and counts a detail carries are folded from the whole journal whatever
    /// this says, and what it narrows is the records served beside them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
}

fn yes() -> bool {
    true
}

/// The query of `GET /api/v2/runs/{run}/timeline`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineQuery {
    /// Which items to serve.
    #[serde(flatten)]
    pub scope: TimelineScope,
    /// Which events the served spans carry; see [`FilterSpec`].
    ///
    /// A span's own bounds and status are what the run recorded and are never
    /// narrowed — a filter that could hide a node from its own timeline would be
    /// a reader's attention deciding what the run did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
}

/// What a timeline request is scoped to.
///
/// `scope` selects the variant and `node` belongs to exactly one of them, so
/// `scope=node` with no node — and `scope=run` with one — are both
/// unrepresentable rather than validated after the fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum TimelineScope {
    /// `?scope=run` — the run's own items.
    Run,
    /// `?scope=node&node=ID` — one node's items.
    Node {
        /// The node whose timeline to serve.
        node: NodeId,
    },
}

/// Declare a validated identifier newtype: the path- and query-segment trust
/// boundary every route's `{...}` placeholder crosses.
macro_rules! identifier {
    ($name:ident, $what:literal, $invalid:ident) => {
        #[doc = concat!("A validated ", $what, ".")]
        ///
        /// Constructed only through [`TryFrom<&str>`], which rejects anything
        /// that is not a bare path segment — so an identifier can never carry a
        /// separator or a traversal into whatever storage the server reads.
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// The identifier as it appears in the URL.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<&str> for $name {
            type Error = ApiError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                match check_identifier(value) {
                    Ok(()) => Ok(Self(value.to_owned())),
                    Err(reason) => Err(ApiError::$invalid(reason)),
                }
            }
        }

        impl TryFrom<String> for $name {
            type Error = ApiError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::try_from(value.as_str())
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

identifier!(RunId, "run identifier", InvalidRunId);
identifier!(NodeId, "node identifier", InvalidNodeId);
identifier!(
    ConversationId,
    "conversation identifier",
    InvalidConversationId
);
identifier!(ArtifactId, "artifact identifier", InvalidArtifactId);
identifier!(DispatchId, "dispatch identifier", InvalidDispatchId);

/// The longest identifier any route accepts.
///
/// A bound rather than a limit anyone will meet: it exists so an unbounded
/// query string cannot become an unbounded allocation or log line.
const IDENTIFIER_MAX_LEN: usize = 128;

/// Why `value` is not a usable identifier, or `Ok(())` when it is.
fn check_identifier(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("must not be empty".to_owned());
    }
    if value.len() > IDENTIFIER_MAX_LEN {
        return Err(format!("must be at most {IDENTIFIER_MAX_LEN} characters"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("must use only ASCII letters, digits, '-', '_', and '.'".to_owned());
    }
    if value.starts_with('.') {
        return Err("must not start with '.'".to_owned());
    }
    Ok(())
}
