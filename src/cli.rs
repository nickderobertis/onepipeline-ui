//! The command-line surface, and the server configuration it produces.
//!
//! [`ServeArgs`] is both: clap parses it from the command line, and serde reads
//! the same shape from a configuration file, so the two can never describe
//! different servers — and both reach the run store through [`RunsRoot`], which
//! only exists once the directory has been read, and act as one [`SessionId`],
//! which only exists once the value has been checked.
//!
//! Beside `serve` the binary carries the engine's two hidden driver verbs,
//! because `POST /api/v2/runs/{run}/adopt` retains **this executable** as the
//! run's driver: `drive-run RUN --adopt` is the process the SDK spawns, and
//! `drive` is what that driver spawns for each dispatch once the engine has
//! recorded that this executable answers its command line. Both are the
//! engine's own argument shapes, parsed by the engine's own parser and run
//! through its own entry point, so the driver an adoption leaves behind runs the
//! engine this binary links and nothing else — the process model
//! `docs/contract.md` states.

use std::fs;
use std::net::SocketAddr;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};

use crate::ui::{UiDist, View};

/// Exit status when a command parsed but this process could not carry it out.
///
/// `sysexits.h`'s `EX_SOFTWARE`. It is the third of the three statuses AGENTS.md
/// fixes, and it is deliberately distinct from clap's `2`: the arguments were
/// usable and something behind them — a runtime this host would not give the
/// process — is what stopped it, so a caller scripting against these can tell
/// "you asked wrongly" from "this host could not do it".
pub const EXIT_SOFTWARE: u8 = 70;

/// Serve and inspect the onepipeline read API.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "onepipeline-api", version, about, long_about = None)]
pub struct Cli {
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The subcommands `onepipeline-api` accepts.
#[allow(
    clippy::large_enum_variant,
    reason = "parsed once per process, so the size of the engine's own driver arguments \
              costs nothing a box would save; boxing the variant would change the shape of \
              a public enum a consumer matches on"
)]
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum Command {
    /// Serve the read API described in docs/contract.md.
    Serve(ServeArgs),
    /// Drive one run's engine loop in this process, adopting it if asked.
    ///
    /// Not part of the documented surface and hidden from `--help`: it is the
    /// process `POST /api/v2/runs/{run}/adopt` retains as the run's driver,
    /// spelled exactly as the engine spells its own — `drive-run RUN --adopt` —
    /// so the driver an adoption leaves behind is this executable running the
    /// engine it links. Nothing but this binary's own adopt route spells it.
    #[command(hide = true, name = DRIVE_RUN_VERB)]
    DriveRun(onepipeline::cli::DriveRunArgs),
    /// Drive one agent graph in this process, relaying its envelopes as NDJSON.
    ///
    /// Hidden for the same reason: once the engine has recorded that this
    /// executable answers its command line, a dispatch the retained driver gives
    /// a process of its own is this executable at this verb. It names no run —
    /// it is a graph and a task, exactly as the engine's own takes them.
    #[command(hide = true, name = DRIVE_VERB)]
    Drive(onepipeline::cli::DriveArgs),
}

/// The engine's hidden retained-driver verb, as it spells it on a command line.
///
/// Restated because the engine declares the name privately and spells it on the
/// command line it builds for the process it retains. The drift gate is
/// `tests/e2e/cli.rs`'s `the_hidden_driver_verbs_answer_as_the_engines_own_do`,
/// which hands this binary and the provisioned `onepipeline` the same verb and
/// holds their answers together: a spelling the engine no longer answers fails
/// on the engine's side of that comparison.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] the one source is a private `const` in the engine (`engine::DRIVE_VERB`, `agentgraph::DRIVE_VERB`), so there is no declaration to import; the journey named above is the drift gate, over the engine's own binary.
pub const DRIVE_RUN_VERB: &str = "drive-run";

/// The engine's hidden per-dispatch verb, on the same terms and under the same
/// gate.
// llmlint: ignore[contracts_have_one_source_or_a_drift_gate] as `DRIVE_RUN_VERB` above: the engine declares it privately, and the same journey drives both binaries at this verb.
pub const DRIVE_VERB: &str = "drive";

