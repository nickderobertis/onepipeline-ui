//! The npm distribution's journeys.
//!
//! Every test here reaches the command a user typed: the packages are assembled
//! for real, and the committed launcher runs under a real node, resolving its
//! platform package through node's own module resolution. Nothing about that
//! resolution is simulated — which matters, because the launcher's whole job is
//! that resolution, and it is the one part of the pipeline a release job would
//! otherwise discover broken in public.
//!
//! What the *packages* must contain, rather than what running them does, is
//! `tests/packaging.rs`.

use std::fs;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(unix)]
use std::process::Stdio;

#[cfg(unix)]
use crate::http;
#[cfg(unix)]
use crate::serving::{self, Stop, STOP_DEADLINE};

/// The Rust target triple for the host, as `.github/workflows/release.yml`
/// spells it. The release matrix builds exactly these five, so a host outside
/// them is a platform this repo does not ship — a failure to see, not to skip.
fn host_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        (os, arch) => panic!(
            "no release target for {os}/{arch}; add it to the matrix in \
             .github/workflows/release.yml, scripts/npm-build.mjs, and the \
             launcher's PACKAGES map, or drop this host"
        ),
    }
}

/// The npm platform package name for the host, as the launcher's `PACKAGES` map
/// spells it.
fn host_package() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("onepipeline-api-cli-{platform}-{arch}")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Run `scripts/npm-build.mjs` and return the package directory it printed.
fn npm_build(args: &[&str]) -> PathBuf {
    let output = Command::new("node")
        .arg(repo_root().join("scripts/npm-build.mjs"))
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("node is on PATH");
    assert!(
        output.status.success(),
        "npm-build.mjs {args:?} failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    PathBuf::from(String::from_utf8(output.stdout).expect("utf-8 path").trim())
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create destination");
    for entry in fs::read_dir(from).expect("read source") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

/// Assemble the launcher and, when `with_platform`, the host's platform package
/// into a node-resolvable tree, and return the launcher's entry point.
fn install(root: &Path, with_platform: bool) -> PathBuf {
    let staging = root.join("staging");
    let modules = root.join("node_modules");
    let launcher = npm_build(&["launcher", "--out", staging.to_str().expect("utf-8 path")]);
    copy_tree(&launcher, &modules.join("onepipeline-api-cli"));
    if with_platform {
        let binary = assert_cmd::cargo::cargo_bin("onepipeline-api");
        let platform = npm_build(&[
            "platform",
            "--target",
            host_target(),
            "--binary",
            binary.to_str().expect("utf-8 path"),
            "--out",
            staging.to_str().expect("utf-8 path"),
        ]);
        copy_tree(&platform, &modules.join(host_package()));
    }
    modules.join("onepipeline-api-cli/bin/onepipeline-api.js")
}

fn run_launcher(entry: &Path, args: &[&str]) -> std::process::Output {
    Command::new("node")
        .arg(entry)
        .args(args)
        .output()
        .expect("node is on PATH")
}

#[test]
fn the_launcher_runs_the_binary_its_platform_package_carries() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let output = run_launcher(&entry, &["--version"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains(env!("CARGO_PKG_VERSION")), "{stdout}");
}

#[test]
fn the_launcher_propagates_the_binarys_exit_code_and_stderr() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let output = run_launcher(&entry, &["serve", "--runs-root", "/no/such/runs/root"]);
    // A caller scripting against the documented exit codes has to see the
    // binary's `2`, not the shim's own `1` — which is what it exits when the
    // resolution it exists to do fails.
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("is not a readable directory"),
        "the shim swallowed the binary's diagnostics"
    );
}

/// Kill whatever the launcher left behind, so a failing journey cannot leave a
/// server listening for as long as the machine is up.
///
/// The launcher is spawned as its own process group leader, which is what lets
/// this reach the binary *it* started — the defect this journey exists for is
/// precisely a launcher that exits without taking that binary with it, and there
/// is no other handle on the grandchild. Disarmed on the way out of a journey
/// that proved the group is already empty.
#[cfg(unix)]
struct Survivors {
    group: i32,
    armed: bool,
}

#[cfg(unix)]
impl Survivors {
    fn of(launcher: &std::process::Child) -> Self {
        Self {
            group: i32::try_from(launcher.id()).expect("a pid fits in an i32"),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(unix)]
impl Drop for Survivors {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // SAFETY: `group` is the pid of a process this journey spawned as its
        // own group leader, so the negated pid names that group and nothing
        // else. Only reached on the failure path, where that group still has a
        // live member holding the pid — the success path disarms first.
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
    }
}

/// The npm distribution's shutdown journey: a launcher asked to stop passes it
/// on, and answers with the status the server chose.
///
/// This is the whole of what `scripts/smoke-published.sh` asks a published
/// artifact to do — serve on a kernel-chosen port, answer `/healthz`, then stop
/// on a signal and exit `0` — run against the launcher a user actually types.
/// It is the command a supervisor signals, so it and not the binary is what has
/// to survive the signal: nothing here can be proven by starting the binary
/// directly, which is why v0.3.1 shipped exiting 143.
#[cfg(unix)]
fn assert_the_launcher_stops_the_server(stop: Stop) {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let runs = tempfile::tempdir().expect("runs root");
    let mut launcher = Command::new("node")
        .arg(&entry)
        .arg("serve")
        .arg("--runs-root")
        .arg(runs.path())
        .args(["--bind", "127.0.0.1:0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0)
        .spawn()
        .expect("node is on PATH");
    let mut survivors = Survivors::of(&launcher);

    // The server's own startup line, read through the launcher's inherited
    // stdout — so this also proves the launcher did not swallow it.
    let address = serving::address_of(&mut launcher);
    assert_eq!(
        http::get(address, "/healthz").status,
        200,
        "the launcher started something that does not serve"
    );

    serving::ask_to_stop(&mut launcher, stop);
    let status = serving::wait_within(&mut launcher, STOP_DEADLINE);
    assert_eq!(
        status.code(),
        Some(0),
        "a supervisor stopping the launcher must see the server's own clean exit, not a kill: {status}"
    );
    // And the stop reached the *binary*, not only the shim: a launcher that
    // exits on its own and leaves the server running is a stop that did not
    // happen, however clean its status looks.
    assert!(
        std::net::TcpStream::connect(address).is_err(),
        "the launcher exited but the server it started is still listening on {address}"
    );
    survivors.disarm();
}

/// Unix only, for the reason `tests/support/serving.rs` gives and
/// `scripts/smoke-published.sh` repeats: Windows offers a parent no way to *ask*.
#[cfg(unix)]
#[test]
fn the_launcher_stops_the_server_when_a_supervisor_asks() {
    assert_the_launcher_stops_the_server(Stop::Terminate);
}

#[cfg(unix)]
#[test]
fn the_launcher_stops_the_server_on_a_terminals_interrupt() {
    assert_the_launcher_stops_the_server(Stop::Interrupt);
}

#[test]
fn a_missing_platform_package_fails_with_the_other_install_paths() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), false);
    let output = run_launcher(&entry, &["--version"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(&host_package()), "{stderr}");
    assert!(stderr.contains("optional dependencies"), "{stderr}");
    assert!(
        stderr.contains("pip install onepipeline-api-cli"),
        "{stderr}"
    );
    assert!(stderr.contains("cargo install onepipeline-ui"), "{stderr}");
}
