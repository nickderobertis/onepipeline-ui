//! The SDK-backed read store: [`ReadApi`] over one runs root.
//!
//! **Every read is proportional to what was asked for, and this module is where
//! that is decided.** The SDK offers two readings of a run and they cost
//! different things: [`RunView`] opens the launch record and folds the run's
//! whole merged event store into memory, and [`RunSummary`] is one fixed-size
//! document per run kept current by whatever appends to that run's journal. A
//! **detail** costs the first; a **listing** and an open **stream** must never.
//!
//! What that rules out, because every one of them was true here:
//!
//! - A run list that surveyed the root — every run opened and folded — and then
//!   sliced a page off the result, so asking for one row cost more than asking
//!   for fifty.
//! - A route about one named run that surveyed the root to find it, so a small
//!   transcript took as long as the gigabytes beside it.
//! - A subscriber whose every poll tick re-surveyed the root to compute change
//!   tokens, which is one core, continuously, per connection, emitting nothing.
//!   A tick now costs one listing of the root and one metadata lookup per run,
//!   and opens nothing until a run's journal has actually moved.
//! - A process started per served row to read that row's clock. The summary
//!   carries the run's aggregate timing, which is what the process was fetching.
//!
//! Reads take no lock the engine's single writer needs, which is what lets the
//! server run beside the engine's own reconcile loop. Nothing here writes — but
//! the SDK's summary read is a cache: a run whose document is missing or stale
//! is folded once and the fold written back beside the run, best-effort, so the
//! *next* reader of that run pays a bounded read. That is the SDK's own design
//! and the reason a store full of runs recorded by an older build is slow on its
//! first listing and cheap on every one after it.
//!
//! Filtering is resolved here, once per read: `?filter=` is matched against the
//! run being served — a built-in profile, one its launch config defined, or an
//! inline spec — and the resolved [`EventFilter`] is handed to the projection.
//! It reaches only the places events are *listed*, so a filter narrows what a
//! response carries and never what the run is: every status, settlement,
//! decision, count and timing is folded from the whole journal whatever it said.

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use onepipeline::views::{Listing, RunPaths, RunSummary, RunView, Skipped};
use serde_json::{json, Value};

use crate::api::ReadApi;
use crate::cli::RunsRoot;
use crate::contract::{
    ArtifactId, ConversationId, Envelope, EventFrame, EventsQuery, Health, HealthStatus, Release,
    RunId, RunQuery, RunSelection, RunsPage, RunsQuery, SseEvent, TimelineQuery, TimelineScope,
    API_VERSION, TELEMETRY_SCHEMA_VERSION,
};
use crate::error::ApiError;
use crate::filter::{EventFilter, FilterSpec, LaunchProfiles};
use crate::payload::{self, Scope, Signature};
use crate::telemetry::{self, RunTelemetry};

/// How often the event stream re-reads the runs root, in milliseconds.
pub const POLL_INTERVAL_MS: NonZeroU64 = NonZeroU64::new(500).expect("500 is not zero");

/// How many run-root polls pass between two transcript polls.
///
/// Transcripts are re-read a tenth as often on purpose: that read walks every
/// relayed envelope of the run, which is affordable per detail view and not per
/// tick of the runs root.
pub const CONVERSATION_POLLS_PER_RUN_POLL: u32 = 10;

/// How long the stream may go silent before the server writes a comment to
/// prove it is still there. Without it an idle connection is indistinguishable
/// from a dead one to every proxy between the browser and this process. The
/// comment is the server's, not a frame: a client must never have to decide
/// whether a payload it cannot read was a keep-alive.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// A read-only view of one runs root.
#[derive(Debug, Clone)]
pub struct RunStore {
    root: PathBuf,
    poll: Duration,
    conversation_poll: Duration,
    aggregated: Aggregated,
}

/// The sibling's telemetry document for each run, kept until that run moves.
///
/// Asking for it starts a process, and a run list serves fifty rows: doing that
/// per row per read would make the cheapest surface in this server the most
/// expensive one. The run's own change token is what the cached answer is held
/// against, so a document is re-read exactly when the run it describes has
/// recorded something — which is the same condition the event stream already
/// invalidates on.
type Aggregated = Arc<Mutex<HashMap<String, (Signature, Option<Arc<RunTelemetry>>)>>>;

