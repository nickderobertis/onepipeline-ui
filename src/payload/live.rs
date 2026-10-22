//! Keeping a served detail and timeline current from the records a refresh
//! appended, rather than rebuilding them whole.
//!
//! `RunView::refresh` reads, parses and folds only the records appended since the
//! view last read. What this module adds is the payload half of the same rule:
//! the run's records are indexed by the **owner** each belongs to in a payload —
//! the run itself for a record that names no node, and otherwise the node it
//! names — and a change rebuilds only the shares of the payload whose owners the
//! appended records name, over those owners' records alone, with each record
//! rendered into a timeline entry once, as it arrives. The rebuilt shares are
//! diffed against what the subscriber holds into [`Op`]s; a share nothing touched
//! is not read at all. A `Reread` rebuilds everything and is still sent as the
//! structural difference — never as the whole payload.
//!
//! The shares are read by the same functions the routes build whole payloads
//! with, over a [`Run`] holding one owner's records at their merged-store
//! positions, so a share rebuilt live is the share a fresh read builds: the
//! journeys in `tests/e2e/live.rs` hold the patched payload to a fresh read after
//! every append.
//!
//! One part of the detail is not the crate's to fold incrementally: the SDK's own
//! telemetry document, which `onepipeline::telemetry::of_run` folds over the whole
//! journal. The caller decides when that is refolded and hands it in; see
//! [`crate::live`].

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use onepipeline::event::Envelope;
use onepipeline::views::RunView;
use serde_json::{json, Map, Value};

use super::{
    detail_document, is_end_boundary, is_settlement, measured, moment_of, share_spans,
    timeline_harnesses_over, turns_of, ActivityFold, DeclaredMembers, Ends, Rendered, Run, Scope,
    Share, Transcripts,
};
use crate::contract::NodeId;
use crate::filter::EventFilter;
use crate::patch::{self, Op, Step};
use crate::telemetry::RunTelemetry;

/// Who owns a record in a payload.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Owner {
    /// The run itself: a record that names no node.
    Run,
    /// The node a record names.
    Node(String),
}

/// What one refresh appended, read for which owners it touched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Touched {
    /// Whether any appended record names no node.
    pub(crate) run: bool,
    /// The nodes appended records name.
    pub(crate) nodes: BTreeSet<String>,
    /// How many records were appended.
    pub(crate) records: usize,
    /// Whether an appended record that names no node is one every node's share
    /// reads: a release observed for a commit, which any node's work may have
    /// landed as.
    pub(crate) every_node: bool,
}

impl Touched {
    /// Whether the refresh appended anything.
    pub(crate) fn any(&self) -> bool {
        self.records > 0
    }
}

/// A run's records, indexed by owner, with the facts a live reading keeps so it
/// never has to re-read the store for them.
#[derive(Debug, Default)]
pub(crate) struct Indexed {
    /// Each record's position in the canonical store — the store with every
    /// repeated producer identity counted once — or `None` for a repetition.
    canonical: Vec<Option<usize>>,
    identities: HashSet<(String, u64)>,
    canonical_len: usize,
    /// The records that name no node, by merged-store index.
    run: Vec<usize>,
    /// Each node's records, in the order nodes first appeared.
    nodes: Vec<(String, Vec<usize>)>,
    node_at: HashMap<String, usize>,
    /// The highest per-stream sequence number recorded.
    pub(crate) last_seq: u64,
    /// The lint transport's relayed records, over the whole store.
    lint: u64,
    /// The latest settlement, by moment and merged-store index.
    latest_settlement: Option<(i128, usize)>,
    /// The last record that decides whether a historical exit still holds.
    last_boundary: Option<usize>,
}

impl Indexed {
    /// Index every record `view` holds.
    pub(crate) fn of(view: &RunView) -> Self {
        let mut indexed = Self::default();
        indexed.extend(view, 0);
        indexed
    }

