//! Appending to a run's journal the way the engine's own writer does.
//!
//! The engine's writer publishes an append receipt beside the journal after each
//! record it appends (`events.append.json`: the journal's metadata after the
//! write, under an epoch that survives only a write whose starting metadata
//! matches the previous receipt). A long-lived `RunView::refresh` reads only the
//! appended records when the receipt continues the one it last saw, and re-reads
//! the whole journal otherwise — so a fixture that appended bare lines would make
//! every live update a whole re-read, which is not what a run the engine drives
//! costs. The engine exports no appender; this writes the receipt the way
//! `onepipeline::appendstamp` does, and `apps/dag-ui-e2e/load/journal.mjs` is the
//! same writer for the browser's load workload. The journeys count the refresh
//! outcomes the server reports, so a receipt the engine stopped accepting fails
//! them as a re-read rather than passing unnoticed.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The receipt beside one journal.
pub fn receipt_path(journal: &Path) -> PathBuf {
    journal.with_extension("append.json")
}

fn system_time(at: SystemTime) -> Value {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    json!({ "secs_since_epoch": since.as_secs(), "nanos_since_epoch": since.subsec_nanos() })
}

/// The journal's metadata, as the engine's `Stamp` reads it.
pub fn stamp_of(journal: &Path) -> Value {
    let about = fs::metadata(journal).expect("the journal is there");
    let mut stamp = json!({
        "len": about.len(),
        "modified": system_time(about.modified().expect("a modification time")),
    });
    if let Ok(created) = about.created() {
        stamp["created"] = system_time(created);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        stamp["identity"] = json!([about.dev(), about.ino(), about.ctime(), about.ctime_nsec()]);
    }
    stamp
}

fn write_receipt(journal: &Path, epoch: &str) {
    let receipt = json!({ "schema_version": 1, "epoch": epoch, "stamp": stamp_of(journal) });
    let staged = journal.with_extension("append.json.tmp");
    fs::write(&staged, serde_json::to_vec_pretty(&receipt).expect("serialize")).expect("stage");
    fs::rename(&staged, receipt_path(journal)).expect("publish the receipt");
}

fn fresh_epoch() -> String {
    format!(
        "journey-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
    )
}

/// Leave a receipt for a journal written whole, as a writer that has just
/// appended its last record leaves one.
pub fn receipt_for(journal: &Path) {
    write_receipt(journal, &fresh_epoch());
}

/// Append `lines` to `journal` in one write and publish the receipt the
/// engine's writer would: the epoch continues only when the receipt on disk
/// describes the journal as this write found it.
pub fn append_lines(journal: &Path, lines: &[String]) {
    let before = stamp_of(journal);
    let previous: Option<Value> = fs::read(receipt_path(journal))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let epoch = previous
        .filter(|receipt| receipt["schema_version"] == 1 && receipt["stamp"] == before)
        .and_then(|receipt| receipt["epoch"].as_str().map(str::to_owned))
        .unwrap_or_else(fresh_epoch);
    let mut file = fs::OpenOptions::new().append(true).open(journal).expect("open the journal");
    for line in lines {
        writeln!(file, "{line}").expect("append");
    }
    file.flush().expect("flush");
    drop(file);
    write_receipt(journal, &epoch);
}

/// Split a journal written whole into the first `keep` records, which stay on
/// disk with a receipt, and the rest, handed back to be appended one by one.
pub fn hold_back(journal: &Path, keep: usize) -> Vec<String> {
    let text = fs::read_to_string(journal).expect("read the journal");
    let lines: Vec<String> = text.lines().filter(|line| !line.is_empty()).map(str::to_owned).collect();
    let (kept, rest) = lines.split_at(keep.min(lines.len()));
    let mut body = kept.join("\n");
    body.push('\n');
    fs::write(journal, body).expect("rewrite the journal");
    receipt_for(journal);
    rest.to_vec()
}
