//! `onepipeline-api serve`, sampled: the server the crate's own binary runs, with a
//! CPU-time sampler over every thread. The folded stacks are written to the file
//! `ONEPIPELINE_UI_PROFILE` names when the process is stopped; unset, no sampler runs
//! and the binary is the server. `SIGTERM` reaches the server's own stop handler,
//! which is what lets `serve` return and the report run.

use std::io::Write;

use clap::Parser;
use onepipeline_ui::cli::{Cli, Command};
use onepipeline_ui::server;
use onepipeline_ui::store::RunStore;

fn main() {
    let Cli { command } = Cli::parse();
    let Command::Serve(args) = command;
    let session = args.acting_session().expect("a session");
    std::env::set_var(onepipeline_ui::store::RUNS_DIR_ENV, args.runs_root.as_path());
    if let Some(session) = &session {
        std::env::set_var(onepipeline_ui::cli::SESSION_ENV, session.as_str());
    }
    let hz: i32 = std::env::var("ONEPIPELINE_UI_PROFILE_HZ")
        .ok()
        .and_then(|hz| hz.parse().ok())
        .unwrap_or(99);
    let profile = std::env::var("ONEPIPELINE_UI_PROFILE").ok();
    let guard = profile.as_ref().map(|_| {
        pprof::ProfilerGuardBuilder::default()
            .frequency(hz)
            .blocklist(&["libc", "libgcc", "pthread", "vdso"])
            .build()
            .expect("the sampler starts")
    });
    let view = args.view().expect("the view");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let store = RunStore::new_polling_every(&args.runs_root, args.poll_interval_ms)
        .acting_as(session.as_ref());
    let listener = runtime
        .block_on(server::bind(args.bind))
        .expect("the bind");
    let stop = runtime.block_on(async { server::StopSignal::install() });
    println!(
        "onepipeline-api: serving on http://{}",
        listener.local_addr().expect("an address")
    );
    runtime
        .block_on(server::serve_with_view(store, listener, stop, view))
        .expect("the server");
    let (Some(guard), Some(path)) = (guard, profile) else {
        return;
    };
    let report = guard.report().build().expect("the report");
    let mut out = std::fs::File::create(path).expect("the profile file");
    for (frames, count) in &report.data {
        let mut names: Vec<String> = frames
            .frames
            .iter()
            .rev()
            .flat_map(|symbols| symbols.iter().rev().map(pprof::Symbol::name))
            .collect();
        names.insert(0, frames.thread_name.clone());
        writeln!(out, "{} {count}", names.join(";")).expect("the profile line");
    }
}
