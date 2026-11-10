//! The first-view-time spike's switches and trace. Nothing here lands: it is the
//! measurement harness `apps/dag-ui-e2e/read-latency/measure-run.mjs --corpus` reads.
//!
//! A switch is on when [`SWITCHES_ENV`] names it (comma-separated); none is on by
//! default, so a server started without that variable takes the landed tree's path.
//! A span is recorded only when [`TRACE_ENV`] names a file, to which each
//! subscription's answer appends one JSON line of what it cost; unset, recording is a
//! no-op.

use std::cell::RefCell;
use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

use serde_json::{Map, Value};

/// The prototype switches a server runs with, comma-separated.
pub const SWITCHES_ENV: &str = "ONEPIPELINE_UI_SPIKE";

/// The file each subscription's cost is appended to, one JSON line each.
pub const TRACE_ENV: &str = "ONEPIPELINE_UI_SPIKE_TRACE";

fn switches() -> &'static [String] {
    static SWITCHES: OnceLock<Vec<String>> = OnceLock::new();
    SWITCHES.get_or_init(|| {
        std::env::var(SWITCHES_ENV)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

/// Whether the prototype switch `name` is on.
#[must_use]
pub fn on(name: &str) -> bool {
    switches().iter().any(|on| on == name)
}

fn trace_file() -> Option<&'static std::path::Path> {
    static TRACE: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    TRACE
        .get_or_init(|| std::env::var_os(TRACE_ENV).map(std::path::PathBuf::from))
        .as_deref()
}

/// Whether spans are being recorded.
#[must_use]
pub fn tracing() -> bool {
    trace_file().is_some()
}

thread_local! {
    static SPANS: RefCell<Map<String, Value>> = RefCell::new(Map::new());
}

/// Record `value` under `name` for this thread's current answer. A name recorded
/// twice keeps both, the second under `name#2` and so on.
pub fn record(name: &str, value: impl Into<Value>) {
    if !tracing() {
        return;
    }
    let value = value.into();
    SPANS.with(|spans| {
        let mut spans = spans.borrow_mut();
        let mut key = name.to_owned();
        let mut again = 1;
        while spans.contains_key(&key) {
            again += 1;
            key = format!("{name}#{again}");
        }
        spans.insert(key, value);
    });
}

/// A timed span, recorded in seconds under its name when dropped.
pub struct Span {
    name: &'static str,
    started: Option<Instant>,
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some(started) = self.started {
            record(self.name, started.elapsed().as_secs_f64());
        }
    }
}

/// Time from now until the returned span is dropped.
#[must_use]
pub fn span(name: &'static str) -> Span {
    Span {
        name,
        started: tracing().then(Instant::now),
    }
}

/// This thread's spans so far, emptied.
#[must_use]
pub fn take() -> Map<String, Value> {
    SPANS.with(|spans| std::mem::take(&mut *spans.borrow_mut()))
}

/// Append `line` to the trace, where there is one.
pub fn write(line: &Value) {
    let Some(path) = trace_file() else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// The selection a first screen reads. Without the `spike-engine` feature this is the
/// landed tree's, the one the released engine has.
#[cfg(not(feature = "spike-engine"))]
#[must_use]
pub fn first_screen(node: Option<&str>) -> onepipeline::journal::Selection<'_> {
    onepipeline::journal::Selection::FirstScreen { node }
}

/// The selection a first screen reads: with `node-latest` on, a node's first answer
/// keeps only that node's latest records its window draws, plus what the fold needs.
///
/// With `overall-stubs` on, a kept record of a kind `ONEPIPELINE_UI_SPIKE_STUB_KINDS` names
/// (by default the turn kinds) and not of the node is kept with its payload empty.
#[cfg(feature = "spike-engine")]
#[must_use]
pub fn first_screen(node: Option<&str>) -> onepipeline::journal::Selection<'_> {
    onepipeline::journal::Selection::FirstScreen {
        node,
        node_latest: (node.is_some() && on("node-latest")).then_some(node_latest()),
        stub_kinds: on("overall-stubs").then_some(stub_kinds()),
    }
}

/// The kinds `overall-stubs` keeps without their payload.
#[cfg(feature = "spike-engine")]
fn stub_kinds() -> &'static [&'static str] {
    static KINDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    KINDS.get_or_init(|| {
        std::env::var("ONEPIPELINE_UI_SPIKE_STUB_KINDS")
            .unwrap_or_else(|_| "turn-message,turn-started,turn-completed".to_owned())
            .split(',')
            .map(str::trim)
            .filter(|kind| !kind.is_empty())
            .map(|kind| &*Box::leak(kind.to_owned().into_boxed_str()))
            .collect()
    })
}

/// How many of a node's latest records `node-latest` keeps: `ONEPIPELINE_UI_SPIKE_NODE_LATEST`,
/// or the node window's rows.
#[cfg(feature = "spike-engine")]
#[must_use]
pub fn node_latest() -> usize {
    std::env::var("ONEPIPELINE_UI_SPIKE_NODE_LATEST")
        .ok()
        .and_then(|latest| latest.parse().ok())
        .unwrap_or(crate::contract::NODE_WINDOW_EVENTS)
}

/// Record what the patched engine timed inside its last `stage` on this thread.
#[cfg(feature = "spike-engine")]
pub fn engine_split(stage: &str) {
    for (name, seconds) in onepipeline::journal::spike_take_split() {
        record(&format!("{stage}.{name}"), seconds);
    }
}

/// The released engine times nothing inside itself.
#[cfg(not(feature = "spike-engine"))]
pub fn engine_split(_stage: &str) {}
