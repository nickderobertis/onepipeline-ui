//! The axum server: `docs/contract.md`'s routes, and nothing else — unless it
//! was started with `--ui`, in which case every path those routes do not own is
//! the browser view's ([`crate::ui`]).
//!
//! Every handler is the same three steps — validate the path, the query and
//! the body at the trust boundary, ask the [`RunApi`] for the payload, render
//! the envelope or the error contract — so a route cannot serve a status and a
//! code that disagree, and a raw `String` from a URL never reaches storage.
//! The one body that is *not* parsed here is a channel reply's: it is the
//! envelope's bytes, handed to the engine verbatim, because the engine is what
//! rules on it.
//!
//! Reads block: a run list walks the whole root and a detail folds a journal.
//! None of that runs on the async runtime. Each handler defers its read to a
//! blocking worker, and the two streams — the event stream and a watch — drive
//! their whole (blocking) frame iterators on one, forwarding through a channel
//! — so one slow scan occupies a worker rather than the runtime every other
//! connection shares. A write is a read on the same terms: the engine's verbs
//! block on the run's own files and locks.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::api::RunApi;
use crate::contract::{
    routes, ArtifactId, AttestRequest, ConversationId, Correlation, Envelope, EventsQuery,
    NextQuery, NodeId, PageLimit, ProjectId, RunId, RunQuery, RunSelection, RunsPage, RunsQuery,
    StopRequest, SurfaceRequest, TimelineQuery, TimelineScope, TranscriptQuery, WatchQuery,
};
use crate::error::ApiError;
use crate::filter::FilterSpec;
use crate::store::{RunStore, HEARTBEAT_INTERVAL};
use crate::ui::View;

/// How many frames the stream may buffer ahead of the client.
///
/// Small on purpose: the blocking reader parks on a full channel, so a client
/// that stopped reading stops the reads being made for it instead of queueing
/// an unbounded backlog of them in this process.
const FRAME_BUFFER: usize = 8;

/// What every handler shares: the store, whether this process has been asked
/// to stop, and the browser view — if it was asked to serve one.
#[derive(Clone)]
struct Serving {
    store: Arc<RunStore>,
    /// Set once, when the process is asked to stop. An open event stream watches
    /// it, so a shutdown is not held open by a browser that is still subscribed.
    stopping: Arc<AtomicBool>,
    /// What answers every path the API does not own: the view under `--ui`,
    /// and the error contract's 404 without it.
    view: Option<Arc<View>>,
}

/// The router serving one runs root, ending its streams when `stopping` is set,
/// and serving `view` at every path the contract's routes do not own.
// llmlint: ignore-block[authorization_enforced_server_side] there is no authorization to
// enforce here and no place to enforce it from. This is `docs/contract.md`'s whole surface
// over a directory of runs, with no accounts and no principal but the **one** session the
// whole server acts as — `--session`, resolved once at startup, which the engine's own
// ownership rule judges every stop and adoption by — and the CLI's `--bind` defaults to
// loopback, so an operator who exposes it wider puts whatever their host uses in front of
// it, exactly as they would in front of a shell holding `onepipeline`. Adding an
// authentication layer would be a change to the contract this crate is the Rust rendering
// of, which that document's owner decides and this repository is forbidden from editing to
// suit the code. The trust boundary this surface *does* have is validated at every handler
// above: each `{...}` a route interpolates is an identifier newtype, every query and every
// body is parsed before a run is opened, the one body that is not parsed is handed to the
// engine that rules on it, and no raw `String` reaches storage.
fn router_stopping_on(store: RunStore, stopping: Arc<AtomicBool>, view: Option<View>) -> Router {
    Router::new()
        .route(routes::HEALTHZ, get(healthz))
        .route(routes::RUNS, get(runs))
        .route(routes::RUN, get(run))
        .route(routes::RUN_TIMELINE, get(timeline))
        .route(routes::RUN_CONVERSATION, get(conversation))
        .route(routes::RUN_ARTIFACT, get(artifact))
        .route(routes::EVENTS, get(events))
        .route(routes::PROJECTS, get(projects))
        .route(routes::PROJECT, get(project))
        .route(routes::RUN_CHANNEL, get(channel))
        .route(routes::RUN_CHANNEL_NEXT, post(channel_next))
        .route(routes::RUN_CHANNEL_REPLY, post(channel_reply))
        .route(routes::RUN_CHANNEL_SURFACE, post(channel_surface))
        .route(routes::RUN_ATTEST, post(attest))
        .route(routes::RUN_STOP, post(stop))
        .route(routes::RUN_ADOPT, post(adopt))
        .route(routes::RUN_WATCH, get(watch))
        .route(routes::UNWATCHED, get(unwatched))
        .route(routes::HOST, get(host))
        .route(routes::RUN_STATUS, get(status))
        .route(routes::RUN_RESULTS, get(results))
        .route(routes::GOALS, get(goals))
        .route(routes::RUN_GOALS, get(run_goals))
        .route(routes::RUN_TRANSCRIPT, get(transcript))
        .route(routes::RUN_TELEMETRY, get(telemetry))
        .fallback(fallback)
        .with_state(Serving {
            store: Arc::new(store),
            stopping,
            view: view.map(Arc::new),
        })
}
// llmlint: ignore-end[authorization_enforced_server_side]

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
    serve_with_view(store, listener, stop, None).await
}

