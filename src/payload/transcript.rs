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
    events: &'a [Envelope],
    session: &'a str,
    node: Option<&'a str>,
    found: OnceCell<Vec<Transcript>>,
}

impl<'a> Sources<'a> {
    /// The sources of `session`, among the run's `events`, at the node it ran at.
    pub(crate) fn of(
        paths: &'a RunPaths,
        events: &'a [Envelope],
        session: &'a str,
        node: Option<&'a str>,
    ) -> Self {
        Self {
            paths,
            events,
            session,
            node,
            found: OnceCell::new(),
        }
    }

    fn get(&self) -> &[Transcript] {
        self.found.get_or_init(|| {
            // The session's own pointers: a `oneharness-session` carries no
            // `session` label, so it is joined the way a settlement is — by the
            // `{stream}.{member}` a session id is minted from.
            let mut found: Vec<Transcript> = self
                .events
                .iter()
                .filter(|event| event.kind.0 == HARNESS_SESSION && spells(event, self.session))
                .filter_map(|event| location(&json!(event.payload)))
                .collect();
            // The run's pointer file names every invocation its launches began,
            // a member that died before anything relayed a pointer at it
            // included. A line counts for this session only where it was stamped
            // at the node the session ran at; the prefix test in `recover` is
            // what makes a line from another dispatch of that node harmless.
            if let (Some(node), Ok(agents)) = (
                self.node,
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

/// The whole invocations a cut copy may be recovered from.
pub(crate) trait Candidates {
    /// The invocations, read once and kept.
    fn candidates(&self) -> &[Transcript];
}

impl Candidates for Sources<'_> {
    fn candidates(&self) -> &[Transcript] {
        self.get()
    }
}

/// The invocation one turn ran as, among a session's sources: the one whose
/// prompt begins with the instruction the turn's own record carried.
///
/// A turn's reply and its tool outputs are recovered from that invocation and
/// no other. A tool's output is a tail, and two turns that ran the same command
/// can have returned the same tail — so an output test alone cannot tell which
/// turn's file it is reading, where the prompt each turn was given can.
pub(crate) struct TurnSources<'a, 's> {
    sources: &'s Sources<'a>,
    started: Option<&'s Envelope>,
    found: OnceCell<Vec<Transcript>>,
}

impl<'a, 's> TurnSources<'a, 's> {
    /// The invocation the turn `started` opened, among `sources`.
    pub(crate) fn of(sources: &'s Sources<'a>, started: Option<&'s Envelope>) -> Self {
        Self {
            sources,
            started,
            found: OnceCell::new(),
        }
    }
}

impl Candidates for TurnSources<'_, '_> {
    fn candidates(&self) -> &[Transcript] {
        self.found.get_or_init(|| {
            let Some(copy) = self
                .started
                .and_then(|event| event.payload.get("instruction"))
                .and_then(Value::as_str)
            else {
                return Vec::new();
            };
            self.sources
                .get()
                .iter()
                .filter(|source| {
                    matches!(
                        resolve(&TranscriptRef::Instruction((*source).clone())),
                        Ok(Resolved { text: Text::Instruction(whole), .. }) if whole.starts_with(copy)
                    )
                })
                .cloned()
                .collect()
        })
    }
}

/// Whether a relayed record belongs to `session` by its own label or by the
/// `{stream}.{member}` a session id is minted from.
fn spells(event: &Envelope, session: &str) -> bool {
    super::session_label(event) == Some(session) || super::spells_session(event, session)
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
pub(crate) fn read(event: &Envelope, sources: Option<&dyn Candidates>) -> Option<Read> {
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
            .candidates()
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
    let reference = match event.kind.0.as_str() {
        "turn-started" => TranscriptRef::Instruction(source.clone()),
        // Only the agent's own words are a turn's reply; a supervisor's message
        // is no agent turn's text, and is never read whole from here.
        "turn-message"
            if event.payload.get("role").and_then(Value::as_str) == Some("assistant") =>
        {
            TranscriptRef::Message(source.clone())
        }
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

/// The resolutions this process has made, oldest first out, within a bound.
struct Remembered {
    entries: HashMap<String, Resolved>,
    order: VecDeque<(String, usize)>,
    bytes: usize,
    /// The most text kept, in bytes; an entry larger than this is not kept.
    max_bytes: usize,
    /// The most entries kept.
    max_entries: usize,
}

// llmlint: ignore-block[changed_behavior_has_e2e] the bound is 32 MiB or 16,384 entries, so a journey would have to push that much transcript through a server to reach it; the unit tests below drive `keep` and `get` at small bounds for the refusal of an oversized entry and for eviction by bytes and by count, and what a read does after an eviction is a miss — a fresh resolution of the file — which `tests/e2e/transcripts.rs::a_remembered_reading_follows_the_history_file_as_it_changes` drives through the server.
impl Remembered {
    fn within(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_bytes,
            max_entries,
        }
    }

    fn get(&self, key: &str) -> Option<Resolved> {
        self.entries.get(key).cloned()
    }

    fn keep(&mut self, key: String, resolved: &Resolved) {
        if self.entries.contains_key(&key) {
            return;
        }
        let size = key.len() + resolved.description.len() + text_len(&resolved.text);
        if size > self.max_bytes || self.max_entries == 0 {
            return;
        }
        while self.bytes + size > self.max_bytes || self.order.len() >= self.max_entries {
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
// llmlint: ignore-end[changed_behavior_has_e2e]

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
    REMEMBERED.get_or_init(|| Mutex::new(Remembered::within(REMEMBERED_BYTES, REMEMBERED_ENTRIES)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(words: &str) -> Resolved {
        Resolved {
            text: Text::Message(words.to_owned()),
            description: String::new(),
            cut: false,
        }
    }

    /// What one entry costs against the byte bound: its key and its text.
    fn cost(key: &str, words: &str) -> usize {
        key.len() + words.len()
    }

    #[test]
    fn an_entry_larger_than_the_whole_bound_is_never_kept() {
        let mut remembered = Remembered::within(cost("k", "0123456789") - 1, 8);
        remembered.keep("k".into(), &said("0123456789"));
        assert!(remembered.get("k").is_none());
        assert_eq!(remembered.bytes, 0);
    }

    #[test]
    fn the_oldest_entries_go_first_once_the_bytes_would_pass_the_bound() {
        let mut remembered = Remembered::within(cost("a", "aaaa") * 2, 8);
        remembered.keep("a".into(), &said("aaaa"));
        remembered.keep("b".into(), &said("bbbb"));
        remembered.keep("c".into(), &said("cccc"));
        assert!(remembered.get("a").is_none(), "the oldest was let go");
        assert_eq!(remembered.get("b"), Some(said("bbbb")));
        assert_eq!(remembered.get("c"), Some(said("cccc")));
        assert_eq!(remembered.bytes, cost("b", "bbbb") + cost("c", "cccc"));
    }

    #[test]
    fn the_oldest_entries_go_first_once_the_count_would_pass_the_bound() {
        let mut remembered = Remembered::within(usize::MAX, 2);
        for key in ["a", "b", "c"] {
            remembered.keep(key.into(), &said(key));
        }
        assert!(remembered.get("a").is_none());
        assert_eq!(remembered.order.len(), 2);
    }

    #[test]
    fn an_entry_already_kept_is_not_counted_twice() {
        let mut remembered = Remembered::within(usize::MAX, 8);
        remembered.keep("a".into(), &said("aaaa"));
        remembered.keep("a".into(), &said("aaaa"));
        assert_eq!(remembered.order.len(), 1);
        assert_eq!(remembered.bytes, cost("a", "aaaa"));
    }
}
