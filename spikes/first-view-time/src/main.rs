//! `onepipeline-api serve` for the first-view-time spike: the crate's own serve path
//! over the patched engine, with a CPU-time sampler over every thread when
//! `ONEPIPELINE_UI_PROFILE` names a file, to which the folded stacks are written when
//! the server is stopped. Unset, no sampler runs and this is the server. Its switches
//! are `onepipeline_ui::spike`'s, all off by default.

use std::io::Write;

use clap::Parser;
use onepipeline_ui::cli::{Cli, Command, SESSION_ENV};
use onepipeline_ui::server;
use onepipeline_ui::store::RunStore;

fn main() {
    let Cli { command } = Cli::parse();
    let Command::Serve(args) = command;
    let session = args.acting_session().expect("a session");
    let view = args.view().expect("the view");
    std::env::set_var(
        onepipeline_ui::store::RUNS_DIR_ENV,
        args.runs_root.as_path(),
    );
    match &session {
        Some(session) => std::env::set_var(SESSION_ENV, session.as_str()),
        None => std::env::remove_var(SESSION_ENV),
    }
    let hz: i32 = std::env::var("ONEPIPELINE_UI_PROFILE_HZ")
        .ok()
        .and_then(|hz| hz.parse().ok())
        .unwrap_or(997);
    let profile = std::env::var("ONEPIPELINE_UI_PROFILE").ok();
    let guard = profile.as_ref().map(|_| {
        pprof::ProfilerGuardBuilder::default()
            .frequency(hz)
            .blocklist(&["libc", "libgcc", "pthread", "vdso"])
            .build()
            .expect("the sampler starts")
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let store = RunStore::new_polling_every(&args.runs_root, args.poll_interval_ms)
        .acting_as(session.as_ref());
    let listener = runtime.block_on(server::bind(args.bind)).expect("the bind");
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