/// [`serve`], with the browser view served beside the API when `view` is one.
///
/// The view answers every path the contract's routes do not own — and only
/// those: the routes are matched first, and the fallback below hands the API's
/// prefixes to the error contract rather than to the view, so a request under
/// `/api` or for `/healthz` is never answered by a bundle, and a request for
/// the bundle is never answered by the API.
///
/// # Errors
///
/// As [`serve`].
pub async fn serve_with_view(
    store: RunStore,
    listener: TcpListener,
    stop: StopSignal,
    view: Option<View>,
) -> Result<(), String> {
    let stopping = Arc::new(AtomicBool::new(false));
    let router = router_stopping_on(store, Arc::clone(&stopping), view);
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
        let status = self.status();
        (status, Json(self.envelope())).into_response()
    }
}

/// A path no route serves: the browser view's, when one is being served and
/// the path is not the API's, and the contract's 404 otherwise.
///
/// The body of that 404 is still the error contract: a client parsing every
/// response the same way must not meet a framework's own — and under `--ui`
/// a client under `/api` must not meet a page.
async fn fallback(State(serving): Store, uri: Uri) -> Response {
    match &serving.view {
        Some(view) if !crate::ui::is_api_path(uri.path()) => view.answer(uri.path()).await,
        _ => ApiError::NoSuchRoute.into_response(),
    }
}

async fn healthz(State(serving): Store) -> Json<crate::contract::Health> {
    Json(serving.store.health())
}

/// Run one blocking call — a read, or a verb that writes to the run — on a
/// worker, and render whatever it produced.
async fn answer<F>(work: F) -> Response
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
    answer(move || serving.store.runs(&query)).await
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
    let filter = match filter_spec(&raw) {
        Ok(filter) => filter,
        Err(error) => return error.into_response(),
    };
    let query = RunQuery {
        include_conversations,
        filter,
    };
    answer(move || serving.store.run(&run, &query)).await
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
    answer(move || serving.store.timeline(&run, &query)).await
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
    answer(move || serving.store.conversation(&run, &id)).await
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
    answer(move || serving.store.artifact(&run, &id)).await
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
        None => PageLimit::default(),
        Some(value) => PageLimit::clamping(value.parse::<usize>().map_err(|_| {
            ApiError::InvalidRequest(format!("limit must be a whole number, got {value:?}"))
        })?),
    };
    let cursor = match raw.get("cursor") {
        None => None,
        Some(value) => Some(RunId::try_from(value.as_str())?),
    };
    // Parsed here, at the boundary, so a name that is not a usable run id and a
    // selection larger than a page are both refused before a run is opened —
    // and so no raw `String` reaches storage, on the same terms every other
    // `{...}` this server interpolates crosses.
    let Some(select) = raw.get("select") else {
        return Ok(RunsQuery::Page(RunsPage {
            include_settled: flag(raw, "include_settled", false)?,
            limit,
            cursor,
        }));
    };
    // A selection answers exactly the runs it names, so a paging parameter sent
    // beside one is a request whose two halves disagree about what was asked.
    // Refused rather than resolved: serving the selection and dropping the rest
    // would leave a caller who asked for the second page of three named runs
    // reading the first three as though that were the answer.
    let paging: Vec<&str> = ["include_settled", "limit", "cursor"]
        .into_iter()
        .filter(|name| raw.contains_key(*name))
        .collect();
    if !paging.is_empty() {
        return Err(ApiError::InvalidRequest(format!(
            "select answers the runs it names, so it takes no {}",
            paging.join(", ")
        )));
    }
    Ok(RunsQuery::Selected(RunSelection::parse(select)?))
}

