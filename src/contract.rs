//! The wire contract: route table, response envelope, identifiers, and queries.
//!
//! Every item here is named by `docs/contract.md`. `tests/contract.rs`
//! reconciles the two, so a route added to one and not the other fails the gate.

use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;
use crate::filter::FilterSpec;

/// The API version every path under `/api/v2` and every envelope carries.
pub const API_VERSION: u32 = 2;

/// The telemetry schema version every payload is served at.
///
/// Schema-version discipline: a payload shape change bumps this, and the
/// envelope carries it on every response so a client can refuse a version it
/// does not understand rather than mis-read it. Schema 10 was the version that
/// began carrying `dispatch_id` (see [`DispatchId`]).
///
/// **Schema 11 made every unmeasured timing absent.** Under 10 each of the eight
/// `*_seconds`, the four `*_model_ms`, `idle_orchestration_ms`,
/// `unattributed_ms`, `wall_ms` and every fraction was a required number, so a
/// lane nothing measured was served `0` and read as a measurement — a run whose
/// judge chain never reported looked like one whose judge cost nothing. Under 11
/// each of them is `null` when no record measured it, which is a breaking change
/// in the only direction that matters: a client that read a number now finds a
/// null, and one that reads 11 knows the difference between free and unknown.
///
/// **Schema 12 says, per node in flight, whether its turn can be redirected.**
/// `node_control` carries one entry for every node recorded as `running` and for
/// no other — so a planner deciding between correcting a node and cancelling it
/// reads the answer instead of assuming the expensive one. Under 11 there was no
/// entry to read and the safe reading of an absent one was "cannot", which is
/// the wrong default for every node that can.
///
/// **Schema 13 is the removal of rounds.** Execution in the onepipeline SDK is
/// continuous and dependency-driven: a node dispatches the moment its
/// dependencies settle, nothing batches them, and the deprecated `round` label
/// is stamped by nothing. So the payload's `rounds` array — with its per-round
/// `round` number, per-round plan and per-round result — is replaced by one
/// [`graph`](https://github.com/nickderobertis/onepipeline-ui/blob/main/docs/contract.md)
/// object describing the run's whole continuous state, no `round` field survives
/// anywhere in a response, and `phase` names a continuous phase rather than
/// `driving-round`. A client reading 12 must not read a 13 payload: the array it
/// indexed is gone, not renamed.
///
/// **Schema 14 is the transcript a dispatch really had.** A conversation turn is
/// assembled from the settled member's stored onejudge report rather than from
/// the journal envelopes alone, which carry almost none of what a transcript is:
/// `user` is the prompt the simulated user gave and never the dispatch's persona
/// name, `assistant` is the reply that turn wrote, a tool call carries the
/// observation it returned, and `usage` and `durationMs` are what *that turn's*
/// own invocation spent and took rather than the run's total or nothing at all.
/// `startedAt` and `finishedAt` are that turn's agent-side bounds where the
/// report holds them, and both `null` where it does not — never a bound recorded
/// against the judge. The same removal fixes every recorded usage figure the
/// payload carries: the six keys this crate read a usage record by were spelled
/// the way a type nothing writes declares them, so every served cost and token
/// count was `null`. A client reading 13 sees the same fields it always did and
/// reads a persona name where a prompt now is.
///
/// **Schema 15 is what the run list stops hiding.** The payload gains two
/// optional companions to `runs` and `next_cursor` — `unreadable`, one entry per
/// run root the reader refused, carrying that root's path and the reader's own
/// reason for refusing it, and `missing`, the run ids a named selection asked
/// about and did not find — and the route gains the [`RunSelection`] those ids
/// come from. Both arrays are **absent** rather than empty when there is nothing
/// to report, and every field 14 served is served with the same meaning, so a
/// client written against 14 reads a 15 payload unchanged. The version moves
/// because a client that has never seen `unreadable` is a client reading a run
/// list that may be shorter than the host — which is exactly the silence this
/// version ends: a run the API cannot serve is now reported rather than omitted,
/// and a silent omission is indistinguishable from a server with nothing to say.
///
/// **Schema 16 is what each judge of a stacked panel decided.** A conversation
/// turn a panel judged gains `judges`, one `{judge, kind, decision, reason}` per
/// judge in the panel's order, read from the stored report's `judge_decisions` or,
/// for a session with no report, from its `judge-decided` records. It is absent
/// rather than empty on a turn nothing decided on, and every field 15 served is
/// served with the same meaning. The version moves because a client that has
/// never seen `judges` reads a stacked panel's dispatch as though no judge had
/// said anything about any turn of it.
///
/// **Schema 17 opens the `agent_role` vocabulary.** Under 16 a session's
/// `agent_role` — on a run's session links and on a conversation's attribution
/// — was one of five words this crate kept, and a member a run recorded under
/// any other name was mapped onto one of them or dropped. Under 17 it is the
/// **member name the run recorded for the session**, served exactly where one
/// of the run's own recorded graph declarations — the observer graph's or a
/// node graph's — names that member: a host's `monitor` is served as `monitor`
/// and a member named `sentinel` as `sentinel`. A session stamped with a member
/// no declaration names, or with none and a persona none names, is served no
/// `agent_role`; a conversation's attribution may therefore carry none, where
/// 16 defaulted it to `worker`. The word is held to `oneagentgraph`'s own
/// member-name grammar and to nothing narrower, and the version moves because a
/// client that switched on the closed vocabulary exhaustively misreads an open
/// one.
///
/// **Schema 18 is what a run-list row says about where a run belongs and
/// whether anything is waiting on it.** Four additive fields on every row:
/// `project`, the qualified project id the run was launched with, absent where
/// its summary recorded none; `project_name`, the plan's name as recorded,
/// absent where none was; `liveness`, the SDK's own word for how the run is
/// being driven, read through `views::liveness_of` over the bounded summary;
/// and `unread_surfaces`, the surfaces the run raised that nobody has read,
/// counted off its channel. Every field 17 served is served with
/// the same meaning and the same value; the version moves because a client
/// that has never seen `liveness` reads a run holding an unanswered question
/// as one nothing is happening to, and one that has never seen `project`
/// cannot group the list the way `onepipeline runs` does. The invalidation
/// frames of the event stream name the `project` of the run that moved beside
/// its `run_id`, on the same terms.
///
/// **Schema 19 is the agent count.** The run detail's `run` and each project
/// group gain `agent_count`: how many oneharness sessions the corresponding
/// agents route answers, read off the run's own pointer file — `0` for a run
/// with none, absent only where the file is there and could not be read.
/// Every field 18 served is served with the same meaning and the same value;
/// the version moves because a client that has never seen the field reads a
/// run a dozen agents ran under as one nothing was launched for.
pub const TELEMETRY_SCHEMA_VERSION: u32 = 19;

