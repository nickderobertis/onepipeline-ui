//! Subscriptions: the sidebar and at most one visible view per tab, kept current
//! by pushing what changed.
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
//! `payload::live`. A run nobody shows is never opened, and two tabs on
//! one view share one reading of it.
//!
//! The SDK's telemetry document is the one part of a detail that folds the whole
//! journal however little moved. It is folded when a view first needs it, and
//! again once something moved: on the first tick at least [`TELEMETRY_REFOLD`]
//! after the last fold that carries no change, or once it is twice that behind
//! on a run that never goes quiet — so no change waits on it.
//!
//! Action items is one more view on the same subscription and the same poller,
//! over no run at all. While a tab holds it, each tick looks at the metadata of
//! the engine's human-item journal, and only once that moved reads each distinct
//! view through the engine and sends what differs. Without such a tab, none of it
//! runs.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use axum::response::sse::Event;
use onepipeline::agents::{AgentScope, Agents};
use onepipeline::human_items::HumanItemFilter;
use onepipeline::views::{Refreshed, RunPaths, RunSummary, RunView};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::contract::{
    EventId, HumanItemId, NodeId, RunId, SubscribeOrigin, SubscribeRequest, SubscriptionId,
    SubscriptionView, ViewScope, API_VERSION, DETAIL_FIRST_LOADING, DISCONNECTED_GRACE,
    NODE_WINDOW_EVENTS, RETAINED_FRAMES, SPANS_HARNESS_LOADING, TELEMETRY_SCHEMA_VERSION,
};
use crate::error::ApiError;
use crate::filter::EventFilter;
use crate::patch::Op;
use crate::payload::live::{
    DetailInputs, Indexed, LiveDetail, LiveTimeline, TimelineScope, Touched,
};
use crate::payload::{self, ActivityFold, DeclaredMembers, ItemsWindow};
use crate::store::RunStore;
use crate::telemetry::RunTelemetry;

mod first_screen;
mod history;
mod progressive;

/// How long the SDK's whole-journal telemetry fold is left behind the run once
/// something moved: it is folded again on the first tick after this that carries
/// no change, and at the latest at twice this on a run that never goes quiet —
/// so the detail's `telemetry`, and the timing and usage its `run` reads off it,
/// follow the journal without any change waiting on the fold.
pub const TELEMETRY_REFOLD: Duration = Duration::from_secs(10);

/// How many retired subscription ids are remembered, so a stream asked for one
/// is told it expired rather than that it never existed.
const RETIRED_REMEMBERED: usize = 4096;

/// The environment variable that sets [`TELEMETRY_REFOLD`] in milliseconds,
/// for a reader that must see the telemetry follow every change — the journeys
/// that hold a patched detail to a fresh read. `0` refolds on every change.
pub const TELEMETRY_REFOLD_ENV: &str = "ONEPIPELINE_UI_TELEMETRY_REFOLD_MS";

/// The environment variable that sets [`DISCONNECTED_GRACE`] in milliseconds,
/// for the journey that watches a disconnected subscription expire without
/// waiting out the contract's two minutes. Unset, the contract's grace holds.
pub const DISCONNECTED_GRACE_ENV: &str = "ONEPIPELINE_UI_SUBSCRIPTION_GRACE_MS";

/// The environment variable that delays a run's complete read by this many
/// milliseconds after its first answer, for a journey that must act while it is
/// outstanding. Unset, it starts at once.
pub const COMPLETE_READ_HOLD_ENV: &str = "ONEPIPELINE_UI_COMPLETE_READ_HOLD_MS";

/// The environment variable that sets the length in bytes up to which a run's
/// journal is read whole for its first answer, rather than as its heads, for a
/// journey that holds a long run's first answer to the one a whole read gives.
/// Unset, [`WHOLE_READ_BYTES`] holds.
pub const WHOLE_READ_ENV: &str = "ONEPIPELINE_UI_WHOLE_READ_BYTES";

/// The environment variable that holds a refold off for this many milliseconds
/// after the fold went stale — the first record it has not folded — for a
/// journey that watches the fold fall overdue. Counted from that record rather
/// than from the last fold, so the overdue state is drawn before the held refold
/// lands however long a loaded host takes to see the record. Unset, nothing
/// holds it.
pub const FOLD_HOLD_ENV: &str = "ONEPIPELINE_UI_TELEMETRY_FOLD_HOLD_MS";

/// How many refold intervals behind the fold may fall before its values draw as
/// loading: `TELEMETRY_REFOLD`'s 10 s makes this the contract's 40 s.
const OVERDUE_INTERVALS: u32 = 4;

/// The environment variable naming a file the poller appends one JSON line to
/// per refresh that moved something: what the refresh read, what each payload
/// rebuilt, and what that cost. Passive: nothing reads it back, and unset it
/// costs nothing.
pub const TRACE_ENV: &str = "ONEPIPELINE_UI_LIVE_TRACE";

/// How long a run opened for a page's document is kept for the subscription that
/// page makes: a page that never subscribes lets it go then.
const PREPARED_HOLD: Duration = Duration::from_secs(30);

/// The most runs opened ahead of their subscriptions at once: a document is cheap
/// to ask for and a long run's opening is not, so asking for many does not open many.
const PREPARED_RUNS: usize = 2;

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
    /// The sidebar's rows. Taken before a run or the state, and held only to
    /// read or change them — never across a [`Look`].
    sidebar: Mutex<Sidebar>,
    /// Held across one whole [`Look`] and the change it makes to the sidebar,
    /// so two looks never read against the same rows. Taken before the
    /// sidebar, and by nothing that answers a stream.
    looking: Mutex<()>,
    /// Each subscribed run's reading. The map is held only to look one up.
    runs: Mutex<HashMap<RunId, Arc<Mutex<LiveRun>>>>,
    /// Runs a page's document named, opening or opened ahead of the subscription
    /// that page makes ([`Hub::prepare`]). Held only to look one up, and never with
    /// another lock.
    prepared: Mutex<HashMap<RunId, Arc<Prepared>>>,
    /// The human-item views subscriptions show. Taken where a run is — after the
    /// sidebar and before the state — and held across the engine's reads of it,
    /// so two looks never send one change twice.
    human_items: Mutex<HumanItemsReading>,
    polling: AtomicBool,
    trace: Option<PathBuf>,
    refold: Duration,
    /// The least age a fold reaches before it may be taken again.
    fold_hold: Duration,
    /// How long a complete read waits before it starts.
    complete_hold: Duration,
    /// The longest journal a first answer reads whole.
    whole_read: u64,
    /// How long a disconnected subscription keeps recording before it expires.
    grace: Duration,
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
    link: Link,
    /// Frames held behind this subscription's `sidebar.snapshot`, for a run
    /// view whose snapshot said `sidebar: null`; `None` once it has gone out.
    deferred: Option<Vec<Change>>,
}

impl Subscription {
    /// Why a stream asking for the frames after `after` is answered with a reset
    /// rather than a replay, or `None` where what is retained answers it.
    fn reset_reason(&self, after: Option<EventId>, epoch: uuid::Uuid) -> Option<ResetReason> {
        let after = after?;
        if after.epoch != epoch {
            return Some(ResetReason::ServerRestarted);
        }
        let seq = after.seq;
        if seq > self.last || seq < self.first {
            Some(ResetReason::UnknownCursor)
        } else if seq < self.boundary {
            Some(ResetReason::StaleCursor)
        } else if seq == self.boundary || self.frames.iter().any(|frame| frame.seq == seq) {
            None
        } else {
            Some(ResetReason::UnknownCursor)
        }
    }
}

/// Whether a subscription's stream is open: connected to the sender its
/// frames go to, or disconnected since an instant its grace runs from — never
/// both, and never neither.
enum Link {
    Connected(mpsc::Sender<Event>),
    Disconnected(Instant),
}

impl Link {
    fn drop_now() -> Self {
        Self::Disconnected(Instant::now())
    }
}

#[derive(Clone)]
struct Retained {
    seq: u64,
    kind: FrameKind,
    data: Arc<str>,
}

/// Why a stream was answered with one whole re-send rather than a replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResetReason {
    /// A cursor this subscription never issued, or none it still holds.
    UnknownCursor,
    /// A cursor older than the frames it retains.
    StaleCursor,
    /// A cursor another process issued.
    ServerRestarted,
}

impl ResetReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::UnknownCursor => "unknown-cursor",
            Self::StaleCursor => "stale-cursor",
            Self::ServerRestarted => "server-restarted",
        }
    }
}

/// Every type of frame a subscription stream carries, as its SSE event name
/// and its data's `type` spell it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    RunChanged,
    RunRemoved,
    DetailPatch,
    TimelinePatch,
    ChannelPatch,
    SidebarSnapshot,
    // llmlint: ignore[code_lands_in_the_domain_that_owns_it] the subscription protocol is one closed contract, `docs/contract.md`'s, and the plan names this file's `FrameKind` as the one declaration of the frame; reading and diffing the view stay in the poller the frame goes out on, and the records stay the engine's.
    HumanItemsPatch,
    Reset,
}

impl FrameKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::RunChanged => "run.changed",
            Self::RunRemoved => "run.removed",
            Self::DetailPatch => "detail.patch",
            Self::TimelinePatch => "timeline.patch",
            Self::ChannelPatch => "channel.patch",
            Self::SidebarSnapshot => "sidebar.snapshot",
            Self::HumanItemsPatch => "human-items.patch",
            Self::Reset => "reset",
        }
    }
}

