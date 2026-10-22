//! Subscriptions: the sidebar and at most one visible run view per tab, kept
//! current by pushing what changed.
//!
//! `docs/contract.md` states the protocol; this is its one implementation. A tab
//! creates a subscription with `POST /api/v2/subscriptions` and is answered with
//! the state it shows — the sidebar's trimmed rows and the visible view's payload
//! — at one publication boundary, then reads `GET /api/v2/events?subscription=`
//! for the changes after it: a trimmed row per run that moved, a patch of the
//! visible detail, timeline or channel queue, and nothing for anything the tab is
//! not showing. A reconnect resumes after the last frame it applied, replayed
//! from the frames the subscription retained; a cursor the subscription cannot
//! resume from is answered with one explicit reset, never a silent re-send.
//!
//! One poller serves every subscription. Each tick it looks at the runs root's
//! metadata for the sidebar, and refreshes each **subscribed** run's long-lived
//! [`RunView`] with `RunView::refresh`, which reads, parses and folds only what
//! was appended; the payloads are kept current from those records by
//! [`crate::payload::live`]. A run nobody shows is never opened, and two tabs on
//! one view share one reading of it.
//!
//! The SDK's telemetry document is the one part of a detail that folds the whole
//! journal however little moved. It is folded when a view first needs it and
//! then at most once every [`TELEMETRY_REFOLD`], to the run as it stands, so a
//! change reaches the page without waiting on it.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use axum::response::sse::Event;
use onepipeline::agents::{AgentScope, Agents};
use onepipeline::views::{Refreshed, RunPaths, RunSummary, RunView};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::contract::{
    Envelope, EventId, RunId, SubscribeRequest, SubscriptionId, SubscriptionView, ViewScope,
    API_VERSION, DISCONNECTED_GRACE, RETAINED_FRAMES, TELEMETRY_SCHEMA_VERSION,
};
use crate::error::ApiError;
use crate::filter::EventFilter;
use crate::patch::Op;
use crate::payload::live::{DetailInputs, Indexed, LiveDetail, LiveTimeline, TimelineScope, Touched};
use crate::payload::{self, DeclaredMembers};
use crate::store::RunStore;
use crate::telemetry::RunTelemetry;

/// The longest the SDK's whole-journal telemetry fold is left behind the run,
/// once something moved: the detail's `telemetry`, and the timing and usage its
/// `run` reads off it, follow the journal within this.
pub const TELEMETRY_REFOLD: Duration = Duration::from_secs(10);

/// How many retired subscription ids are remembered, so a stream asked for one
/// is told it expired rather than that it never existed.
const RETIRED_REMEMBERED: usize = 4096;

/// The environment variable that sets [`TELEMETRY_REFOLD`] in milliseconds,
/// for a reader that must see the telemetry follow every change — the journeys
/// that hold a patched detail to a fresh read. `0` refolds on every change.
pub const TELEMETRY_REFOLD_ENV: &str = "ONEPIPELINE_UI_TELEMETRY_REFOLD_MS";

/// The environment variable naming a file the poller appends one JSON line to
/// per refresh that moved something: what the refresh read, what each payload
/// rebuilt, and what that cost. Passive: nothing reads it back, and unset it
/// costs nothing.
pub const TRACE_ENV: &str = "ONEPIPELINE_UI_LIVE_TRACE";

/// Every subscription this process holds, and the poller that keeps them
/// current.
#[derive(Clone)]
pub struct Hub(Arc<Shared>);

struct Shared {
    store: RunStore,
    epoch: uuid::Uuid,
    stopping: Arc<AtomicBool>,
    /// Subscriptions and their frames. Taken last, after a sidebar or a run.
    state: Mutex<State>,
    /// The sidebar's rows. Taken before a run or the state.
    sidebar: Mutex<Sidebar>,
    /// Each subscribed run's reading. The map is held only to look one up.
    runs: Mutex<HashMap<String, Arc<Mutex<LiveRun>>>>,
    polling: AtomicBool,
    trace: Option<PathBuf>,
    refold: Duration,
}

/// Why a subscription id is no longer served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Retired {
    /// Disconnected for longer than [`DISCONNECTED_GRACE`].
    Expired,
    /// Replaced by another, or deleted.
    Retired,
}

struct State {
    next: u64,
    subscriptions: HashMap<SubscriptionId, Subscription>,
    retired: VecDeque<(SubscriptionId, Retired)>,
}

struct Subscription {
    view: SubscriptionView,
    /// The first id this subscription issued: its snapshot, or the reset it
    /// was recreated with.
    first: u64,
    /// The last frame emitted, which the next one names as its base.
    last: u64,
    /// The cursor before the oldest retained frame.
    boundary: u64,
    frames: VecDeque<Retained>,
    connection: Option<mpsc::Sender<Event>>,
    disconnected_at: Option<Instant>,
}

