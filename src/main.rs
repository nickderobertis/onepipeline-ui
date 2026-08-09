//! The `onepipeline-ui` binary.
//!
//! Exit codes are a contract: `0` on success (`--help`, `--version`, a server
//! that was stopped), `2` on a usage error (clap, or a bind this process cannot
//! take), and [`EXIT_SOFTWARE`] when a command parsed but this host would not
//! give the process what it needs. See `docs/contract.md` for what it serves.

use std::process::ExitCode;

use clap::Parser;
use onepipeline_ui::cli::{Cli, Command, EXIT_SOFTWARE};
use onepipeline_ui::server;
use onepipeline_ui::store::RunStore;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match &cli.command {
        Command::Serve(args) => serve(args),
    }
}

fn serve(args: &onepipeline_ui::cli::ServeArgs) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!(
                "onepipeline-ui: cannot start an async runtime: {err}\n\
                 ACTION: this host could not create the threads the server needs; \
                 check its thread and file-descriptor limits."
            );
            return ExitCode::from(EXIT_SOFTWARE);
        }
    };
    let store = RunStore::new_polling_every(
        &args.runs_root,
        std::time::Duration::from_millis(args.poll_interval_ms.max(1)),
    );
    let listener = match runtime.block_on(server::bind(args.bind)) {
        Ok(listener) => listener,
        Err(message) => {
            eprintln!(
                "onepipeline-ui: {message}\n\
                 ACTION: choose a free address with --bind HOST:PORT, or stop \
                 whatever is holding this one."
            );
            return ExitCode::from(2);
        }
    };
    // Printed *after* the bind and before the accept loop, and naming the
    // address the kernel actually gave: a supervisor that waits for this line
    // can connect on the next one, and `--bind 127.0.0.1:0` reports the port it
    // was handed rather than the zero it asked for.
    match listener.local_addr() {
        Ok(address) => println!(
            "onepipeline-ui: serving {} on http://{address}",
            args.runs_root.as_path().display()
        ),
        Err(err) => eprintln!("onepipeline-ui: bound, but cannot name the address: {err}"),
    }
    match runtime.block_on(server::serve(store, listener)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("onepipeline-ui: {message}\nACTION: check the server log above.");
            ExitCode::from(EXIT_SOFTWARE)
        }
    }
}
