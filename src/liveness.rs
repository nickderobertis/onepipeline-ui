//! How a run is being driven, answered from its **summary** rather than from a
//! fold of its journal.
//!
//! This is the one reading in this crate that is a *restatement* of the sibling's
//! own, and `src/AGENTS.md` carries it as a proposal to make upstream. The reason
//! it cannot be a call: `onepipeline::views::liveness` takes a `RunState`, which
//! is the fold of a run's whole merged store, and the whole point of the
//! bounded summary is that a listing never takes one. The summary carries every
//! *input* that reading needs — the launch record's pid and host, whether a stop
//! was recorded, the run's last write, and whether a human action is
//! outstanding — but the SDK publishes no entry point that takes them.
//!
//! **The check that goes red when the two drift apart** is
//! `tests/contract.rs`'s `a_row_read_from_the_summary_is_the_row_a_fold_produces`,
//! which serves the same run directories both ways — through this reading and
//! through `onepipeline::views::liveness_word` behind
//! [`payload::run_summary`](crate::payload::run_summary) — and compares the rows
//! field by field. A run state this restatement gets wrong is a failing test
//! rather than a row an operator has to disbelieve.
//!
//! **Every unreadable input resolves toward "still working"**, which is the
//! sibling's own bias and the one that matters: a busy driver reported dead
//! sends an operator to intervene in work that is doing exactly what it should.

use std::num::NonZeroU32;

use onepipeline::views::{parked_after_seconds, DriverLiveness, RunSummary};

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
/// The sibling's `views::liveness_word` over a folded run, restated over the
/// bounded document — see this module's header for why, and for the check that
/// holds the two together.
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
/// [`DriverLiveness`] is the sibling's own type, so the *answers* are its
/// vocabulary and only the reading is here.
#[must_use]
pub fn driver(summary: &RunSummary) -> DriverLiveness {
    if summary.stop_recorded {
        return DriverLiveness::DriverDead;
    }
    // A pid means nothing across machines, so a run another host is driving
    // resolves toward the live work it is — and a record that named no host or
    // no driver at all carries `None` here rather than a value to probe.
    let ours = summary.host.as_deref() == Some(hostname().as_str());
    if ours && summary.pid.is_some_and(|pid| !process_may_be_live(pid)) {
        return DriverLiveness::DriverDead;
    }
    // A live pid is ownership, not progress.
    let quiet_for = summary
        .last_write_at
        .map(|last| now_millis().saturating_sub(last) / 1_000);
    match quiet_for {
        // A run holding an outstanding decision point is *waiting*, not parked:
        // the loop that would be writing is deliberately holding a subtree back
        // until a person answers.
        Some(seconds) if seconds > parked_after_seconds() && !decision_outstanding(summary) => {
            DriverLiveness::Parked
        }
        _ => DriverLiveness::Driving,
    }
}

/// Whether the run is waiting on somebody rather than on itself.
///
/// The graph's half — a ready human action nobody has attested — is recorded in
/// the summary. The other half is a **blocking surface**, which lives in the
/// channel rather than in the store, and which this crate cannot ask about: the
/// SDK's `channel::ChannelState` is crate-private, and restating the channel's
/// file layout here would put a second source of truth for it in the wrong
/// repository. `src/AGENTS.md` carries publishing that reading as the proposal.
///
/// So the question asked instead is the one the summary *can* answer, and it is
/// deliberately the **wider** one: any surface the run has sent and a planner has
/// not consumed, blocking or not. That errs toward "still working", which is the
/// direction the sibling's own reading errs in for every input it cannot read —
/// a busy driver reported parked invites an `adopt` that ends it, where a parked
/// one reported busy costs a second look.
///
/// **Where the two can disagree**, precisely: a run quiet past the parked
/// threshold, holding no ready human action, whose only outstanding surface is
/// **non-blocking**. The sibling reads that run `PARKED` and this reads it
/// `ACTIVE`. Nothing else in this module can differ, which is why the drift gate
/// this module's header names covers every other state and not that one.
/// `tests/e2e/server.rs`'s
/// `a_quiet_run_with_a_surface_nobody_has_read_is_waiting_rather_than_parked`
/// pins what this server serves there, so the difference is a decision on the
/// record rather than one nobody would notice moving.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the other source cannot be
// reached to gate against: the sibling's half of this reading is `channel::ChannelState`,
// which is `pub(crate)` in every published version, and restating the channel's file layout
// here would put a second source of truth for it in the wrong repository — the thing a drift
// gate exists to prevent, arriving as the fix for one. Every other state of this restatement
// *is* gated, over nine run shapes, by the check this module's header names; this one arm is
// the residue, its direction is chosen to err the way the sibling errs, and `src/AGENTS.md`
// carries publishing that reading as the proposal that closes it.
fn decision_outstanding(summary: &RunSummary) -> bool {
    summary.awaiting_human_action || summary.surfaces_queued > summary.surfaces_read
}