    /// Index the records from `first` on, which a refresh appended, and say
    /// which owners they touched.
    pub(crate) fn extend(&mut self, view: &RunView, first: usize) -> Touched {
        let mut touched = Touched::default();
        for (index, event) in view.events.iter().enumerate().skip(first) {
            touched.records += 1;
            let identity = (event.stream.clone(), event.seq);
            if self.identities.insert(identity) {
                self.canonical.push(Some(self.canonical_len));
                self.canonical_len += 1;
            } else {
                self.canonical.push(None);
            }
            self.last_seq = self.last_seq.max(event.seq);
            self.lint += measured(std::iter::once(event)).lint_records;
            if is_settlement(event) {
                if let Some(at) = moment_of(event) {
                    if self
                        .latest_settlement
                        .is_none_or(|(latest, _)| at >= latest)
                    {
                        self.latest_settlement = Some((at, index));
                    }
                }
            }
            if is_end_boundary(event) {
                self.last_boundary = Some(index);
            }
            match event.labels.node.as_deref() {
                None => {
                    self.run.push(index);
                    touched.run = true;
                    touched.every_node |= event.kind.0 == super::vcs::RELEASE_OBSERVED;
                }
                Some(node) => {
                    let at = *self.node_at.entry(node.to_owned()).or_insert_with(|| {
                        self.nodes.push((node.to_owned(), Vec::new()));
                        self.nodes.len() - 1
                    });
                    self.nodes[at].1.push(index);
                    touched.nodes.insert(node.to_owned());
                }
            }
        }
        touched
    }

    /// The nodes, in the order they first appeared.
    fn node_order(&self) -> impl Iterator<Item = &str> {
        self.nodes.iter().map(|(node, _)| node.as_str())
    }

    fn indices(&self, owner: &Owner) -> &[usize] {
        match owner {
            Owner::Run => &self.run,
            Owner::Node(node) => self
                .node_at
                .get(node)
                .map_or(&[][..], |at| self.nodes[*at].1.as_slice()),
        }
    }

    /// One owner's records as a store of their own, and where each sits in the
    /// canonical store — repetitions left out, as the timeline leaves them.
    fn canonical_share(&self, view: &RunView, owner: &Owner) -> (Vec<Envelope>, Vec<usize>) {
        let mut events = Vec::new();
        let mut positions = Vec::new();
        for &index in self.indices(owner) {
            if let Some(position) = self.canonical[index] {
                events.push(view.events[index].clone());
                positions.push(position);
            }
        }
        (events, positions)
    }

    /// The records of several owners together, in merge order, as the detail
    /// reads them — repetitions kept, as the detail keeps them.
    fn merged_share(&self, view: &RunView, owners: &[Owner]) -> Vec<Envelope> {
        let mut indices: Vec<usize> = owners
            .iter()
            .flat_map(|owner| self.indices(owner).iter().copied())
            .collect();
        indices.sort_unstable();
        indices.dedup();
        indices
            .into_iter()
            .map(|index| view.events[index].clone())
            .collect()
    }

    /// The run's end, from what this index keeps.
    fn ends(&self, view: &RunView) -> Ends {
        Ends::from_parts(
            &Run::of(view),
            self.latest_settlement
                .map(|(at, index)| (at, view.events[index].ts.as_str())),
            self.last_boundary.map(|index| &view.events[index]),
        )
    }
}

/// What a timeline draws: the run, or one node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TimelineScope {
    /// The whole run.
    Run,
    /// One node.
    Node(NodeId),
}

/// One owner's run of spans in a run-scope timeline: where it starts, and for
/// each span whether the run's end may still close it.
#[derive(Debug, Clone)]
struct Slot {
    owner: Owner,
    start: usize,
    /// Per span: whether it was open, and running, before the run's end
    /// closed it — what a later end, or a driver coming back, recloses from.
    openings: Vec<Opening>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Opening {
    open: bool,
    running: bool,
}

impl Opening {
    fn of(span: &Value) -> Self {
        Self {
            open: span["ended_at"].is_null(),
            running: span["status"] == "running",
        }
    }
}

/// A timeline kept current from what each refresh appended.
pub(crate) struct LiveTimeline {
    scope: TimelineScope,
    filter: EventFilter,
    payload: Value,
    slots: Vec<Slot>,
    /// The spans after the owners' — the harness sessions the run's pointer file
    /// names — and how many there are.
    harness: usize,
    ends: Ends,
    rendered: RefCell<Rendered>,
    /// The owners whose entries the cache holds, taken from the payload the
    /// subscriber already has the first time each is rebuilt.
    seeded: BTreeSet<Owner>,
}

impl LiveTimeline {
    /// Build the timeline whole, as the timeline route does, and index it by
    /// owner.
    pub(crate) fn build(
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        scope: TimelineScope,
        filter: EventFilter,
        agents: Option<&onepipeline::agents::Agents>,
    ) -> Self {
        let mut timeline = Self {
            scope,
            filter,
            payload: Value::Null,
            slots: Vec::new(),
            harness: 0,
            ends: indexed.ends(view),
            rendered: RefCell::new(Rendered::default()),
            seeded: BTreeSet::new(),
        };
        timeline.payload = timeline.whole(view, indexed, declared, agents);
        timeline
    }

