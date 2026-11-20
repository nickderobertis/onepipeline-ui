//! `GET /api/v2/runs/{run}/timeline/events`: the rows a span's list leaves out; and
//! `GET /api/v2/runs/{run}/timeline/node-stream`: every row of one node's timeline;
//! and `GET /api/v2/runs/{run}/artifacts/{id}`, answered from a run's live reading
//! where the server holds one that names the artifact.
//!
//! Before a run's complete read ends this reads one share of its journal alone
//! and never waits on that read; after, it reads a share's timeline kept inside
//! the server: built from the complete read the first time that share is asked
//! for, then kept current by each refresh rather than rebuilt per request.

use onepipeline::journal::{self, Selection};
use serde_json::{json, Map, Value};

use super::{agents_of, lock, Held, Hub, LiveRun};
use crate::contract::{
    ArtifactId, Envelope, NodeId, NodeStreamSplit, PageCursor, PageOwner, RunId,
    TimelineEventsQuery,
};
use crate::api::RunApi as _;
use crate::error::ApiError;
use crate::payload::live::{Indexed, LiveTimeline, TimelineScope};
use crate::payload::{self, ItemsWindow};
use crate::store::RunStore;

impl Hub {
    /// One recorded artifact, from the reading a live subscription already holds of
    /// its run where that reading names it, and otherwise from a reading of the run
    /// made for this request.
    ///
    /// A person opens a refused edit's complete refusal on a run they are watching,
    /// so the record naming it is already in the server's reading of that run — a
    /// first screen's included, which holds every record but heartbeats and turn
    /// activity — and reading a long run's whole journal again for one kept file is
    /// what that person would wait on. Resolution is the same either way.
    ///
    /// # Errors
    ///
    /// `404` for a run, or an artifact the run does not hold.
    pub fn artifact(&self, run: &RunId, id: &ArtifactId) -> Result<Envelope<Value>, ApiError> {
        let shared = &self.0;
        let live = lock(&shared.runs).get(run).cloned();
        if let Some(live) = live {
            let held = payload::artifact(&lock(&live).view, id);
            if let Some(held) = held {
                return Ok(RunStore::envelope(held));
            }
        }
        shared.store.artifact(run, id)
    }

    /// One page of a run's rows.
    ///
    /// # Errors
    ///
    /// `404` for a run, node or span the run does not hold, and a filter's
    /// refusal.
    pub fn timeline_events(
        &self,
        run: &RunId,
        query: &TimelineEventsQuery,
    ) -> Result<Envelope<Value>, ApiError> {
        let shared = &self.0;
        let paths = shared.store.present(run)?;
        let live = lock(&shared.runs).get(run).cloned();
        let page = match live {
            Some(live) => {
                let (complete, kept) = {
                    let guard = lock(&live);
                    (guard.complete(), guard.holds_whole(query))
                };
                if complete {
                    // Read before the lock, so a view not yet kept costs the run's
                    // other readers only its share's build.
                    let selected = (!kept).then(|| read_share(&paths, &query.owner));
                    let mut guard = lock(&live);
                    from_kept(&mut guard, query, selected.as_ref())?
                } else {
                    // A reading holding every record of the node whole, a short
                    // journal's, builds its page; one that holds some of them as
                    // their heads fetches the rest by their handles, since a page
                    // lists rows a first screen did not fetch; any other share, or
                    // one whose fetch is refused, is read afresh.
                    let held = lock(&live).hold_page_owner(&query.owner);
                    let selected = (!held).then(|| read_share(&paths, &query.owner));
                    let mut guard = lock(&live);
                    from_selected(&mut guard, query, selected.as_ref())?
                }
            }
            None => {
                let node = match &query.owner {
                    PageOwner::Node(node) | PageOwner::RunNode(node) => Some(node),
                    PageOwner::Run => None,
                };
                // The run's first reading, for its state and plan: a short journal's
                // holds every record whole and builds the page, and a longer one's
                // heads have the page's share read beside them.
                let mut alone =
                    LiveRun::open_selective(&shared.store, run, node, shared.whole_read)?;
                from_selected(&mut alone, query, None)?
            }
        };
        Ok(RunStore::envelope(page))
    }
}