/// `?scope=run`, or `?scope=node&node=ID`. The pair is parsed into the variant
/// it names, so `scope=node` with no node — and `scope=run` with one — are both
/// refused here rather than served as something the caller did not ask for.
fn timeline_query(raw: &HashMap<String, String>) -> Result<TimelineQuery, ApiError> {
    let scope = match (raw.get("scope").map(String::as_str), raw.get("node")) {
        (Some("run"), None) => TimelineScope::Run,
        (Some("node"), Some(node)) => TimelineScope::Node {
            node: NodeId::try_from(node.as_str())?,
        },
        (Some("node"), None) => {
            return Err(ApiError::InvalidNodeId(
                "scope=node needs the node it scopes to".to_owned(),
            ))
        }
        (Some("run"), Some(_)) => {
            return Err(ApiError::InvalidNodeId(
                "scope=run covers the whole run and takes no node".to_owned(),
            ))
        }
        (scope, _) => {
            return Err(ApiError::InvalidRequest(format!(
                "scope must be run or node, got {:?}",
                scope.unwrap_or_default()
            )))
        }
    };
    Ok(TimelineQuery {
        scope,
        filter: filter_spec(raw)?,
    })
}

/// `?filter=`, as either the profile it names or the spec it carries.
///
/// Parsed here, at the boundary, rather than carried to the store as the string
/// it arrived as: a malformed spec is a bad request whichever run it was sent
/// about, and refusing it before a run is opened is what keeps a crafted one from
/// reaching a read at all. Whether a *name* resolves is the run's answer, not
/// this one's, so a name is only checked for being a usable name here.
fn filter_spec(raw: &HashMap<String, String>) -> Result<Option<FilterSpec>, ApiError> {
    raw.get("filter")
        .map(|value| FilterSpec::parse(value))
        .transpose()
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
    Ok(EventsQuery {
        run_id,
        after,
        filter: filter_spec(raw)?,
    })
}

async fn projects(State(serving): Store) -> Response {
    answer(move || serving.store.projects()).await
}

async fn project(State(serving): Store, Path(project): Path<String>) -> Response {
    // The router has already percent-decoded the segment, so this is the id as
    // the engine records it, checked before anything is compared against it.
    let project = match ProjectId::try_from(project.as_str()) {
        Ok(project) => project,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.project(&project)).await
}

/// The run a verb route is about, validated.
fn run_id(run: &str) -> Result<RunId, ApiError> {
    RunId::try_from(run)
}

async fn channel(State(serving): Store, Path(run): Path<String>) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.channel(&run)).await
}

// llmlint: ignore[authorization_enforced_server_side] there is no principal to authenticate against: `docs/contract.md` fixes this surface with **one** acting session for the whole server, resolved once at startup from `--session`, and every write this handler makes is judged by the engine's own ownership rule under that session — exactly as a shell holding `onepipeline` is — with `--bind` on loopback by default and whatever the host puts in front of a wider bind. An authentication layer is a change to the contract this crate is the Rust rendering of, which its owner decides; what this handler owes is the trust boundary it keeps, validating the path and the body before the engine is asked.
async fn channel_next(
    State(serving): Store,
    Path(run): Path<String>,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let query = match filter_spec(&raw) {
        Ok(filter) => NextQuery { filter },
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.channel_next(&run, &query)).await
}

/// The envelope's bytes, verbatim: the engine parses them, so the only thing
/// checked here is that they are text at all, which is what an envelope is.
// llmlint: ignore[authorization_enforced_server_side] there is no principal to authenticate against: `docs/contract.md` fixes this surface with **one** acting session for the whole server, resolved once at startup from `--session`, and every write this handler makes is judged by the engine's own ownership rule under that session — exactly as a shell holding `onepipeline` is — with `--bind` on loopback by default and whatever the host puts in front of a wider bind. An authentication layer is a change to the contract this crate is the Rust rendering of, which its owner decides; what this handler owes is the trust boundary it keeps, validating the path and the body before the engine is asked.
async fn channel_reply(
    State(serving): Store,
    Path(run): Path<String>,
    Query(raw): Query<HashMap<String, String>>,
    body: String,
) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let correlation = match raw.get("correlation") {
        None => None,
        Some(value) => match Correlation::try_from(value.as_str()) {
            Ok(correlation) => Some(correlation),
            Err(error) => return error.into_response(),
        },
    };
    answer(move || {
        serving
            .store
            .channel_reply(&run, correlation.as_ref(), &body)
    })
    .await
}