/// The timeline payload's own schema version, carried beside the API's.
///
/// It moves independently of [`TELEMETRY_SCHEMA_VERSION`] because it says which
/// *meaning* of the span list this is: version 1 served the role pair only on a
/// `dispatch` span, so a client could read "carries roles" as "is a dispatch".
/// Version 2 served it on a `scope=run` rollup too, naming the category the
/// rollup summarizes, and that inference no longer held.
///
/// **Version 3 serves a rollup that is not a dispatch at all.** A `rollup` span
/// may now carry no roles and stand for the waits a node's publication spent
/// blocked on a lock, named by the kind it summarizes — so under 2 a client
/// could read every rollup as a category of dispatches, and under 3 it must read
/// the label.
///
/// **Version 4 carries the redirection a record was.** A timeline event produced
/// by a `turn-interrupted` or by an `edit-committed` that added context to a node
/// carries `redirection`, which says whether the running turn took the note and
/// why it did not. Under 3 the event was served as its kind and its stamp alone,
/// so a turn whose behaviour changed mid-flight read as a worker inexplicably
/// switching tasks.
///
/// **Version 5 is continuous.** Under 4 the top of a `scope=run` timeline was one
/// span per round, every span carried the `round` it belonged to, and every span
/// id was numbered by one. There are no rounds: the run itself is the single root
/// span, no span carries a `round`, and every id is keyed by what it identifies —
/// `node.ID`, `dispatch.SESSION`, `publication.ID` — rather than by a round that
/// does not exist. Version 5 is also where a span may be **filtered**: the events
/// a span carries are the ones `?filter=` admitted, while the span itself, its
/// bounds and its status stay what the run recorded.
///
/// **Version 6 is what one lane was doing, and when.** Under 5 every `dispatch`
/// span of a node carried the node's own bounds and every `rollup` the node's
/// dispatch and settlement, so a node dispatched three times served three spans
/// over one identical interval and a drafting turn that took a minute was drawn
/// across the four hours of work it drafted for. Each is now bounded by the
/// attempt that ran it: every session of an attempt opens at that attempt's
/// `node-dispatched`, and each closes at the earliest of the next dispatch, the
/// settlement, the `session-closed` and the session's own end. A `publication`
/// opens where publication work begins rather than where the dispatch's worktree
/// was cut — under 5 it began at the worktree and a node that never published
/// was drawn publishing for its whole life — and the worktree going away closes
/// it, behind a merge, a conflict or an opened change. And a span's `agent_role`
/// is read from the `member` the run recorded for the session rather than from
/// its persona, so a session dispatched under a persona a host invented is
/// served in its own category rather than dropped from the reading. No span kind
/// and no role word moved: `member` `monitor` is served as the `orchestrator` it
/// already shares a lane with.
///
/// **Schema 7 carries the release a record was about.** An event produced by one
/// of the six release kinds — `release-probed`, `release-acknowledged`,
/// `release-observed`, `release-wait`, `release-arrived` and `release-adopted` —
/// carries `release`, which is that record's own fields and nothing defaulted:
/// the identity, target, style and version where it named them, the awaiting
/// entries a wait was held on, and the versions an adoption wrote. Additive and
/// optional exactly as `redirection` was in 4 — every other event is byte-for-byte
/// what 6 served — but a client that reads a `release-wait` and finds no `release`
/// on it can only draw four different waits as one word, which is the reading this
/// version exists to have fixed. A node held on a **person** is the one a reader
/// has to be able to pick out, and it is picked out by the `action` that entry
/// carries and no automated entry does.
/// **Schema 8 draws what a ready node was waiting for.** Under 7 the interval
/// between a node becoming ready and its dispatch was empty — which reads as the
/// harness having done nothing, when what really happened is that the node was
/// queued behind the operator's own other work. A node the engine recorded a hold
/// for now serves a **`queued`** span per hold, carrying `reasons`: one entry per
/// thing holding it at that moment, each naming its `kind` and that kind's own
/// fields. Because the engine writes a hold on transition only, a node behind
/// three running nodes serves three successive spans naming three shrinking sets,
/// ending where the hold cleared and the dispatch followed. Additive exactly as
/// `release` was in 7 — every other span and every event is byte-for-byte what 7
/// served — and a run recorded before the engine wrote any of this serves no
/// `queued` span at all, because a span drawn from a guess cannot be told from one
/// the run recorded.
///
/// **Schema 9 carries what a surface said.** An event produced by a
/// `planner-surface-queued` or a `planner-surfaced` carries **`surface`** —
/// `{kind?, message?, source?, blocking?}` — each present exactly where the
/// record carried it, on the discipline `release` keeps. Under 8 a surface was
/// its kind and its stamp alone, so a reader could see that something was raised
/// and not what, by whom, or whether anything waited on the answer. The `kind`
/// and the `source` are **open** words served as recorded: the engine relays any
/// well-formed surface kind a host defines and any author its bus configuration
/// declared, and the one closed list this build refuses to keep is a list of
/// them. Additive exactly as `release` was in 7 — every other span and every
/// event is byte-for-byte what 8 served.
///
/// **Schema 10 opens the `agent_role` vocabulary, as telemetry schema 17 does
/// for the same field elsewhere.** Under 9 a `dispatch` or `rollup` span's
/// `agent_role` was one of five words this crate kept, and the observer's
/// `monitor` member was served as `orchestrator`. Under 10 it is the member
/// name the run recorded for the session, served where the run's own recorded
/// graph declarations name that member — so the lanes a client draws are the
/// run's members under the run's own words, one per distinct role a payload
/// serves, in the order it serves them. A session stamped with a member no
/// declaration names, or with none and a persona none names, carries no
/// `agent_role`. The `run` span the engine's own driving is drawn under keeps
/// its kind and its label: it is the engine's lane, not a member's. The word
/// is held to `oneagentgraph`'s member-name grammar and to nothing narrower.
pub const TIMELINE_SCHEMA_VERSION: u32 = 10;

/// The largest run-list page any request can ask for.
///
/// A bound rather than a limit anyone will meet: it exists so a crafted `limit`
/// cannot turn one request into an unbounded read of every recorded run.
pub const RUNS_PAGE_LIMIT: usize = 50;

