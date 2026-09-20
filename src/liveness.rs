//! How a run is being driven, answered from its **summary** rather than from a
//! fold of its journal.
//!
//! This used to be the one reading in this crate that *restated* one of the
//! sibling's, because `onepipeline::views::liveness` took a `RunState` — the fold
//! of a run's whole merged store — and the whole point of the bounded summary is
//! that a listing never takes one. The SDK now publishes
//! [`views::liveness_of`](onepipeline::views::liveness_of) over the summary
//! itself, so [`driver`] is a call and the restatement is gone with the
//! proposal that asked for it.
//!
//! **Where that call looks.** The SDK reads the run's channel — the half of the
//! answer no summary carries, whether a *blocking* surface is outstanding —
//! under the runs root its own environment names, `ONEPIPELINE_RUNS_DIR`, which
//! is where a listing found the document. The binary exports that variable from
//! `--runs-root` before it serves anything, so the channel the SDK asks about is
//! the one under the root this server reads; `src/AGENTS.md` records the
//! proposal that would let a caller hand the root in instead.
//!
//! **The check that goes red when the row and the fold drift apart** is
//! `tests/contract.rs`'s `a_row_read_from_the_summary_is_the_row_a_fold_produces`,
//! which serves the same run directories both ways — through this reading and
//! through `onepipeline::views::liveness_word` behind
//! [`payload::run_summary`](crate::payload::run_summary) — and compares the rows
//! field by field.

use onepipeline::views::{DriverLiveness, RunSummary};

/// The word a settled run reads as, whatever is or is not driving it.
///
/// A run whose graph completed is settled rather than abandoned: its driver is
/// gone because there was nothing left for it to do, and reporting it as
/// undriven would send a planner to intervene in finished work.
const SETTLED: &str = "SETTLED";

/// The status word every node of a completed graph carries.
///
/// The run's own word, as `node_counts` counts it. The SDK's `NodeStatus` is
/// declared in a private module, so this is the same literal
/// [`payload`](crate::payload) already reads a status by, held to the SDK's
/// meaning by the drift gate this module's header names.
const DONE: &str = "done";

/// The word a run's summary reads as: how it is being driven, or that it is
/// over.
///
/// The sibling's `views::liveness_word` over a folded run, over the bounded
/// document — see this module's header for the check that holds the two
/// together.
#[must_use]
pub fn word(summary: &RunSummary) -> &'static str {
    if graph_complete(summary) {
        SETTLED
    } else {
        driver(summary).as_str()
    }
}

/// Whether every node the run recorded has settled `done`.
///
/// A run whose graph nothing has recorded has **not** completed: an empty count
/// is a run that has not started, not one with nothing left to do.
#[must_use]
pub fn graph_complete(summary: &RunSummary) -> bool {
    !summary.node_counts.is_empty() && summary.node_counts.keys().all(|word| word == DONE)
}

/// Whether a run is being driven, and if not, why not.
///
/// The SDK's own listing reading, called rather than restated: the driver claim
/// the document carries, the run's last write, and the run's own channel, asked
/// now. [`DriverLiveness`] is the sibling's own type, so the *answers* are its
/// vocabulary.
#[must_use]
pub fn driver(summary: &RunSummary) -> DriverLiveness {
    onepipeline::views::liveness_of(summary)
}

/// The host a recorded pid would be meaningful on.
///
/// The environment first and `/etc/hostname` after it, which is how the sibling
/// resolves it: a run recorded on a host that names itself one way and read back
/// on one that names itself another must not have its driver probed by pid.
///
/// Public because the drift gate this module's header names has to be able to
/// *write* a run recorded on this host, which is the only way the SDK's pid
/// probe is reached at all — a launch record naming any other host resolves
/// toward live without asking.
#[must_use]
pub fn hostname() -> String {
    for key in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                return value;
            }
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "localhost".to_owned())
}
