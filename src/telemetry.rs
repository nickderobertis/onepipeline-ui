//! The seam onto `onepipeline`'s own telemetry document.
//!
//! The SDK aggregates a run's wall clock into the eight buckets the wire carries
//! and folds what each party spent, and it keeps that fold *behind* its contract
//! surface: `onepipeline`'s `telemetry` module is private in every published
//! version, and the document is reachable only through `onepipeline telemetry
//! <run>`. So this crate reaches it the way any other caller does — through that
//! CLI — rather than folding the run's clock a second time here, which is how
//! the two readings would come to disagree about where a run's time went.
//!
//! What is duplicated here is the *document*, not the fold: the stack has no
//! shared crate, so each side owns its copy of a wire shape and a contract test
//! holds them together: `tests/e2e/server.rs` runs the real binary over a real
//! recorded run and reads what it prints through these very types, beside the
//! payload this server made of the same document.
//!
//! Two boundaries, kept apart because they fail differently and are answerable
//! separately. [`of_run`] is the *process*: a build that will not start, or one
//! that ran and refused. [`read_document`] is the *document*: whether what came
//! back is one at all — the version, the run it is about, and then every
//! property `onepipeline` states about what it writes. Nothing under a failed
//! check is served, because
//! a timing read out of a document that does not add up is a claim with nothing
//! behind it, and this server's whole answer for an unknown clock is to say so.
//!
//! What arrives and what leaves are deliberately different shapes. A decode
//! target has to be able to hold whatever the bytes say — a version this build
//! does not read, a bucket set that is not the eight, a cost that is not an
//! amount of money — so the wire types below hold all of it and are private.
//! [`RunTelemetry`] is what survived, and it cannot represent any of those: the
//! version is gone, because after the check there is only one; the buckets are
//! the eight slots rather than a list; and a cost is a [`Cost`]. So a reader
//! downstream is never the last thing between the producer's bytes and a
//! payload.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::contract::RunId;

/// The environment variable naming the `onepipeline` executable.
///
/// Resolved rather than hardcoded, for the same reason the SDK resolves its own
/// siblings: an operator can point at a specific build, and the suite can point
/// at the one it provisioned.
pub const BINARY_ENV: &str = "ONEPIPELINE_UI_ONEPIPELINE_BIN";

/// The executable's name when the environment names none.
pub const DEFAULT_BINARY: &str = "onepipeline";

/// The environment variable `onepipeline` reads its runs root from.
///
/// Its CLI takes the run id and finds the root here rather than on a flag, so
/// this is how a reader points it at the root this server is serving.
pub const RUNS_DIR_ENV: &str = "ONEPIPELINE_RUNS_DIR";

/// The document version this build reads.
///
/// The number is the whole compatibility statement, and the producer refuses a
/// document of another version rather than reading it: version 1 named four
/// spans and carried no usage at all, so reading one as a 2 would report a run
/// as having spent nothing. Refused here on the same terms.
pub const DOCUMENT_VERSION: u32 = 2;

/// The executable this process asks for a telemetry document.
fn binary() -> String {
    std::env::var(BINARY_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_BINARY.to_owned())
}

/// One run's telemetry document, exactly as it arrives.
///
/// Private, and the only thing `serde` builds: every field here is as wide as
/// the bytes are, so that what the producer's contract rules out is ruled out
/// once — in [`validated`] — rather than left for each reader to remember.
///
/// Only what the wire carries is read back. Extra fields are the producer's own
/// and are ignored rather than refused: a newer build of the same document
/// version may report more about a run than this server serves. The version
/// itself is not among them: it is read and checked before this shape is
/// decoded at all, so nothing under it is decoded out of a document that turned
/// out to be another one.
#[derive(Debug, Deserialize)]
struct Document {
    /// Which run the producer aggregated. Required, because the producer writes
    /// it on every document and it is the only thing in the answer that says
    /// what the answer is about.
    run_id: String,
    /// The whole elapsed time, in milliseconds.
    wall_ms: u64,
    /// What the producer wrote as its bucket set, before it is held to being
    /// the eight.
    buckets: Vec<WireBucket>,
    /// What the producer wrote for each party.
    #[serde(default)]
    usage: BTreeMap<Party, WireUsage>,
}