/// Every row of one node's own timeline, newest first, and where the server's time
/// on it went: what `GET .../timeline/node-stream` sends.
#[derive(Debug)]
pub struct NodeStream {
    /// Every row, one per record, newest first.
    pub rows: Vec<Value>,
    /// The heads read, the node's fetch and the build, in seconds.
    pub split: NodeStreamSplit,
}

impl Hub {
    /// Every row of `node`'s own timeline, read apart from any subscription's reading
    /// and without the run's lock: the run's heads, then the node's records fetched
    /// by their handles, built whole and unfiltered.
    ///
    /// # Errors
    ///
    /// `404` for a run or node the run does not hold, and the engine's refusal of
    /// the read.
    pub fn node_stream(&self, run: &RunId, node: &NodeId) -> Result<NodeStream, ApiError> {
        let paths = self.0.store.present(run)?;
        let read = super::first_screen::read_node(&paths, node.as_str())
            .map_err(|error| ApiError::from_engine(run, error))?;
        let building = std::time::Instant::now();
        let view = read.view;
        if !(payload::plan_names(&view, node.as_str())
            || view
                .events
                .iter()
                .any(|event| event.labels.node.as_deref() == Some(node.as_str())))
        {
            return Err(ApiError::NodeNotFound(node.clone()));
        }
        let filter = RunStore::resolve(&view, None)?;
        let declared = self.0.store.declared(&view);
        let agents = agents_of(&paths);
        let built = LiveTimeline::build(
            &view,
            &read.indexed,
            &declared,
            TimelineScope::Node(node.clone()),
            filter,
            agents.as_ref(),
            ItemsWindow::All,
        );
        let payload = built.payload();
        let spans = payload["spans"].as_array().map_or(&[][..], Vec::as_slice);
        let mut rows = rows_by_record(spans, |_| true);
        rows.reverse();
        let rows: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
        Ok(NodeStream {
            rows,
            split: NodeStreamSplit {
                heads_s: read.heads_s,
                fetch_s: read.fetch_s,
                build_s: building.elapsed().as_secs_f64(),
            },
        })
    }
}

/// The key a row is held under: the record it reads, so the rows of two records
/// sharing a row `id` — a turn's opening and its close — are both kept. A row
/// naming no record falls back to its `id`.
fn record_key(row: &Value) -> &str {
    row["record_id"]
        .as_str()
        .or_else(|| row["id"].as_str())
        .unwrap_or_default()
}

/// Every row of `spans` that `keep` admits, once per record (the first span listing
/// it owns it), each with its `span_id`, oldest first.
fn rows_by_record(spans: &[Value], keep: impl Fn(i128) -> bool) -> Vec<((i128, u64), Value)> {
    let mut seen = std::collections::HashSet::new();
    let mut rows: Vec<((i128, u64), Value)> = Vec::new();
    for owner in spans {
        for row in owner["events"].as_array().into_iter().flatten() {
            let Some(order) = payload::row_order(row) else {
                continue;
            };
            if !keep(order.0) || !seen.insert(record_key(row).to_owned()) {
                continue;
            }
            let mut served = row.clone();
            served["span_id"] = owner["id"].clone();
            rows.push((order, served));
        }
    }
    rows.sort_by_key(|(order, _)| *order);
    rows
}

fn read_share(
    paths: &onepipeline::views::RunPaths,
    owner: &PageOwner,
) -> onepipeline::journal::SelectedRecords {
    let selection = match owner {
        PageOwner::Run => Selection::Share(None),
        PageOwner::Node(node) | PageOwner::RunNode(node) => Selection::Share(Some(node.as_str())),
    };
    journal::read_selected(&paths.journal(), &selection)
}

