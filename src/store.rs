//! The SDK-backed read store: [`RunApi`] over one runs root.
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
//!   carries the run's aggregate timing, which is what the process was fetching;
//!   and a detail's clock is the SDK's fold over the view the route already
//!   holds, so this server starts no `onepipeline` process for anything.
//!
//! Reads take no lock the engine's single writer needs, which is what lets the
//! server run beside the engine's own reconcile loop. Nothing here writes — but
//! the SDK's summary read is a cache: a run whose document is missing or stale
//! is folded once and the fold written back beside the run, best-effort — the
//! summary this store reads and the checkpoint the engine's own next fold
//! resumes from — so the *next* reader of that run pays a bounded read. That is
//! the SDK's own design
//! and the reason a store full of runs recorded by an older build is slow on its
//! first listing and cheap on every one after it.
//!
//! Filtering is resolved here, once per read: `?filter=` is matched against the
//! run being served — a built-in profile, one its launch config defined, or an
//! inline spec — and the resolved [`EventFilter`] is handed to the projection.
//! It reaches only the places events are *listed*, so a filter narrows what a
//! response carries and never what the run is: every status, settlement,
//! decision, count and timing is folded from the whole journal whatever it said.

use std::collections::{BTreeSet, HashMap};
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use onepipeline::agents::{AgentScope, Agents};
use onepipeline::verbs;
use onepipeline::views::{Listing, RunPaths, RunSummary, RunView, Skipped};
use serde_json::{json, Value};

use crate::api::RunApi;
use crate::cli::{RunsRoot, SessionId};
use crate::contract::{
    ArtifactId, AttestRequest, ConversationId, Correlation, Envelope, EventFrame, EventsQuery,
    Health, HealthStatus, NextQuery, NodeId, ProjectId, Release, RunId, RunQuery, RunSelection,
    RunsPage, RunsQuery, SseEvent, StopRequest, SurfaceRequest, TimelineQuery, TimelineScope,
    TranscriptQuery, WatchEvent, WatchFrame, WatchQuery, API_VERSION, TELEMETRY_SCHEMA_VERSION,
};
use crate::error::ApiError;
use crate::filter::{EventFilter, FilterSpec, LaunchProfiles};
use crate::payload::{self, AgentsScope, DeclaredMembers, Scope, Signature};
use crate::telemetry::{self, RunTelemetry};

/// How many watch frames the engine may run ahead of a reader.
///
/// Small on purpose: the engine's wait parks on a full channel, so a client
/// that stopped reading stops the frames being rendered for it rather than
/// queueing an unbounded backlog in this process.
const FRAME_BUFFER: usize = 8;

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

/// The variable `oneagentgraph` — and the engine launching graphs through it —
/// reads its state directory from.
///
/// Restated rather than imported, as the engine itself restates it: the sibling
/// declares this name as a private `const` in its binary, so there is no library
/// item to name. What matters is that all three read the *same* name, so the
/// records the engine's launches wrote are the records this store reads.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the one source is a private `const` in `oneagentgraph`'s binary and the engine's own restatement of it is private too, so there is no declaration a gate could read; the engine records the same gap in its `docs/contract-divergences.md`, and the surface that would close it — a library entry point that names its keys — is the sibling's to add.
pub const GRAPH_RECORDS_ENV: &str = "ONEAGENTGRAPH_STATE_DIR";

/// Where `oneagentgraph` keeps its run records when nothing says otherwise,
/// under the home directory — resolved exactly as that CLI and the engine
/// resolve it, so a host that configured neither still reads what it recorded.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the default is computed inside `oneagentgraph`'s binary from `HOME` and a literal no library item declares, so there is nothing to import and no declaration to gate against; the value is a fact about where that CLI writes, restated here so a host that configured nothing is read where it wrote.
const GRAPH_RECORDS_UNDER_HOME: &str = ".local/state/oneagentgraph/runs";

