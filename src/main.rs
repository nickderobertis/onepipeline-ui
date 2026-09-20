//! The `onepipeline-api` binary.
//!
//! Exit codes are a contract: `0` on success (`--help`, `--version`, a server
//! that was stopped), `2` on a usage error (clap, or a bind this process cannot
//! take), and [`EXIT_SOFTWARE`] when a command parsed but this host would not
//! give the process what it needs. See `docs/contract.md` for what it serves.
//!
//! The two hidden driver verbs are the engine's own, run through the engine's
//! own entry point, and their exit codes are the engine's: a retained driver
//! exits `0` for a graph that settled complete and `1` for one that settled
//! unfinished, exactly as `onepipeline drive-run` does, because the process an
//! adoption leaves behind *is* that verb under another name.

use std::process::ExitCode;

use clap::Parser;
use onepipeline_ui::cli::{Cli, Command, ServeArgs, EXIT_SOFTWARE, SESSION_ENV};
use onepipeline_ui::server;
use onepipeline_ui::store::RunStore;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => serve(&args),
        // Through `onepipeline::run` rather than `verbs::drive_run` alone, and
        // the difference is the whole process model: that entry point is where
        // the engine records that *this executable* answers its command line,
        // which is what lets the driver give each dispatch a process of its own
        // (`drive`, below) instead of running every graph inside itself. The
        // body it dispatches to is `verbs::drive_run`.
        Command::DriveRun(args) => engine(onepipeline::cli::Command::DriveRun(args)),
        Command::Drive(args) => engine(onepipeline::cli::Command::Drive(args)),
    }
}

/// One of the engine's own verbs, run as its binary would run it.
///
/// The engine's `run` reads the runs root and the launching session out of the
/// environment, which is why [`serve`] exports both before it retains anything:
/// the driver inherits them, and so drives the run under the root this server
/// serves as the session this server acts as.
fn engine(command: onepipeline::cli::Command) -> ExitCode {
    match onepipeline::run(onepipeline::cli::Cli { command }) {
        Ok(code) => u8::try_from(code).map_or(ExitCode::from(EXIT_SOFTWARE), ExitCode::from),
        Err(refused) => {
            eprintln!("onepipeline-api: {refused}");
            u8::try_from(refused.exit_code()).map_or(ExitCode::from(EXIT_SOFTWARE), ExitCode::from)
        }
    }
}

fn serve(args: &ServeArgs) -> ExitCode {
    let session = match args.acting_session() {
        Ok(session) => session,
        Err(message) => {
            eprintln!(
                "onepipeline-api: {message}\n\
                 ACTION: name the session this server acts as with --session ID, or unset \
                 {SESSION_ENV}."
            );
            return ExitCode::from(2);
        }
    };
    // Exported before anything else runs, on one thread, because two things
    // read them out of this process's environment rather than being handed
    // them: the SDK's own listing reading, which asks a run's channel under the
    // runs root `ONEPIPELINE_RUNS_DIR` names, and the driver the adopt route
    // retains, which inherits its root and its session from here. A server that
    // served one root while the SDK read channels under another would report a
    // run holding a question as parked.
    std::env::set_var(
        onepipeline_ui::store::RUNS_DIR_ENV,
        args.runs_root.as_path(),
    );
    match &session {
        Some(session) => std::env::set_var(SESSION_ENV, session.as_str()),
        // Unattributed means unattributed for the driver too: a session the
        // environment happened to carry but the flag did not name is not one
        // this server acts as, and `acting_session` has already ruled on it.
        None => std::env::remove_var(SESSION_ENV),
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!(
                "onepipeline-api: cannot start an async runtime: {err}\n\
                 ACTION: this host could not create the threads the server needs; \
                 check its thread and file-descriptor limits."
            );
            return ExitCode::from(EXIT_SOFTWARE);
        }
    };
    let store = RunStore::new_polling_every(&args.runs_root, args.poll_interval_ms)
        .acting_as(session.as_ref());
    let listener = match runtime.block_on(server::bind(args.bind)) {
        Ok(listener) => listener,
        Err(message) => {
            eprintln!(
                "onepipeline-api: {message}\n\
                 ACTION: choose a free address with --bind HOST:PORT, or stop \
                 whatever is holding this one."
            );
            return ExitCode::from(2);
        }
    };
    // Installed before the address is announced: a supervisor that connects on
    // that line and immediately says stop must be answered by the handler, not
    // by the default disposition that kills the process.
    let stop = runtime.block_on(async { server::StopSignal::install() });
    // Printed *after* the bind and before the accept loop, and naming the
    // address the kernel actually gave: a supervisor that waits for this line
    // can connect on the next one, and `--bind 127.0.0.1:0` reports the port it
    // was handed rather than the zero it asked for.
    match listener.local_addr() {
        Ok(address) => println!(
            "onepipeline-api: serving {} on http://{address}",
            args.runs_root.as_path().display()
        ),
        Err(err) => eprintln!("onepipeline-api: bound, but cannot name the address: {err}"),
    }
    match runtime.block_on(server::serve(store, listener, stop)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("onepipeline-api: {message}\nACTION: check the server log above.");
            ExitCode::from(EXIT_SOFTWARE)
        }
    }
}
