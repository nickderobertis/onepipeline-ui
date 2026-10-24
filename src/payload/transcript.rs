//! A turn's words, read whole out of the transcript the turn was recorded in.
//!
//! `oneagentgraph` stopped copying a turn's content into its records once
//! history is on: a `turn-started`, `turn-message` or `turn-activity` carries a
//! `transcript` reference into the oneharness history file and none of the
//! bounded copies beside it. Every reading this crate serves of a turn's content
//! — a conversation's prompt, reply and tool calls, a timeline row's one line,
//! the header's activity line, a standalone harness session — goes through
//! [`read`] or [`session`], and those go through the engine's own
//! `views::transcript` resolver, so the browser and `onepipeline transcript`
//! read the same entry by the same rules and describe it in the same words.
//!
//! **A reference that resolves to nothing is said, never blanked.** Its text is
//! the resolver's own `transcript unavailable: <path>: <why>`, which is what the
//! CLI prints for the same record.
//!
//! **A run recorded before references keeps its copies, and a cut copy is the
//! last resort rather than the reading.** Such a record carries the bounded copy
//! and a cut flag. The member's stored report, where the run holds one, is read
//! instead of the journal altogether (`conversation_document`); where it holds
//! none, the copy is recovered whole from a history file the run itself names —
//! the session's own `oneharness-session` records, and the run's pointer-file
//! lines for the same node — when that file holds an entry the copy is a cut of.
//! Only where neither holds one is the copy served, still flagged, which is what
//! lets a reader be told the recorder cut it and no whole copy exists.

use std::cell::OnceCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use oneagentgraph::event::{ActivityTranscript, Transcript};
use onepipeline::agents::{AgentScope, NODE_LABEL};
use onepipeline::event::Envelope;
use onepipeline::views::transcript::{
    resolve as engine_resolve, Resolved, Text, ToolKind, TranscriptRef, Unresolved, Why,
};
use onepipeline::views::RunPaths;
use serde_json::{json, Value};

use crate::contract::{Confined, StoreRoot};

/// The relayed kind that points at a whole oneharness invocation.
const HARNESS_SESSION: &str = "oneharness-session";

/// What one turn record's content reads as.
#[derive(Debug, Clone)]
pub(crate) enum Read {
    /// The whole of it: out of the history file, or a copy nothing cut.
    Whole(Resolved),
    /// A copy its recorder cut, from a run recorded before turn records pointed
    /// at their transcript, with no whole copy anywhere the run names.
    Cut(Resolved),
    /// A reference that resolved to nothing, and why.
    Unavailable(Unresolved),
}

impl Read {
    /// One line describing the entry: the resolver's own, or its
    /// `transcript unavailable` line.
    pub(crate) fn description(&self) -> String {
        match self {
            Self::Whole(resolved) | Self::Cut(resolved) => resolved.description.clone(),
            Self::Unavailable(unresolved) => unresolved.to_string(),
        }
    }

    /// The entry's content, where anything was read.
    pub(crate) fn text(&self) -> Option<&Text> {
        match self {
            Self::Whole(resolved) | Self::Cut(resolved) => Some(&resolved.text),
            Self::Unavailable(_) => None,
        }
    }

    /// Whether what is served is a copy its recorder cut.
    pub(crate) fn cut(&self) -> bool {
        matches!(self, Self::Cut(_))
    }

    /// A tool entry's input, as the harness recorded it, and what it returned —
    /// `None` for an entry that is not a tool's, or that was not read.
    pub(crate) fn tool(&self) -> Option<(Option<Value>, Option<String>)> {
        match self.text()? {
            Text::Tool { input, output, .. } => Some((input.clone(), output.clone())),
            _ => None,
        }
    }

    /// An instruction's or a message's words: the whole text, the copy, or the
    /// `transcript unavailable` line — never empty for want of a read.
    pub(crate) fn words(&self) -> String {
        match self.text() {
            Some(Text::Instruction(words) | Text::Message(words) | Text::Reasoning(words)) => {
                words.clone()
            }
            Some(Text::Tool { output, .. }) => output.clone().unwrap_or_default(),
            Some(_) => String::new(),
            None => self.description(),
        }
    }
}

/// Where a session's cut copies can be recovered whole from: every history
/// location the run itself names for it, read only once a cut copy asks.
///
/// Lazy because almost no read needs it — a record carrying a reference, or a
/// copy nothing cut, never does — and reading a run's pointer file is not a cost
/// a conversation of a current run should pay.
pub(crate) struct Sources<'a> {
    paths: &'a RunPaths,
    records: &'a [&'a Envelope],
    found: OnceCell<Vec<Transcript>>,
}