/// One span of the run's wall clock, as the document names it.
#[derive(Debug, Clone, Copy, Deserialize)]
struct WireBucket {
    /// What the run was doing.
    name: BucketName,
    /// For how long, in milliseconds — absent when nothing in the stack
    /// measures this bucket, which is not the same fact as a measured zero.
    #[serde(default)]
    ms: Option<u64>,
}

/// What one party consumed, as the document writes it.
#[derive(Debug, Clone, Copy, Deserialize)]
struct WireUsage {
    #[serde(default)]
    input: Option<u64>,
    #[serde(default)]
    output: Option<u64>,
    #[serde(default)]
    cache_read: Option<u64>,
    #[serde(default)]
    cache_write: Option<u64>,
    /// A bare number here, because a document may carry one that is not a cost;
    /// it becomes a [`Cost`] or the document is refused.
    #[serde(default)]
    cost_usd: Option<f64>,
}

/// One run's telemetry, as `onepipeline` aggregates it and after its own
/// contract has been held to.
///
/// Constructed only by [`read_document`]. There is no version on it because a
/// value of this type is already a [`DOCUMENT_VERSION`] document, and no list of
/// buckets because it is already exactly the eight.
#[derive(Debug, Clone)]
pub struct RunTelemetry {
    /// The whole elapsed time, in milliseconds.
    pub wall_ms: u64,
    /// The eight buckets, one slot each in the order of [`BucketName::ALL`],
    /// measured or absent. Slots rather than a list: "exactly one of each of the
    /// eight" is the invariant every reading rests on, and as a `Vec` it would
    /// be a rule to re-check instead of a shape.
    buckets: [Option<u64>; BucketName::COUNT],
    /// What each party spent. A party nothing reported for is absent from the
    /// map rather than present and zero.
    usage: BTreeMap<Party, Usage>,
}

/// An amount of money, in US dollars: finite, and not a debt.
///
/// A bare `f64` also holds NaN, an infinity and a negative, none of which a run
/// can cost — and as a field it leaves whoever reads it next as the last thing
/// between the producer's bytes and a served payload. Constructed only through
/// [`TryFrom<f64>`], so a document carrying one of those is refused at the
/// boundary. Serialized as the number it is, which is what the wire carries.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize)]
#[serde(into = "f64")]
pub struct Cost(f64);

/// A number that is not an amount of money.
///
/// It names the number, because the refusal a reader sees has to say which one
/// the document carried; the caller adds only whose cost it was.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NotAnAmount(f64);

impl std::fmt::Display for NotAnAmount {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{:?}, which is not an amount of money", self.0)
    }
}

impl std::error::Error for NotAnAmount {}

impl Cost {
    /// The amount, in US dollars.
    #[must_use]
    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for Cost {
    type Error = NotAnAmount;

    fn try_from(amount: f64) -> Result<Self, Self::Error> {
        if amount.is_finite() && amount >= 0.0 {
            Ok(Self(amount))
        } else {
            Err(NotAnAmount(amount))
        }
    }
}

impl From<Cost> for f64 {
    fn from(cost: Cost) -> Self {
        cost.0
    }
}

/// What a run's wall clock is spent on, in the producer's own vocabulary.
///
/// A closed set, because the measured buckets sum exactly to the wall clock and
/// that invariant only holds while every millisecond has one of a known set of
/// homes. A name this build does not know is a document it cannot add up, so it
/// is refused rather than dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BucketName {
    /// Wall time with an agent dispatch in flight and nothing more specific
    /// happening.
    Agent,
    /// Wall time a judge side of a dispatch was running.
    Judge,
    /// Wall time an LLM-lint pass was running.
    Llmlint,
    /// Wall time a repository's own verification gate was running.
    Gate,
    /// Wall time a publication was in the host's hands.
    PublicationWait,
    /// Wall time blocked on a repository identity's lock.
    LockWait,
    /// Wall time preparing a workspace.
    Setup,
    /// Everything else the run's clock covers, including the waits on a planner
    /// and on a person.
    Scheduling,
}

