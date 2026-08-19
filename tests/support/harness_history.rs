//! A real oneharness history store, written by the library that writes one.
//!
//! The bytes an `oneharness_session` artifact resolves to are not the run's:
//! oneharness keeps them in its own store, and `oneagentgraph` publishes only a
//! pointer at them. So a journey that proves the read has to have a store to
//! read, and this writes one the only honest way — through
//! `oneharness_core::io::history::HistoryWriter`, which is the writer whose
//! layout, line format and session naming the server reads back through.
//! Nothing here spells a file name, a project slug or a record shape: each one
//! is asked of the writer afterwards, so a store built this way cannot pass
//! while the two sides disagree about any of them.
//!
//! No `oneharness` process is ever started. The library is linked, here as in
//! `src/payload.rs`.

#![allow(dead_code)] // Each test binary uses the part of the store it needs.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use oneharness_core::domain::history::HistoryLabels;
use oneharness_core::domain::mode::PermissionMode;
use oneharness_core::domain::report::RunResult;
use oneharness_core::io::history::HistoryWriter;
use serde_json::json;

/// One oneharness invocation that was written down, in the terms
/// `oneagentgraph` publishes a pointer at it: the record's own id, and the three
/// path fields that locate the file it landed in.
///
/// Every one of them is read back off the writer rather than chosen here — the
/// session stem carries the writer's own clock and pid, and the project slug is
/// its own sanitiser's answer.
pub struct Recorded {
    /// The record's id, which is also the artifact id the event carries.
    pub history_id: String,
    /// The store the writer wrote into.
    pub dir: PathBuf,
    /// The project directory inside it, by name.
    pub project: String,
    /// The session file inside that, by stem.
    pub session: String,
    /// The session file itself.
    pub path: PathBuf,
}

impl Recorded {
    /// The session file's size, which is what the producer records as the
    /// artifact's `bytes`.
    pub fn bytes(&self) -> u64 {
        fs::metadata(&self.path).map_or(0, |file| file.len())
    }
}

/// Record one harness invocation into the store at `dir`, exactly as a
/// oneharness run records itself.
///
/// `name` is the session's human-meaningful name, `prompt` what the invocation
/// was asked, and `text` the final assistant text it reported — the three fields
/// a reader opens a transcript to read.
pub fn record(dir: &Path, name: &str, prompt: &str, text: &str) -> Recorded {
    // The directory the harness ran in. oneharness canonicalizes it and slugs
    // the result into the store's project layer, so it has to be a real one.
    let project = dir.join("project");
    fs::create_dir_all(&project).expect("the project the harness ran in");
    let writer = HistoryWriter::open(
        dir,
        &project,
        name,
        HistoryLabels::new(BTreeMap::new()).expect("no labels"),
    )
    .expect("open the history store");
    let history_id = writer.begin_run();
    writer
        .append_streamed(
            history_id,
            PermissionMode::Default,
            Some("a-model"),
            prompt,
            &result(prompt, text),
            &BTreeSet::new(),
        )
        .expect("append the run oneharness had");
    let path = writer.path().to_path_buf();
    Recorded {
        history_id: history_id.to_string(),
        dir: dir.to_path_buf(),
        project: named(path.parent().expect("the project directory")),
        session: path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("the session file's stem")
            .to_owned(),
        path,
    }
}

/// The last component of a path, as the store holds it.
fn named(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .expect("a named directory")
        .to_owned()
}

/// One finished harness run, as oneharness normalizes one.
///
/// Built as the document that library serializes and parsed back into its own
/// type, so a field it renames or requires fails here rather than producing a
/// store the reader silently makes nothing of.
fn result(prompt: &str, text: &str) -> RunResult {
    serde_json::from_value(json!({
        "harness": "claude-code",
        "variant": "alternate",
        "harness_id": "claude-code:alternate",
        "bin": "claude",
        "available": true,
        "status": "ok",
        "prompt": Option::<String>::None,
        "model": "a-model",
        "exit_code": 0,
        "duration_ms": 4_200,
        "telemetry": Option::<String>::None,
        "command": ["claude", "-p", prompt],
        "output_format": "json",
        "text": text,
        "text_source": "json:result",
        "usage": {
            "input_tokens": 1_200,
            "output_tokens": 340,
            "cache_read_tokens": 800,
            "cache_write_tokens": 120,
            "cost_usd": 0.42,
        },
        "usage_source": "json",
        "session_id": "54e7ad34-ce6d-4979-8b4d-531b88026e15",
        "events": Option::<String>::None,
        "events_source": Option::<String>::None,
        "structured": Option::<String>::None,
        "schema_valid": Option::<bool>::None,
        "schema_attempts": Option::<u32>::None,
        "schema_error": Option::<String>::None,
        "failure_kind": Option::<String>::None,
        "failure_kind_source": Option::<String>::None,
        "stdout": "",
        "stderr": "",
        "error": Option::<String>::None,
    }))
    .expect("the run result oneharness normalizes")
}
