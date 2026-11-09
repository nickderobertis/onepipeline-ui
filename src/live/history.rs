//! `GET /api/v2/runs/{run}/timeline/events`: the rows a span's list leaves out.
//!
//! Before a run's complete read ends this reads one share of its journal alone
//! and never waits on that read; after, it reads a share's timeline kept inside
//! the server, current from each refresh and rebuilt on no request.

use onepipeline::journal::{self, Selection};
use serde_json::{json, Map, Value};

use super::{agents_of, lock, Held, Hub, LiveRun};
use crate::contract::{Envelope, PageCursor, PageOwner, RunId, TimelineEventsQuery};
use crate::error::ApiError;
use crate::payload::live::{Indexed, LiveTimeline, TimelineScope};
use crate::payload::{self, ItemsWindow};
use crate::store::RunStore;

impl Hub {
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
                    let selected = read_share(&paths, &query.owner);
                    let mut guard = lock(&live);
                    from_selected(&mut guard, query, &selected)?
                }
            }
            None => {
                let selected = read_share(&paths, &query.owner);
                let node = match &query.owner {
                    PageOwner::Node(node) | PageOwner::RunNode(node) => Some(node),
                    PageOwner::Run => None,
                };
                let mut alone = LiveRun::open_selective(&shared.store, run, node)?;
                from_selected(&mut alone, query, &selected)?
            }
        };
        Ok(RunStore::envelope(page))
    }
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

fn scope_of(owner: &PageOwner) -> TimelineScope {
    match owner {
        PageOwner::Run => TimelineScope::RunShare,
        PageOwner::RunNode(node) => TimelineScope::NodeShare(node.clone()),
        PageOwner::Node(node) => TimelineScope::Node(node.clone()),
    }
}

fn check_node(run: &LiveRun, owner: &PageOwner) -> Result<(), ApiError> {
    if let PageOwner::Node(node) | PageOwner::RunNode(node) = owner {
        let plan = payload::first_detail(&run.view)["graph"]["plan"].clone();
        if !run.knows_node(node, &plan) {
            return Err(ApiError::NodeNotFound(node.clone()));
        }
    }
    Ok(())
}

/// A page before the run's complete read ended, from that share's records alone.
fn from_selected(
    run: &mut LiveRun,
    query: &TimelineEventsQuery,
    selected: &onepipeline::journal::SelectedRecords,
) -> Result<Value, ApiError> {
    check_node(run, &query.owner)?;
    let filter = RunStore::resolve(&run.view, query.filter.as_ref())?;
    if matches!(query.owner, PageOwner::Node(_)) && run.agents.is_none() {
        run.agents = agents_of(&run.view.paths);
    }
    let held = match &query.owner {
        PageOwner::Run => None,
        PageOwner::Node(node) | PageOwner::RunNode(node) => Some(node.as_str()),
    };
    let scope = scope_of(&query.owner);
    let indexed: Indexed = run.indexed.reading_share(&run.view, selected, held);
    let built = LiveTimeline::build(
        &run.view,
        &indexed,
        &run.declared,
        scope,
        filter,
        run.agents.as_ref(),
        ItemsWindow::All,
    );
    page_of(&built.payload()["spans"], query)
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
            if matches!(query.owner, PageOwner::Node(_)) && run.agents.is_none() {
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
            run.history.push((
                scope,
                key,
                Held {
                    payload: built,
                    observed_at: String::new(),
                },
            ));
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
    let mut seen = std::collections::HashSet::new();
    let mut rows: Vec<((i128, u64), Value)> = Vec::new();
    for owner in spans {
        for row in owner["events"].as_array().into_iter().flatten() {
            let Some(order) = payload::row_order(row) else {
                continue;
            };
            if query.from.is_some_and(|from| order.0 < from)
                || query.to.is_some_and(|to| order.0 > to)
            {
                continue;
            }
            if span.is_none() {
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                if !seen.insert(id) {
                    continue;
                }
            }
            let mut served = row.clone();
            served["span_id"] = owner["id"].clone();
            rows.push((order, served));
        }
    }
    rows.sort_by_key(|(order, _)| *order);
    let total = rows.len();
    let older = query.cursor.map_or(rows.len(), |cursor| {
        rows.partition_point(|(order, _)| {
            PageCursor {
                at: order.0,
                order: order.1,
            } < cursor
        })
    });
    let start = older.saturating_sub(query.limit);
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