/// One change, as every subscription it reaches is sent it: each frame type
/// with the members it carries besides the common three, and no other pairing.
#[derive(Clone)]
enum Change {
    /// A run view's sidebar rows, as its stream's first frame.
    SidebarRows(Arc<str>),
    /// One complete trimmed row, already serialized.
    Row(Arc<str>),
    Removed(RunId),
    Detail {
        run: RunId,
        ops: Vec<Op>,
    },
    Timeline {
        run: RunId,
        scope: TimelineScope,
        ops: Vec<Op>,
    },
    Channel {
        run: RunId,
        ops: Vec<Op>,
    },
    // llmlint: ignore-block[code_lands_in_the_domain_that_owns_it] the subscription protocol is one closed contract, `docs/contract.md`'s, and the plan names this file's `FrameKind` as the one declaration of the frame; this is that frame's payload, closed as the frames are.
    HumanItems {
        ops: Vec<Op>,
    },
    // llmlint: ignore-end[code_lands_in_the_domain_that_owns_it]
}

impl Change {
    fn kind(&self) -> FrameKind {
        match self {
            Self::SidebarRows(_) => FrameKind::SidebarSnapshot,
            Self::Row(_) => FrameKind::RunChanged,
            Self::Removed(_) => FrameKind::RunRemoved,
            Self::Detail { .. } => FrameKind::DetailPatch,
            Self::Timeline { .. } => FrameKind::TimelinePatch,
            Self::Channel { .. } => FrameKind::ChannelPatch,
            Self::HumanItems { .. } => FrameKind::HumanItemsPatch,
        }
    }

    /// `"run_id": …, "ops": […]` — the frame's own members, without braces.
    fn members(&self) -> String {
        let wire = |ops: &[Op]| Value::Array(ops.iter().map(Op::to_json).collect());
        let object = match self {
            Self::SidebarRows(rows) => return format!("\"rows\":{rows}"),
            Self::Row(row) => return format!("\"row\":{row}"),
            Self::Removed(run) => json!({ "run_id": run }),
            Self::Detail { run, ops } | Self::Channel { run, ops } => {
                json!({ "run_id": run, "ops": wire(ops) })
            }
            Self::Timeline {
                run,
                scope: TimelineScope::Run,
                ops,
            } => json!({ "run_id": run, "scope": "run", "ops": wire(ops) }),
            Self::Timeline {
                run,
                scope: TimelineScope::Node(node),
                ops,
            } => json!({ "run_id": run, "scope": "node", "node": node, "ops": wire(ops) }),
            Self::Timeline { .. } => json!({}),
            Self::HumanItems { ops } => json!({ "ops": wire(ops) }),
        };
        let text = object.to_string();
        text[1..text.len() - 1].to_owned()
    }
}

/// A filter's normalized spelling, which the payloads a run keeps are keyed
/// by: made only from a parsed [`FilterSpec`](crate::filter::FilterSpec), and
/// empty for a view that names none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
struct FilterKey(String);

impl FilterKey {
    fn of(spec: Option<&crate::filter::FilterSpec>) -> Self {
        Self(
            spec.map(crate::filter::FilterSpec::as_query_value)
                .unwrap_or_default(),
        )
    }

    fn names_none(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Display for FilterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What a subscription is shown: its view's run and which of that run's
/// payloads it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Visible {
    Sidebar,
    Detail {
        run: RunId,
        filter: FilterKey,
    },
    Timeline {
        run: RunId,
        scope: TimelineScope,
        filter: FilterKey,
    },
    Channel {
        run: RunId,
    },
    // llmlint: ignore[code_lands_in_the_domain_that_owns_it] the subscription protocol is one closed contract, `docs/contract.md`'s, and the plan names this file's `FrameKind` as the one declaration of the frame; a subscription shows one of a closed set of views, and this is the one that frame patches.
    HumanItems(HumanItemsKey),
}

/// Which human-item view a subscription shows: tabs showing the same one share
/// one reading of it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HumanItemsKey {
    /// The filter as the engine serializes it, which is the one spelling a
    /// filter has.
    filter: String,
    item: Option<HumanItemId>,
}

impl HumanItemsKey {
    fn of(filter: &HumanItemFilter, item: Option<&HumanItemId>) -> Self {
        Self {
            filter: json!(filter).to_string(),
            item: item.cloned(),
        }
    }
}

impl Visible {
    fn of(view: &SubscriptionView) -> Self {
        let filter = |filter: &Option<crate::filter::FilterSpec>| FilterKey::of(filter.as_ref());
        match view {
            SubscriptionView::Sidebar => Self::Sidebar,
            SubscriptionView::Detail {
                run_id,
                filter: spec,
            } => Self::Detail {
                run: run_id.clone(),
                filter: filter(spec),
            },
            SubscriptionView::Timeline {
                run_id,
                scope,
                filter: spec,
            } => Self::Timeline {
                run: run_id.clone(),
                scope: match scope {
                    ViewScope::Run => TimelineScope::Run,
                    ViewScope::Node(node) => TimelineScope::Node(node.clone()),
                },
                filter: filter(spec),
            },
            SubscriptionView::Channel { run_id } => Self::Channel {
                run: run_id.clone(),
            },
            SubscriptionView::HumanItems { filter, item } => {
                Self::HumanItems(HumanItemsKey::of(filter, item.as_ref()))
            }
        }
    }

    fn run(&self) -> Option<&str> {
        self.run_id().map(RunId::as_str)
    }

    fn run_id(&self) -> Option<&RunId> {
        match self {
            Self::Sidebar | Self::HumanItems(_) => None,
            Self::Detail { run, .. } | Self::Timeline { run, .. } | Self::Channel { run } => {
                Some(run)
            }
        }
    }

    /// The filter its detail is read under: the timeline's for a timeline, and
    /// none for the channel's header.
    fn detail_filter(&self) -> FilterKey {
        match self {
            Self::Detail { filter, .. } | Self::Timeline { filter, .. } => filter.clone(),
            Self::Sidebar | Self::Channel { .. } | Self::HumanItems(_) => FilterKey::default(),
        }
    }
}

/// Every human-item view a subscription shows, and what the engine's journal
/// looked like when they were last read.
#[derive(Default)]
struct HumanItemsReading {
    stamp: Option<(u64, SystemTime)>,
    views: HashMap<HumanItemsKey, HeldHumanItems>,
    /// Whether the last read was refused, so a refusal is reported once per
    /// spell rather than every tick it lasts.
    failing: bool,
}

/// One human-item view: what it selects, and the `visible` its tabs hold.
struct HeldHumanItems {
    filter: HumanItemFilter,
    item: Option<HumanItemId>,
    visible: Value,
}

impl HeldHumanItems {
    /// The `visible` this view shows now, as the engine reads it.
    fn read(&self, items: &crate::human_items::HumanItems) -> Result<Value, ApiError> {
        let (listed, detail) = items.view(&self.filter, self.item.as_ref())?;
        Ok(json!({ "type": "human-items", "items": listed, "detail": detail }))
    }
}

/// The sidebar: one trimmed row per run under the root, and what each run's
/// files looked like when its row was read.
#[derive(Default)]
struct Sidebar {
    read: bool,
    /// Each run's row, what its files looked like when it was read, and when.
    rows: BTreeMap<RunId, (Stamps, Arc<str>, Instant)>,
}

/// How many polls pass between two readings of one run's sidebar row.
///
/// A row is read again at most this often however often its run moves: the
/// sidebar shows state, counts and activity, which a few seconds' coalescing
/// leaves as they were, while a run appending every second would otherwise be
/// read — and its row pushed to every tab — every poll. The open run's own
/// view is patched every poll regardless.
pub const ROW_POLLS_PER_READ: u32 = 10;

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
    Removed(RunId),
}

/// What one look at the runs root read: each run whose row was read again,
/// and every run the root holds.
///
/// Read with no lock but [`Shared::looking`] held, because reading a moved run's
/// summary is the SDK folding it and writing its cache back, which a host with
/// slow syncs takes seconds over per run — and a stream or a subscription that
/// waited on the sidebar for the whole of that would be a request left
/// unanswered for as long as the slowest look takes.
struct Look {
    read: Vec<(RunId, Stamps, Arc<str>)>,
    seen: std::collections::BTreeSet<RunId>,
    /// The runs the sidebar held when the look began: the only ones its
    /// listing can say went away. A row a subscription took in the meantime
    /// is one this listing may have been made too early to see.
    known: std::collections::BTreeSet<RunId>,
}

impl Look {
    /// One listing of the root and four metadata lookups per run; a run is read
    /// — its bounded summary, never its journal — only when one of them moved
    /// since `held` says it was last read, and at most once a reread interval.
    /// `None` when the root cannot be listed.
    fn of(store: &RunStore, read: bool, held: &BTreeMap<RunId, (Stamps, Instant)>) -> Option<Self> {
        let reread = store.poll() * ROW_POLLS_PER_READ;
        let mut look = Self {
            read: Vec::new(),
            seen: std::collections::BTreeSet::new(),
            known: held.keys().cloned().collect(),
        };
        let entries = std::fs::read_dir(store.root()).ok()?;
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
            look.seen.insert(run.clone());
            match held.get(&run) {
                Some((was, _)) if *was == stamps => continue,
                // Moved, but read too recently: read once the interval is up,
                // to what the run then holds.
                Some((_, read_at)) if read && read_at.elapsed() < reread => continue,
                _ => {}
            }
            let Some(row) = row_of(&paths, &run) else {
                continue;
            };
            look.read.push((run, stamps, row));
        }
        Some(look)
    }
}

/// `run`'s sidebar row, read from its bounded summary; `None` where the
/// summary cannot be read.
fn row_of(paths: &RunPaths, run: &RunId) -> Option<Arc<str>> {
    let summary = RunSummary::of(paths).ok()?;
    Some(
        payload::sidebar_row(run, &summary, paths)
            .to_string()
            .into(),
    )
}