/// Where this process would read graph records from, as the engine decides it:
/// [`GRAPH_RECORDS_ENV`], else the default under `HOME`.
///
/// A path and not a validated directory: a host that has never run an observer
/// graph has no such directory, and that is a host whose sessions are served
/// with no `agent_role` rather than one this server refuses to start on. Nor is
/// the value itself checked: it has to resolve to the byte the engine resolved
/// when it wrote the records, and a reading that refused what the engine
/// accepted would read a different store than the engine wrote.
#[must_use]
// llmlint: ignore[boundary_inputs_validated] the variable is read exactly as the engine and the sibling CLI read it — a path, taken verbatim — because the property this store needs is that it looks where they wrote; a value they accept and this refuses is a store nothing here can find, and the path is only ever read from, never created or written.
pub fn graph_records_from_env() -> PathBuf {
    std::env::var_os(GRAPH_RECORDS_ENV).map_or_else(
        || {
            std::env::var_os("HOME")
                .map_or_else(std::env::temp_dir, PathBuf::from)
                .join(GRAPH_RECORDS_UNDER_HOME)
        },
        PathBuf::from,
    )
}

/// The variable the engine reads its runs root from.
///
/// The SDK's own listing reading — `views::liveness_of`, which asks a run's
/// channel whether a blocking surface is outstanding — finds that channel under
/// the root this variable names rather than under one a caller hands it, and
/// the driver an adoption retains resolves the run it drives the same way. So
/// the binary exports it from `--runs-root` before it serves anything, and this
/// is the name it exports. Restated because the engine declares it in a private
/// module; `tests/e2e/server.rs` holds the spelling by starting the server over
/// one root and reading a channel-held run as waiting rather than parked.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the one source is `ledger::RUNS_DIR_ENV` in a private module of the engine, so there is no declaration a gate could import; the journey named above is the drift gate, because a spelling the engine did not read would leave every channel-held run served as parked.
pub const RUNS_DIR_ENV: &str = "ONEPIPELINE_RUNS_DIR";

/// A read-only view of one runs root.
#[derive(Debug, Clone)]
pub struct RunStore {
    root: PathBuf,
    /// The launching session this store acts as on every write, or `None` for
    /// an unattributed server that owns no run.
    session: Option<SessionId>,
    /// The program an adoption retains as the run's driver: this executable,
    /// unless a reader that is not the binary named the binary.
    driver: Option<PathBuf>,
    /// The drivers this process has retained and not yet seen exit.
    reaper: Reaper,
    /// Where the `oneagentgraph` run records this store reads a run's declared
    /// members from live — the sibling's state directory, not the runs root.
    graph_records: PathBuf,
    poll: Duration,
    conversation_poll: Duration,
    aggregated: Aggregated,
}

