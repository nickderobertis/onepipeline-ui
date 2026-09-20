//! The binary's own argument journeys.
//!
//! What `serve` *serves* is `server.rs`; this is everything a user meets before
//! a port is taken — the version, the help, and every argument the process
//! refuses rather than starting on. The exit codes here are the contract
//! AGENTS.md fixes, spelled out as the numbers a shell sees.

use assert_cmd::Command;
use predicates::str::contains;

/// Clap's usage-error status.
const USAGE: i32 = 2;

fn cli() -> Command {
    Command::cargo_bin("onepipeline-api").expect("the binary is built")
}

#[test]
fn version_reports_the_crate_version() {
    cli()
        .arg("--version")
        .assert()
        .success()
        .stdout(contains(env!("CARGO_PKG_VERSION")))
        .stdout(contains("onepipeline-api"));
}

#[test]
fn help_documents_the_serve_command() {
    cli()
        .arg("--help")
        .assert()
        .success()
        .stdout(contains("serve"))
        .stdout(contains("Serve the read API"));
}

#[test]
fn serve_help_documents_its_arguments() {
    cli()
        .args(["serve", "--help"])
        .assert()
        .success()
        .stdout(contains("--runs-root"))
        .stdout(contains("--bind"))
        .stdout(contains("--poll-interval-ms"))
        .stdout(contains("127.0.0.1:8765"));
}

#[test]
fn a_bind_something_else_is_holding_is_a_usage_error_that_names_it() {
    let held = std::net::TcpListener::bind("127.0.0.1:0").expect("hold a port");
    let address = held.local_addr().expect("the held address");
    let runs = tempfile::tempdir().expect("temp dir");
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .args(["--bind", &address.to_string()])
        .assert()
        .code(USAGE)
        .stderr(contains(format!("cannot bind {address}")))
        .stderr(contains("ACTION:"));
}

#[test]
fn serve_needs_a_runs_root() {
    cli()
        .arg("serve")
        .assert()
        .code(USAGE)
        .stderr(contains("--runs-root"))
        .stderr(contains("Usage"));
}

/// A poll of no milliseconds is refused rather than corrected: the operator has
/// to learn that the number they typed is not what the stream would do.
#[test]
fn a_poll_of_no_milliseconds_is_a_usage_error() {
    let runs = tempfile::tempdir().expect("temp dir");
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .args(["--poll-interval-ms", "0"])
        .assert()
        .code(USAGE)
        .stderr(contains("--poll-interval-ms"));
}

#[test]
fn a_runs_root_that_does_not_exist_is_rejected_before_anything_starts() {
    cli()
        .args(["serve", "--runs-root", "/no/such/runs/root"])
        .assert()
        .code(USAGE)
        .stderr(contains("/no/such/runs/root is not a readable directory"));
}

#[test]
fn a_runs_root_that_is_a_file_is_rejected() {
    let file = tempfile::NamedTempFile::new().expect("temp file");
    cli()
        .args(["serve", "--runs-root"])
        .arg(file.path())
        .assert()
        .code(USAGE)
        // The reason the OS gave, not one this crate guessed: a root that
        // exists but is a file, one whose permissions deny the read, and one
        // that is missing all reach the user as what actually stopped them.
        .stderr(contains("is not a readable directory: not a directory"));
}

/// A directory that exists but cannot be opened. Unix-only: this is a POSIX
/// permission bit, and Windows denies a directory read through an ACL the same
/// journey cannot set.
#[cfg(unix)]
#[test]
fn a_runs_root_that_cannot_be_read_is_rejected() {
    use std::os::unix::fs::PermissionsExt;

    let runs = tempfile::tempdir().expect("temp dir");
    std::fs::set_permissions(runs.path(), std::fs::Permissions::from_mode(0o000))
        .expect("drop the read bit");
    let assertion = cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .assert();
    // Restored before asserting, so a failure here cannot also leave an
    // unremovable directory behind.
    std::fs::set_permissions(runs.path(), std::fs::Permissions::from_mode(0o700))
        .expect("restore the read bit");
    assertion
        .code(USAGE)
        .stderr(contains("is not a readable directory: permission denied"));
}