/// Who spent a run's tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Party {
    /// The side doing the work.
    Agent,
    /// The side supervising it.
    Judge,
    /// The LLM-lint pass.
    Llmlint,
    /// Everything the run spent, however it was split.
    Total,
}

/// What one party consumed. Every field is independently absent until something
/// reported a number for it: a run whose cost nothing answered must not read as
/// a run that was free.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    /// Input tokens billed.
    pub input: Option<u64>,
    /// Output tokens billed.
    pub output: Option<u64>,
    /// Prompt tokens served from the provider's cache.
    pub cache_read: Option<u64>,
    /// Prompt tokens written to it.
    pub cache_write: Option<u64>,
    /// What it cost, in US dollars.
    pub cost_usd: Option<Cost>,
}

impl BucketName {
    /// How many buckets a document carries — the eight, once each.
    pub const COUNT: usize = 8;

    /// Every bucket, in the order the producer writes them. Also the order of
    /// the slots a [`RunTelemetry`] holds them in.
    pub const ALL: [Self; Self::COUNT] = [
        Self::Agent,
        Self::Judge,
        Self::Llmlint,
        Self::Gate,
        Self::PublicationWait,
        Self::LockWait,
        Self::Setup,
        Self::Scheduling,
    ];

    /// The word this bucket is written as, for naming it in a refusal.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Judge => "judge",
            Self::Llmlint => "llmlint",
            Self::Gate => "gate",
            Self::PublicationWait => "publication_wait",
            Self::LockWait => "lock_wait",
            Self::Setup => "setup",
            Self::Scheduling => "scheduling",
        }
    }
}

impl Party {
    /// The word this party is written as, for naming it in a refusal.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Judge => "judge",
            Self::Llmlint => "llmlint",
            Self::Total => "total",
        }
    }
}

impl Usage {
    /// Whether nothing at all was reported for this party.
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.input.is_none()
            && self.output.is_none()
            && self.cache_read.is_none()
            && self.cache_write.is_none()
            && self.cost_usd.is_none()
    }
}

impl RunTelemetry {
    /// One bucket's measured span, or `None` when nothing measured it.
    ///
    /// The slot a bucket occupies is its place in [`BucketName::ALL`], looked up
    /// there rather than written out a second time to drift from it.
    #[must_use]
    pub fn bucket(&self, name: BucketName) -> Option<u64> {
        BucketName::ALL
            .iter()
            .position(|candidate| *candidate == name)
            .and_then(|slot| self.buckets[slot])
    }

    /// What the measured buckets account for, which is what the residue is the
    /// rest of.
    #[must_use]
    pub fn measured_ms(&self) -> u64 {
        self.buckets
            .iter()
            .filter_map(|ms| *ms)
            .fold(0, u64::saturating_add)
    }

    /// One party's usage, or an empty one when nothing reported for it.
    #[must_use]
    pub fn usage_of(&self, party: Party) -> Usage {
        self.usage.get(&party).copied().unwrap_or_default()
    }
}

