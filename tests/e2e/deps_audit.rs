//! The supply-chain audit, split by who is responsible for an advisory:
//! `just _crate-deps-check` (the blocking `onepipeline-ui:deps-check` target the
//! required `lint` job runs), `just advisories-report` (informational, never
//! required) and `just advisories-status` (that report, posted as the
//! `advisories` commit status). All three are `scripts/deps-audit.mjs`.
//!
//! What it guards is a state this repository was left in: RUSTSEC-2026-0433 was
//! published against a pulldown-cmark `main` already resolved, every change
//! failed the audit, and the release went out only when it was merged by hand.
//! So each journey is a real crate in a real git repository whose `origin/main`
//! is the base a pull request forks from, audited by the real cargo-deny and
//! cargo-machete under this repository's own `deny.toml`, offline: its
//! dependencies are crates vendored through cargo's source replacement (so they
//! keep their crates.io identity, which is what advisories match on), and the
//! advisory database is the fixture one under `tests/fixtures/deps-audit`,
//! placed where cargo-deny looks for its default database under a scratch
//! `CARGO_HOME`. The base and head lockfiles are committed fixtures too; the
//! audit runs with `--locked`, so a manifest here that drifted from its lockfile
//! fails rather than being resolved afresh.
//!
//! One thing is stood in for, in the `status` journeys only: `gh` on PATH, because
//! the real one writes a commit status on a public repository. It is a recording
//! stand-in (`support/stub_bin.rs`), so the script is the real script and the
//! status it asked for is readable here.
//!
//! Linux only: the audit's one runner is the Linux `lint` job, and what it
//! decides — which lockfile resolved which version — is not a property of the
//! platform. `test-linux` installs the two tools these journeys fail without.
#![cfg(target_os = "linux")]

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

/// The directory cargo-deny keeps its default database (RustSec's advisory-db)
/// in under `$CARGO_HOME/advisory-dbs`, named for the hash of that URL. Placing
/// the fixture database there is what lets the real policy, which names no
/// database, read it.
const DEFAULT_DB_DIR: &str = "advisory-db-3157b0e258782691";

/// The fixture database's advisories, with the crate version each matches.
const VULN: &str = "RUSTSEC-2099-0001 fixture-vuln 1.0.0";
const LIB_2_1: &str = "RUSTSEC-2099-0002 fixture-lib 2.1.0";
const LONG: &str = "RUSTSEC-2099-0003 fixture-whose-name-is-long-enough-to-overflow-a-status 1.0.0";
/// The crate [`LONG`] is against: named beside the other two, the advisories
/// overflow the 140 characters GitHub allows a status description.
const LONG_NAME: &str = "fixture-whose-name-is-long-enough-to-overflow-a-status";

/// Every vendored crate: name, version, license.
const VENDORED: &[(&str, &str, &str)] = &[
    ("fixture-vuln", "1.0.0", "MIT"),
    ("fixture-lib", "2.0.0", "MIT"),
    ("fixture-lib", "2.1.0", "MIT"),
    ("fixture-extra", "1.0.0", "MIT"),
    ("fixture-gpl", "1.0.0", "GPL-3.0-only"),
    (LONG_NAME, "1.0.0", "MIT"),
    // A crate `deny.toml` bans by name.
    ("serde_yaml", "0.9.0", "MIT"),
];
/// The package checksum every committed fixture lockfile records, and so every
/// vendored crate declares.
const CHECKSUM: &str = "5d5c5e5f00000000000000000000000000000000000000000000000000000000";

/// One side of a change: the committed lockfile it resolves, the root crate's
/// version, its exact dependencies, and which of them its source leaves unused.
struct Side {
    lock: &'static str,
    version: &'static str,
    deps: &'static [(&'static str, &'static str)],
    unused: &'static [&'static str],
}

const VULNERABLE: Side = Side {
    lock: "vulnerable",
    version: "0.1.0",
    deps: &[("fixture-lib", "2.0.0"), ("fixture-vuln", "1.0.0")],
    unused: &[],
};
const CLEAN: Side = Side {
    lock: "clean",
    version: "0.1.0",
    deps: &[("fixture-lib", "2.0.0")],
    unused: &[],
};

struct Project {
    _dir: TempDir,
    repo: PathBuf,
    home: PathBuf,
    gitconfig: PathBuf,
}

fn git(gitconfig: &Path, cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", gitconfig)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("git prints UTF-8")
        .trim()
        .to_owned()
}

fn write_side(repo: &Path, side: &Side) {
    let mut manifest = format!(
        "[package]\nname = \"fixture-root\"\nversion = \"{}\"\nedition = \"2021\"\n\
         license = \"MIT\"\npublish = false\n\n[dependencies]\n",
        side.version
    );
    let mut lib = String::new();
    for (name, version) in side.deps {
        manifest.push_str(&format!("{name} = \"={version}\"\n"));
        if !side.unused.contains(name) {
            lib.push_str(&format!("pub use {};\n", name.replace('-', "_")));
        }
    }
    fs::write(repo.join("Cargo.toml"), manifest).expect("write the manifest");
    fs::write(repo.join("src/lib.rs"), lib).expect("write the source");
    fs::copy(
        Path::new(ROOT).join(format!(
            "tests/fixtures/deps-audit/{}.Cargo.lock",
            side.lock
        )),
        repo.join("Cargo.lock"),
    )
    .expect("copy the fixture lockfile");
}