/// The routes `docs/contract.md` defines, as axum path templates.
pub mod routes {
    /// Liveness that never touches run storage.
    pub const HEALTHZ: &str = "/healthz";
    /// The run list, with session attribution.
    pub const RUNS: &str = "/api/v2/runs";
    /// One run's detail.
    pub const RUN: &str = "/api/v2/runs/{run}";
    /// One run's timeline, at run or node scope.
    pub const RUN_TIMELINE: &str = "/api/v2/runs/{run}/timeline";
    /// One conversation of one run.
    pub const RUN_CONVERSATION: &str = "/api/v2/runs/{run}/conversations/{id}";
    /// One recorded artifact of one run.
    pub const RUN_ARTIFACT: &str = "/api/v2/runs/{run}/artifacts/{id}";
    /// The server-sent event stream; every connection opens with a fresh snapshot.
    pub const EVENTS: &str = "/api/v2/events";
    /// The runs grouped by project, as `verbs::runs` groups them.
    pub const PROJECTS: &str = "/api/v2/projects";
    /// One project's group.
    pub const PROJECT: &str = "/api/v2/projects/{project}";
    /// The run's channel as it stands: `verbs::channel`.
    pub const RUN_CHANNEL: &str = "/api/v2/runs/{run}/channel";
    /// Claim the next surface: `verbs::next`.
    pub const RUN_CHANNEL_NEXT: &str = "/api/v2/runs/{run}/channel/next";
    /// Submit an envelope, byte for byte: `verbs::reply`.
    pub const RUN_CHANNEL_REPLY: &str = "/api/v2/runs/{run}/channel/reply";
    /// Raise a surface to the planner: `verbs::surface`.
    pub const RUN_CHANNEL_SURFACE: &str = "/api/v2/runs/{run}/channel/surface";
    /// Complete a ready human action: `verbs::attest`.
    pub const RUN_ATTEST: &str = "/api/v2/runs/{run}/attest";
    /// End the run and its dispatch tree: `verbs::stop`.
    pub const RUN_STOP: &str = "/api/v2/runs/{run}/stop";
    /// Retain this binary as a fresh driver: `verbs::adopt`.
    pub const RUN_ADOPT: &str = "/api/v2/runs/{run}/adopt";
    /// Shut one run down, gently: `verbs::shutdown` at run scope.
    pub const RUN_SHUTDOWN: &str = "/api/v2/runs/{run}/shutdown";
    /// Shut down every run this session owns, or the whole host:
    /// `verbs::shutdown` at `mine` or `host` scope.
    pub const SHUTDOWN: &str = "/api/v2/shutdown";
    /// A watch on the run as a server-sent event stream: `verbs::watch`.
    pub const RUN_WATCH: &str = "/api/v2/runs/{run}/watch";
    /// Which of the acting session's runs nothing is watching: `verbs::unwatched`.
    pub const UNWATCHED: &str = "/api/v2/unwatched";
    /// Every live dispatch on this host: `verbs::host`.
    pub const HOST: &str = "/api/v2/host";
    /// One run's folded standing: `verbs::status`.
    pub const RUN_STATUS: &str = "/api/v2/runs/{run}/status";
    /// Per-node outcomes with their evidence: `verbs::results`.
    pub const RUN_RESULTS: &str = "/api/v2/runs/{run}/results";
    /// What every run is for: `verbs::goals` given no run.
    pub const GOALS: &str = "/api/v2/goals";
    /// What one run is for: `verbs::goals` given one.
    pub const RUN_GOALS: &str = "/api/v2/runs/{run}/goals";
    /// A dispatched turn's tools and reasoning: `verbs::transcript`.
    pub const RUN_TRANSCRIPT: &str = "/api/v2/runs/{run}/transcript";
    /// The run's timing and usage document: `verbs::telemetry`.
    pub const RUN_TELEMETRY: &str = "/api/v2/runs/{run}/telemetry";
    /// Every oneharness session the run's launches wrote: `verbs::agents`.
    pub const RUN_AGENTS: &str = "/api/v2/runs/{run}/agents";
    /// The sessions one node's dispatches wrote: `verbs::agents` at node scope.
    pub const RUN_NODE_AGENTS: &str = "/api/v2/runs/{run}/nodes/{node}/agents";
    /// The union over a project's runs: `verbs::project_agents`.
    pub const PROJECT_AGENTS: &str = "/api/v2/projects/{project}/agents";

    /// The HTTP method a route answers.
    ///
    /// Two, and only two: a read is a `GET`, and a verb that writes to the run —
    /// claims a surface, submits an envelope, stops, adopts or shuts down — is a
    /// `POST`, so
    /// nothing a browser prefetches or a proxy retries can act on a run.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Method {
        /// A read.
        Get,
        /// A write to the run.
        Post,
    }

    impl Method {
        /// The method as `docs/contract.md` spells it before the path.
        #[must_use]
        pub const fn as_str(self) -> &'static str {
            match self {
                Self::Get => "GET",
                Self::Post => "POST",
            }
        }
    }

    /// One route: the method it answers and its path template.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Route {
        /// The method.
        pub method: Method,
        /// The path template, as axum reads it and as the contract writes it.
        pub path: &'static str,
    }

    const fn get(path: &'static str) -> Route {
        Route {
            method: Method::Get,
            path,
        }
    }

    const fn post(path: &'static str) -> Route {
        Route {
            method: Method::Post,
            path,
        }
    }

    /// How many routes the contract defines.
    pub const COUNT: usize = 30;

    /// Every route above with its method, in the order `docs/contract.md`
    /// lists them.
    pub const TABLE: [Route; COUNT] = [
        get(HEALTHZ),
        get(RUNS),
        get(RUN),
        get(RUN_TIMELINE),
        get(RUN_CONVERSATION),
        get(RUN_ARTIFACT),
        get(EVENTS),
        get(PROJECTS),
        get(PROJECT),
        get(RUN_CHANNEL),
        post(RUN_CHANNEL_NEXT),
        post(RUN_CHANNEL_REPLY),
        post(RUN_CHANNEL_SURFACE),
        post(RUN_ATTEST),
        post(RUN_STOP),
        post(RUN_ADOPT),
        post(RUN_SHUTDOWN),
        post(SHUTDOWN),
        get(RUN_WATCH),
        get(UNWATCHED),
        get(HOST),
        get(RUN_STATUS),
        get(RUN_RESULTS),
        get(GOALS),
        get(RUN_GOALS),
        get(RUN_TRANSCRIPT),
        get(RUN_TELEMETRY),
        get(RUN_AGENTS),
        get(RUN_NODE_AGENTS),
        get(PROJECT_AGENTS),
    ];

    /// Every route's path, in the same order — read off [`TABLE`] rather than
    /// listed twice.
    pub const ALL: [&str; COUNT] = {
        let mut all = [""; COUNT];
        let mut index = 0;
        while index < COUNT {
            all[index] = TABLE[index].path;
            index += 1;
        }
        all
    };
}

/// The response body of `GET /healthz`.
///
/// Deliberately not an [`Envelope`]: liveness must answer without reading run
/// storage, so it carries no schema version to read one from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    /// The one state a served `/healthz` can be in.
    pub status: HealthStatus,
    /// The `onepipeline` release this binary links, from that crate's own
    /// `VERSION` and never from a literal here.
    ///
    /// A host that pins the engine writing a run store and separately pins this
    /// reader of it has nothing else to prove the two are the same release, so
    /// the reader says which one it is rather than leaving it assumed.
    pub onepipeline_version: Release,
}

/// A validated release identifier: `MAJOR.MINOR.PATCH`, with the pre-release and
/// build metadata cargo allows after it.
///
/// Constructed only through [`TryFrom<&str>`], so a `Health` a client parses
/// cannot carry a release nobody could have published — the comparison a host
/// makes against it is only worth making if both sides are releases.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Release(String);

impl Release {
    /// The `onepipeline` release this binary links.
    ///
    /// The SDK's own package version, which cargo will not build without, so the
    /// check cannot fail — the same footing [`POLL_INTERVAL_MS`] is on.
    ///
    /// [`POLL_INTERVAL_MS`]: crate::store::POLL_INTERVAL_MS
    #[must_use]
    pub fn linked() -> Self {
        Self::try_from(onepipeline::VERSION).expect("the SDK's own package version is a release")
    }

