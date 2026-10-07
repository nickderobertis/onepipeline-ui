//! The workspace's install: `scripts/workspace-install.sh`, over a fresh copy of
//! this checkout with no `node_modules` at all.
//!
//! Every recipe reaches the TypeScript workspace through this one script —
//! `scripts/nx.sh` runs it before every Nx invocation — so what a fresh clone
//! gets is decided here: bun installing exactly what `bun.lock` pins, or a
//! refusal that names the fix. These journeys run the real script with the real
//! bun this checkout was bootstrapped with, then run a real Nx target over what
//! it installed. The one substitution is the bun-below-the-floor journey's, which
//! puts a program on PATH that reports an older version: no installed bun can be
//! made older, and that journey asserts the stand-in was never asked to install.
//!
//! Unix only for the reason `nx_affected` is: the script is bash, and the
//! bun-absent journey builds its search path out of symlinks. The macOS leg runs
//! it.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A copy of every file this checkout carries, and nothing it installed.
struct Checkout {
    dir: TempDir,
}

impl Checkout {
    fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let listed = Command::new("git")
            .args([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ])
            .current_dir(repo_root())
            .output()
            .expect("git is on PATH");
        assert!(
            listed.status.success(),
            "git ls-files: {}",
            text(&listed.stderr)
        );
        for name in listed.stdout.split(|byte| *byte == 0) {
            let name = std::str::from_utf8(name).expect("a utf-8 path");
            let source = repo_root().join(name);
            if name.is_empty() || !source.is_file() {
                continue;
            }
            let destination = dir.path().join(name);
            fs::create_dir_all(destination.parent().expect("a parent directory"))
                .expect("create the copy's directory");
            fs::copy(&source, &destination)
                .unwrap_or_else(|error| panic!("copy {name} into the checkout: {error}"));
        }
        let checkout = Self { dir };
        assert!(
            !checkout.root().join("node_modules").exists(),
            "the copy carries an install, so nothing below would be installed by the script"
        );
        checkout
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    /// Run the real script in this checkout, with `path` as its search path.
    fn install(&self, path: &std::ffi::OsStr) -> Output {
        Command::new("bash")
            .arg(self.root().join("scripts/workspace-install.sh"))
            .current_dir(self.root())
            .env("PATH", path)
            .output()
            .expect("bash is on PATH")
    }

    fn installed(&self) -> bool {
        self.root().join("node_modules/.bin/nx").exists()
    }
}

fn this_path() -> std::ffi::OsString {
    std::env::var_os("PATH").expect("PATH is set")
}

/// From a clone with no `node_modules`, the script installs the workspace from
/// `bun.lock`, and an Nx target that needs those dependencies then runs on it.
#[test]
fn a_fresh_checkout_installs_from_the_lockfile_and_runs_a_target() {
    let checkout = Checkout::new();
    let lock = fs::read(checkout.root().join("bun.lock")).expect("the committed bun.lock");

    let installed = checkout.install(&this_path());
    assert!(
        installed.status.success(),
        "the install failed:\n{}",
        text(&installed.stderr)
    );
    assert!(checkout.installed(), "the install left no Nx shim");
    assert!(
        text(&installed.stdout).is_empty(),
        "the install wrote to stdout, which a caller reads for an answer:\n{}",
        text(&installed.stdout)
    );
    assert_eq!(
        fs::read(checkout.root().join("bun.lock")).expect("bun.lock after the install"),
        lock,
        "the install rewrote bun.lock"
    );
    assert!(
        !checkout.root().join("package-lock.json").exists(),
        "an npm lockfile beside bun.lock is a second pin of the same workspace"
    );
    // A sibling resolved from the workspace, not the registry.
    let sibling = fs::canonicalize(
        checkout
            .root()
            .join("node_modules/@onepipeline-ui/dag-model"),
    )
    .expect("the workspace sibling is linked");
    assert_eq!(
        sibling,
        fs::canonicalize(checkout.root().join("packages/dag-model")).expect("the sibling"),
    );

    // Vitest and the sibling's sources both come from that install.
    let ran = Command::new("bash")
        .arg(checkout.root().join("scripts/nx.sh"))
        .args(["run", "timeline-categories:test", "--skip-nx-cache"])
        .current_dir(checkout.root())
        .env("NX_DAEMON", "false")
        .env_remove("NX_SKIP_NX_CACHE")
        .output()
        .expect("bash is on PATH");
    assert!(
        ran.status.success(),
        "the target failed on the fresh install:\n{}{}",
        text(&ran.stdout),
        text(&ran.stderr)
    );
}