impl RunStore {
    /// Read the runs recorded under `root`.
    #[must_use]
    pub fn new(root: &RunsRoot) -> Self {
        Self::new_polling_every(root, POLL_INTERVAL_MS)
    }

    /// The same store, re-reading the runs root every `poll_ms` milliseconds.
    ///
    /// A shorter poll is what makes a live change reach a browser sooner, at the
    /// cost of the disk the open stream keeps busy; `onepipeline-api serve
    /// --poll-interval-ms` is where an operator sets it.
    ///
    /// Milliseconds that cannot be zero rather than a bare `Duration`: a store
    /// polling every no-time spins its reader on the disk, and the flag and the
    /// config file already refuse that number. The floor belongs in the type
    /// all three go through rather than in each of them separately.
    #[must_use]
    pub fn new_polling_every(root: &RunsRoot, poll_ms: NonZeroU64) -> Self {
        let poll = Duration::from_millis(poll_ms.get());
        Self {
            root: root.as_path().to_path_buf(),
            poll,
            conversation_poll: poll * CONVERSATION_POLLS_PER_RUN_POLL,
            aggregated: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// What `onepipeline` aggregated for this run, read through its own CLI and
    /// kept until the run moves.
    ///
    /// `None` when the sibling cannot be asked, which leaves every timing the
    /// payload carries absent rather than zero. The reason is written once per
    /// run per change, to stderr beside the server's own output: a run served
    /// with no clock at all is a thing an operator has to be able to explain,
    /// and the alternative is a payload full of nulls with nothing saying why.
    ///
    /// A lock poisoned by a panicking reader is not a reason to stop serving:
    /// the cache is an optimisation, and the worst a recovered one costs is a
    /// re-read.
    fn telemetry(&self, view: &RunView) -> Option<Arc<RunTelemetry>> {
        // Keyed and asked for by the validated id, so a directory this contract
        // could not name is one no argument list is built from either — the same
        // filter the stream applies before announcing a run.
        let run = RunId::try_from(view.paths.run.as_str()).ok()?;
        // The run's own change token, unfiltered: the cached document describes
        // the run, so what invalidates it is the run moving at all.
        let token = payload::signature(view, &EventFilter::default());
        let mut cache = self
            .aggregated
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((cached, document)) = cache.get(run.as_str()) {
            if *cached == token {
                return document.clone();
            }
        }
        let document = match telemetry::of_run(&self.root, &run) {
            Ok(document) => Some(Arc::new(document)),
            Err(unavailable) => {
                eprintln!("onepipeline-api: no telemetry for {run}: {unavailable}");
                None
            }
        };
        cache.insert(run.as_str().to_owned(), (token, document.clone()));
        document
    }

    /// Where one run's state lives under this root.
    ///
    /// Joined from a **validated** run id, which is the whole of why a raw
    /// `String` never reaches here: the id is a bare name by the time it is one
    /// of these, so this join cannot leave the root.
    fn paths_of(&self, run: &RunId) -> RunPaths {
        RunPaths::under(&self.root, run.as_str())
    }

    /// One run, folded — **and nothing else opened**.
    ///
    /// Opened by name rather than searched for in a survey of the root, which is
    /// what made every route about one run cost the whole store: a transcript
    /// that is not large took a long time because the survey behind it was
    /// gigabytes. A run this build cannot read is the same answer to a caller as
    /// a run that is not there, and both are this route's not-found.
    fn view(&self, run: &RunId) -> Result<RunView, ApiError> {
        RunView::open(&self.paths_of(run)).map_err(|_| ApiError::RunNotFound(run.clone()))
    }

    /// Wrap a payload in the schema-version envelope every route serves.
    fn envelope(payload: Value) -> Envelope<Value> {
        Envelope {
            api_version: API_VERSION,
            telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
            observed_at: payload::now_rfc3339(),
            payload,
        }
    }

    /// Whether this run's graph has completed, from its bounded summary.
    ///
    /// Every node it recorded settled `done`. Under rounds this also had to ask
    /// whether the open round had closed; execution is continuous and there is no
    /// such flag — a graph whose every node is done has nothing left to
    /// dispatch, which is the whole of what completion is now.
    fn settled(summary: &RunSummary) -> bool {
        crate::liveness::graph_complete(summary)
    }

    /// The filter one request asked for, resolved against the run it is reading.
    ///
    /// A request naming none is served everything, which is what an unfiltered
    /// read has always been. A name is resolved against the run's own profiles,
    /// so `planner` and `monitor` answer for every run and a launch-defined name
    /// answers only for the run that defined it.
    fn resolve(view: &RunView, spec: Option<&FilterSpec>) -> Result<EventFilter, ApiError> {
        match spec {
            None => Ok(EventFilter::default()),
            Some(spec) => spec.resolve(&LaunchProfiles::of(&view.launch.dag_sets)),
        }
    }

    /// One row, and the bounded reads it costs.
    ///
    /// Paid **only for a run the page serves**, which is the whole of what a
    /// page size can bound: reading each run's summary and ordering the runs by
    /// what those summaries say are per run and nothing else is.
    fn row(&self, run: &RunId, summary: &RunSummary) -> Value {
        // Joined from the **validated** id rather than from the name the
        // directory happened to have, so no raw `String` read off the filesystem
        // reaches storage — the same rule every `{...}` a route interpolates
        // crosses.
        let paths = self.paths_of(run);
        // The row's clock, out of the document the summary carries rather than
        // out of a process started for this row. It still crosses this crate's
        // own telemetry boundary, so a document that does not add up leaves the
        // row's timings absent exactly as an unaskable sibling does.
        let timing = telemetry::of_aggregate(run, &summary.timing).ok();
        payload::run_row(run, summary, &paths, timing.as_ref())
    }

    /// The runs a listing can serve, and the roots it has to refuse.
    ///
    /// **A row's `run_id` is what a client turns straight back into
    /// `GET /api/v2/runs/{run}`**, so a directory whose name this contract's own
    /// boundary would reject is not a run to point a reader at — the event
    /// stream has always applied that filter before announcing one, and a list
    /// that served it anyway handed out an id the route beside it refuses.
    /// Reported rather than dropped, on the same terms every other refused root
    /// is: a run this API cannot serve is a fact about the root.
    ///
    /// No read: the summaries are already in hand, and this is a walk over their
    /// names.
    fn nameable(
        &self,
        summaries: Vec<RunSummary>,
        refused: &mut Vec<Skipped>,
    ) -> Vec<(RunId, RunSummary)> {
        let mut serving = Vec::with_capacity(summaries.len());
        for summary in summaries {
            match RunId::try_from(summary.run_id.as_str()) {
                Ok(run) => serving.push((run, summary)),
                // The directory rather than the bare name, because that is what
                // `unreadable` carries for every other refused root and a client
                // reading the two together must not have to tell them apart.
                Err(why) => refused.push(Skipped {
                    path: self.root.join(&summary.run_id),
                    reason: format!("this API cannot serve a run under that name: {why}"),
                }),
            }
        }
        serving
    }

    /// The run roots a read refused, as the reader itself worded them.
    ///
    /// Never a second wording: a refusal restated here is a second thing to keep
    /// true, and the one the SDK gives is the one an operator can act on. Absent
    /// rather than empty when nothing was refused, so a client written before
    /// this array reads exactly what it read before.
    fn unreadable(skipped: &[Skipped]) -> Option<Value> {
        (!skipped.is_empty()).then(|| {
            Value::Array(
                skipped
                    .iter()
                    .map(|root| {
                        json!({
                            "path": root.path.to_string_lossy(),
                            "reason": root.reason,
                        })
                    })
                    .collect(),
            )
        })
    }

    /// The run list as one page, with the cursor the next page resumes from.
    ///
    /// Ordered by most recent progress, newest first, because that is the order a
    /// reader arrives in: a client takes the first row as the run to open, and the
    /// run that moved last is the one an operator came to look at. Ties break on
    /// the id, so the order is total and a page boundary lands in the same place
    /// on every read. That is the SDK's own [`Listing`] order — the summary
    /// stores `last_write_at` to make it answerable without a fold — rather than
    /// a second sort taken over a survey.
    ///
    /// **What the page size bounds, exactly.** Answering "the most recently
    /// active N" needs every run's last activity, and that lives one fixed-size
    /// document per run with no root-level index above it — so the cost cannot be
    /// made independent of how many runs the root holds. What it *is* independent
    /// of is everything else: a run the page does not serve costs its summary and
    /// nothing more, and a run it does serve costs one row's worth of work.
    fn page(&self, query: &RunsPage) -> Value {
        let listing = Listing::of(&self.root);
        let mut skipped = listing.skipped;
        let summaries = self.nameable(listing.summaries, &mut skipped);
        // The cursor names the last row *served*, so resumption is positional in
        // this order rather than a comparison on the id: an id comparison would
        // skip or repeat rows the moment the order stopped being the id's.
        let resume = query.cursor.as_ref().map_or(0, |cursor| {
            summaries
                .iter()
                .position(|(run, _)| run == cursor)
                .map_or(0, |index| index + 1)
        });
        let page = query.size();
        // One more than the page, and then stop: knowing whether a further row
        // exists is the whole of what the extra one is for, and reading past it
        // is what made a page of one cost more than a page of fifty.
        let mut rows: Vec<&(RunId, RunSummary)> = Vec::new();
        for row in summaries.iter().skip(resume) {
            if !query.include_settled && Self::settled(&row.1) {
                continue;
            }
            rows.push(row);
            if rows.len() > page {
                break;
            }
        }
        // The cursor is the last row *served*, so the next page resumes after
        // it: naming the first unserved row instead would skip it, because the
        // filter above is what the cursor is compared against.
        let more = rows.len() > page;
        rows.truncate(page);
        let next = more
            .then(|| rows.last().map(|(run, _)| run.clone()))
            .flatten();
        let mut payload = serde_json::Map::new();
        payload.insert(
            "runs".into(),
            Value::Array(
                rows.into_iter()
                    .map(|(run, summary)| self.row(run, summary))
                    .collect(),
            ),
        );
        if let Some(cursor) = next {
            payload.insert("next_cursor".into(), json!(cursor));
        }
        if let Some(refused) = Self::unreadable(&skipped) {
            payload.insert("unreadable".into(), refused);
        }
        Value::Object(payload)
    }

    /// The runs a request **named**, and nothing else read.
    ///
    /// The reason this is on the run-list route rather than a route of its own:
    /// the order a row is served in is one rule, and a second route would be a
    /// second copy of it. The reason it exists at all: an invalidation frame
    /// names the run that moved, and refreshing that one row must not cost what
    /// refetching the first page costs — so the stream stays an invalidation
    /// channel rather than becoming a second, disagreeing copy of run state, and
    /// one extra round trip is the price of that property.
    ///
    /// Three rulings, each deliberate:
    ///
    /// - A named run that is **no longer there** is named on `missing` beside
    ///   the ordinary rows. Removal is a normal race rather than an error, and a
    ///   silent omission is indistinguishable from a server with nothing to say.
    /// - **No cursor.** It answers exactly the runs named, and the count is
    ///   bounded where the selection is parsed.
    /// - **The settled filter is not applied.** A caller that names a run wants
    ///   that run, and a settled row that cannot be refreshed reads as a stale
    ///   view.
    ///
    /// The runs root is never listed: each name is joined to it and opened, so a
    /// selection of one against a store of hundreds touches one run.
    fn selected(&self, selection: &RunSelection) -> Value {
        let mut summaries: Vec<(RunId, RunSummary)> = Vec::new();
        let mut missing: Vec<&RunId> = Vec::new();
        let mut skipped: Vec<Skipped> = Vec::new();
        for run in selection.named() {
            let paths = self.paths_of(run);
            match RunSummary::of(&paths) {
                Ok(summary) => summaries.push((run.clone(), summary)),
                // A run that is not there, and a run that is there and will not
                // read, are two different facts to the caller: the first is the
                // race a refresh loses, the second is a run this host is failing
                // to serve. They are reported apart for that reason.
                Err(refusal) => {
                    if paths.exists() {
                        skipped.push(Skipped {
                            path: paths.dir,
                            reason: refusal.to_string(),
                        });
                    } else {
                        missing.push(run);
                    }
                }
            }
        }
        // The same order a page is served in, so a client folding a refreshed row
        // back into its list never has to re-sort by a second rule.
        summaries.sort_by(|(left_run, left), (right_run, right)| {
            right
                .last_write_at
                .cmp(&left.last_write_at)
                .then_with(|| left_run.cmp(right_run))
        });
        let mut payload = serde_json::Map::new();
        payload.insert(
            "runs".into(),
            Value::Array(
                summaries
                    .iter()
                    .map(|(run, summary)| self.row(run, summary))
                    .collect(),
            ),
        );
        if !missing.is_empty() {
            payload.insert(
                "missing".into(),
                Value::Array(missing.into_iter().map(|run| json!(run)).collect()),
            );
        }
        if let Some(refused) = Self::unreadable(&skipped) {
            payload.insert("unreadable".into(), refused);
        }
        Value::Object(payload)
    }

    /// The run list one request asked for: the runs it named, or a page of them.
    fn run_list(&self, query: &RunsQuery) -> Value {
        match query {
            RunsQuery::Selected(selection) => self.selected(selection),
            RunsQuery::Page(page) => self.page(page),
        }
    }
}

impl ReadApi for RunStore {
    type Events = Frames;

    fn health(&self) -> Health {
        Health {
            status: HealthStatus::Ok,
            onepipeline_version: Release::linked(),
        }
    }

    fn runs(&self, query: &RunsQuery) -> Result<Envelope<Value>, ApiError> {
        Ok(Self::envelope(self.run_list(query)))
    }

    fn run(&self, run: &RunId, query: &RunQuery) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        let filter = Self::resolve(&view, query.filter.as_ref())?;
        // The telemetry document describes the run, not the reading of it: a
        // reader narrowing their attention must not be told the run spent less
        // time than it did.
        let aggregated = self.telemetry(&view);
        Ok(Self::envelope(payload::run_detail(
            &view,
            query.include_conversations,
            aggregated.as_deref(),
            &filter,
        )))
    }

    fn timeline(&self, run: &RunId, query: &TimelineQuery) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        let filter = Self::resolve(&view, query.filter.as_ref())?;
        let scope = match &query.scope {
            TimelineScope::Run => Scope::Run,
            TimelineScope::Node { node } => Scope::Node(node),
        };
        Ok(Self::envelope(payload::timeline(&view, &scope, &filter)))
    }