    /// The timeline as the subscriber holds it.
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    /// How many entries this timeline has rendered from records, rather than
    /// reused, since it was built.
    pub(crate) fn rendered(&self) -> usize {
        self.rendered.borrow().fresh
    }

    /// Every share rebuilt, and the slots laid out again: what a build and a
    /// `Reread` both do.
    fn whole(
        &mut self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        agents: Option<&onepipeline::agents::Agents>,
    ) -> Value {
        self.ends = indexed.ends(view);
        self.slots.clear();
        let mut spans: Vec<Value> = Vec::new();
        let owners: Vec<Owner> = match &self.scope {
            TimelineScope::Node(node) => vec![Owner::Node(node.as_str().to_owned())],
            TimelineScope::Run if view.events.is_empty() => Vec::new(),
            TimelineScope::Run => std::iter::once(Owner::Run)
                .chain(
                    indexed
                        .node_order()
                        .map(|node| Owner::Node(node.to_owned())),
                )
                .collect(),
        };
        for owner in owners {
            let pre = self.share(view, indexed, declared, &owner);
            let start = spans.len();
            self.slots.push(Slot {
                owner,
                start,
                openings: pre.iter().map(Opening::of).collect(),
            });
            spans.extend(pre.into_iter().map(|mut span| {
                self.ends.close(&mut span);
                span
            }));
        }
        let mut payload = json!({
            "timeline_schema_version": crate::contract::TIMELINE_SCHEMA_VERSION,
            "run_id": view.paths.run,
            "spans": spans,
        });
        let owned = payload["spans"].as_array().map_or(0, Vec::len);
        payload = self.harnessed(view, indexed, payload, agents);
        self.harness = payload["spans"].as_array().map_or(0, Vec::len) - owned;
        payload
    }

    /// Hold every entry the subscriber already has for `owner`, as rendered,
    /// so rebuilding the owner renders only the records it has not seen.
    fn seed(&mut self, owner: &Owner) {
        if !self.seeded.insert(owner.clone()) {
            return;
        }
        let Some(spans) = self.payload["spans"].as_array() else {
            return;
        };
        let range = match &self.scope {
            TimelineScope::Node(_) => 0..spans.len(),
            TimelineScope::Run => match self.slots.iter().find(|slot| slot.owner == *owner) {
                Some(slot) => slot.start..slot.start + slot.openings.len(),
                None => return,
            },
        };
        let mut rendered = self.rendered.borrow_mut();
        for span in &spans[range] {
            for entry in span["events"].as_array().into_iter().flatten() {
                let (Some(position), Some(id)) = (
                    entry["journal_order"]
                        .as_u64()
                        .and_then(|at| usize::try_from(at).ok()),
                    entry["id"].as_str(),
                ) else {
                    continue;
                };
                let turn = (id != format!("e{position}")).then(|| id.to_owned());
                rendered
                    .entries
                    .entry(position)
                    .or_insert_with(|| (turn, entry.clone()));
            }
        }
    }

    /// One owner's spans, before the run's end closes any of them.
    fn share(
        &self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        owner: &Owner,
    ) -> Vec<Value> {
        let (events, positions) = indexed.canonical_share(view, owner);
        let run = Run::of(view).share(&events, &positions);
        let node;
        let share = match (&self.scope, owner) {
            (TimelineScope::Node(scope), _) => Share::NodeScope(scope),
            (TimelineScope::Run, Owner::Run) => match view.events.first() {
                Some(first) => Share::RunLevel { first },
                None => return Vec::new(),
            },
            (TimelineScope::Run, Owner::Node(name)) => {
                node = name.clone();
                Share::NodeLevel(&node)
            }
        };
        share_spans(
            &run,
            declared,
            &share,
            &self.filter,
            &self.ends,
            &self.rendered,
        )
    }

