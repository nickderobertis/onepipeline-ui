//! Spike `first-screen`: a run's first answer from a selective read of its journal.
//!
//! Only built under `spike-engine-open-current`, whose engine copy
//! `scripts/spike-run-open-costs-build.sh` patches, and only routed when
//! `ONEPIPELINE_UI_SPIKE` names `first-screen`. A prototype to measure, not a surface:
//! `docs/contract.md` names none of this.
//!
//! The read skims every line of the journal for its `ts`, `stream`, `seq`, `kind` and
//! `node` without parsing it, merges all of them, so a chosen record's position in the
//! merged store is the one a complete read gives it, and parses only the records it keeps.

use std::collections::{BTreeMap, BinaryHeap, HashSet};
use std::time::Instant;

use onepipeline::event::Envelope;
use serde_json::{json, Map, Value};

use super::{Folded, Hub, Indexed, LiveTimeline, RunView, TimelineScope};
use crate::contract::{NodeId, RunId};
use crate::error::ApiError;
use crate::filter::EventFilter;
use crate::open_trace::{ItemsWindow, ITEMS_WINDOW};
use crate::payload;
use onepipeline::verbs::{self, AgentScope};

/// The kinds a first answer does not parse, unless a node's own timeline asks for them.
const SKIPPED: [&str; 2] = ["member-heartbeat", "turn-activity"];

/// How many transcript rows a node's first answer renders from each of its spans.
const LATEST_ROWS: usize = 40;

/// One line of a journal, read without parsing it.
struct Skim<'a> {
    line: &'a [u8],
    ts: &'a str,
    stream: &'a str,
    seq: u64,
    kind: &'a str,
    node: Option<&'a str>,
}

/// Bytes up to the next `"` from `at`, and where that quote is.
fn quoted(line: &[u8], at: usize) -> Option<(&str, usize)> {
    let end = at + line.get(at..)?.iter().position(|byte| *byte == b'"')?;
    Some((std::str::from_utf8(&line[at..end]).ok()?, end))
}

/// The envelope's fields, off the order every writer of it serializes them in.
fn skim_prefix(line: &[u8]) -> Option<Skim<'_>> {
    let rest = line.strip_prefix(b"{\"v\":")?;
    let open = rest.iter().position(|byte| *byte == b',')?;
    let mut at = 5 + open + 1;
    let expect = |at: usize, what: &[u8]| -> Option<usize> {
        line.get(at..)?.starts_with(what).then_some(at + what.len())
    };
    at = expect(at, b"\"ts\":\"")?;
    let (ts, end) = quoted(line, at)?;
    at = expect(end, b"\",\"stream\":\"")?;
    let (stream, end) = quoted(line, at)?;
    at = expect(end, b"\",\"seq\":")?;
    let digits = line[at..].iter().position(|byte| *byte == b',')?;
    let seq = std::str::from_utf8(&line[at..at + digits])
        .ok()?
        .parse()
        .ok()?;
    at = expect(at + digits, b",\"source\":\"")?;
    let (_, end) = quoted(line, at)?;
    at = expect(end, b"\",\"kind\":\"")?;
    let (kind, end) = quoted(line, at)?;
    // `onevcs`'s records carry a `phase` between the two.
    at = match expect(end, b"\",\"phase\":\"") {
        Some(phase) => quoted(line, phase)?.1,
        None => end,
    };
    at = expect(at, b"\",\"labels\":{")?;
    let labels = line[at..].iter().position(|byte| *byte == b'}')?;
    let labels = &line[at..at + labels];
    let key = b"\"node\":\"";
    let node = labels
        .windows(key.len())
        .position(|window| window == key)
        .and_then(|found| quoted(labels, found + key.len()))
        .map(|(node, _)| node);
    Some(Skim {
        line,
        ts,
        stream,
        seq,
        kind,
        node,
    })
}

