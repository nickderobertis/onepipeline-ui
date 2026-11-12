//! A long run's first screen, read as every record's head and then only the records
//! that screen draws.
//!
//! The engine supplies two general reads and knows nothing of screens:
//! [`RunView::heads`], which folds the run's state and heads every record without
//! parsing the payloads it can do without, and [`journal::fetch`], which reads whole
//! records by the handles those heads hold. What a first screen reads whole is this
//! crate's decision, because this crate is what draws it, and it is held in three
//! places only: [`HEADED_KINDS`], what an opened node's own records are read for
//! ([`NODE_HEADED_KINDS`]), and that node's latest [`NODE_WINDOW_EVENTS`] rows, which
//! [`Headed::hold_node`] fetches once the subscription's filter is known.
//!
//! Every record the journal holds is in the reading, in merged order and at the
//! place the complete read gives it, so every count, bound and status a first
//! screen derives from the records is the complete read's. A record not fetched is
//! held as its head: its payload and artifacts empty. Nothing may read the payload of
//! one before the complete read replaces the reading — so a page of a node's history
//! before then reads its share afresh, and Overall's turns and harness sessions are
//! drawn as loading until then.

use std::cell::Cell;
use std::time::Instant;

use onepipeline::event::{Envelope, ENVELOPE_VERSION};
use onepipeline::journal::{self, RecordHandle, RecordHead};
use onepipeline::views::{RunHeads, RunPaths, RunView};

use crate::contract::NODE_WINDOW_EVENTS;
use crate::filter::EventFilter;
use crate::payload::live::Indexed;
use crate::payload::millis_of;

/// The kinds whose payload no first screen reads, but in the node it is opened on;
/// a first screen reads the payload of every record of every other kind, so those
/// are fetched whole.
///
/// By far the most numerous records of a long run: a member's heartbeat, and a
/// turn's opening, messages, activity and close. Graph and the detail are drawn
/// from the engine's fold, which [`RunView::heads`] gives without them; Overall's
/// spans are bounded and statused by their records' heads, and the turns and harness
/// sessions that are read from these kinds' payloads are drawn as loading until the
/// complete read arrives; an opened node's own records are read as
/// [`NODE_HEADED_KINDS`] says. The list names what is left out rather than what is read so a
/// kind the engine adds is read whole until a first screen is shown not to need it,
/// rather than drawn from a payload nobody fetched.
pub(crate) const HEADED_KINDS: [&str; 5] = [
    "member-heartbeat",
    "turn-activity",
    "turn-message",
    "turn-started",
    "turn-completed",
];

/// The kinds of an opened node's own records whose payload its first screen reads
/// only inside its window; the node's records of every other kind are fetched whole.
///
/// A node's rows are numbered into its sessions' turns by those turns' openings,
/// messages and closes wherever they lie, so a row in the window can be numbered by a
/// turn opened long before it: of [`HEADED_KINDS`], only a heartbeat and a tool call
/// outside the window are drawn from their heads alone.
pub(crate) const NODE_HEADED_KINDS: [&str; 2] = ["member-heartbeat", "turn-activity"];

/// Whether a first screen reads `head`'s record whole: one whose kind it reads the
/// payload of, or one carrying evidence, which the screen links to by its artifacts.
fn reads_whole(head: &RecordHead) -> bool {
    head.evidence || !HEADED_KINDS.contains(&head.kind.0.as_str())
}

/// What a reading opened from heads keeps of them until the complete read replaces
/// it: where each record it holds as a head can be read whole.
#[derive(Debug)]
pub(super) struct Headed {
    /// Each record's handle, by its index in the view's events.
    handles: Vec<RecordHandle>,
    /// Whether the view holds each of those records whole.
    whole: Vec<bool>,
}

/// A first reading's view, its index and its heads.
pub(super) struct FirstRead {
    pub(super) view: RunView,
    pub(super) indexed: Indexed,
    pub(super) headed: Headed,
}

/// Read `paths`' run as its heads, and fetch every record [`reads_whole`] names.
///
/// # Errors
///
/// The engine's refusal of the run, or of a fetch: a journal rewritten since its
/// heads were read, which the caller reads whole instead.
pub(super) fn read(paths: &RunPaths) -> Result<FirstRead, onepipeline::Error> {
    let started = Instant::now();
    let RunHeads {
        mut view,
        heads,
        store_len,
        last_seq,
    } = RunView::heads(paths)?;
    let headed_at = Instant::now();
    record(|split| split.heads_s = Some((headed_at - started).as_secs_f64()));
    let mut wanted = Vec::new();
    let mut places = Vec::with_capacity(heads.len());
    let mut handles = Vec::with_capacity(heads.len());
    view.events.reserve(heads.len());
    for (index, head) in heads.into_iter().enumerate() {
        if reads_whole(&head) {
            wanted.push(index);
        }
        places.push(head.place);
        handles.push(head.handle);
        view.events.push(Envelope {
            v: ENVELOPE_VERSION,
            ts: head.ts,
            stream: head.stream,
            seq: head.seq,
            source: head.source,
            kind: head.kind,
            dimensions: head.phase.into(),
            labels: head.labels,
            payload: serde_json::Map::new(),
            artifacts: Vec::new(),
        });
    }
    let mut headed = Headed {
        whole: vec![false; handles.len()],
        handles,
    };
    let stubbed = headed_at.elapsed();
    headed.fetch(&mut view, &wanted)?;
    let indexing = Instant::now();
    let indexed = Indexed::headed(&view, places, store_len, last_seq);
    let took = (stubbed + indexing.elapsed()).as_secs_f64();
    record(|split| split.index_s = Some(took));
    Ok(FirstRead {
        view,
        indexed,
        headed,
    })
}

