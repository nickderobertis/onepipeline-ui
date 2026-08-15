//! The read-time event filter: the stack's shared grammar, and the named
//! profiles a reader selects it by.
//!
//! The grammar is the one `onevcs`, `oneagentgraph`, and `onepipeline` already
//! read — `include`/`exclude` matcher lists over the envelope's addressing, with
//! `exclude` winning and an absent `include` admitting everything. Like the
//! envelope itself it is **duplicated per repository by design**: there is no
//! shared util crate in this stack, so each consumer owns its copy and
//! `tests/contract.rs` holds this one to `oneagentgraph`'s published type.
//!
//! What is this crate's own is where a filter comes from. On the CLI a producer
//! is told once, at launch, what to put on its stream. A read API is asked per
//! request by a reader who did not launch the run, so the filter arrives as a
//! query parameter — a **named profile** (`planner`, `monitor`, or one the run's
//! own launch config defined) or an inline spec — and is resolved against the
//! run being read.
//!
//! **Filtering shapes responses and never run state.** A filter decides which
//! *events* a payload carries; the fold every status, settlement and count is
//! read from is the whole journal either way. A reader narrowing their attention
//! must never be shown a different graph from the one the run is running.

use std::collections::BTreeMap;

use onepipeline::event::{Envelope, Labels, Source};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;

/// The prefix a run's launch config defines a named profile under.
///
/// `onepipeline start --set filters.NAME=SPEC` is forwarded opaquely to the
/// dag-scope launch and retained verbatim in the run's launch record, which is
/// the one place this crate can read a run-specific decision from without asking
/// the SDK for a field it does not have. A `--set` under any other path is
/// somebody else's, and is left alone.
pub const PROFILE_SET_PREFIX: &str = "filters.";

/// The longest inline spec any request may carry.
///
/// A bound rather than a limit anyone will meet: a query string is external
/// input, and parsing an unbounded one into matchers is an unbounded allocation
/// per request.
pub const SPEC_MAX_LEN: usize = 8 * 1024;

/// Which envelopes a response carries.
///
/// [`EventFilter::default`] — no matcher on either list — admits everything, so
/// a request naming no filter is served exactly what it always was.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventFilter {
    /// Matchers an envelope satisfies one of to pass. Absent or empty admits
    /// every envelope, so a filter that only rejects need name nothing here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<Matcher>,
    /// Matchers that reject. A match here rejects whatever
    /// [`include`](Self::include) said, so a broad include beside a narrow
    /// exclude is how "all of this except that" is written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<Matcher>,
}

/// One matcher: every field it names must hold of an envelope, and a field it
/// does not name is not consulted.
///
/// Deliberately absent, and for two different reasons. `stream` identifies a
/// producing process rather than anything a reader means by an event, and
/// payload fields would make this a matcher over contents rather than over
/// addressing — both are the grammar's own omissions, shared with every sibling.
/// **`round` is absent because there are no rounds**: execution is continuous,
/// the label is deprecated and nothing stamps it, and a matcher over it would be
/// a filter that silently matched nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Matcher {
    /// The producing library, by exact equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    /// A glob over the kind's kebab-case wire string, where `*` stands for any
    /// run of characters including none and every other character is itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The `run_id` label the envelope was stamped with, by exact equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The `node` label the envelope was stamped with, by exact equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// The `step` label the envelope was stamped with, by exact equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// The `member` label the envelope was stamped with, by exact equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
    /// The `persona` label the envelope was stamped with, by exact equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
}

impl EventFilter {
    /// Whether an envelope reaches the response.
    ///
    /// `exclude` wins: a matcher there rejects whatever `include` admitted, and
    /// an empty `include` admits everything.
    #[must_use]
    pub fn allows(&self, event: &Envelope) -> bool {
        let (source, kind, labels) = (event.source, event.kind.0.as_str(), &event.labels);
        if self
            .exclude
            .iter()
            .any(|matcher| matcher.matches(source, kind, labels))
        {
            return false;
        }
        self.include.is_empty()
            || self
                .include
                .iter()
                .any(|matcher| matcher.matches(source, kind, labels))
    }

    /// Whether this filter admits every envelope, whatever a run recorded.
    ///
    /// The one question the store asks before doing any work: a request that
    /// narrowed nothing is served the payload it would have been served anyway,
    /// without a copy of the run's events being taken to prove it.
    #[must_use]
    pub fn admits_everything(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }

    /// Whether every matcher in this filter could match anything.
    ///
    /// A spec is external input, so this is its trust boundary and it is checked
    /// before a run is read rather than after: a matcher naming nothing at all
    /// silences the whole stream from `exclude`, and one naming an empty field
    /// matches nothing from either list. Both are far likelier to be a typo than
    /// an intent, and neither is answerable from the empty payload it produces.
    ///
    /// # Errors
    ///
    /// A message naming the offending matcher — which list it is in, where in
    /// that list, and what it says.
    pub fn validate(&self) -> Result<(), String> {
        for (list, matchers) in [("include", &self.include), ("exclude", &self.exclude)] {
            for (at, matcher) in matchers.iter().enumerate() {
                matcher.check().map_err(|why| {
                    format!(
                        "{list}[{at}] {}: {why}",
                        serde_json::to_string(matcher).unwrap_or_else(|_| "{}".to_owned())
                    )
                })?;
            }
        }
        Ok(())
    }
}

impl Matcher {
    /// What this matcher asks of the reserved labels, in the order the grammar
    /// lists them.
    ///
    /// One list rather than two, because [`matches`](Self::matches) and
    /// [`check`](Self::check) must read exactly the same keys: a key added to
    /// the grammar and to only one of them is either unchecked or unmatched, and
    /// both are silent.
    fn labels_asked(&self) -> [(&'static str, Option<&str>); 5] {
        [
            ("run_id", self.run_id.as_deref()),
            ("node", self.node.as_deref()),
            ("step", self.step.as_deref()),
            ("member", self.member.as_deref()),
            ("persona", self.persona.as_deref()),
        ]
    }

    /// Whether every field this matcher names holds of the envelope.
    fn matches(&self, source: Source, kind: &str, labels: &Labels) -> bool {
        if self.source.is_some_and(|named| named != source) {
            return false;
        }
        if self
            .kind
            .as_deref()
            .is_some_and(|pattern| !glob(pattern, kind))
        {
            return false;
        }
        // `member` has no typed slot on this envelope — `oneagentgraph` declares
        // one and `onepipeline` does not, and the merged store carries both — so
        // it is read off the extras alone, which is exactly where the producer
        // stamps it. Everything else has a slot, and [`stamped`] falls back to
        // the extras for each of them anyway.
        let typed = [
            labels.run_id.as_deref(),
            labels.node.as_deref(),
            labels.step.as_deref(),
            None,
            labels.persona.as_deref(),
        ];
        // A label the envelope never stamped is `None`, which no asked-for value
        // equals — a matcher naming a label the envelope did not stamp does not
        // match it.
        self.labels_asked()
            .iter()
            .zip(typed)
            .all(|((key, asked), typed)| match asked {
                None => true,
                Some(asked) => stamped(labels, key, typed) == Some(*asked),
            })
    }

    /// Whether this matcher could match anything; see [`EventFilter::validate`].
    fn check(&self) -> Result<(), String> {
        let mut named = usize::from(self.source.is_some());
        for (field, asked) in
            std::iter::once(("kind", self.kind.as_deref())).chain(self.labels_asked())
        {
            let Some(asked) = asked else { continue };
            named += 1;
            if asked.trim().is_empty() {
                return Err(format!(
                    "`{field}` is empty, and nothing on the stream carries an empty {field} — \
                     omit the field to leave it unasked"
                ));
            }
        }
        if named == 0 {
            return Err(
                "a matcher naming no field matches every event — name at least one of \
                        `source`, `kind`, `run_id`, `node`, `step`, `member`, or `persona`"
                    .to_owned(),
            );
        }
        Ok(())
    }
}

/// What an envelope carries under one reserved label key.
///
/// The typed slot, or — where that is unset — the same key among the extras,
/// because a matcher asks about the key *as the envelope carries it*. `Labels`
/// flattens its extras beside the reserved fields, so a stamp a producer added
/// under a name this envelope has no slot for reaches the wire under exactly the
/// name the grammar names, and a filter that consulted only the typed slot would
/// refuse to see a label its own reader can plainly read. A non-string extra is
/// not a label value and matches nothing.
fn stamped<'a>(labels: &'a Labels, key: &str, typed: Option<&'a str>) -> Option<&'a str> {
    typed.or_else(|| labels.extra.get(key).and_then(Value::as_str))
}

/// Whether `pattern` matches `text`, where `*` stands for any run of characters
/// including none and every other character is itself.
///
/// The whole dialect, stated rather than inherited: this is a cross-repo grammar
/// with no shared implementation, so a `?` or a `[a-z]` supported here and
/// nowhere else would be a spec that filters differently depending on which
/// producer read it. Kebab-case wire strings need neither.
fn glob(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    // Where to resume from if the run this `*` is currently standing for turns
    // out to be one character too short.
    let (mut star, mut resume) = (None, 0);
    while t < text.len() {
        if pattern.get(p) == Some(&'*') {
            star = Some(p);
            resume = t;
            p += 1;
        } else if pattern.get(p) == Some(&text[t]) {
            p += 1;
            t += 1;
        } else if let Some(at) = star {
            p = at + 1;
            resume += 1;
            t = resume;
        } else {
            return false;
        }
    }
    while pattern.get(p) == Some(&'*') {
        p += 1;
    }
    p == pattern.len()
}

/// The profiles this server defines for every run, whatever it was launched
/// with.
///
/// Two, because there are two attentions and the CLI already gives its readers
/// exactly these: the planner decides, and the monitor watches. A reader picks
/// one by name rather than restating a spec, so the browser and the CLI narrow
/// to the same thing under the same word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Profile {
    /// **Decisions only.** `onepipeline`'s own vocabulary is a closed set and it
    /// is exactly the decision vocabulary — a node became ready, was dispatched,
    /// settled; an edit was committed or refused; a decision began holding
    /// dependents back and was cleared; the planner was surfaced to and replied.
    /// Everything a sibling relays is the *activity* those decisions are made
    /// about, and none of it is a decision.
    Planner,
    /// **Detailed activity**: the whole merged stream, all three sources. The
    /// monitor persona's own contract is that it reads the detailed stream and
    /// compares activity against the run's goal, so its profile narrows nothing
    /// — it is named rather than derived so that asking for it is a statement of
    /// intent a reader can see beside the other, and so the view's two settings
    /// are two profiles rather than a profile and an absence.
    Monitor,
}