/// The same fields off a line in any other form, whose strings outlive the read only
/// because a prototype's single request may let them.
fn skim_parsed(line: &[u8]) -> Option<Skim<'_>> {
    let event: Envelope = serde_json::from_slice(line).ok()?;
    let leak = |text: &str| -> &'static str { Box::leak(text.to_owned().into_boxed_str()) };
    Some(Skim {
        line,
        ts: leak(&event.ts),
        stream: leak(&event.stream),
        seq: event.seq,
        kind: leak(&event.kind.0),
        node: event.labels.node.as_deref().map(leak),
    })
}

/// How many threads the whole-journal steps divide across.
const READERS: usize = 4;

/// The file, read a slice per thread.
fn read_whole(path: &std::path::Path) -> Vec<u8> {
    use std::os::unix::fs::FileExt;
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let length = file
        .metadata()
        .ok()
        .and_then(|about| usize::try_from(about.len()).ok())
        .unwrap_or(0);
    let mut bytes = vec![0_u8; length];
    let slice = length.div_ceil(READERS).max(1);
    let got: usize = std::thread::scope(|scope| {
        let workers: Vec<_> = bytes
            .chunks_mut(slice)
            .enumerate()
            .map(|(at, chunk)| {
                let file = &file;
                scope.spawn(move || {
                    let mut filled = 0;
                    let from = (at * slice) as u64;
                    while filled < chunk.len() {
                        match file.read_at(&mut chunk[filled..], from + filled as u64) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => filled += read,
                        }
                    }
                    filled
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap_or(0))
            .sum()
    });
    bytes.truncate(got);
    bytes
}

/// Every line skimmed, a slice of the file per thread, each slice ending at a line's end.
fn skim_all<'a>(bytes: &'a [u8], unusual: &std::sync::atomic::AtomicU64) -> Vec<Skim<'a>> {
    let mut slices = Vec::with_capacity(READERS);
    let mut from = 0;
    for part in 1..=READERS {
        let target = (bytes.len() * part / READERS).max(from);
        let end = bytes[target..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |found| target + found + 1);
        slices.push(&bytes[from..end]);
        from = end;
    }
    std::thread::scope(|scope| {
        let workers: Vec<_> = slices
            .into_iter()
            .map(|slice| {
                scope.spawn(move || {
                    slice
                        .split(|byte| *byte == b'\n')
                        .filter(|line| !line.is_empty())
                        .filter_map(|line| {
                            skim_prefix(line).or_else(|| {
                                unusual.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                skim_parsed(line)
                            })
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    })
}

/// A cheap hash for the read's short-lived maps of short strings.
#[derive(Default, Clone, Copy)]
struct Quick(u64);

impl std::hash::Hasher for Quick {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0_u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word))
                .wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
}

type QuickMap<K, V> = std::collections::HashMap<K, V, std::hash::BuildHasherDefault<Quick>>;

/// Each line's place in merge order: every stream in its `seq`, the earliest head by
/// `(ts, stream)` next, which is the engine's order. Where every stream's stamps rise with
/// its `seq`, as a stream written by one clock's do, that order is a plain sort; a stream
/// whose clock stepped back takes the k-way merge the order is defined by. Also the lines
/// that are a stream's first or last, and those repeating a `(stream, seq)` already seen.
fn merged<'a>(lines: &[Skim<'a>]) -> (Vec<usize>, HashSet<usize>, HashSet<usize>) {
    let mut streams: QuickMap<&'a str, Vec<usize>> = QuickMap::default();
    for (index, line) in lines.iter().enumerate() {
        streams.entry(line.stream).or_default().push(index);
    }
    let mut ends = HashSet::new();
    let mut repeats = HashSet::new();
    let mut monotonic = true;
    for queue in streams.values_mut() {
        queue.sort_by_key(|index| lines[*index].seq);
        ends.extend(queue.first().copied());
        ends.extend(queue.last().copied());
        for pair in queue.windows(2) {
            let (one, next) = (&lines[pair[0]], &lines[pair[1]]);
            if one.seq == next.seq {
                repeats.insert(pair[1]);
            }
            monotonic &= one.ts <= next.ts;
        }
    }
    if monotonic {
        // Stable within a stream: its queue is already in its order.
        let mut placed = vec![0_usize; lines.len()];
        for queue in streams.values() {
            for (at, index) in queue.iter().enumerate() {
                placed[*index] = at;
            }
        }
        let mut order: Vec<usize> = (0..lines.len()).collect();
        order.sort_unstable_by(|left, right| {
            (lines[*left].ts, lines[*left].stream, placed[*left]).cmp(&(
                lines[*right].ts,
                lines[*right].stream,
                placed[*right],
            ))
        });
        return (order, ends, repeats);
    }
    let mut cursor: BTreeMap<&'a str, (usize, Vec<usize>)> = streams
        .into_iter()
        .map(|(stream, queue)| (stream, (0, queue)))
        .collect();
    let mut heads: BinaryHeap<std::cmp::Reverse<(&'a str, &'a str)>> = cursor
        .iter()
        .filter_map(|(stream, (_, queue))| {
            queue
                .first()
                .map(|index| std::cmp::Reverse((lines[*index].ts, *stream)))
        })
        .collect();
    let mut order = Vec::with_capacity(lines.len());
    while let Some(std::cmp::Reverse((_, stream))) = heads.pop() {
        let Some((at, queue)) = cursor.get_mut(stream) else {
            continue;
        };
        if let Some(index) = queue.get(*at) {
            order.push(*index);
        }
        *at += 1;
        if let Some(next) = queue.get(*at) {
            heads.push(std::cmp::Reverse((lines[*next].ts, stream)));
        }
    }
    (order, ends, repeats)
}

/// What to keep of a journal.
pub(super) struct Selection<'a> {
    /// Keep every stream's first and last record whatever its kind.
    pub(super) stream_ends: bool,
    /// Keep every record of this node whatever its kind.
    pub(super) node: Option<&'a str>,
    /// Keep only this node's records and the run's first and last.
    pub(super) node_only: bool,
}

/// A selective read: the records kept, in merge order, each one's place in the canonical
/// store, and what the read cost.
pub(super) struct Selected {
    pub(super) events: Vec<Envelope>,
    pub(super) canonical: Vec<Option<usize>>,
    pub(super) canonical_len: usize,
    pub(super) last_seq: u64,
    /// Each node's kept records' places among all of that node's.
    pub(super) shares: std::collections::HashMap<String, Vec<usize>>,
    pub(super) timings: Map<String, Value>,
}

fn millis(began: Instant) -> Value {
    json!((began.elapsed().as_secs_f64() * 10_000.0).round() / 10.0)
}

/// Parse `lines` across a few threads, keeping their order.
fn parse(lines: &[&[u8]]) -> Vec<Option<Envelope>> {
    let chunk = lines.len().div_ceil(READERS).max(1);
    std::thread::scope(|scope| {
        let workers: Vec<_> = lines
            .chunks(chunk)
            .map(|lines| {
                scope.spawn(move || {
                    lines
                        .iter()
                        .map(|line| serde_json::from_slice::<Envelope>(line).ok())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    })
}

/// Read a journal, parsing only what `selection` keeps.
pub(super) fn select(path: &std::path::Path, selection: &Selection<'_>) -> Selected {
    let mut timings = Map::new();
    let began = Instant::now();
    let bytes = read_whole(path);
    timings.insert("read_ms".into(), millis(began));
    timings.insert("journal_bytes".into(), json!(bytes.len()));

    let began = Instant::now();
    let unusual = std::sync::atomic::AtomicU64::new(0);
    let lines = skim_all(&bytes, &unusual);
    timings.insert("skim_ms".into(), millis(began));
    timings.insert("records".into(), json!(lines.len()));
    timings.insert(
        "lines_not_in_the_usual_form".into(),
        json!(unusual.load(std::sync::atomic::Ordering::Relaxed)),
    );

    let began = Instant::now();
    let (order, ends, repeats) = merged(&lines);
    timings.insert("merge_ms".into(), millis(began));

    let began = Instant::now();
    let mut position = 0_usize;
    let mut kept: Vec<&[u8]> = Vec::new();
    let mut canonical = Vec::new();
    let mut last_seq = 0;
    let first = order.first().copied();
    let last = order.last().copied();
    // Each owner's records so far: a span's `queued.<node>.<n>` id counts its owner's
    // whole share, and `since` on a piece of evidence is the record of its node before it.
    let mut share_length: QuickMap<Option<&str>, usize> = QuickMap::default();
    let mut share_at = Vec::new();
    let mut previous: QuickMap<&str, usize> = QuickMap::default();
    let mut before_evidence: HashSet<usize> = HashSet::new();
    for index in &order {
        let line = &lines[*index];
        if let Some(node) = line.node {
            if !line.line.ends_with(b"\"artifacts\":[]}") {
                before_evidence.extend(previous.get(node).copied());
            }
            previous.insert(node, *index);
        }
    }
    for index in &order {
        let line = &lines[*index];
        last_seq = last_seq.max(line.seq);
        let place = if repeats.contains(index) {
            None
        } else {
            position += 1;
            Some(position - 1)
        };
        let at_in_share = place.map(|_| {
            let length = share_length.entry(line.node).or_insert(0);
            *length += 1;
            *length - 1
        });
        let chosen = selection.node.is_some_and(|node| line.node == Some(node))
            || Some(*index) == first
            || Some(*index) == last
            || (!selection.node_only
                && (!SKIPPED.contains(&line.kind)
                    || (selection.stream_ends && ends.contains(index))
                    || (selection.stream_ends && before_evidence.contains(index))));
        if chosen {
            kept.push(line.line);
            canonical.push(place);
            share_at.push((at_in_share, line.node.map(str::to_owned)));
        }
    }
    timings.insert("positions_ms".into(), millis(began));
    timings.insert("kept".into(), json!(kept.len()));
    timings.insert(
        "kept_bytes".into(),
        json!(kept.iter().map(|line| line.len()).sum::<usize>()),
    );

    let began = Instant::now();
    let mut events = Vec::with_capacity(kept.len());
    let mut places = Vec::with_capacity(kept.len());
    let mut shares: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for ((event, place), (at_in_share, node)) in
        parse(&kept).into_iter().zip(canonical).zip(share_at)
    {
        if let Some(event) = event {
            events.push(event);
            places.push(place);
            if let (Some(at), Some(node)) = (at_in_share, node) {
                shares.entry(node).or_default().push(at);
            }
        }
    }
    timings.insert("parse_ms".into(), millis(began));
    Selected {
        events,
        canonical: places,
        canonical_len: position,
        last_seq,
        shares,
        timings,
    }
}

/// A `queued.<node>.<n>` span's `n` counts its node's records, and a selective read holds
/// fewer of them than the store does, so it is put back to the count over the whole store.
fn queued_ids_over_the_store(
    spans: &mut Value,
    shares: &std::collections::HashMap<String, Vec<usize>>,
) {
    for span in spans.as_array_mut().into_iter().flatten() {
        if span["kind"] != "queued" {
            continue;
        }
        let (Some(node), Some(id)) = (span["node_id"].as_str(), span["id"].as_str()) else {
            continue;
        };
        let Some(number) = id.rsplit('.').next().and_then(|n| n.parse::<usize>().ok()) else {
            continue;
        };
        let Some(whole) = shares.get(node).and_then(|share| share.get(number)) else {
            continue;
        };
        let prefix = id[..id.len() - id.rsplit('.').next().map_or(0, str::len)].to_owned();
        span["id"] = json!(format!("{prefix}{whole}"));
    }
}

/// What a first answer may be asked for.
pub(super) enum FirstView {
    Graph,
    Overall,
    Node(NodeId),
}

/// The fields each first answer keeps of a complete answer's shape, as `a.b` paths under
/// the visible state, `*` standing for each key or element. Whatever a complete answer
/// holds beyond them arrives with the complete read.
const DETAIL_KEPT: &[&str] = &[
    "run.run_id",
    "run.state",
    "run.phase",
    "run.last_event",
    "run.timing.wall_seconds",
    "run.nodes.*.node",
    "run.nodes.*.status",
    "run.nodes.*.outcome",
    "run.nodes.*.failure",
    "graph.last_seq",
    "graph.run_id",
    "graph.plan.goal",
    "graph.plan.tasks.*.id",
    "graph.plan.tasks.*.kind",
    "graph.plan.tasks.*.name",
    "graph.plan.tasks.*.deps",
    "graph.plan.tasks.*.repo",
    "graph.plan.tasks.*.steps",
    "graph.node_status",
    "graph.node_gated_by",
    "graph.node_results.*.blocked_by",
    "graph.node_results.*.awaiting",
    "graph.node_results.*.outcome",
    "graph.node_results.*.error",
    "graph.node_results.*.detail",
    "graph.node_control",
    "graph.result",
];

/// Values a first screen shows that no selective read holds, by the same paths. Each is
/// served as `{"loading": true}`, never as a value.
const DETAIL_LOADING: &[&str] = &["run.turns"];

/// One path of `kept` taken from `from` into `into`.
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
                    // A record holding none of the path is no record, not a null.
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

/// Mark `path` of `value` as still loading.
fn mark_loading(value: &mut Value, path: &[&str]) {
    let Some((step, rest)) = path.split_first() else {
        *value = json!({ "loading": true });
        return;
    };
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    mark_loading(&mut value[*step], rest);
}

fn trimmed_detail(detail: &Value) -> Value {
    let mut trimmed = Value::Null;
    for path in DETAIL_KEPT {
        keep(detail, &mut trimmed, &path.split('.').collect::<Vec<_>>());
    }
    for path in DETAIL_LOADING {
        mark_loading(&mut trimmed, &path.split('.').collect::<Vec<_>>());
    }
    // The maps the screen's model reads whatever they hold.
    for (path, empty) in [("node_details", json!({}))] {
        trimmed[path] = empty;
    }
    for map in ["node_results", "node_control", "node_gated_by"] {
        if trimmed["graph"][map].is_null() {
            trimmed["graph"][map] = json!({});
        }
    }
    trimmed
}

/// What the screen's plots do not read of a span, which can be its largest field.
fn trim_spans(timeline: &mut Value) {
    for span in timeline["spans"].as_array_mut().into_iter().flatten() {
        if let Some(fields) = span.as_object_mut() {
            fields.remove("detail");
        }
    }
}

impl Hub {
    /// A run's first answer, from a selective read. `whole` keeps the complete answer's
    /// every field, for comparing what a selective read gets wrong before anything is
    /// trimmed; `stream_ends` and `checkpoint` choose the record set and the state's source.
    pub(super) fn first_screen(
        &self,
        run: &RunId,
        view: &FirstView,
        options: &FirstOptions,
    ) -> Result<Value, ApiError> {
        let store = &self.0.store;
        store.present(run)?;
        let total = Instant::now();
        let paths = store.paths_of(run);
        let node = match view {
            FirstView::Node(node) => Some(node.as_str()),
            _ => None,
        };
        let Selected {
            events,
            canonical,
            canonical_len,
            last_seq,
            shares,
            mut timings,
        } = select(
            &paths.journal(),
            &Selection {
                stream_ends: options.stream_ends,
                node,
                node_only: false,
            },
        );

        let began = Instant::now();
        let view_of_run =
            RunView::spike_selected(&paths, events, options.checkpoint, options.every_edge)
                .map_err(|_| ApiError::RunNotFound(run.clone()))?;
        timings.insert("state_ms".into(), millis(began));

        let began = Instant::now();
        let mut indexed = Indexed::of(&view_of_run);
        indexed.rebase(canonical, canonical_len, last_seq);
        timings.insert("index_ms".into(), millis(began));

        let began = Instant::now();
        let declared = store.declared(&view_of_run);
        timings.insert("declared_ms".into(), millis(began));

        let began = Instant::now();
        // A node's rows include its sessions, so its first answer reads the pointer file. So
        // does the whole document under comparison. Overall's first answer holds no harness
        // pointer, 2.8 MB of them on the largest run, and marks them loading.
        let agents = if options.whole || matches!(view, FirstView::Node(_)) {
            verbs::agents(&paths, AgentScope::Run).ok()
        } else {
            Some(onepipeline::agents::Agents::default())
        };
        timings.insert("agents_ms".into(), millis(began));

        let began = Instant::now();
        let detail = if options.whole {
            let telemetry = Folded::of(&view_of_run);
            let inputs = telemetry.inputs(agents.as_ref().map(|agents| agents.sessions.len()));
            payload::first_screen_detail(&view_of_run, &declared, &inputs)
        } else {
            payload::first_screen_detail_cheap(&view_of_run, &mut timings)
        };
        timings.insert("detail_ms".into(), millis(began));

        let began = Instant::now();
        let timeline = match view {
            FirstView::Graph => None,
            FirstView::Overall => Some((TimelineScope::Run, ItemsWindow::Nothing)),
            FirstView::Node(node) => Some((
                TimelineScope::Node(node.clone()),
                ItemsWindow::Latest(LATEST_ROWS),
            )),
        }
        .map(|(scope, window)| {
            ITEMS_WINDOW.with(|held| held.set(window));
            let built = LiveTimeline::build(
                &view_of_run,
                &indexed,
                &declared,
                scope,
                EventFilter::default(),
                agents.as_ref(),
            );
            ITEMS_WINDOW.with(|held| held.set(ItemsWindow::All));
            built.payload().clone()
        });
        timings.insert("timeline_ms".into(), millis(began));

        let observed_at = payload::now_rfc3339();
        let mut answer = Map::new();
        answer.insert("run_id".into(), json!(run.as_str()));
        answer.insert("observed_at".into(), json!(observed_at));
        answer.insert(
            "detail".into(),
            if options.whole {
                detail
            } else {
                trimmed_detail(&detail)
            },
        );
        if let Some(mut timeline) = timeline {
            timeline["observed_at"] = json!(observed_at);
            queued_ids_over_the_store(&mut timeline["spans"], &shares);
            if !options.whole {
                trim_spans(&mut timeline);
            }
            answer.insert("timeline".into(), timeline);
        }
        let mut loading: Vec<String> = DETAIL_LOADING
            .iter()
            .map(|path| format!("detail.{path}"))
            .collect();
        if matches!(view, FirstView::Overall) {
            loading.push("timeline.spans[harness_scope]".to_owned());
        }
        answer.insert("loading".into(), json!(loading));
        timings.insert("answer_ms".into(), millis(total));
        answer.insert("timings".into(), Value::Object(timings));
        Ok(Value::Object(answer))
    }

    /// One page of a span's events, or one node's latest rows: from the complete read's
    /// payload where it has finished and nothing holds it, otherwise from that node's
    /// records alone. Says which it read.
    pub(super) fn first_page(
        &self,
        run: &RunId,
        node: &NodeId,
        span: Option<&str>,
        window: ItemsWindow,
    ) -> Result<Value, ApiError> {
        let store = &self.0.store;
        let total = Instant::now();
        let scope = TimelineScope::Node(node.clone());
        let held = crate::live::lock(&self.0.runs).get(run).cloned();
        if let Some(held) = held {
            if let Ok(live) = held.try_lock() {
                // The complete read has finished: the same share, over what it holds.
                ITEMS_WINDOW.with(|held| held.set(window));
                let built = LiveTimeline::build(
                    &live.view,
                    &live.indexed,
                    &live.declared,
                    scope,
                    EventFilter::default(),
                    None,
                );
                ITEMS_WINDOW.with(|held| held.set(ItemsWindow::All));
                let spans = built.payload()["spans"].clone();
                return Ok(json!({
                    "source": "complete read",
                    "rows": page_of(&spans, node, span, ItemsWindow::All),
                    "seconds": total.elapsed().as_secs_f64(),
                }));
            }
        }
        let paths = store.paths_of(run);
        let Selected {
            events,
            canonical,
            canonical_len,
            last_seq,
            shares,
            timings,
        } = select(
            &paths.journal(),
            &Selection {
                stream_ends: false,
                node: Some(node.as_str()),
                node_only: true,
            },
        );
        let view = RunView::spike_selected(&paths, events, false, false)
            .map_err(|_| ApiError::RunNotFound(run.clone()))?;
        let mut indexed = Indexed::of(&view);
        indexed.rebase(canonical, canonical_len, last_seq);
        let declared = store.declared(&view);
        ITEMS_WINDOW.with(|held| held.set(window));
        let built = LiveTimeline::build(
            &view,
            &indexed,
            &declared,
            scope,
            EventFilter::default(),
            None,
        );
        ITEMS_WINDOW.with(|held| held.set(ItemsWindow::All));
        let mut spans = built.payload()["spans"].clone();
        queued_ids_over_the_store(&mut spans, &shares);
        let rows = page_of(&spans, node, span, ItemsWindow::All);
        Ok(json!({
            "source": "selective read of the node's records",
            "rows": rows,
            "timings": timings,
            "seconds": total.elapsed().as_secs_f64(),
        }))
    }

    /// `open_current`'s steps on this run, timed.
    pub(super) fn first_open_current_steps(&self, run: &RunId) -> Result<Value, ApiError> {
        let store = &self.0.store;
        store.present(run)?;
        let steps = RunView::spike_open_current_steps(&store.paths_of(run))
            .map_err(|_| ApiError::RunNotFound(run.clone()))?;
        Ok(Value::Object(
            steps
                .into_iter()
                .map(|(name, value)| (name, json!(value)))
                .collect(),
        ))
    }
}

/// The route's reading of its query and body.
impl Hub {
    pub(crate) fn spike_first_screen(
        &self,
        raw: &std::collections::HashMap<String, String>,
        body: &str,
    ) -> Result<Value, ApiError> {
        let run = RunId::try_from(raw.get("run").map_or("", String::as_str))?;
        let view = match body.trim() {
            "graph" => FirstView::Graph,
            "overall" => FirstView::Overall,
            node => FirstView::Node(NodeId::try_from(node)?),
        };
        let on = |name: &str| raw.get(name).is_some_and(|value| value == "1");
        let options = FirstOptions {
            stream_ends: !on("no_stream_ends"),
            checkpoint: on("checkpoint"),
            whole: on("whole"),
            every_edge: on("every_edge"),
        };
        self.first_screen(&run, &view, &options)
    }

    pub(crate) fn spike_page(
        &self,
        raw: &std::collections::HashMap<String, String>,
    ) -> Result<Value, ApiError> {
        let run = RunId::try_from(raw.get("run").map_or("", String::as_str))?;
        let node = NodeId::try_from(raw.get("node").map_or("", String::as_str))?;
        let number = |name: &str, default: usize| {
            raw.get(name)
                .and_then(|value| value.parse().ok())
                .unwrap_or(default)
        };
        let window = if raw.contains_key("offset") {
            ItemsWindow::Page {
                offset: number("offset", 0),
                limit: number("limit", 50),
            }
        } else {
            ItemsWindow::Latest(number("limit", 50))
        };
        self.first_page(&run, &node, raw.get("span").map(String::as_str), window)
    }

    pub(crate) fn spike_open_current(
        &self,
        raw: &std::collections::HashMap<String, String>,
    ) -> Result<Value, ApiError> {
        let run = RunId::try_from(raw.get("run").map_or("", String::as_str))?;
        self.first_open_current_steps(&run)
    }
}

/// The rows of `span`, or of every span of `node`, under `window`, as a client reads them.
fn page_of(spans: &Value, node: &NodeId, span: Option<&str>, window: ItemsWindow) -> Value {
    let rows: Vec<Value> = spans
        .as_array()
        .into_iter()
        .flatten()
        .filter(|candidate| match span {
            Some(span) => candidate["id"] == span,
            None => candidate["node_id"] == node.as_str(),
        })
        .flat_map(|span| {
            let events = span["events"].as_array().cloned().unwrap_or_default();
            let (start, end) = window.range(events.len());
            events[start..end].to_vec()
        })
        .collect();
    Value::Array(rows)
}

/// Which record set and state source a first answer is read from.
#[derive(Debug, Clone, Copy)]
pub(super) struct FirstOptions {
    pub(super) stream_ends: bool,
    pub(super) checkpoint: bool,
    pub(super) whole: bool,
    pub(super) every_edge: bool,
}
