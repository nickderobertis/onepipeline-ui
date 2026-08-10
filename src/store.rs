//! The SDK-backed read store: [`ReadApi`] over one runs root.
//!
//! Every read here goes through the onepipeline SDK's [`RunView`], which opens a
//! run's launch record, its merged event store, and the fold of that store. This
//! module adds the run-list paging, the not-found decisions, and the polling
//! loop behind the event stream; the payloads themselves are
//! [`crate::payload`]'s projection of what the SDK read.
//!
//! Nothing here writes. Reading takes no lock the engine's single writer needs,
//! which is what lets the server run beside a live round.

use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use onepipeline::views::RunView;
use serde_json::{json, Value};

use crate::api::ReadApi;
use crate::cli::RunsRoot;
use crate::contract::{
    ArtifactId, ConversationId, Envelope, EventFrame, EventsQuery, Health, HealthStatus, RunId,
    RunQuery, RunsQuery, SseEvent, TimelineQuery, API_VERSION, TELEMETRY_SCHEMA_VERSION,
};
use crate::error::ApiError;
use crate::payload::{self, Scope};

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
}

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
        }
    }

    /// Every readable run under the root, oldest id first.
    fn views(&self) -> Vec<RunView> {
        RunView::all(&self.root)
    }

    /// One run, or the not-found this route serves for it.
    fn view(&self, run: &RunId) -> Result<RunView, ApiError> {
        self.views()
            .into_iter()
            .find(|view| view.paths.run == run.as_str())
            .ok_or_else(|| ApiError::RunNotFound(run.clone()))
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

    /// Whether a run's graph has completed and nothing is driving it.
    fn settled(view: &RunView) -> bool {
        !view.state.round_open
            && !view.state.statuses().is_empty()
            && view
                .state
                .statuses()
                .values()
                .all(|status| status.as_str() == "done")
    }

    /// The run list as one page, with the cursor the next page resumes from.
    ///
    /// Ordered by most recent progress, newest first, because that is the order a
    /// reader arrives in: a client takes the first row as the run to open, and the
    /// run that moved last is the one an operator came to look at. The SDK orders
    /// its own listing by run id instead, so this is one of the presentation-worthy
    /// computations AGENTS.md proposes moving into it. Ties break on the id, so the
    /// order is total and a page boundary lands in the same place on every read.
    fn run_list(&self, query: &RunsQuery) -> Value {
        let views = self.views();
        let mut ordered: Vec<&RunView> = views.iter().collect();
        ordered.sort_by(|left, right| {
            right
                .state
                .last_write_at
                .cmp(&left.state.last_write_at)
                .then_with(|| left.paths.run.cmp(&right.paths.run))
        });
        // The cursor names the last row *served*, so resumption is positional in
        // this order rather than a comparison on the id: an id comparison would
        // skip or repeat rows the moment the order stopped being the id's.
        let resume = query.cursor.as_ref().map_or(0, |cursor| {
            ordered
                .iter()
                .position(|view| view.paths.run == cursor.as_str())
                .map_or(0, |index| index + 1)
        });
        let mut rows: Vec<&RunView> = Vec::new();
        for view in ordered.into_iter().skip(resume) {
            if !query.include_settled && Self::settled(view) {
                continue;
            }
            rows.push(view);
        }
        let page = query.page();
        // The cursor is the last row *served*, so the next page resumes after
        // it: naming the first unserved row instead would skip it, because the
        // filter above is what the cursor is compared against.
        let more = rows.len() > page;
        rows.truncate(page);
        let next = more
            .then(|| rows.last().map(|view| view.paths.run.clone()))
            .flatten();
        let mut payload = serde_json::Map::new();
        payload.insert(
            "runs".into(),
            Value::Array(rows.into_iter().map(payload::run_summary).collect()),
        );
        if let Some(cursor) = next {
            payload.insert("next_cursor".into(), json!(cursor));
        }
        Value::Object(payload)
    }
}

impl ReadApi for RunStore {
    type Events = Frames;

    fn health(&self) -> Health {
        Health {
            status: HealthStatus::Ok,
        }
    }

    fn runs(&self, query: &RunsQuery) -> Result<Envelope<Value>, ApiError> {
        Ok(Self::envelope(self.run_list(query)))
    }

    fn run(&self, run: &RunId, query: &RunQuery) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        Ok(Self::envelope(payload::run_detail(
            &view,
            query.include_conversations,
        )))
    }

    fn timeline(&self, run: &RunId, query: &TimelineQuery) -> Result<Envelope<Value>, ApiError> {
        let view = self.view(run)?;
        let scope = match query {
            TimelineQuery::Run => Scope::Run,
            TimelineQuery::Node { node } => Scope::Node(node),
        };
        Ok(Self::envelope(payload::timeline(&view, &scope)))
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
    cursor: u64,
    opened: bool,
    baseline: Vec<(RunId, (u64, usize, u64))>,
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
            cursor: query.after.unwrap_or(0),
            opened: false,
            baseline: Vec::new(),
            transcripts: None,
            activity: None,
            pending: std::collections::VecDeque::new(),
            since_conversation_poll: Duration::ZERO,
        }
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

    /// The runs this connection watches, and their change tokens.
    ///
    /// Keyed by [`RunId`] rather than by the directory name: every frame below
    /// hands this back as the `run_id` a client refetches the run with, so a
    /// directory the contract's own boundary would refuse is one this stream
    /// must not announce as a run to go and read.
    fn signatures(&self) -> Vec<(RunId, (u64, usize, u64))> {
        self.store
            .views()
            .iter()
            .filter(|view| {
                self.watched
                    .as_ref()
                    .is_none_or(|run| view.paths.run == run.as_str())
            })
            .filter_map(|view| {
                RunId::try_from(view.paths.run.as_str())
                    .ok()
                    .map(|run| (run, payload::signature(view)))
            })
            .collect()
    }

    /// The watched run's transcript digest, or `None` when nothing is watched.
    fn transcript_digest(&self) -> Option<String> {
        let watched = self.watched.as_ref()?;
        let view = self.store.view(watched).ok()?;
        Some(payload::conversation_signature(&view))
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
        Some(payload::live_activity(&view))
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
            self.baseline = self.signatures();
            self.transcripts = self.transcript_digest();
            self.activity = self.activity();
            let snapshot = RunStore::envelope(self.store.run_list(&RunsQuery {
                include_settled: true,
                ..RunsQuery::default()
            }));
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

            let current = self.signatures();
            for (run, token) in &current {
                let known = self
                    .baseline
                    .iter()
                    .find(|(name, _)| name == run)
                    .map(|(_, token)| token);
                if known != Some(token) {
                    self.pending.push_back((
                        SseEvent::RunChanged,
                        json!({ "run_id": run, "round": token.0 }),
                    ));
                    // The same movement, read for what it was: a run that moved
                    // because a turn reported from inside itself has something in
                    // flight to say, and a client watching it is told rather than
                    // left to refetch a detail that does not carry it.
                    if self.watched.as_ref() == Some(run) {
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
            }
            for (run, _) in &self.baseline {
                if !current.iter().any(|(name, _)| name == run) {
                    self.pending
                        .push_back((SseEvent::RunRemoved, json!({ "run_id": run })));
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