/// The SDK's telemetry document for each run, kept until that run moves.
///
/// Folding it walks the run's every event and reads every retained report, and
/// a detail is refreshed far more often than a run moves. The run's own change
/// token is what the cached answer is held against, so a document is re-folded
/// exactly when the run it describes has recorded something — which is the same
/// condition the event stream already invalidates on.
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
            session: None,
            driver: None,
            reaper: Reaper::default(),
            graph_records: graph_records_from_env(),
            poll,
            conversation_poll: poll * CONVERSATION_POLLS_PER_RUN_POLL,
            aggregated: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The same store, acting as `session` on every write it makes.
    ///
    /// `None` is an unattributed server: it owns no run, so it is refused every
    /// stop it does not force and every adoption, and `unwatched` has nothing
    /// to report for it. The acting session is the one the binary resolved from
    /// `--session` and the environment, so the store never reads the
    /// environment for it.
    #[must_use]
    pub fn acting_as(mut self, session: Option<&SessionId>) -> Self {
        self.session = session.cloned();
        self
    }

    /// The same store, retaining `program` as the driver of every run it adopts
    /// rather than this process's own executable.
    ///
    /// For a reader that is not the `onepipeline-api` binary — a suite holding
    /// the store in-process — to retain the binary that does carry the hidden
    /// driver verb. The served process retains itself.
    #[must_use]
    pub fn driving_with(mut self, program: &Path) -> Self {
        self.driver = Some(program.to_path_buf());
        self
    }

    /// The program an adoption retains, and its arguments, exactly as the
    /// engine will spawn them: this executable at its own hidden driver verb,
    /// `drive-run RUN --adopt`, as the engine's binary retains itself. The
    /// engine appends nothing.
    fn retain(&self, run: &RunId) -> Result<verbs::Retain, ApiError> {
        let program = match &self.driver {
            Some(program) => program.clone(),
            None => std::env::current_exe().map_err(|error| {
                ApiError::Engine(format!(
                    "cannot find this executable to retain a driver: {error}"
                ))
            })?,
        };
        Ok(verbs::Retain {
            program,
            args: vec![
                crate::cli::DRIVE_RUN_VERB.to_owned(),
                run.as_str().to_owned(),
                "--adopt".to_owned(),
            ],
        })
    }

    /// The session this store acts as, as the engine is handed it: the empty
    /// string for an unattributed server, which the engine reads as nobody.
    fn session(&self) -> &str {
        self.session.as_ref().map_or("", SessionId::as_str)
    }

    /// The same store, reading `oneagentgraph`'s run records from `dir` rather
    /// than from where this process's environment says that library keeps them.
    ///
    /// For a reader that holds a store of its own — a suite writing records
    /// beside the runs it serves — where the served process reads the engine's.
    #[must_use]
    pub fn reading_graph_records(mut self, dir: &Path) -> Self {
        self.graph_records = dir.to_path_buf();
        self
    }

    /// The members this run's recorded graph declarations name.
    ///
    /// Read off the run records `oneagentgraph` wrote for the graphs this run
    /// ran: the observer graph's, which the launch record names — every one it
    /// has been, because a replaced observer is still the producer of what it
    /// relayed — and every node graph's, whose run id is the **stream** its
    /// records were relayed on, because that library writes each graph run's
    /// envelopes under the id it minted for the run. A record from before the
    /// sibling kept its declarations lists only the members that settled, which
    /// is what the engine itself falls back to; a stream this host holds no
    /// record for declares nothing, so a session on it is served no role rather
    /// than one guessed at.
    fn declared(&self, view: &RunView) -> DeclaredMembers {
        let mut graph_runs: Vec<&str> = view
            .launch
            .observer_runs
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(view.launch.graph_run.as_str()))
            .filter(|run| !run.is_empty())
            .collect();
        graph_runs.extend(
            view.events
                .iter()
                .filter(|event| event.source == onepipeline::event::Source::Agentgraph)
                .map(|event| event.stream.as_str()),
        );
        let graph_runs: BTreeSet<&str> = graph_runs.into_iter().collect();
        DeclaredMembers::new(graph_runs.into_iter().flat_map(|run| {
            oneagentgraph::history::show(&self.graph_records, run).map_or_else(
                |_| Vec::new(),
                |record| {
                    if record.declared_members.is_empty() {
                        record.members.into_keys().collect()
                    } else {
                        record.declared_members
                    }
                },
            )
        }))
    }

    /// What `onepipeline` folds for this run, over the view already in hand,
    /// kept until the run moves.
    ///
    /// `None` when the document the fold produced is not one this build reads,
    /// which leaves every timing the payload carries absent rather than zero.
    /// The reason is written once per run per change, to stderr beside the
    /// server's own output: a run served with no clock at all is a thing an
    /// operator has to be able to explain, and the alternative is a payload full
    /// of nulls with nothing saying why.
    ///
    /// A cache still, though the fold is in-process now: it walks every event
    /// of the run and reads every settled member's retained report, which is
    /// affordable per change and not per refresh of an unmoved run. A lock
    /// poisoned by a panicking reader is not a reason to stop serving: the cache
    /// is an optimisation, and the worst a recovered one costs is a re-read.
    fn telemetry(&self, view: &RunView) -> Option<Arc<RunTelemetry>> {
        // Keyed by the validated id, so a directory this contract could not name
        // is one no cache entry is written under either — the same filter the
        // stream applies before announcing a run.
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
        let document = match telemetry::of_run(view) {
            Ok(document) => Some(Arc::new(document)),
            Err(unreadable) => {
                eprintln!("onepipeline-api: no telemetry for {run}: {unreadable}");
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
    /// so `planner` and `detailed` answer for every run and a launch-defined name
    /// answers only for the run that defined it.
    fn resolve(view: &RunView, spec: Option<&FilterSpec>) -> Result<EventFilter, ApiError> {
        match spec {
            None => Ok(EventFilter::default()),
            Some(spec) => spec.resolve(&LaunchProfiles::of(
                &view.launch.dag_sets,
                &view.launch.filters,
            )),
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

    /// The paths of a run a verb is about, once the run is known to be there.
    ///
    /// Every verb route answers `404 run_not_found` for a run that is not under
    /// the root, before anything else is read or written about it: the engine
    /// refuses the same run on every verb, and a refusal in its words about a
    /// run that does not exist would be the engine's account of a directory
    /// rather than the contract's answer.
    fn present(&self, run: &RunId) -> Result<RunPaths, ApiError> {
        let paths = self.paths_of(run);
        if !paths.exists() {
            return Err(ApiError::RunNotFound(run.clone()));
        }
        Ok(paths)
    }

    /// The engine's own refusal of a verb about `run`, on the wire.
    fn refused(run: &RunId, error: onepipeline::Error) -> ApiError {
        ApiError::from_engine(run, error)
    }

    /// One row of the grouped listing, on the terms a page serves one.
    ///
    /// `None` for a run whose directory this contract's boundary refuses, which
    /// the caller reports on `unreadable` rather than serving under a name the
    /// run route beside it would refuse.
    fn grouped_row(&self, summary: &RunSummary) -> Option<Value> {
        let run = RunId::try_from(summary.run_id.as_str()).ok()?;
        Some(self.row(&run, summary))
    }

    /// The runs under this root grouped by project, as `verbs::runs` groups them
    /// for the acting session.
    fn grouped(&self) -> onepipeline::views::Projects {
        verbs::runs(&self.root, self.session(), false)
    }

    /// The roots a grouped listing refused, and the runs it could not name.
    fn grouped_unreadable(&self, projects: &onepipeline::views::Projects) -> Option<Value> {
        let mut skipped = projects.skipped.clone();
        for summary in projects.groups.iter().flat_map(|group| &group.runs) {
            if let Err(why) = RunId::try_from(summary.run_id.as_str()) {
                skipped.push(Skipped {
                    path: self.root.join(&summary.run_id),
                    reason: format!("this API cannot serve a run under that name: {why}"),
                });
            }
        }
        Self::unreadable(&skipped)
    }

    /// How many sessions the run's pointer file names, as `GET .../agents`
    /// would answer them: zero for a run with no pointer file, and `None` —
    /// said once to stderr, on the terms an unreadable telemetry document is —
    /// where the file is there and this build could not read it.
    fn agent_count(&self, run: &RunId) -> Option<usize> {
        match verbs::agents(&self.paths_of(run), AgentScope::Run) {
            Ok(agents) => Some(agents.sessions.len()),
            Err(unreadable) => {
                eprintln!("onepipeline-api: no agent count for {run}: {unreadable}");
                None
            }
        }
    }

    /// How many sessions `GET /api/v2/projects/{project}/agents` answers for
    /// one group: the union over its runs, grouped by session as the SDK
    /// groups them, so the number a project row shows is the number its
    /// listing serves.
    ///
    /// Read run by run rather than through `verbs::project_agents`, which
    /// lists the whole root once per call — a grouped listing of every project
    /// would list it once per group. Each read is one small file, paid only for
    /// a run the group serves. `None` where any of them could not be read.
    fn group_agent_count(&self, group: &onepipeline::views::ProjectGroup) -> Option<usize> {
        let mut sessions = BTreeSet::new();
        for summary in &group.runs {
            let run = RunId::try_from(summary.run_id.as_str()).ok()?;
            let agents = self.agents_of(&run, AgentScope::Run).ok()?;
            sessions.extend(
                agents
                    .sessions
                    .into_iter()
                    .map(|session| session.history_session),
            );
        }
        Some(sessions.len())
    }

    /// `verbs::agents` over one run that is known to be there, with the
    /// engine's refusal of a pointer file it could not read on the wire.
    fn agents_of(&self, run: &RunId, scope: AgentScope<'_>) -> Result<Agents, ApiError> {
        let paths = self.present(run)?;
        verbs::agents(&paths, scope).map_err(|error| Self::refused(run, error))
    }

    /// The agents payload, enveloped.
    fn agents_payload(
        scope: &AgentsScope<'_>,
        agents: &Agents,
    ) -> Result<Envelope<Value>, ApiError> {
        payload::agents(scope, agents)
            .map(Self::envelope)
            .map_err(|error| {
                ApiError::ProjectionFailed(format!("the agents do not serialize: {error}"))
            })
    }

    /// The filter one verb request asked for, as the engine's own type.
    ///
    /// Resolved against the run, exactly as a read route resolves one — the
    /// built-in profiles, the run's own, or an inline spec — and then handed to
    /// the engine in its own grammar.
    fn engine_filter(
        &self,
        run: &RunId,
        spec: Option<&FilterSpec>,
    ) -> Result<onepipeline::filter::EventFilter, ApiError> {
        let view = self.view(run)?;
        Self::resolve(&view, spec)?.to_engine()
    }
}

impl RunApi for RunStore {
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
            &self.declared(&view),
            query.include_conversations,
            aggregated.as_deref(),
            self.agent_count(run),
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
        Ok(Self::envelope(payload::timeline(
            &view,
            &self.declared(&view),
            &scope,
            &filter,
        )))
    }

    fn conversation(
        &self,
        run: &RunId,
        conversation: &ConversationId,
    ) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        payload::conversation(&view, &self.declared(&view), conversation)
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

    type Watch = Watching;

    fn projects(&self) -> Result<Envelope<Value>, ApiError> {
        let projects = self.grouped();
        let mut payload = serde_json::Map::new();
        payload.insert(
            "projects".into(),
            payload::projects(&projects, &|summary| self.grouped_row(summary), &|group| {
                self.group_agent_count(group)
            }),
        );
        if let Some(refused) = self.grouped_unreadable(&projects) {
            payload.insert("unreadable".into(), refused);
        }
        Ok(Self::envelope(Value::Object(payload)))
    }

    fn project(&self, project: &ProjectId) -> Result<Envelope<Value>, ApiError> {
        let projects = self.grouped();
        let group = projects
            .groups
            .iter()
            .find(|group| group.project.as_deref() == Some(project.as_str()))
            .ok_or_else(|| ApiError::ProjectNotFound(project.clone()))?;
        Ok(Self::envelope(payload::project_group(
            group,
            &|summary| self.grouped_row(summary),
            &|group| self.group_agent_count(group),
        )))
    }

    fn channel(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let queue = verbs::channel(&paths).map_err(|error| Self::refused(run, error))?;
        let mut payload = serde_json::to_value(&queue).map_err(|error| {
            ApiError::ProjectionFailed(format!("the channel does not serialize: {error}"))
        })?;
        payload["run_id"] = json!(run);
        Ok(Self::envelope(payload))
    }

    fn channel_next(&self, run: &RunId, query: &NextQuery) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let filter = self.engine_filter(run, query.filter.as_ref())?;
        let next = verbs::next(&paths, &filter).map_err(|error| Self::refused(run, error))?;
        let mut payload = serde_json::to_value(&next).map_err(|error| {
            ApiError::ProjectionFailed(format!("the claim does not serialize: {error}"))
        })?;
        payload["run_id"] = json!(run);
        Ok(Self::envelope(payload))
    }

    fn channel_reply(
        &self,
        run: &RunId,
        correlation: Option<&Correlation>,
        envelope: &str,
    ) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        // The body, byte for byte: the engine parses it, validates it and rules
        // on its author, and this crate reads nothing out of it first.
        let receipt = verbs::reply(&paths, correlation.map(Correlation::inner), envelope)
            .map_err(|error| Self::refused(run, error))?;
        Ok(Self::envelope(payload::receipt(run, &receipt)))
    }

    fn channel_surface(
        &self,
        run: &RunId,
        request: &SurfaceRequest,
    ) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let surfaced = verbs::surface(&paths, request.kind.clone(), request.message.clone())
            .map_err(|error| Self::refused(run, error))?;
        Ok(Self::envelope(json!({
            "run_id": run,
            "surface": surfaced.surface,
            "state": "queued",
        })))
    }

    fn attest(&self, run: &RunId, request: &AttestRequest) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let receipt =
            verbs::attest(&paths, &request.reference).map_err(|error| Self::refused(run, error))?;
        Ok(Self::envelope(payload::receipt(run, &receipt)))
    }

    fn stop(&self, run: &RunId, request: &StopRequest) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let stopped = verbs::stop(
            &paths,
            verbs::StopRequest {
                session: self.session(),
                force: request.force,
            },
        )
        .map_err(|error| Self::refused(run, error))?;
        // A teardown that was not clean is journalled and is not a stop: the run
        // is still running, and the engine's own account of what it could not
        // reach is the answer, on the status its binary refuses with.
        if let Some(refusal) = stopped.refusal() {
            return Err(ApiError::NotStopped(refusal));
        }
        Ok(Self::envelope(payload::stopped(run, &stopped)))
    }

    fn adopt(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let adopted = verbs::adopt(&paths, verbs::Adopt::Detached(self.retain(run)?))
            .map_err(|error| Self::refused(run, error))?;
        let verbs::Adopted::Detached { pid, .. } = adopted else {
            return Err(ApiError::ProjectionFailed(
                "a detached adoption answered as an attached one".to_owned(),
            ));
        };
        self.reaper.watch(pid);
        Ok(Self::envelope(json!({ "run_id": run, "pid": pid })))
    }

    fn watch(&self, run: &RunId, query: &WatchQuery) -> Result<Self::Watch, ApiError> {
        let paths = self.present(run)?;
        let filter = self.engine_filter(run, query.filter.as_ref())?;
        let request = verbs::WatchRequest {
            filter,
            timeout: query.timeout,
            tick: query.tick,
            cursor: query.cursor.clone(),
            until: query.until.clone(),
        };
        Watching::open(run, paths, request)
    }

    fn unwatched(&self) -> Result<Envelope<Value>, ApiError> {
        let unwatched = verbs::unwatched(&self.root, self.session())
            .map_err(|error| ApiError::Engine(error.to_string()))?;
        Ok(Self::envelope(json!({
            "reported": unwatched
                .reported
                .iter()
                .map(|run| json!({
                    "run": run.run,
                    "standing": run.standing,
                    "why_not_watched": run.why_not_watched,
                }))
                .collect::<Vec<Value>>(),
            "unresolved": unwatched.unresolved,
        })))
    }

    fn host(&self) -> Result<Envelope<Value>, ApiError> {
        let host = verbs::host(&self.root);
        Ok(Self::envelope(payload::rendered_root(
            verbs::render_host(&host),
            &host.survey.skipped,
        )))
    }

    fn status(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        self.present(run)?;
        let status = verbs::status(&self.root, Some(run.as_str()))
            .map_err(|error| Self::refused(run, error))?;
        let rendered = verbs::render_status(&status);
        let verbs::Status::Run(detail) = status else {
            return Err(ApiError::ProjectionFailed(
                "a run's status answered as a listing".to_owned(),
            ));
        };
        Ok(Self::envelope(payload::status(run, &detail, rendered)))
    }

    fn results(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let results = verbs::results(&paths).map_err(|error| Self::refused(run, error))?;
        Ok(Self::envelope(payload::rendered(
            run,
            verbs::render_results(&results),
        )))
    }

    fn goals(&self) -> Result<Envelope<Value>, ApiError> {
        let goals =
            verbs::goals(&self.root, None).map_err(|error| ApiError::Engine(error.to_string()))?;
        Ok(Self::envelope(payload::rendered_root(
            verbs::render_goals(&goals),
            &goals.survey.skipped,
        )))
    }

    fn run_goals(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        self.present(run)?;
        let goals = verbs::goals(&self.root, Some(run.as_str()))
            .map_err(|error| Self::refused(run, error))?;
        Ok(Self::envelope(payload::rendered(
            run,
            verbs::render_goals(&goals),
        )))
    }

    fn transcript(
        &self,
        run: &RunId,
        query: &TranscriptQuery,
    ) -> Result<Envelope<Value>, ApiError> {
        let paths = self.present(run)?;
        let transcript = verbs::transcript(
            &paths,
            query.node.as_ref().map(crate::contract::NodeId::as_str),
        )
        .map_err(|error| Self::refused(run, error))?;
        let mut payload = payload::rendered(run, verbs::render_transcript(&transcript));
        if let Some(node) = &query.node {
            payload["node"] = json!(node);
        }
        Ok(Self::envelope(payload))
    }

    fn telemetry(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        self.present(run)?;
        let measured = verbs::telemetry(&self.root, Some(run.as_str()))
            .map_err(|error| Self::refused(run, error))?;
        let document = measured.first().ok_or_else(|| {
            ApiError::ProjectionFailed("the engine measured nothing for the run".to_owned())
        })?;
        Ok(Self::envelope(
            json!({ "run_id": run, "telemetry": document }),
        ))
    }

    fn agents(&self, run: &RunId) -> Result<Envelope<Value>, ApiError> {
        let agents = self.agents_of(run, AgentScope::Run)?;
        Self::agents_payload(&AgentsScope::Run { run, node: None }, &agents)
    }

    fn node_agents(&self, run: &RunId, node: &NodeId) -> Result<Envelope<Value>, ApiError> {
        let agents = self.agents_of(run, AgentScope::Node(node.as_str()))?;
        Self::agents_payload(
            &AgentsScope::Run {
                run,
                node: Some(node),
            },
            &agents,
        )
    }

    fn project_agents(&self, project: &ProjectId) -> Result<Envelope<Value>, ApiError> {
        // The project route's own not-found first: the engine refuses a project
        // no run was launched from in its own words, and a group this listing
        // does not hold is the contract's `404` rather than the engine's `422`.
        let projects = self.grouped();
        if !projects
            .groups
            .iter()
            .any(|group| group.project.as_deref() == Some(project.as_str()))
        {
            return Err(ApiError::ProjectNotFound(project.clone()));
        }
        // The engine's own ruling, classified as it is on the run routes: a
        // pointer file it could not read is the contract's `refused`, which is
        // what the run beside this one answers for the same file.
        let agents = verbs::project_agents(&self.root, project.as_str())
            .map_err(ApiError::from_engine_unscoped)?;
        Self::agents_payload(&AgentsScope::Project(project), &agents)
    }
}