#[derive(Clone)]
struct Retained {
    seq: u64,
    kind: &'static str,
    data: Arc<str>,
}

/// One change, as every subscription it reaches is sent it: the frame's type
/// and its members besides the common three.
struct Change {
    kind: &'static str,
    /// `"run_id": …, "ops": […]` — a JSON object's members, without braces.
    members: String,
}

impl Change {
    fn new(kind: &'static str, members: &Value) -> Self {
        let text = members.to_string();
        Self {
            kind,
            members: text[1..text.len() - 1].to_owned(),
        }
    }
}

/// What a subscription is shown: its view's run and which of that run's
/// payloads it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Visible {
    Sidebar,
    Detail { run: String, filter: String },
    Timeline { run: String, scope: TimelineScope, filter: String },
    Channel { run: String },
}

impl Visible {
    fn of(view: &SubscriptionView) -> Self {
        let filter = |filter: &Option<crate::filter::FilterSpec>| {
            filter.as_ref().map(crate::filter::FilterSpec::as_query_value).unwrap_or_default()
        };
        match view {
            SubscriptionView::Sidebar => Self::Sidebar,
            SubscriptionView::Detail { run_id, filter: spec } => Self::Detail {
                run: run_id.as_str().to_owned(),
                filter: filter(spec),
            },
            SubscriptionView::Timeline { run_id, scope, filter: spec } => Self::Timeline {
                run: run_id.as_str().to_owned(),
                scope: match scope {
                    ViewScope::Run => TimelineScope::Run,
                    ViewScope::Node(node) => TimelineScope::Node(node.clone()),
                },
                filter: filter(spec),
            },
            SubscriptionView::Channel { run_id } => Self::Channel {
                run: run_id.as_str().to_owned(),
            },
        }
    }

    fn run(&self) -> Option<&str> {
        match self {
            Self::Sidebar => None,
            Self::Detail { run, .. } | Self::Timeline { run, .. } | Self::Channel { run } => Some(run),
        }
    }

    /// The filter its detail is read under: the timeline's for a timeline, and
    /// none for the channel's header.
    fn detail_filter(&self) -> &str {
        match self {
            Self::Detail { filter, .. } | Self::Timeline { filter, .. } => filter,
            Self::Sidebar | Self::Channel { .. } => "",
        }
    }
}

/// The sidebar: one trimmed row per run under the root, and what each run's
/// files looked like when its row was read.
#[derive(Default)]
struct Sidebar {
    read: bool,
    rows: BTreeMap<String, (Stamps, Arc<str>)>,
}

/// What a run's files look like: the journal, the bounded summary, the label
/// overlay and the result — every file a row is read from or moves with.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamps([Option<(u64, SystemTime)>; 4]);

impl Stamps {
    fn of(paths: &RunPaths) -> Self {
        let stamp = |path: PathBuf| {
            std::fs::metadata(path)
                .ok()
                .and_then(|about| Some((about.len(), about.modified().ok()?)))
        };
        Self([
            stamp(paths.journal()),
            stamp(paths.summary()),
            stamp(paths.dir.join("labels.json")),
            stamp(paths.result()),
        ])
    }
}

/// A change to the sidebar.
enum RowChange {
    Changed(Arc<str>),
    Removed(String),
}

impl Sidebar {
    /// The rows that moved since the last look, and the runs that went away.
    ///
    /// One listing of the root and four metadata lookups per run; a run is read
    /// — its bounded summary, never its journal — only when one of them moved,
    /// and announced only when the row the sidebar shows came out different.
    fn poll(&mut self, store: &RunStore) -> Vec<RowChange> {
        let mut changes = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        let Ok(entries) = std::fs::read_dir(store.root()) else {
            return changes;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(run) = RunId::try_from(name.as_str()) else {
                continue;
            };
            let paths = store.paths_of(&run);
            let stamps = Stamps::of(&paths);
            if stamps.0[0].is_none() {
                continue;
            }
            seen.insert(name.clone());
            if self.rows.get(&name).is_some_and(|(held, _)| *held == stamps) {
                continue;
            }
            let Ok(summary) = RunSummary::of(&paths) else {
                continue;
            };
            let row: Arc<str> = payload::sidebar_row(&run, &summary, &paths).to_string().into();
            let moved = self.rows.get(&name).is_none_or(|(_, held)| *held != row);
            self.rows.insert(name, (stamps, Arc::clone(&row)));
            if moved && self.read {
                changes.push(RowChange::Changed(row));
            }
        }
        let gone: Vec<String> = self
            .rows
            .keys()
            .filter(|name| !seen.contains(*name))
            .cloned()
            .collect();
        for name in gone {
            self.rows.remove(&name);
            if self.read {
                changes.push(RowChange::Removed(name));
            }
        }
        self.read = true;
        changes
    }