/// Hold a document to the producer's own contract, before any of it is served.
///
/// The version says which document this is; these say whether it is one at all.
/// Each is a property `onepipeline` states and enforces about what it writes, so
/// a document failing one is not a document with a surprising number in it — it
/// is a producer this reader cannot honestly project, and every timing served
/// from it would be a claim nothing supports.
fn validated(run: &RunId, document: Document) -> Result<RunTelemetry, Unavailable> {
    // The run the answer is about, before anything measured in it. Nothing in a
    // document says which run's clock it is except this, and a document about
    // another run is not a surprising number — it is a whole other run's timing,
    // which this server would serve under this run's name with nothing in the
    // payload to tell them apart.
    if document.run_id != run.as_str() {
        return Err(Unavailable::Unreadable(format!(
            "the document is run `{}`'s, and this asked about `{run}`",
            document.run_id
        )));
    }

    // Exactly the eight, once each. The invariant under everything else is that
    // every millisecond of the clock has one of a known set of homes, which says
    // nothing at all over a set missing one, carrying one twice, or naming one
    // this build cannot add up. Order is the producer's own and is not required
    // here: the slot a span lands in is its bucket's place in `ALL`.
    let mut buckets = [None; BucketName::COUNT];
    for (slot, name) in BucketName::ALL.into_iter().enumerate() {
        let mut named = document.buckets.iter().filter(|bucket| bucket.name == name);
        let one = named.next();
        let found = usize::from(one.is_some()) + named.count();
        if found != 1 {
            return Err(Unavailable::Unreadable(format!(
                "the `{}` bucket appears {found} times, and a telemetry document carries \
                 exactly one of each of the eight",
                name.as_str()
            )));
        }
        buckets[slot] = one.and_then(|bucket| bucket.ms);
    }
    // No length check beside it: a name outside the eight is refused while the
    // document is still being decoded, so eight names each appearing once is
    // eight buckets and nothing else.

    // Measured time that was never on the clock. The producer's aim is that its
    // measured buckets sum *exactly* to the whole, and it sweeps any residue into
    // `scheduling` to keep that true — but a reader must refuse only what is
    // impossible, and a sum *below* the wall clock is honest: it is time nothing
    // claimed, which is what `unattributed_ms` is for. A sum above it is the one
    // that cannot be true of any clock.
    let measured = buckets
        .iter()
        .filter_map(|ms| *ms)
        .fold(0, u64::saturating_add);
    if measured > document.wall_ms {
        return Err(Unavailable::Unreadable(format!(
            "the buckets measure {measured}ms of a {}ms wall clock",
            document.wall_ms
        )));
    }

    let mut usage = BTreeMap::new();
    for (party, spent) in document.usage {
        let cost = spent
            .cost_usd
            .map(Cost::try_from)
            .transpose()
            .map_err(|rejected| {
                Unavailable::Unreadable(format!("the `{}` party cost {rejected}", party.as_str()))
            })?;
        let spent = Usage {
            input: spent.input,
            output: spent.output,
            cache_read: spent.cache_read,
            cache_write: spent.cache_write,
            cost_usd: cost,
        };
        // A party nothing reported for is absent from the map rather than
        // present and empty — the producer says so, and a reader that accepted
        // an empty one would serve "spent nothing" for a party nobody measured.
        if spent.is_empty() {
            return Err(Unavailable::Unreadable(format!(
                "the `{}` party is present and reports nothing, where a party nothing was \
                 reported for is absent",
                party.as_str()
            )));
        }
        usage.insert(party, spent);
    }

    Ok(RunTelemetry {
        wall_ms: document.wall_ms,
        buckets,
        usage,
    })
}

/// Read one telemetry document about `run`, or say why it is not one.
///
/// The parser boundary, separate from the process that produced the bytes: what
/// a document has to be is the same question whichever build wrote it, and it is
/// answerable — and tested — without starting anything.
///
/// `run` is what was asked about, and a document is only an answer to that: the
/// producer names the run it aggregated, so an answer naming another one is
/// refused rather than served under the name the caller used.
///
/// # Errors
///
/// [`Unavailable::Unreadable`] for anything that is not a document of
/// [`DOCUMENT_VERSION`] about `run`, holding to the producer's own contract.
pub fn read_document(run: &RunId, answer: &[u8]) -> Result<RunTelemetry, Unavailable> {
    // The version before anything under it. A document of another version is not
    // a document with a bad field in it: schema 1 named four spans this build has
    // no names for, and reporting that as an unknown bucket would send a reader
    // looking for a typo instead of at the version they are running.
    let answered: serde_json::Value =
        serde_json::from_slice(answer).map_err(|err| Unavailable::Unreadable(err.to_string()))?;
    let version = answered
        .get("schema_version")
        .and_then(serde_json::Value::as_u64);
    if version != Some(u64::from(DOCUMENT_VERSION)) {
        return Err(Unavailable::Unreadable(format!(
            "telemetry schema_version {}, and this build reads {DOCUMENT_VERSION}",
            version.map_or_else(|| "absent".to_owned(), |found| found.to_string())
        )));
    }
    let document: Document =
        serde_json::from_value(answered).map_err(|err| Unavailable::Unreadable(err.to_string()))?;
    validated(run, document)
}

