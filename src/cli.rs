//! The command-line surface, and the server configuration it produces.
//!
//! [`ServeArgs`] is both: clap parses it from the command line, and serde reads
//! the same shape from a configuration file, so the two can never describe
//! different servers — and both reach the run store through [`RunsRoot`], which
//! only exists once the directory has been read.

use std::fs;
use std::net::SocketAddr;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum Command {
    /// Serve the read API described in docs/contract.md.
    Serve(ServeArgs),
}

impl Command {
    /// The subcommand's name as a user typed it.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Serve(_) => "serve",
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
    #[arg(long, value_name = "ADDR", default_value_t = default_bind())]
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

/// The address this server binds when nothing says otherwise.
///
/// The one spelling of it: the flag's own default is rendered from this rather
/// than written beside it as a string, and `tests/contract.rs` holds the
/// browser's proxy default to it — that copy is in TypeScript and cannot read
/// this, and the two disagreeing is a `just dag-ui` that proxies to a port
/// nothing is listening on.
pub fn default_bind() -> SocketAddr {
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
