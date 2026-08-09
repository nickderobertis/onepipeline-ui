//! The axum server: `docs/contract.md`'s seven routes, and nothing else.
//!
//! Every handler is the same three steps — validate the path and query at the
//! trust boundary, ask the [`ReadApi`] for the payload, render the envelope or
//! the error contract — so a route cannot serve a status and a code that
//! disagree, and a raw `String` from a URL never reaches storage.
//!
//! Reads block: a run list walks the whole root and a detail folds a journal.
//! None of that runs on the async runtime. Each handler defers its read to a
//! blocking worker, and the event stream drives its whole (blocking, endless)
//! frame iterator on one, forwarding through a channel — so one slow scan
//! occupies a worker rather than the runtime every other connection shares.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::api::ReadApi;
use crate::contract::{
    routes, ArtifactId, ConversationId, Envelope, EventsQuery, NodeId, RunId, RunQuery, RunsQuery,
    TimelineQuery,
};
use crate::error::ApiError;
use crate::store::{RunStore, HEARTBEAT_INTERVAL};

/// How many frames the stream may buffer ahead of the client.
///
/// Small on purpose: the blocking reader parks on a full channel, so a client
/// that stopped reading stops the reads being made for it instead of queueing
/// an unbounded backlog of them in this process.
const FRAME_BUFFER: usize = 8;

/// What every handler shares: the store, and whether this process has been
/// asked to stop.
#[derive(Clone)]
struct Serving {
    store: Arc<RunStore>,
    /// Set once, when the process is asked to stop. An open event stream watches
    /// it, so a shutdown is not held open by a browser that is still subscribed.
    stopping: Arc<AtomicBool>,
}

/// The router serving one runs root, ending its streams when `stopping` is set.
fn router_stopping_on(store: RunStore, stopping: Arc<AtomicBool>) -> Router {
    Router::new()
        .route(routes::HEALTHZ, get(healthz))
        .route(routes::RUNS, get(runs))
        .route(routes::RUN, get(run))
        .route(routes::RUN_TIMELINE, get(timeline))
        .route(routes::RUN_CONVERSATION, get(conversation))
        .route(routes::RUN_ARTIFACT, get(artifact))
        .route(routes::EVENTS, get(events))
        .fallback(not_found)
        .with_state(Serving {
            store: Arc::new(store),
            stopping,
        })
}

/// Take `address`, so a caller can report the port before the accept loop
/// starts — and learn which port it was given when it asked for `:0`.
///
/// # Errors
///
/// Returns the address the bind failed on and why. Separate from [`serve`]
/// because it is the one failure a caller can act on, and acting on it means
/// saying which address was refused.
pub async fn bind(address: SocketAddr) -> Result<TcpListener, String> {
    TcpListener::bind(address)
        .await
        .map_err(|err| format!("cannot bind {address}: {err}"))
}

/// Serve `store` on an already-bound listener until the process is asked to
/// stop, then finish the requests already in flight and return.
///
/// A read surface is something a supervisor restarts, so being asked to stop is
/// the *normal* end of this process, not a failure: `SIGTERM` and `Ctrl-C` both
/// end it cleanly and it exits `0`. Killing it instead would cut a response
/// mid-body and, in a coverage build, throw away what the run measured.
///
/// # Errors
///
/// Returns why the accept loop ended when it ended for any other reason.
pub async fn serve(store: RunStore, listener: TcpListener, stop: StopSignal) -> Result<(), String> {
    let stopping = Arc::new(AtomicBool::new(false));
    let router = router_stopping_on(store, Arc::clone(&stopping));
    let shutdown = async move {
        stop.asked().await;
        stopping.store(true, Ordering::Relaxed);
    };
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|err| format!("the server stopped: {err}"))
}

