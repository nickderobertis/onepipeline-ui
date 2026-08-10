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

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

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

/// One run's telemetry, as `onepipeline` aggregates it.
///
/// Only what the wire carries is read back. Extra fields are the producer's own
/// and are ignored rather than refused: a newer build of the same document
/// version may report more about a run than this server serves.
#[derive(Debug, Clone, Deserialize)]
pub struct RunTelemetry {
    /// The version of the document, read before anything under it and refused
    /// unless it is [`DOCUMENT_VERSION`].
    pub schema_version: u32,
    /// The whole elapsed time, in milliseconds.
    pub wall_ms: u64,
    /// The eight buckets, each measured or absent.
    pub buckets: Vec<Bucket>,
    /// What each party spent. A party nothing reported for is absent from the
    /// map rather than present and zero.
    #[serde(default)]
    pub usage: BTreeMap<Party, Usage>,
}

/// One span of the run's wall clock, named by what the run was doing.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bucket {
    /// What the run was doing.
    pub name: BucketName,
    /// For how long, in milliseconds — absent when nothing in the stack
    /// measures this bucket, which is not the same fact as a measured zero.
    #[serde(default)]
    pub ms: Option<u64>,
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
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Usage {
    /// Input tokens billed.
    #[serde(default)]
    pub input: Option<u64>,
    /// Output tokens billed.
    #[serde(default)]
    pub output: Option<u64>,
    /// Prompt tokens served from the provider's cache.
    #[serde(default)]
    pub cache_read: Option<u64>,
    /// Prompt tokens written to it.
    #[serde(default)]
    pub cache_write: Option<u64>,
    /// What it cost, in US dollars.
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

impl RunTelemetry {
    /// One bucket's measured span, or `None` when nothing measured it.
    #[must_use]
    pub fn bucket(&self, name: BucketName) -> Option<u64> {
        self.buckets
            .iter()
            .find(|bucket| bucket.name == name)
            .and_then(|bucket| bucket.ms)
    }

    /// What the measured buckets account for, which is what the residue is the
    /// rest of.
    #[must_use]
    pub fn measured_ms(&self) -> u64 {
        self.buckets
            .iter()
            .filter_map(|bucket| bucket.ms)
            .fold(0, u64::saturating_add)
    }

    /// One party's usage, or an empty one when nothing reported for it.
    #[must_use]
    pub fn usage_of(&self, party: Party) -> Usage {
        self.usage.get(&party).copied().unwrap_or_default()
    }
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
    // The version before anything under it. A document of another version is not
    // a document with a bad field in it: schema 1 named four spans this build has
    // no names for, and reporting that as an unknown bucket would send a reader
    // looking for a typo instead of at the version they are running.
    let answered: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| Unavailable::Unreadable(err.to_string()))?;
    let version = answered
        .get("schema_version")
        .and_then(serde_json::Value::as_u64);
    if version != Some(u64::from(DOCUMENT_VERSION)) {
        return Err(Unavailable::Unreadable(format!(
            "telemetry schema_version {}, and this build reads {DOCUMENT_VERSION}",
            version.map_or_else(|| "absent".to_owned(), |found| found.to_string())
        )));
    }
    serde_json::from_value(answered).map_err(|err| Unavailable::Unreadable(err.to_string()))
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