    /// The rows, newest activity first, as a snapshot serves them.
    fn snapshot(&self) -> Vec<Value> {
        let mut rows: Vec<Value> = self
            .rows
            .values()
            .filter_map(|(_, row)| serde_json::from_str(row).ok())
            .collect();
        rows.sort_by(|left: &Value, right: &Value| {
            right["updated_at"]
                .as_str()
                .cmp(&left["updated_at"].as_str())
                .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
        });
        rows
    }
}

/// One subscribed run: its long-lived view, and each payload a subscription
/// shows of it.
struct LiveRun {
    run: RunId,
    view: RunView,
    indexed: Indexed,
    declared: DeclaredMembers,
    details: HashMap<String, Held<LiveDetail>>,
    timelines: Vec<(TimelineScope, String, Held<LiveTimeline>)>,
    channel: Option<Held<Value>>,
    channel_stamp: Vec<(PathBuf, u64, SystemTime)>,
    telemetry: Folded,
    agents: Option<Agents>,
    agents_stamp: Option<(u64, SystemTime)>,
    liveness: &'static str,
}

/// A payload, and the instant it was last read at — the envelope's
/// `observed_at`.
struct Held<T> {
    payload: T,
    observed_at: String,
}

/// The SDK's telemetry document, folded on its own clock.
struct Folded {
    document: Option<RunTelemetry>,
    served: Value,
    folded_at: Instant,
    stale: bool,
}

impl Folded {
    fn of(view: &RunView) -> Self {
        let aggregate = onepipeline::telemetry::of_run(&view.paths, &view.events);
        let document = RunId::try_from(view.paths.run.as_str())
            .ok()
            .and_then(|run| crate::telemetry::of_aggregate(&run, &aggregate).ok());
        Self {
            document,
            served: json!(aggregate),
            folded_at: Instant::now(),
            stale: false,
        }
    }

    fn inputs(&self, agents: Option<usize>) -> DetailInputs<'_> {
        DetailInputs {
            telemetry: self.document.as_ref(),
            sdk_telemetry: &self.served,
            agents,
        }
    }
}

impl LiveRun {
    fn open(store: &RunStore, run: &RunId) -> Result<Self, ApiError> {
        let view = store.view(run)?;
        let indexed = Indexed::of(&view);
        let declared = store.declared(&view);
        let paths = store.paths_of(run);
        let agents = onepipeline::verbs::agents(&paths, AgentScope::Run).ok();
        Ok(Self {
            run: run.clone(),
            telemetry: Folded::of(&view),
            liveness: view.liveness().as_str(),
            indexed,
            declared,
            details: HashMap::new(),
            timelines: Vec::new(),
            channel: None,
            channel_stamp: channel_stamp(&paths.channel_dir()),
            agents,
            agents_stamp: file_stamp(&paths.oneharness_sessions()),
            view,
        })
    }

    fn agent_count(&self) -> Option<usize> {
        self.agents.as_ref().map(|agents| agents.sessions.len())
    }

    /// Make sure the payloads `visible` shows are being kept, building any that
    /// are not, and answer the snapshot of them.
    fn ensure(&mut self, store: &RunStore, visible: &Visible, spec: Option<&crate::filter::FilterSpec>) -> Result<Value, ApiError> {
        let filter = RunStore::resolve(&self.view, spec)?;
        let detail_key = visible.detail_filter().to_owned();
        if !self.details.contains_key(&detail_key) {
            let detail_filter = if detail_key.is_empty() { EventFilter::default() } else { filter.clone() };
            let built = LiveDetail::build(
                &self.view,
                &self.indexed,
                &self.declared,
                detail_filter,
                &self.telemetry.inputs(self.agent_count()),
            );
            self.details.insert(detail_key.clone(), held(built));
        }
        let detail = enveloped(&self.details[&detail_key].payload.payload(), &self.details[&detail_key].observed_at);
        let run = self.run.as_str();
        match visible {
            Visible::Sidebar => Ok(json!({ "type": "sidebar" })),
            Visible::Detail { .. } => Ok(json!({ "type": "detail", "run_id": run, "detail": detail })),
            Visible::Timeline { scope, filter: key, .. } => {
                if let TimelineScope::Node(node) = scope {
                    let known = self.view.state.statuses().contains_key(node.as_str())
                        || self
                            .view
                            .events
                            .iter()
                            .any(|event| event.labels.node.as_deref() == Some(node.as_str()));
                    if !known {
                        return Err(ApiError::NodeNotFound(node.clone()));
                    }
                }
                let at = match self
                    .timelines
                    .iter()
                    .position(|(held_scope, held_key, _)| held_scope == scope && held_key == key)
                {
                    Some(at) => at,
                    None => {
                        let built = LiveTimeline::build(
                            &self.view,
                            &self.indexed,
                            &self.declared,
                            scope.clone(),
                            filter,
                            self.agents.as_ref(),
                        );
                        self.timelines.push((scope.clone(), key.clone(), held(built)));
                        self.timelines.len() - 1
                    }
                };
                let (_, _, timeline) = &self.timelines[at];
                let timeline = enveloped(timeline.payload.payload(), &timeline.observed_at);
                Ok(match scope {
                    TimelineScope::Run => json!({
                        "type": "timeline", "run_id": run, "scope": "run",
                        "detail": detail, "timeline": timeline,
                    }),
                    TimelineScope::Node(node) => json!({
                        "type": "timeline", "run_id": run, "scope": "node", "node": node,
                        "detail": detail, "timeline": timeline,
                    }),
                })
            }
            Visible::Channel { .. } => {
                if self.channel.is_none() {
                    let channel = channel_payload(store, &self.run)?;
                    self.channel = Some(held(channel));
                }
                let channel = self.channel.as_ref().map(|held| enveloped(&held.payload, &held.observed_at));
                Ok(json!({ "type": "channel", "run_id": run, "detail": detail, "channel": channel }))
            }
        }
    }
}

