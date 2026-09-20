//! The `onepipeline` CLI the journeys compare the server against.
//!
//! The server itself runs no `onepipeline` binary — every verb it serves is a
//! call into the SDK it links — so the only thing that still needs the sibling
//! provisioned is a journey asking whether what the server served is what the
//! CLI prints over the same run: the telemetry document, and whether a run is
//! being watched. `just _ensure-sibling` provisions it at the release the lock
//! pins the library to, and exports its path under [`BINARY_ENV`]; a journey
//! run outside `just` reads the same clone-local path, and never a build on
//! `PATH` — a different release prints a different document, and comparing
//! against one is the failure the pin exists to prevent.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The variable the justfile exports the provisioned CLI's path under.
///
/// A test-side name now: the server no longer reads it, and the recipe that
/// exports it is the one the journeys here depend on. Held to the justfile by
/// [`binary`], which refuses a justfile that no longer exports it.
pub const BINARY_ENV: &str = "ONEPIPELINE_UI_ONEPIPELINE_BIN";

/// Where the clone provisions the CLI: `.tools/bin`, as `_ensure-sibling`
/// writes it.
fn provisioned() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(".tools/bin")
        .join(format!("onepipeline{}", std::env::consts::EXE_SUFFIX))
}

/// The executable: the one the clone provisions, and nothing else.
///
/// The environment is read and **held** rather than trusted: what this names
/// is a program these journeys start, and one that is anything but the
/// provisioned sibling makes every comparison here a comparison against a
/// release nobody pinned. So a value the justfile exported has to be the path
/// the recipe writes, the justfile has to export it under this name, and the
/// path returned is the provisioned one either way.
pub fn binary() -> String {
    let justfile = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("justfile"))
        .expect("the justfile reads");
    assert!(
        justfile.contains(&format!("export {BINARY_ENV} :=")),
        "the justfile no longer exports {BINARY_ENV}; this helper reads the name the recipe \
         exports, so one of the two has moved"
    );
    let provisioned = provisioned();
    if let Some(named) = std::env::var_os(BINARY_ENV).filter(|value| !value.is_empty()) {
        assert_eq!(
            PathBuf::from(&named),
            provisioned,
            "{BINARY_ENV} names a path this clone does not provision to; run the \
             `onepipeline-ui:ensure-sibling` target, which exports the one it writes"
        );
    }
    provisioned.display().to_string()
}

/// One `onepipeline` invocation over `root`, as `session`, with its whole output.
///
/// The root and the session go through the engine's own environment, which is
/// where its binary reads them, so the CLI and the server are asked the same
/// question about the same store.
pub fn run(root: &Path, session: Option<&str>, arguments: &[&str]) -> Output {
    let mut command = Command::new(binary());
    command
        .args(arguments)
        .env(onepipeline_ui::store::RUNS_DIR_ENV, root)
        .env_remove(onepipeline_ui::cli::SESSION_ENV);
    if let Some(session) = session {
        command.env(onepipeline_ui::cli::SESSION_ENV, session);
    }
    command.output().unwrap_or_else(|err| {
        panic!(
            "cannot start `{}`: {err} — run `just bootstrap` to provision the engine CLI the \
             lock pins, or name one with {BINARY_ENV}",
            binary()
        )
    })
}

/// The telemetry document `onepipeline telemetry RUN` prints for `run`, as the
/// SDK's own type reads it back.
pub fn telemetry(root: &Path, run: &str) -> onepipeline::views::RunTelemetry {
    let output = run_or_panic(root, &["telemetry", run]);
    let line = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(line.trim()).unwrap_or_else(|err| {
        panic!("`onepipeline telemetry {run}` printed something that is not its document: {err}: {line}")
    })
}

fn run_or_panic(root: &Path, arguments: &[&str]) -> Output {
    let output = run(root, None, arguments);
    assert!(
        output.status.success(),
        "`{} {}` refused: {}",
        binary(),
        arguments.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}