/// A JSON body, or the contract's refusal of what was sent.
///
/// Parsed by hand rather than through axum's `Json` extractor so a body the
/// route does not accept is the error contract — a client parsing every
/// response the same way must not meet a framework's own rejection.
fn body<T: serde::de::DeserializeOwned>(what: &str, body: &str) -> Result<T, ApiError> {
    serde_json::from_str(body)
        .map_err(|error| ApiError::InvalidRequest(format!("the body is not {what}: {error}")))
}

// llmlint: ignore[authorization_enforced_server_side] there is no principal to authenticate against: `docs/contract.md` fixes this surface with **one** acting session for the whole server, resolved once at startup from `--session`, and every write this handler makes is judged by the engine's own ownership rule under that session — exactly as a shell holding `onepipeline` is — with `--bind` on loopback by default and whatever the host puts in front of a wider bind. An authentication layer is a change to the contract this crate is the Rust rendering of, which its owner decides; what this handler owes is the trust boundary it keeps, validating the path and the body before the engine is asked.
async fn channel_surface(State(serving): Store, Path(run): Path<String>, raw: String) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let request: SurfaceRequest = match body("{kind, message}", &raw) {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.channel_surface(&run, &request)).await
}

// llmlint: ignore[authorization_enforced_server_side] there is no principal to authenticate against: `docs/contract.md` fixes this surface with **one** acting session for the whole server, resolved once at startup from `--session`, and every write this handler makes is judged by the engine's own ownership rule under that session — exactly as a shell holding `onepipeline` is — with `--bind` on loopback by default and whatever the host puts in front of a wider bind. An authentication layer is a change to the contract this crate is the Rust rendering of, which its owner decides; what this handler owes is the trust boundary it keeps, validating the path and the body before the engine is asked.
async fn attest(State(serving): Store, Path(run): Path<String>, raw: String) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let request: AttestRequest = match body("{reference}", &raw) {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.attest(&run, &request)).await
}

// llmlint: ignore[authorization_enforced_server_side] there is no principal to authenticate against: `docs/contract.md` fixes this surface with **one** acting session for the whole server, resolved once at startup from `--session`, and every write this handler makes is judged by the engine's own ownership rule under that session — exactly as a shell holding `onepipeline` is — with `--bind` on loopback by default and whatever the host puts in front of a wider bind. An authentication layer is a change to the contract this crate is the Rust rendering of, which its owner decides; what this handler owes is the trust boundary it keeps, validating the path and the body before the engine is asked.
async fn stop(State(serving): Store, Path(run): Path<String>, raw: String) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    // An empty body is a stop that forces nothing, which is what the CLI's bare
    // `stop RUN` is.
    let request: StopRequest = if raw.trim().is_empty() {
        StopRequest::default()
    } else {
        match body("{force?}", &raw) {
            Ok(request) => request,
            Err(error) => return error.into_response(),
        }
    };
    answer(move || serving.store.stop(&run, &request)).await
}

// llmlint: ignore[authorization_enforced_server_side] there is no principal to authenticate against: `docs/contract.md` fixes this surface with **one** acting session for the whole server, resolved once at startup from `--session`, and every write this handler makes is judged by the engine's own ownership rule under that session — exactly as a shell holding `onepipeline` is — with `--bind` on loopback by default and whatever the host puts in front of a wider bind. An authentication layer is a change to the contract this crate is the Rust rendering of, which its owner decides; what this handler owes is the trust boundary it keeps, validating the path and the body before the engine is asked.
async fn adopt(State(serving): Store, Path(run): Path<String>) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.adopt(&run)).await
}

