//! The command-line surface, and the server configuration it produces.
//!
//! [`ServeArgs`] is both: clap parses it from the command line, and serde reads
//! the same shape from a configuration file, so the two can never describe
//! different servers.

use std::net::SocketAddr;
use std::path::PathBuf;

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
    pub runs_root: PathBuf,

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
