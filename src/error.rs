//! The error contract every route shares.
//!
//! One enum carries both halves of a failed response — the HTTP status and the
//! stable `code` in the [`ErrorEnvelope`] — so a route cannot serve a status and
//! a code that disagree. The codes are the ones the existing `/api/v2` clients
//! already branch on; the copied frontend re-points without touching them.

use thiserror::Error;

use crate::contract::{ArtifactId, ConversationId, ErrorBody, ErrorEnvelope, RunId};

/// A failure of a read route.
///
/// Every message here is safe to serve: it names what was wrong with the
/// request, never a filesystem path or the contents of a record.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ApiError {
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
            Self::InvalidRunId(_) => "invalid_run_id",
            Self::InvalidNodeId(_) => "invalid_node_id",
            Self::InvalidConversationId(_) => "invalid_conversation_id",
            Self::InvalidArtifactId(_) => "invalid_artifact_id",
            Self::InvalidDispatchId(_) => "invalid_dispatch_id",
            Self::RunNotFound(_) => "run_not_found",
            Self::ConversationNotFound(_) => "conversation_not_found",
            Self::ArtifactNotFound(_) => "artifact_not_found",
            Self::ProjectionFailed(_) => "projection_error",
            Self::Read(_) => "read_error",
        }
    }

    /// The HTTP status this failure is served with.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self {
            Self::InvalidRunId(_)
            | Self::InvalidNodeId(_)
            | Self::InvalidConversationId(_)
            | Self::InvalidArtifactId(_)
            | Self::InvalidDispatchId(_) => 422,
            Self::RunNotFound(_) | Self::ConversationNotFound(_) | Self::ArtifactNotFound(_) => 404,
            Self::ProjectionFailed(_) => 409,
            Self::Read(_) => 500,
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
