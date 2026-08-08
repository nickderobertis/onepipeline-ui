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
use std::path::{Path, PathBuf};
use std::process::Command;

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
    format!("onepipeline-ui-cli-{platform}-{arch}")
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
    copy_tree(&launcher, &modules.join("onepipeline-ui-cli"));
    if with_platform {
        let binary = assert_cmd::cargo::cargo_bin("onepipeline-ui");
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
    modules.join("onepipeline-ui-cli/bin/onepipeline-ui.js")
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
    let runs = tempfile::tempdir().expect("temp dir");
    let output = run_launcher(
        &entry,
        &[
            "serve",
            "--runs-root",
            runs.path().to_str().expect("utf-8 path"),
        ],
    );
    // A caller scripting against the documented exit codes has to see the
    // binary's, not the shim's.
    assert_eq!(output.status.code(), Some(70));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("`serve` is not implemented"),
        "the shim swallowed the binary's diagnostics"
    );
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
        stderr.contains("pip install onepipeline-ui-cli"),
        "{stderr}"
    );
    assert!(stderr.contains("cargo install onepipeline-ui"), "{stderr}");
}