impl<'a> Sources<'a> {
    /// The sources of the session whose relayed records are `records`.
    pub(crate) fn of(paths: &'a RunPaths, records: &'a [&'a Envelope]) -> Self {
        Self {
            paths,
            records,
            found: OnceCell::new(),
        }
    }

    fn get(&self) -> &[Transcript] {
        self.found.get_or_init(|| {
            let mut found: Vec<Transcript> = self
                .records
                .iter()
                .filter(|event| event.kind.0 == HARNESS_SESSION)
                .filter_map(|event| location(&json!(event.payload)))
                .collect();
            // The run's pointer file names every invocation its launches began,
            // a member that died before anything relayed a pointer at it
            // included. A line counts for this session only where it was stamped
            // at the node the session ran at; the prefix test in `recover` is
            // what makes a line from another dispatch of that node harmless.
            let node = self
                .records
                .iter()
                .find_map(|event| event.labels.node.as_deref());
            if let (Some(node), Ok(agents)) = (
                node,
                onepipeline::verbs::agents(self.paths, AgentScope::Run),
            ) {
                for session in &agents.sessions {
                    if session.labels.as_map().get(NODE_LABEL).map(String::as_str) != Some(node) {
                        continue;
                    }
                    for run in &session.runs {
                        if let Some(source) = location(&json!({
                            "history_dir": session.history_dir,
                            "history_project": session.history_project,
                            "history_session": session.history_session,
                            "history_id": run.history_id.to_string(),
                        })) {
                            if !found.contains(&source) {
                                found.push(source);
                            }
                        }
                    }
                }
            }
            found
        })
    }
}

/// A history location, read off a record that names one — `None` for one this
/// build cannot read as the shape `oneagentgraph` writes.
fn location(fields: &Value) -> Option<Transcript> {
    serde_json::from_value(json!({
        "history_dir": fields.get("history_dir")?,
        "history_project": fields.get("history_project")?,
        "history_session": fields.get("history_session")?,
        "history_id": fields.get("history_id")?,
    }))
    .ok()
}

/// What one relayed record's content reads as, or `None` for a record that
/// carries no turn content.
pub(crate) fn read(event: &Envelope, sources: Option<&Sources<'_>>) -> Option<Read> {
    let reference = match TranscriptRef::of(&event.kind.0, &event.payload)? {
        Ok(reference) => reference,
        Err(unresolved) => return Some(Read::Unavailable(unresolved)),
    };
    if reference.is_reference() {
        return Some(match resolve(&reference) {
            Ok(resolved) => Read::Whole(resolved),
            Err(unresolved) => Read::Unavailable(unresolved),
        });
    }
    // A copy answers itself without opening anything.
    let copy = match engine_resolve(&reference) {
        Ok(copy) => copy,
        Err(unresolved) => return Some(Read::Unavailable(unresolved)),
    };
    if !copy.cut {
        return Some(Read::Whole(copy));
    }
    let whole = sources.and_then(|sources| {
        sources
            .get()
            .iter()
            .find_map(|source| recover(event, &copy.text, source))
    });
    Some(whole.map_or(Read::Cut(copy), Read::Whole))
}

/// The whole entry `source` holds for a cut copy, where it holds one the copy is
/// a cut of.
///
/// The recorder keeps an instruction's and a message's **head** and a tool
/// output's **tail**, so the whole text starts or ends with the copy; an entry
/// that does not is some other turn's, however its location was found.
fn recover(event: &Envelope, copy: &Text, source: &Transcript) -> Option<Resolved> {
    let role = event.payload.get("role").and_then(Value::as_str);
    let reference = match event.kind.0.as_str() {
        "turn-started" => TranscriptRef::Instruction(source.clone()),
        "turn-message" if role == Some("user") => TranscriptRef::Decision(source.clone()),
        "turn-message" => TranscriptRef::Message(source.clone()),
        "turn-activity" => TranscriptRef::Activity(ActivityTranscript {
            location: source.clone(),
            index: event.payload.get("index").and_then(Value::as_u64)?,
            tool_call_id: event
                .payload
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        _ => return None,
    };
    let whole = resolve(&reference).ok()?;
    // An instruction and a message are bounded like every payload text, to their
    // head; an activity's output to its tail.
    let head = event.kind.0 != "turn-activity";
    let holds = |cut: &str, whole: &str| {
        if head {
            whole.starts_with(cut)
        } else {
            whole.trim_end().ends_with(cut.trim_end())
        }
    };
    let agrees = match (copy, &whole.text) {
        (Text::Instruction(cut), Text::Instruction(whole))
        | (Text::Message(cut), Text::Message(whole))
        | (Text::Reasoning(cut), Text::Reasoning(whole)) => holds(cut, whole),
        (
            Text::Tool {
                name: cut_name,
                output: cut_output,
                ..
            },
            Text::Tool {
                name: whole_name,
                output: whole_output,
                ..
            },
        ) => {
            cut_name == whole_name
                && match (cut_output, whole_output) {
                    (Some(cut), Some(whole)) => holds(cut, whole),
                    // A call cut only in its summary is matched by identity: the
                    // summary is a collapsed head of the input, which no text
                    // test can hold to the input it summarized.
                    (None, _) => event.payload.get("tool_call_id").is_some(),
                    (Some(_), None) => false,
                }
        }
        _ => false,
    };
    agrees.then_some(whole)
}

/// One standalone oneharness invocation, read whole entry by entry: its prompt,
/// every event it recorded in order, and its closing text where it has closed.
///
/// Its events are the resolver's `index` from 0 until the file holds no next
/// one, which is how oneharness numbers a candidate's events — contiguously from
/// 0 — so a file still being written reads up to its last complete event.
pub(crate) struct Session {
    /// The prompt it was given, or why it could not be read.
    pub(crate) instruction: Read,
    /// Every event it recorded, in order.
    pub(crate) events: Vec<(u64, Read)>,
    /// What it closed with; `None` for an invocation still running.
    pub(crate) closed: Option<Read>,
}

/// The invocation `location` names, read whole.
pub(crate) fn session(location: &Transcript) -> Session {
    let instruction = whole_or_not(&TranscriptRef::Instruction(location.clone()));
    let mut events = Vec::new();
    for index in 0_u64.. {
        let entry = TranscriptRef::Activity(ActivityTranscript {
            location: location.clone(),
            index,
            tool_call_id: None,
        });
        match resolve(&entry) {
            Ok(resolved) => events.push((index, Read::Whole(resolved))),
            // The end of what it recorded, not an entry that is missing.
            Err(Unresolved {
                why: Why::MissingEntry,
                ..
            }) => break,
            Err(unresolved) => {
                // A file that could not be read for its first event is said once,
                // on the instruction beside it; one that stopped part way says
                // where.
                if index > 0 {
                    events.push((index, Read::Unavailable(unresolved)));
                }
                break;
            }
        }
    }
    let closed = match resolve(&TranscriptRef::Message(location.clone())) {
        Ok(resolved) => Some(Read::Whole(resolved)),
        Err(Unresolved {
            why: Why::MissingEntry,
            ..
        }) if !matches!(instruction, Read::Unavailable(_)) => None,
        Err(unresolved) => Some(Read::Unavailable(unresolved)),
    };
    Session {
        instruction,
        events,
        closed,
    }
}

fn whole_or_not(reference: &TranscriptRef) -> Read {
    match resolve(reference) {
        Ok(resolved) => Read::Whole(resolved),
        Err(unresolved) => Read::Unavailable(unresolved),
    }
}

/// A tool entry's kind, or `None` for an entry that is the agent's own words.
pub(crate) fn tool_kind(text: &Text) -> Option<&ToolKind> {
    match text {
        Text::Tool { kind, .. } => Some(kind),
        _ => None,
    }
}

/// The tool a call named, where it named one.
pub(crate) fn tool_name(text: &Text) -> Option<&str> {
    match text {
        Text::Tool { name, .. } => name.as_deref(),
        _ => None,
    }
}

/// The history schema's word for an entry that is the agent's words: `message`
/// or `reasoning`.
pub(crate) fn words_kind(text: &Text) -> &'static str {
    match text {
        Text::Reasoning(_) => "reasoning",
        _ => "message",
    }
}

/// The wire's word for a tool entry's kind: oneharness's own.
pub(crate) fn kind_word(kind: &ToolKind) -> String {
    match kind {
        ToolKind::Call => "tool_call".to_owned(),
        ToolKind::Result => "tool_result".to_owned(),
        ToolKind::Other(word) => word.clone(),
        // A kind a later engine distinguishes is still a tool's entry; its own
        // spelling is not reachable here, so it is named for what it is.
        _ => "tool".to_owned(),
    }
}

/// Resolve one reference through the engine, confined to the store it names and
/// remembered once it resolved.
///
/// **Confined first.** The resolver refuses a project or session that is not a
/// bare name, but a bare name still lands anywhere if a component of the store
/// is a symlink; so where the store is on this host the file is proved to land
/// under it before anything opens it, exactly as the artifact route always has,
/// and one that escapes is unreadable rather than read.
///
/// **Remembered once whole.** A history file is append-only and an entry in it
/// never changes once written, so what resolved is kept — bounded — and served
/// again while the file is still there, rather than rescanning the file for every
/// record of a turn on every read of a live view. Only a success is kept: an
/// entry not written yet is one a later read must look for again.
fn resolve(reference: &TranscriptRef) -> Result<Resolved, Unresolved> {
    let Some(path) = path_of(reference) else {
        return engine_resolve(reference);
    };
    if let Some(store) = store_of(reference).and_then(|dir| StoreRoot::read(&dir)) {
        if let Confined::Escaped = store.confine(&path) {
            eprintln!(
                "onepipeline-api: refusing a transcript that resolves outside the store its record named"
            );
            return Err(Unresolved {
                path,
                why: Why::Unreadable,
            });
        }
    }
    let key = serde_json::to_string(reference).ok();
    if let Some(key) = &key {
        if path.is_file() {
            if let Some(hit) = remembered().lock().ok().and_then(|cache| cache.get(key)) {
                return Ok(hit);
            }
        }
    }
    let resolved = engine_resolve(reference)?;
    if let (Some(key), Ok(mut cache)) = (key, remembered().lock()) {
        cache.keep(key, &resolved);
    }
    Ok(resolved)
}

/// The history file a reference names, as the resolver spells it.
fn path_of(reference: &TranscriptRef) -> Option<PathBuf> {
    let location = location_of(reference)?;
    Some(
        PathBuf::from(&location.history_dir)
            .join(&location.history_project)
            .join(format!("{}.jsonl", location.history_session)),
    )
}

fn store_of(reference: &TranscriptRef) -> Option<PathBuf> {
    location_of(reference).map(|location| Path::new(&location.history_dir).to_path_buf())
}

fn location_of(reference: &TranscriptRef) -> Option<&Transcript> {
    match reference {
        TranscriptRef::Instruction(location)
        | TranscriptRef::Message(location)
        | TranscriptRef::Decision(location) => Some(location),
        TranscriptRef::Activity(activity) => Some(&activity.location),
        _ => None,
    }
}

/// How much resolved text is remembered, in bytes, and how many entries.
const REMEMBERED_BYTES: usize = 32 * 1024 * 1024;
const REMEMBERED_ENTRIES: usize = 16 * 1024;

/// The resolutions this process has made, oldest first out.
#[derive(Default)]
struct Remembered {
    entries: HashMap<String, Resolved>,
    order: VecDeque<(String, usize)>,
    bytes: usize,
}

impl Remembered {
    fn get(&self, key: &str) -> Option<Resolved> {
        self.entries.get(key).cloned()
    }

    fn keep(&mut self, key: String, resolved: &Resolved) {
        if self.entries.contains_key(&key) {
            return;
        }
        let size = key.len() + resolved.description.len() + text_len(&resolved.text);
        if size > REMEMBERED_BYTES {
            return;
        }
        while self.bytes + size > REMEMBERED_BYTES || self.order.len() >= REMEMBERED_ENTRIES {
            let Some((oldest, freed)) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
            self.bytes -= freed;
        }
        self.entries.insert(key.clone(), resolved.clone());
        self.order.push_back((key, size));
        self.bytes += size;
    }
}

fn text_len(text: &Text) -> usize {
    match text {
        Text::Instruction(words) | Text::Message(words) | Text::Reasoning(words) => words.len(),
        Text::Tool {
            name,
            input,
            output,
            ..
        } => {
            name.as_ref().map_or(0, String::len)
                + input.as_ref().map_or(0, |input| input.to_string().len())
                + output.as_ref().map_or(0, String::len)
        }
        _ => 0,
    }
}

fn remembered() -> &'static Mutex<Remembered> {
    static REMEMBERED: OnceLock<Mutex<Remembered>> = OnceLock::new();
    REMEMBERED.get_or_init(|| Mutex::new(Remembered::default()))
}