#[test]
fn a_bind_address_is_validated_at_the_edge() {
    let runs = tempfile::tempdir().expect("temp dir");
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .args(["--bind", "not-an-address"])
        .assert()
        .code(USAGE)
        .stderr(contains("not-an-address"));
}

/// The session the environment names crosses the same boundary the flag does:
/// a value the flag would refuse is a usage error rather than a server acting
/// as nobody, which would be a quiet change of identity.
#[test]
fn a_session_the_environment_names_that_is_not_one_is_a_usage_error() {
    let runs = tempfile::tempdir().expect("temp dir");
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .env(onepipeline_ui::cli::SESSION_ENV, "has a space")
        .assert()
        .code(USAGE)
        .stderr(contains("ONEPIPELINE_LAUNCHER_SESSION is not a session id"))
        .stderr(contains("ACTION:"));
}

#[test]
fn a_command_the_cli_does_not_have_is_a_usage_error() {
    cli()
        .arg("browse")
        .assert()
        .code(USAGE)
        .stderr(contains("unrecognized subcommand 'browse'"))
        .stderr(contains("try '--help'"));
}

#[test]
fn no_command_at_all_is_a_usage_error() {
    cli().assert().code(USAGE).stderr(contains("Usage"));
}

/// The two hidden driver verbs are the engine's own, and this is the drift
/// gate on their spelling and their shape: the binary and the provisioned
/// `onepipeline` are given the same arguments, and answer the same way.
///
/// A dispatch cannot be driven here — a graph's members are agents on a
/// harness — so what is driven is everything before one: the verb parses the
/// engine's own arguments, runs the engine's own entry, and refuses in the
/// engine's own words with the engine's own exit code. A spelling the engine
/// no longer answers would fail on its side of the comparison first, which is
/// what makes the constants in `src/cli.rs` a reading of the SDK rather than a
/// second copy of it.
#[test]
fn the_hidden_driver_verbs_answer_as_the_engines_own_do() {
    let scratch = tempfile::tempdir().expect("temp dir");
    let dir = scratch.path().to_str().expect("utf-8 path");
    for (arguments, said) in [
        (
            vec!["drive", "graphs/nope.yaml", "--task", "do it", "--dir", dir],
            "invalid config: cannot read graphs/nope.yaml",
        ),
        (
            vec!["drive-run", "run-that-is-not-there", "--adopt"],
            "no such run 'run-that-is-not-there'",
        ),
    ] {
        let ours = cli()
            .args(&arguments)
            .env("ONEPIPELINE_RUNS_DIR", dir)
            .output()
            .expect("the binary runs");
        let theirs = std::process::Command::new(crate::sibling::binary())
            .args(&arguments)
            .env("ONEPIPELINE_RUNS_DIR", dir)
            .output()
            .expect("the provisioned onepipeline runs — `just bootstrap` provisions it");
        assert_eq!(
            ours.status.code(),
            theirs.status.code(),
            "{}: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&ours.stderr)
        );
        assert_eq!(
            ours.status.code(),
            Some(USAGE),
            "the engine's own refusal code"
        );
        // The one thing the two lines cannot share is the program's own name
        // in front of the refusal.
        let refusal = |output: &std::process::Output| {
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .split_once(": ")
                .map(|(_, rest)| rest.to_owned())
                .unwrap_or_default()
        };
        assert_eq!(refusal(&ours), refusal(&theirs), "{}", arguments.join(" "));
        assert!(refusal(&ours).contains(said), "{}", refusal(&ours));
    }
    // Hidden: neither is a verb an operator is offered.
    let help = cli().arg("--help").output().expect("the binary runs");
    assert!(help.status.success());
    assert!(
        !String::from_utf8_lossy(&help.stdout).contains("drive"),
        "{}",
        String::from_utf8_lossy(&help.stdout)
    );
}
