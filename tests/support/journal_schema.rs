//! Every pipeline record a journey serves, held to the schema the linked engine
//! publishes for its kind.
//!
//! This crate serves a payload as the journal holds it, so a fixture that wrote
//! a shape the engine never journals would be served — and asserted on — as if
//! it were one. The engine registers a document for every payload it emits
//! (`onepipeline::payload::registry`) under the id its kind maps to
//! (`onepipeline::payload::schema_of`), so a record a fixture wrote by hand is
//! checked against that document rather than against a second reading of it
//! kept here. [`crate::serving::Serving`] runs the check over the root it served
//! once its server has stopped, so a record appended after the server started
//! is held to it as well as one the fixture wrote before. The one exception is
//! a payload a fixture marked with `fixture_run::departing_by_design` — a record
//! a producer wrote badly, for a journey about what a reader makes of one — and
//! that one is held to departing.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::fs;
use std::path::Path;

use onepipeline::event::{EventKind, PipelineKind};
use serde_json::Value;

use crate::fixture_run;

/// The file every run keeps its journal in.
const JOURNAL: &str = "events.jsonl";

/// The source this library's own records are written under; a sibling's
/// records are its own library's to describe.
const PIPELINE_SOURCE: &str = "pipeline";

/// Every pipeline record under `runs_root` whose payload its kind's schema
/// refuses, one line each naming the journal, the line, the kind and the
/// violation. Empty when every record conforms.
pub fn departures(runs_root: &Path) -> Vec<String> {
    let registry = onepipeline::payload::registry();
    let mut found = Vec::new();
    let mut journals = Vec::new();
    collect_journals(runs_root, &mut journals);
    journals.sort();
    for journal in journals {
        // A journal a journey removed or truncated mid-read is the journey's to
        // describe; what is here to read is what is checked.
        let Ok(text) = fs::read_to_string(&journal) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            // A torn or non-JSON line is a fixture about an unreadable journal,
            // which the server's own reader answers; it has no payload to check.
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if record["source"] != PIPELINE_SOURCE {
                continue;
            }
            let Some(kind) = record["kind"]
                .as_str()
                .and_then(|kind| PipelineKind::from_wire(&EventKind(kind.to_owned())))
            else {
                continue;
            };
            let checked =
                registry.check(&onepipeline::payload::schema_of(kind), &record["payload"]);
            let at = format!("{}:{}: {kind}", journal.display(), index + 1);
            match (
                checked,
                fixture_run::departs_by_design(kind.as_str(), &record["payload"]),
            ) {
                (Ok(()), false) | (Err(_), true) => {}
                (Err(refused), false) => found.push(format!("{at}: {refused}")),
                (Ok(()), true) => found.push(format!(
                    "{at}: marked as departing from its schema by design, and conforms"
                )),
            }
        }
    }
    found
}

/// Fail the journey when any pipeline record under `runs_root` departs from its
/// kind's schema.
pub fn assert_conforms(runs_root: &Path) {
    let found = departures(runs_root);
    assert!(
        found.is_empty(),
        "a journal record departs from the schema the linked engine publishes for its kind:\n{}",
        found.join("\n")
    );
}

fn collect_journals(dir: &Path, into: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_journals(&path, into);
        } else if kind.is_file() && entry.file_name() == JOURNAL {
            into.push(path);
        }
    }
}