fn held<T>(payload: T) -> Held<T> {
    Held {
        payload,
        observed_at: payload::now_rfc3339(),
    }
}

/// A payload in the schema-version envelope every route serves it in.
fn enveloped(payload: &Value, observed_at: &str) -> Value {
    serde_json::to_value(Envelope {
        api_version: API_VERSION,
        telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
        observed_at: observed_at.to_owned(),
        payload,
    })
    .unwrap_or(Value::Null)
}

/// The channel route's payload, without its envelope.
fn channel_payload(store: &RunStore, run: &RunId) -> Result<Value, ApiError> {
    use crate::api::RunApi;
    store.channel(run).map(|envelope| envelope.payload)
}

fn file_stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let about = std::fs::metadata(path).ok()?;
    Some((about.len(), about.modified().ok()?))
}

/// Every file under a run's channel directory, and what each looks like: the
/// queue moves exactly when one of them does.
fn channel_stamp(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.metadata() {
                Ok(about) if about.is_dir() => pending.push(path),
                Ok(about) => {
                    if let Ok(modified) = about.modified() {
                        found.push((path, about.len(), modified));
                    }
                }
                Err(_) => {}
            }
        }
    }
    found.sort();
    found
}

/// What a stream asked for a subscription it cannot have is told: `410` with
/// `{code: "subscription-unavailable", reason}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// It was disconnected for longer than the grace.
    Expired,
    /// The cursor names another process's epoch: this server restarted.
    ServerRestarted,
    /// Nothing this process can say about it.
    Unknown,
}

impl Unavailable {
    /// The reason as the body names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::ServerRestarted => "server-restarted",
            Self::Unknown => "unknown",
        }
    }
}

/// An open stream: the frames to replay, and the receiver the rest arrive on.
pub struct Stream {
    /// Frames to send before anything new, in order.
    pub replay: Vec<Event>,
    /// Every frame emitted after the replay.
    pub frames: mpsc::Receiver<Event>,
}

/// How many frames a connection may fall behind before it is dropped to
/// reconnect and replay — never more than the subscription retains.
const CONNECTION_BUFFER: usize = RETAINED_FRAMES;

impl Hub {
    /// A hub over `store`, ending its streams once `stopping` is set.
    #[must_use]
    pub fn new(store: RunStore, stopping: Arc<AtomicBool>) -> Self {
        Self(Arc::new(Shared {
            store,
            epoch: EventId::fresh_epoch(),
            stopping,
            state: Mutex::new(State {
                next: 0,
                subscriptions: HashMap::new(),
                retired: VecDeque::new(),
            }),
            sidebar: Mutex::new(Sidebar::default()),
            runs: Mutex::new(HashMap::new()),
            polling: AtomicBool::new(false),
            trace: std::env::var_os(TRACE_ENV).map(PathBuf::from),
            refold: std::env::var(TELEMETRY_REFOLD_ENV)
                .ok()
                .and_then(|ms| ms.parse().ok())
                .map_or(TELEMETRY_REFOLD, Duration::from_millis),
        }))
    }

    fn id(&self, seq: u64) -> String {
        EventId {
            epoch: self.0.epoch,
            seq,
        }
        .to_string()
    }