impl Headed {
    /// Fetch the records at `indices` the view does not yet hold whole, and put each
    /// in its place.
    fn fetch(&mut self, view: &mut RunView, indices: &[usize]) -> Result<(), onepipeline::Error> {
        let started = Instant::now();
        let missing: Vec<usize> = indices
            .iter()
            .copied()
            .filter(|&index| self.whole.get(index).is_some_and(|whole| !whole))
            .collect();
        let handles: Vec<RecordHandle> = missing
            .iter()
            .map(|&index| self.handles[index].clone())
            .collect();
        let fetched = journal::fetch(&view.paths.journal(), &handles)?;
        for (index, record) in missing.iter().zip(fetched) {
            view.events[*index] = record;
            self.whole[*index] = true;
        }
        let took = started.elapsed().as_secs_f64();
        record(|split| {
            split.fetch_s = Some(split.fetch_s.unwrap_or(0.0) + took);
            split.fetched = Some(split.fetched.unwrap_or(0) + missing.len());
            split.records = Some(self.handles.len());
        });
        Ok(())
    }

    /// Fetch what `node`'s first screen under `filter` reads whole that the view holds
    /// as heads: the records of its latest [`NODE_WINDOW_EVENTS`] rows, as its
    /// timeline's window takes them, and every record of it of a kind outside
    /// [`NODE_HEADED_KINDS`].
    ///
    /// # Errors
    ///
    /// A fetch's refusal: the journal was rewritten since its heads were read.
    pub(super) fn hold_node(
        &mut self,
        view: &mut RunView,
        indexed: &Indexed,
        node: &str,
        filter: &EventFilter,
    ) -> Result<(), onepipeline::Error> {
        let mut wanted = window(view, indexed, node, filter);
        wanted.extend(view.events.iter().enumerate().filter_map(|(index, event)| {
            (event.labels.node.as_deref() == Some(node)
                && !NODE_HEADED_KINDS.contains(&event.kind.0.as_str()))
            .then_some(index)
        }));
        wanted.sort_unstable();
        wanted.dedup();
        self.fetch(view, &wanted)
    }
}

/// The indices of `node`'s latest [`NODE_WINDOW_EVENTS`] records `filter` admits,
/// ordered as a node's timeline orders its window: by stamp, then by place, a record
/// repeating one already held left out as the timeline leaves it out.
fn window(view: &RunView, indexed: &Indexed, node: &str, filter: &EventFilter) -> Vec<usize> {
    let mut keys: Vec<(Option<i128>, usize)> = view
        .events
        .iter()
        .enumerate()
        .filter(|(index, event)| {
            event.labels.node.as_deref() == Some(node)
                && indexed.placed(*index)
                && filter.allows(event)
        })
        .map(|(index, event)| (millis_of(&event.ts), index))
        .collect();
    keys.sort_unstable();
    keys.iter()
        .rev()
        .take(NODE_WINDOW_EVENTS)
        .map(|(_, index)| *index)
        .collect()
}

/// Where one subscription's first answer spent its time, for the trace
/// [`TRACE_ENV`](super::TRACE_ENV) names: what is not set was not done.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Split {
    /// The engine's heads read.
    pub(super) heads_s: Option<f64>,
    /// Every fetch the answer made.
    pub(super) fetch_s: Option<f64>,
    /// How many records those fetches read whole.
    pub(super) fetched: Option<usize>,
    /// How many records the heads read headed.
    pub(super) records: Option<usize>,
    /// Holding every head as a record and indexing them.
    pub(super) index_s: Option<f64>,
    /// Building the detail the answer holds.
    pub(super) detail_s: Option<f64>,
    /// Building the timeline the answer holds.
    pub(super) timeline_s: Option<f64>,
}

thread_local! {
    static SPLIT: Cell<Split> = Cell::new(Split::default());
}

/// Add to the split of the first answer this thread is building: one answer is built
/// on one blocking thread, so each read records what it cost where it happens rather
/// than passing it back through every call between it and the trace.
pub(super) fn record(change: impl FnOnce(&mut Split)) {
    SPLIT.with(|split| {
        let mut held = split.get();
        change(&mut held);
        split.set(held);
    });
}

/// This thread's split since it was last taken, which starts it again.
pub(super) fn take() -> Split {
    SPLIT.with(Cell::take)
}