impl Command {
    /// The subcommand's name as a user typed it.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Serve(_) => "serve",
            Self::DriveRun(_) => DRIVE_RUN_VERB,
            Self::Drive(_) => DRIVE_VERB,
        }
    }
}

/// Where `onepipeline-api serve` reads runs from and what it binds.
#[derive(Debug, Clone, PartialEq, Eq, Args, Serialize, Deserialize)]
pub struct ServeArgs {
    /// Directory holding the recorded runs to serve.
    #[arg(long, value_name = "DIR")]
    pub runs_root: RunsRoot,

    /// Address to bind, as `HOST:PORT`.
    ///
    /// Loopback by default: this serves a local run store and is not
    /// authenticated, so reaching the network is an explicit choice.
    #[arg(long, value_name = "ADDR", default_value = "127.0.0.1:8765")]
    #[serde(default = "default_bind")]
    pub bind: SocketAddr,

    /// How often the event stream re-reads the runs root, in milliseconds.
    ///
    /// The lever between how quickly a live change reaches a browser and how
    /// much of this host's disk the stream costs to hold open. A watched run's
    /// transcripts are re-read a tenth as often, because that read walks every
    /// relayed envelope of the run.
    /// Refused rather than clamped at zero: a poll of no milliseconds is a
    /// request this host cannot honour, and a usage error is the contract for
    /// one — silently correcting it would leave an operator believing the
    /// number they typed is what the stream is doing. The refusal is the
    /// field's type rather than a check on either way in, so the flag and a
    /// config file reject the same number for the same reason.
    #[arg(long, value_name = "MS", default_value_t = DEFAULT_POLL_MS)]
    #[serde(default = "default_poll_ms")]
    pub poll_interval_ms: NonZeroU64,

    /// The launching session this server acts as.
    ///
    /// The one identity every write this server makes carries: it is passed to
    /// the engine's `stop`, `unwatched` and `runs` as the acting session, and it
    /// is what an adoption is recorded under. Omitted, the session
    /// `ONEPIPELINE_LAUNCHER_SESSION` names — the same variable the engine's own
    /// CLI reads — and with neither the server is **unattributed**: it owns no
    /// run, so it is refused every stop it does not force and every adoption.
    #[arg(long, value_name = "ID")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionId>,

    /// Also serve the browser view, at every path the API does not own.
    ///
    /// Off by default, so every caller that asked for the read API alone gets
    /// exactly that. On, the same address serves the DAG Observatory built
    /// into this binary — the view of this same release — at `/`, with
    /// `/api/v2/…` and `/healthz` unchanged, and every path the bundle has no
    /// file for answered with its `index.html` so a deep link opens. A binary
    /// built without the bundle refuses this flag naming what is missing.
    #[arg(long)]
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ui: bool,

    /// Serve the browser view from this directory instead of the built-in one.
    ///
    /// For developing the view against a real runs root — a rebuild reaches
    /// the browser without a restart — and the only way to serve a bundle of
    /// another release. Checked for its `index.html` before the port is taken.
    #[arg(long, value_name = "DIR", requires = "ui")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_dist: Option<UiDist>,
}

/// The variable the launching session is read from when `--session` names
/// none.
///
/// The engine's own: `onepipeline stop`, `adopt` and `unwatched` read the same
/// name, so a server started in a planner's environment acts as that planner
/// without being told twice. Restated because the engine declares it in a
/// private module; `tests/e2e/server.rs` holds the two to one another by
/// starting the server under it and asking `onepipeline` the same question.
pub const SESSION_ENV: &str = "ONEPIPELINE_LAUNCHER_SESSION";