/// The retained drivers this process is the parent of, reaped when they exit.
///
/// `verbs::adopt(Detached)` spawns the driver as this process's child, in a
/// process group of its own, and hands back its pid and nothing else: the
/// server keeps no handle on the driver, and every later read is off the run
/// record. But a child nobody waits on stays a **zombie** when it exits, and a
/// zombie answers the engine's own liveness probe as a live process — so a
/// driver that had settled its run and gone would go on reading as driving it,
/// and the run would refuse every adoption after the first, for as long as
/// this process lived. The CLI never meets this because it exits right after
/// retaining, and `init` reaps what it left; a server that lives on has to reap
/// its own. This waits on exactly the pids it retained, with `WNOHANG`, so no
/// exit status of any other child — the engine's own subprocesses, which it
/// waits on itself — is ever taken from the process that started it.
#[derive(Debug, Clone, Default)]
struct Reaper {
    retained: Arc<Mutex<Vec<u32>>>,
}

/// How often the reaper looks at the drivers it retained.
const REAP_EVERY: Duration = Duration::from_millis(500);

impl Reaper {
    /// Reap `pid` when it exits, on a thread started for the first driver and
    /// kept for every one after it.
    fn watch(&self, pid: u32) {
        let mut retained = self
            .retained
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let first = retained.is_empty();
        retained.push(pid);
        drop(retained);
        if first {
            let retained = Arc::clone(&self.retained);
            std::thread::spawn(move || loop {
                std::thread::sleep(REAP_EVERY);
                let mut retained = retained
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                retained.retain(|pid| !reaped(*pid));
                if retained.is_empty() {
                    return;
                }
            });
        }
    }
}