    fn conversation(
        &self,
        run: &RunId,
        conversation: &ConversationId,
    ) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        payload::conversation(&view, conversation)
            .map(Self::envelope)
            .ok_or_else(|| ApiError::ConversationNotFound(conversation.clone()))
    }

    fn artifact(&self, run: &RunId, artifact: &ArtifactId) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        payload::artifact(&view, artifact)
            .map(Self::envelope)
            .ok_or_else(|| ApiError::ArtifactNotFound(artifact.clone()))
    }

    fn events(&self, query: &EventsQuery) -> Result<Self::Events, ApiError> {
        Ok(Frames::open(self.clone(), query))
    }
}

/// One run's **cheap** change stamp: what the journal's own metadata says, with
/// no byte of it read.
///
/// The pair the SDK holds its own summary document fresh against, and for the
/// reasons it gives: the journal is append-only, so a length that moved is a
/// record nothing has seen — and a store rewritten to the same size, healed of a
/// torn tail or edited by hand, is one whose modification time moved. A single
/// metadata lookup answers both, which is the whole cost of a tick on which
/// nothing changed.
///
/// Named fields rather than a pair of numbers: both are `u64` and both come off
/// one `metadata` call, so a tuple is two values one edit could swap — and a
/// stamp comparing a length against an instant matches nothing and wakes every
/// subscriber on every tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    /// How long the journal is.
    len: u64,
    /// When it was last written, in milliseconds since the epoch.
    modified_ms: u64,
}