/// Whether `run`'s own reading holds every record a page of `owner` lists whole: a
/// node's, where the reading read the journal whole. A heads read holds only a
/// first screen's records whole, and a run-level share and a run's node share are
/// read apart, as their scopes are built over them.
fn holds_owner(run: &LiveRun, owner: &PageOwner) -> bool {
    match owner {
        PageOwner::Node(node) => run.indexed.holds_share(node.as_str()),
        PageOwner::Run | PageOwner::RunNode(_) => false,
    }
}

fn scope_of(owner: &PageOwner) -> TimelineScope {
    match owner {
        PageOwner::Run => TimelineScope::RunShare,
        PageOwner::RunNode(node) => TimelineScope::NodeShare(node.clone()),
        PageOwner::Node(node) => TimelineScope::Node(node.clone()),
    }
}

fn check_node(run: &LiveRun, owner: &PageOwner) -> Result<(), ApiError> {
    if let PageOwner::Node(node) | PageOwner::RunNode(node) = owner {
        // The plan's tasks read off the plan itself rather than the detail built
        // from it, which a page has no other use for.
        if !(payload::plan_names(&run.view, node.as_str()) || run.knows_node(node, &Value::Null)) {
            return Err(ApiError::NodeNotFound(node.clone()));
        }
    }
    Ok(())
}

/// A page before the run's complete read ended, from that share's records alone:
/// `selected`, or the run's own reading where that already holds them.
fn from_selected(
    run: &mut LiveRun,
    query: &TimelineEventsQuery,
    selected: Option<&onepipeline::journal::SelectedRecords>,
) -> Result<Value, ApiError> {
    check_node(run, &query.owner)?;
    let filter = RunStore::resolve(&run.view, query.filter.as_ref())?;
    // Every scope lays the run's harness sessions, as the timeline it pages does.
    if run.agents.is_none() {
        run.agents = agents_of(&run.view.paths);
    }
    let held = match &query.owner {
        PageOwner::Run => None,
        PageOwner::Node(node) | PageOwner::RunNode(node) => Some(node.as_str()),
    };
    let scope = scope_of(&query.owner);
    // A reading that no longer holds the share when this lock is taken reads it here.
    let reread = match selected {
        Some(_) => None,
        None if holds_owner(run, &query.owner) => None,
        None => Some(read_share(&run.view.paths, &query.owner)),
    };
    let share: Option<Indexed> = selected
        .or(reread.as_ref())
        .map(|selected| run.indexed.reading_share(&run.view, selected, held));
    let indexed = share.as_ref().unwrap_or(&run.indexed);
    // Only this page's rows are rendered and the rest of the share counted,
    // except for one span asked for whole, whose own list is the answer.
    let window = match query.span {
        Some(_) => ItemsWindow::All,
        None => ItemsWindow::Page {
            before: query.cursor.map(|cursor| (cursor.at, cursor.order)),
            from: query.from,
            to: query.to,
            limit: query.limit.get(),
        },
    };
    // A page's records are lent to its build rather than copied, as a first
    // answer's are.
    let built = LiveTimeline::build_lending(
        &mut run.view,
        indexed,
        &run.declared,
        scope,
        filter,
        run.agents.as_ref(),
        window,
    );
    let mut page = page_of(&built.payload()["spans"], query)?;
    if query.span.is_none() {
        page["total"] = json!(built.counted());
        // The window rendered this page and the row before it at most, so whether
        // an older page exists is read off every row the cursor leaves, counted.
        let rows = page["rows"].as_array().map_or(&[][..], Vec::as_slice);
        let more = built.older() > rows.len();
        page["next_cursor"] = match rows.first().and_then(payload::row_order) {
            Some((at, order)) if more => json!(PageCursor { at, order }.encode()),
            _ => Value::Null,
        };
    }
    Ok(page)
}