/// The row of `run` the sidebar does not hold yet, read with no lock held:
/// what a subscription naming that run carries in its snapshot rather than
/// leave it to the next look. `None` once the sidebar holds it, or where the
/// run has no journal or no readable summary.
fn missing_row(shared: &Shared, run: &RunId) -> Option<(RunId, Stamps, Arc<str>)> {
    if lock(&shared.sidebar).rows.contains_key(run) {
        return None;
    }
    let paths = shared.store.paths_of(run);
    let stamps = Stamps::of(&paths);
    stamps.0[0]?;
    let row = row_of(&paths, run)?;
    Some((run.clone(), stamps, row))
}

impl Sidebar {
    /// Take `run`'s row where no look has yet: the change every subscription
    /// already made is sent, or `None` where a look took it first or the
    /// sidebar has not been read.
    fn add(&mut self, run: RunId, stamps: Stamps, row: Arc<str>) -> Option<RowChange> {
        if self.rows.contains_key(&run) {
            return None;
        }
        self.rows
            .insert(run, (stamps, Arc::clone(&row), Instant::now()));
        self.read.then_some(RowChange::Changed(row))
    }

    /// What each row was read from and when: all a [`Look`] needs to decide
    /// what to read again.
    fn held(&self) -> BTreeMap<RunId, (Stamps, Instant)> {
        self.rows
            .iter()
            .map(|(run, (stamps, _, read_at))| (run.clone(), (stamps.clone(), *read_at)))
            .collect()
    }