    /// `POST /api/v2/subscriptions`: the subscription and its initial state.
    ///
    /// # Errors
    ///
    /// `404 run_not_found` for a run that is not under the root, `404
    /// node_not_found` for a node scope naming a node the run does not carry,
    /// and the filter's refusal for a profile the run does not have.
    pub fn subscribe(&self, request: &SubscribeRequest) -> Result<Value, ApiError> {
        let shared = &self.0;
        let visible = Visible::of(&request.view);
        let spec = match &request.view {
            SubscriptionView::Detail { filter, .. } | SubscriptionView::Timeline { filter, .. } => filter.as_ref(),
            _ => None,
        };
        // The run's reading first, outside every other lock: opening a long
        // journal takes seconds, and nothing else waits on it.
        let live = match visible.run() {
            None => None,
            Some(run) => {
                let run = RunId::try_from(run)?;
                let live = self.live_run(&run)?;
                lock(&live).ensure(&shared.store, &visible, spec)?;
                Some(live)
            }
        };
        // Then the publication boundary: the sidebar, the run and the
        // subscriptions locked together, so every change after the snapshot is
        // one this subscription is sent and none before it is.
        let mut sidebar = lock(&shared.sidebar);
        if !sidebar.read {
            sidebar.poll(&shared.store);
        }
        let mut run = live.as_ref().map(|live| lock(live));
        let visible_state = match run.as_mut() {
            Some(run) => run.ensure(&shared.store, &visible, spec)?,
            None => json!({ "type": "sidebar" }),
        };
        let rows = sidebar.snapshot();
        let mut state = lock(&shared.state);
        let seq = state.next;
        state.next += 1;
        let subscription = SubscriptionId::mint();
        if let Some(replaced) = request.replaces {
            state.retire(replaced, Retired::Retired);
        }
        state.subscriptions.insert(
            subscription,
            Subscription {
                view: request.view.clone(),
                first: seq,
                last: seq,
                boundary: seq,
                frames: VecDeque::new(),
                connection: None,
                // Recording from now, for at most the grace, until a stream
                // connects.
                disconnected_at: Some(Instant::now()),
            },
        );
        drop(state);
        drop(run);
        drop(sidebar);
        self.start_polling();
        let id = self.id(seq);
        let snapshot = json!({ "id": id, "sidebar": rows, "visible": visible_state });
        let initial = match request.resume {
            None => json!({ "type": "snapshot", "snapshot": snapshot }),
            Some(resume) => {
                let reason = if resume.epoch == shared.epoch {
                    "unknown-cursor"
                } else {
                    "server-restarted"
                };
                json!({
                    "type": "reset", "id": id, "base": resume.to_string(),
                    "subscription": subscription, "reason": reason, "snapshot": snapshot,
                })
            }
        };
        Ok(json!({
            "subscription": subscription,
            "view": request.view.to_json(),
            "initial": initial,
        }))
    }

    /// `DELETE /api/v2/subscriptions/{subscription}`: retire it, whether or not
    /// it was still held.
    pub fn retire(&self, subscription: SubscriptionId) {
        lock(&self.0.state).retire(subscription, Retired::Retired);
    }

