//! What a subscription is served while a run's complete read is outstanding, and
//! what makes a held complete reading into the same wire shape: the projections
//! `docs/contract.md`'s progressive opening states.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::contract::{DETAIL_FIRST_KEPT, DETAIL_FIRST_LOADING};
use crate::patch::{self, Op, Step};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::{
    agents_of, fold_activity, lock, wire_window, Change, DetailBody, FilterKey, Folded, Hub,
    LiveRun, Reading, RunId, RunStore, SubscriptionId, Touched, Visible,
};
use crate::error::ApiError;
use crate::filter::EventFilter;
use crate::payload::live::{DetailInputs, Indexed, LiveDetail, LiveTimeline, TimelineScope};
use crate::payload::{ActivityFold, DeclaredMembers, ItemsWindow};
use onepipeline::agents::Agents;
use onepipeline::views::{Refreshed, RunView};

/// One path of a kept declaration taken from `from` into `into`, `*` meaning
/// each element or key.
fn keep(from: &Value, into: &mut Value, path: &[&str]) {
    let Some((step, rest)) = path.split_first() else {
        *into = from.clone();
        return;
    };
    if *step == "*" {
        match from {
            Value::Array(items) => {
                if !into.is_array() {
                    *into = Value::Array(vec![Value::Null; items.len()]);
                }
                if let Some(slots) = into.as_array_mut() {
                    for (item, slot) in items.iter().zip(slots.iter_mut()) {
                        keep(item, slot, rest);
                    }
                }
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    if !into.is_object() {
                        *into = Value::Object(Map::new());
                    }
                    keep(value, &mut into[key.as_str()], rest);
                    if into[key.as_str()].is_null() {
                        if let Some(held) = into.as_object_mut() {
                            held.remove(key);
                        }
                    }
                }
            }
            _ => {}
        }
        return;
    }
    let Some(next) = from.get(*step) else {
        return;
    };
    if !into.is_object() {
        *into = Value::Object(Map::new());
    }
    keep(next, &mut into[*step], rest);
}

/// `detail`, holding exactly what the contract names of a first answer.
pub(super) fn trimmed_detail(detail: &Value) -> Value {
    let mut trimmed = Value::Object(Map::new());
    for path in DETAIL_FIRST_KEPT {
        keep(detail, &mut trimmed, &path.split('.').collect::<Vec<_>>());
    }
    for path in DETAIL_FIRST_LOADING {
        let mut at = &mut trimmed;
        let steps: Vec<&str> = path.split('.').collect();
        let (last, parents) = steps.split_last().expect("a path has a step");
        for step in parents {
            if !at.is_object() {
                *at = Value::Object(Map::new());
            }
            at = &mut at[*step];
        }
        at[*last] = json!({ "loading": true });
    }
    trimmed["node_details"] = json!({});
    // A run with no graph yet is `graph: null`, as the complete document serves it.
    if trimmed["graph"].is_object() {
        for member in ["node_results", "node_control", "node_gated_by"] {
            if trimmed["graph"][member].is_null() {
                trimmed["graph"][member] = json!({});
            }
        }
    } else {
        trimmed["graph"] = Value::Null;
    }
    trimmed
}

