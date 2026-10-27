//! Appending to a run's journal through the one fixture writer every test and
//! the load workload append with.
//!
//! The engine exports no appender, so the crate's journeys hand every append
//! to `apps/dag-ui-e2e/load/journal.ts` — which says what a receipt is and why
//! a long-lived reader needs one — rather than keeping a second writer here;
//! `tests/e2e/live.rs` holds what it writes to receipts the linked engine wrote.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use serde_json::{Map, Value};

/// The receipt beside one journal.
pub fn receipt_path(journal: &Path) -> PathBuf {
    journal.with_extension("append.json")
}

/// The fixture writer, from this crate's root.
fn writer() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/dag-ui-e2e/load/journal.ts")
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
    Writer::start().append_many(appends);
}

/// A fixture writer started ahead of its append, for a journey that must
/// append at a moment of its choosing: the writer has started by the time it is
/// handed its lines, so the append does not wait on a starting process.
pub struct Writer(Child);

impl Writer {
    pub fn start() -> Self {
        Self(
            node()
                .arg("append")
                .stdin(Stdio::piped())
                .spawn()
                .expect("node runs the fixture writer"),
        )
    }

    /// [`append_lines`], through this writer.
    pub fn append_lines(self, journal: &Path, lines: &[String]) {
        self.append_many(&[(journal, lines)]);
    }

    /// [`append_many`], through this writer.
    pub fn append_many(mut self, appends: &[(&Path, &[String])]) {
        let mut input = Map::new();
        for (journal, lines) in appends {
            input.insert(
                journal.to_str().expect("a utf-8 journal path").to_owned(),
                Value::Array(lines.iter().cloned().map(Value::String).collect()),
            );
        }
        self.0
            .stdin
            .take()
            .expect("a pipe")
            .write_all(Value::Object(input).to_string().as_bytes())
            .expect("hand the writer its lines");
        assert!(
            self.0.wait().expect("the writer exits").success(),
            "the fixture writer refused the append"
        );
    }
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
