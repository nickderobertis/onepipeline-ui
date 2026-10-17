//! The judged tier: `just lint-llm-diff`, driven the way the gate and CI drive
//! it, over a throwaway copy of this repository's recipe and Nx target.
//!
//! The tier is llmlint run directly by a cached Nx target, keyed on the tracked
//! tree, the resolved base commit and `llmlint fingerprint`. What these journeys
//! hold it to is what that arrangement has to be worth: a pass is replayed only
//! for the tree, base and judge that produced it, a failure is never replayed,
//! and whatever llmlint printed reaches the caller — on a replay as on a fresh
//! run, and on a failure with no terminal attached.
//!
//! Everything is the real thing but one. The recipe is the committed
//! `justfile`'s, the target is `nx.json`'s and `project.json`'s, Nx is the one
//! this workspace pins, and `llmlint` is the one `just setup-llmlint` installed —
//! found where that installer puts it and never replaced, so a changed judge is
//! told apart by the real `llmlint fingerprint`. The one stand-in is the paid
//! model call: llmlint reaches it through `LLMLINT_ONEHARNESS_BIN`, and the
//! program named there answers `--version` and `config` by handing them to the
//! real `oneharness` installed beside llmlint, so the harness configuration the
//! digest covers is the real one's reading. A judge call is recorded and answered
//! with a verdict, so "was the judge asked again?" is a file count.

// The tier runs bash recipes under Nx, and the scratch workspace borrows this
// checkout's `node_modules` through a symlink. `ci.yml`'s `llmlint` job runs the
// tier on ubuntu alone, and so does the lane that runs these journeys.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

/// What the tier reads out of a checkout, copied verbatim. `llmlint.yml` is
/// read too, and derived below rather than copied whole.
const COPIED: &[&str] = &[
    // The recipe under test.
    "justfile",
    // The cached target: its inputs, and the project that owns it.
    "nx.json",
    "project.json",
    // The Nx this workspace pins, which the borrowed install must match.
    "package.json",
    "bun.lock",
    // Without it `.nx/cache` would be part of the tree Nx hashes, and nothing
    // would ever replay.
    ".gitignore",
    // The harness configuration llmlint judges with.
    "oneharness.toml",
    // The repository's Nx launcher, and the install check it runs first.
    "scripts/nx.sh",
    "scripts/workspace-install.sh",
];

/// The rules the scratch workspace judges with, in place of `llmlint.yml`'s
/// remote plugins: a journey must not fetch the network to learn which rules
/// exist. Everything else in that file is kept.
const RULES: &str = "rules:
  - name: no_todo
    description: \"Files contain no TODO markers.\"
  - name: plain_words
    description: \"Prose is written in plain words.\"
";

/// The stand-in for the paid model call, and the whole of this suite's
/// substitution. `--version` and `config` go to the real `oneharness`; a judge
/// call (`run`) is recorded as one JSON file — the rules it was asked about and
/// the characters its prompt held — and answered as `STANDIN_VERDICT` says:
/// every rule holding (the default), `fail` for one violation on `CHANGED.md`,
/// `none` for a reply answering no rule, `some` for one answering the first rule
/// alone.
const STANDIN_ONEHARNESS: &str = r#"#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version | -V | config) exec "$STANDIN_REAL_ONEHARNESS" "$@" ;;
esac
schema="" system="" prompt="" prev=""
for arg in "$@"; do
  case "$prev" in
    --schema) schema="$arg" ;;
    --system-file) system="$arg" ;;
    --prompt) prompt="$arg" ;;
  esac
  prev="$arg"