    /// The release as it is served.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for Release {
    type Error = InvalidRelease;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match check_release(value) {
            Ok(()) => Ok(Self(value.to_owned())),
            Err(reason) => Err(InvalidRelease(reason)),
        }
    }
}

impl TryFrom<String> for Release {
    type Error = InvalidRelease;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_from(value.as_str())
    }
}

impl From<Release> for String {
    fn from(value: Release) -> Self {
        value.0
    }
}

/// What a string that is not a [`Release`] is refused with.
///
/// Its own type rather than an [`ApiError`] arm: no route parses one, so a
/// refusal here is not a status a client is served.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("not a release: {0}")]
pub struct InvalidRelease(String);

/// The longest release identifier this crate accepts.
const RELEASE_MAX_LEN: usize = 64;

/// Whether a string is a release, by the semantic-version grammar cargo
/// publishes under: `MAJOR.MINOR.PATCH`, each a number without a leading zero,
/// then optional `-PRE` and `+BUILD` metadata of dot-separated identifiers.
///
/// Strict rather than permissive on purpose. The point of the type is that a
/// host comparing two of these is comparing releases, and a validator that
/// admitted `01.2.3` would have this crate assert an invariant its name claims
/// and its values do not keep.
fn check_release(value: &str) -> Result<(), String> {
    if value.len() > RELEASE_MAX_LEN {
        return Err(format!("must be at most {RELEASE_MAX_LEN} characters"));
    }
    // Build metadata comes off first: it is the last part and it may itself
    // contain `-`, so a pre-release cannot be found until it is gone.
    let (rest, build) = match value.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (value, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let components: Vec<&str> = core.split('.').collect();
    if components.len() != 3 {
        return Err("must be MAJOR.MINOR.PATCH".to_owned());
    }
    // Bounded to what cargo's own version components are, not merely to digits:
    // a number no registry could have published is a release nobody could be
    // running, and it must be refused at the parse rather than carried.
    if !components
        .iter()
        .copied()
        .all(|component| is_numeric_identifier(component) && component.parse::<u64>().is_ok())
    {
        return Err(
            "every component of MAJOR.MINOR.PATCH must be a number without a leading zero, \
             within the range cargo publishes"
                .to_owned(),
        );
    }
    if let Some(pre) = pre {
        for identifier in pre.split('.') {
            if !is_alphanumeric_identifier(identifier) {
                return Err(
                    "every pre-release identifier must be ASCII letters, digits or '-'".to_owned(),
                );
            }
            if identifier.chars().all(|c| c.is_ascii_digit()) && !is_numeric_identifier(identifier)
            {
                return Err(
                    "a numeric pre-release identifier must not have a leading zero".to_owned(),
                );
            }
        }
    }
    if let Some(build) = build {
        for identifier in build.split('.') {
            if !is_alphanumeric_identifier(identifier) {
                return Err(
                    "every build identifier must be ASCII letters, digits or '-'".to_owned(),
                );
            }
        }
    }
    Ok(())
}

/// A semantic-version numeric identifier: digits, and no leading zero unless the
/// whole of it is one.
fn is_numeric_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| c.is_ascii_digit())
        && (value.len() == 1 || !value.starts_with('0'))
}

/// A semantic-version metadata identifier: non-empty, ASCII letters, digits and
/// `-`. A second `+` fails here, which is what keeps `1.2.3+one+two` out.
fn is_alphanumeric_identifier(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The only status `/healthz` reports: a process that could not answer serves
/// nothing at all, so "not ok" is unrepresentable rather than unhandled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    /// The process is serving.
    Ok,
}

/// A successful response: the schema-version preamble plus the payload.
///
/// The payload is flattened, so `{"api_version": 2, ..., "runs": [...]}` is one
/// object rather than a nested envelope — the shape the existing v2 clients
/// already read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    /// The major API version, always [`API_VERSION`] when this crate serves it.
    // llmlint: ignore-block[invalid_states_unrepresentable] this type parses as well as serves, and a version it does not know must survive being read to be named in the refusal.
    pub api_version: u32,
    /// The payload's telemetry schema version, always [`TELEMETRY_SCHEMA_VERSION`]
    /// when this crate serves it.
    pub telemetry_schema_version: u32,
    // llmlint: ignore-end[invalid_states_unrepresentable]
    /// When the server read the state this payload describes, as RFC 3339.
    // llmlint: ignore[invalid_states_unrepresentable] a date-time type re-renders the instant, and the fixtures pin this envelope byte for byte.
    pub observed_at: String,
    /// The endpoint's own payload, sourced from the onepipeline SDK.
    #[serde(flatten)]
    pub payload: T,
}

/// A failed response. Every route serves this shape on every non-2xx status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    /// The machine-readable code and the human-readable message.
    pub error: ErrorBody,
}

/// The body of an [`ErrorEnvelope`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    /// A stable code a client can branch on, e.g. `run_not_found`.
    // llmlint: ignore[invalid_states_unrepresentable] [`ApiError`] is the enum tying a code to its status; this is the wire form, where a code a newer server introduced must survive parsing.
    pub code: String,
    /// A message safe to show a user: never a path or record contents.
    pub message: String,
}

/// The closed `event:` vocabulary `GET /api/v2/events` names its frames with.
///
/// Closed because a client dispatches on it: an event name it does not know is
/// a frame it silently drops, so a name added here has to be added there too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SseEvent {
    /// The run list, as it stands right now. The first frame of every
    /// connection, so a reconnecting client never sits on state it missed.
    #[serde(rename = "snapshot")]
    Snapshot,
    /// One run's recorded state moved; the client refetches its detail.
    #[serde(rename = "run.changed")]
    RunChanged,
    /// One watched run's transcripts moved.
    #[serde(rename = "conversation.changed")]
    ConversationChanged,
    /// A watched run reported from *inside* a turn: `oneagentgraph` publishes a
    /// bounded tool summary as the turn runs rather than when it is done, so
    /// there is something in flight to say.
    #[serde(rename = "activity.changed")]
    ActivityChanged,
    /// A run left the runs root; the client stops polling it.
    #[serde(rename = "run.removed")]
    RunRemoved,
}

impl SseEvent {
    /// The name this event is written as in an SSE `event:` line.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::RunChanged => "run.changed",
            Self::ConversationChanged => "conversation.changed",
            Self::ActivityChanged => "activity.changed",
            Self::RunRemoved => "run.removed",
        }
    }
}

/// One frame of `GET /api/v2/events`.
///
/// The first frame of every connection is a fresh snapshot, so a client that
/// reconnects never has to reconcile against state it missed. `data` is a bare
/// [`Value`] because only the snapshot carries an [`Envelope`]: an invalidation
/// names the run that moved and nothing else, so the client refetches rather
/// than reconciling a second copy of the state model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    /// The server-issued cursor, monotonically increasing from zero within a
    /// connection; a client resumes with it as `Last-Event-ID`.
    pub id: u64,
    /// Which kind of frame this is.
    pub event: SseEvent,
    /// The frame's payload.
    pub data: Value,
}