/// What one journal's metadata says right now, or `None` where there is no
/// journal to describe.
///
/// `None` is what makes a directory entry *not a run* to this stream: a plain
/// file beside the runs never claimed to be one, and a run swept between the
/// listing and the look is not a root to make a claim about. A run whose store
/// this build cannot stat is on those same terms — it is announced once it has
/// a journal, and the snapshot every connection opens with is what carries it
/// until then.
fn stamp_of(journal: &std::path::Path) -> Option<Stamp> {
    let about = std::fs::metadata(journal).ok()?;
    let modified_ms = about
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        });
    Some(Stamp {
        len: about.len(),
        modified_ms,
    })
}

/// One run as an open connection is tracking it.
struct Watched {
    /// The run, as a client would refetch it.
    run: RunId,
    /// What its journal's metadata said at the last tick.
    stamp: Stamp,
    /// The change token over the records this connection **admitted**, for a
    /// connection whose filter can narrow something.
    ///
    /// `None` for every other connection, which needs none: a filter that
    /// admits everything moves exactly when the journal does, so the stamp above
    /// is the whole answer and no run is ever opened to compute one.
    signature: Option<Signature>,
}

/// One connection's frames: a fresh snapshot, then the invalidations that follow
/// it, forever, until the consumer stops pulling.
///
/// It *invalidates* rather than restating state: a frame names the run that
/// moved and the client refetches its detail, so the stream can never become a
/// second, disagreeing copy of the state model. Every connection opens with a
/// snapshot even when it carries a resume cursor — this process retains no
/// history to replay, so a snapshot is the only thing that stops a reconnecting
/// client silently sitting on stale state.
pub struct Frames {
    store: RunStore,
    stop: Arc<dyn Fn() -> bool + Send + Sync>,
    watched: Option<RunId>,
    /// What this connection is watching for, unresolved: a profile resolves
    /// against a run, and this stream may be watching every run in the root.
    spec: Option<FilterSpec>,
    cursor: u64,
    opened: bool,
    baseline: Vec<Watched>,
    transcripts: Option<String>,
    activity: Option<Vec<Value>>,
    pending: std::collections::VecDeque<(SseEvent, Value)>,
    since_conversation_poll: Duration,
}