    /// `GET /api/v2/events?subscription=`: the frames after `after`, then the
    /// rest as they come.
    ///
    /// # Errors
    ///
    /// Why the subscription cannot be streamed, which the route serves as `410`.
    pub fn connect(&self, subscription: SubscriptionId, after: Option<EventId>) -> Result<Stream, Unavailable> {
        let shared = &self.0;
        // A reset reads the run's state, so the run is locked before the
        // subscriptions, as every tick locks them.
        let view = lock(&shared.state)
            .subscriptions
            .get(&subscription)
            .map(|held| held.view.clone());
        let Some(view) = view else {
            let state = lock(&shared.state);
            return Err(match state.retired.iter().find(|(id, _)| *id == subscription) {
                Some((_, Retired::Expired)) => Unavailable::Expired,
                _ if after.is_some_and(|after| after.epoch != shared.epoch) => Unavailable::ServerRestarted,
                _ => Unavailable::Unknown,
            });
        };
        let visible = Visible::of(&view);
        let live = visible.run().and_then(|run| lock(&shared.runs).get(run).cloned());
        let sidebar = lock(&shared.sidebar);
        let mut run = live.as_ref().map(|live| lock(live));
        let mut state = lock(&shared.state);
        let Some(held) = state.subscriptions.get(&subscription) else {
            return Err(Unavailable::Unknown);
        };
        let (sender, frames) = mpsc::channel(CONNECTION_BUFFER);
        let first = held.first;
        let last = held.last;
        let boundary = held.boundary;
        let resumable = after.filter(|after| after.epoch == shared.epoch).map(|after| after.seq);
        let mut replay = Vec::new();
        let reset_reason = match (after, resumable) {
            (None, _) => None,
            (Some(_), None) => Some("server-restarted"),
            (Some(_), Some(seq)) if seq > last || seq < first => Some("unknown-cursor"),
            (Some(_), Some(seq)) if seq < boundary => Some("stale-cursor"),
            (Some(_), Some(seq)) if seq == boundary || held.frames.iter().any(|frame| frame.seq == seq) => None,
            (Some(_), Some(_)) => Some("unknown-cursor"),
        };
        match (reset_reason, after) {
            (Some(reason), Some(after)) => {
                // One explicit re-send, named, and the new base from here on.
                let visible_state = match run.as_mut() {
                    Some(run) => run.ensure(&shared.store, &visible, spec_of(&view)).ok(),
                    None => Some(json!({ "type": "sidebar" })),
                };
                let seq = state.next;
                state.next += 1;
                let id = self.id(seq);
                let data = json!({
                    "id": id, "base": after.to_string(), "subscription": subscription,
                    "type": "reset", "reason": reason,
                    "snapshot": { "id": id, "sidebar": sidebar.snapshot(), "visible": visible_state },
                })
                .to_string();
                let held = state.subscriptions.get_mut(&subscription).expect("held above");
                held.frames.clear();
                held.first = seq;
                held.last = seq;
                held.boundary = seq;
                replay.push(Event::default().id(id).event("reset").data(data));
            }
            _ => {
                let from = resumable.unwrap_or(first);
                replay.extend(
                    held.frames
                        .iter()
                        .filter(|frame| frame.seq > from)
                        .map(|frame| frame_event(&self.id(frame.seq), frame.kind, &frame.data)),
                );
            }
        }
        let held = state.subscriptions.get_mut(&subscription).expect("held above");
        held.connection = Some(sender);
        held.disconnected_at = None;
        drop(state);
        drop(run);
        drop(sidebar);
        self.start_polling();
        Ok(Stream { replay, frames })
    }

    /// The reading of `run`, opened if no subscription holds it yet.
    fn live_run(&self, run: &RunId) -> Result<Arc<Mutex<LiveRun>>, ApiError> {
        if let Some(live) = lock(&self.0.runs).get(run.as_str()) {
            return Ok(Arc::clone(live));
        }
        let opened = Arc::new(Mutex::new(LiveRun::open(&self.0.store, run)?));
        Ok(Arc::clone(
            lock(&self.0.runs)
                .entry(run.as_str().to_owned())
                .or_insert(opened),
        ))
    }

    fn start_polling(&self) {
        if self.0.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        let hub = self.clone();
        std::thread::Builder::new()
            .name("subscriptions".to_owned())
            .spawn(move || hub.poll_forever())
            .ok();
    }

    fn poll_forever(&self) {
        loop {
            std::thread::sleep(self.0.store.poll());
            if self.0.stopping.load(Ordering::Relaxed) {
                // Every stream ends, so a shutdown is not held open by a tab.
                for held in lock(&self.0.state).subscriptions.values_mut() {
                    held.connection = None;
                }
                return;
            }
            self.tick();
        }
    }

    /// One look at everything subscribed.
    fn tick(&self) {
        let shared = &self.0;
        let wanted: Vec<Visible> = {
            let mut state = lock(&shared.state);
            state.expire();
            state.subscriptions.values().map(|held| Visible::of(&held.view)).collect()
        };
        // Runs no subscription shows any more are let go.
        lock(&shared.runs).retain(|run, _| wanted.iter().any(|visible| visible.run() == Some(run.as_str())));
        if wanted.is_empty() {
            return;
        }
        {
            let mut sidebar = lock(&shared.sidebar);
            let changes = sidebar.poll(&shared.store);
            if !changes.is_empty() {
                let mut state = lock(&shared.state);
                let ids: Vec<SubscriptionId> = state.subscriptions.keys().copied().collect();
                for change in &changes {
                    let change = match change {
                        RowChange::Changed(row) => Change {
                            kind: "run.changed",
                            members: format!("\"row\":{row}"),
                        },
                        RowChange::Removed(run) => Change::new("run.removed", &json!({ "run_id": run })),
                    };
                    for id in &ids {
                        self.emit(&mut state, *id, &change);
                    }
                }
            }
        }
        let runs: Vec<Arc<Mutex<LiveRun>>> = lock(&shared.runs).values().cloned().collect();
        for live in runs {
            self.refresh(&live);
        }
    }

