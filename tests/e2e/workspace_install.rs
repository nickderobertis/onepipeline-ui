//! The workspace's install: `scripts/workspace-install.sh`, over a fresh copy of
//! this checkout with no `node_modules` at all.
//!
//! Every recipe reaches the TypeScript workspace through this one script —
//! `scripts/nx.sh` runs it before every Nx invocation — so what a fresh clone
//! gets is decided here: bun installing exactly what `bun.lock` pins, or a
//! refusal that names the fix. These journeys run the real script with the real
//! bun this checkout was bootstrapped with, then run a real Nx target over what
//! it installed. Nothing is stood in for: a bun below the floor is the real bun
//! under a pin moved past it, and a `bun` that is not bun is a real program
//! linked under that name.
//!
//! Unix only for the reason `nx_affected` is: the script is bash, and the
//! journeys that take a runtime away build their search path out of symlinks.
//! The macOS leg runs it.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

/// The script's refusal when a runtime is missing, answers no version, or is
/// below its floor — the sysexits `EX_UNAVAILABLE`, as its header documents.
const EX_UNAVAILABLE: i32 = 69;

/// The script's refusal when package.json names no floor to hold a runtime to —
/// the sysexits `EX_CONFIG`.
const EX_CONFIG: i32 = 78;

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

/// A directory holding only the named programs, as a search path: what a host
/// with exactly those installed would offer the script. `bash` is always among
/// them, since the journeys start the script through it.
fn only(scratch: &Path, programs: &[(&str, PathBuf)]) -> std::ffi::OsString {
    let dir = scratch.join("only");
    fs::create_dir_all(&dir).expect("create the search-path directory");
    for (name, program) in std::iter::once(&("bash", on_path("bash"))).chain(programs) {
        symlink(program, dir.join(name)).unwrap_or_else(|error| panic!("link {name}: {error}"));
    }
    dir.into_os_string()
}

/// A program's real file, through this process's search path. Resolved rather
/// than linked as found, because a version manager's shim on PATH finds its
/// program through the PATH a journey has taken away.
fn on_path(name: &str) -> PathBuf {
    let found = Command::new("bash")
        .args(["-c", &format!("command -v {name}")])
        .output()
        .expect("bash is on PATH");
    assert!(found.status.success(), "{name} is not on PATH");
    fs::canonicalize(text(&found.stdout).trim()).expect("resolve the program")
}

/// The file a runtime is running from, as that runtime reports it.
fn runtime(name: &str, script: &str) -> PathBuf {
    let ran = Command::new(name)
        .args(["-e", script])
        .output()
        .unwrap_or_else(|error| panic!("{name} is on PATH: {error}"));
    PathBuf::from(text(&ran.stdout).trim())
}

fn node() -> PathBuf {
    runtime("node", "console.log(process.execPath)")
}

fn bun() -> PathBuf {
    runtime("bun", "console.log(process.execPath)")
}

/// With no bun on the search path the script refuses, naming the version to
/// install and how.
#[test]
fn no_bun_on_path_is_refused_naming_the_pinned_version() {
    let checkout = Checkout::new();
    let scratch = TempDir::new().expect("temp dir");
    let path = only(
        scratch.path(),
        &[
            ("dirname", on_path("dirname")),
            ("sed", on_path("sed")),
            ("node", node()),
        ],
    );

    let refused = checkout.install(&path);
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_UNAVAILABLE), "{stderr}");
    assert!(stderr.contains("bun not found"), "{stderr}");
    let pinned = pinned_bun();
    assert!(
        stderr.contains(&format!("ACTION: install bun {pinned}"))
            && stderr.contains(&format!("bash -s bun-v{pinned}")),
        "the refusal does not name the pinned bun and how to install it:\n{stderr}"
    );
    assert!(!checkout.installed(), "a refused install left an Nx shim");
}

/// With bun but no node the script refuses before installing anything: what
/// bun installs here is Node programs, so a workspace with no Node to run them
/// is not an install worth making.
#[test]
fn no_node_on_path_is_refused_naming_the_runtime() {
    let checkout = Checkout::new();
    let scratch = TempDir::new().expect("temp dir");
    let path = only(
        scratch.path(),
        &[
            ("dirname", on_path("dirname")),
            ("sed", on_path("sed")),
            ("bun", bun()),
        ],
    );

    let refused = checkout.install(&path);
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_UNAVAILABLE), "{stderr}");
    assert!(stderr.contains("node not found"), "{stderr}");
    assert!(
        stderr.contains("ACTION: install Node.js 24+"),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !checkout.root().join("node_modules").exists(),
        "a refused install wrote node_modules"
    );
}

/// A package.json that no longer pins bun is refused: the pin is the floor, and
/// an install with no floor is one CI and a laptop can disagree about.
#[test]
fn a_manifest_without_the_bun_pin_is_refused() {
    let checkout = Checkout::new();
    let manifest = checkout.root().join("package.json");
    let mut parsed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest).expect("read package.json"))
            .expect("parse package.json");
    parsed
        .as_object_mut()
        .expect("package.json is an object")
        .remove("packageManager")
        .expect("package.json pins its package manager");
    fs::write(
        &manifest,
        serde_json::to_string_pretty(&parsed).expect("serialise"),
    )
    .expect("write package.json");

    let refused = checkout.install(&this_path());
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_CONFIG), "{stderr}");
    assert!(
        stderr.contains("package.json pins no bun version"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: restore \"packageManager\""),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(!checkout.installed(), "a refused install left an Nx shim");
}

