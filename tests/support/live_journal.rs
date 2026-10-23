//! Appending to a run's journal the way the engine's own writer does, through
//! the one fixture writer every test and the load workload append with.
//!
//! The engine's writer publishes an append receipt beside the journal after each
//! record it appends (`events.append.json`: the journal's metadata after the
//! write, under an epoch that survives only a write whose starting metadata
//! matches the previous receipt). A long-lived `RunView::refresh` reads only the
//! appended records when the receipt continues the one it last saw, and re-reads
//! the whole journal otherwise — so a fixture that appended bare lines would make
//! every live update a whole re-read, which is not what a run the engine drives
//! costs. The engine exports no appender, so this hands every append to
//! `apps/dag-ui-e2e/load/journal.mjs` — the single fixture writer the browser
//! fixtures and the load workload use too — and `tests/e2e/live.rs` holds the
//! receipts it writes field for field to ones the linked engine wrote. The
//! journeys count the refresh outcomes the server reports, so a receipt the
//! engine stopped accepting fails them as a re-read rather than passing
//! unnoticed.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Map, Value};

/// The receipt beside one journal.
pub fn receipt_path(journal: &Path) -> PathBuf {
    journal.with_extension("append.json")
}

/// The fixture writer, from this crate's root.
fn writer() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui-e2e/load/journal.mjs")
}

fn node() -> Command {
    let mut command = Command::new("node");
    command.arg(writer());
    command
}

/// Leave a receipt for a journal written whole, as a writer that has just
/// appended its last record leaves one.
pub fn receipt_for(journal: &Path) {
    let status = node()
        .arg("receipt")
        .arg(journal)
        .status()
        .expect("node runs the fixture writer");
    assert!(
        status.success(),
        "the fixture writer refused {}",
        journal.display()
    );
}

/// Append `lines` to `journal` in one write and publish the receipt the
/// engine's writer would.
pub fn append_lines(journal: &Path, lines: &[String]) {
    append_many(&[(journal, lines)]);
}

/// [`append_lines`] for several journals in one invocation of the writer —
/// each journal still in one write of its own, in the order given.
pub fn append_many(appends: &[(&Path, &[String])]) {
    let mut input = Map::new();
    for (journal, lines) in appends {
        input.insert(
            journal.to_str().expect("a utf-8 journal path").to_owned(),
            Value::Array(lines.iter().cloned().map(Value::String).collect()),
        );
    }
    let mut child = node()
        .arg("append")
        .stdin(Stdio::piped())
        .spawn()
        .expect("node runs the fixture writer");
    child
        .stdin
        .take()
        .expect("a pipe")
        .write_all(Value::Object(input).to_string().as_bytes())
        .expect("hand the writer its lines");
    assert!(
        child.wait().expect("the writer exits").success(),
        "the fixture writer refused the append"
    );
}

/// Split a journal written whole into the first `keep` records, which stay on
/// disk with a receipt, and the rest, handed back to be appended one by one.
pub fn hold_back(journal: &Path, keep: usize) -> Vec<String> {
    let text = fs::read_to_string(journal).expect("read the journal");
    let lines: Vec<String> = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    let (kept, rest) = lines.split_at(keep.min(lines.len()));
    let mut body = kept.join("\n");
    body.push('\n');
    fs::write(journal, body).expect("rewrite the journal");
    receipt_for(journal);
    rest.to_vec()
}