    /// Refresh one run and push what moved to every subscription showing it.
    fn refresh(&self, live: &Arc<Mutex<LiveRun>>) {
        let shared = &self.0;
        let mut run = lock(live);
        let run = &mut *run;
        let started = Instant::now();
        let outcome = run.view.refresh();
        let paths = run.view.paths.clone();
        let touched = match outcome {
            Ok(Refreshed::Unchanged) => Some(Touched::default()),
            Ok(Refreshed::Appended { first }) => Some(run.indexed.extend(&run.view, first)),
            Ok(Refreshed::Reread) => {
                run.indexed = Indexed::of(&run.view);
                run.declared = shared.store.declared(&run.view);
                None
            }
            Err(_) => {
                // The run went away: its row's removal reaches every sidebar,
                // and the view showing it is left as it was.
                lock(&shared.runs).remove(run.run.as_str());
                return;
            }
        };
        if touched.as_ref().is_some_and(Touched::any) || touched.is_none() {
            run.telemetry.stale = true;
        }
        let agents_stamp = file_stamp(&paths.oneharness_sessions());
        let agents_moved = agents_stamp != run.agents_stamp;
        if agents_moved {
            run.agents_stamp = agents_stamp;
            run.agents = onepipeline::verbs::agents(&paths, AgentScope::Run).ok();
        }
        let liveness = run.view.liveness().as_str();
        let liveness_moved = liveness != run.liveness;
        run.liveness = liveness;
        let refold = run.telemetry.stale && run.telemetry.folded_at.elapsed() >= shared.refold;
        let mut folded_ms = None;
        if refold {
            let folding = Instant::now();
            run.telemetry = Folded::of(&run.view);
            folded_ms = Some(folding.elapsed().as_secs_f64() * 1000.0);
        }
        let moved = touched.as_ref().is_none_or(Touched::any) || agents_moved || liveness_moved || refold;
        let channel_stamp = if run.channel.is_some() { channel_stamp(&paths.channel_dir()) } else { Vec::new() };
        let channel_moved = run.channel.is_some() && channel_stamp != run.channel_stamp;
        if !moved && !channel_moved {
            return;
        }
        let now = payload::now_rfc3339();
        let mut changes: Vec<(Visible, Change)> = Vec::new();
        let mut rebuilt_whole = Vec::new();
        let mut rendered = 0;
        let mut ops_count = 0;
        if moved {
            let agents = run.agent_count();
            let LiveRun { view, indexed, declared, details, timelines, telemetry, agents: agent_list, .. } = run;
            for (key, detail) in details.iter_mut() {
                let ops = detail.payload.refreshed(view, indexed, declared, touched.as_ref(), &telemetry.inputs(agents));
                if touched.is_none() {
                    rebuilt_whole.push(format!("detail:{key}"));
                }
                if let Some(change) = patch_change("detail.patch", &mut detail.observed_at, &now, ops, |members| {
                    members["run_id"] = json!(view.paths.run);
                }) {
                    ops_count += 1;
                    changes.push((Visible::Detail { run: view.paths.run.clone(), filter: key.clone() }, change));
                }
            }
            for (scope, key, timeline) in timelines.iter_mut() {
                let before = timeline.payload.rendered();
                let ops = timeline.payload.refreshed(
                    view,
                    indexed,
                    declared,
                    touched.as_ref(),
                    agent_list.as_ref(),
                    agents_moved || liveness_moved,
                );
                rendered += timeline.payload.rendered() - before;
                if touched.is_none() {
                    rebuilt_whole.push(format!("timeline:{key}"));
                }
                let scope_members = scope.clone();
                if let Some(change) = patch_change("timeline.patch", &mut timeline.observed_at, &now, ops, |members| {
                    members["run_id"] = json!(view.paths.run);
                    match &scope_members {
                        TimelineScope::Run => members["scope"] = json!("run"),
                        TimelineScope::Node(node) => {
                            members["scope"] = json!("node");
                            members["node"] = json!(node);
                        }
                    }
                }) {
                    ops_count += 1;
                    changes.push((
                        Visible::Timeline { run: view.paths.run.clone(), scope: scope.clone(), filter: key.clone() },
                        change,
                    ));
                }
            }
        }
        if channel_moved {
            run.channel_stamp = channel_stamp;
            if let (Ok(now_channel), Some(held)) = (channel_payload(&shared.store, &run.run), run.channel.as_mut()) {
                let mut ops = Vec::new();
                crate::patch::diff(&held.payload, &now_channel, &mut ops);
                held.payload = now_channel;
                if let Some(change) = patch_change("channel.patch", &mut held.observed_at, &now, ops, |members| {
                    members["run_id"] = json!(run.run);
                }) {
                    changes.push((Visible::Channel { run: run.run.as_str().to_owned() }, change));
                }
            }
        }
        if !changes.is_empty() {
            let mut state = lock(&shared.state);
            let reach: Vec<(SubscriptionId, Visible)> = state
                .subscriptions
                .iter()
                .map(|(id, held)| (*id, Visible::of(&held.view)))
                .collect();
            for (id, visible) in reach {
                for (target, change) in &changes {
                    if reaches(&visible, target) {
                        self.emit(&mut state, id, change);
                    }
                }
            }
        }
        self.trace(&json!({
            "run": run.run,
            "refresh": match outcome {
                Ok(Refreshed::Appended { .. }) => "appended",
                Ok(Refreshed::Reread) => "reread",
                _ => "unchanged",
            },
            "records": touched.as_ref().map_or(run.view.events.len(), |touched| touched.records),
            "rendered": rendered,
            "whole": rebuilt_whole,
            "telemetry_fold_ms": folded_ms,
            "patches": ops_count,
            "ms": started.elapsed().as_secs_f64() * 1000.0,
        }));
    }