/// A repository whose `origin/main` resolves `base` and whose checked-out branch
/// resolves `head`, with the fixture database installed as cargo-deny's default.
fn project(base: &Side, head: &Side) -> Project {
    let dir = TempDir::new().expect("temp dir");
    let gitconfig = dir.path().join("gitconfig");
    fs::write(
        &gitconfig,
        "[user]\n\tname = deps-audit journeys\n\temail = journeys@onepipeline-ui.invalid\n\
         [init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    )
    .expect("write the git config");

    let vendor = dir.path().join("vendor");
    for (name, version, license) in VENDORED {
        let krate = vendor.join(format!("{name}-{version}"));
        fs::create_dir_all(krate.join("src")).expect("create a vendored crate");
        fs::write(
            krate.join("Cargo.toml"),
            format!(
                "[package]\nname = \"{name}\"\nversion = \"{version}\"\nedition = \"2021\"\n\
                 license = \"{license}\"\ndescription = \"A deps-audit fixture crate.\"\n"
            ),
        )
        .expect("write a vendored manifest");
        fs::write(krate.join("src/lib.rs"), "").expect("write a vendored source");
        fs::write(
            krate.join(".cargo-checksum.json"),
            format!("{{\"files\":{{}},\"package\":\"{CHECKSUM}\"}}"),
        )
        .expect("write a vendored checksum");
    }

    let home = dir.path().join("cargo-home");
    let db = home.join("advisory-dbs").join(DEFAULT_DB_DIR);
    copy_tree(
        &Path::new(ROOT).join("tests/fixtures/deps-audit/advisory-db"),
        &db,
    );
    git(&gitconfig, &db, &["init", "-q"]);
    git(&gitconfig, &db, &["add", "-A"]);
    git(
        &gitconfig,
        &db,
        &["commit", "-qm", "the fixture advisory database"],
    );
    // The database's `origin` is a local copy of it, so a cargo-deny that fetches
    // before every check (0.20 does; 0.19 skipped a fresh FETCH_HEAD) fetches
    // the fixture back, offline, rather than failing to reach RustSec.
    let origin = dir.path().join("advisory-db-origin.git");
    git(
        &gitconfig,
        dir.path(),
        &[
            "clone",
            "-q",
            "--bare",
            &db.to_string_lossy(),
            &origin.to_string_lossy(),
        ],
    );
    git(
        &gitconfig,
        &db,
        &["remote", "add", "origin", &origin.to_string_lossy()],
    );
    // cargo-deny reads when the database was last fetched from FETCH_HEAD.
    let fetched = git(&gitconfig, &db, &["rev-parse", "HEAD"]);
    fs::write(db.join(".git/FETCH_HEAD"), format!("{fetched}\n")).expect("write FETCH_HEAD");

    let repo = dir.path().join("repo");
    fs::create_dir_all(repo.join("src")).expect("create the repository");
    fs::create_dir_all(repo.join(".cargo")).expect("create .cargo");
    fs::write(
        repo.join(".cargo/config.toml"),
        format!(
            "[source.crates-io]\nreplace-with = \"vendored\"\n\n[source.vendored]\ndirectory = \"{}\"\n",
            vendor.display()
        ),
    )
    .expect("write the source replacement");
    // This repository's own policy, so what blocks here is what blocks there.
    fs::copy(Path::new(ROOT).join("deny.toml"), repo.join("deny.toml")).expect("copy deny.toml");
    git(&gitconfig, &repo, &["init", "-q"]);
    write_side(&repo, base);
    git(&gitconfig, &repo, &["add", "-A"]);
    git(&gitconfig, &repo, &["commit", "-qm", "the base"]);
    let base_commit = git(&gitconfig, &repo, &["rev-parse", "HEAD"]);
    git(
        &gitconfig,
        &repo,
        &["update-ref", "refs/remotes/origin/main", &base_commit],
    );
    git(&gitconfig, &repo, &["checkout", "-qb", "change"]);
    write_side(&repo, head);
    git(&gitconfig, &repo, &["add", "-A"]);
    git(
        &gitconfig,
        &repo,
        &["commit", "-qm", "the change", "--allow-empty"],
    );

    Project {
        _dir: dir,
        repo,
        home,
        gitconfig,
    }
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create a directory");
    for entry in fs::read_dir(from).expect("read a fixture directory") {
        let entry = entry.expect("a fixture entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("a file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy a fixture file");
        }
    }
}

struct Run {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Run {
    fn all(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

/// This repository's recipe, run in the fixture repository the way Nx runs it in
/// this one, offline, and with none of the runner's own GitHub context.
fn just(project: &Project, args: &[&str], env: &[(&str, &OsStr)]) -> Run {
    let mut command = Command::new("just");
    command
        .arg("--justfile")
        .arg(Path::new(ROOT).join("justfile"))
        .arg("--working-directory")
        .arg(&project.repo)
        .args(args);
    run_in(project, command, env)
}

/// `scripts/deps-audit.mjs` itself, from the fixture repository's root, for what
/// the recipes never pass it: `--base`, and arguments it must refuse.
fn script(project: &Project, args: &[&str]) -> Run {
    let mut command = Command::new("node");
    command
        .arg(Path::new(ROOT).join("scripts/deps-audit.mjs"))
        .args(args)
        .current_dir(&project.repo);
    run_in(project, command, &[])
}

fn run_in(project: &Project, mut command: Command, env: &[(&str, &OsStr)]) -> Run {
    command
        .env("CARGO_HOME", &project.home)
        .env("CARGO_NET_OFFLINE", "true")
        .env("GIT_CONFIG_GLOBAL", &project.gitconfig)
        .env("GIT_CONFIG_NOSYSTEM", "1");
    for variable in [
        "GITHUB_ACTIONS",
        "GITHUB_REPOSITORY",
        "GITHUB_RUN_ID",
        "GITHUB_SERVER_URL",
        "GITHUB_STEP_SUMMARY",
        "GH_TOKEN",
        "GITHUB_TOKEN",
    ] {
        command.env_remove(variable);
    }
    // What cargo sets for this test binary, and Nx never sets for the recipe:
    // cargo-machete reads `CARGO_PKG_NAME` as being run by `cargo test` and then
    // takes `machete` for the directory to analyze.
    for (variable, _) in std::env::vars_os() {
        let name = variable.to_string_lossy();
        if [
            "CARGO_PKG_",
            "CARGO_MANIFEST_",
            "CARGO_CRATE_",
            "CARGO_BIN_",
            "CARGO_PRIMARY_",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
        {
            command.env_remove(&variable);
        }
    }
    command.envs(env.iter().copied());
    let Output {
        status,
        stdout,
        stderr,
    } = command.output().expect("run just");
    Run {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

fn blocking(project: &Project) -> Run {
    just(project, &["_crate-deps-check"], &[])
}

fn report(project: &Project) -> Run {
    just(project, &["advisories-report"], &[])
}

#[test]
fn a_pre_existing_advisory_does_not_block_and_is_still_reported() {
    // The base already carries RUSTSEC-2099-0001; the change adds an unrelated,
    // clean dependency.
    let project = project(
        &VULNERABLE,
        &Side {
            lock: "vulnerable-and-extra",
            version: "0.1.0",
            deps: &[
                ("fixture-extra", "1.0.0"),
                ("fixture-lib", "2.0.0"),
                ("fixture-vuln", "1.0.0"),
            ],
            unused: &[],
        },
    );
    let check = blocking(&project);
    assert_eq!(
        check.code,
        Some(0),
        "the blocking audit failed:\n{}",
        check.all()
    );
    assert!(
        check
            .stdout
            .contains(&format!("pre-existing, not blocking: {VULN}")),
        "the blocking audit did not name the pre-existing advisory:\n{}",
        check.all()
    );

    let report = report(&project);
    assert_ne!(report.code, Some(0), "the report passed:\n{}", report.all());
    assert!(
        report.stderr.contains(&format!("advisory {VULN}")),
        "the report did not name the pre-existing advisory:\n{}",
        report.all()
    );
    assert!(
        report.stderr.contains("already resolved at the base"),
        "{}",
        report.all()
    );
}

#[test]
fn an_introduced_advisory_blocks_naming_it() {
    // fixture-lib moves from the unaffected 2.0.0 to the affected 2.1.0.
    let project = project(
        &VULNERABLE,
        &Side {
            lock: "vulnerable-lib-2.1",
            version: "0.1.0",
            deps: &[("fixture-lib", "2.1.0"), ("fixture-vuln", "1.0.0")],
            unused: &[],
        },
    );
    let check = blocking(&project);
    assert_ne!(
        check.code,
        Some(0),
        "the blocking audit passed:\n{}",
        check.all()
    );
    assert!(
        check
            .stderr
            .contains(&format!("introduced by this change: {LIB_2_1}")),
        "the blocking audit did not name the introduced advisory:\n{}",
        check.all()
    );
    // The one the base already carried is still the report's, not this change's.
    assert!(
        check
            .stdout
            .contains(&format!("pre-existing, not blocking: {VULN}")),
        "{}",
        check.all()
    );
    assert!(!check
        .stderr
        .contains(&format!("introduced by this change: {VULN}")));

    let report = report(&project);
    assert_ne!(report.code, Some(0), "the report passed:\n{}", report.all());
    for named in [VULN, LIB_2_1] {
        assert!(
            report.stderr.contains(&format!("advisory {named}")),
            "the report did not name {named}:\n{}",
            report.all()
        );
    }
}

#[test]
fn a_release_head_over_a_vulnerable_base_is_not_blocked() {
    // What release-plz's pull request does to Cargo.lock: the crate's own version
    // and nothing else.
    let project = project(
        &VULNERABLE,
        &Side {
            lock: "vulnerable-released",
            version: "0.2.0",
            ..VULNERABLE
        },
    );
    let check = blocking(&project);
    assert_eq!(
        check.code,
        Some(0),
        "the release was blocked:\n{}",
        check.all()
    );
    assert!(check
        .stdout
        .contains(&format!("pre-existing, not blocking: {VULN}")));

    let report = report(&project);
    assert_ne!(report.code, Some(0), "the report passed:\n{}", report.all());
    assert!(
        report.stderr.contains(&format!("advisory {VULN}")),
        "{}",
        report.all()
    );
}

#[test]
fn a_license_violation_still_blocks() {
    let project = project(
        &CLEAN,
        &Side {
            lock: "clean-and-gpl",
            version: "0.1.0",
            deps: &[("fixture-gpl", "1.0.0"), ("fixture-lib", "2.0.0")],
            unused: &[],
        },
    );
    let check = blocking(&project);
    assert_ne!(
        check.code,
        Some(0),
        "the blocking audit passed:\n{}",
        check.all()
    );
    assert!(
        check.all().contains("GPL-3.0-only") && check.all().contains("fixture-gpl"),
        "the blocking audit did not name the rejected license:\n{}",
        check.all()
    );
    assert!(
        check
            .stderr
            .contains("ACTION: fix the bans, licenses or sources finding"),
        "the blocking audit did not say what to do:\n{}",
        check.all()
    );
    // Licenses are not the report's: with no advisory in the graph it passes.
    let report = report(&project);
    assert_eq!(report.code, Some(0), "the report failed:\n{}", report.all());
    assert!(report
        .stdout
        .contains("no advisory matches the resolved graph"));
}

#[test]
fn a_banned_crate_still_blocks() {
    let project = project(
        &CLEAN,
        &Side {
            lock: "clean-and-banned",
            version: "0.1.0",
            deps: &[("fixture-lib", "2.0.0"), ("serde_yaml", "0.9.0")],
            unused: &[],
        },
    );
    let check = blocking(&project);
    assert_ne!(
        check.code,
        Some(0),
        "the blocking audit passed:\n{}",
        check.all()
    );
    assert!(
        check.all().contains("serde_yaml") && check.all().contains("banned"),
        "the blocking audit did not name the banned crate:\n{}",
        check.all()
    );
}

#[test]
fn an_unused_dependency_still_blocks() {
    let project = project(
        &CLEAN,
        &Side {
            lock: "clean-and-extra",
            version: "0.1.0",
            deps: &[("fixture-extra", "1.0.0"), ("fixture-lib", "2.0.0")],
            unused: &["fixture-extra"],
        },
    );
    let check = blocking(&project);
    assert_ne!(
        check.code,
        Some(0),
        "the blocking audit passed:\n{}",
        check.all()
    );
    assert!(
        check.stdout.contains("fixture-extra"),
        "the blocking audit did not name the unused dependency:\n{}",
        check.all()
    );
    assert!(
        check
            .stderr
            .contains("ACTION: remove the unused dependency cargo-machete named"),
        "the blocking audit did not say what to do:\n{}",
        check.all()
    );
}

#[test]
fn a_base_it_cannot_resolve_is_refused_rather_than_read_as_empty() {
    let project = project(&VULNERABLE, &VULNERABLE);
    git(
        &project.gitconfig,
        &project.repo,
        &["update-ref", "-d", "refs/remotes/origin/main"],
    );
    let check = blocking(&project);
    assert_ne!(
        check.code,
        Some(0),
        "the blocking audit passed:\n{}",
        check.all()
    );
    assert!(
        check.stderr.contains("cannot resolve the base"),
        "the refusal did not say why:\n{}",
        check.all()
    );
    assert!(!check.all().contains("pre-existing, not blocking"));
}

/// A commit on an orphan branch whose tree is `Cargo.lock` holding `lock` alone,
/// or nothing when `lock` is `None`: a base no fixture side describes, for
/// `--base`. The checkout is left on the change.
fn odd_base(project: &Project, lock: Option<&str>) -> String {
    let git = |args: &[&str]| git(&project.gitconfig, &project.repo, args);
    git(&["checkout", "-q", "--orphan", "odd-base"]);
    git(&["rm", "-rq", "--cached", "."]);
    if let Some(lock) = lock {
        fs::write(project.repo.join("Cargo.lock"), lock).expect("write the base lockfile");
        git(&["add", "Cargo.lock"]);
    }
    git(&["commit", "-qm", "an odd base", "--allow-empty"]);
    let commit = git(&["rev-parse", "HEAD"]);
    git(&["checkout", "-qf", "change"]);
    // The commit outlives its branch, so another odd base can be cut the same way.
    git(&["branch", "-qD", "odd-base"]);
    commit
}

fn fixture_lock(name: &str) -> String {
    fs::read_to_string(Path::new(ROOT).join(format!("tests/fixtures/deps-audit/{name}.Cargo.lock")))
        .expect("read a fixture lockfile")
}

#[test]
fn an_explicit_base_is_the_one_read() {
    // `origin/main` is clean, so against it the advisory is the change's; the
    // base named instead already resolved it.
    let project = project(&CLEAN, &VULNERABLE);
    assert_ne!(blocking(&project).code, Some(0));
    let base = odd_base(&project, Some(&fixture_lock(VULNERABLE.lock)));
    let check = script(&project, &["check", "--base", &base]);
    assert_eq!(
        check.code,
        Some(0),
        "the audit blocked against the base it was given:\n{}",
        check.all()
    );
    assert!(
        check
            .stdout
            .contains(&format!("pre-existing, not blocking: {VULN}")),
        "{}",
        check.all()
    );
    assert!(check.stdout.contains(&base[..12]), "{}", check.all());
}

#[test]
fn a_base_with_no_lockfile_resolved_nothing_so_every_advisory_is_introduced() {
    let project = project(&VULNERABLE, &VULNERABLE);
    let base = odd_base(&project, None);
    let check = script(&project, &["check", "--base", &base]);
    assert_ne!(check.code, Some(0), "the audit passed:\n{}", check.all());
    assert!(
        check
            .stderr
            .contains(&format!("introduced by this change: {VULN}")),
        "{}",
        check.all()
    );
}

#[test]
fn a_base_lockfile_it_cannot_read_is_refused_rather_than_read_in_part() {
    let project = project(&VULNERABLE, &VULNERABLE);
    let vulnerable = fixture_lock(VULNERABLE.lock);
    let cases = [
        // fixture-vuln's version dropped: read in part, the base would resolve
        // fixture-lib and nothing the advisory matches.
        (
            vulnerable.replace("version = \"1.0.0\"\n", ""),
            "0 quoted version fields",
        ),
        // Not a lockfile at all.
        (
            "<html>a proxy's error page</html>\n".to_owned(),
            "it lists no [[package]]",
        ),
        // A table cargo does not write, which could hold packages read as none.
        (
            vulnerable.replace(
                "[[package]]\nname = \"fixture-vuln\"",
                "[[packages]]\nname = \"fixture-vuln\"",
            ),
            "'[[packages]]' is not a table cargo writes there",
        ),
    ];
    for (lock, reason) in cases {
        let base = odd_base(&project, Some(&lock));
        for args in [["check", "--base", &base], ["report", "--base", &base]] {
            let run = script(&project, &args);
            assert_eq!(
                run.code,
                Some(1),
                "{args:?} was not refused:\n{}",
                run.all()
            );
            assert!(
                run.stderr.contains("cannot read Cargo.lock at the base")
                    && run.stderr.contains(reason)
                    && run.stderr.contains("ACTION:"),
                "{args:?} did not say {reason}:\n{}",
                run.all()
            );
            assert!(!run.all().contains("RUSTSEC-2099-0001"), "{}", run.all());
        }
    }
}

#[test]
fn a_tool_it_cannot_launch_is_named_with_what_to_install() {
    let project = project(&VULNERABLE, &VULNERABLE);
    // A PATH holding node and git and nothing else, so `cargo` cannot launch.
    let bin = project
        .repo
        .parent()
        .expect("a parent")
        .join("no-cargo-bin");
    fs::create_dir_all(&bin).expect("create the PATH directory");
    for tool in ["node", "git"] {
        let found = Command::new("sh")
            .args(["-c", &format!("command -v {tool}")])
            .output()
            .expect("find a tool");
        let found = String::from_utf8(found.stdout).expect("a UTF-8 path");
        std::os::unix::fs::symlink(found.trim(), bin.join(tool)).expect("link a tool");
    }
    let mut command = Command::new(bin.join("node"));
    command
        .arg(Path::new(ROOT).join("scripts/deps-audit.mjs"))
        .arg("report")
        .current_dir(&project.repo)
        .env("PATH", &bin);
    let run = run_in(&project, command, &[]);
    assert_eq!(run.code, Some(1), "{}", run.all());
    assert!(
        run.stderr.contains("deps-audit: cannot run cargo:")
            && run.stderr.contains("ACTION: install cargo and re-run"),
        "{}",
        run.all()
    );
}

#[test]
fn a_base_that_is_not_a_commit_is_refused() {
    let project = project(&VULNERABLE, &VULNERABLE);
    let check = script(&project, &["check", "--base", "no-such-commit"]);
    assert_eq!(check.code, Some(1), "{}", check.all());
    assert!(
        check
            .stderr
            .contains("the base 'no-such-commit' is not a commit here"),
        "{}",
        check.all()
    );
}

#[test]
fn arguments_it_cannot_use_are_a_usage_error() {
    let project = project(&CLEAN, &CLEAN);
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let cases: &[(&[&str], &str)] = &[
        (&[], "name a mode"),
        (&["audit"], "'audit' is not check, report or status"),
        (
            &["check", "--frobnicate", "x"],
            "unknown argument '--frobnicate'",
        ),
        (&["check", "--base"], "--base needs a value"),
        (
            &["report", "--sha", sha],
            "only status takes --sha and --head-repo",
        ),
        (
            &["status", "--head-repo", "a/b"],
            "status needs --sha <commit>",
        ),
        (
            &["status", "--sha", "abc123", "--head-repo", "a/b"],
            "'abc123' is not a full commit id",
        ),
        (
            &["status", "--sha", sha],
            "status needs --head-repo <owner/name>",
        ),
    ];
    for (args, refusal) in cases {
        let run = script(&project, args);
        assert_eq!(
            run.code,
            Some(2),
            "{args:?} was not refused:\n{}",
            run.all()
        );
        assert!(
            run.stderr.contains(refusal) && run.stderr.contains("ACTION: run 'deps-audit.mjs"),
            "{args:?} did not say {refusal}:\n{}",
            run.all()
        );
    }
}

#[test]
fn an_advisory_database_it_cannot_read_fails_both_halves_saying_what_to_do() {
    let project = project(&VULNERABLE, &VULNERABLE);
    break_database(&project);
    for run in [blocking(&project), report(&project)] {
        assert_eq!(
            run.code,
            Some(1),
            "a broken database passed:\n{}",
            run.all()
        );
        assert!(
            run.stderr.contains("deps-audit: advisories check:")
                && run
                    .stderr
                    .contains("ACTION: fix the cargo-deny error above"),
            "the failure did not say what to do:\n{}",
            run.all()
        );
        assert!(
            !run.all().contains("pre-existing, not blocking"),
            "{}",
            run.all()
        );
    }
}

/// A database entry the advisories check cannot parse, in both the database
/// and the origin it fetches from.
fn break_database(project: &Project) {
    let db = project.home.join("advisory-dbs").join(DEFAULT_DB_DIR);
    fs::write(
        db.join("crates/fixture-vuln/RUSTSEC-2099-0009.md"),
        "not an advisory\n",
    )
    .expect("write a broken advisory");
    let git = |args: &[&str]| git(&project.gitconfig, &db, args);
    git(&["add", "-A"]);
    git(&["commit", "-qm", "a broken advisory"]);
    git(&["push", "-q", "origin", "HEAD"]);
    let fetched = git(&["rev-parse", "HEAD"]);
    fs::write(db.join(".git/FETCH_HEAD"), format!("{fetched}\n")).expect("write FETCH_HEAD");
}

// llmlint: ignore-block[e2e_not_mocked] the journeys from here to the end of the
// file stand in for `gh` at the PATH boundary, and one for `cargo deny check
// advisories`: the real `gh`
// would write a commit status on a public repository from every test run, needs
// a token with `statuses: write`, and cannot be made to refuse with the 403 a
// fork's read-only token gets. The script under test is the real script, run by
// the real recipe over a real crate audited by the real cargo-deny; the stand-in
// records the exact request it was asked to send. What GitHub does with that
// request is exercised by `lint` on every pull request from this repository.
// The `cargo` stand-in answers only the advisories check, and only with output a
// real advisory database cannot be made to produce — a line that is not JSON, an
// advisory without its crate, a failed run that says nothing, a yanked crate
// (which needs the live crates.io index) — and hands every other cargo command
// to the real one.
/// The pull request head the status is posted on.
const HEAD_SHA: &str = "0123456789abcdef0123456789abcdef01234567";

/// The repository the workflow runs in, and a fork of it.
const REPOSITORY: &str = "nickderobertis/onepipeline-ui";
const FORK: &str = "contributor/onepipeline-ui";

/// The fixture change that leaves all three fixture advisories in the head.
const THREE_ADVISORIES: Side = Side {
    lock: "three-advisories",
    version: "0.1.0",
    deps: &[
        ("fixture-lib", "2.1.0"),
        ("fixture-vuln", "1.0.0"),
        (LONG_NAME, "1.0.0"),
    ],
    unused: &[],
};

/// The fixture change that leaves both fixture advisories in the head.
const VULNERABLE_LIB_2_1: Side = Side {
    lock: "vulnerable-lib-2.1",
    version: "0.1.0",
    deps: &[("fixture-lib", "2.1.0"), ("fixture-vuln", "1.0.0")],
    unused: &[],
};

/// The Actions run the status journeys post from.
const RUN_ID: &str = "41436212603";
const SERVER_URL: &str = "https://github.com";

/// What Actions sets for `lint`'s step: the repository it runs in and the run
/// a status links to.
const ACTIONS: &[(&str, &str)] = &[
    ("GITHUB_REPOSITORY", REPOSITORY),
    ("GITHUB_RUN_ID", RUN_ID),
    ("GITHUB_SERVER_URL", SERVER_URL),
];

/// `just advisories-status` for a head living in `head_repo`, as Actions runs
/// it from [`ACTIONS`] and with a step summary to write.
fn status(project: &Project, code: i32, head_repo: &str) -> (Run, String, String) {
    status_in(project, code, head_repo, ACTIONS)
}

/// [`status`] under the Actions context `actions`, with a `gh` that records
/// each argument on a line of its own and answers with `code`.
fn status_in(
    project: &Project,
    code: i32,
    head_repo: &str,
    actions: &[(&str, &str)],
) -> (Run, String, String) {
    let scratch = project.repo.parent().expect("the repository has a parent");
    let calls = scratch.join("gh-calls");
    let summary = scratch.join("step-summary");
    let path: OsString = stub_bin::install(
        &scratch.join("stub-bin"),
        "gh",
        &format!(
            "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\"; done >> '{}'\n\
             [ {code} -eq 0 ] || echo 'HTTP 403: Resource not accessible by integration' >&2\n\
             exit {code}\n",
            calls.display()
        ),
    );
    let mut env: Vec<(&str, &OsStr)> = vec![
        ("PATH", path.as_os_str()),
        ("GITHUB_ACTIONS", OsStr::new("true")),
        ("GITHUB_STEP_SUMMARY", summary.as_os_str()),
    ];
    env.extend(
        actions
            .iter()
            .map(|(name, value)| (*name, OsStr::new(*value))),
    );
    let run = just(project, &["advisories-status", HEAD_SHA, head_repo], &env);
    let read = |file: &Path| fs::read_to_string(file).unwrap_or_default();
    (run, read(&calls), read(&summary))
}

#[test]
fn the_status_is_posted_red_naming_every_advisory() {
    let project = project(&VULNERABLE, &VULNERABLE_LIB_2_1);
    let (run, calls, summary) = status(&project, 0, REPOSITORY);
    assert_ne!(run.code, Some(0), "the status step passed:\n{}", run.all());
    let args: Vec<&str> = calls.lines().collect();
    for expected in [
        "api",
        "--method",
        "POST",
        &format!("repos/nickderobertis/onepipeline-ui/statuses/{HEAD_SHA}"),
        "state=failure",
        "context=advisories",
        &format!("description={VULN}, {LIB_2_1}"),
        &format!("target_url={SERVER_URL}/{REPOSITORY}/actions/runs/{RUN_ID}"),
    ] {
        assert!(
            args.contains(&expected),
            "gh was not asked for {expected}: {args:?}"
        );
    }
    for named in [
        "RUSTSEC-2099-0001` fixture-vuln 1.0.0",
        "RUSTSEC-2099-0002` fixture-lib 2.1.0",
    ] {
        assert!(
            summary.contains(named),
            "the step summary omits {named}:\n{summary}"
        );
    }
    assert!(
        run.stdout.contains("posted advisories=failure"),
        "{}",
        run.all()
    );
}

#[test]
fn the_status_is_posted_green_when_nothing_matches() {
    let project = project(&CLEAN, &CLEAN);
    // GitHub names repositories case-insensitively: this is the same one.
    let (run, calls, _) = status(&project, 0, "NickDeRobertis/onepipeline-ui");
    assert_eq!(run.code, Some(0), "the status step failed:\n{}", run.all());
    let args: Vec<&str> = calls.lines().collect();
    assert!(args.contains(&"state=success"), "{args:?}");
    assert!(args.contains(&"context=advisories"), "{args:?}");
}

#[test]
fn a_status_github_refuses_fails_the_step_saying_why() {
    // This repository's own pull request, with a token lacking `statuses: write`.
    let project = project(&CLEAN, &CLEAN);
    let (run, calls, _) = status(&project, 1, REPOSITORY);
    assert_ne!(run.code, Some(0), "the status step passed:\n{}", run.all());
    assert!(
        calls.contains("context=advisories"),
        "gh was not asked: {calls}"
    );
    assert!(
        run.stderr.contains("could not post the advisories status")
            && run.stderr.contains("HTTP 403"),
        "the refusal did not say why:\n{}",
        run.all()
    );
}

#[test]
fn a_forks_pull_request_reads_every_advisory_in_the_summary_and_log_and_posts_nothing() {
    let project = project(&VULNERABLE, &VULNERABLE_LIB_2_1);
    // A `gh` that would post: the fork path must not ask it to.
    let (run, calls, summary) = status(&project, 0, FORK);
    assert_ne!(run.code, Some(0), "the status step passed:\n{}", run.all());
    assert!(
        calls.is_empty(),
        "a fork's pull request asked gh for: {calls}"
    );
    for named in [VULN, LIB_2_1] {
        assert!(
            run.stderr.contains(&format!("advisory {named}")),
            "the log omits {named}:\n{}",
            run.all()
        );
    }
    for annotation in [
        "::warning title=RUSTSEC-2099-0001 in fixture-vuln 1.0.0::",
        "::warning title=RUSTSEC-2099-0002 in fixture-lib 2.1.0::",
    ] {
        assert!(
            run.stdout.contains(annotation),
            "the log carries no {annotation} annotation:\n{}",
            run.all()
        );
    }
    for named in [
        "RUSTSEC-2099-0001` fixture-vuln 1.0.0",
        "RUSTSEC-2099-0002` fixture-lib 2.1.0",
        &format!("fork {FORK}"),
    ] {
        assert!(
            summary.contains(named),
            "the step summary omits {named}:\n{summary}"
        );
    }
    assert!(
        run.stdout
            .contains(&format!("{FORK} is a fork of {REPOSITORY}")),
        "the log does not say why nothing was posted:\n{}",
        run.all()
    );
}

#[test]
fn a_clean_forks_pull_request_passes_and_posts_nothing() {
    let project = project(&CLEAN, &CLEAN);
    let (run, calls, summary) = status(&project, 0, FORK);
    assert_eq!(run.code, Some(0), "the status step failed:\n{}", run.all());
    assert!(
        calls.is_empty(),
        "a fork's pull request asked gh for: {calls}"
    );
    assert!(
        summary.contains("no advisory matches the resolved graph"),
        "{summary}"
    );
}

#[test]
fn a_head_repository_that_is_not_one_is_refused_before_anything_is_posted() {
    let project = project(&CLEAN, &CLEAN);
    let (run, calls, summary) = status(&project, 0, "not a repository");
    assert_eq!(
        run.code,
        Some(2),
        "the step was not refused:\n{}",
        run.all()
    );
    assert!(calls.is_empty(), "gh was asked for: {calls}");
    assert!(summary.is_empty(), "a summary was written: {summary}");
    assert!(
        run.stderr.contains("is not an owner/name repository"),
        "the refusal did not say why:\n{}",
        run.all()
    );
}

#[test]
fn a_description_too_long_for_github_names_whole_advisories_and_how_many_more() {
    let project = project(&VULNERABLE, &THREE_ADVISORIES);
    let (run, calls, summary) = status(&project, 0, REPOSITORY);
    assert_ne!(run.code, Some(0), "the status step passed:\n{}", run.all());
    let description = calls
        .lines()
        .find_map(|arg| arg.strip_prefix("description="))
        .unwrap_or_else(|| panic!("gh was asked for no description: {calls}"));
    // All three would be 153 characters; GitHub refuses more than 140.
    assert!(
        format!("{VULN}, {LIB_2_1}, {LONG}").chars().count() > 140,
        "the fixture no longer overflows a description"
    );
    assert_eq!(
        description,
        format!("{VULN}, {LIB_2_1}, 1 more in the run's summary")
    );
    assert!(description.chars().count() <= 140);
    for named in [VULN, LIB_2_1, LONG] {
        assert!(
            run.stderr.contains(&format!("advisory {named}")),
            "the log omits {named}:\n{}",
            run.all()
        );
    }
    assert!(
        summary.contains(&format!("RUSTSEC-2099-0003` {LONG_NAME} 1.0.0")),
        "the step summary omits the advisory the description left out:\n{summary}"
    );
}

#[test]
fn a_status_without_its_actions_context_is_refused_before_anything_runs() {
    let project = project(&VULNERABLE, &VULNERABLE);
    let cases: &[(&[(&str, &str)], &str)] = &[
        (&[], "status needs GITHUB_REPOSITORY"),
        (
            &[("GITHUB_REPOSITORY", "not a repository")],
            "GITHUB_REPOSITORY 'not a repository' is not an owner/name repository",
        ),
        (
            &[
                ("GITHUB_REPOSITORY", REPOSITORY),
                ("GITHUB_SERVER_URL", "http://github.com/x"),
            ],
            "GITHUB_SERVER_URL 'http://github.com/x' is not an https origin",
        ),
        (
            &[
                ("GITHUB_REPOSITORY", REPOSITORY),
                ("GITHUB_RUN_ID", "1/../2"),
            ],
            "GITHUB_RUN_ID '1/../2' is not a run id",
        ),
    ];
    for (actions, refusal) in cases {
        let (run, calls, summary) = status_in(&project, 0, REPOSITORY, actions);
        assert_eq!(
            run.code,
            Some(1),
            "{actions:?} was not refused:\n{}",
            run.all()
        );
        assert!(
            run.stderr.contains(refusal) && run.stderr.contains("ACTION:"),
            "{actions:?} did not say {refusal}:\n{}",
            run.all()
        );
        assert!(calls.is_empty(), "gh was asked for: {calls}");
        assert!(summary.is_empty(), "a summary was written: {summary}");
        assert!(!run.all().contains("RUSTSEC-2099-0001"), "{}", run.all());
    }
}

#[test]
fn an_annotation_escapes_what_actions_would_read_as_its_own_syntax() {
    // RUSTSEC-2099-0003's title carries a `%`, which Actions would read as the
    // start of an escape: the annotation must carry it as `%25`.
    let project = project(&VULNERABLE, &THREE_ADVISORIES);
    let (run, _, _) = status(&project, 0, FORK);
    let annotation = format!(
        "::warning title=RUSTSEC-2099-0003 in {LONG_NAME} 1.0.0::\
         Unbounded allocation: 100%25 of memory, in {LONG_NAME}\n"
    );
    assert!(
        run.stdout.contains(&annotation),
        "no escaped {annotation}:\n{}",
        run.all()
    );
}
#[test]
fn a_status_whose_check_did_not_run_is_posted_red_saying_so() {
    let project = project(&VULNERABLE, &VULNERABLE);
    break_database(&project);
    let (run, calls, _) = status(&project, 0, REPOSITORY);
    assert_eq!(run.code, Some(1), "the status step passed:\n{}", run.all());
    let args: Vec<&str> = calls.lines().collect();
    assert!(args.contains(&"state=failure"), "{args:?}");
    assert!(
        args.contains(&"description=the advisories check did not run; see the log"),
        "{args:?}"
    );
}

#[test]
fn a_status_outside_a_run_is_posted_without_a_run_link() {
    let project = project(&CLEAN, &CLEAN);
    let (run, calls, _) = status_in(
        &project,
        0,
        REPOSITORY,
        &[("GITHUB_REPOSITORY", REPOSITORY)],
    );
    assert_eq!(run.code, Some(0), "the status step failed:\n{}", run.all());
    assert!(calls.contains("state=success"), "{calls}");
    assert!(
        !calls.contains("target_url="),
        "a run link was invented: {calls}"
    );
}

#[test]
fn a_step_summary_it_cannot_write_fails_the_step_after_posting() {
    let project = project(&CLEAN, &CLEAN);
    // A directory, which cannot be appended to.
    let directory = project.repo.to_str().expect("a UTF-8 path").to_owned();
    let mut actions = ACTIONS.to_vec();
    actions.push(("GITHUB_STEP_SUMMARY", &directory));
    let (run, calls, _) = status_in(&project, 0, REPOSITORY, &actions);
    assert_eq!(run.code, Some(1), "the status step passed:\n{}", run.all());
    assert!(
        calls.contains("state=success"),
        "the status was not posted: {calls}"
    );
    assert!(
        run.stderr.contains("cannot write the step summary")
            && run
                .stderr
                .contains("ACTION: point GITHUB_STEP_SUMMARY at a writable file"),
        "{}",
        run.all()
    );
}

/// `just <recipe>` with a `cargo` on PATH that answers `cargo deny check
/// advisories` with `output` and `code`, and runs the real cargo for the rest.
fn with_advisories_output(project: &Project, recipe: &str, output: &str, code: i32) -> Run {
    let scratch = project.repo.parent().expect("the repository has a parent");
    let answer = scratch.join("advisories-output");
    fs::write(&answer, output).expect("write the advisories output");
    let cargo = Command::new("sh")
        .args(["-c", "command -v cargo"])
        .output()
        .expect("find cargo");
    let cargo = String::from_utf8(cargo.stdout).expect("a UTF-8 path");
    let path = stub_bin::install(
        &scratch.join("cargo-bin"),
        "cargo",
        &format!(
            "#!/bin/sh\ncase \"$*\" in *'check advisories'*) cat '{}'; exit {code};; esac\n\
             exec '{}' \"$@\"\n",
            answer.display(),
            cargo.trim()
        ),
    );
    just(project, &[recipe], &[("PATH", path.as_os_str())])
}

#[test]
fn advisories_output_it_cannot_read_fails_rather_than_passing_as_none() {
    let project = project(&CLEAN, &CLEAN);
    let unreadable_advisory = r#"{"type":"diagnostic","fields":{"severity":"error","code":"vulnerability","message":"m","advisory":{"id":"RUSTSEC-2099-0001"}}}"#;
    let cases = [
        ("{not json\n".to_owned(), 1, "unparseable output: {not json"),
        (
            format!("{unreadable_advisory}\n"),
            1,
            "an advisory diagnostic this cannot read",
        ),
        (String::new(), 3, "exited 3 with nothing this script reads"),
    ];
    for (output, code, reason) in cases {
        for recipe in ["_crate-deps-check", "advisories-report"] {
            let run = with_advisories_output(&project, recipe, &output, code);
            assert_ne!(
                run.code,
                Some(0),
                "{recipe} passed over {output:?}:\n{}",
                run.all()
            );
            assert!(
                run.stderr.contains(reason)
                    && run
                        .stderr
                        .contains("ACTION: fix the cargo-deny error above"),
                "{recipe} did not say {reason}:\n{}",
                run.all()
            );
        }
    }
}

#[test]
fn a_yanked_crate_still_blocks() {
    let project = project(&CLEAN, &CLEAN);
    let yanked = r#"{"type":"diagnostic","fields":{"severity":"error","code":"yanked","message":"detected yanked crate (try `cargo update -p fixture-lib`)","graphs":[{"Krate":{"name":"fixture-lib","version":"2.0.0"}}]}}"#;
    let run = with_advisories_output(&project, "_crate-deps-check", &format!("{yanked}\n"), 1);
    assert_ne!(run.code, Some(0), "a yanked crate passed:\n{}", run.all());
    assert!(
        run.stderr.contains(
            "yanked: detected yanked crate (try `cargo update -p fixture-lib`) (fixture-lib 2.0.0)"
        ),
        "{}",
        run.all()
    );
}
// llmlint: ignore-end[e2e_not_mocked]