/// The handlers this process stops on, installed the moment this is built.
///
/// Built *before* the server announces its address, and deliberately not inside
/// the shutdown future: a signal handler is installed when the stream is
/// created, so registering it at first poll leaves a window in which a
/// supervisor that connected on the announced address and immediately said stop
/// is answered by the default disposition — which kills the process rather than
/// letting it finish, and in a coverage build throws away what the run measured.
///
/// A supervisor sends `SIGTERM`; a terminal sends `SIGINT`. Both mean the same
/// thing here, and a server that honoured only one of them would be killed by
/// whichever it ignored. A host that will give the process neither leaves this
/// empty, and the server stays startable rather than refusing to run.
#[derive(Debug)]
pub struct StopSignal {
    #[cfg(unix)]
    signals: Vec<tokio::signal::unix::Signal>,
}

impl StopSignal {
    /// Install them. Call from inside the runtime the server will run on.
    #[must_use]
    pub fn install() -> Self {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            Self {
                signals: [SignalKind::terminate(), SignalKind::interrupt()]
                    .into_iter()
                    .filter_map(|kind| signal(kind).ok())
                    .collect(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {}
        }
    }

    /// Resolves the first time this process is asked to stop.
    async fn asked(self) {
        #[cfg(unix)]
        {
            let mut waits: Vec<_> = self.signals.into_iter().collect();
            if waits.is_empty() {
                std::future::pending::<()>().await;
                return;
            }
            let mut pending: futures_core::future::BoxFuture<'_, ()> =
                Box::pin(std::future::pending());
            for signal in &mut waits {
                let next: futures_core::future::BoxFuture<'_, ()> = Box::pin(async {
                    signal.recv().await;
                });
                let previous = pending;
                pending = Box::pin(async move {
                    tokio::select! {
                        () = previous => {}
                        () = next => {}
                    }
                });
            }
            pending.await;
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

/// The shared state every handler holds.
type Store = State<Serving>;

/// Render a failed read as the error contract, whatever produced it.
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self.envelope())).into_response()
    }
}

/// A route nothing serves. The body is still the error contract: a client
/// parsing every response the same way must not meet a framework's own 404.
async fn not_found() -> Response {
    ApiError::NoSuchRoute.into_response()
}

async fn healthz(State(serving): Store) -> Json<crate::contract::Health> {
    Json(serving.store.health())
}

/// Run one blocking read on a worker, and render whatever it produced.
async fn read<F>(work: F) -> Response
where
    F: FnOnce() -> Result<Envelope<Value>, ApiError> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(envelope)) => Json(envelope).into_response(),
        Ok(Err(error)) => error.into_response(),
        // The worker panicked. The panic itself can name a path or a record, so
        // it reaches the process's own stderr and the client gets the contract's
        // opaque read failure.
        Err(_) => ApiError::Read("unexpected read failure".to_owned()).into_response(),
    }
}

async fn runs(State(serving): Store, Query(raw): Query<HashMap<String, String>>) -> Response {
    let query = match runs_query(&raw) {
        Ok(query) => query,
        Err(error) => return error.into_response(),
    };
    read(move || serving.store.runs(&query)).await
}

async fn run(
    State(serving): Store,
    Path(run): Path<String>,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    let run = match RunId::try_from(run.as_str()) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let include_conversations = match flag(&raw, "include_conversations", true) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let query = RunQuery {
        include_conversations,
    };
    read(move || serving.store.run(&run, &query)).await
}

async fn timeline(
    State(serving): Store,
    Path(run): Path<String>,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    let run = match RunId::try_from(run.as_str()) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let query = match timeline_query(&raw) {
        Ok(query) => query,
        Err(error) => return error.into_response(),
    };
    read(move || serving.store.timeline(&run, &query)).await
}

async fn conversation(State(serving): Store, Path((run, id)): Path<(String, String)>) -> Response {
    let run = match RunId::try_from(run.as_str()) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let id = match ConversationId::try_from(id.as_str()) {
        Ok(id) => id,
        Err(error) => return error.into_response(),
    };
    read(move || serving.store.conversation(&run, &id)).await
}

async fn artifact(State(serving): Store, Path((run, id)): Path<(String, String)>) -> Response {
    let run = match RunId::try_from(run.as_str()) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let id = match ArtifactId::try_from(id.as_str()) {
        Ok(id) => id,
        Err(error) => return error.into_response(),
    };
    read(move || serving.store.artifact(&run, &id)).await
}