/// Now, in milliseconds since the epoch — the clock the run's own last write is
/// stamped against.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The host a recorded pid would be meaningful on.
///
/// The environment first and `/etc/hostname` after it, which is how the sibling
/// resolves it: a run recorded on a host that names itself one way and read back
/// on one that names itself another must not have its driver probed by pid.
///
/// Public because the drift gate this module's header names has to be able to
/// *write* a run recorded on this host, which is the only way the pid probe
/// below is reached at all — a launch record naming any other host resolves
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

/// Whether a pid recorded on *this* host may still be a live process.
///
/// Signal `0` performs the permission and existence checks without delivering
/// anything, and `ESRCH` is the only proof of absence: a refusal means the
/// process exists and is somebody else's, and anything else is a question this
/// host cannot answer. Both resolve toward live.
#[cfg(unix)]
fn process_may_be_live(pid: NonZeroU32) -> bool {
    let Ok(raw) = i32::try_from(pid.get()) else {
        return true;
    };
    // SAFETY: `kill` with signal 0 delivers nothing and touches no memory this
    // call owns; it reports only whether the pid could be signalled.
    let sent = unsafe { libc::kill(raw, 0) };
    if sent == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// The same question on Windows, which has no signal to send.
///
/// A process handle becomes signalled when — and **only** when — the process has
/// terminated, so opening one for `SYNCHRONIZE` and waiting zero milliseconds on
/// it settles the question without touching the process. Asked that way rather
/// than through `GetExitCodeProcess`, whose "still running" answer is the
/// sentinel `STILL_ACTIVE` — which is also the exit code `259` of a process that
/// really did exit.
///
/// The asymmetry is the unix arm's: `false` is a proof of absence and every
/// other answer resolves toward live. `ERROR_INVALID_PARAMETER` is what a pid
/// that never existed earns; a permission refusal means the process is there and
/// is somebody else's, and anything else is a question this host cannot answer.
///
/// **This is the sibling's own probe, spelled the same way**, and that is the
/// point rather than a coincidence: `tests/contract.rs`'s drift gate serves a
/// run whose recorded driver is gone through both readings and compares the
/// rows, so an arm here that answered the question differently — including by
/// declining to ask it — is a listing that contradicts the detail beside it on
/// that platform alone.
#[cfg(windows)]
fn process_may_be_live(pid: NonZeroU32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    // SAFETY: `OpenProcess` borrows nothing; it returns a null handle on failure
    // and a handle this function closes exactly once on success.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid.get()) };
    if handle.is_null() {
        return std::io::Error::last_os_error().raw_os_error()
            != i32::try_from(ERROR_INVALID_PARAMETER).ok();
    }
    // SAFETY: `handle` is the live handle opened above, and a zero timeout
    // returns immediately rather than waiting on it.
    let waited = unsafe { WaitForSingleObject(handle, 0) };
    // SAFETY: the handle came from `OpenProcess` above and is closed once.
    unsafe { CloseHandle(handle) };
    // `WAIT_OBJECT_0` is the one proof of absence: `WAIT_TIMEOUT` is a process
    // still running, and `WAIT_FAILED` is a question this host cannot answer.
    waited != WAIT_OBJECT_0
}

/// The same question on a platform this crate can probe no processes on.
///
/// **Unanswered rather than answered `false`**, which is where every other
/// unreadable input here resolves: a run reads as driven rather than as
/// abandoned. Neither platform the gate rules on takes this arm — unix sends
/// signal `0` and Windows waits on a process handle — so nothing this repository
/// ships reads a live driver as dead for want of a way to ask.
#[cfg(not(any(unix, windows)))]
fn process_may_be_live(_pid: NonZeroU32) -> bool {
    true
}
