//! The trait the server is built over: one method per route in
//! [`contract::routes`](crate::contract::routes).
//!
//! It is deliberately unimplemented. The implementation reads the onepipeline
//! SDK, and it lands with that dependency — this trait is what the axum router
//! and the SDK-backed store are written against, so both sides can be built
//! knowing the other's shape.
//!
//! Payloads are [`Value`] rather than typed records for the reason
//! `docs/contract.md` gives: anything presentation-worthy lands in the SDK/CLI
//! first, so the record types come from there and are not invented here. The
//! part this crate owns — the schema-version envelope — is typed.

use serde_json::Value;

use crate::contract::{
    ArtifactId, ConversationId, Envelope, EventFrame, Health, RunId, RunQuery, TimelineQuery,
};
use crate::error::ApiError;

/// The read surface `docs/contract.md` defines.
pub trait ReadApi {
    /// The frames one `GET /api/v2/events` connection serves. The first is
    /// always a fresh snapshot.
    type Events: Iterator<Item = EventFrame>;

    /// `GET /healthz` — liveness that never touches run storage.
    fn health(&self) -> Health;

    /// `GET /api/v2/runs` — the run list, with session attribution.
    fn runs(&self) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}` — one run's detail.
    fn run(&self, run: &RunId, query: &RunQuery) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/timeline` — the run's or one node's timeline.
    fn timeline(&self, run: &RunId, query: &TimelineQuery) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/conversations/{id}` — one conversation.
    fn conversation(
        &self,
        run: &RunId,
        conversation: &ConversationId,
    ) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/artifacts/{id}` — one recorded artifact.
    fn artifact(&self, run: &RunId, artifact: &ArtifactId) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/events` — a fresh snapshot, then the stream that follows it.
    fn events(&self) -> Result<Self::Events, ApiError>;
}
