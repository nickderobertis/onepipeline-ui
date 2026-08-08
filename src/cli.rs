//! The command-line surface, and the server configuration it produces.
//!
//! [`ServeArgs`] is both: clap parses it from the command line, and serde reads
//! the same shape from a configuration file, so the two can never describe
//! different servers — and both reach the run store through [`RunsRoot`], which
//! only exists once the directory has been read.

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};

/// Exit status when a parsed command has no implementation yet.
///
/// `sysexits.h`'s `EX_SOFTWARE`. The command surface is real and its arguments
/// are validated; what is missing is behind it, which is an internal-software
/// condition rather than a usage error (clap's `2`).
pub const EXIT_NOT_IMPLEMENTED: u8 = 70;

/// Serve and inspect the onepipeline read API.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "onepipeline-ui", version, about, long_about = None)]
pub struct Cli {
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The subcommands `onepipeline-ui` accepts.
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

/// Where `onepipeline-ui serve` reads runs from and what it binds.
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