/// A bun older than the pin is refused before it installs anything — the state
/// a clone is in after pulling a pin its bun has not caught up with. The pin is
/// moved past the real bun rather than the bun moved behind it, which no
/// offline journey can do.
#[test]
fn a_bun_older_than_the_pin_is_refused_before_it_installs() {
    let checkout = Checkout::new();
    let installed = text(
        &Command::new("bun")
            .arg("--version")
            .output()
            .expect("bun is on PATH")
            .stdout,
    )
    .trim()
    .to_owned();
    let manifest = checkout.root().join("package.json");
    let read = fs::read_to_string(&manifest).expect("read package.json");
    let pinned = format!("\"packageManager\": \"bun@{}\"", pinned_bun());
    assert!(
        read.contains(&pinned),
        "package.json spells its pin otherwise"
    );
    fs::write(
        &manifest,
        read.replace(&pinned, "\"packageManager\": \"bun@999.0.0\""),
    )
    .expect("write package.json");
    let lock = fs::read(checkout.root().join("bun.lock")).expect("the committed bun.lock");

    let refused = checkout.install(&this_path());
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_UNAVAILABLE), "{stderr}");
    assert!(
        stderr.contains(&format!("bun {installed} is older than bun 999.0.0")),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: run 'bun upgrade'"),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !checkout.root().join("node_modules").exists(),
        "a bun below the floor installed anyway"
    );
    assert_eq!(
        fs::read(checkout.root().join("bun.lock")).expect("bun.lock after the refusal"),
        lock,
        "a bun below the floor rewrote bun.lock"
    );
}

/// A `bun` on PATH that is some other program — an alias or a link left
/// pointing at the wrong thing — is refused as answering no version, rather
/// than reaching the comparison as a shell arithmetic error. Node is that other
/// program here: it answers `--version` with `v` and its own release.
#[test]
fn a_bun_that_answers_no_version_is_refused_before_it_installs() {
    let checkout = Checkout::new();
    let scratch = TempDir::new().expect("temp dir");
    let path = only(
        scratch.path(),
        &[
            ("dirname", on_path("dirname")),
            ("sed", on_path("sed")),
            ("node", node()),
            ("bun", node()),
        ],
    );

    let refused = checkout.install(&path);
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_UNAVAILABLE), "{stderr}");
    assert!(
        stderr.contains("answered --version with 'v") && stderr.contains("which is not a version"),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!("ACTION: install bun {}", pinned_bun())),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !stderr.contains("integer expression"),
        "the answer reached the arithmetic:\n{stderr}"
    );
    assert!(
        !checkout.root().join("node_modules").exists(),
        "a bun with no version installed anyway"
    );
}

/// Refuses an edit that matched nothing: a journey whose pattern stopped
/// matching package.json would otherwise run against the committed manifest
/// and pass for a reason that has nothing to do with the refusal it names.
fn edit_manifest(checkout: &Checkout, edit: impl FnOnce(String) -> String) {
    let manifest = checkout.root().join("package.json");
    let read = fs::read_to_string(&manifest).expect("read package.json");
    let edited = edit(read.clone());
    assert_ne!(edited, read, "the edit changed nothing in package.json");
    fs::write(&manifest, edited).expect("write package.json");
}

/// A node older than package.json's `engines` floor is refused before bun
/// installs anything. The floor is moved past the real node rather than the
/// node moved behind it, which no offline journey can do.
#[test]
fn a_node_older_than_the_floor_is_refused_before_it_installs() {
    let checkout = Checkout::new();
    let installed = text(
        &Command::new("node")
            .arg("--version")
            .output()
            .expect("node is on PATH")
            .stdout,
    )
    .trim()
    .to_owned();
    edit_manifest(&checkout, |read| {
        read.replace("\"node\": \">=24\"", "\"node\": \">=999\"")
    });

    let refused = checkout.install(&this_path());
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_UNAVAILABLE), "{stderr}");
    assert!(
        stderr.contains(&format!("node {installed} is older than Node.js 999")),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: install Node.js 999+"),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !checkout.root().join("node_modules").exists(),
        "a node below the floor installed anyway"
    );
}

/// A package.json that names no Node floor is refused rather than accepting
/// whatever node is on PATH.
#[test]
fn a_manifest_without_the_node_floor_is_refused() {
    let checkout = Checkout::new();
    edit_manifest(&checkout, |read| {
        read.replace("  \"engines\": {\n    \"node\": \">=24\"\n  },\n", "")
    });

    let refused = checkout.install(&this_path());
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_CONFIG), "{stderr}");
    assert!(
        stderr.contains("package.json names no Node.js floor"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: restore \"engines\""),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !checkout.root().join("node_modules").exists(),
        "an install with no Node floor went ahead"
    );
}

/// A `node` on PATH that is some other program is refused as answering no
/// version. Bun is that other program here: it answers `--version` without
/// node's leading `v`.
#[test]
fn a_node_that_answers_no_version_is_refused_before_it_installs() {
    let checkout = Checkout::new();
    let scratch = TempDir::new().expect("temp dir");
    let path = only(
        scratch.path(),
        &[
            ("dirname", on_path("dirname")),
            ("sed", on_path("sed")),
            ("node", bun()),
            ("bun", bun()),
        ],
    );

    let refused = checkout.install(&path);
    let stderr = text(&refused.stderr);
    assert_eq!(refused.status.code(), Some(EX_UNAVAILABLE), "{stderr}");
    assert!(
        stderr.contains("the node on PATH") && stderr.contains("which is not a version"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: install Node.js 24+"),
        "the refusal does not name the fix:\n{stderr}"
    );
    assert!(
        !checkout.root().join("node_modules").exists(),
        "a node with no version installed anyway"
    );
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