done
chars=$(( $(wc -m < "$system") + ${#prompt} ))
record="$(mktemp "$STANDIN_CALLS/call.XXXXXX")"
jq -c --argjson chars "$chars" '{rules: (.properties | keys), chars: $chars}' "$schema" > "$record"
jq -c --arg verdict "${STANDIN_VERDICT:-pass}" '
  (.properties | keys) as $rules
  | ($rules | map({key: ., value: {name: ., rationale: "stand-in", holds: true}}) | from_entries) as $all
  | (if $verdict == "fail" then
       $all + {($rules[0]): {name: $rules[0], rationale: "stand-in found one", holds: false,
                            violations: [{file: "CHANGED.md", line: 1, message: "stand-in violation"}]}}
     elif $verdict == "none" then {}
     elif $verdict == "some" then {($rules[0]): $all[$rules[0]]}
     else $all end) as $structured
  | {schema_version: "0.1", oneharness_version: "stand-in",
     results: [{harness: "codex", status: "ok", exit_code: 0, structured: $structured,
                schema_valid: true, schema_attempts: 1, schema_error: null, error: null}]}' "$schema"
"#;

/// Nx's own words for a replay; one of them is printed on every cache hit.
const NX_REPLAYED: [&str; 2] = [
    "Nx read the output from the cache instead of running the command",
    "Cache: 1/1 hit",
];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The `llmlint` `just setup-llmlint` installed: the first on PATH, else where
/// that installer puts it. Absent, the tier has no judge, and that is a failure
/// of the lane rather than a reason to skip.
fn installed_llmlint() -> PathBuf {
    let on_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|dir| dir.join("llmlint"))
        .find(|candidate| candidate.is_file());
    let fallback =
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin/llmlint"));
    on_path
        .or(fallback.filter(|candidate| candidate.is_file()))
        .expect("llmlint is not installed — run `just setup-llmlint`")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.email=gate@example.invalid",
            "-c",
            "user.name=gate",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git is on PATH");
    assert!(
        output.status.success(),
        "git {args:?} failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("utf-8 git output")
}

/// Both streams together, which is what a caller reading a gate log sees.
fn printed(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// llmlint's summary line, e.g. `2 rules: 2 passed, 0 failed, 0 skipped`.
fn summary_line(output: &Output) -> String {
    printed(output)
        .lines()
        .map(str::trim)
        .find(|line| line.contains(" rules: ") && line.contains(" passed, "))
        .unwrap_or_else(|| panic!("no llmlint summary line in:\n{}", printed(output)))
        .to_owned()
}

fn replayed(output: &Output) -> bool {
    let printed = printed(output);
    NX_REPLAYED.iter().any(|words| printed.contains(words))
}

/// One judge call as the stand-in recorded it.
struct JudgeCall {
    rules: Vec<String>,
    chars: u64,
}

/// A scratch copy of the tier over a git repository whose branch changed one
/// file since its base.
struct Fixture {
    dir: TempDir,
    base: String,
    /// A commit before the base, so "the base moved" is a base this checkout has.
    earlier: String,
    llmlint: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        Self::with_config("")
    }

    /// The same, with `extra` appended to the scratch `llmlint.yml`.
    fn with_config(extra: &str) -> Self {
        let dir = TempDir::new().expect("temp dir");
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join("scripts")).expect("create the scratch workspace");
        for name in COPIED {
            fs::copy(repo_root().join(name), workspace.join(name))
                .unwrap_or_else(|error| panic!("copy {name} into the scratch workspace: {error}"));
        }
        fs::write(
            workspace.join("llmlint.yml"),
            format!("{}{RULES}{extra}", local_config()),
        )
        .expect("write the scratch llmlint.yml");
        // The justfile's variables read these two with backticks before any
        // recipe parses; their contents decide nothing the tier does.
        for manifest in ["Cargo.toml", "Cargo.lock"] {
            fs::write(workspace.join(manifest), "").expect("write a placeholder manifest");
        }
        // Borrowed rather than installed: `scripts/workspace-install.sh` sees the
        // shim and no-ops, as in a bootstrapped clone.
        symlink(
            repo_root().join("node_modules"),
            workspace.join("node_modules"),
        )
        .expect("borrow the workspace's node_modules");

        fs::create_dir_all(dir.path().join("home")).expect("create the scratch home");
        fs::create_dir_all(dir.path().join("calls")).expect("create the judge-call log");
        let standin = dir.path().join("oneharness");
        fs::write(&standin, STANDIN_ONEHARNESS).expect("write the stand-in oneharness");
        fs::set_permissions(&standin, fs::Permissions::from_mode(0o755))
            .expect("make the stand-in executable");

        git(&workspace, &["init", "--quiet"]);
        git(&workspace, &["add", "-A"]);
        git(&workspace, &["commit", "--quiet", "-m", "the repository"]);
        let earlier = git(&workspace, &["rev-parse", "HEAD"]).trim().to_owned();
        fs::write(workspace.join("BEFORE.md"), "already on the base branch\n").expect("write");
        git(&workspace, &["add", "-A"]);
        git(&workspace, &["commit", "--quiet", "-m", "the base"]);
        let base = git(&workspace, &["rev-parse", "HEAD"]).trim().to_owned();
        fs::write(workspace.join("CHANGED.md"), "the change under judgement\n").expect("write");
        git(&workspace, &["add", "-A"]);
        git(&workspace, &["commit", "--quiet", "-m", "the change"]);

        Self {
            dir,
            base,
            earlier,
            llmlint: installed_llmlint(),
        }
    }

    fn workspace(&self) -> PathBuf {
        self.dir.path().join("workspace")
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    /// The environment every program here runs under: the scratch home, the
    /// installed llmlint first on PATH, the stand-in named as its harness, and
    /// nothing inherited that would steer llmlint, oneharness or Nx.
    fn command(&self, program: &str) -> Command {
        let mut command = Command::new(program);
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy();
            if ["LLMLINT_", "ONEHARNESS_", "NX_"]
                .iter()
                .any(|prefix| key.starts_with(prefix))
            {
                command.env_remove(&name);
            }
        }
        let bin = self.llmlint.parent().expect("llmlint has a directory");
        let mut path = vec![bin.to_path_buf()];
        path.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let real = fs::canonicalize(&self.llmlint)
            .expect("resolve the installed llmlint")
            .with_file_name("oneharness");
        assert!(
            real.is_file(),
            "no oneharness beside the installed llmlint at {} — run `just setup-llmlint`",
            real.display()
        );
        command
            .current_dir(self.workspace())
            .env("PATH", std::env::join_paths(path).expect("join PATH"))
            .env("HOME", self.home())
            .env("LLMLINT_ONEHARNESS_BIN", self.dir.path().join("oneharness"))
            .env("STANDIN_REAL_ONEHARNESS", real)
            .env("STANDIN_CALLS", self.dir.path().join("calls"));
        command
    }

    /// `just lint-llm-diff <base> [nx args]`, with `environment` layered on.
    fn run(&self, base: &str, environment: &[(&str, &str)], nx_args: &[&str]) -> Output {
        let mut command = self.command("just");
        command.arg("lint-llm-diff").arg(base).args(nx_args);
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("just is on PATH")
    }

    fn run_base(&self) -> Output {
        self.run(&self.base.clone(), &[], &[])
    }

    /// The real `llmlint fingerprint` for this workspace, as the target's
    /// runtime input reads it.
    fn fingerprint(&self) -> String {
        let output = self
            .command(self.llmlint.to_str().expect("utf-8 path"))
            .arg("fingerprint")
            .output()
            .expect("run llmlint fingerprint");
        assert!(
            output.status.success(),
            "llmlint fingerprint failed:\n{}",
            printed(&output)
        );
        String::from_utf8(output.stdout)
            .expect("utf-8 fingerprint")
            .trim()
            .to_owned()
    }

    fn judge_calls(&self) -> Vec<JudgeCall> {
        let mut calls: Vec<JudgeCall> = fs::read_dir(self.dir.path().join("calls"))
            .expect("read the judge-call log")
            .map(|entry| {
                let text = fs::read_to_string(entry.expect("a judge call").path())
                    .expect("read a judge call");
                let record: Value = serde_json::from_str(&text).expect("a recorded judge call");
                JudgeCall {
                    rules: record["rules"]
                        .as_array()
                        .expect("recorded rules")
                        .iter()
                        .map(|rule| rule.as_str().expect("a rule name").to_owned())
                        .collect(),
                    chars: record["chars"].as_u64().expect("recorded prompt size"),
                }
            })
            .collect();
        calls.sort_by_key(|call| call.chars);
        calls
    }

    /// Commit `contents` at `name` in the workspace.
    fn commit(&self, name: &str, contents: &str) {
        fs::write(self.workspace().join(name), contents).expect("write the change");
        git(&self.workspace(), &["add", "-A"]);
        git(&self.workspace(), &["commit", "--quiet", "-m", name]);
    }
}

/// This repository's `llmlint.yml` up to its remote `plugins:` list, which is
/// its last key.
fn local_config() -> String {
    let config = fs::read_to_string(repo_root().join("llmlint.yml")).expect("read llmlint.yml");
    let (local, plugins) = config
        .split_once("\nplugins:\n")
        .expect("llmlint.yml declares its plugins");
    assert!(
        plugins
            .lines()
            .all(|line| line.trim().is_empty() || line.trim_start().starts_with(['-', '#'])),
        "llmlint.yml has a key after `plugins:`, which the scratch copy would drop:\n{plugins}"
    );
    format!("{local}\n")
}

fn assert_passed(output: &Output) {
    assert!(
        output.status.success(),
        "the tier failed:\n{}",
        printed(output)
    );
}

/// A first pass is judged and says against which commit; the same tree, base and
/// judge then replay it — llmlint's own summary and all — without asking the
/// judge again, and `--skip-nx-cache` reaches Nx and rolls afresh.
#[test]
fn a_pass_is_judged_once_and_then_replayed() {
    let fixture = Fixture::new();

    let first = fixture.run_base();
    assert_passed(&first);
    assert!(
        printed(&first).contains(&format!(
            "lint-llm-diff: judging against base {}",
            fixture.base
        )),
        "the run did not name the base commit it judged against:\n{}",
        printed(&first)
    );
    let judged = fixture.judge_calls().len();
    assert!(judged > 0, "the first pass asked the judge nothing");
    assert!(
        !replayed(&first),
        "a first pass was a replay:\n{}",
        printed(&first)
    );

    let second = fixture.run_base();
    assert_passed(&second);
    assert_eq!(
        fixture.judge_calls().len(),
        judged,
        "an unchanged tree was judged again"
    );
    assert!(
        replayed(&second),
        "Nx did not report a replay:\n{}",
        printed(&second)
    );
    assert_eq!(summary_line(&second), summary_line(&first));

    let forced = fixture.run(&fixture.base, &[], &["--skip-nx-cache"]);
    assert_passed(&forced);
    assert!(
        fixture.judge_calls().len() > judged,
        "`--skip-nx-cache` did not reach Nx"
    );
}

/// A pass is a pass against one base commit: a new base is judged, and each base
/// then replays its own pass.
#[test]
fn each_base_commit_gets_its_own_verdict() {
    let fixture = Fixture::new();

    assert_passed(&fixture.run_base());
    let after_base = fixture.judge_calls().len();
    let earlier = fixture.run(&fixture.earlier, &[], &[]);
    assert_passed(&earlier);
    assert!(
        printed(&earlier).contains(&fixture.earlier),
        "the run did not name the new base:\n{}",
        printed(&earlier)
    );
    let after_earlier = fixture.judge_calls().len();
    assert!(
        after_earlier > after_base,
        "a new base replayed the old base's pass"
    );

    assert!(
        replayed(&fixture.run_base()),
        "the first base did not replay its pass"
    );
    assert!(
        replayed(&fixture.run(&fixture.earlier, &[], &[])),
        "the second base did not replay its pass"
    );
    assert_eq!(fixture.judge_calls().len(), after_earlier);
}

/// A changed rule moves the real judge digest and is judged again.
#[test]
fn a_changed_rule_is_judged_again() {
    let fixture = Fixture::new();
    assert_passed(&fixture.run_base());
    let judged = fixture.judge_calls().len();
    let before = fixture.fingerprint();

    let config = fs::read_to_string(fixture.workspace().join("llmlint.yml")).expect("read");
    fixture.commit(
        "llmlint.yml",
        &config.replace(
            "Files contain no TODO markers.",
            "Files contain no FIXME markers.",
        ),
    );
    assert_ne!(
        fixture.fingerprint(),
        before,
        "a changed rule left the digest unchanged"
    );

    assert_passed(&fixture.run_base());
    assert!(
        fixture.judge_calls().len() > judged,
        "a changed rule replayed the old pass"
    );
}

/// A changed harness model moves the real digest and is judged again — from a
/// configuration outside the tree, where the digest is the only input that sees
/// it, and from the tracked `oneharness.toml`.
#[test]
fn a_changed_harness_model_is_judged_again() {
    let fixture = Fixture::new();
    assert_passed(&fixture.run_base());
    let judged = fixture.judge_calls().len();
    let before = fixture.fingerprint();

    let user_config = fixture.home().join(".config/oneharness/config.toml");
    fs::create_dir_all(user_config.parent().expect("a directory")).expect("create");
    fs::write(&user_config, "model = \"claude-sonnet-5-5\"\n").expect("write");
    let out_of_tree = fixture.fingerprint();
    assert_ne!(
        out_of_tree, before,
        "a user-level model left the digest unchanged"
    );
    assert_eq!(git(&fixture.workspace(), &["status", "--porcelain"]), "");
    assert_passed(&fixture.run_base());
    let after_user = fixture.judge_calls().len();
    assert!(
        after_user > judged,
        "a changed user-level model replayed the old pass"
    );

    let harness = fs::read_to_string(fixture.workspace().join("oneharness.toml")).expect("read");
    let moved = harness.replacen("model = \"", "model = \"moved-", 1);
    assert_ne!(moved, harness, "oneharness.toml names no model to move");
    fixture.commit("oneharness.toml", &moved);
    assert_ne!(
        fixture.fingerprint(),
        out_of_tree,
        "a changed model left the digest unchanged"
    );
    assert_passed(&fixture.run_base());
    assert!(
        fixture.judge_calls().len() > after_user,
        "a changed tracked model replayed the old pass"
    );
}

/// A changed tracked file is judged again.
#[test]
fn a_changed_file_is_judged_again() {
    let fixture = Fixture::new();
    assert_passed(&fixture.run_base());
    let judged = fixture.judge_calls().len();

    fixture.commit("CHANGED.md", "the change, revised\n");
    let output = fixture.run_base();
    assert_passed(&output);
    assert!(
        fixture.judge_calls().len() > judged,
        "a changed file replayed the old pass"
    );
    assert!(
        !replayed(&output),
        "Nx replayed a changed tree:\n{}",
        printed(&output)
    );
}

/// A failing verdict reaches a caller with no terminal — as CI and a dispatched
/// agent run it — naming llmlint's rule and file, and is never replayed.
#[test]
fn a_failing_verdict_is_reported_and_judged_again() {
    let fixture = Fixture::new();
    let failing = [
        ("STANDIN_VERDICT", "fail"),
        ("CI", "true"),
        ("CLAUDECODE", "1"),
    ];

    let first = fixture.run(&fixture.base, &failing, &[]);
    assert!(
        !first.status.success(),
        "a failing verdict passed:\n{}",
        printed(&first)
    );
    for expected in ["FAIL no_todo", "CHANGED.md:1: stand-in violation"] {
        assert!(
            printed(&first).contains(expected),
            "the failure did not reach the caller (`{expected}` missing):\n{}",
            printed(&first)
        );
    }
    let judged = fixture.judge_calls().len();
    assert!(judged > 0);

    let second = fixture.run(&fixture.base, &failing, &[]);
    assert!(
        !second.status.success(),
        "the second run passed:\n{}",
        printed(&second)
    );
    assert!(
        fixture.judge_calls().len() > judged,
        "a failure was replayed"
    );
    assert!(
        !replayed(&second),
        "Nx replayed a failure:\n{}",
        printed(&second)
    );
}

/// A reply answering none of the selected rules, or only some, is no verdict:
/// the tier fails naming each unanswered rule, and the next run judges again.
#[test]
fn an_unanswered_rule_fails_and_is_judged_again() {
    for (reply, unanswered, answered) in [
        ("none", &["no_todo", "plain_words"][..], &[][..]),
        ("some", &["plain_words"][..], &["no_todo"][..]),
    ] {
        let fixture = Fixture::new();
        let output = fixture.run(&fixture.base, &[("STANDIN_VERDICT", reply)], &[]);
        assert!(
            !output.status.success(),
            "a reply answering {reply} of the rules passed:\n{}",
            printed(&output)
        );
        let printed = printed(&output);
        for rule in unanswered {
            assert!(
                printed.contains(&format!(
                    "rule {rule}: the judge returned no verdict for it"
                )),
                "the {reply} reply did not name `{rule}`:\n{printed}"
            );
        }
        for rule in answered {
            assert!(
                !printed.contains(&format!("rule {rule}: the judge returned no verdict")),
                "the {reply} reply named an answered rule `{rule}`:\n{printed}"
            );
        }
        let judged = fixture.judge_calls().len();
        let again = fixture.run(&fixture.base, &[("STANDIN_VERDICT", reply)], &[]);
        assert!(!again.status.success());
        assert!(
            fixture.judge_calls().len() > judged,
            "a reply answering {reply} of the rules was replayed"
        );
    }
}

/// A base that does not resolve is refused, naming it, before any judge call.
#[test]
fn an_unresolvable_base_is_refused_before_judging() {
    let fixture = Fixture::new();
    let output = fixture.run("no-such-base", &[], &[]);
    assert_eq!(output.status.code(), Some(2), "{}", printed(&output));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("base 'no-such-base' does not resolve"),
        "the refusal did not name the base:\n{}",
        printed(&output)
    );
    assert!(
        fixture.judge_calls().is_empty(),
        "the judge was asked about an unresolved base"
    );
}

/// A diff too large for one judge prompt is judged in several calls, each
/// within the bound in force, and passes: llmlint's own `max_prompt_chars`
/// does the splitting, with nothing of this repository's in between.
#[test]
fn a_diff_larger_than_one_prompt_is_judged_in_several_calls() {
    const BOUND: u64 = 12_000;
    let fixture = Fixture::with_config(&format!("max_prompt_chars: {BOUND}\n"));
    for index in 1..=6 {
        let line = format!("{}\n", "word ".repeat(15));
        fixture.commit(&format!("LARGE-{index}.md"), &line.repeat(40));
    }

    let output = fixture.run_base();
    assert_passed(&output);
    let calls = fixture.judge_calls();
    let total: u64 = calls.iter().map(|call| call.chars).sum();
    assert!(calls.len() >= 2, "the diff was judged in one call");
    assert!(
        total > BOUND,
        "the diff fit one prompt ({total} characters)"
    );
    for call in &calls {
        assert!(
            call.chars <= BOUND,
            "a judge prompt held {} characters, over the {BOUND} bound",
            call.chars
        );
        assert_eq!(call.rules, ["no_todo", "plain_words"]);
    }
}