impl Frames {
    fn open(store: RunStore, query: &EventsQuery) -> Self {
        Self {
            store,
            // Nothing to stop for by default: a consumer that wants the frames
            // to end says so, and one that never does gets the endless stream
            // the route promises.
            stop: Arc::new(|| false),
            watched: query.run_id.clone(),
            spec: query.filter.clone(),
            cursor: query.after.unwrap_or(0),
            opened: false,
            baseline: Vec::new(),
            transcripts: None,
            activity: None,
            pending: std::collections::VecDeque::new(),
            since_conversation_poll: Duration::ZERO,
        }
    }

    /// One run's signature as this connection sees it.
    ///
    /// A filtered connection is asking about the events it admitted, so a run
    /// whose only new records this connection excluded has not moved as far as
    /// this subscriber is concerned and is not announced. A filter this run has
    /// no profile for narrows nothing rather than failing the stream: the frames
    /// are an invalidation, and the refusal a reader can act on is the one the
    /// detail route serves when they refetch.
    fn signature_of(&self, view: &RunView) -> Signature {
        payload::signature(view, &self.filter_for(view))
    }

    /// This connection's filter, resolved against one run.
    ///
    /// A filter that run has no profile for narrows nothing rather than failing
    /// the stream: the frames are an invalidation, and the refusal a reader can
    /// act on is the one the detail route serves when they refetch.
    fn filter_for(&self, view: &RunView) -> EventFilter {
        self.spec
            .as_ref()
            .and_then(|spec| RunStore::resolve(view, Some(spec)).ok())
            .unwrap_or_default()
    }