impl ServeArgs {
    /// The session this server acts as, or `None` for an unattributed one.
    ///
    /// The one place the flag and the environment are resolved, so every caller
    /// that needs the acting session — the store, and the environment the
    /// retained driver inherits — reads one answer: `--session`, else
    /// [`SESSION_ENV`], else nobody. The variable crosses the same boundary the
    /// flag does, so a value the flag would refuse is refused here too rather
    /// than acted as.
    ///
    /// # Errors
    ///
    /// When [`SESSION_ENV`] holds a value that is not a session id, which is a
    /// usage error: the operator's environment named a session this process
    /// cannot act as, and acting as nobody instead would be a quiet change of
    /// identity.
    pub fn acting_session(&self) -> Result<Option<SessionId>, String> {
        if let Some(session) = &self.session {
            return Ok(Some(session.clone()));
        }
        match std::env::var(SESSION_ENV) {
            Ok(value) if !value.is_empty() => SessionId::try_from(value)
                .map(Some)
                .map_err(|why| format!("{SESSION_ENV} is not a session id: {why}")),
            _ => Ok(None),
        }
    }

    /// The browser view this server serves beside the API, or `None` for the
    /// API alone.
    ///
    /// `--ui-dist` over the bundle built into this binary, and neither without
    /// `--ui`. Resolved once, before the port is taken, for the same reason the
    /// session is: a refusal belongs at the command line.
    ///
    /// # Errors
    ///
    /// When `--ui` asks for a view this build does not carry and no `--ui-dist`
    /// names one — see [`View::resolve`].
    pub fn view(&self) -> Result<Option<View>, String> {
        View::resolve(self.ui, self.ui_dist.as_ref(), crate::ui::EMBEDDED)
    }
}

/// A launching session id this process may act as.
///
/// An opaque token the launcher minted — the engine compares it byte for byte
/// against the one a launch recorded and never parses it — so the check here is
/// only that it *is* a token: non-empty, bounded, and printable with no
/// whitespace, which is what a value that reaches a launch record, a journal
/// entry and a command line's environment has to be. Both the flag and a
/// configuration file construct it the same way, so neither can carry a session
/// the other would reject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SessionId(String);

/// The longest session id this process acts as.
const SESSION_MAX_LEN: usize = 128;

impl SessionId {
    /// The session, as the engine is handed it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SessionId {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            return Err("a session id must not be empty".to_owned());
        }
        if value.len() > SESSION_MAX_LEN {
            return Err(format!(
                "a session id must be at most {SESSION_MAX_LEN} characters"
            ));
        }
        if !value.chars().all(|c| c.is_ascii_graphic()) {
            return Err("a session id must be printable ASCII with no whitespace".to_owned());
        }
        Ok(Self(value))
    }
}

impl FromStr for SessionId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value.to_owned())
    }
}

impl From<SessionId> for String {
    fn from(value: SessionId) -> Self {
        value.0
    }
}

/// How often the event stream re-reads the runs root when nothing says otherwise.
///
/// The store's own default, not a second copy of the number: the flag exists to
/// override what a store built without one already polls at, so the two saying
/// different things would be a default nobody chose.
pub const DEFAULT_POLL_MS: NonZeroU64 = crate::store::POLL_INTERVAL_MS;

fn default_poll_ms() -> NonZeroU64 {
    DEFAULT_POLL_MS
}

fn default_bind() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 8765))
}

/// A runs directory this process has read.
///
/// The check is the `read_dir` the server does anyway, so a path that is
/// missing, is not a directory, or cannot be opened is a usage error at the
/// command line rather than a failure after the port is bound. The CLI and a
/// configuration file both construct it the same way, so neither can carry a
/// root the other would reject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "PathBuf", into = "PathBuf")]
pub struct RunsRoot(PathBuf);

impl RunsRoot {
    /// The directory, as a path.
    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

impl TryFrom<PathBuf> for RunsRoot {
    type Error = String;

    fn try_from(path: PathBuf) -> Result<Self, Self::Error> {
        match fs::read_dir(&path) {
            Ok(_) => Ok(Self(path)),
            Err(err) => Err(format!(
                "{} is not a readable directory: {}",
                path.display(),
                err.kind()
            )),
        }
    }
}

impl FromStr for RunsRoot {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(PathBuf::from(value))
    }
}

impl From<RunsRoot> for PathBuf {
    fn from(value: RunsRoot) -> Self {
        value.0
    }
}