    fn trace(&self, line: &Value) {
        let Some(path) = &self.0.trace else { return };
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(file, "{line}");
        }
    }

    /// Send `change` to one subscription, retaining it for a reconnect.
    fn emit(&self, state: &mut State, subscription: SubscriptionId, change: &Change) {
        let seq = state.next;
        state.next += 1;
        let id = self.id(seq);
        let Some(held) = state.subscriptions.get_mut(&subscription) else {
            return;
        };
        let base = self.id(held.last);
        held.last = seq;
        let data: Arc<str> = format!(
            "{{\"id\":\"{id}\",\"base\":\"{base}\",\"subscription\":\"{subscription}\",\"type\":\"{}\",{}}}",
            change.kind, change.members
        )
        .into();
        held.frames.push_back(Retained {
            seq,
            kind: change.kind,
            data: Arc::clone(&data),
        });
        while held.frames.len() > RETAINED_FRAMES {
            if let Some(oldest) = held.frames.pop_front() {
                held.boundary = oldest.seq;
            }
        }
        if let Some(connection) = &held.connection {
            if connection.try_send(frame_event(&id, change.kind, &data)).is_err() {
                // Gone, or too far behind: it reconnects and replays from what
                // is retained.
                held.connection = None;
                held.disconnected_at = Some(Instant::now());
            }
        }
    }
}

/// Whether a subscription showing `visible` is sent a change to `target`.
fn reaches(visible: &Visible, target: &Visible) -> bool {
    match target {
        Visible::Detail { run, filter } => {
            visible.run() == Some(run.as_str()) && visible.detail_filter() == filter && !matches!(visible, Visible::Sidebar)
        }
        other => visible == other,
    }
}

fn spec_of(view: &SubscriptionView) -> Option<&crate::filter::FilterSpec> {
    match view {
        SubscriptionView::Detail { filter, .. } | SubscriptionView::Timeline { filter, .. } => filter.as_ref(),
        _ => None,
    }
}

/// A patch frame's change, with `observed_at` moved to the instant it was read
/// — or nothing, where nothing moved.
fn patch_change(
    kind: &'static str,
    observed_at: &mut String,
    now: &str,
    mut ops: Vec<Op>,
    members: impl FnOnce(&mut Value),
) -> Option<Change> {
    if ops.is_empty() {
        return None;
    }
    *observed_at = now.to_owned();
    ops.push(Op::Set {
        path: vec![crate::patch::Step::Key("observed_at".to_owned())],
        value: json!(now),
    });
    let mut body = json!({});
    members(&mut body);
    body["ops"] = Value::Array(ops.iter().map(Op::to_json).collect());
    Some(Change::new(kind, &body))
}

fn frame_event(id: &str, kind: &str, data: &str) -> Event {
    Event::default().id(id).event(kind).data(data)
}

impl State {
    fn retire(&mut self, subscription: SubscriptionId, why: Retired) {
        if self.subscriptions.remove(&subscription).is_some() {
            self.retired.push_back((subscription, why));
            while self.retired.len() > RETIRED_REMEMBERED {
                self.retired.pop_front();
            }
        }
    }

    /// Retire every subscription disconnected for longer than the grace, and
    /// notice the connections that went away.
    fn expire(&mut self) {
        let now = Instant::now();
        for held in self.subscriptions.values_mut() {
            if held.connection.as_ref().is_some_and(mpsc::Sender::is_closed) {
                held.connection = None;
                held.disconnected_at = Some(now);
            }
        }
        let expired: Vec<SubscriptionId> = self
            .subscriptions
            .iter()
            .filter(|(_, held)| held.disconnected_at.is_some_and(|at| now.duration_since(at) > DISCONNECTED_GRACE))
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            self.retire(id, Retired::Expired);
        }
    }
}

/// A lock poisoned by a panicking reader is still the state every other
/// subscription is being served from.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