/// The three frames `GET /api/v2/runs/{run}/watch` streams, named as the SSE
/// `event:` line names them.
///
/// One per variant of the SDK's own `WatchFrame`: a meaningful event, a
/// heartbeat, and the ending that closes the stream. The data beside each is
/// the machine record `onepipeline watch` prints for that frame, rendered by
/// the SDK, so a client of this stream and a script reading that verb read one
/// shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchEvent {
    /// One meaningful event of the run.
    Event,
    /// Nothing happened for a whole tick, and the watch is still there.
    Tick,
    /// The wait is over, and this says why; the stream closes after it.
    Returned,
}

impl WatchEvent {
    /// The name this frame is written as in an SSE `event:` line.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Tick => "tick",
            Self::Returned => "returned",
        }
    }
}

/// One frame of `GET /api/v2/runs/{run}/watch`.
///
/// `data` is the machine record the SDK renders for the frame — a bare
/// [`Value`], because the record's shape is the engine's own and this crate
/// projects it rather than restating it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchFrame {
    /// The server-issued cursor within the connection, from zero.
    pub id: u64,
    /// Which kind of frame this is.
    pub event: WatchEvent,
    /// The engine's own record for it.
    pub data: Value,
}

/// The query of `GET /api/v2/runs/{run}/watch`: the shape of the wait, as the
/// CLI's own flags take it.
///
/// Every field is the SDK's own type where the SDK declares one — a condition
/// and a timeout are parsed by the engine's parsers, so a spelling the CLI
/// refuses is refused here in the same words — and the filter is this crate's,
/// resolved against the run being watched.
#[derive(Debug, Clone, PartialEq)]
pub struct WatchQuery {
    /// What ends the wait, beside the run finishing and nothing driving it.
    pub until: Vec<onepipeline::cli::WatchUntil>,
    /// How long to wait before giving up.
    pub timeout: onepipeline::cli::WatchTimeout,
    /// How long a silence may last before the stream says it is still there;
    /// zero turns the heartbeat off.
    pub tick: std::time::Duration,
    /// Which events are reported.
    pub filter: Option<FilterSpec>,
    /// The cursor an earlier watch returned, to resume from. Placed against the
    /// run by the engine, which is the one reading that decides it.
    // llmlint: ignore[invalid_states_unrepresentable] the token is external input the engine's `WatchRequest` takes as a `String` for the reason the engine states on that field: whether it is a cursor is decided by placing it against *this run's journal*, which only the engine's own read can do, and a type here that claimed it without that read would be a second reading of a token whose one reading is the engine's. The boundary this crate keeps is the bound and the character set in `server::watch_query`.
    pub cursor: Option<String>,
}

impl Default for WatchQuery {
    fn default() -> Self {
        Self {
            until: vec![onepipeline::cli::WatchUntil::default()],
            timeout: onepipeline::cli::WatchTimeout::Bounded(
                onepipeline::cli::DEFAULT_WATCH_TIMEOUT_SECONDS,
            ),
            tick: std::time::Duration::from_secs(onepipeline::cli::DEFAULT_WATCH_TICK_SECONDS),
            filter: None,
            cursor: None,
        }
    }
}

/// The query of `POST /api/v2/runs/{run}/channel/next`: the profile the
/// answered events are shaped through.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NextQuery {
    /// The profile or spec, resolved against the run. `None` shapes nothing,
    /// which is every event the run holds.
    pub filter: Option<FilterSpec>,
}

/// The query of `GET /api/v2/runs/{run}/transcript`: the one node asked for.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TranscriptQuery {
    /// The node, or every node with a record.
    pub node: Option<NodeId>,
}

/// The body of `POST /api/v2/runs/{run}/channel/surface`.
///
/// The kind is the engine's own validated type, so a word its grammar refuses
/// — `^[a-z][a-z0-9-]{0,63}$` — is refused while the body is read rather than
/// carried to the channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceRequest {
    /// What the surface is about.
    pub kind: onepipeline::channel::SurfaceKind,
    /// What it has to say. Blank once trimmed is the engine's refusal.
    // llmlint: ignore[invalid_states_unrepresentable] the engine's `verbs::surface` takes the message as a `String`, trims it and refuses one with nothing in it in its own words — the refusal `docs/contract.md` promises this route serves verbatim. A type here that refused blank first would be a second statement of the engine's rule, with this crate's words in place of the engine's.
    pub message: String,
}

/// The body of `POST /api/v2/runs/{run}/attest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestRequest {
    /// The reference of the ready human action, as the run's decision names it.
    // llmlint: ignore[invalid_states_unrepresentable] whether a reference names a ready human action is decided against the run's own decisions by the engine's `verbs::attest`, which refuses one nothing is waiting on in its own words; the only reading of a reference is that one, and a type here could hold it to nothing the engine does not already rule on.
    pub reference: String,
}

/// The body of `POST /api/v2/runs/{run}/stop`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopRequest {
    /// Stop a run another session owns, naming the owner. Omitted, `false`.
    #[serde(default)]
    pub force: bool,
}

/// The body of `POST /api/v2/runs/{run}/shutdown`.
///
/// Empty or absent is the default shutdown — the engine's own default grace,
/// nothing forced — exactly as an empty body on `stop` is a stop that forces
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunShutdownRequest {
    /// How long, in integer seconds, a dispatch has to end itself after it is
    /// asked. Omitted, the engine's own default; `0` is the engine's force path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grace: Option<u64>,
    /// Skip the interrupt and the wait and go straight to the teardown.
    /// Omitted, `false`.
    #[serde(default)]
    pub force: bool,
}

/// Which runs `POST /api/v2/shutdown` acts on.
///
/// The engine's two scopes that name no one run. One run is the run route's,
/// so a body cannot name a run here and a path there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShutdownScope {
    /// Every run the acting session owns, as `runs --mine` selects them.
    Mine,
    /// Every run under the runs root, whoever owns it.
    Host,
}

/// The body of `POST /api/v2/shutdown`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShutdownRequest {
    /// Which runs. Required: a shutdown that named none is refused before
    /// anything is signalled, as the engine's own verb refuses one.
    pub scope: ShutdownScope,
    /// As [`RunShutdownRequest::grace`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grace: Option<u64>,
    /// As [`RunShutdownRequest::force`].
    #[serde(default)]
    pub force: bool,
}

/// The correlation a channel reply is answered under, as
/// `POST /api/v2/runs/{run}/channel/reply?correlation=C` names it.
///
/// The bus's own token, parsed by the bus's own parser: this wraps
/// [`onemessagebus::Correlation`] so the query crosses the same boundary the
/// CLI's `--correlation` crosses, and never a second copy of that grammar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Correlation(onemessagebus::Correlation);

impl Correlation {
    /// The token, as the engine is handed it.
    #[must_use]
    pub fn inner(&self) -> &onemessagebus::Correlation {
        &self.0
    }
}

impl TryFrom<&str> for Correlation {
    type Error = ApiError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        value
            .parse::<onemessagebus::Correlation>()
            .map(Self)
            .map_err(|refused| ApiError::InvalidCorrelation(refused.to_string()))
    }
}

