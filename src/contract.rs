//! The wire contract: route table, response envelope, identifiers, and queries.
//!
//! Every item here is named by `docs/contract.md`. `tests/contract.rs`
//! reconciles the two, so a route added to one and not the other fails the gate.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;

/// The API version every path under `/api/v2` and every envelope carries.
pub const API_VERSION: u32 = 2;

/// The telemetry schema version every payload is served at.
///
/// Schema-version discipline: a payload shape change bumps this, and the
/// envelope carries it on every response so a client can refuse a version it
/// does not understand rather than mis-read it. Schema 10 is the version that
/// carries `dispatch_id` (see [`DispatchId`]).
pub const TELEMETRY_SCHEMA_VERSION: u32 = 10;

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
    // llmlint: ignore[invalid_states_unrepresentable] both version fields are `u32` on purpose: this type is the *parsing* side of the schema-version discipline as well as the serving side, and a client can only refuse a version it does not understand if that version is representable long enough to be read and named in the refusal. A type admitting only the current constant would turn "server is newer than me" into an indistinguishable parse error.
    pub api_version: u32,
    /// The payload's telemetry schema version, always [`TELEMETRY_SCHEMA_VERSION`]
    /// when this crate serves it.
    pub telemetry_schema_version: u32,
    /// When the server read the state this payload describes, as RFC 3339.
    // llmlint: ignore[invalid_states_unrepresentable] a date-time type would need a dependency this interface-only crate does not carry, and — the deciding reason — it would *re-render* the instant on serialization, so a `Z` that arrived as `+00:00` would come back changed. The fixtures pin this envelope byte for byte (`tests/contract.rs`), which a re-rendering type cannot satisfy.
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
    // llmlint: ignore[invalid_states_unrepresentable] the enum tying a code to its status is [`ApiError`], and `ApiError::envelope` is the only thing in this crate that builds one. This struct is the *wire* form, which a client also parses: a code a newer server introduced has to survive being read so it can be logged, and an enum here would fail the whole response instead.
    pub code: String,
    /// A message safe to show a user: never a path or record contents.
    pub message: String,
}

/// One frame of `GET /api/v2/events`.
///
/// The first frame of every connection is a fresh snapshot, so a client that
/// reconnects never has to reconcile against state it missed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    /// The server-issued cursor, monotonically increasing from zero within a
    /// connection; a client resumes with it as `Last-Event-ID`.
    pub id: u64,
    /// The frame's payload, carrying the same envelope every read route serves.
    pub data: Envelope<Value>,
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
}

fn yes() -> bool {
    true
}

/// The query of `GET /api/v2/runs/{run}/timeline`.
///
/// `scope` selects the variant and `node` belongs to exactly one of them, so
/// `scope=node` with no node — and `scope=run` with one — are both
/// unrepresentable rather than validated after the fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum TimelineQuery {
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
