//! The seam onto `onepipeline`'s own telemetry document.
//!
//! The SDK aggregates a run's wall clock into the eight buckets the wire carries
//! and folds what each party spent, and this crate never folds it a second time
//! — that is how two readings of where a run's time went come to disagree. There
//! are **two ways in**, because the SDK offers two and they cost differently:
//!
//! - [`of_aggregate`] takes the document a run's own **bounded summary** carries,
//!   read in this process. That is what a run-list row uses: a page of fifty rows
//!   used to be fifty subprocesses, each one folding the run it was asked about.
//! - [`of_run`] takes the SDK's published fold,
//!   [`telemetry::of_run`](onepipeline::telemetry::of_run), over a view the
//!   caller already holds. That is what the run **detail** uses: the route has
//!   already folded the run, so its clock is read off the fold in hand rather
//!   than fetched from a process started for it. No `onepipeline` binary is run
//!   by this server, for anything — the rule `AGENTS.md` states, and the
//!   coupling `src/AGENTS.md` carried as a proposal until the SDK published the
//!   fold.
//!
//! Both cross one boundary — `validated` — so what a telemetry document has to
//! be before this crate serves anything out of it is stated once. Not because
//! the producer is less trusted in-process — it is the same fold — but because
//! there is then **one** statement of what a document has to be, rather than a
//! second path in that nobody has to keep true. The two vocabularies are joined
//! by exhaustive matches, so a bucket or a party the sibling adds fails to
//! compile here rather than being quietly dropped out of a served row.
//!
//! What arrives and what leaves are deliberately different shapes. The SDK's
//! document can hold whatever a summary on disk said — a version this build does
//! not read, a bucket set that is not the eight, a cost that is not an amount of
//! money. [`RunTelemetry`] is what survived, and it cannot represent any of
//! those: the version is gone, because after the check there is only one; the
//! buckets are the eight slots rather than a list; and a cost is a [`Cost`]. So a
//! reader downstream is never the last thing between the producer's document and
//! a payload.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::contract::RunId;

/// One run's telemetry document, as wide as the SDK's own is.
///
/// Private, and built only from [`onepipeline::views::RunTelemetry`]: every
/// field here is as wide as that document's, so that what the producer's
/// contract rules out is ruled out once — in [`validated`] — rather than left
/// for each reader to remember. The version is not among the fields, because
/// the SDK's own type refuses to read a document of another version — schema 1
/// named four spans and carried no usage at all — so a value of that type is
/// already a document of the one version this build reads.
#[derive(Debug)]
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
    usage: BTreeMap<Party, WireUsage>,
}

/// One span of the run's wall clock, as the document names it.
#[derive(Debug, Clone, Copy)]
struct WireBucket {
    /// What the run was doing.
    name: BucketName,
    /// For how long, in milliseconds — absent when nothing in the stack
    /// measures this bucket, which is not the same fact as a measured zero.
    ms: Option<u64>,
}

/// What one party consumed, as the document writes it.
#[derive(Debug, Clone, Copy)]
struct WireUsage {
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    /// A bare number here, because a document may carry one that is not a cost;
    /// it becomes a [`Cost`] or the document is refused.
    cost_usd: Option<f64>,
}

