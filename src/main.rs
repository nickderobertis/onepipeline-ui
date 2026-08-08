//! The `onepipeline-ui` binary.
//!
//! Exit codes: `0` on success (`--help`, `--version`), `2` on a usage error
//! (clap), and [`EXIT_NOT_IMPLEMENTED`] when a command parsed but has no
//! implementation yet — which, until the onepipeline SDK dependency lands, is
//! every command. See `docs/contract.md` for the surface being built.

use std::process::ExitCode;

use clap::Parser;
use onepipeline_ui::cli::{Cli, EXIT_NOT_IMPLEMENTED};

fn main() -> ExitCode {
    let cli = Cli::parse();
    eprintln!(
        "onepipeline-ui: `{}` is not implemented.\n\
         This repository currently lands the contract interface only: the types, \
         routes, and argument surface of docs/contract.md compile and are tested, \
         but no server is started.\n\
         ACTION: track https://github.com/nickderobertis/onepipeline-ui for the \
         release that implements it.",
        cli.command.name()
    );
    ExitCode::from(EXIT_NOT_IMPLEMENTED)
}