/// A page once the complete read was published, from a share's kept timeline,
/// which is built from `selected` the first time it is asked for and then kept.
fn from_kept(
    run: &mut LiveRun,
    query: &TimelineEventsQuery,
    selected: Option<&journal::SelectedRecords>,
) -> Result<Value, ApiError> {
    check_node(run, &query.owner)?;
    let filter = RunStore::resolve(&run.view, query.filter.as_ref())?;
    let scope = scope_of(&query.owner);
    let key = super::FilterKey::of(query.filter.as_ref());
    if let Some((_, _, held)) = run.timelines.iter().find(|(held_scope, held_key, held)| {
        *held_scope == scope && *held_key == key && held.live.renders_whole()
    }) {
        return page_of(&held.live.payload()["spans"], query);
    }
    let at = run
        .history
        .iter()
        .position(|(held_scope, held_key, _)| *held_scope == scope && *held_key == key);
    let at = match at {
        Some(at) => at,
        None => {
            if run.agents.is_none() {
                run.agents = agents_of(&run.view.paths);
            }
            let held = match &query.owner {
                PageOwner::Run => None,
                PageOwner::Node(node) | PageOwner::RunNode(node) => Some(node.as_str()),
            };
            // A whole store's build is seconds under this run's lock; the share's is
            // what the page needs.
            let indexed: Indexed = match selected {
                Some(selected) => run.indexed.reading_share(&run.view, selected, held),
                None => run.indexed.reading_share(
                    &run.view,
                    &read_share(&run.view.paths, &query.owner),
                    held,
                ),
            };
            let built = LiveTimeline::build(
                &run.view,
                &indexed,
                &run.declared,
                scope.clone(),
                filter,
                run.agents.as_ref(),
                ItemsWindow::All,
            );
            run.history.push((scope, key, Held { payload: built }));
            run.history.len() - 1
        }
    };
    page_of(&run.history[at].2.payload.payload()["spans"], query)
}

impl LiveRun {
    /// Whether a page of `query` is answered from a timeline already kept whole.
    fn holds_whole(&self, query: &TimelineEventsQuery) -> bool {
        let scope = scope_of(&query.owner);
        let key = super::FilterKey::of(query.filter.as_ref());
        self.timelines.iter().any(|(held_scope, held_key, held)| {
            *held_scope == scope && *held_key == key && held.live.renders_whole()
        }) || self
            .history
            .iter()
            .any(|(held_scope, held_key, _)| *held_scope == scope && *held_key == key)
    }
}

/// The asked-for page of `spans`' rows, and the span when one was named.
fn page_of(spans: &Value, query: &TimelineEventsQuery) -> Result<Value, ApiError> {
    let spans = spans.as_array().map_or(&[][..], Vec::as_slice);
    let (spans, span) = match &query.span {
        Some(id) => {
            let found = spans
                .iter()
                .find(|span| span["id"] == id.as_str())
                .ok_or_else(|| ApiError::SpanNotFound(id.clone()))?;
            (std::slice::from_ref(found), Some(found))
        }
        None => (spans, None),
    };
    // Once per record across spans, keyed as the node stream keys them.
    let mut rows = rows_by_record(spans, |at| {
        !(query.from.is_some_and(|from| at < from) || query.to.is_some_and(|to| at > to))
    });
    let total = rows.len();
    let older = query.cursor.map_or(rows.len(), |cursor| {
        rows.partition_point(|(order, _)| {
            PageCursor {
                at: order.0,
                order: order.1,
            } < cursor
        })
    });
    let start = older.saturating_sub(query.limit.get());
    let next_cursor = (start > 0).then(|| {
        PageCursor {
            at: rows[start].0 .0,
            order: rows[start].0 .1,
        }
        .encode()
    });
    let page: Vec<Value> = rows.drain(start..older).map(|(_, row)| row).collect();
    let mut answer = Map::new();
    answer.insert("rows".into(), Value::Array(page));
    answer.insert("next_cursor".into(), json!(next_cursor));
    answer.insert("total".into(), json!(total));
    if let Some(span) = span {
        let mut fields = span.clone();
        if let Some(object) = fields.as_object_mut() {
            let held = object
                .get("events")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            object.remove("events");
            object.insert("events_total".into(), json!(held));
        }
        answer.insert("span".into(), fields);
    }
    Ok(Value::Object(answer))
}