    /// Take what `look` read: the rows that moved since the last look, and the
    /// runs that went away. Announced only once the sidebar has been read, and
    /// only where the row the sidebar shows came out different.
    fn apply(&mut self, look: Look) -> Vec<RowChange> {
        let mut changes = Vec::new();
        for (run, stamps, row) in look.read {
            let moved = self.rows.get(&run).is_none_or(|(_, held, _)| *held != row);
            self.rows
                .insert(run, (stamps, Arc::clone(&row), Instant::now()));
            if moved && self.read {
                changes.push(RowChange::Changed(row));
            }
        }
        let gone: Vec<RunId> = self
            .rows
            .keys()
            .filter(|run| look.known.contains(*run) && !look.seen.contains(*run))
            .cloned()
            .collect();
        for run in gone {
            self.rows.remove(&run);
            if self.read {
                changes.push(RowChange::Removed(run));
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
            .filter_map(|(_, row, _)| serde_json::from_str(row).ok())
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
    details: HashMap<FilterKey, HeldDetail>,
    timelines: Vec<(TimelineScope, FilterKey, HeldTimeline)>,
    /// The per-share timelines `GET .../timeline/events` reads once the run's
    /// complete read has been published, kept current here rather than
    /// rebuilt on a request.
    history: Vec<(TimelineScope, FilterKey, Held<LiveTimeline>)>,
    channel: Option<Held<Value>>,
    channel_stamp: Vec<(PathBuf, u64, SystemTime)>,
    telemetry: Folded,
    /// What each node was last seen doing: one fold per opening.
    activity: ActivityFold,
    agents: Option<Agents>,
    agents_stamp: Option<(u64, SystemTime)>,
    liveness: onepipeline::views::DriverLiveness,
    /// Whether the last refresh failed, so a failure is reported once per
    /// spell rather than every tick it lasts.
    failing: bool,
    /// How far this reading has come.
    reading: Reading,
    /// Whether the telemetry fold is overdue, so its values draw as loading.
    overdue: bool,
    /// Where each record a heads read holds as its head can be read whole: `None`
    /// once the view holds every record whole, a whole read's or the complete one's.
    headed: Option<first_screen::Headed>,
}

/// How far a held run's reading has come.
enum Reading {
    /// A selective read, whose complete read has not been started.
    Selective,
    /// A selective read, with its complete read running.
    Running,
    /// A selective read, whose complete read failed for this reason; a later
    /// subscription starts it again.
    Failed(String),
    /// The complete read was published.
    Complete,
}

/// A detail, as a subscription is shown it.
enum DetailBody {
    /// The kept fields of a selective read, trimmed as the contract says.
    First(Value),
    /// A complete reading, kept current as ever.
    Live(LiveDetail),
}

struct HeldDetail {
    body: DetailBody,
    filter: EventFilter,
    /// The `progress` member the subscriber holds.
    progress: Value,
    observed_at: String,
}

impl HeldDetail {
    fn wire(&self) -> Value {
        let body = match &self.body {
            DetailBody::First(detail) => detail,
            DetailBody::Live(detail) => detail.payload(),
        };
        let mut wire = body.clone();
        wire["progress"] = self.progress.clone();
        wire
    }
}

/// What a kept timeline nobody shows has not been brought up to date with.
#[derive(Default)]
struct Behind {
    /// Whether anything moved since it was last refreshed.
    pending: bool,
    /// What the refreshes it missed touched; `None` once one reread the store.
    touched: Option<Touched>,
    agents_moved: bool,
}

struct HeldTimeline {
    /// While nobody shows it, what it has not caught up with: caught up when a tab
    /// next opens it, so a view nobody shows is never rebuilt on a tick.
    behind: Behind,
    /// Where its wire window starts: a node's latest rows when first projected,
    /// after which rows arriving are appended to it.
    since: Option<(String, u64)>,
    live: LiveTimeline,
    /// What its subscribers hold: no whole list of events.
    wire: Value,
    window: ItemsWindow,
    filter: EventFilter,
    observed_at: String,
}

/// A timeline's wire window: Overall lists none, a node its latest.
fn wire_window(scope: &TimelineScope) -> ItemsWindow {
    match scope {
        TimelineScope::Node(_) => ItemsWindow::Latest(NODE_WINDOW_EVENTS),
        _ => ItemsWindow::Nothing,
    }
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
    /// When the first record this fold has not folded was seen: `None` while
    /// the fold holds every record, so it is stale exactly when this is set.
    stale_since: Option<Instant>,
}

impl Folded {
    fn of(view: &RunView) -> Self {
        let aggregate = onepipeline::telemetry::of_run(&view.paths, &view.events);
        let document = RunId::try_from(view.paths.run.as_str())
            .ok()
            .and_then(|run| crate::telemetry::of_aggregate(&run, &aggregate).ok());
        let mut served = json!(aggregate);
        // The time they were computed, which a reader of a run still appending
        // reads the rest of them against.
        served["as_of"] = json!(payload::now_rfc3339());
        Self {
            document,
            served,
            folded_at: Instant::now(),
            stale_since: None,
        }
    }

    /// No fold yet: a selective reading folds nothing of the run's whole
    /// history, and shows none of what a fold would give.
    fn none() -> Self {
        Self {
            document: None,
            served: Value::Null,
            folded_at: Instant::now(),
            stale_since: None,
        }
    }

    /// Mark the fold behind the journal, from the first record it has not folded.
    fn go_stale(&mut self) {
        self.stale_since.get_or_insert_with(Instant::now);
    }

    /// Whether a record has been seen that this fold does not hold.
    fn stale(&self) -> bool {
        self.stale_since.is_some()
    }

    fn inputs<'a>(&'a self, agents: Option<usize>, activity: &'a ActivityFold) -> DetailInputs<'a> {
        DetailInputs {
            telemetry: self.document.as_ref(),
            sdk_telemetry: &self.served,
            agents,
            activity: Some(activity),
        }
    }
}

/// A journal this small is read whole for its first answer: reading every record
/// of it costs less than a first screen can notice. [`WHOLE_READ_ENV`] sets another.
pub const WHOLE_READ_BYTES: u64 = 1024 * 1024;

fn agents_of(paths: &RunPaths) -> Option<Agents> {
    onepipeline::verbs::agents(paths, AgentScope::Run).ok()
}

impl LiveRun {
    /// A first reading of `run`: a short journal whole, and a longer one as every
    /// record's head with only the records a first screen reads whole fetched. What
    /// a node's screen reads of it is fetched once its timeline's filter is known, by
    /// [`hold_node_share`](Self::hold_node_share).
    fn open_selective(
        store: &RunStore,
        run: &RunId,
        node: Option<&NodeId>,
        whole_read: u64,
    ) -> Result<Self, ApiError> {
        let paths = store.present(run)?;
        // A node's session rows come off the pointer file, and its agent count and
        // rows are the only thing a first answer reads it for: read beside the
        // journal rather than after it.
        let pointer = node.map(|_| {
            let paths = paths.clone();
            std::thread::spawn(move || agents_of(&paths))
        });
        let whole = |store: &RunStore| -> Result<(RunView, Indexed), ApiError> {
            let view = store.view(run)?;
            let mut indexed = Indexed::of(&view);
            indexed.holds_whole(None);
            Ok((view, indexed))
        };
        let (view, indexed, headed) =
            if std::fs::metadata(paths.journal()).is_ok_and(|about| about.len() <= whole_read) {
                let (view, indexed) = whole(store)?;
                (view, indexed, None)
            } else {
                match first_screen::read(&paths) {
                    Ok(read) => (read.view, read.indexed, Some(read.headed)),
                    // A journal rewritten under its heads read, rather than appended to,
                    // is read whole.
                    Err(onepipeline::Error::RecordMoved { .. }) => {
                        let (view, indexed) = whole(store)?;
                        (view, indexed, None)
                    }
                    Err(error) => return Err(ApiError::from_engine(run, error)),
                }
            };
        let declared = store.declared(&view);
        let agents = pointer.and_then(|read| read.join().ok().flatten());
        Ok(Self {
            run: run.clone(),
            liveness: view.liveness(),
            telemetry: Folded::none(),
            activity: ActivityFold::default(),
            failing: false,
            indexed,
            declared,
            details: HashMap::new(),
            timelines: Vec::new(),
            history: Vec::new(),
            channel: None,
            channel_stamp: channel_stamp(&paths.channel_dir()),
            agents_stamp: file_stamp(&paths.oneharness_sessions()),
            agents,
            view,
            reading: Reading::Selective,
            overdue: false,
            headed,
        })
    }

    /// Bring a kept timeline nobody showed up to date before a tab is shown it.
    fn catch_up_timeline(&mut self, at: usize) {
        let complete = self.complete();
        let progress = self.timeline_progress(&self.timelines[at].0);
        let (scope, _, held) = &mut self.timelines[at];
        if !held.behind.pending {
            return;
        }
        let behind = std::mem::take(&mut held.behind);
        let agents = match scope {
            TimelineScope::Run if !complete => None,
            _ => self.agents.as_ref(),
        };
        held.live.refreshed(
            &self.view,
            &self.indexed,
            &self.declared,
            behind.touched.as_ref(),
            agents,
            behind.agents_moved,
        );
        held.since = progressive::window_start(held.live.payload(), held.window);
        held.wire = progressive::wire_timeline_from(
            held.live.payload(),
            held.window,
            complete,
            held.since.clone(),
        );
        held.wire["progress"] = progress;
        held.observed_at = payload::now_rfc3339();
    }

    fn agent_count(&self) -> Option<usize> {
        self.agents.as_ref().map(|agents| agents.sessions.len())
    }

    fn complete(&self) -> bool {
        matches!(self.reading, Reading::Complete)
    }

    /// Claim the starting of the complete read, if none is held, running or
    /// failed: a later subscription retries one that failed.
    fn claim_complete(&mut self) -> bool {
        match self.reading {
            Reading::Selective | Reading::Failed(_) => {
                self.reading = Reading::Running;
                true
            }
            Reading::Running | Reading::Complete => false,
        }
    }

    fn failed(&self) -> Option<&str> {
        match &self.reading {
            Reading::Failed(why) => Some(why),
            Reading::Selective | Reading::Running | Reading::Complete => None,
        }
    }

    /// The `progress` a detail is shown.
    fn detail_progress(&self) -> Value {
        if !self.complete() {
            return progressive::progress(false, DETAIL_FIRST_LOADING, self.failed());
        }
        let loading: &[&str] = if self.overdue {
            &["telemetry", "run.usage", "run.timing"]
        } else {
            &[]
        };
        progressive::progress(true, loading, None)
    }

    /// The `progress` a timeline is shown.
    fn timeline_progress(&self, scope: &TimelineScope) -> Value {
        let loading: &[&str] = if matches!(scope, TimelineScope::Run) && !self.complete() {
            &[SPANS_HARNESS_LOADING]
        } else {
            &[]
        };
        progressive::progress(self.complete(), loading, self.failed())
    }

    /// The window a held timeline renders, which while selective is the wire's.
    fn render_window(&self, scope: &TimelineScope) -> ItemsWindow {
        // A node opened after the rest renders its window too: rendering all its
        // rows here is seconds under this run's lock, and its first page keeps a
        // whole view of the node of its own.
        if self.complete() && matches!(scope, TimelineScope::Run) {
            ItemsWindow::Counted
        } else {
            wire_window(scope)
        }
    }

    /// A node the run's records, plan or state knows, whatever the view holds.
    fn knows_node(&self, node: &NodeId, plan: &Value) -> bool {
        plan["tasks"]
            .as_array()
            .is_some_and(|tasks| tasks.iter().any(|task| task["id"] == node.as_str()))
            || self.view.state.statuses().contains_key(node.as_str())
            || self
                .view
                .events
                .iter()
                .any(|event| event.labels.node.as_deref() == Some(node.as_str()))
    }

    /// Hold every record of the node `owner` names whole, for a page of its history
    /// before the complete read ends, by fetching what a heads reading holds as heads;
    /// whether the reading now holds them. `false` for any other owner, and for a
    /// reading whose fetch was refused, which then has the share read apart instead.
    fn hold_page_owner(&mut self, owner: &crate::contract::PageOwner) -> bool {
        let crate::contract::PageOwner::Node(node) = owner else {
            return false;
        };
        if self.indexed.holds_share(node.as_str()) {
            return true;
        }
        let Some(headed) = &mut self.headed else {
            return false;
        };
        match headed.hold_whole(&mut self.view, node.as_str()) {
            Ok(()) => {
                self.indexed.holds_whole(Some(node.as_str()));
                true
            }
            Err(_) => {
                self.headed = None;
                false
            }
        }
    }

    /// Hold every record `node`'s timeline under `filter` draws whole: what a heads
    /// read's node screen reads of it, fetched, and otherwise the node's every record,
    /// for a reading that holds only some of them.
    fn hold_node_share(&mut self, node: &NodeId, filter: &EventFilter) {
        if self.complete() || self.indexed.holds_share(node.as_str()) {
            return;
        }
        if let Some(headed) = &mut self.headed {
            match headed.hold_node(&mut self.view, &self.indexed, node.as_str(), filter) {
                Ok(()) => return,
                // A journal rewritten under the heads read: the node's records are
                // read whole instead, as its share.
                Err(_) => self.headed = None,
            }
        }
        let selected = onepipeline::journal::read_selected(
            &self.view.paths.journal(),
            &onepipeline::journal::Selection::Share(Some(node.as_str())),
        );
        self.indexed.hold_share(node.as_str(), &selected);
    }

    /// Make sure the payloads `visible` shows are being kept, building any that
    /// are not, and answer the snapshot of them.
    fn ensure(
        &mut self,
        store: &RunStore,
        visible: &Visible,
        spec: Option<&crate::filter::FilterSpec>,
    ) -> Result<Value, ApiError> {
        let at = self.hold(store, visible, spec)?;
        Ok(self.answer(visible, at))
    }

    /// Make sure the payloads `visible` shows are being kept, building any that
    /// are not, and say where a timeline's is held: [`answer`](Self::answer) then
    /// reads them.
    fn hold(
        &mut self,
        store: &RunStore,
        visible: &Visible,
        spec: Option<&crate::filter::FilterSpec>,
    ) -> Result<Option<usize>, ApiError> {
        let filter = RunStore::resolve(&self.view, spec)?;
        let detail_key = visible.detail_filter();
        if !self.details.contains_key(&detail_key) {
            let detail_filter = if detail_key.names_none() {
                EventFilter::default()
            } else {
                filter.clone()
            };
            let building = Instant::now();
            let body = if self.complete() {
                let agents = self.agent_count();
                DetailBody::Live(LiveDetail::build(
                    &self.view,
                    &self.indexed,
                    &self.declared,
                    detail_filter.clone(),
                    &self.telemetry.inputs(agents, &self.activity),
                ))
            } else {
                DetailBody::First(progressive::trimmed_detail(&payload::first_detail(
                    &self.view,
                )))
            };
            let took = building.elapsed().as_secs_f64();
            first_screen::record(|split| split.detail_s = Some(took));
            let held = HeldDetail {
                body,
                filter: detail_filter,
                progress: self.detail_progress(),
                observed_at: payload::now_rfc3339(),
            };
            self.details.insert(detail_key.clone(), held);
        }
        match visible {
            Visible::Sidebar | Visible::HumanItems(_) | Visible::Detail { .. } => Ok(None),
            Visible::Timeline {
                scope, filter: key, ..
            } => {
                if let TimelineScope::Node(node) = scope {
                    // A node of the plan, recorded or not, or one a record names.
                    let plan = match &self.details[&detail_key].body {
                        DetailBody::First(detail) => &detail["graph"]["plan"],
                        DetailBody::Live(detail) => &detail.payload()["graph"]["plan"],
                    };
                    if !self.knows_node(node, plan) {
                        return Err(ApiError::NodeNotFound(node.clone()));
                    }
                    // Selective: every record of the node, and its session rows,
                    // whatever view this run was opened for.
                    self.hold_node_share(node, &filter);
                    if self.agents.is_none() {
                        self.agents = agents_of(&self.view.paths);
                    }
                }
                let at =
                    match self.timelines.iter().position(|(held_scope, held_key, _)| {
                        held_scope == scope && held_key == key
                    }) {
                        Some(at) => {
                            self.catch_up_timeline(at);
                            at
                        }
                        None => {
                            let building = Instant::now();
                            let render = self.render_window(scope);
                            let agents = match scope {
                                TimelineScope::Run if !self.complete() => None,
                                _ => self.agents.as_ref(),
                            };
                            let built = LiveTimeline::build_lending(
                                &mut self.view,
                                &self.indexed,
                                &self.declared,
                                scope.clone(),
                                filter.clone(),
                                agents,
                                render,
                            );
                            let window = wire_window(scope);
                            let since = progressive::window_start(built.payload(), window);
                            let mut wire = progressive::wire_timeline_from(
                                built.payload(),
                                window,
                                self.complete(),
                                since.clone(),
                            );
                            wire["progress"] = self.timeline_progress(scope);
                            let took = building.elapsed().as_secs_f64();
                            first_screen::record(|split| split.timeline_s = Some(took));
                            self.timelines.push((
                                scope.clone(),
                                key.clone(),
                                HeldTimeline {
                                    behind: Behind::default(),
                                    since,
                                    live: built,
                                    wire,
                                    window,
                                    filter: filter.clone(),
                                    observed_at: payload::now_rfc3339(),
                                },
                            ));
                            self.timelines.len() - 1
                        }
                    };
                Ok(Some(at))
            }
            Visible::Channel { .. } => {
                if self.channel.is_none() {
                    let channel = channel_payload(store, &self.run)?;
                    self.channel = Some(held(channel));
                }
                Ok(None)
            }
        }
    }

    /// The snapshot of what `visible` shows, from the payloads [`hold`](Self::hold)
    /// keeps, `at` the timeline it said: one copy of each held payload, moved into
    /// the answer from there.
    fn answer(&self, visible: &Visible, at: Option<usize>) -> Value {
        let run = Value::from(self.run.as_str());
        let detail = || {
            let held = &self.details[&visible.detail_filter()];
            enveloped(held.wire(), &held.observed_at)
        };
        match (visible, at) {
            // Views of no run, which no run is ever asked for.
            (Visible::Sidebar | Visible::HumanItems(_), _) => {
                object_of([("type", Value::from("sidebar"))])
            }
            (Visible::Detail { .. }, _) => object_of([
                ("type", Value::from("detail")),
                ("run_id", run),
                ("detail", detail()),
            ]),
            (Visible::Timeline { scope, .. }, Some(at)) => {
                let (_, _, held) = &self.timelines[at];
                let timeline = enveloped(held.wire.clone(), &held.observed_at);
                match scope {
                    TimelineScope::Node(node) => object_of([
                        ("type", Value::from("timeline")),
                        ("run_id", run),
                        ("scope", Value::from("node")),
                        ("node", Value::from(node.as_str())),
                        ("detail", detail()),
                        ("timeline", timeline),
                    ]),
                    _ => object_of([
                        ("type", Value::from("timeline")),
                        ("run_id", run),
                        ("scope", Value::from("run")),
                        ("detail", detail()),
                        ("timeline", timeline),
                    ]),
                }
            }
            (Visible::Timeline { .. }, None) => Value::Null,
            (Visible::Channel { .. }, _) => {
                let channel = self.channel.as_ref().map_or(Value::Null, |held| {
                    enveloped(held.payload.clone(), &held.observed_at)
                });
                object_of([
                    ("type", Value::from("channel")),
                    ("run_id", run),
                    ("detail", detail()),
                    ("channel", channel),
                ])
            }
        }
    }
}

/// One fold of what each node was last seen doing, over a whole read.
fn fold_activity(view: &RunView) -> ActivityFold {
    let mut fold = ActivityFold::default();
    for event in &view.events {
        fold.absorb(event, &EventFilter::default());
    }
    fold.settle();
    fold
}

fn held<T>(payload: T) -> Held<T> {
    Held {
        payload,
        observed_at: payload::now_rfc3339(),
    }
}

/// A payload in the schema-version envelope every route serves it in: the
/// [`Envelope`](crate::contract::Envelope) the routes serialize, with `payload`'s members moved in after the
/// envelope's own rather than serialized into a copy of each.
///
/// A payload that is not an object has no members to flatten, which is the
/// serialization's refusal too, and reads as `null`.
fn enveloped(payload: Value, observed_at: &str) -> Value {
    let Value::Object(members) = payload else {
        return Value::Null;
    };
    let mut object = serde_json::Map::with_capacity(members.len() + 3);
    object.insert("api_version".to_owned(), Value::from(API_VERSION));
    object.insert(
        "telemetry_schema_version".to_owned(),
        Value::from(TELEMETRY_SCHEMA_VERSION),
    );
    object.insert("observed_at".to_owned(), Value::from(observed_at));
    for (key, value) in members {
        object.insert(key, value);
    }
    Value::Object(object)
}

/// An object of `members`, in their order, each moved in: what `json!` builds,
/// without the copy it serializes of every value it interpolates.
fn object_of<const N: usize>(members: [(&str, Value); N]) -> Value {
    Value::Object(
        members
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
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

/// A run opened for a page's document ahead of its subscription ([`Hub::prepare`]):
/// its reading once made, with what making it cost, or the refusal.
#[derive(Default)]
struct Prepared {
    opened: OnceLock<Opened>,
}

/// A run's reading as [`Hub::open_prepared`] made it, and where its time went.
type Opened = Result<(Arc<Mutex<LiveRun>>, first_screen::Split), ApiError>;

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
            looking: Mutex::new(()),
            runs: Mutex::new(HashMap::new()),
            prepared: Mutex::new(HashMap::new()),
            human_items: Mutex::new(HumanItemsReading::default()),
            polling: AtomicBool::new(false),
            trace: std::env::var_os(TRACE_ENV).map(PathBuf::from),
            refold: std::env::var(TELEMETRY_REFOLD_ENV)
                .ok()
                .and_then(|ms| ms.parse().ok())
                .map_or(TELEMETRY_REFOLD, Duration::from_millis),
            fold_hold: std::env::var(FOLD_HOLD_ENV)
                .ok()
                .and_then(|ms| ms.parse().ok())
                .map_or(Duration::ZERO, Duration::from_millis),
            complete_hold: std::env::var(COMPLETE_READ_HOLD_ENV)
                .ok()
                .and_then(|ms| ms.parse().ok())
                .map_or(Duration::ZERO, Duration::from_millis),
            whole_read: std::env::var(WHOLE_READ_ENV)
                .ok()
                .and_then(|bytes| bytes.parse().ok())
                .unwrap_or(WHOLE_READ_BYTES),
            grace: std::env::var(DISCONNECTED_GRACE_ENV)
                .ok()
                .and_then(|ms| ms.parse().ok())
                .map_or(DISCONNECTED_GRACE, Duration::from_millis),
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
    /// the filter's refusal for a profile the run does not have, and the
    /// engine's refusal for a human-item view on a host that cannot serve one.
    pub fn subscribe(&self, request: &SubscribeRequest) -> Result<Value, ApiError> {
        let shared = &self.0;
        let visible = Visible::of(&request.view);
        let spec = match &request.view {
            SubscriptionView::Detail { filter, .. } | SubscriptionView::Timeline { filter, .. } => {
                filter.as_ref()
            }
            _ => None,
        };
        // The run's reading first, outside every other lock: opening a long
        // journal takes seconds, and nothing else waits on it.
        let live = match visible.run() {
            None => None,
            Some(run) => {
                let run = RunId::try_from(run)?;
                let node = match &visible {
                    Visible::Timeline {
                        scope: TimelineScope::Node(node),
                        ..
                    } => Some(node),
                    _ => None,
                };
                let live = self.live_run(&run, node)?;
                lock(&live).hold(&shared.store, &visible, spec)?;
                Some(live)
            }
        };
        // A human-item view's first reading likewise: the engine may refuse it.
        let human_items = human_items_view(&request.view);
        if let Some(view) = &human_items {
            let mut reading = lock(&shared.human_items);
            self.ensure_human_items(&mut reading, view)?;
        }
        // A run view's snapshot waits on neither the sidebar nor the run's
        // complete read: its rows arrive as the stream's first frame.
        let run_view = visible.run_id().is_some();
        // Then the publication boundary: the sidebar, the run and the
        // subscriptions locked together, so every change after the snapshot is
        // one this subscription is sent and none before it is.
        if !run_view {
            self.first_look();
        }
        let sidebar = lock(&shared.sidebar);
        let mut run = live.as_ref().map(|live| lock(live));
        let mut reading = human_items.as_ref().map(|_| lock(&shared.human_items));
        let visible_state = match (run.as_mut(), &human_items, reading.as_mut()) {
            (Some(run), _, _) => run.ensure(&shared.store, &visible, spec)?,
            (None, Some(view), Some(reading)) => self.ensure_human_items(reading, view)?,
            _ => json!({ "type": "sidebar" }),
        };
        let rows = if run_view {
            Value::Null
        } else {
            Value::Array(sidebar.snapshot())
        };
        let mut state = lock(&shared.state);
        // The reading is held for this subscription from the boundary on: a tick
        // that let it go between its opening and now — when no subscription yet
        // wanted it — would leave the subscription with nothing refreshing it.
        if let (Some(live), Some(run)) = (&live, visible.run_id()) {
            lock(&shared.runs)
                .entry(run.clone())
                .or_insert_with(|| Arc::clone(live));
        }
        let seq = state.next;
        state.next += 1;
        let subscription = SubscriptionId::mint();
        if let SubscribeOrigin::Replaces(replaced) = request.origin {
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
                // Recording from now, for at most the grace, until a stream
                // connects.
                link: Link::drop_now(),
                deferred: run_view.then(Vec::new),
            },
        );
        drop(state);
        drop(reading);
        let begin_complete = run.as_mut().is_some_and(|run| run.claim_complete());
        drop(run);
        drop(sidebar);
        self.start_polling();
        if run_view {
            self.send_sidebar(subscription, visible.run_id().cloned());
        }
        if begin_complete {
            if let Some(live) = &live {
                self.spawn_complete(live);
            }
        }
        // Every value is moved into the answer rather than interpolated, which
        // would serialize a copy of each: Overall's is about a megabyte.
        let id = Value::from(self.id(seq));
        let subscribed = Value::from(subscription.to_string());
        let snapshot = object_of([
            ("id", id.clone()),
            ("sidebar", rows),
            ("visible", visible_state),
        ]);
        let initial = match request.origin {
            SubscribeOrigin::Fresh | SubscribeOrigin::Replaces(_) => {
                object_of([("type", Value::from("snapshot")), ("snapshot", snapshot)])
            }
            SubscribeOrigin::Resume(resume) => {
                let reason = if resume.epoch == shared.epoch {
                    ResetReason::UnknownCursor
                } else {
                    ResetReason::ServerRestarted
                }
                .as_str();
                object_of([
                    ("type", Value::from("reset")),
                    ("id", id),
                    ("base", Value::from(resume.to_string())),
                    ("subscription", subscribed.clone()),
                    ("reason", Value::from(reason)),
                    ("snapshot", snapshot),
                ])
            }
        };
        Ok(object_of([
            ("subscription", subscribed),
            ("view", request.view.to_json()),
            ("initial", initial),
        ]))
    }

    /// [`subscribe`](Self::subscribe)'s answer, serialized as the route serves it.
    ///
    /// Where [`TRACE_ENV`] names a file, one line of it says where the answer's time
    /// went: the engine's heads read and the fetches a long run's first answer
    /// makes, holding and indexing the heads, the detail and timeline it builds, and
    /// the serialization.
    ///
    /// # Errors
    ///
    /// [`subscribe`](Self::subscribe)'s.
    pub fn subscribe_serialized(&self, request: &SubscribeRequest) -> Result<Vec<u8>, ApiError> {
        let started = Instant::now();
        first_screen::take();
        let answer = self.subscribe(request)?;
        let answered = Instant::now();
        let bytes = serde_json::to_vec(&answer)
            .map_err(|error| ApiError::Read(format!("the answer did not serialize: {error}")))?;
        if self.0.trace.is_some() {
            let split = first_screen::take();
            let ms = |seconds: Option<f64>| seconds.map(|seconds| seconds * 1000.0);
            self.trace(&json!({
                "subscribe": request.view.to_json(),
                "heads_ms": ms(split.heads_s),
                "fetch_ms": ms(split.fetch_s),
                "fetched": split.fetched,
                "records": split.records,
                "index_ms": ms(split.index_s),
                "detail_ms": ms(split.detail_s),
                "timeline_ms": ms(split.timeline_s),
                "answer_ms": (answered - started).as_secs_f64() * 1000.0,
                "serialize_ms": answered.elapsed().as_secs_f64() * 1000.0,
                "bytes": bytes.len(),
            }));
        }
        Ok(bytes)
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
    pub fn connect(
        &self,
        subscription: SubscriptionId,
        after: Option<EventId>,
    ) -> Result<Stream, Unavailable> {
        let shared = &self.0;
        // A reset reads the run's state, so the run is locked before the
        // subscriptions, as every tick locks them.
        let view = lock(&shared.state)
            .subscriptions
            .get(&subscription)
            .map(|held| held.view.clone());
        let Some(view) = view else {
            let state = lock(&shared.state);
            return Err(
                match state.retired.iter().find(|(id, _)| *id == subscription) {
                    Some((_, Retired::Expired)) => Unavailable::Expired,
                    _ if after.is_some_and(|after| after.epoch != shared.epoch) => {
                        Unavailable::ServerRestarted
                    }
                    _ => Unavailable::Unknown,
                },
            );
        };
        let visible = Visible::of(&view);
        let live = visible
            .run_id()
            .and_then(|run| lock(&shared.runs).get(run).cloned());
        let human_items = human_items_view(&view);
        let sidebar = lock(&shared.sidebar);
        let mut run = live.as_ref().map(|live| lock(live));
        let mut reading = human_items.as_ref().map(|_| lock(&shared.human_items));
        // A reset re-sends what the routes then answer, and what catching up for
        // it moved is an ordinary frame to everyone showing the view. A resume
        // takes no read: its stream is answered from what was retained.
        if let Some(reading) = reading.as_mut() {
            let resets = lock(&shared.state)
                .subscriptions
                .get(&subscription)
                .and_then(|held| held.reset_reason(after, shared.epoch))
                .is_some();
            if resets {
                // Refused, the reset re-sends what was last read, and the next
                // look that can read sends the rest.
                let _ = self.refresh_human_items(reading);
            }
        }
        let mut state = lock(&shared.state);
        let Some(held) = state.subscriptions.get(&subscription) else {
            return Err(Unavailable::Unknown);
        };
        let (sender, frames) = mpsc::channel(CONNECTION_BUFFER);
        let first = held.first;
        let resumable = after
            .filter(|after| after.epoch == shared.epoch)
            .map(|after| after.seq);
        let mut replay = Vec::new();
        let reset_reason = held.reset_reason(after, shared.epoch);
        match (reset_reason, after) {
            (Some(reason), Some(after)) => {
                // One explicit re-send, named, and the new base from here on.
                let visible_state = match (run.as_mut(), &human_items, reading.as_ref()) {
                    (Some(run), _, _) => run.ensure(&shared.store, &visible, spec_of(&view)).ok(),
                    (None, Some(view), Some(reading)) => reading
                        .views
                        .get(&HumanItemsKey::of(&view.0, view.1.as_ref()))
                        .map(|held| held.visible.clone()),
                    _ => Some(json!({ "type": "sidebar" })),
                };
                // A reset re-sends the whole view, so nothing held behind the
                // sidebar's rows is sent after it; and where the rows are read
                // it carries them, so no `sidebar.snapshot` follows it either.
                let sidebar_pending = held.deferred.is_some() && !sidebar.read;
                let seq = state.next;
                state.next += 1;
                let id = self.id(seq);
                let data = json!({
                    "id": id, "base": after.to_string(), "subscription": subscription,
                    "type": "reset", "reason": reason.as_str(),
                    "snapshot": { "id": id, "sidebar": if sidebar_pending { Value::Null } else { Value::Array(sidebar.snapshot()) }, "visible": visible_state },
                })
                .to_string();
                let held = state
                    .subscriptions
                    .get_mut(&subscription)
                    .expect("held above");
                held.frames.clear();
                held.deferred = sidebar_pending.then(Vec::new);
                held.first = seq;
                held.last = seq;
                held.boundary = seq;
                replay.push(frame_event(&id, FrameKind::Reset, &data));
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
        let held = state
            .subscriptions
            .get_mut(&subscription)
            .expect("held above");
        held.link = Link::Connected(sender);
        drop(state);
        drop(reading);
        drop(run);
        drop(sidebar);
        self.start_polling();
        Ok(Stream { replay, frames })
    }

    /// Read the sidebar's rows the first time anything asks for them. A
    /// subscription made once they are read waits on no look.
    fn first_look(&self) {
        let shared = &self.0;
        if lock(&shared.sidebar).read {
            return;
        }
        let _looking = lock(&shared.looking);
        // Read by a look that finished while this one waited for its turn.
        if lock(&shared.sidebar).read {
            return;
        }
        if let Some(look) = Look::of(&shared.store, false, &BTreeMap::new()) {
            lock(&shared.sidebar).apply(look);
        }
    }

    /// One look at the runs root, read without the sidebar's lock and then
    /// taken into it: the sidebar, locked, and what moved — which the caller
    /// sends with the sidebar still locked, so a subscription made in between
    /// is either in the snapshot or sent the change. `None` when the root
    /// cannot be listed.
    fn look(&self) -> Option<(MutexGuard<'_, Sidebar>, Vec<RowChange>)> {
        let shared = &self.0;
        let _looking = lock(&shared.looking);
        let (read, held) = {
            let sidebar = lock(&shared.sidebar);
            (sidebar.read, sidebar.held())
        };
        let look = Look::of(&shared.store, read, &held)?;
        let mut sidebar = lock(&shared.sidebar);
        let changes = sidebar.apply(look);
        Some((sidebar, changes))
    }

    /// The reading of `run`, opened if no subscription holds it yet.
    fn live_run(
        &self,
        run: &RunId,
        node: Option<&NodeId>,
    ) -> Result<Arc<Mutex<LiveRun>>, ApiError> {
        if let Some(live) = lock(&self.0.runs).get(run) {
            return Ok(Arc::clone(live));
        }
        // A run a page's document named is taken as that opening left it, waiting
        // for it while it is still being made; one that failed is opened again, so
        // the answer is this request's own.
        let prepared = lock(&self.0.prepared).get(run).map(Arc::clone);
        let taken = prepared.and_then(|prepared| {
            let opened = self.open_prepared(&prepared, run, node);
            lock(&self.0.prepared).retain(|_, held| !Arc::ptr_eq(held, &prepared));
            let (live, split) = opened.ok()?;
            first_screen::record(|own| own.adopt(split));
            Some(live)
        });
        let opened = match taken {
            Some(live) => live,
            None => {
                let live = LiveRun::open_selective(&self.0.store, run, node, self.0.whole_read)?;
                self.trace(&json!({ "unprepared": run.as_str() }));
                Arc::new(Mutex::new(live))
            }
        };
        Ok(Arc::clone(
            lock(&self.0.runs).entry(run.clone()).or_insert(opened),
        ))
    }

    /// Open `run` for the subscription a page whose document named it is about to
    /// make, on a thread of its own, so the run's reading is under way while the
    /// browser loads and runs the page. Nothing else changes: the subscription takes
    /// the reading as [`live_run`](Self::live_run) would have made it, or waits for
    /// it to be made, and a run nobody subscribes to is let go after
    /// [`PREPARED_HOLD`]. A run already held, already being opened, or beyond
    /// [`PREPARED_RUNS`] opened this way is left alone.
    pub fn prepare(&self, run: RunId, node: Option<NodeId>) {
        if lock(&self.0.runs).contains_key(&run) {
            return;
        }
        let prepared = {
            let mut held = lock(&self.0.prepared);
            if held.contains_key(&run) || held.len() >= PREPARED_RUNS {
                return;
            }
            let prepared = Arc::new(Prepared::default());
            held.insert(run.clone(), Arc::clone(&prepared));
            prepared
        };
        let hub = self.clone();
        let opening = Arc::clone(&prepared);
        let spawned = std::thread::Builder::new()
            .name("prepare-run".to_owned())
            .spawn(move || {
                let _ = hub.open_prepared(&opening, &run, node.as_ref());
                std::thread::sleep(PREPARED_HOLD);
                lock(&hub.0.prepared).retain(|_, held| !Arc::ptr_eq(held, &opening));
            });
        if spawned.is_err() {
            lock(&self.0.prepared).retain(|_, held| !Arc::ptr_eq(held, &prepared));
        }
    }

    /// `prepared`'s reading of `run`, made here if nothing has made it yet and
    /// waited for if something is making it.
    fn open_prepared(&self, prepared: &Prepared, run: &RunId, node: Option<&NodeId>) -> Opened {
        prepared
            .opened
            .get_or_init(|| {
                let opened = LiveRun::open_selective(&self.0.store, run, node, self.0.whole_read);
                // What the opening cost goes with it, to the answer that takes it.
                let split = first_screen::take();
                self.trace(&json!({ "prepared": run.as_str(), "opened": opened.is_ok() }));
                opened.map(|live| (Arc::new(Mutex::new(live)), split))
            })
            .clone()
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
                    held.link = Link::drop_now();
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
            state.expire(shared.grace);
            let wanted: Vec<Visible> = state
                .subscriptions
                .values()
                .map(|held| Visible::of(&held.view))
                .collect();
            // Runs no subscription shows any more are let go — under the lock a
            // subscription is registered under, so one being made keeps its run.
            lock(&shared.runs)
                .retain(|run, _| wanted.iter().any(|visible| visible.run_id() == Some(run)));
            wanted
        };
        if wanted.is_empty() {
            return;
        }
        if let Some((_sidebar, changes)) = self.look() {
            if !changes.is_empty() {
                let mut state = lock(&shared.state);
                let ids: Vec<SubscriptionId> = state.subscriptions.keys().copied().collect();
                for change in &changes {
                    let change = match change {
                        RowChange::Changed(row) => Change::Row(Arc::clone(row)),
                        RowChange::Removed(run) => Change::Removed(run.clone()),
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
        // Under the lock a subscription is registered under, so one being made
        // keeps its view; and with no view left, no file is looked at.
        let mut reading = lock(&shared.human_items);
        let wanted: Vec<Visible> = lock(&shared.state)
            .subscriptions
            .values()
            .map(|held| Visible::of(&held.view))
            .collect();
        reading.views.retain(|key, _| {
            wanted
                .iter()
                .any(|visible| matches!(visible, Visible::HumanItems(shown) if shown == key))
        });
        // Reported once a spell by the refresh itself, and tried again next tick.
        let _ = self.refresh_human_items(&mut reading);
    }

    /// `view`'s `visible` as of now, read once if no subscription shows it yet.
    fn ensure_human_items(
        &self,
        reading: &mut HumanItemsReading,
        view: &(HumanItemFilter, Option<HumanItemId>),
    ) -> Result<Value, ApiError> {
        let (filter, item) = view;
        let key = HumanItemsKey::of(filter, item.as_ref());
        // A store that moved and cannot be read is refused here as a fresh read
        // of it would be, rather than answered with what was last read.
        self.refresh_human_items(reading)?;
        if let Some(held) = reading.views.get(&key) {
            return Ok(held.visible.clone());
        }
        let (items, _) = self.0.store.human_items();
        if reading.views.is_empty() {
            // Before the read, so a write landing during it is read again.
            reading.stamp = file_stamp(&items.journal());
        }
        let mut held = HeldHumanItems {
            filter: filter.clone(),
            item: item.clone(),
            visible: Value::Null,
        };
        held.visible = held.read(items)?;
        let visible = held.visible.clone();
        reading.views.insert(key, held);
        Ok(visible)
    }

    /// Look at the engine's journal for the views subscriptions show, and only
    /// once it moved read each of them and send what differs.
    ///
    /// # Errors
    ///
    /// The engine's refusal of a read, which is tried again on the next look.
    fn refresh_human_items(&self, reading: &mut HumanItemsReading) -> Result<(), ApiError> {
        if reading.views.is_empty() {
            return Ok(());
        }
        let shared = &self.0;
        let (items, _) = shared.store.human_items();
        let stamp = file_stamp(&items.journal());
        if stamp == reading.stamp {
            reading.failing = false;
            return Ok(());
        }
        let mut changes = Vec::new();
        let mut refused = None;
        for (key, held) in &mut reading.views {
            match held.read(items) {
                Ok(visible) => {
                    let mut ops = Vec::new();
                    if let Err(refused) = crate::patch::diff(&held.visible, &visible, &mut ops) {
                        eprintln!("onepipeline-api: human items could not be patched: {refused}");
                    }
                    held.visible = visible;
                    if !ops.is_empty() {
                        changes.push((key.clone(), Change::HumanItems { ops }));
                    }
                }
                Err(error) => refused = Some(error),
            }
        }
        // The stamp is taken as read only once every view was: a read the engine
        // refused is tried again on the next tick, not forgotten.
        match &refused {
            Some(error) => {
                if !reading.failing {
                    eprintln!(
                        "onepipeline-api: human items could not be read, and are read again each tick: {error}"
                    );
                }
                reading.failing = true;
            }
            None => {
                reading.failing = false;
                reading.stamp = stamp;
            }
        }
        if !changes.is_empty() {
            self.send_human_items(&changes);
        }
        refused.map_or(Ok(()), Err)
    }

    /// Send each change to every subscription showing the view it is of.
    fn send_human_items(&self, changes: &[(HumanItemsKey, Change)]) {
        let shared = &self.0;
        let mut state = lock(&shared.state);
        let reach: Vec<(SubscriptionId, Visible)> = state
            .subscriptions
            .iter()
            .map(|(id, held)| (*id, Visible::of(&held.view)))
            .collect();
        for (id, visible) in reach {
            for (key, change) in changes {
                if matches!(&visible, Visible::HumanItems(shown) if shown == key) {
                    self.emit(&mut state, id, change);
                }
            }
        }
    }

    /// Refresh one run and push what moved to every subscription showing it.
    fn refresh(&self, live: &Arc<Mutex<LiveRun>>) {
        let shared = &self.0;
        let mut run = lock(live);
        let run = &mut *run;
        let started = Instant::now();
        // Only what a subscription shows is kept current: a payload a view
        // switch left behind is let go rather than rebuilt on every change.
        // Read under the run's lock, which a subscription is registered under,
        // so a view being made is never let go.
        let wanted: Vec<Visible> = lock(&shared.state)
            .subscriptions
            .values()
            .map(|held| Visible::of(&held.view))
            .filter(|visible| visible.run() == Some(run.run.as_str()))
            .collect();
        // A complete reading keeps its unfiltered detail and Overall: a whole build of
        // either is a long hold of this run's lock, and a tab opening it then waits.
        let complete = run.complete();
        run.details.retain(|key, _| {
            (complete && key.names_none())
                || wanted.iter().any(|visible| {
                    !matches!(visible, Visible::Sidebar) && visible.detail_filter() == *key
                })
        });
        run.timelines.retain(|(scope, key, _)| {
            (complete && *scope == TimelineScope::Run && key.names_none())
                || wanted.iter().any(|visible| {
                    matches!(visible, Visible::Timeline { scope: shown, filter, .. } if shown == scope && filter == key)
                })
        });
        if !wanted
            .iter()
            .any(|visible| matches!(visible, Visible::Channel { .. }))
        {
            run.channel = None;
        }
        let outcome = run.view.refresh();
        let paths = run.view.paths.clone();
        let touched = match outcome {
            Ok(Refreshed::Unchanged) => Some(Touched::default()),
            Ok(Refreshed::Appended { first }) => Some(run.indexed.extend(&run.view, first)),
            Ok(Refreshed::Reread) => {
                // A reread reads the store whole, selective or not.
                run.indexed = Indexed::of(&run.view);
                run.indexed.holds_whole(None);
                run.headed = None;
                run.declared = shared.store.declared(&run.view);
                None
            }
            Err(error) => {
                // Kept, and read again next tick: a run the engine could not
                // read for a moment is patched again once it can be, and one
                // that went away for good is the sidebar's removal to report.
                if !run.failing {
                    eprintln!(
                        "onepipeline-api: {} could not be refreshed, and is read again each tick: {error}",
                        run.run.as_str()
                    );
                }
                run.failing = true;
                return;
            }
        };
        run.failing = false;
        if let Some(touched) = &touched {
            if touched.any() {
                run.telemetry.go_stale();
                if run.complete() {
                    let at = run.view.events.len().saturating_sub(touched.records);
                    for event in &run.view.events[at..] {
                        run.activity.absorb(event, &EventFilter::default());
                    }
                    run.activity.settle();
                }
            }
        } else {
            run.telemetry.go_stale();
            if run.complete() {
                run.activity = fold_activity(&run.view);
            }
        }
        let agents_stamp = file_stamp(&paths.oneharness_sessions());
        let agents_moved = agents_stamp != run.agents_stamp;
        if agents_moved {
            run.agents_stamp = agents_stamp;
            if run.agents.is_some() || run.complete() {
                run.agents = agents_of(&paths);
            }
        }
        let liveness = run.view.liveness();
        let liveness_moved = liveness != run.liveness;
        run.liveness = liveness;
        // The whole-journal fold is caught up on a tick that carries no change,
        // so a change is never held back by it — and, on a run that never goes
        // quiet, at the latest once it is two intervals behind. A selective
        // reading has no fold to catch up.
        let complete = run.complete();
        let mut folded_ms = None;
        let mut refold = false;
        if complete {
            let aged = run.telemetry.folded_at.elapsed();
            let quiet = touched.as_ref().is_some_and(|touched| !touched.any());
            let held = run
                .telemetry
                .stale_since
                .is_some_and(|since| since.elapsed() < shared.fold_hold);
            refold = run.telemetry.stale()
                && !held
                && ((quiet && aged >= shared.refold) || aged >= shared.refold * 2);
            if refold {
                let folding = Instant::now();
                run.telemetry = Folded::of(&run.view);
                folded_ms = Some(folding.elapsed().as_secs_f64() * 1000.0);
            }
        }
        // Whether the fold's values are older than a reader should be shown as
        // fact: past due with records since, or a fold that failed.
        let overdue = complete
            && (run.telemetry.document.is_none()
                || (run.telemetry.stale()
                    && run.telemetry.folded_at.elapsed() >= shared.refold * OVERDUE_INTERVALS));
        let overdue_moved = overdue != run.overdue;
        run.overdue = overdue;
        let moved = touched.as_ref().is_none_or(Touched::any)
            || agents_moved
            || liveness_moved
            || refold
            || overdue_moved;
        let channel_stamp = if run.channel.is_some() {
            channel_stamp(&paths.channel_dir())
        } else {
            Vec::new()
        };
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
            let detail_progress = run.detail_progress();
            let first_detail =
                (!complete).then(|| progressive::trimmed_detail(&payload::first_detail(&run.view)));
            let progresses: Vec<Value> = run
                .timelines
                .iter()
                .map(|(scope, _, _)| run.timeline_progress(scope))
                .collect();
            let LiveRun {
                run: run_id,
                view,
                indexed,
                declared,
                details,
                timelines,
                history,
                telemetry,
                activity,
                agents: agent_list,
                ..
            } = run;
            for (key, detail) in details.iter_mut() {
                let mut ops = match (&mut detail.body, &first_detail) {
                    (DetailBody::Live(live), _) => live.refreshed(
                        view,
                        indexed,
                        declared,
                        touched.as_ref(),
                        &telemetry.inputs(agents, activity),
                    ),
                    (DetailBody::First(held), Some(new)) => {
                        let mut ops = Vec::new();
                        if let Err(refused) = crate::patch::diff(held, new, &mut ops) {
                            eprintln!(
                                "onepipeline-api: a first detail could not be patched: {refused}"
                            );
                        }
                        *held = new.clone();
                        ops
                    }
                    (DetailBody::First(_), None) => Vec::new(),
                };
                if detail.progress != detail_progress {
                    detail.progress = detail_progress.clone();
                    ops.extend(Op::set(
                        &[crate::patch::Step::Key("progress".to_owned())],
                        detail_progress.clone(),
                    ));
                }
                if touched.is_none() {
                    rebuilt_whole.push(format!("detail:{key}"));
                }
                if let Some(ops) = patch_ops(&mut detail.observed_at, &now, ops) {
                    ops_count += 1;
                    changes.push((
                        Visible::Detail {
                            run: run_id.clone(),
                            filter: key.clone(),
                        },
                        Change::Detail {
                            run: run_id.clone(),
                            ops,
                        },
                    ));
                }
            }
            for ((scope, key, timeline), progress) in timelines.iter_mut().zip(progresses) {
                let shown = wanted.iter().any(|visible| {
                    matches!(visible, Visible::Timeline { scope: held, filter, .. } if held == scope && filter == key)
                });
                if !shown {
                    // Kept for the next tab to open it, and caught up then.
                    let behind = &mut timeline.behind;
                    behind.touched = match (behind.pending, &behind.touched, &touched) {
                        (false, _, Some(now)) => Some(now.clone()),
                        (true, Some(was), Some(now)) => {
                            let mut both = was.clone();
                            both.absorb(now);
                            Some(both)
                        }
                        _ => None,
                    };
                    behind.pending = true;
                    behind.agents_moved |= agents_moved || liveness_moved;
                    continue;
                }
                // Past its first answer a node view holds every row from its
                // window's start, so its rows are all rendered from here on.
                if matches!(scope, TimelineScope::Node(_)) {
                    timeline.live.widen();
                }
                let before = timeline.live.rendered();
                let agents_for = match scope {
                    TimelineScope::Run if !complete => None,
                    _ => agent_list.as_ref(),
                };
                let full = timeline.live.refreshed(
                    view,
                    indexed,
                    declared,
                    touched.as_ref(),
                    agents_for,
                    agents_moved || liveness_moved,
                );
                rendered += timeline.live.rendered() - before;
                let mut ops = progressive::sync_timeline(
                    &mut timeline.wire,
                    timeline.live.payload(),
                    &full,
                    timeline.window,
                    complete,
                    timeline.since.as_ref(),
                );
                if timeline.wire["progress"] != progress {
                    timeline.wire["progress"] = progress.clone();
                    ops.extend(Op::set(
                        &[crate::patch::Step::Key("progress".to_owned())],
                        progress,
                    ));
                }
                if touched.is_none() {
                    rebuilt_whole.push(format!("timeline:{key}"));
                }
                if let Some(ops) = patch_ops(&mut timeline.observed_at, &now, ops) {
                    ops_count += 1;
                    changes.push((
                        Visible::Timeline {
                            run: run_id.clone(),
                            scope: scope.clone(),
                            filter: key.clone(),
                        },
                        Change::Timeline {
                            run: run_id.clone(),
                            scope: scope.clone(),
                            ops,
                        },
                    ));
                }
            }
            for (_, _, held) in history.iter_mut() {
                held.payload.refreshed(
                    view,
                    indexed,
                    declared,
                    touched.as_ref(),
                    agent_list.as_ref(),
                    agents_moved || liveness_moved,
                );
            }
        }
        if channel_moved {
            // The stamp is taken as read only once the queue was: a read the
            // engine refused is tried again on the next tick, not forgotten.
            let read = channel_payload(&shared.store, &run.run);
            if read.is_ok() {
                run.channel_stamp = channel_stamp;
            }
            if let (Ok(now_channel), Some(held)) = (read, run.channel.as_mut()) {
                let mut ops = Vec::new();
                if let Err(refused) = crate::patch::diff(&held.payload, &now_channel, &mut ops) {
                    eprintln!("onepipeline-api: a channel could not be patched: {refused}");
                }
                held.payload = now_channel;
                if let Some(ops) = patch_ops(&mut held.observed_at, &now, ops) {
                    changes.push((
                        Visible::Channel {
                            run: run.run.clone(),
                        },
                        Change::Channel {
                            run: run.run.clone(),
                            ops,
                        },
                    ));
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
        // Which payloads this refresh kept current, for the trace.
        let kept: Vec<String> = run
            .details
            .keys()
            .map(|key| format!("detail:{key}"))
            .chain(
                run.timelines
                    .iter()
                    .filter(|(_, _, held)| !held.behind.pending)
                    .map(|(scope, key, _)| match scope {
                        TimelineScope::Run => format!("timeline:run:{key}"),
                        TimelineScope::Node(node) => format!("timeline:node {node}:{key}"),
                        TimelineScope::RunShare | TimelineScope::NodeShare(_) => {
                            format!("history:{key}")
                        }
                    }),
            )
            .chain(run.channel.as_ref().map(|_| "channel".to_owned()))
            .collect();
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
            "kept": kept,
            "ms": started.elapsed().as_secs_f64() * 1000.0,
        }));
    }

    fn trace(&self, line: &Value) {
        let Some(path) = &self.0.trace else { return };
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "{line}");
        }
    }

    /// Send `change` to one subscription, retaining it for a reconnect.
    fn emit(&self, state: &mut State, subscription: SubscriptionId, change: &Change) {
        let Some(held) = state.subscriptions.get_mut(&subscription) else {
            return;
        };
        if let (Some(deferred), false) = (
            held.deferred.as_mut(),
            matches!(change, Change::SidebarRows(_)),
        ) {
            deferred.push(change.clone());
            return;
        }
        let seq = state.next;
        state.next += 1;
        let id = self.id(seq);
        let held = state
            .subscriptions
            .get_mut(&subscription)
            .expect("held above");
        let base = self.id(held.last);
        held.last = seq;
        let kind = change.kind();
        let data: Arc<str> = format!(
            "{{\"id\":\"{id}\",\"base\":\"{base}\",\"subscription\":\"{subscription}\",\"type\":\"{}\",{}}}",
            kind.as_str(),
            change.members()
        )
        .into();
        held.frames.push_back(Retained {
            seq,
            kind,
            data: Arc::clone(&data),
        });
        while held.frames.len() > RETAINED_FRAMES {
            if let Some(oldest) = held.frames.pop_front() {
                held.boundary = oldest.seq;
            }
        }
        if let Link::Connected(connection) = &held.link {
            if connection.try_send(frame_event(&id, kind, &data)).is_err() {
                // Gone, or too far behind: it reconnects and replays from what
                // is retained.
                held.link = Link::drop_now();
            }
        }
    }
}

/// Whether a subscription showing `visible` is sent a change to `target`.
fn reaches(visible: &Visible, target: &Visible) -> bool {
    match target {
        Visible::Detail { run, filter } => {
            visible.run() == Some(run.as_str())
                && visible.detail_filter() == *filter
                && !matches!(visible, Visible::Sidebar)
        }
        other => visible == other,
    }
}

/// What a human-item view selects, or `None` for any other view.
fn human_items_view(view: &SubscriptionView) -> Option<(HumanItemFilter, Option<HumanItemId>)> {
    match view {
        SubscriptionView::HumanItems { filter, item } => Some((filter.clone(), item.clone())),
        _ => None,
    }
}

fn spec_of(view: &SubscriptionView) -> Option<&crate::filter::FilterSpec> {
    match view {
        SubscriptionView::Detail { filter, .. } | SubscriptionView::Timeline { filter, .. } => {
            filter.as_ref()
        }
        _ => None,
    }
}

/// A patch frame's operations, with `observed_at` moved to the instant it was
/// read — or nothing, where nothing moved.
fn patch_ops(observed_at: &mut String, now: &str, mut ops: Vec<Op>) -> Option<Vec<Op>> {
    if ops.is_empty() {
        return None;
    }
    *observed_at = now.to_owned();
    ops.push(Op::Set {
        parent: Vec::new(),
        last: crate::patch::Step::Key("observed_at".to_owned()),
        value: json!(now),
    });
    Some(ops)
}

fn frame_event(id: &str, kind: FrameKind, data: &str) -> Event {
    Event::default().id(id).event(kind.as_str()).data(data)
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
    fn expire(&mut self, grace: Duration) {
        let now = Instant::now();
        for held in self.subscriptions.values_mut() {
            if matches!(&held.link, Link::Connected(sender) if sender.is_closed()) {
                held.link = Link::Disconnected(now);
            }
        }
        let expired: Vec<SubscriptionId> = self
            .subscriptions
            .iter()
            .filter(|(_, held)| {
                matches!(held.link, Link::Disconnected(at) if now.duration_since(at) > grace)
            })
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
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