/// One run's telemetry, as `onepipeline` aggregates it and after its own
/// contract has been held to.
///
/// Constructed only by the boundary that holds a document to the producer's
/// contract. There is no version on it because the SDK's own document already
/// is one of the version this build reads, and no list of buckets because it
/// is already exactly the eight.
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
fn validated(run: &RunId, document: Document) -> Result<RunTelemetry, Unreadable> {
    // The run the answer is about, before anything measured in it. Nothing in a
    // document says which run's clock it is except this, and a document about
    // another run is not a surprising number — it is a whole other run's timing,
    // which this server would serve under this run's name with nothing in the
    // payload to tell them apart.
    if document.run_id != run.as_str() {
        return Err(Unreadable(format!(
            "the document is run `{}`'s, and this asked about `{run}`",
            document.run_id
        )));
    }

    // Exactly the eight, once each, slotted by each bucket's place in `ALL`.
    // The invariant under everything else is that every millisecond of the
    // clock has one of a known set of homes, and the SDK's own type holds it:
    // it refuses to read a document whose bucket list is not exactly the eight
    // in its own order, so a value of that type carries each name once and the
    // slotting below cannot meet a name twice or miss one. Order is looked up
    // rather than assumed all the same, so a producer that reordered its list
    // would land each span in its own slot.
    let mut buckets = [None; BucketName::COUNT];
    for bucket in &document.buckets {
        if let Some(slot) = BucketName::ALL.iter().position(|name| *name == bucket.name) {
            buckets[slot] = bucket.ms;
        }
    }

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
        return Err(Unreadable(format!(
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
                Unreadable(format!("the `{}` party cost {rejected}", party.as_str()))
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
            return Err(Unreadable(format!(
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

/// Why a run's telemetry document could not be served.
///
/// Carried rather than swallowed: every timing this server serves is absent
/// without it, and an operator looking at a run with no clock at all needs to
/// know what the document said that this build could not read. One variant
/// rather than three: with the subprocess gone there is no binary to fail to
/// start and no process to refuse, and what is left is the document itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable(pub String);

impl std::fmt::Display for Unreadable {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            out,
            "the telemetry document is not one this build can read: {}",
            self.0
        )
    }
}

impl std::error::Error for Unreadable {}

/// The telemetry `onepipeline` folds for one run, over the view a caller
/// already holds.
///
/// The SDK's published fold — [`onepipeline::telemetry::of_run`] over the
/// run's paths and its merged events — and nothing else: no process, no second
/// reading of the journal. The run whose clock this is comes off the view, so
/// the only way to ask about one run and be answered about another is a view
/// that lies about its own paths, which `validated` still refuses.
///
/// # Errors
///
/// When the document the fold produces does not hold to the producer's own
/// contract, which leaves the run's timing unknown and served as absent rather
/// than as zero.
pub fn of_run(view: &onepipeline::views::RunView) -> Result<RunTelemetry, Unreadable> {
    let run = RunId::try_from(view.paths.run.as_str()).map_err(|refused| {
        Unreadable(format!("the view names a run this API cannot: {refused}"))
    })?;
    of_aggregate(
        &run,
        &onepipeline::telemetry::of_run(&view.paths, &view.events),
    )
}

/// The SDK's own document, held to the producer's contract and projected.
///
/// A run's bounded summary carries `views::RunTelemetry` — the whole of what
/// `onepipeline telemetry <run>` prints, referenced by that document rather than
/// restated in it — so a run list reads each served row's clock without starting
/// a process for it; and the fold [`of_run`] takes produces the same document
/// over a view. Both cross this one boundary.
///
/// `run` is what was asked about, and a document is only an answer to that: the
/// producer names the run it aggregated, so an answer naming another one is
/// refused rather than served under the name the caller used.
///
/// The two vocabularies are joined by exhaustive matches below, so a bucket or a
/// party the sibling adds fails to compile here rather than being quietly
/// dropped out of a served row.
///
/// # Errors
///
/// Anything that is not a telemetry document about `run`, held to the
/// producer's own contract.
pub fn of_aggregate(
    run: &RunId,
    aggregate: &onepipeline::views::RunTelemetry,
) -> Result<RunTelemetry, Unreadable> {
    validated(
        run,
        Document {
            run_id: aggregate.run_id.clone(),
            wall_ms: aggregate.wall_ms,
            buckets: aggregate
                .buckets
                .iter()
                .map(|bucket| WireBucket {
                    name: bucket_named(bucket.name),
                    ms: bucket.ms,
                })
                .collect(),
            usage: aggregate
                .usage
                .iter()
                .map(|(party, spent)| {
                    (
                        party_named(*party),
                        WireUsage {
                            input: spent.input,
                            output: spent.output,
                            cache_read: spent.cache_read,
                            cache_write: spent.cache_write,
                            cost_usd: spent.cost_usd,
                        },
                    )
                })
                .collect(),
        },
    )
}

/// This crate's name for one of the sibling's buckets.
///
/// Exhaustive, and that is the whole of its job: the eight are what the wire
/// carries and what the sum-to-the-whole invariant is checked over, so a ninth
/// arriving from the producer has to be decided here rather than dropped.
fn bucket_named(name: onepipeline::views::BucketName) -> BucketName {
    use onepipeline::views::BucketName as Theirs;
    match name {
        Theirs::Agent => BucketName::Agent,
        Theirs::Judge => BucketName::Judge,
        Theirs::Llmlint => BucketName::Llmlint,
        Theirs::Gate => BucketName::Gate,
        Theirs::PublicationWait => BucketName::PublicationWait,
        Theirs::LockWait => BucketName::LockWait,
        Theirs::Setup => BucketName::Setup,
        Theirs::Scheduling => BucketName::Scheduling,
    }
}

/// This crate's name for one of the sibling's parties, on the same terms.
fn party_named(party: onepipeline::views::Party) -> Party {
    use onepipeline::views::Party as Theirs;
    match party {
        Theirs::Agent => Party::Agent,
        Theirs::Judge => Party::Judge,
        Theirs::Llmlint => Party::Llmlint,
        Theirs::Total => Party::Total,
    }
}