/// Whether `pid` has exited and been waited on, or is no child of this
/// process to wait on at all — either way, nothing left to reap.
#[cfg(unix)]
fn reaped(pid: u32) -> bool {
    let Ok(raw) = i32::try_from(pid) else {
        return true;
    };
    let mut status = 0;
    // SAFETY: `waitpid` with `WNOHANG` touches no memory but the status it is
    // handed, and asks only about the one child named.
    let answered = unsafe { libc::waitpid(raw, &mut status, libc::WNOHANG) };
    // `0` is a child still running; the pid is one that exited and is reaped
    // by this call; `-1` is a pid that is not this process's child, which is
    // nothing to wait on.
    answered != 0
}

/// A platform with no zombies to reap: a handle the SDK dropped is a handle
/// closed, and the kernel keeps nothing for it.
#[cfg(not(unix))]
fn reaped(_pid: u32) -> bool {
    true
}

/// One `GET /api/v2/runs/{run}/watch` connection's frames: the engine's wait,
/// driven on a thread of its own and read off a channel.
///
/// `verbs::watch` is a blocking call that hands each frame to a sink and returns
/// when the wait ends, so an iterator over it is a thread running the wait and
/// a channel the sink writes to. Dropping the iterator drops the receiver, the
/// next frame's send fails, the sink refuses, and the engine ends the wait with
/// that refusal — which is when it removes the watcher record it wrote. A
/// client that disconnected is therefore no longer a watcher by the time the
/// next frame would have been sent.
pub struct Watching {
    frames: std::sync::mpsc::Receiver<WatchFrame>,
    /// Whether the `returned` frame has been handed out, after which the
    /// engine's wait is over and there is nothing more to receive.
    ended: bool,
}