    /// The harness sessions the run's pointer file names, laid after the spans
    /// they hang under — and, at node scope, every dispatch stamped with the
    /// group it belongs to, over the node's own records.
    fn harnessed(
        &self,
        view: &RunView,
        indexed: &Indexed,
        payload: Value,
        agents: Option<&onepipeline::agents::Agents>,
    ) -> Value {
        let Some(agents) = agents else {
            return payload;
        };
        match &self.scope {
            TimelineScope::Run => {
                timeline_harnesses_over(payload, &Run::of(view), &Scope::Run, agents)
            }
            TimelineScope::Node(node) => {
                let (events, positions) =
                    indexed.canonical_share(view, &Owner::Node(node.as_str().to_owned()));
                timeline_harnesses_over(
                    payload,
                    &Run::of(view).share(&events, &positions),
                    &Scope::Node(node),
                    agents,
                )
            }
        }
    }

    /// The operations that bring the subscriber's timeline up to date with the
    /// records `touched` names, or with everything after a `Reread`.
    pub(crate) fn refreshed(
        &mut self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        touched: Option<&Touched>,
        agents: Option<&onepipeline::agents::Agents>,
        agents_moved: bool,
    ) -> Vec<Op> {
        let Some(touched) = touched else {
            // A `Reread`: everything rebuilt, sent as what changed. The records
            // may sit at other positions now, so nothing rendered by position
            // is reused.
            self.rendered.borrow_mut().entries.clear();
            self.seeded.clear();
            let old = std::mem::take(&mut self.payload);
            let new = self.whole(view, indexed, declared, agents);
            let mut ops = Vec::new();
            patch::diff(&old, &new, &mut ops);
            self.payload = new;
            return ops;
        };
        let ends = indexed.ends(view);
        let ends_moved = ends != self.ends;
        self.ends = ends;
        match &self.scope {
            TimelineScope::Node(node) => {
                if !(ends_moved || agents_moved || touched.nodes.contains(node.as_str())) {
                    return Vec::new();
                }
                self.seed(&Owner::Node(node.as_str().to_owned()));
                let old = std::mem::take(&mut self.payload);
                let new = self.whole(view, indexed, declared, agents);
                let mut ops = Vec::new();
                patch::diff(&old, &new, &mut ops);
                self.payload = new;
                ops
            }
            TimelineScope::Run => self.refreshed_run(
                view,
                indexed,
                declared,
                touched,
                ends_moved,
                agents,
                agents_moved,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn refreshed_run(
        &mut self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        touched: &Touched,
        ends_moved: bool,
        agents: Option<&onepipeline::agents::Agents>,
        agents_moved: bool,
    ) -> Vec<Op> {
        if self.slots.is_empty() && !view.events.is_empty() {
            // The first records a run ever recorded: there was no run span to
            // keep current, so the layout is new and is built as one.
            return self.refreshed(view, indexed, declared, None, agents, agents_moved);
        }
        // Nodes that appeared for the first time, laid after the ones before
        // them, in the order they appeared — the order a fresh read lays them in.
        let known: BTreeSet<Owner> = self.slots.iter().map(|slot| slot.owner.clone()).collect();
        let appeared: Vec<Owner> = indexed
            .node_order()
            .map(|node| Owner::Node(node.to_owned()))
            .filter(|owner| !known.contains(owner))
            .collect();
        let owned_end = self
            .slots
            .last()
            .map_or(0, |slot| slot.start + slot.openings.len());
        let dirty_owners: Vec<Owner> = self
            .slots
            .iter()
            .filter(|slot| match &slot.owner {
                Owner::Run => touched.run || ends_moved || !touched.nodes.is_empty(),
                Owner::Node(node) => touched.nodes.contains(node),
            })
            .map(|slot| slot.owner.clone())
            .collect();
        for owner in &dirty_owners {
            self.seed(owner);
        }
        let mut layout: Vec<(Owner, Option<Vec<Value>>)> = Vec::new();
        for slot in &self.slots {
            // The run's own span carries the run's end and phase, which a node's
            // records move, and its sessions close with the run.
            let dirty = dirty_owners.contains(&slot.owner);
            layout.push((
                slot.owner.clone(),
                dirty.then(|| self.share(view, indexed, declared, &slot.owner)),
            ));
        }
        for owner in appeared {
            let pre = self.share(view, indexed, declared, &owner);
            layout.push((owner, Some(pre)));
        }
        let Some(spans) = self.payload["spans"].as_array() else {
            return Vec::new();
        };
        // The new spans array, as a list of where each element comes from: a
        // span the subscriber already holds (by index), or a rebuilt one.
        let mut assembled: Vec<Source> = Vec::new();
        let mut slots: Vec<Slot> = Vec::new();
        for (owner, rebuilt) in layout {
            let start = assembled.len();
            let old = self.slots.iter().find(|slot| slot.owner == owner).cloned();
            match rebuilt {
                Some(pre) => {
                    let openings = pre.iter().map(Opening::of).collect();
                    assembled.extend(pre.into_iter().map(|mut span| {
                        self.ends.close(&mut span);
                        Source::Rebuilt(span)
                    }));
                    slots.push(Slot {
                        owner,
                        start,
                        openings,
                    });
                }
                None => {
                    let old = old.expect("an untouched slot was laid out before");
                    for (offset, opening) in old.openings.iter().enumerate() {
                        let index = old.start + offset;
                        if ends_moved && opening.open {
                            // Reclosed from what it was before the end closed it.
                            let mut span = spans[index].clone();
                            span["ended_at"] = Value::Null;
                            if opening.running {
                                span["status"] = json!("running");
                            }
                            self.ends.close(&mut span);
                            assembled.push(Source::Rebuilt(span));
                        } else {
                            assembled.push(Source::Held(index));
                        }
                    }
                    slots.push(Slot {
                        owner,
                        start,
                        openings: old.openings,
                    });
                }
            }
        }
        // The harness spans hang under the dispatch spans; rebuilt when the
        // pointer file moved or a node's spans did, and otherwise held.
        let harness: Vec<Source> = if agents_moved || !touched.nodes.is_empty() {
            let dispatches: Vec<Value> = assembled
                .iter()
                .map(|source| match source {
                    Source::Held(index) => &spans[*index],
                    Source::Rebuilt(span) => span,
                })
                .filter(|span| span["kind"] == "dispatch")
                .map(|span| {
                    let mut stub = span.clone();
                    stub["events"] = json!([]);
                    stub
                })
                .collect();
            let skeleton = json!({ "spans": dispatches });
            let before = dispatches_len(&skeleton);
            let harnessed = self.harnessed(view, indexed, skeleton, agents);
            harnessed["spans"]
                .as_array()
                .map(|all| all[before..].iter().cloned().map(Source::Rebuilt).collect())
                .unwrap_or_default()
        } else {
            (owned_end..owned_end + self.harness)
                .map(Source::Held)
                .collect()
        };
        let harness_len = harness.len();
        assembled.extend(harness);

        let mut ops = Vec::new();
        let mut path = vec![Step::Key("spans".to_owned())];
        if assembled.len() < spans.len() {
            // A run whose spans shrank: replaced at the array, which a deletion
            // could not do without shifting what follows.
            let whole: Vec<Value> = assembled
                .into_iter()
                .map(|source| match source {
                    Source::Held(index) => spans[index].clone(),
                    Source::Rebuilt(span) => span,
                })
                .collect();
            ops.push(Op::Set {
                path,
                value: Value::Array(whole),
            });
        } else {
            let mut appended = Vec::new();
            for (index, source) in assembled.into_iter().enumerate() {
                match (source, spans.get(index)) {
                    (Source::Held(from), Some(_)) if from == index => {}
                    (Source::Held(from), Some(old)) => {
                        path.push(Step::Index(index));
                        patch::diff_at(&mut path, old, &spans[from], &mut ops);
                        path.pop();
                    }
                    (Source::Rebuilt(span), Some(old)) => {
                        path.push(Step::Index(index));
                        if old.get("id") == span.get("id") {
                            patch::diff_at(&mut path, old, &span, &mut ops);
                        } else {
                            ops.push(Op::Set {
                                path: path.clone(),
                                value: span,
                            });
                        }
                        path.pop();
                    }
                    (Source::Held(from), None) => appended.push(spans[from].clone()),
                    (Source::Rebuilt(span), None) => appended.push(span),
                }
            }
            if !appended.is_empty() {
                ops.push(Op::Append {
                    path,
                    values: appended,
                });
            }
        }
        if let Err(refused) = patch::apply_trusted(&mut self.payload, &ops) {
            // Operations diffed against this very payload always apply; one that
            // did not is a fault in this module, and the timeline is laid out
            // again rather than left half-patched.
            eprintln!("onepipeline-api: a live timeline patch did not apply: {refused}");
            return self.refreshed(view, indexed, declared, None, agents, agents_moved);
        }
        self.slots = slots;
        self.harness = harness_len;
        ops
    }
}

/// How many spans a skeleton holds.
fn dispatches_len(skeleton: &Value) -> usize {
    skeleton["spans"].as_array().map_or(0, Vec::len)
}

/// Where one element of a rebuilt spans array comes from.
enum Source {
    /// The span the subscriber holds at this index.
    Held(usize),
    /// A span rebuilt from its owner's records.
    Rebuilt(Value),
}

/// A detail kept current from what each refresh appended.
pub(crate) struct LiveDetail {
    filter: EventFilter,
    payload: Value,
    /// What each node was last seen doing, folded one appended record at a time.
    activity: ActivityFold,
    /// Each owner's transcript turns, which the run's own count sums.
    turns: BTreeMap<Owner, usize>,
}

/// What the detail is read with besides the run's records: the SDK's telemetry,
/// folded on the caller's clock, and the agents the pointer file names.
pub(crate) struct DetailInputs<'a> {
    /// The run's telemetry, as the crate validated it.
    pub(crate) telemetry: Option<&'a RunTelemetry>,
    /// The SDK's own telemetry document, as served.
    pub(crate) sdk_telemetry: &'a Value,
    /// How many agent sessions the run's pointer file names.
    pub(crate) agents: Option<usize>,
}

impl LiveDetail {
    /// Build the detail whole, as the detail route does without transcripts.
    pub(crate) fn build(
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        filter: EventFilter,
        inputs: &DetailInputs<'_>,
    ) -> Self {
        let mut detail = Self {
            filter,
            payload: Value::Null,
            activity: ActivityFold::default(),
            turns: BTreeMap::new(),
        };
        detail.payload = detail.whole(view, indexed, declared, inputs);
        detail
    }

    /// The detail as the subscriber holds it.
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    fn whole(
        &mut self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        inputs: &DetailInputs<'_>,
    ) -> Value {
        self.turns.clear();
        self.activity = ActivityFold::default();
        for event in &view.events {
            self.activity.absorb(event, &EventFilter::default());
        }
        for owner in std::iter::once(Owner::Run).chain(
            indexed
                .node_order()
                .map(|node| Owner::Node(node.to_owned())),
        ) {
            let events = indexed.merged_share(view, std::slice::from_ref(&owner));
            self.turns
                .insert(owner, owner_turns(&Run::of(view).over(&events), declared));
        }
        detail_document(
            &Run::of(view),
            declared,
            false,
            inputs.telemetry,
            inputs.sdk_telemetry.clone(),
            inputs.agents,
            &self.filter,
        )
    }

    /// The operations that bring the subscriber's detail up to date with the
    /// records `touched` names — or with everything, after a `Reread` (`None`)
    /// — and with the inputs handed in.
    pub(crate) fn refreshed(
        &mut self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        touched: Option<&Touched>,
        inputs: &DetailInputs<'_>,
    ) -> Vec<Op> {
        let new = match touched {
            None => self.whole(view, indexed, declared, inputs),
            Some(touched) => self.merged(view, indexed, declared, touched, inputs),
        };
        let mut ops = Vec::new();
        patch::diff(&self.payload, &new, &mut ops);
        self.payload = new;
        ops
    }

    /// The detail with the touched nodes' shares rebuilt over their own
    /// records — and the run's records, which the release a node's work shipped
    /// in is read from — and every other node's share held.
    fn merged(
        &mut self,
        view: &RunView,
        indexed: &Indexed,
        declared: &DeclaredMembers,
        touched: &Touched,
        inputs: &DetailInputs<'_>,
    ) -> Value {
        let whole = Run::of(view);
        // A node whose engine status moved is touched too, whatever named it:
        // a settlement elsewhere can make it ready, blocked or skipped.
        let mut dirty: BTreeSet<String> = touched.nodes.clone();
        if touched.every_node {
            dirty.extend(indexed.node_order().map(str::to_owned));
        }
        let statuses = view.state.statuses();
        let held_status = &self.payload["graph"]["node_status"];
        for (node, status) in &statuses {
            if held_status.get(node).and_then(Value::as_str) != Some(status.as_str()) {
                dirty.insert(node.clone());
            }
        }
        let owners: Vec<Owner> = std::iter::once(Owner::Run)
            .chain(dirty.iter().map(|node| Owner::Node(node.clone())))
            .collect();
        let events = indexed.merged_share(view, &owners);
        let share = whole.over(&events);
        let partial = detail_document(
            &share,
            declared,
            false,
            inputs.telemetry,
            inputs.sdk_telemetry.clone(),
            inputs.agents,
            &self.filter,
        );
        if touched.run {
            let events = indexed.merged_share(view, &[Owner::Run]);
            self.turns
                .insert(Owner::Run, owner_turns(&whole.over(&events), declared));
        }
        for node in &dirty {
            let owner = Owner::Node(node.clone());
            let events = indexed.merged_share(view, std::slice::from_ref(&owner));
            self.turns
                .insert(owner, owner_turns(&whole.over(&events), declared));
        }
        let mut detail = partial;
        // Only the appended records reach the activity fold.
        for event in &view.events[view.events.len().saturating_sub(touched.records)..] {
            self.activity.absorb(event, &EventFilter::default());
        }
        let held = &self.payload;
        let keep = |node: &str| !dirty.contains(node);
        // The run: its own fields read over the whole store, its nodes merged.
        if let Some(run) = detail.get_mut("run").and_then(Value::as_object_mut) {
            run.insert("last_event".into(), super::last_event(&whole));
            let quality = json!(super::timing_quality(&whole));
            run.insert("timing_quality".into(), quality.clone());
            run.insert("turns".into(), json!(self.turns.values().sum::<usize>()));
            run.insert("lint".into(), json!(indexed.lint));
            run.insert("live_activity".into(), json!(self.activity.entries()));
            if let Some(Value::Array(nodes)) = run.get_mut("nodes") {
                for entry in nodes.iter_mut() {
                    let node = entry["node"].as_str().unwrap_or_default().to_owned();
                    if keep(&node) {
                        if let Some(old) = held["run"]["nodes"]
                            .as_array()
                            .and_then(|old| old.iter().find(|old| old["node"] == node.as_str()))
                        {
                            *entry = old.clone();
                        }
                    }
                    // Every node's row carries the run's timing quality, which a
                    // settlement anywhere moves.
                    entry["timing_quality"] = quality.clone();
                }
            }
        }
        if let Some(graph) = detail.get_mut("graph").and_then(Value::as_object_mut) {
            graph.insert("last_seq".into(), json!(indexed.last_seq));
            for member in ["node_results", "node_control"] {
                merge_held(graph, held["graph"].get(member), member, &keep);
            }
        }
        if let Some(object) = detail.as_object_mut() {
            merge_held(object, held.get("node_details"), "node_details", &keep);
        }
        detail
    }
}

/// Replace every entry of `container[member]` whose node `keep` holds with the
/// entry the subscriber already has, adding held entries the rebuilt share
/// could not see.
fn merge_held(
    container: &mut Map<String, Value>,
    held: Option<&Value>,
    member: &str,
    keep: &dyn Fn(&str) -> bool,
) {
    let Some(Value::Object(rebuilt)) = container.get_mut(member) else {
        return;
    };
    let held = held.and_then(Value::as_object);
    let mut keys: BTreeSet<String> = rebuilt.keys().cloned().collect();
    if let Some(held) = held {
        keys.extend(held.keys().filter(|node| keep(node)).cloned());
    }
    let mut merged = Map::new();
    for node in keys {
        let entry = if keep(&node) {
            held.and_then(|held| held.get(&node))
                .or_else(|| rebuilt.get(&node))
        } else {
            rebuilt.get(&node)
        };
        if let Some(entry) = entry {
            merged.insert(node, entry.clone());
        }
    }
    // The order a fresh read serves: plan order for the graph's maps, sorted for
    // the details — kept by re-reading the rebuilt order first.
    let mut ordered = Map::new();
    for key in rebuilt.keys() {
        if let Some(value) = merged.shift_remove(key) {
            ordered.insert(key.clone(), value);
        }
    }
    ordered.extend(merged);
    *rebuilt = ordered;
}

/// How many transcript turns one owner's records hold.
fn owner_turns(run: &Run<'_>, declared: &DeclaredMembers) -> usize {
    turns_of(&Transcripts::of(run, declared), None)
}