async fn watch(
    State(serving): Store,
    Path(run): Path<String>,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let query = match watch_query(&raw) {
        Ok(query) => query,
        Err(error) => return error.into_response(),
    };
    // The engine rules on the request before it waits, and it rules from
    // inside a blocking read of the run — so the ruling is taken on a worker,
    // and a refusal is this response rather than a frame.
    let opened = {
        let serving = serving.clone();
        tokio::task::spawn_blocking(move || serving.store.watch(&run, &query)).await
    };
    let mut frames = match opened {
        Ok(Ok(frames)) => frames,
        Ok(Err(error)) => return error.into_response(),
        Err(_) => return ApiError::Read("unexpected read failure".to_owned()).into_response(),
    };
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(FRAME_BUFFER);
    // The same two reasons to stop the event stream keeps: the client went
    // away, or this process was asked to. Dropping the frames ends the engine's
    // wait, and with it the watcher record it wrote for this connection.
    let closed = tx.clone();
    let stopping = Arc::clone(&serving.stopping);
    let stop = move || closed.is_closed() || stopping.load(Ordering::Relaxed);
    tokio::task::spawn_blocking(move || {
        while let Some(frame) = frames.next_frame_unless(&stop) {
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

/// `?until=&timeout=&tick=&filter=&cursor=`, each parsed by the engine's own
/// parser where the engine declares one.
///
/// `until` is repeatable, which a query string spells as either a repeated key
/// or a comma-separated list; axum's map keeps one value per key, so the list
/// form is the one read here and a repeated key is the last of them.
fn watch_query(raw: &HashMap<String, String>) -> Result<WatchQuery, ApiError> {
    let mut query = WatchQuery {
        filter: filter_spec(raw)?,
        cursor: raw.get("cursor").cloned(),
        ..WatchQuery::default()
    };
    if let Some(until) = raw.get("until") {
        query.until = until
            .split(',')
            .map(str::trim)
            .filter(|condition| !condition.is_empty())
            .map(|condition| {
                condition
                    .parse::<onepipeline::cli::WatchUntil>()
                    .map_err(ApiError::InvalidRequest)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if query.until.is_empty() {
            return Err(ApiError::InvalidRequest(
                "until names no condition".to_owned(),
            ));
        }
    }
    if let Some(timeout) = raw.get("timeout") {
        query.timeout = timeout
            .parse::<onepipeline::cli::WatchTimeout>()
            .map_err(ApiError::InvalidRequest)?;
    }
    if let Some(tick) = raw.get("tick") {
        let seconds = tick.parse::<u64>().map_err(|_| {
            ApiError::InvalidRequest(format!(
                "tick must be a whole number of seconds, got {tick:?}"
            ))
        })?;
        query.tick = std::time::Duration::from_secs(seconds);
    }
    if let Some(cursor) = &query.cursor {
        if cursor.is_empty() || cursor.len() > CURSOR_MAX_LEN || !cursor.is_ascii() {
            return Err(ApiError::InvalidRequest(
                "cursor is not a token an earlier watch returned".to_owned(),
            ));
        }
    }
    Ok(query)
}

/// The longest cursor a watch accepts, before the engine places it.
///
/// A bound rather than a limit anyone will meet: the token an earlier watch
/// returned is short, and an unbounded one is an unbounded refusal message.
const CURSOR_MAX_LEN: usize = 256;

async fn unwatched(State(serving): Store) -> Response {
    answer(move || serving.store.unwatched()).await
}

async fn host(State(serving): Store) -> Response {
    answer(move || serving.store.host()).await
}

async fn status(State(serving): Store, Path(run): Path<String>) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.status(&run)).await
}

async fn results(State(serving): Store, Path(run): Path<String>) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.results(&run)).await
}

async fn goals(State(serving): Store) -> Response {
    answer(move || serving.store.goals()).await
}

async fn run_goals(State(serving): Store, Path(run): Path<String>) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.run_goals(&run)).await
}

async fn transcript(
    State(serving): Store,
    Path(run): Path<String>,
    Query(raw): Query<HashMap<String, String>>,
) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    let node = match raw.get("node") {
        None => None,
        Some(node) => match NodeId::try_from(node.as_str()) {
            Ok(node) => Some(node),
            Err(error) => return error.into_response(),
        },
    };
    let query = TranscriptQuery { node };
    answer(move || serving.store.transcript(&run, &query)).await
}

async fn telemetry(State(serving): Store, Path(run): Path<String>) -> Response {
    let run = match run_id(&run) {
        Ok(run) => run,
        Err(error) => return error.into_response(),
    };
    answer(move || serving.store.telemetry(&run)).await
}