/// How long a receive may block before the iterator checks whether the
/// stopping condition its driver watches has fired.
///
/// The engine's wait cannot be interrupted from outside, so what a server asked
/// to stop can do is stop *reading* — which ends the wait at the next frame the
/// engine hands out, a tick at most. Polling at this interval is what keeps the
/// blocking worker from sitting on a receive nothing will ever satisfy.
const WATCH_RECEIVE_POLL: Duration = Duration::from_millis(250);

impl Watching {
    /// Start the engine's wait over `paths`, refusing what it refuses before
    /// it would wait.
    ///
    /// The engine rules on the request — the cursor, every condition — before
    /// it hands out a frame or waits a second, but it rules from inside one
    /// blocking call that then goes on to wait. So the ruling is taken first
    /// through a wait of no seconds, which reads the run once and returns:
    /// every refusal it can make it makes there, in its own words, before this
    /// connection opens. The frames of that read are not served; the real wait
    /// starts from the same cursor.
    fn open(run: &RunId, paths: RunPaths, request: verbs::WatchRequest) -> Result<Self, ApiError> {
        let preflight = verbs::WatchRequest {
            timeout: onepipeline::cli::WatchTimeout::Bounded(0),
            ..request.clone()
        };
        verbs::watch(&paths, &preflight, &mut |_| Ok(()))
            .map_err(|error| ApiError::from_engine(run, error))?;

        let (tx, rx) = std::sync::mpsc::sync_channel::<WatchFrame>(FRAME_BUFFER);
        let run = run.clone();
        std::thread::spawn(move || {
            let mut next = 0;
            let mut sink = |frame: verbs::WatchFrame<'_>| -> onepipeline::Result<()> {
                let event = match frame {
                    verbs::WatchFrame::Event { .. } => WatchEvent::Event,
                    verbs::WatchFrame::Tick { .. } => WatchEvent::Tick,
                    verbs::WatchFrame::Ended { .. } => WatchEvent::Returned,
                };
                let lines = verbs::render_watch_frame(&frame)?;
                let data = serde_json::from_str(&lines.machine).map_err(|error| {
                    onepipeline::Error::Invalid(format!(
                        "the watch rendered a record this API cannot read: {error}"
                    ))
                })?;
                let frame = WatchFrame {
                    id: next,
                    event,
                    data,
                };
                next += 1;
                tx.send(frame)
                    .map_err(|_| onepipeline::Error::Refused("the reader has gone".to_owned()))
            };
            // A wait that ends with its reader gone is the ordinary end of a
            // connection, and the engine's own ending is on the last frame it
            // handed out; nothing here has anyone left to tell.
            if let Err(error) = verbs::watch(&paths, &request, &mut sink) {
                if !matches!(&error, onepipeline::Error::Refused(why) if why == "the reader has gone")
                {
                    eprintln!("onepipeline-api: the watch on {run} ended: {error}");
                }
            }
        });
        Ok(Self {
            frames: rx,
            ended: false,
        })
    }

    /// The next frame, or `None` once the wait is over or `stop` says to end.
    ///
    /// Not [`Iterator::next`], because the one thing an iterator cannot be told
    /// is when to stop waiting: the server's driver asks with the same stopping
    /// condition the event stream is driven with.
    pub fn next_frame_unless(&mut self, stop: &dyn Fn() -> bool) -> Option<WatchFrame> {
        if self.ended {
            return None;
        }
        loop {
            match self.frames.recv_timeout(WATCH_RECEIVE_POLL) {
                Ok(frame) => {
                    if frame.event == WatchEvent::Returned {
                        self.ended = true;
                    }
                    return Some(frame);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if stop() {
                        return None;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
    }
}

impl Iterator for Watching {
    type Item = WatchFrame;

    fn next(&mut self) -> Option<WatchFrame> {
        self.next_frame_unless(&|| false)
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
            &self.store.declared(&view),
            &self.filter_for(&view),
        ))
    }

    /// The project a run's bounded summary records, or `None` where it
    /// records none — or where the summary cannot be read, which is a run the
    /// detail refetch will report on its own terms.
    fn project_of(&self, run: &RunId) -> Option<String> {
        let summary = RunSummary::of(&self.store.paths_of(run)).ok()?;
        (!summary.project.is_empty()).then_some(summary.project)
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
                    // deliberately does not carry. The project group it belongs
                    // to is named beside it — read off the run's own bounded
                    // summary, which is one document of a run that has actually
                    // moved — so a client refreshing by group refreshes the group
                    // that moved; a run whose summary records none names none.
                    let mut changed = json!({ "run_id": run });
                    if let Some(project) = self.project_of(&run) {
                        changed["project"] = json!(project);
                    }
                    self.pending.push_back((SseEvent::RunChanged, changed));
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