/// A manifest the lockfile does not carry is refused, and the lockfile is left
/// exactly as committed rather than re-resolved and written back.
#[test]
fn a_manifest_the_lockfile_does_not_carry_is_refused_without_rewriting_it() {
    let checkout = Checkout::new();
    let lock = fs::read(checkout.root().join("bun.lock")).expect("the committed bun.lock");
    let manifest = checkout.root().join("packages/dag-model/package.json");
    let mut parsed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest).expect("read the manifest"))
            .expect("parse the manifest");
    parsed["devDependencies"] = serde_json::json!({ "left-pad": "1.3.0" });
    fs::write(
        &manifest,
        serde_json::to_string_pretty(&parsed).expect("serialise"),
    )
    .expect("write the manifest");

    let refused = checkout.install(&this_path());
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(1), "{stderr}");
    assert!(
        stderr.contains("lockfile had changes, but lockfile is frozen"),
        "bun's own diagnostic is not passed through:\n{stderr}"
    );
    assert!(
        stderr.contains("run 'bun install' and commit bun.lock"),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert_eq!(
        fs::read(checkout.root().join("bun.lock")).expect("bun.lock after the refusal"),
        lock,
        "a refused install rewrote bun.lock"
    );
    assert!(!checkout.installed(), "a refused install left an Nx shim");
}

/// With no bun on the search path the script refuses, naming the version to
/// install and how.
#[test]
fn no_bun_on_path_is_refused_naming_the_pinned_version() {
    let checkout = Checkout::new();
    let scratch = TempDir::new().expect("temp dir");
    // Every search-path entry that holds a bun is dropped. Node can share a
    // directory with bun — a bun installed through npm lands beside node — so it
    // is put back on its own, through a directory holding nothing else.
    let without_bun: Vec<PathBuf> = std::env::split_paths(&this_path())
        .filter(|entry| !entry.join("bun").exists())
        .collect();
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("node is on PATH");
    let node_only = scratch.path().join("node-only");
    fs::create_dir(&node_only).expect("create the node directory");
    symlink(text(&node.stdout).trim(), node_only.join("node")).expect("link node");
    let path =
        std::env::join_paths(std::iter::once(node_only).chain(without_bun)).expect("join PATH");
    let probe = Command::new("bash")
        .args(["-c", "command -v bun || true"])
        .env("PATH", &path)
        .output()
        .expect("bash is on PATH");
    assert!(
        text(&probe.stdout).trim().is_empty(),
        "bun is still reachable at {}",
        text(&probe.stdout)
    );

    let refused = checkout.install(&path);
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("bun not found"), "{stderr}");
    let pinned = pinned_bun();
    assert!(
        stderr.contains(&format!("ACTION: install bun {pinned}"))
            && stderr.contains(&format!("bash -s bun-v{pinned}")),
        "the refusal does not name the pinned bun and how to install it:\n{stderr}"
    );
    assert!(!checkout.installed(), "a refused install left an Nx shim");
}

/// A bun older than the pin is refused before it is asked to install anything.
#[test]
fn a_bun_older_than_the_pin_is_refused_before_it_installs() {
    let checkout = Checkout::new();
    let scratch = TempDir::new().expect("temp dir");
    let asked = scratch.path().join("asked");
    let path = stub_bin::install(
        &scratch.path().join("bin"),
        "bun",
        &format!(
            "#!/usr/bin/env bash\n\
             if [ \"$1\" = --version ]; then echo 1.0.0; exit 0; fi\n\
             echo \"$@\" >> '{}'\n\
             exit 0\n",
            asked.display()
        ),
    );

    let refused = checkout.install(&path);
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(1), "{stderr}");
    let pinned = pinned_bun();
    assert!(
        stderr.contains(&format!("bun 1.0.0 is older than bun {pinned}")),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: run 'bun upgrade'"),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !asked.exists(),
        "a bun below the floor was asked to install: {}",
        fs::read_to_string(&asked).unwrap_or_default()
    );
    assert!(!checkout.installed(), "a refused install left an Nx shim");
}

/// The one pin of the workspace's package manager, as package.json names it.
fn pinned_bun() -> String {
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(repo_root().join("package.json")).expect("read package.json"),
    )
    .expect("parse package.json");
    manifest["packageManager"]
        .as_str()
        .and_then(|spelled| spelled.strip_prefix("bun@"))
        .expect("package.json pins bun in packageManager")
        .to_owned()
}