/// A span, as a subscriber is shown it: no whole list of events.
pub(super) fn wire_span(
    span: &Value,
    window: ItemsWindow,
    complete: bool,
    since: Option<(String, u64)>,
) -> Value {
    let Some(fields) = span.as_object() else {
        return span.clone();
    };
    let events = fields.get("events").and_then(Value::as_array);
    let mut wire = Map::with_capacity(fields.len() + 1);
    for (key, value) in fields {
        if key == "events" || (key == "detail" && !complete) {
            continue;
        }
        wire.insert(key.clone(), value.clone());
    }
    let held = events.map_or(0, Vec::len);
    let listed = match window {
        ItemsWindow::Nothing | ItemsWindow::Counted => json!([]),
        ItemsWindow::Latest(_) => Value::Array(
            events
                .map(|events| {
                    events
                        .iter()
                        .filter(|event| since.as_ref().is_none_or(|since| row_key(event) >= *since))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default(),
        ),
        // A page's rendering is the page route's own, never a subscriber's.
        ItemsWindow::All | ItemsWindow::Page { .. } => {
            fields.get("events").cloned().unwrap_or(json!([]))
        }
    };
    wire.insert("events".to_owned(), listed);
    if complete && !wire.contains_key("events_total") {
        wire.insert("events_total".to_owned(), json!(held));
    }
    Value::Object(wire)
}

/// What a payload's operations touched of its `spans`.
enum Spans {
    /// The whole array was set.
    All,
    /// These elements moved, appended ones included.
    Indices(BTreeSet<usize>),
}

fn touched_spans(ops: &[Op], before: usize, after: usize) -> Spans {
    let mut indices = BTreeSet::new();
    for op in ops {
        let path: Vec<&Step> = match op {
            Op::Set { parent, last, .. } => parent.iter().chain(std::iter::once(last)).collect(),
            Op::Append { path, .. } => path.iter().collect(),
            Op::Delete { parent, .. } => parent.iter().collect(),
        };
        match path.as_slice() {
            [Step::Key(root)] if root == "spans" => {
                if matches!(op, Op::Set { .. }) {
                    return Spans::All;
                }
            }
            [Step::Key(root), Step::Index(index), ..] if root == "spans" => {
                indices.insert(*index);
            }
            _ => {}
        }
    }
    if before != after {
        indices.extend(before.min(after)..after);
    }
    Spans::Indices(indices)
}

/// The operations from what a subscriber's `wire` holds of a timeline to what
/// `payload` now says, applied to `wire`, given the operations that moved
/// `payload`: only the spans those touched are projected again.
pub(super) fn sync_timeline(
    wire: &mut Value,
    payload: &Value,
    full_ops: &[Op],
    window: ItemsWindow,
    complete: bool,
    since: Option<&(String, u64)>,
) -> Vec<Op> {
    let Some(new_spans) = payload["spans"].as_array() else {
        return Vec::new();
    };
    let before = wire["spans"].as_array().map_or(0, Vec::len);
    let mut ops = Vec::new();
    let mut path = vec![Step::Key("spans".to_owned())];
    // A node's window is held from where it started, so a row arriving joins its
    // own span's list and moves no other; the spans the operations touched are
    // the ones projected again, as for Overall.
    let since = since.cloned();
    let touched = touched_spans(full_ops, before, new_spans.len());
    match touched {
        Spans::All => {
            let whole: Vec<Value> = new_spans
                .iter()
                .map(|span| wire_span(span, window, complete, since.clone()))
                .collect();
            let new = Value::Array(whole);
            patch::diff_at(&mut path, &wire["spans"], &new, &mut ops);
            wire["spans"] = new;
        }
        Spans::Indices(indices) => {
            let mut appended = Vec::new();
            for index in indices {
                let Some(span) = new_spans.get(index) else {
                    continue;
                };
                let projected = wire_span(span, window, complete, since.clone());
                match wire["spans"]
                    .as_array_mut()
                    .and_then(|spans| spans.get_mut(index))
                {
                    Some(held) => {
                        path.push(Step::Index(index));
                        patch::diff_at(&mut path, held, &projected, &mut ops);
                        path.pop();
                        *held = projected;
                    }
                    None => appended.push(projected),
                }
            }
            if !appended.is_empty() {
                ops.push(Op::Append {
                    path: path.clone(),
                    values: appended.clone(),
                });
                if let Some(spans) = wire["spans"].as_array_mut() {
                    spans.extend(appended);
                }
            }
        }
    }
    ops
}

/// Where a row stands in a timeline's order: its stamp, then its place in the store.
fn row_key(event: &Value) -> (String, u64) {
    (
        event["at"].as_str().unwrap_or_default().to_owned(),
        event["journal_order"].as_u64().unwrap_or_default(),
    )
}

/// Under [`ItemsWindow::Latest`], the earliest row of the latest `n` across every
/// span: each span lists only its own rows from there on. `None` where every row
/// is within the window.
pub(super) fn window_start(payload: &Value, window: ItemsWindow) -> Option<(String, u64)> {
    let ItemsWindow::Latest(latest) = window else {
        return None;
    };
    let mut keys: Vec<(String, u64)> = payload["spans"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|span| span["events"].as_array().into_iter().flatten())
        .map(row_key)
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys.len()
        .checked_sub(latest)
        .map(|from| keys[from].clone())
}

/// A timeline payload as a subscriber is shown it, its window held from `since`:
/// a node's window starts where it started when the view was first projected, so
/// a row arriving is appended to it rather than moving every span's list.
pub(super) fn wire_timeline_from(
    payload: &Value,
    window: ItemsWindow,
    complete: bool,
    since: Option<(String, u64)>,
) -> Value {
    let mut wire = Map::new();
    if let Some(fields) = payload.as_object() {
        for (key, value) in fields {
            if key != "spans" {
                wire.insert(key.clone(), value.clone());
            }
        }
    }
    let spans: Vec<Value> = payload["spans"]
        .as_array()
        .map(|spans| {
            spans
                .iter()
                .map(|span| wire_span(span, window, complete, since.clone()))
                .collect()
        })
        .unwrap_or_default();
    wire.insert("spans".to_owned(), Value::Array(spans));
    Value::Object(wire)
}

/// A payload's `progress`.
pub(super) fn progress(complete: bool, loading: &[&str], failed: Option<&str>) -> Value {
    let mut value = json!({ "complete": complete, "loading": loading });
    if let Some(failed) = failed {
        value["failed"] = json!(failed);
    }
    value
}

/// A run's complete read, off the run's lock: everything a publication swaps in.
struct CompleteRead {
    view: RunView,
    indexed: Indexed,
    declared: DeclaredMembers,
    agents: Option<Agents>,
    agents_stamp: Option<(u64, std::time::SystemTime)>,
    telemetry: Folded,
    activity: ActivityFold,
    details: HashMap<FilterKey, (EventFilter, LiveDetail)>,
    timelines: Vec<(TimelineScope, FilterKey, EventFilter, LiveTimeline)>,
}

/// What a held run is showing, which a complete read has to have built.
type Shown = (
    Vec<(FilterKey, EventFilter)>,
    Vec<(TimelineScope, FilterKey, EventFilter)>,
);

impl CompleteRead {
    fn open(store: &RunStore, run: &RunId) -> Result<Self, ApiError> {
        let view = store.view(run)?;
        let indexed = Indexed::of(&view);
        let declared = store.declared(&view);
        let paths = store.paths_of(run);
        let agents = agents_of(&paths);
        let agents_stamp = super::file_stamp(&paths.oneharness_sessions());
        let telemetry = Folded::of(&view);
        let activity = fold_activity(&view);
        Ok(Self {
            view,
            indexed,
            declared,
            agents,
            agents_stamp,
            telemetry,
            activity,
            details: HashMap::new(),
            timelines: Vec::new(),
        })
    }

    fn inputs(&self) -> DetailInputs<'_> {
        self.telemetry.inputs(
            self.agents.as_ref().map(|agents| agents.sessions.len()),
            &self.activity,
        )
    }

    /// Build whatever `shown` names and this read has not.
    fn build(&mut self, shown: &Shown) {
        for (key, filter) in &shown.0 {
            if !self.details.contains_key(key) {
                let built = LiveDetail::build(
                    &self.view,
                    &self.indexed,
                    &self.declared,
                    filter.clone(),
                    &self.inputs(),
                );
                self.details.insert(key.clone(), (filter.clone(), built));
            }
        }
        // Overall is built whoever shows it now: a tab opening it once this read is
        // published must not wait on a build of the whole run under the run's lock.
        let overall = (
            TimelineScope::Run,
            FilterKey::default(),
            EventFilter::default(),
        );
        for (scope, key, filter) in shown.1.iter().chain(std::iter::once(&overall)) {
            if !self
                .timelines
                .iter()
                .any(|(held_scope, held_key, ..)| held_scope == scope && held_key == key)
            {
                let built = LiveTimeline::build(
                    &self.view,
                    &self.indexed,
                    &self.declared,
                    scope.clone(),
                    filter.clone(),
                    self.agents.as_ref(),
                    // Overall lists no rows once published, only how many each span
                    // holds: rendering the run's every row is most of what the rest
                    // would cost. A node renders all of its own, for its pages.
                    if matches!(scope, TimelineScope::Run) {
                        ItemsWindow::Counted
                    } else {
                        ItemsWindow::All
                    },
                );
                self.timelines
                    .push((scope.clone(), key.clone(), filter.clone(), built));
            }
        }
    }

    /// Fold what was appended since the read: a publication moves no value
    /// backward. Whether a value moved is the subscriber's to learn from the
    /// publication's own difference.
    fn catch_up(&mut self) {
        let touched = match self.view.refresh() {
            Ok(Refreshed::Unchanged) => Some(Touched::default()),
            Ok(Refreshed::Appended { first }) => Some(self.indexed.extend(&self.view, first)),
            Ok(Refreshed::Reread) => {
                self.indexed = Indexed::of(&self.view);
                self.activity = fold_activity(&self.view);
                None
            }
            // What was read stands; the next tick reports a run that cannot be.
            Err(_) => return,
        };
        if let Some(touched) = &touched {
            if touched.any() {
                let at = self.view.events.len().saturating_sub(touched.records);
                for event in &self.view.events[at..] {
                    self.activity.absorb(event, &EventFilter::default());
                }
                self.activity.settle();
            }
        }
        let inputs_activity = self.activity.clone();
        for (_, detail) in self.details.values_mut() {
            detail.refreshed(
                &self.view,
                &self.indexed,
                &self.declared,
                touched.as_ref(),
                &self.telemetry.inputs(
                    self.agents.as_ref().map(|agents| agents.sessions.len()),
                    &inputs_activity,
                ),
            );
        }
        for (_, _, _, timeline) in &mut self.timelines {
            timeline.refreshed(
                &self.view,
                &self.indexed,
                &self.declared,
                touched.as_ref(),
                self.agents.as_ref(),
                false,
            );
        }
    }
}

impl LiveRun {
    fn shown(&self) -> Shown {
        (
            self.details
                .iter()
                .map(|(key, held)| (key.clone(), held.filter.clone()))
                .collect(),
            self.timelines
                .iter()
                .map(|(scope, key, held)| (scope.clone(), key.clone(), held.filter.clone()))
                .collect(),
        )
    }
}

fn same_shown(left: &Shown, right: &Shown) -> bool {
    left.0.len() == right.0.len()
        && left.1.len() == right.1.len()
        && left
            .0
            .iter()
            .all(|(key, _)| right.0.iter().any(|(other, _)| other == key))
        && left
            .1
            .iter()
            .all(|(scope, key, _)| right.1.iter().any(|(s, k, _)| s == scope && k == key))
}

impl Hub {
    /// Start `live`'s complete read on its own thread, publishing when it ends.
    pub(super) fn spawn_complete(&self, live: &Arc<Mutex<LiveRun>>) {
        let hub = self.clone();
        let live = Arc::clone(live);
        std::thread::Builder::new()
            .name("complete-read".to_owned())
            .spawn(move || hub.run_complete_read(&live))
            .ok();
    }

    fn run_complete_read(&self, live: &Arc<Mutex<LiveRun>>) {
        let shared = &self.0;
        std::thread::sleep(shared.complete_hold);
        let run = lock(live).run.clone();
        let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            CompleteRead::open(&shared.store, &run)
        }));
        let mut read = match opened {
            Ok(Ok(read)) => read,
            Ok(Err(error)) => return self.fail_complete(live, &error.to_string()),
            Err(_) => return self.fail_complete(live, "the complete read failed"),
        };
        loop {
            // A run nobody shows any more is let go, not published.
            let held = lock(&shared.runs)
                .get(&run)
                .is_some_and(|current| Arc::ptr_eq(current, live));
            if !held {
                return;
            }
            let shown = lock(live).shown();
            let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                read.build(&shown);
                read.catch_up();
            }));
            if built.is_err() {
                return self.fail_complete(live, "the complete read failed");
            }
            let mut guard = lock(live);
            let held_run = &mut *guard;
            if !same_shown(&held_run.shown(), &shown) {
                continue;
            }
            // Under the lock, so nothing appended can slip between this catching
            // up and the swap below.
            read.catch_up();
            self.publish(held_run, read);
            return;
        }
    }

    /// Fail the complete read: its subscribers are told, and a later
    /// subscription retries.
    fn fail_complete(&self, live: &Arc<Mutex<LiveRun>>, why: &str) {
        let shared = &self.0;
        let mut guard = lock(live);
        let run = &mut *guard;
        if !matches!(run.reading, Reading::Complete) {
            run.reading = Reading::Failed(why.to_owned());
        }
        let now = crate::payload::now_rfc3339();
        let mut changes: Vec<(Visible, Change)> = Vec::new();
        let detail_progress = run.detail_progress();
        for (key, detail) in &mut run.details {
            detail.progress = detail_progress.clone();
            detail.observed_at = now.clone();
            let ops = vec![
                crate::patch::Op::Set {
                    parent: Vec::new(),
                    last: crate::patch::Step::Key("progress".to_owned()),
                    value: detail_progress.clone(),
                },
                crate::patch::Op::Set {
                    parent: Vec::new(),
                    last: crate::patch::Step::Key("observed_at".to_owned()),
                    value: serde_json::json!(now),
                },
            ];
            changes.push((
                Visible::Detail {
                    run: run.run.clone(),
                    filter: key.clone(),
                },
                Change::Detail {
                    run: run.run.clone(),
                    ops,
                },
            ));
        }
        let progresses: Vec<serde_json::Value> = run
            .timelines
            .iter()
            .map(|(scope, ..)| run.timeline_progress(scope))
            .collect();
        for ((scope, key, timeline), progress) in run.timelines.iter_mut().zip(progresses) {
            timeline.wire["progress"] = progress.clone();
            timeline.observed_at = now.clone();
            let ops = vec![
                crate::patch::Op::Set {
                    parent: Vec::new(),
                    last: crate::patch::Step::Key("progress".to_owned()),
                    value: progress,
                },
                crate::patch::Op::Set {
                    parent: Vec::new(),
                    last: crate::patch::Step::Key("observed_at".to_owned()),
                    value: serde_json::json!(now),
                },
            ];
            changes.push((
                Visible::Timeline {
                    run: run.run.clone(),
                    scope: scope.clone(),
                    filter: key.clone(),
                },
                Change::Timeline {
                    run: run.run.clone(),
                    scope: scope.clone(),
                    ops,
                },
            ));
        }
        self.deliver(&changes, shared);
    }

    /// Swap `read` in and send every subscriber one patch of everything the rest
    /// carries, `progress` among it.
    fn publish(&self, run: &mut LiveRun, read: CompleteRead) {
        let shared = &self.0;
        let CompleteRead {
            view,
            indexed,
            declared,
            agents,
            agents_stamp,
            telemetry,
            activity,
            mut details,
            timelines,
        } = read;
        run.view = view;
        run.indexed = indexed;
        run.declared = declared;
        run.agents = agents;
        run.agents_stamp = agents_stamp;
        run.telemetry = telemetry;
        run.activity = activity;
        run.reading = Reading::Complete;
        run.liveness = run.view.liveness();
        let now = crate::payload::now_rfc3339();
        let mut changes: Vec<(Visible, Change)> = Vec::new();
        let progress = run.detail_progress();
        for (key, held) in &mut run.details {
            let Some((_, built)) = details.remove(key) else {
                continue;
            };
            let old = held.wire();
            held.body = DetailBody::Live(built);
            held.progress = progress.clone();
            let new = held.wire();
            let mut ops = Vec::new();
            if let Err(refused) = crate::patch::diff(&old, &new, &mut ops) {
                eprintln!("onepipeline-api: a run's rest could not be patched: {refused}");
            }
            if let Some(ops) = super::patch_ops(&mut held.observed_at, &now, ops) {
                changes.push((
                    Visible::Detail {
                        run: run.run.clone(),
                        filter: key.clone(),
                    },
                    Change::Detail {
                        run: run.run.clone(),
                        ops,
                    },
                ));
            }
        }
        let mut timelines: Vec<(TimelineScope, FilterKey, EventFilter, LiveTimeline)> = timelines;
        let progresses: Vec<serde_json::Value> = run
            .timelines
            .iter()
            .map(|(scope, ..)| run.timeline_progress(scope))
            .collect();
        for ((scope, key, held), progress) in run.timelines.iter_mut().zip(progresses) {
            let Some(at) = timelines
                .iter()
                .position(|(built_scope, built_key, ..)| built_scope == scope && built_key == key)
            else {
                continue;
            };
            let (.., built) = timelines.swap_remove(at);
            let window = wire_window(scope);
            let since = window_start(built.payload(), window);
            let mut wire = wire_timeline_from(built.payload(), window, true, since.clone());
            wire["progress"] = progress;
            let mut ops = Vec::new();
            if let Err(refused) = crate::patch::diff(&held.wire, &wire, &mut ops) {
                eprintln!("onepipeline-api: a run's rest could not be patched: {refused}");
            }
            held.live = built;
            held.wire = wire;
            held.window = window;
            held.since = since;
            if let Some(ops) = super::patch_ops(&mut held.observed_at, &now, ops) {
                changes.push((
                    Visible::Timeline {
                        run: run.run.clone(),
                        scope: scope.clone(),
                        filter: key.clone(),
                    },
                    Change::Timeline {
                        run: run.run.clone(),
                        scope: scope.clone(),
                        ops,
                    },
                ));
            }
        }
        if let Some(at) = timelines
            .iter()
            .position(|(scope, key, ..)| *scope == TimelineScope::Run && key.names_none())
        {
            let (scope, key, filter, built) = timelines.swap_remove(at);
            if !run
                .timelines
                .iter()
                .any(|(held_scope, held_key, _)| *held_scope == scope && *held_key == key)
            {
                let window = wire_window(&scope);
                let since = window_start(built.payload(), window);
                let mut wire = wire_timeline_from(built.payload(), window, true, since.clone());
                wire["progress"] = run.timeline_progress(&scope);
                run.timelines.push((
                    scope,
                    key,
                    super::HeldTimeline {
                        behind: super::Behind::default(),
                        since,
                        live: built,
                        wire,
                        window,
                        filter,
                        observed_at: now.clone(),
                    },
                ));
            }
        }
        self.deliver(&changes, shared);
    }

    fn deliver(&self, changes: &[(Visible, Change)], shared: &super::Shared) {
        if changes.is_empty() {
            return;
        }
        let mut state = lock(&shared.state);
        let reach: Vec<(SubscriptionId, Visible)> = state
            .subscriptions
            .iter()
            .map(|(id, held)| (*id, Visible::of(&held.view)))
            .collect();
        for (id, visible) in reach {
            for (target, change) in changes {
                if super::reaches(&visible, target) {
                    self.emit(&mut state, id, change);
                }
            }
        }
    }

    /// Read the sidebar, on its own thread, and send it as `subscription`'s
    /// stream's first frame, whatever waited behind it after it.
    pub(super) fn send_sidebar(&self, subscription: SubscriptionId, run: Option<RunId>) {
        let hub = self.clone();
        std::thread::Builder::new()
            .name("sidebar-snapshot".to_owned())
            .spawn(move || {
                let shared = &hub.0;
                hub.first_look();
                if let Some(run) = &run {
                    if let Some(missing) = super::missing_row(shared, run) {
                        let mut sidebar = lock(&shared.sidebar);
                        if let Some(super::RowChange::Changed(row)) =
                            sidebar.add(missing.0, missing.1, missing.2)
                        {
                            let mut state = lock(&shared.state);
                            let ids: Vec<SubscriptionId> =
                                state.subscriptions.keys().copied().collect();
                            for id in ids {
                                hub.emit(&mut state, id, &Change::Row(Arc::clone(&row)));
                            }
                        }
                    }
                }
                let sidebar = lock(&shared.sidebar);
                let rows = serde_json::Value::Array(sidebar.snapshot()).to_string();
                let mut state = lock(&shared.state);
                hub.emit(&mut state, subscription, &Change::SidebarRows(rows.into()));
                let flushed = state
                    .subscriptions
                    .get_mut(&subscription)
                    .and_then(|held| held.deferred.take())
                    .unwrap_or_default();
                for change in flushed {
                    hub.emit(&mut state, subscription, &change);
                }
            })
            .ok();
    }
}