    /// End the stream the moment `stop` says to.
    ///
    /// Checked once per poll rather than once per frame, because the loop parks
    /// between polls: without it a connection nobody is reading would keep
    /// re-reading the runs root until something changed, and a process asked to
    /// stop would wait for a change that may never come.
    #[must_use]
    pub fn stopping_when(mut self, stop: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.stop = stop;
        self
    }

    /// Whether this connection's filter can narrow anything at all.
    ///
    /// The question that decides what a tick costs. A connection that narrows
    /// nothing — every unfiltered one, and every one on the browser's
    /// **Detailed activity** setting — is answered entirely by the journals'
    /// metadata and opens no run at any point. One that can narrow something has
    /// to look at what arrived, and pays that for **the runs that moved** rather
    /// than for the root.
    fn narrows(&self) -> bool {
        self.spec
            .as_ref()
            .is_some_and(|spec| !spec.admits_everything_for_every_run())
    }

    /// The runs this connection watches, and their journals' change stamps.
    ///
    /// **One listing of the runs root, and one metadata lookup per run.** No
    /// open, no read, no second lookup and no process — which is what makes a
    /// tick on which nothing changed free, and what a subscriber used to spend a
    /// core on: this was a survey of the whole root, twice a second, per
    /// connection, to compute tokens that were nearly always the same ones.
    ///
    /// The listing is what lets a run that **appeared** since the last tick be
    /// noticed, and a run that went away be missed — so neither needs the run
    /// set the opening snapshot saw.
    ///
    /// Keyed by [`RunId`] rather than by the directory name: every frame below
    /// hands this back as the `run_id` a client refetches the run with, so a
    /// directory the contract's own boundary would refuse is one this stream
    /// must not announce as a run to go and read.
    fn stamps(&self) -> Vec<(RunId, Stamp)> {
        let Ok(entries) = std::fs::read_dir(&self.store.root) else {
            return Vec::new();
        };
        let mut watching: Vec<(RunId, Stamp)> = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(run) = RunId::try_from(name.as_str()) else {
                continue;
            };
            if self.watched.as_ref().is_some_and(|watched| *watched != run) {
                continue;
            }
            let paths = RunPaths::under(&self.store.root, &name);
            if let Some(stamp) = stamp_of(&paths.journal()) {
                watching.push((run, stamp));
            }
        }
        watching.sort_by(|left, right| left.0.cmp(&right.0));
        watching
    }

    /// One run's change token over the records this connection admitted.
    ///
    /// The fuller read, paid for **one run that moved** rather than for the
    /// root. `None` for a run this build cannot open, which is not a run this
    /// connection can say anything about.
    fn signature_of_run(&self, run: &RunId) -> Option<Signature> {
        let view = self.store.view(run).ok()?;
        Some(self.signature_of(&view))
    }

    /// What this connection knows about the runs it watches, at the moment it
    /// opens.
    ///
    /// Stamps alone for a connection that narrows nothing, which is the same
    /// cost as every tick after it. A connection that **can** narrow reads each
    /// run once here, and that read is the whole of what such a subscription
    /// costs beyond an unfiltered one: with nothing to compare the admitted
    /// records against, the first movement of every run would announce — and a
    /// reader who narrowed their attention would be woken by exactly the records
    /// they excluded.
    fn opening_baseline(&self) -> Vec<Watched> {
        let narrows = self.narrows();
        self.stamps()
            .into_iter()
            .map(|(run, stamp)| {
                let signature = narrows.then(|| self.signature_of_run(&run)).flatten();
                Watched {
                    run,
                    stamp,
                    signature,
                }
            })
            .collect()
    }

    /// The watched run's transcript digest, or `None` when nothing is watched.
    ///
    /// Under this connection's own filter, so it is a digest of the transcripts
    /// this reader would be served rather than of every one the run holds.
    fn transcript_digest(&self) -> Option<String> {
        let watched = self.watched.as_ref()?;
        let view = self.store.view(watched).ok()?;
        Some(payload::conversation_signature(
            &view,
            &self.filter_for(&view),
        ))
    }

    /// What the watched run's nodes were last reported doing from inside a turn.
    ///
    /// Read only when that run's own change token moved, because an activity
    /// summary *is* a recorded event: nothing can arrive that the run-level poll
    /// has not already noticed, so this costs a read of one run rather than a
    /// second poll of the root.
    fn activity(&self) -> Option<Vec<Value>> {
        let watched = self.watched.as_ref()?;
        let view = self.store.view(watched).ok()?;
        Some(payload::live_activity(&view, &self.filter_for(&view)))
    }

    fn frame(&mut self, event: SseEvent, data: Value) -> EventFrame {
        let frame = EventFrame {
            id: self.cursor,
            event,
            data,
        };
        self.cursor += 1;
        frame
    }
}