impl fmt::Display for Correlation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// A validated qualified project id: `<source>:<native>`.
///
/// The source is one of onetaskgraph's, under [`SOURCE_GRAMMAR`](Self::SOURCE_GRAMMAR),
/// and the native id is a non-empty bare token carrying no separator — the
/// same characters a run id may. Constructed only through [`TryFrom<&str>`], on
/// the same terms every other `{...}` a route interpolates is: the wire carries
/// it path-encoded, the router decodes it, and this is what the decoded segment
/// has to be before it is compared against any group.
///
/// The grammar is quoted from `docs/contract.md`, which quotes it from the
/// decision that fixed this route — onetaskgraph is no dependency of this
/// crate, and the engine reaches it by subprocess — so the contract text is the
/// one source, and `tests/contract.rs` holds this copy to it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProjectId(String);

impl ProjectId {
    /// The separator between the source and the native id.
    pub const SEPARATOR: char = ':';

    /// The grammar a source name is held to, as the contract spells it.
    pub const SOURCE_GRAMMAR: &'static str = "^[a-z0-9][a-z0-9-]*$";

    /// The id as the engine records it on a launch and a summary.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for ProjectId {
    type Error = ApiError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        let Some((source, native)) = value.split_once(Self::SEPARATOR) else {
            return Err(ApiError::InvalidProjectId(
                "must be <source>:<native>".to_owned(),
            ));
        };
        let source_ok = source
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
            && source
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !source_ok {
            return Err(ApiError::InvalidProjectId(format!(
                "the source must match {}",
                Self::SOURCE_GRAMMAR
            )));
        }
        if native.contains(Self::SEPARATOR) {
            return Err(ApiError::InvalidProjectId(
                "the native id must not carry a second ':'".to_owned(),
            ));
        }
        check_identifier(native)
            .map_err(|reason| ApiError::InvalidProjectId(format!("the native id {reason}")))?;
        Ok(Self(value.to_owned()))
    }
}

impl TryFrom<String> for ProjectId {
    type Error = ApiError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_from(value.as_str())
    }
}

impl From<ProjectId> for String {
    fn from(value: ProjectId) -> Self {
        value.0
    }
}

impl fmt::Display for ProjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The query of `GET /api/v2/runs`.
///
/// `docs/contract.md` names no query on this route. These three are the paging
/// and filtering surface the copied frontend already reads, kept here so the
/// server's answer is bounded whatever a caller asks for; see AGENTS.md for the
/// amendment they are proposed under.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RunsQuery {
    /// A page of the whole list, in the order most recent activity leads.
    Page(RunsPage),
    /// The runs this request **named**, and no others.
    ///
    /// A variant rather than a field beside the paging, because the two are
    /// answers to different questions and each one's fields mean nothing to the
    /// other: a selection answers exactly the runs named, with no cursor and no
    /// settled filter. Carried together they would be a request whose halves
    /// disagree about what was asked, and something would have to decide which
    /// half won — silently, on every request that sent both.
    Selected(RunSelection),
}

impl Default for RunsQuery {
    fn default() -> Self {
        Self::Page(RunsPage::default())
    }
}

impl RunsQuery {
    /// The page this query asks for, or `None` when it names runs instead.
    #[must_use]
    pub fn paging(&self) -> Option<&RunsPage> {
        match self {
            Self::Page(page) => Some(page),
            Self::Selected(_) => None,
        }
    }

    /// The runs this query named, or `None` when it asks for a page.
    #[must_use]
    pub fn selection(&self) -> Option<&RunSelection> {
        match self {
            Self::Selected(selection) => Some(selection),
            Self::Page(_) => None,
        }
    }
}

/// Which page of the run list to serve.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RunsPage {
    /// Whether to list runs whose graph has completed. Off by default: the list
    /// is a supervision surface, and finished work is not what needs attention.
    #[serde(default)]
    pub include_settled: bool,
    /// How many rows to serve.
    #[serde(default)]
    pub limit: PageLimit,
    /// The `next_cursor` of the previous page; the list resumes after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<RunId>,
}

impl RunsPage {
    /// The page size this query actually gets: never zero, never unbounded.
    #[must_use]
    pub fn size(&self) -> usize {
        self.limit.get()
    }
}

/// A named-run selection: which runs `GET /api/v2/runs` answers about, rather
/// than which page of them.
///
/// On the **existing** route rather than a new one, because the ordering rule a
/// row is served in has to live in one place — a second route would be a second
/// copy of it to drift. It answers the same row shape in the same order.
///
/// **Comma-separated, with no escaping rule.** A run id on this wire is already
/// validated as a bare name — ASCII letters, digits, `-`, `_` and `.` — so a
/// comma cannot occur inside one and there is nothing to escape.
///
/// Bounded by [`RUNS_PAGE_LIMIT`], the same maximum a page is clamped to, and a
/// larger selection is **refused** rather than truncated: a caller that named
/// sixty runs and was served fifty has no way to tell which ten it did not
/// learn about, where a refusal says so.
///
/// Repeats are dropped, first mention winning, so a selection answers one row
/// per run named. The bound is checked against what was *asked for* rather than
/// against what survives that: sixty names is a request for sixty runs however
/// many of them are the same one.
///
/// Constructed only through [`RunSelection::parse`] or [`TryFrom<Vec<RunId>>`],
/// so a selection this server would not serve cannot be built and then read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<RunId>", into = "Vec<RunId>")]
pub struct RunSelection(Vec<RunId>);

impl RunSelection {
    /// What separates two run ids in the query string.
    pub const SEPARATOR: char = ',';

    /// The selection `?select=` names, or the contract's refusal of what was
    /// sent.
    ///
    /// # Errors
    ///
    /// [`ApiError::InvalidRunId`] for a name that is not a usable run id, and
    /// [`ApiError::InvalidRequest`] for a selection naming nothing at all or
    /// more runs than a page serves.
    pub fn parse(raw: &str) -> Result<Self, ApiError> {
        // `?select=` with nothing after it is a caller asking about no runs, not
        // a caller naming a run whose id happens to be empty — and the two are
        // told apart here, because the second reading answers "invalid run id:
        // must not be empty" to somebody who wrote no id at all.
        if raw.is_empty() {
            return Err(Self::names_nothing());
        }
        let named: Vec<RunId> = raw
            .split(Self::SEPARATOR)
            .map(RunId::try_from)
            .collect::<Result<_, _>>()?;
        Self::try_from(named)
    }

    /// The refusal a selection naming no run at all is answered with.
    ///
    /// One wording for the two ways in — the query string, and a deserialized
    /// [`RunsQuery`] — because a caller has no way to tell which of them it
    /// crossed.
    fn names_nothing() -> ApiError {
        ApiError::InvalidRequest("select names no run; leave it off to list every run".to_owned())
    }

    /// The runs named, in the order they were named, each once.
    #[must_use]
    pub fn named(&self) -> &[RunId] {
        &self.0
    }
}

impl TryFrom<Vec<RunId>> for RunSelection {
    type Error = ApiError;

