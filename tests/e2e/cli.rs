//! The binary's own journeys.
//!
//! Every command this crate exposes parses today and refuses today: the read API
//! is landed interface-only (see `docs/contract.md`). These journeys are what
//! keep "refuses" honest — a `serve` that started something, or one that failed
//! with a bare usage error instead of saying why, would fail here.

use assert_cmd::Command;
use predicates::str::contains;

/// The exit status a parsed-but-unimplemented command leaves. Mirrors
/// `onepipeline_ui::cli::EXIT_NOT_IMPLEMENTED`, spelled out here so the journey
/// asserts the number a user's shell sees rather than the constant's own value.
const NOT_IMPLEMENTED: i32 = 70;

/// Clap's usage-error status.
const USAGE: i32 = 2;

fn cli() -> Command {
    Command::cargo_bin("onepipeline-ui").expect("the binary is built")
}

#[test]
fn version_reports_the_crate_version() {
    cli()
        .arg("--version")
        .assert()
        .success()
        .stdout(contains(env!("CARGO_PKG_VERSION")))
        .stdout(contains("onepipeline-ui"));
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
        .stdout(contains("127.0.0.1:8765"));
}

#[test]
fn serve_refuses_loudly_and_starts_nothing() {
    let runs = tempfile::tempdir().expect("temp dir");
    cli()
        .args(["serve", "--runs-root"])
        .arg(runs.path())
        .assert()
        .code(NOT_IMPLEMENTED)
        .stdout(predicates::str::is_empty())
        .stderr(contains("`serve` is not implemented"))
        .stderr(contains("contract interface only"))
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