/// Why a run's telemetry could not be read.
///
/// Carried rather than swallowed: every timing this server serves is absent
/// without it, and an operator looking at a run with no clock at all needs to
/// know whether the sibling is missing, refusing, or answering something this
/// build cannot read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
    /// The executable could not be started.
    NoBinary(String),
    /// It ran and refused, with the tail of what it said.
    Refused(String),
    /// It answered something this build cannot read.
    Unreadable(String),
}

impl std::fmt::Display for Unavailable {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoBinary(reason) => write!(
                out,
                "cannot start `{} telemetry`: {reason} — install the matching \
                 `onepipeline`, or name one with {BINARY_ENV}",
                binary()
            ),
            Self::Refused(reason) => write!(out, "`{} telemetry` refused: {reason}", binary()),
            Self::Unreadable(reason) => write!(
                out,
                "`{} telemetry` answered a document this build cannot read: {reason}",
                binary()
            ),
        }
    }
}

/// The telemetry `onepipeline` aggregates for one run under `root`.
///
/// A [`RunId`] rather than a name: this reaches another process's argument list,
/// and the sibling refuses a run id that navigates for exactly the reason this
/// crate does. Taking the validated type means there is no path into the seam
/// that has not already crossed that boundary.
///
/// # Errors
///
/// When the sibling cannot be started, refuses the run, or answers a document of
/// another version. Every one of those leaves the run's timing unknown, which is
/// served as absent rather than as zero.
pub fn of_run(root: &Path, run: &RunId) -> Result<RunTelemetry, Unavailable> {
    of_run_from(&binary(), root, run)
}

/// The same, from a named build of the sibling.
///
/// The one caller that names it is a journey: every reading this can give but a
/// good one needs a producer that gives it — one that is not installed, one that
/// refuses, one that answers a document of another version — and choosing which
/// producer answers is the only way to drive those without changing the
/// environment out from under every other test in the process.
///
/// # Errors
///
/// As [`of_run`].
pub fn of_run_from(binary: &str, root: &Path, run: &RunId) -> Result<RunTelemetry, Unavailable> {
    let output = Command::new(binary)
        .arg("telemetry")
        .arg(run.as_str())
        .env(RUNS_DIR_ENV, root)
        .output()
        .map_err(|err| Unavailable::NoBinary(err.to_string()))?;
    if !output.status.success() {
        return Err(Unavailable::Refused(tail(&output.stderr)));
    }
    // llmlint: ignore[changed_behavior_has_e2e] the observable behaviour behind
    // this line — a run served with no clock at all, every timing absent rather
    // than zero, on the row and in the detail alike — is driven end to end by
    // `a_run_whose_telemetry_cannot_be_read_is_served_with_no_clock_at_all`, and
    // the two process outcomes are driven against the real `onepipeline` by
    // `a_sibling_that_cannot_answer_names_which_way_it_could_not`. What is not
    // driven through a subprocess is a *started* producer answering a bad
    // document — one that contradicts itself, or one about another run entirely —
    // and deliberately: that would need a fake `onepipeline` written to emit one,
    // since the real one echoes the id it was asked, and what makes a document
    // wrong is a property of its bytes rather than of who wrote them. So it is
    // driven through `read_document` over real bytes instead, exhaustively, in
    // `tests/contract.rs`.
    read_document(run, &output.stdout)
}

/// The last line of what a refused command said, bounded: the sibling names the
/// problem on its last line, and the rest is its own context.
fn tail(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .next_back()
        .unwrap_or("it said nothing")
        .trim()
        .to_owned()
}
