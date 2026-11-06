//! Spike instrumentation: one JSON line per named span of a run-open or status
//! read, written to the file [`OPEN_TRACE_ENV`] names.
//!
//! Passive like [`crate::live::TRACE_ENV`]: nothing reads it back, and unset a
//! span costs one relaxed read of a `OnceLock`. Each line carries the span's wall
//! time, its thread's on-CPU and run-queue time from `/proc/thread-self/schedstat`
//! (so host load is separated from work), the resident set either side of it, and
//! its minor faults, because `scripts/spike-run-open-costs.mjs` attributes a
//! request's wall time to causes from exactly these fields.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// The environment variable naming the file spans are appended to.
pub const OPEN_TRACE_ENV: &str = "ONEPIPELINE_UI_OPEN_TRACE";

fn sink() -> Option<&'static Mutex<File>> {
    static SINK: OnceLock<Option<Mutex<File>>> = OnceLock::new();
    SINK.get_or_init(|| {
        let path = std::env::var_os(OPEN_TRACE_ENV).map(PathBuf::from)?;
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .map(Mutex::new)
    })
    .as_ref()
}

/// On-CPU and run-queue nanoseconds of the calling thread.
fn schedstat() -> (u64, u64) {
    let text = std::fs::read_to_string("/proc/thread-self/schedstat").unwrap_or_default();
    let mut fields = text.split_whitespace().map(str::parse::<u64>);
    let mut next = || fields.next().and_then(Result::ok).unwrap_or(0);
    (next(), next())
}

/// The process's resident kilobytes and its minor faults so far.
fn memory() -> (u64, u64) {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let resident = statm
        .split_whitespace()
        .nth(1)
        .and_then(|pages| pages.parse::<u64>().ok())
        .unwrap_or(0)
        * 4;
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    // The command name may hold spaces, so fields are counted after its `)`.
    let minor = stat
        .rsplit(')')
        .next()
        .and_then(|rest| rest.split_whitespace().nth(7))
        .and_then(|faults| faults.parse::<u64>().ok())
        .unwrap_or(0);
    (resident, minor)
}

/// One open span: written when dropped.
pub struct Span {
    open: Option<Open>,
}

struct Open {
    name: &'static str,
    label: String,
    began: Instant,
    began_unix_ms: u128,
    cpu: u64,
    wait: u64,
    rss: u64,
    minor: u64,
}

/// A span named `name`, its line carrying `label`.
#[must_use]
pub fn span_of(name: &'static str, label: &str) -> Span {
    if sink().is_none() {
        return Span { open: None };
    }
    let (cpu, wait) = schedstat();
    let (rss, minor) = memory();
    Span {
        open: Some(Open {
            name,
            label: label.to_owned(),
            began: Instant::now(),
            began_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_millis()),
            cpu,
            wait,
            rss,
            minor,
        }),
    }
}

/// A span named `name`.
#[must_use]
pub fn span(name: &'static str) -> Span {
    span_of(name, "")
}

impl Drop for Span {
    fn drop(&mut self) {
        let (Some(open), Some(sink)) = (self.open.take(), sink()) else {
            return;
        };
        let wall = open.began.elapsed().as_secs_f64() * 1000.0;
        let (cpu, wait) = schedstat();
        let (rss, minor) = memory();
        let line = serde_json::json!({
            "span": open.name,
            "label": open.label,
            "began_unix_ms": open.began_unix_ms as u64,
            "wall_ms": wall,
            "cpu_ms": cpu.saturating_sub(open.cpu) as f64 / 1e6,
            "runqueue_ms": wait.saturating_sub(open.wait) as f64 / 1e6,
            "rss_kb_before": open.rss,
            "rss_kb_after": rss,
            "minor_faults": minor.saturating_sub(open.minor),
        });
        if let Ok(mut file) = sink.lock() {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// When an accumulated cost began, or `None` when nothing is tracing.
#[must_use]
pub fn timer() -> Option<Instant> {
    sink().map(|_| Instant::now())
}

fn totals() -> &'static Mutex<std::collections::BTreeMap<&'static str, (f64, u64)>> {
    static TOTALS: OnceLock<Mutex<std::collections::BTreeMap<&'static str, (f64, u64)>>> =
        OnceLock::new();
    TOTALS.get_or_init(Mutex::default)
}

/// Add the time since `began` to `name`'s running total, for a cost paid too many
/// times per request to give each its own line.
pub fn add(name: &'static str, began: Option<Instant>) {
    if let (Some(began), Ok(mut totals)) = (began, totals().lock()) {
        let total = totals.entry(name).or_default();
        total.0 += began.elapsed().as_secs_f64() * 1000.0;
        total.1 += 1;
    }
}

/// Write every running total as a line and clear it.
pub fn flush() {
    let Some(sink) = sink() else { return };
    let Ok(mut totals) = totals().lock() else {
        return;
    };
    let Ok(mut file) = sink.lock() else { return };
    for (name, (wall, count)) in std::mem::take(&mut *totals) {
        let line = serde_json::json!({ "total": name, "wall_ms": wall, "count": count });
        let _ = writeln!(file, "{line}");
    }
}

/// Whether the spike prototype `name` is switched on by its environment variable.
#[must_use]
pub fn prototype(name: &str) -> bool {
    std::env::var("ONEPIPELINE_UI_SPIKE")
        .is_ok_and(|on| on.split(',').any(|prototype| prototype == name))
}