impl Iterator for Frames {
    type Item = EventFrame;

    fn next(&mut self) -> Option<EventFrame> {
        if !self.opened {
            self.opened = true;
            self.baseline = self.opening_baseline();
            self.transcripts = self.transcript_digest();
            self.activity = self.activity();
            let snapshot = RunStore::envelope(self.store.run_list(&RunsQuery::Page(RunsPage {
                include_settled: true,
                ..RunsPage::default()
            })));
            let data = serde_json::to_value(snapshot).unwrap_or(Value::Null);
            return Some(self.frame(SseEvent::Snapshot, data));
        }
        loop {
            if let Some((event, data)) = self.pending.pop_front() {
                return Some(self.frame(event, data));
            }
            std::thread::sleep(self.store.poll);
            if (self.stop)() {
                return None;
            }
            self.since_conversation_poll += self.store.poll;

            let narrows = self.narrows();
            let mut current: Vec<Watched> = Vec::new();
            for (run, stamp) in self.stamps() {
                let known = self.baseline.iter().find(|watched| watched.run == run);
                if let Some(known) = known {
                    if known.stamp == stamp {
                        // Nothing was appended to this run's journal, so nothing
                        // about it is opened or read — whatever this connection
                        // is filtering for. This is the tick that used to cost a
                        // fold of the whole store and now costs the lookup that
                        // has already happened.
                        current.push(Watched {
                            run,
                            stamp,
                            signature: known.signature,
                        });
                        continue;
                    }
                }
                // The journal moved, or this run is new to this connection. What
                // that means to *this* subscriber is the only thing worth a read,
                // and it is a read of this run rather than of the root.
                let signature = if narrows {
                    self.signature_of_run(&run)
                } else {
                    None
                };
                let moved = match known {
                    // A filtered connection is asking about the events it
                    // admitted, so a run whose only new records this connection
                    // excluded has not moved as far as this subscriber is
                    // concerned and is not announced.
                    Some(known) if narrows => known.signature != signature,
                    Some(_) => true,
                    // A run that appeared since this connection opened, which is
                    // news to it whatever it is filtering for.
                    None => true,
                };
                if moved {
                    // The run that moved, and nothing else: the client refetches
                    // its detail. There is no round to name here, and naming the
                    // event count instead would be this stream restating state it
                    // deliberately does not carry.
                    self.pending
                        .push_back((SseEvent::RunChanged, json!({ "run_id": run })));
                    // The same movement, read for what it was: a run that moved
                    // because a turn reported from inside itself has something in
                    // flight to say, and a client watching it is told rather than
                    // left to refetch a detail that does not carry it.
                    if self.watched.as_ref() == Some(&run) {
                        let latest = self.activity();
                        if latest.is_some() && latest != self.activity {
                            self.activity.clone_from(&latest);
                            self.pending.push_back((
                                SseEvent::ActivityChanged,
                                json!({ "run_id": run, "activity": latest }),
                            ));
                        }
                    }
                }
                current.push(Watched {
                    run,
                    stamp,
                    signature,
                });
            }
            for watched in &self.baseline {
                if !current.iter().any(|current| current.run == watched.run) {
                    self.pending
                        .push_back((SseEvent::RunRemoved, json!({ "run_id": watched.run })));
                }
            }
            self.baseline = current;

            if self.watched.is_some()
                && self.since_conversation_poll >= self.store.conversation_poll
            {
                self.since_conversation_poll = Duration::ZERO;
                let latest = self.transcript_digest();
                if latest != self.transcripts {
                    self.transcripts = latest;
                    let run = self.watched.as_ref().map(RunId::as_str);
                    self.pending
                        .push_back((SseEvent::ConversationChanged, json!({ "run_id": run })));
                }
            }
        }
    }
}
