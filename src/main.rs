//! The `onepipeline-api` binary.
//!
//! Exit codes are a contract: `0` on success (`--help`, `--version`, a server
//! that was stopped), `2` on a usage error (clap, or a bind this process cannot
//! take), and [`EXIT_SOFTWARE`] when a command parsed but this host would not
//! give the process what it needs. See `docs/contract.md` for what it serves.
//!
use std::process::ExitCode;

use clap::Parser;
use onepipeline_ui::cli::{Cli, Command, ServeArgs, EXIT_SOFTWARE, SESSION_ENV};
use onepipeline_ui::server;
use onepipeline_ui::store::RunStore;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => serve(&args),
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
    // Resolved before the port is taken, like the session: a `--ui` this build
    // cannot honour is a refusal at the command line rather than a server that
    // answers `/` with nothing.
    let view = match args.view() {
        Ok(view) => view,
        Err(message) => {
            eprintln!(
                "onepipeline-api: {message}\n\
                 ACTION: serve a built view with --ui-dist DIR, or install a prebuilt \
                 onepipeline-api of this release, which carries it."
            );
            return ExitCode::from(EXIT_SOFTWARE);
        }
    };
    // Exported before threads start: the SDK's listing reads channels under
    // ONEPIPELINE_RUNS_DIR, and its advice reads the acting session. Those reads
    // must agree with the root and session the server was given.
    std::env::set_var(
        onepipeline_ui::store::RUNS_DIR_ENV,
        args.runs_root.as_path(),
    );
    match &session {
        Some(session) => std::env::set_var(SESSION_ENV, session.as_str()),
        // An unattributed server must also leave the SDK's advice unattributed.
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
    // The view, when there is one, is named on the same line — before the
    // address, which stays last so a supervisor reading the address off the
    // end of the line reads the same line whether or not the view is served.
    let what = match &view {
        Some(view) => format!(
            "{} and {}",
            args.runs_root.as_path().display(),
            view.describe()
        ),
        None => args.runs_root.as_path().display().to_string(),
    };
    match listener.local_addr() {
        Ok(address) => println!("onepipeline-api: serving {what} on http://{address}"),
        Err(err) => eprintln!("onepipeline-api: bound, but cannot name the address: {err}"),
    }
    match runtime.block_on(server::serve_with_view(store, listener, stop, view)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("onepipeline-api: {message}\nACTION: check the server log above.");
            ExitCode::from(EXIT_SOFTWARE)
        }
    }
}