impl Profile {
    /// The profile that word names, or `None` for a word naming none.
    #[must_use]
    pub fn named(word: &str) -> Option<Self> {
        match word {
            "planner" => Some(Self::Planner),
            "monitor" => Some(Self::Monitor),
            _ => None,
        }
    }

    /// The name this profile is asked for by.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planner => "planner",
            Self::Monitor => "monitor",
        }
    }

    /// The filter this profile is.
    #[must_use]
    pub fn filter(self) -> EventFilter {
        match self {
            Self::Planner => EventFilter {
                include: vec![Matcher {
                    source: Some(Source::Pipeline),
                    ..Matcher::default()
                }],
                exclude: Vec::new(),
            },
            Self::Monitor => EventFilter::default(),
        }
    }
}

/// Every built-in profile, in the order `docs/contract.md` lists them.
pub const PROFILES: [Profile; 2] = [Profile::Planner, Profile::Monitor];

/// What `?filter=` asked for, before it is resolved against a run.
///
/// Two forms because there are two kinds of reader. A browser switching between
/// the decisions-level view and detailed activity names a profile; a reader with
/// an attention nothing named yet writes the spec. Both are parsed at the trust
/// boundary — a name is a name and a spec is a spec — and neither reaches a run
/// as the raw string it arrived as.
///
/// It serializes as the one string a request sends, and parses back through
/// [`parse`](Self::parse): a query is a string, so a form that round-tripped
/// through anything else would be a second reading of the same parameter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum FilterSpec {
    /// A profile, by name. Whether it exists depends on the run: the two
    /// built-in ones exist for every run, and a run's launch config may define
    /// more.
    Named(String),
    /// A spec written out inline, already validated.
    Inline(EventFilter),
}