    fn try_from(named: Vec<RunId>) -> Result<Self, Self::Error> {
        if named.is_empty() {
            return Err(Self::names_nothing());
        }
        if named.len() > RUNS_PAGE_LIMIT {
            return Err(ApiError::InvalidRequest(format!(
                "select names {} runs, and this route serves at most {RUNS_PAGE_LIMIT}",
                named.len()
            )));
        }
        let mut once: Vec<RunId> = Vec::with_capacity(named.len());
        for run in named {
            if !once.contains(&run) {
                once.push(run);
            }
        }
        Ok(Self(once))
    }
}

impl From<RunSelection> for Vec<RunId> {
    fn from(selection: RunSelection) -> Self {
        selection.0
    }
}

/// A run-list page size: never zero, never more than [`RUNS_PAGE_LIMIT`].
///
/// A bare `usize` would let a query carry a page size the server never serves,
/// leaving whoever reads `limit` next as the only thing between a caller and an
/// unbounded read. Constructed only by clamping, so the bound is the type's and
/// an out-of-range `?limit=` is still answered with a page rather than refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "usize", into = "usize")]
pub struct PageLimit(usize);

impl PageLimit {
    /// The page size a caller asking for `requested` rows actually gets.
    #[must_use]
    pub fn clamping(requested: usize) -> Self {
        Self(requested.clamp(1, RUNS_PAGE_LIMIT))
    }

    /// How many rows this page serves.
    #[must_use]
    pub fn get(self) -> usize {
        self.0
    }
}

impl Default for PageLimit {
    fn default() -> Self {
        Self(RUNS_PAGE_LIMIT)
    }
}

impl From<usize> for PageLimit {
    fn from(requested: usize) -> Self {
        Self::clamping(requested)
    }
}

impl From<PageLimit> for usize {
    fn from(limit: PageLimit) -> Self {
        limit.0
    }
}

/// The query of `GET /api/v2/events`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct EventsQuery {
    /// Watch one run rather than the whole root. Only a watched run's
    /// transcripts are polled — each poll is a separate read, affordable for one
    /// detail view and not for every run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    /// Continue the cursor sequence from a frame this process already issued.
    ///
    /// It only continues the numbering: the connection still opens with a fresh
    /// snapshot, because no event history is retained to replay from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    /// Which events this connection is watching for; see [`FilterSpec`].
    ///
    /// The stream *invalidates* rather than restating state, so a filter here
    /// decides which movements are worth announcing: a run whose only new
    /// records the filter excludes has not moved as far as this connection is
    /// concerned, and its subscriber is not woken to refetch a detail that would
    /// come back unchanged. What the connection then refetches is filtered by
    /// the same spec on the detail route, which is what keeps the two agreeing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
}

/// The query of `GET /api/v2/runs/{run}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunQuery {
    /// Whether to serve the run's transcripts.
    ///
    /// Defaults to `true`. Opting out is a size lever, not a schema change: the
    /// `conversations` field stays present and required, just empty, for a
    /// client that reads the timeline instead of refetching every transcript.
    #[serde(default = "yes")]
    pub include_conversations: bool,
    /// Which events this reading carries; see [`FilterSpec`].
    ///
    /// It shapes the response and never the run: the node statuses, settlements
    /// and counts a detail carries are folded from the whole journal whatever
    /// this says, and what it narrows is the records served beside them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
}

fn yes() -> bool {
    true
}

/// The query of `GET /api/v2/runs/{run}/timeline`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineQuery {
    /// Which items to serve.
    #[serde(flatten)]
    pub scope: TimelineScope,
    /// Which events the served spans carry; see [`FilterSpec`].
    ///
    /// A span's own bounds and status are what the run recorded and are never
    /// narrowed — a filter that could hide a node from its own timeline would be
    /// a reader's attention deciding what the run did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
}

/// What a timeline request is scoped to.
///
/// `scope` selects the variant and `node` belongs to exactly one of them, so
/// `scope=node` with no node — and `scope=run` with one — are both
/// unrepresentable rather than validated after the fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum TimelineScope {
    /// `?scope=run` — the run's own items.
    Run,
    /// `?scope=node&node=ID` — one node's items.
    Node {
        /// The node whose timeline to serve.
        node: NodeId,
    },
}

/// Declare a validated identifier newtype: the path- and query-segment trust
/// boundary every route's `{...}` placeholder crosses.
macro_rules! identifier {
    ($name:ident, $what:literal, $invalid:ident) => {
        #[doc = concat!("A validated ", $what, ".")]
        ///
        /// Constructed only through [`TryFrom<&str>`], which rejects anything
        /// that is not a bare path segment — so an identifier can never carry a
        /// separator or a traversal into whatever storage the server reads.
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// The identifier as it appears in the URL.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<&str> for $name {
            type Error = ApiError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                match check_identifier(value) {
                    Ok(()) => Ok(Self(value.to_owned())),
                    Err(reason) => Err(ApiError::$invalid(reason)),
                }
            }
        }

        impl TryFrom<String> for $name {
            type Error = ApiError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::try_from(value.as_str())
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

identifier!(RunId, "run identifier", InvalidRunId);
identifier!(NodeId, "node identifier", InvalidNodeId);
identifier!(
    ConversationId,
    "conversation identifier",
    InvalidConversationId
);
identifier!(ArtifactId, "artifact identifier", InvalidArtifactId);
identifier!(DispatchId, "dispatch identifier", InvalidDispatchId);

/// The wire's closed reference vocabulary: what the record a reference sits on
/// points at.
///
/// A closed set rather than the producing library's own string, because it
/// decides two things that must never disagree — the word served beside the
/// reference, and *where* `payload::artifact` reads that artifact's bytes from.
/// The browser client declares the same set as `timelineReferenceKindSchema`,
/// and `tests/contract.rs` reconciles the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceKind {
    /// A recorded transcript, served by the conversation route.
    Conversation,
    /// A log the producing library stored beside the run.
    GateLog,
    /// The report a settled member left, which the run keeps its own copy of.
    WorkerReport,
    /// A session in the oneharness history store.
    OneharnessSession,
    /// A change request on the host.
    Pr,
}

impl ReferenceKind {
    /// Every word the vocabulary holds, in the order the contract lists them.
    ///
    /// The list is what the drift gate reads: a variant added here without being
    /// added to the client's own copy fails that gate rather than reaching a
    /// reader as a word their model rejects.
    pub const ALL: [Self; 5] = [
        Self::Conversation,
        Self::GateLog,
        Self::WorkerReport,
        Self::OneharnessSession,
        Self::Pr,
    ];

    /// The producing library's own word for an artifact, read onto this
    /// vocabulary. Anything unrecognized is a log, which is what the producing
    /// libraries store.
    #[must_use]
    pub fn of(kind: &str) -> Self {
        match kind {
            "conversation" => Self::Conversation,
            "worker_report" | "report" => Self::WorkerReport,
            "oneharness_session" | "session" => Self::OneharnessSession,
            "pr" => Self::Pr,
            _ => Self::GateLog,
        }
    }

    /// The word the wire carries for it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::GateLog => "gate_log",
            Self::WorkerReport => "worker_report",
            Self::OneharnessSession => "oneharness_session",
            Self::Pr => "pr",
        }
    }
}

