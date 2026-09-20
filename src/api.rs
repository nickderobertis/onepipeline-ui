//! The trait the server is built over: one method per route in
//! [`contract::routes`](crate::contract::routes), reads and verbs alike.
//!
//! [`RunStore`](crate::store::RunStore) is the implementation, reading the
//! onepipeline SDK; [`server`](crate::server) is the axum router written against
//! this trait, so neither side has to know the other's internals.
//!
//! Payloads are [`Value`] rather than typed records for the reason
//! `docs/contract.md` gives: anything presentation-worthy lands in the SDK/CLI
//! first, so the record types come from there and are not invented here. The
//! part this crate owns — the schema-version envelope — is typed.

use serde_json::Value;

use crate::contract::{
    ArtifactId, AttestRequest, ConversationId, Correlation, Envelope, EventFrame, EventsQuery,
    Health, NextQuery, ProjectId, RunId, RunQuery, RunsQuery, StopRequest, SurfaceRequest,
    TimelineQuery, TranscriptQuery, WatchFrame, WatchQuery,
};
use crate::error::ApiError;

/// The surface `docs/contract.md` defines: the read routes the browser view
/// was copied against, and the post-launch verbs wrapped after them.
///
/// One trait over one runs root, and one method per route. A verb that writes
/// to the run is a method that takes what the route's body and query carried,
/// already validated, and answers the engine's own result in the envelope; a
/// read answers a projection of the SDK's records. The store behind it is a
/// thin call into `onepipeline::verbs` on every one of the verbs.
pub trait RunApi {
    /// The frames one `GET /api/v2/events` connection serves. The first is
    /// always a fresh snapshot.
    ///
    /// It is an [`Iterator`] rather than a stream because every read behind it
    /// blocks on the filesystem: the server drives it on a blocking worker and
    /// forwards each frame, so one connection's scan never holds the runtime
    /// every other connection shares.
    type Events: Iterator<Item = EventFrame>;

    /// `GET /healthz` — liveness that never touches run storage.
    fn health(&self) -> Health;

    /// `GET /api/v2/runs` — the run list, with session attribution.
    fn runs(&self, query: &RunsQuery) -> Result<Envelope<Value>, ApiError>;

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
    fn events(&self, query: &EventsQuery) -> Result<Self::Events, ApiError>;

    /// The frames one `GET /api/v2/runs/{run}/watch` connection serves, on the
    /// terms [`Events`](Self::Events) states: every read behind it blocks, so
    /// the server drives it on a blocking worker. The iterator ends with the
    /// `returned` frame, and dropping it before that ends the engine's wait —
    /// and with it the watcher record the wait wrote.
    type Watch: Iterator<Item = WatchFrame>;

    /// `GET /api/v2/projects` — every run, grouped by project as `verbs::runs`
    /// groups them.
    fn projects(&self) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/projects/{project}` — one group of that listing.
    fn project(&self, project: &ProjectId) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/channel` — the run's channel, consuming nothing.
    fn channel(&self, run: &RunId) -> Result<Envelope<Value>, ApiError>;

    /// `POST /api/v2/runs/{run}/channel/next` — claim the next surface.
    fn channel_next(&self, run: &RunId, query: &NextQuery) -> Result<Envelope<Value>, ApiError>;

    /// `POST /api/v2/runs/{run}/channel/reply` — submit `envelope`, the request
    /// body byte for byte, under `correlation`.
    fn channel_reply(
        &self,
        run: &RunId,
        correlation: Option<&Correlation>,
        envelope: &str,
    ) -> Result<Envelope<Value>, ApiError>;

    /// `POST /api/v2/runs/{run}/channel/surface` — raise a surface.
    fn channel_surface(
        &self,
        run: &RunId,
        request: &SurfaceRequest,
    ) -> Result<Envelope<Value>, ApiError>;

    /// `POST /api/v2/runs/{run}/attest` — complete a ready human action.
    fn attest(&self, run: &RunId, request: &AttestRequest) -> Result<Envelope<Value>, ApiError>;

    /// `POST /api/v2/runs/{run}/stop` — end the run as the acting session.
    fn stop(&self, run: &RunId, request: &StopRequest) -> Result<Envelope<Value>, ApiError>;

    /// `POST /api/v2/runs/{run}/adopt` — retain this binary as a fresh driver.
    fn adopt(&self, run: &RunId) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/watch` — the engine's wait, as frames.
    ///
    /// Everything the engine refuses before it waits — a cursor this run cannot
    /// place, a node it does not hold — is refused here, before a frame exists.
    fn watch(&self, run: &RunId, query: &WatchQuery) -> Result<Self::Watch, ApiError>;

    /// `GET /api/v2/unwatched` — which of the acting session's runs nothing is
    /// watching.
    fn unwatched(&self) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/host` — every live dispatch on this host.
    fn host(&self) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/status` — one run's folded standing.
    fn status(&self, run: &RunId) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/results` — per-node outcomes with their evidence.
    fn results(&self, run: &RunId) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/goals` — what every run is for.
    fn goals(&self) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/goals` — what one run is for.
    fn run_goals(&self, run: &RunId) -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/transcript` — a dispatched turn's tools and
    /// reasoning, as the CLI renders it.
    fn transcript(&self, run: &RunId, query: &TranscriptQuery)
        -> Result<Envelope<Value>, ApiError>;

    /// `GET /api/v2/runs/{run}/telemetry` — the run's own telemetry document.
    fn telemetry(&self, run: &RunId) -> Result<Envelope<Value>, ApiError>;
}
