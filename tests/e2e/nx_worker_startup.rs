//! Real Nx task-graph resolution with a stalled host event loop. Its own tier
//! keeps the deliberate worker deadline wait out of unrelated tooling checks.

use tempfile::TempDir;

use crate::ensure_sibling::{assert_view_task_graph, view_task_graph};

#[test]
fn view_graph_survives_a_worker_load_message_delayed_past_nx_deadline() {
    let scratch = TempDir::new().expect("graph scratch directory");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/nx/delay-worker-load.mjs");
    // Unix permits a literal backslash in a filename; Windows supplies them as
    // path separators. Exercise NODE_OPTIONS escaping on either platform.
    let filename = if cfg!(unix) {
        "worker \\ preload.mjs"
    } else {
        "worker preload.mjs"
    };
    let preload = scratch.path().join(filename);
    std::fs::copy(fixture, &preload).expect("copy the real worker-delay preload");
    // NODE_OPTIONS consumes backslashes as escapes even inside quotes. Pass
    // an escaped, quoted path so separators and spaces reach Node's loader.
    let escaped = preload
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let options = format!("--require \"{escaped}\"");
    let run = |before_fix| {
        let mut command = view_task_graph();
        if before_fix {
            command.env("NX_ISOLATE_PLUGINS", "true");
        }
        command
            .env("NODE_OPTIONS", &options)
            .env("NX_PLUGIN_NO_TIMEOUTS", "false")
            .env("NX_CACHE_PROJECT_GRAPH", "false")
            .env("NX_WORKSPACE_DATA_DIRECTORY", scratch.path())
            .output()
            .expect("just is on PATH")
    };
    let before = run(true);
    assert!(
        !before.status.success(),
        "isolated graph unexpectedly passed"
    );
    let diagnostic = String::from_utf8_lossy(&before.stderr);
    assert!(
        diagnostic.contains("stalling Nx host past worker load deadline")
            && diagnostic.contains("did not receive a load message within 10 seconds"),
        "the induced failure was not Nx's worker load deadline:\n{diagnostic}"
    );
    let after = run(false);
    assert_view_task_graph(&after);
    assert!(
        !String::from_utf8_lossy(&after.stderr).contains("stalling Nx host"),
        "in-process graph resolution unexpectedly started a worker"
    );
}