async fn events(
    State(serving): Store,
    headers: HeaderMap,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    let query = match events_query(&raw, &headers) {
        Ok(query) => query,
        Err(error) => return error.into_response(),
    };
    let frames = match serving.store.events(&query) {
        Ok(frames) => frames,
        Err(error) => return error.into_response(),
    };
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(FRAME_BUFFER);
    // The frame iterator blocks and would otherwise never end, so it runs on a
    // blocking worker and is given the two reasons to stop: the client went
    // away, or this process was asked to. Both are checked once a poll, which is
    // what keeps a disconnected subscriber from being read for indefinitely, and
    // a shutdown from waiting on a subscriber that is still connected.
    let closed = tx.clone();
    let stopping = Arc::clone(&serving.stopping);
    let frames = frames.stopping_when(Arc::new(move || {
        closed.is_closed() || stopping.load(Ordering::Relaxed)
    }));
    tokio::task::spawn_blocking(move || {
        for frame in frames {
            let event = Event::default()
                .id(frame.id.to_string())
                .event(frame.event.as_str())
                .data(frame.data.to_string());
            if tx.blocking_send(Ok(event)).is_err() {
                return;
            }
        }
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::new().interval(HEARTBEAT_INTERVAL))
        .into_response()
}

/// A boolean query parameter, or the contract's refusal of what was sent.
fn flag(raw: &HashMap<String, String>, name: &str, default: bool) -> Result<bool, ApiError> {
    match raw.get(name).map(String::as_str) {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(other) => Err(ApiError::InvalidRequest(format!(
            "{name} must be true or false, got {other:?}"
        ))),
    }
}

fn runs_query(raw: &HashMap<String, String>) -> Result<RunsQuery, ApiError> {
    let limit = match raw.get("limit") {
        None => crate::contract::RUNS_PAGE_LIMIT,
        Some(value) => value.parse::<usize>().map_err(|_| {
            ApiError::InvalidRequest(format!("limit must be a whole number, got {value:?}"))
        })?,
    };
    let cursor = match raw.get("cursor") {
        None => None,
        Some(value) => Some(RunId::try_from(value.as_str())?),
    };
    Ok(RunsQuery {
        include_settled: flag(raw, "include_settled", false)?,
        limit,
        cursor,
    })
}

/// `?scope=run`, or `?scope=node&node=ID`. The pair is parsed into the variant
/// it names, so `scope=node` with no node — and `scope=run` with one — are both
/// refused here rather than served as something the caller did not ask for.
fn timeline_query(raw: &HashMap<String, String>) -> Result<TimelineQuery, ApiError> {
    match (raw.get("scope").map(String::as_str), raw.get("node")) {
        (Some("run"), None) => Ok(TimelineQuery::Run),
        (Some("node"), Some(node)) => Ok(TimelineQuery::Node {
            node: NodeId::try_from(node.as_str())?,
        }),
        (Some("node"), None) => Err(ApiError::InvalidNodeId(
            "scope=node needs the node it scopes to".to_owned(),
        )),
        (Some("run"), Some(_)) => Err(ApiError::InvalidNodeId(
            "scope=run covers the whole run and takes no node".to_owned(),
        )),
        (scope, _) => Err(ApiError::InvalidRequest(format!(
            "scope must be run or node, got {:?}",
            scope.unwrap_or_default()
        ))),
    }
}

/// The stream's query, and the resume point a reconnecting browser sends.
///
/// A `Last-Event-ID` this process could not have issued — unparseable, or
/// negative — is ignored rather than refused: a crafted header must not be able
/// to stop a client reconnecting, and the connection opens with a fresh snapshot
/// either way.
fn events_query(
    raw: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<EventsQuery, ApiError> {
    let run_id = match raw.get("run_id") {
        None => None,
        Some(value) => Some(RunId::try_from(value.as_str())?),
    };
    let after = match raw.get("after") {
        Some(value) => value.parse::<u64>().ok(),
        None => headers
            .get("last-event-id")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok()),
    };
    Ok(EventsQuery { run_id, after })
}
