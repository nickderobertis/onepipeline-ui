//! The error contract every route shares.
//!
//! One enum carries both halves of a failed response — the HTTP status and the
//! stable `code` in the [`ErrorEnvelope`] — so a route cannot serve a status and
//! a code that disagree. The codes are the ones the existing `/api/v2` clients
//! already branch on; the copied frontend re-points without touching them.

use axum::http::StatusCode;
use thiserror::Error;

use crate::contract::{ArtifactId, ConversationId, ErrorBody, ErrorEnvelope, RunId};

/// A failure of a read route.
///
/// Every message here is safe to serve: it names what was wrong with the
/// request, never a filesystem path or the contents of a record.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ApiError {
    /// The path names no route this server serves.
    ///
    /// A route rather than a record: a client parsing every response the same
    /// way must not meet a framework's own 404 body when it mistypes a path.
    #[error("no such route")]
    NoSuchRoute,
    /// A query parameter is not one this route accepts.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    /// The run identifier in the path is not a usable one.
    #[error("invalid run id: {0}")]
    InvalidRunId(String),
    /// The node identifier in the timeline query is not a usable one.
    #[error("invalid node id: {0}")]
    InvalidNodeId(String),
    /// The conversation identifier in the path is not a usable one.
    #[error("invalid conversation id: {0}")]
    InvalidConversationId(String),
    /// The artifact identifier in the path is not a usable one.
    #[error("invalid artifact id: {0}")]
    InvalidArtifactId(String),
    /// A payload carried a `dispatch_id` that is not a usable identifier.
    #[error("invalid dispatch id: {0}")]
    InvalidDispatchId(String),
    /// `?filter=` named a profile the run being read does not have.
    ///
    /// Separate from [`InvalidRequest`](Self::InvalidRequest) because it is not
    /// a malformed request: the name is a usable one and the spec is well
    /// formed, and whether it resolves depends on the run. A reader who asked
    /// one run for a profile its launch config defined and then asked another
    /// has to be able to tell that from a typo.
    #[error("no such filter profile: {0}")]
    UnknownFilterProfile(String),
    /// No run is recorded under that identifier.
    #[error("no recorded run {0}")]
    RunNotFound(RunId),
    /// The run has no conversation under that identifier.
    #[error("no recorded conversation {0}")]
    ConversationNotFound(ConversationId),
    /// The run has no artifact under that identifier.
    #[error("no recorded artifact {0}")]
    ArtifactNotFound(ArtifactId),
    /// The run's recorded state could not be projected into a payload.
    #[error("projection failed: {0}")]
    ProjectionFailed(String),
    /// Run storage could not be read.
    #[error("read failed: {0}")]
    Read(String),
}

impl ApiError {
    /// The stable code a client branches on.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoSuchRoute => "no_such_route",
            Self::InvalidRequest(_) => "invalid_request",
            Self::InvalidRunId(_) => "invalid_run_id",
            Self::InvalidNodeId(_) => "invalid_node_id",
            Self::InvalidConversationId(_) => "invalid_conversation_id",
            Self::InvalidArtifactId(_) => "invalid_artifact_id",
            Self::InvalidDispatchId(_) => "invalid_dispatch_id",
            Self::UnknownFilterProfile(_) => "unknown_filter_profile",
            Self::RunNotFound(_) => "run_not_found",
            Self::ConversationNotFound(_) => "conversation_not_found",
            Self::ArtifactNotFound(_) => "artifact_not_found",
            Self::ProjectionFailed(_) => "projection_error",
            Self::Read(_) => "read_error",
        }
    }

    /// The HTTP status this failure is served with.
    ///
    /// The status type rather than a number: every arm here is a status that
    /// exists, and a route rebuilding one from an integer would have to decide
    /// what to do when it did not — a branch nothing can reach and nothing can
    /// test.
    #[must_use]
    pub fn status(&self) -> StatusCode {
        match self {
            Self::InvalidRequest(_)
            | Self::InvalidRunId(_)
            | Self::InvalidNodeId(_)
            | Self::InvalidConversationId(_)
            | Self::InvalidArtifactId(_)
            | Self::InvalidDispatchId(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::NoSuchRoute
            | Self::RunNotFound(_)
            | Self::ConversationNotFound(_)
            | Self::ArtifactNotFound(_)
            | Self::UnknownFilterProfile(_) => StatusCode::NOT_FOUND,
            Self::ProjectionFailed(_) => StatusCode::CONFLICT,
            Self::Read(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// The body this failure is served as.
    #[must_use]
    pub fn envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            error: ErrorBody {
                code: self.code().to_owned(),
                message: self.to_string(),
            },
        }
    }
}