impl FilterSpec {
    /// Parse what a request sent, or the contract's refusal of it.
    ///
    /// A value that starts with `{` is a spec and is parsed as one — including
    /// when it is malformed, which is refused as a bad spec rather than looked
    /// up as an absurd profile name. Anything else is a name.
    ///
    /// # Errors
    ///
    /// [`ApiError::InvalidRequest`] naming what was wrong: a spec too long to
    /// parse, one that is not JSON, one carrying a field the grammar does not
    /// have, one whose matchers could match nothing, or a name that is not a
    /// usable one.
    pub fn parse(value: &str) -> Result<Self, ApiError> {
        let value = value.trim();
        if value.len() > SPEC_MAX_LEN {
            return Err(ApiError::InvalidRequest(format!(
                "filter must be at most {SPEC_MAX_LEN} characters"
            )));
        }
        if value.starts_with('{') {
            let filter: EventFilter = serde_json::from_str(value).map_err(|err| {
                ApiError::InvalidRequest(format!("filter is not a filter spec: {err}"))
            })?;
            filter
                .validate()
                .map_err(|why| ApiError::InvalidRequest(format!("filter: {why}")))?;
            return Ok(Self::Inline(filter));
        }
        if value.is_empty() {
            return Err(ApiError::InvalidRequest(
                "filter must name a profile or carry a spec".to_owned(),
            ));
        }
        if !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err(ApiError::InvalidRequest(format!(
                "filter profile must use only ASCII letters, digits, '-' and '_', got {value:?}"
            )));
        }
        Ok(Self::Named(value.to_owned()))
    }

    /// The string a request sends this spec as.
    #[must_use]
    pub fn as_query_value(&self) -> String {
        match self {
            Self::Named(name) => name.clone(),
            Self::Inline(filter) => {
                serde_json::to_string(filter).unwrap_or_else(|_| "{}".to_owned())
            }
        }
    }

    /// The filter this spec is for one run, or why that run has no such profile.
    ///
    /// # Errors
    ///
    /// [`ApiError::UnknownFilterProfile`] naming the profiles that run does
    /// have, because a reader who mistyped one cannot otherwise discover the
    /// name their run's launch defined.
    pub fn resolve(&self, launch: &LaunchProfiles) -> Result<EventFilter, ApiError> {
        match self {
            Self::Inline(filter) => Ok(filter.clone()),
            Self::Named(name) => launch.get(name),
        }
    }
}

impl TryFrom<String> for FilterSpec {
    type Error = ApiError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<FilterSpec> for String {
    fn from(spec: FilterSpec) -> Self {
        spec.as_query_value()
    }
}

/// The named profiles one run answers to: the built-in ones, plus whatever its
/// own launch config defined.
///
/// Read from the launch record's retained `--set` overrides, which is where a
/// launch's own opaque decisions are kept. A `--set` this crate cannot read as a
/// filter is **not** an error: those overrides belong to the graph launch and
/// most of them are nothing to do with this server, so one that does not parse
/// is one that was not addressed to it.
#[derive(Debug, Clone, Default)]
pub struct LaunchProfiles {
    defined: BTreeMap<String, EventFilter>,
}

impl LaunchProfiles {
    /// The profiles defined by a run's retained launch overrides.
    ///
    /// A launch-defined profile may not shadow a built-in one: `planner` and
    /// `monitor` mean the same thing for every run, which is the whole reason a
    /// reader names them instead of writing a spec.
    #[must_use]
    pub fn of(sets: &[String]) -> Self {
        let mut defined = BTreeMap::new();
        for set in sets {
            let Some((path, spec)) = set.split_once('=') else {
                continue;
            };
            let Some(name) = path.trim().strip_prefix(PROFILE_SET_PREFIX) else {
                continue;
            };
            if name.is_empty() || Profile::named(name).is_some() {
                continue;
            }
            let Ok(filter) = serde_json::from_str::<EventFilter>(spec) else {
                continue;
            };
            if filter.validate().is_ok() {
                defined.insert(name.to_owned(), filter);
            }
        }
        Self { defined }
    }

    /// The filter one name resolves to, or the refusal naming what does exist.
    ///
    /// # Errors
    ///
    /// [`ApiError::UnknownFilterProfile`] listing every name this run answers
    /// to.
    pub fn get(&self, name: &str) -> Result<EventFilter, ApiError> {
        if let Some(profile) = Profile::named(name) {
            return Ok(profile.filter());
        }
        if let Some(filter) = self.defined.get(name) {
            return Ok(filter.clone());
        }
        Err(ApiError::UnknownFilterProfile(format!(
            "{name:?} is not a filter profile of this run; it has {}",
            self.names().join(", ")
        )))
    }

    /// Every name this run answers to, built-in first and then its own.
    #[must_use]
    pub fn names(&self) -> Vec<&str> {
        PROFILES
            .iter()
            .map(|profile| profile.as_str())
            .chain(self.defined.keys().map(String::as_str))
            .collect()
    }
}