/// One directory or file name a producer's payload named, checked before
/// anything joins it to a path.
///
/// The other trust boundary this crate has. An identifier above crosses it from
/// a request; this one crosses it from a *record* — the `history_project` and
/// `history_session` an `oneharness-session` event names, which together locate
/// a transcript inside the oneharness history store on this host. A record is
/// external input exactly as a URL is: the producing library promises a bare
/// name, and a payload that carries anything else is refused rather than joined,
/// because joining it is how a read surface is made to open a file nobody asked
/// for.
///
/// Constructed only through [`TryFrom<&str>`], so a `String` read off a payload
/// cannot reach a `Path::join` without having passed through here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathSegment(String);

impl PathSegment {
    /// The name, as the store holds it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for PathSegment {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        check_segment(value, SEGMENT_MAX_LEN)?;
        Ok(Self(value.to_owned()))
    }
}

/// The directory a producer's record *named* as its store, held to the shape the
/// producer publishes one in.
///
/// The other half of the [`PathSegment`] boundary. `oneagentgraph` publishes a
/// history pointer **only** for a file already in oneharness's own layout: an
/// absolute path, with no component that climbs. Checked here rather than taken
/// on the producer's word, because a relative store resolves against whatever
/// directory this process happens to be serving from and a `..` inside one is
/// the same traversal a bare name is checked for.
///
/// **It certifies how a record spelled a path and nothing about this host.** The
/// name is still only what a record claimed: the directory may not exist, may
/// hold no store, and every component of it may be a symlink onto somewhere
/// else. Nothing may open a file on the strength of this type — a path earns
/// that only from [`StoreRoot::confine`], which is why this one is named for the
/// claim rather than for a root. It is deliberately the type that reads no
/// filesystem: the store a record names *no* store for is oneharness's own
/// default, which never passes through here, so a host-level check made here
/// would be one the store most records resolve to never takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedStore(String);

impl NamedStore {
    /// The directory, as the record named it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for NamedStore {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        let path = Path::new(value);
        if !path.is_absolute() {
            return Err("must be an absolute path".to_owned());
        }
        if path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err("must have no component that climbs".to_owned());
        }
        Ok(Self(value.to_owned()))
    }
}

/// A history store this process has read, as this host really holds it.
///
/// The trusted root, and the only thing in this crate that lets a file outside
/// the runs root be opened. It exists only once [`fs::canonicalize`] has
/// resolved the directory — the rule [`crate::cli::RunsRoot`] already follows for
/// the runs root — so what it holds is where the kernel actually arrives, with
/// every symlink, `.` and `..` along the way already resolved.
///
/// Canonical rather than lexical because of what stands between a pointer and a
/// file: oneharness's own reader walks the store's layout, listing a project
/// directory and matching a session file inside it, and either component can be
/// a symlink planted by anything that can write into the store. A check on how a
/// path is *spelled* says nothing about where opening it lands, so the proof is
/// made against the resolved path on both sides or it is not a proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreRoot(PathBuf);

impl StoreRoot {
    /// The store at `dir`, or `None` when this host holds no directory there.
    ///
    /// Resolved and then *read*, so the type cannot be inhabited by a path that
    /// is merely spelled well — a file, or a name nothing answers to, is not a
    /// root anything may be confined to. A store that is not there is an
    /// artifact with no readable bytes, which is the answer a pointer at a store
    /// this host does not hold has always had.
    #[must_use]
    pub fn read(dir: &Path) -> Option<Self> {
        let resolved = fs::canonicalize(dir).ok()?;
        fs::read_dir(&resolved).ok()?;
        Some(Self(resolved))
    }

    /// Where `path` — a path the store's own reader produced from this root —
    /// really lands, which is what decides whether it may be opened.
    #[must_use]
    pub fn confine(&self, path: &Path) -> Confined {
        match fs::canonicalize(path) {
            Ok(resolved) if resolved.starts_with(&self.0) => {
                Confined::Under(ConfinedPath(resolved))
            }
            Ok(_) => Confined::Escaped,
            Err(_) => Confined::Missing,
        }
    }
}

/// A path [`StoreRoot::confine`] resolved and found beneath its store.
///
/// The proof, rather than a note that one was taken: the field is private, so
/// `confine` is the only code in the crate that can fill it and no caller
/// anywhere can hand a reader an unchecked path wearing this type. That is the
/// whole reason it exists instead of a bare `PathBuf` — a guarantee a caller can
/// forge is worse than none, because the next reader is entitled to trust it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfinedPath(PathBuf);

impl ConfinedPath {
    /// Where the path really lands, which is the one to open.
    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

/// What a [`StoreRoot`] made of a path named beneath it.
///
/// Three answers and not two, because "there is nothing there" and "there is
/// something there and it is not yours" are different facts about the host and
/// only one of them is worth an operator's attention. Both are the same `404` to
/// a reader — the contract answers an artifact whose bytes this server will not
/// serve one way — so the distinction is kept here, where the caller can log the
/// refusal it must never put on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confined {
    /// It lands beneath the store, and this is where. Opening *this* path rather
    /// than the one it came from is the point: it holds no symlink left for the
    /// open itself to follow back out.
    Under(ConfinedPath),
    /// It lands outside the store that named it. Nothing may open it, and
    /// nothing may say on the wire where it went.
    Escaped,
    /// It lands nowhere this process can resolve — the name is a dangling link,
    /// a loop, or a file that went away between being listed and being read.
    /// Not a refusal: a refusal is a statement about a path that resolved, and
    /// this one did not.
    Missing,
}

/// The longest identifier any route accepts.
///
/// A bound rather than a limit anyone will meet: it exists so an unbounded
/// query string cannot become an unbounded allocation or log line.
const IDENTIFIER_MAX_LEN: usize = 128;

/// The longest name a checked path segment may carry.
///
/// Looser than an identifier because it bounds a *file name* rather than a URL
/// segment: oneharness composes a session name out of a member's own name, a
/// timestamp and a pid, and nothing upstream caps the first. 255 is what the
/// file systems underneath this hold a single component to, so a longer name
/// names no file anywhere and there is nothing to gain by joining it.
const SEGMENT_MAX_LEN: usize = 255;

/// Why `value` is not a usable identifier, or `Ok(())` when it is.
fn check_identifier(value: &str) -> Result<(), String> {
    check_segment(value, IDENTIFIER_MAX_LEN)
}

/// Why `value` is not a bare name, or `Ok(())` when it is.
///
/// One rule, two bounds. The character set is the whole of what makes a value
/// safe to join: no separator on any platform, no drive letter, no wildcard, no
/// NUL — and a leading `.` refused, which also refuses `.`, `..`, and the dot
/// files a store keeps its own index in.
fn check_segment(value: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err("must not be empty".to_owned());
    }
    if value.len() > max_len {
        return Err(format!("must be at most {max_len} characters"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("must use only ASCII letters, digits, '-', '_', and '.'".to_owned());
    }
    if value.starts_with('.') {
        return Err("must not start with '.'".to_owned());
    }
    Ok(())
}
