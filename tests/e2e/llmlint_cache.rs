//! The judged tier's memo: `just lint-llm-diff`, driven the way the gate and CI
//! drive it, over a real Nx workspace and a real git repository.
//!
//! The judge is non-deterministic across the gap between what it judges and what
//! changed — it judges every file in the base-to-head diff, because llmlint has
//! no increment mode, while what changed is one hunk. Rolls of one branch have
//! named a different rule each time, and one gate invocation over one tree has
//! returned two opposite verdicts. So the tier is memoized, and these journeys
//! are what that memo has to be worth: one tree judged against one base with one
//! judge configuration gets **one** verdict, and each of the three moving on
//! costs a real re-judge rather than a replay.
//!
//! Everything here is the real thing but one. The recipe is the committed
//! `justfile`'s, the Nx target is `nx.json`'s and `project.json`'s, the scripts
//! are the ones the gate runs, and the workspace is a git repository with a base
//! commit and a change — because what is being asserted is a cache key, and a key
//! computed over a stub workspace would key nothing this repository has.
//!
//! The one stand-in is `llmlint` itself. The real one bills a model call and is
//! the very thing whose answer varies, so a journey that drove it could not tell
//! a replay from a lucky reroll. It stands in from inside the scratch `HOME`,
//! which is also how these journeys check that the tier resolves its judge
//! through `scripts/llmlint-runtime-env.sh` rather than through whatever the
//! caller had on PATH.

// The tier is bash scripts fanned out by Nx, and its scratch workspace reaches
// the orchestrator through a symlinked `node_modules` — which on Windows needs a
// privilege a test runner does not have. Nothing is lost by scoping to the
// platforms that run this tier: `.github/workflows/ci.yml` runs the `llmlint` job
// on ubuntu alone, and `just check-cross`, which is what macOS and Windows run,
// covers the deterministic tiers rather than this one.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

/// Everything the cached tier reads out of a checkout, and nothing else. Spelled
/// out rather than swept up, so a file this tier starts depending on has to be
/// named here — which is the same list an operator would have to explain.
const WORKSPACE_FILES: &[&str] = &[
    // The recipe under test, and the two manifests whose backticks `just`
    // evaluates before it will parse that recipe at all.
    "justfile",
    "Cargo.toml",
    "Cargo.lock",
    // The cached target: its defaults and inputs, and the project that owns it.
    "nx.json",
    "project.json",
    "package.json",
    "package-lock.json",
    // Without this, `.nx/cache` would be a tracked part of the workspace Nx
    // hashes, so every run would change the tree and nothing would ever replay.
    ".gitignore",
    // The tier itself, end to end.
    "scripts/nx.sh",
    "scripts/workspace-install.sh",
    "scripts/lint-llm-diff.sh",
    "scripts/llmlint-cached-diff.sh",
    "scripts/llmlint-judge.sh",
    "scripts/llmlint-fingerprint.sh",
    "scripts/llmlint-runtime-env.sh",
];

/// The stand-in judge, and the whole of this suite's substitution.
///
/// It answers the two questions `scripts/llmlint-fingerprint.sh` asks — its
/// version, and its effective merged configuration — from its environment rather
/// than from the workspace, which is what lets a journey move the judge
/// configuration without touching the tree. Everything else is a judge call: it
/// is recorded, and it answers with a verdict naming which call it was, so a
/// replayed report is distinguishable from a fresh one that happens to agree.
///
/// llmlint: ignore-file[e2e_not_mocked] the real `llmlint` bills a model call and
/// is precisely the thing whose answer varies between two runs over one tree — a
/// journey that drove it could not tell a replayed verdict from a lucky reroll,
/// which is the entire subject here. This is the narrowest cut available: the
/// recipe, the Nx target, the scripts and the workspace are all real, and the
/// stand-in only makes "was the judge asked again?" readable. This constant is
/// the whole of that substitution.
const STUB_LLMLINT: &str = "#!/usr/bin/env bash\n\
     set -eu\n\
     case \"${1:-}\" in\n\
       --version)\n\
         [ -z \"${STUB_VERSION_STATUS:-}\" ] || { echo 'stub llmlint: cannot report a version' >&2; exit \"$STUB_VERSION_STATUS\"; }\n\
         printf 'llmlint %s\\n' \"${STUB_LLMLINT_VERSION:-9.9.9}\"; exit 0 ;;\n\
       config)\n\
         [ -z \"${STUB_CONFIG_STATUS:-}\" ] || { echo 'stub llmlint: cannot resolve the config' >&2; exit \"$STUB_CONFIG_STATUS\"; }\n\
         printf 'rules=%s\\noneharness_bin=%s\\nconfig_file=%s/llmlint.yml\\n' \"${STUB_CONFIG_RULES:-baseline}\" \"${LLMLINT_ONEHARNESS_BIN:-null}\" \"$PWD\"\n\
         exit 0 ;;\n\
     esac\n\
     printf '%s\\n' \"$*\" >> \"$STUB_CALLS\"\n\
     printf 'stub llmlint verdict #%s\\n' \"$(wc -l < \"$STUB_CALLS\" | tr -d ' ')\"\n\
     exit \"${STUB_JUDGE_STATUS:-0}\"\n";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Both streams together. Which one a *replayed* report arrives on is Nx's
/// choice — it records one terminal output and hands it back whole — so a
/// journey asserting on the judge's own words reads both.
fn reported(output: &Output) -> String {
    format!("{}{}", stdout(output), stderr(output))
}

/// What one run said about where its verdict came from, as the recipe reports it.
#[derive(Debug, PartialEq, Eq)]
enum Provenance {
    Judged,
    Replayed,
}

/// A scratch Nx workspace carrying this repository's own tier, over a git
/// repository whose branch commit changed one file.
struct Fixture {
    dir: TempDir,
    /// The base the journeys judge against.
    base: String,
    /// A commit before it, so "the base moved" is a base this checkout really
    /// has and really diffs differently against.
    earlier: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join("scripts")).expect("create the scratch workspace");
        for name in WORKSPACE_FILES {
            fs::copy(repo_root().join(name), workspace.join(name))
                .unwrap_or_else(|error| panic!("copy {name} into the scratch workspace: {error}"));
        }
        // The orchestrator itself, borrowed rather than installed: `npm ci` here
        // would cost minutes per test, and Nx is a tool this tier runs, not a
        // thing it decides. `scripts/workspace-install.sh` sees the shim and
        // no-ops, exactly as it does in a bootstrapped clone.
        symlink(
            repo_root().join("node_modules"),
            workspace.join("node_modules"),
        )
        .expect("borrow the workspace's node_modules");

        git(&workspace, &["init", "--quiet"]);
        git(&workspace, &["add", "-A"]);
        git(&workspace, &["commit", "--quiet", "-m", "the repository"]);
        // Commits rather than branch names: what the recipe resolves a base *to*
        // is the point, and a commit resolves the same however this git was
        // configured to name its first branch.
        let earlier = git(&workspace, &["rev-parse", "HEAD"]).trim().to_owned();

        fs::write(workspace.join("BEFORE.md"), "already on the base branch\n")
            .expect("write the earlier commit");
        git(&workspace, &["add", "-A"]);
        git(
            &workspace,
            &[
                "commit",
                "--quiet",
                "-m",
                "the base this branch forked from",
            ],
        );
        let base = git(&workspace, &["rev-parse", "HEAD"]).trim().to_owned();

        fs::write(workspace.join("CHANGED.md"), "the change under judgement\n")
            .expect("write the change");
        git(&workspace, &["add", "-A"]);
        git(&workspace, &["commit", "--quiet", "-m", "the change"]);

        // Into the scratch `HOME`, which is where `just setup-llmlint` installs
        // the real one — so the tier reaches it only by resolving its judge
        // through `scripts/llmlint-runtime-env.sh`. The search path this answers
        // with is deliberately dropped rather than used: putting the stand-in on
        // PATH as well would resolve it whether or not that runtime environment
        // works, which is one of the things these journeys are here to assert.
        let _on_path =
            stub_bin::install(&dir.path().join("home/.local/bin"), "llmlint", STUB_LLMLINT);

        Self { dir, base, earlier }
    }

    fn workspace(&self) -> PathBuf {
        self.dir.path().join("workspace")
    }

    fn calls_log(&self) -> PathBuf {
        self.dir.path().join("judge-calls.log")
    }

    /// Run the recipe the gate and CI run, against this fixture's base.
    fn run(&self) -> Output {
        self.run_full(&self.base.clone(), &[], &[])
    }

    /// The same, with `environment` layered on and `nx_args` forwarded.
    fn run_with(&self, environment: &[(&str, &str)], nx_args: &[&str]) -> Output {
        self.run_full(&self.base.clone(), environment, nx_args)
    }

    fn run_full(&self, base: &str, environment: &[(&str, &str)], nx_args: &[&str]) -> Output {
        let mut command = Command::new("just");
        command
            .arg("lint-llm-diff")
            .arg(base)
            .args(nx_args)
            .current_dir(self.workspace())
            // The scratch home is where the stand-in judge lives, so this is also
            // what makes `scripts/llmlint-runtime-env.sh` resolve it: the tier
            // prepends `$HOME/.local/bin`, which is where `just setup-llmlint`
            // installs the real one.
            .env("HOME", self.dir.path().join("home"))
            .env("STUB_CALLS", self.calls_log());
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("just is on PATH")
    }

    /// The cached target's body, run exactly as `project.json` tells Nx to run
    /// it. That is the real usage the guards below exist for: they catch a target
    /// reached without `just lint-llm-diff` in front of it, which has had no base
    /// resolved for it, and `scripts/llmlint-judge.sh` says so in its own header.
    ///
    /// Reaching it through `just nx run onepipeline-ui:lint-llm-diff` was tried
    /// and is not usable here: these refusals fail in tens of milliseconds, and
    /// Nx drops a task's stderr that fast often enough — one run in four, under
    /// the load of the whole suite — that the journey would assert on a refusal
    /// message Nx had swallowed. The 17 journeys either side of these two drive
    /// the recipe, which is where that entry point is covered.
    fn run_judge_target(&self, environment: &[(&str, &str)]) -> Output {
        let mut command = Command::new("bash");
        command
            .arg("scripts/llmlint-judge.sh")
            .current_dir(self.workspace())
            .env("HOME", self.dir.path().join("home"))
            .env("STUB_CALLS", self.calls_log())
            .env_remove("LLMLINT_DIFF_BASE_SHA");
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("bash is on PATH")
    }

    /// The judge-configuration fingerprint this workspace resolves, through the
    /// script the recipe resolves it with.
    fn judge_fingerprint(&self) -> String {
        let output = Command::new("bash")
            .arg("scripts/llmlint-fingerprint.sh")
            .current_dir(self.workspace())
            .env("HOME", self.dir.path().join("home"))
            .output()
            .expect("bash is on PATH");
        assert!(
            output.status.success(),
            "the fingerprint could not be resolved:\n{}",
            stderr(&output)
        );
        stdout(&output).trim().to_owned()
    }

    /// Every judge call the tier asked for, in order.
    fn judge_calls(&self) -> Vec<String> {
        fs::read_to_string(self.calls_log())
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

/// Where the run said its verdict came from. Read off the recipe's own line
/// rather than off Nx's, because that line is this tier's contract with an
/// operator reading a gate log — and it is what a wrong reading would mislabel.
fn provenance(output: &Output) -> Provenance {
    let reported = stderr(output);
    let replayed = reported.contains("lint-llm-diff: replayed the recorded verdict");
    let judged = reported.contains("lint-llm-diff: judged this diff against base");
    assert!(
        replayed ^ judged,
        "the run did not report exactly one provenance:\n{reported}"
    );
    if replayed {
        Provenance::Replayed
    } else {
        Provenance::Judged
    }
}

/// The whole point of the memo: a second gate over an unchanged tree and an
/// unchanged base does not roll the dice again, it replays the first roll.
#[test]
fn a_second_run_over_an_unchanged_tree_replays_the_first_verdict() {
    let fixture = Fixture::new();

    let first = fixture.run();
    let second = fixture.run();

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(second.status.success(), "{}", stderr(&second));
    assert_eq!(provenance(&first), Provenance::Judged);
    assert_eq!(provenance(&second), Provenance::Replayed);
    assert_eq!(
        fixture.judge_calls().len(),
        1,
        "the judge was asked twice, so the tier is still an independent roll per run"
    );
    // Nx annotates its own task line on a hit, so what has to match is the
    // judge's report inside it — which is the verdict a reader came for.
    assert!(
        reported(&first).contains("stub llmlint verdict #1")
            && reported(&second).contains("stub llmlint verdict #1"),
        "the replayed run did not reproduce the recorded verdict:\nfirst:\n{}\nsecond:\n{}",
        reported(&first),
        reported(&second)
    );
}

/// The tree is in the key, so the hunk a worker just wrote is judged rather than
/// answered from the verdict its predecessor earned.
#[test]
fn a_changed_tree_is_judged_again() {
    let fixture = Fixture::new();

    let first = fixture.run();
    fs::write(fixture.workspace().join("CHANGED.md"), "a second hunk\n").expect("change the tree");
    let second = fixture.run();

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(second.status.success(), "{}", stderr(&second));
    assert_eq!(provenance(&second), Provenance::Judged);
    assert_eq!(fixture.judge_calls().len(), 2);
}

/// "Green" means green *against that commit*, so a base that moved is a
/// different question and gets a fresh answer.
#[test]
fn a_base_that_moved_is_judged_again() {
    let fixture = Fixture::new();

    let first = fixture.run();
    let earlier = fixture.earlier.clone();
    let second = fixture.run_full(&earlier, &[], &[]);

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(second.status.success(), "{}", stderr(&second));
    assert_eq!(provenance(&second), Provenance::Judged);
    assert_eq!(fixture.judge_calls().len(), 2);
    let judged = fixture.judge_calls();
    assert!(
        judged[1].contains(&earlier),
        "the second run judged against the wrong base: {}",
        judged[1]
    );
}

/// The judge configuration is in the key, and it has to be — the rules come from
/// plugins pinned in `llmlint.yml` but fetched from outside this repository, so a
/// rule can change with no file in the tree changing at all. Moved here the same
/// way: entirely outside the workspace.
#[test]
fn a_judge_configuration_that_moved_outside_the_tree_is_judged_again() {
    let fixture = Fixture::new();

    let first = fixture.run();
    let second = fixture.run_with(&[("STUB_CONFIG_RULES", "a rule the plugin added")], &[]);
    let third = fixture.run();

    assert!(second.status.success(), "{}", stderr(&second));
    assert_eq!(provenance(&first), Provenance::Judged);
    assert_eq!(
        provenance(&second),
        Provenance::Judged,
        "a changed judge configuration replayed a verdict it has moved on from"
    );
    assert_eq!(
        provenance(&third),
        Provenance::Replayed,
        "the original configuration's own verdict should still be on record"
    );
    assert_eq!(fixture.judge_calls().len(), 2);
}

/// The *installed* llmlint version is in the key beside the merged config, and it
/// has to be: no tracked file in this repository records it, so an upgraded judge
/// would otherwise answer from a verdict the version it replaced produced.
#[test]
fn an_upgraded_llmlint_is_judged_again() {
    let fixture = Fixture::new();

    let first = fixture.run();
    let upgraded = fixture.run_with(&[("STUB_LLMLINT_VERSION", "9.9.10")], &[]);
    let original = fixture.run();

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(upgraded.status.success(), "{}", stderr(&upgraded));
    assert_eq!(provenance(&first), Provenance::Judged);
    assert_eq!(
        provenance(&upgraded),
        Provenance::Judged,
        "an upgraded llmlint replayed the verdict the version it replaced produced"
    );
    assert_eq!(
        provenance(&original),
        Provenance::Replayed,
        "the version that recorded it should still have its own verdict"
    );
    assert_eq!(fixture.judge_calls().len(), 2);
}

/// The shard budget is in the key beside the fingerprint, because it is the other
/// half of the same question. `scripts/lint-llm-diff.sh` splits a change too large
/// for one harness turn across several judge calls, and a rule that needs two
/// files together only sees them together when they share a shard — so a verdict
/// reached under one budget is not a verdict under another.
#[test]
fn a_changed_shard_budget_is_judged_again() {
    let fixture = Fixture::new();

    let first = fixture.run();
    let rebudgeted = fixture.run_with(&[("LLMLINT_SHARD_BUDGET_CHARS", "4000")], &[]);
    let original = fixture.run();

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(rebudgeted.status.success(), "{}", stderr(&rebudgeted));
    assert_eq!(provenance(&first), Provenance::Judged);
    assert_eq!(
        provenance(&rebudgeted),
        Provenance::Judged,
        "a change split differently across judge calls replayed the other split's verdict"
    );
    assert_eq!(
        provenance(&original),
        Provenance::Replayed,
        "the budget that recorded it should still have its own verdict"
    );
    assert_eq!(fixture.judge_calls().len(), 2);
}

/// The subtle half. `llmlint config` renders the resolved oneharness binary, and
/// this host really does leak one — a checkout of another repository exports
/// `LLMLINT_ONEHARNESS_BIN` at its own wrapper. Read from the caller, that would
/// hash one judged diff to a different key per dispatch and re-roll the judge
/// every round, so the fingerprint resolves it through the environment the target
/// itself judges under.
#[test]
fn a_callers_environment_cannot_change_the_key_for_one_judged_diff() {
    let fixture = Fixture::new();

    let first = fixture.run_with(
        &[("LLMLINT_ONEHARNESS_BIN", "/dispatch-one/wrapper.sh")],
        &[],
    );
    let second = fixture.run_with(
        &[("LLMLINT_ONEHARNESS_BIN", "/dispatch-two/wrapper.sh")],
        &[],
    );

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(second.status.success(), "{}", stderr(&second));
    assert_eq!(provenance(&first), Provenance::Judged);
    assert_eq!(
        provenance(&second),
        Provenance::Replayed,
        "the caller's environment reached the cache key, so every dispatch re-rolls the judge"
    );
    assert_eq!(fixture.judge_calls().len(), 1);
}

/// A fingerprint that cannot be produced must stop the tier, not quietly leave
/// the judge configuration out of the key. Nx scores a failing `runtime` input as
/// no contribution rather than as an error, which is why the recipe resolves this
/// itself — and why the failure has to be asserted as *fatal* rather than as
/// merely logged.
#[test]
fn a_fingerprint_that_cannot_be_produced_fails_the_tier_rather_than_replaying() {
    let fixture = Fixture::new();

    let recorded = fixture.run();
    let broken = fixture.run_with(&[("STUB_CONFIG_STATUS", "3")], &[]);

    assert!(recorded.status.success(), "{}", stderr(&recorded));
    assert_eq!(
        broken.status.code(),
        Some(2),
        "a tier with no fingerprint reported something other than a usage error:\n{}",
        stderr(&broken)
    );
    assert!(
        stderr(&broken).contains("refusing to judge without a fingerprint"),
        "the failure does not say why it stopped:\n{}",
        stderr(&broken)
    );
    assert_eq!(
        fixture.judge_calls().len(),
        1,
        "the tier judged, or replayed, without a fingerprint of the judge configuration"
    );
}

/// Only a green is memoized. Findings are re-judged every run — the deliberate
/// price of having no verdict record of our own to write, restore, or race on.
#[test]
fn findings_are_judged_again_rather_than_replayed() {
    let fixture = Fixture::new();

    let first = fixture.run_with(&[("STUB_JUDGE_STATUS", "1")], &[]);
    let second = fixture.run_with(&[("STUB_JUDGE_STATUS", "1")], &[]);

    assert_eq!(first.status.code(), Some(1), "{}", stderr(&first));
    assert_eq!(second.status.code(), Some(1), "{}", stderr(&second));
    assert_eq!(provenance(&second), Provenance::Judged);
    assert_eq!(fixture.judge_calls().len(), 2);
}

/// A judge that never reached a verdict is not a finding to clear, and it is not
/// cached either. Nx reports every failed task as exit 1, so the tier restores
/// the status llmlint actually exited with — the difference between "clear this"
/// and "repair the toolchain".
#[test]
fn a_judge_that_never_reached_a_verdict_is_judged_again_and_keeps_its_exit_code() {
    let fixture = Fixture::new();

    let first = fixture.run_with(&[("STUB_JUDGE_STATUS", "2")], &[]);
    let second = fixture.run_with(&[("STUB_JUDGE_STATUS", "2")], &[]);

    assert_eq!(
        first.status.code(),
        Some(2),
        "a judge that never reached a verdict was reported as findings:\n{}",
        stderr(&first)
    );
    assert_eq!(second.status.code(), Some(2), "{}", stderr(&second));
    assert!(
        stderr(&first).contains("never reached a verdict"),
        "the failure does not distinguish itself from a finding, or did not reach stderr:\n{}",
        stderr(&first)
    );
    assert_eq!(provenance(&second), Provenance::Judged);
    assert_eq!(fixture.judge_calls().len(), 2);
}

/// The one supported way to force a fresh roll, and it is per-invocation on
/// purpose: it neither reads the recorded verdict nor overwrites it, so the next
/// ordinary run still replays the entry that was there before.
#[test]
fn the_per_invocation_option_re_judges_without_reading_or_writing_the_cache() {
    let fixture = Fixture::new();

    let recorded = fixture.run();
    let forced = fixture.run_with(&[], &["--skip-nx-cache"]);
    let after = fixture.run();

    assert!(recorded.status.success(), "{}", stderr(&recorded));
    assert!(forced.status.success(), "{}", stderr(&forced));
    assert!(after.status.success(), "{}", stderr(&after));
    assert_eq!(
        provenance(&forced),
        Provenance::Judged,
        "--skip-nx-cache read the cache instead of re-judging"
    );
    assert_eq!(fixture.judge_calls().len(), 2);
    assert_eq!(provenance(&after), Provenance::Replayed);
    assert!(
        reported(&after).contains("stub llmlint verdict #1"),
        "the forced run overwrote the recorded verdict:\n{}",
        reported(&after)
    );
}

/// The provenance line is read back out of Nx's own wording, and Nx paints that
/// wording whenever something sets `FORCE_COLOR` — which Nx itself does for every
/// task it runs. Matching the painted text reported every replay as a fresh
/// judgement, which is the one way this line can be worse than absent: an
/// operator reads it to know whether the verdict in front of them was rolled or
/// recalled.
#[test]
fn a_colourized_nx_report_is_still_read_as_a_replay() {
    let fixture = Fixture::new();

    let first = fixture.run_with(&[("FORCE_COLOR", "true")], &[]);
    let second = fixture.run_with(&[("FORCE_COLOR", "true")], &[]);

    assert!(first.status.success(), "{}", stderr(&first));
    assert!(second.status.success(), "{}", stderr(&second));
    assert!(
        reported(&second).contains('\u{1b}'),
        "the run was not colourized, so this journey proves nothing:\n{}",
        reported(&second)
    );
    assert_eq!(provenance(&first), Provenance::Judged);
    assert_eq!(
        provenance(&second),
        Provenance::Replayed,
        "a painted cache annotation was read as a fresh judgement"
    );
    assert_eq!(fixture.judge_calls().len(), 1);
}

/// An ambient global cache skip — exported to re-roll this tier and then
/// inherited by every unrelated command — is reported and ignored here, because
/// honouring it would put the judge back to one independent roll per run. Every
/// other Nx target still honours it.
#[test]
fn an_ambient_global_cache_skip_is_reported_and_ignored() {
    let fixture = Fixture::new();

    let recorded = fixture.run();
    let ambient = fixture.run_with(&[("NX_SKIP_NX_CACHE", "true")], &[]);
    let disabled = fixture.run_with(&[("NX_DISABLE_NX_CACHE", "true")], &[]);

    assert!(recorded.status.success(), "{}", stderr(&recorded));
    for (output, name) in [
        (&ambient, "NX_SKIP_NX_CACHE"),
        (&disabled, "NX_DISABLE_NX_CACHE"),
    ] {
        assert!(output.status.success(), "{}", stderr(output));
        assert_eq!(
            provenance(output),
            Provenance::Replayed,
            "{name} re-rolled the judge from an ambient setting"
        );
        assert!(
            stderr(output).contains("ignoring the ambient global Nx cache skip")
                && stderr(output).contains("--skip-nx-cache"),
            "{name} was ignored without saying so, or without naming the per-invocation lever:\n{}",
            stderr(output)
        );
    }
    assert_eq!(fixture.judge_calls().len(), 1);
}

/// A base is interpolated into `git rev-parse` as a revision, so a leading dash
/// would arrive there as an option rather than as a name. It is refused at the
/// boundary, before anything is resolved or judged.
#[test]
fn a_base_that_is_not_a_revision_is_refused_at_the_boundary() {
    let fixture = Fixture::new();

    for base in ["--all", "-x"] {
        let output = fixture.run_full(base, &[], &[]);

        assert_eq!(
            output.status.code(),
            Some(2),
            "'{base}' was not refused as a usage error:\n{}",
            stderr(&output)
        );
        assert!(
            stderr(&output).contains(base) && stderr(&output).contains("not a revision"),
            "the message should name what it refused and why:\n{}",
            stderr(&output)
        );
    }
    assert!(
        fixture.judge_calls().is_empty(),
        "something was judged against a base that is not a revision"
    );
}

/// A judge that cannot even report its version cannot be fingerprinted, so the
/// tier stops rather than keying on the tree and the base alone. This is the same
/// guard as an unresolvable config, on the other reading the fingerprint takes.
#[test]
fn a_judge_that_cannot_report_its_version_fails_the_tier() {
    let fixture = Fixture::new();

    let recorded = fixture.run();
    let broken = fixture.run_with(&[("STUB_VERSION_STATUS", "127")], &[]);

    assert!(recorded.status.success(), "{}", stderr(&recorded));
    assert_eq!(
        broken.status.code(),
        Some(2),
        "a judge with no reportable version did not stop the tier:\n{}",
        stderr(&broken)
    );
    assert!(
        stderr(&broken).contains("setup-llmlint"),
        "the failure does not say how to repair the toolchain:\n{}",
        stderr(&broken)
    );
    assert_eq!(
        fixture.judge_calls().len(),
        1,
        "the tier judged, or replayed, without a fingerprint of the judge configuration"
    );
}

// llmlint: ignore-block[tests_mirror_real_usage] these two journeys reach the
// target body through `run_judge_target`, which runs it exactly as
// `project.json` tells Nx to run it — the real usage these guards exist for is a
// target reached *without* `just lint-llm-diff` in front of it. Going through
// `just nx run onepipeline-ui:lint-llm-diff` was tried and measured unusable:
// the refusals fail in tens of milliseconds and Nx drops a task's stderr that
// fast one run in four under the whole suite's load, so these would assert on a
// message Nx had swallowed. The 17 journeys either side of them drive the
// recipe, which is where that entry point is covered.
/// The cached target keys on the base it is handed, so being handed a ref name —
/// or nothing — would let one recorded verdict be replayed for another commit.
/// Reached directly, it refuses and says which command resolves a base for it.
#[test]
fn the_cached_target_refuses_a_base_that_was_never_resolved() {
    let fixture = Fixture::new();

    for handed in [None, Some("origin/main"), Some("HEAD"), Some("not-a-sha")] {
        let environment: Vec<(&str, &str)> = handed
            .map(|value| vec![("LLMLINT_DIFF_BASE_SHA", value)])
            .unwrap_or_default();
        let output = fixture.run_judge_target(&environment);

        assert_eq!(
            output.status.code(),
            Some(2),
            "{handed:?} was accepted as a resolved commit id:\n{}",
            reported(&output)
        );
        assert!(
            reported(&output).contains("not a resolved commit id")
                && reported(&output).contains("just lint-llm-diff"),
            "the refusal should say what was wrong and name the command that \
             resolves a base:\n{}",
            reported(&output)
        );
    }
    assert!(
        fixture.judge_calls().is_empty(),
        "the judge was asked about a base nothing had resolved"
    );
}

/// A commit id this checkout does not have is well-formed and still unusable:
/// llmlint would diff against nothing. Refused with the one thing that fixes it.
#[test]
fn the_cached_target_refuses_a_commit_this_checkout_does_not_have() {
    let fixture = Fixture::new();
    let absent = "0".repeat(40);

    let output = fixture.run_judge_target(&[("LLMLINT_DIFF_BASE_SHA", &absent)]);

    assert_eq!(
        output.status.code(),
        Some(2),
        "a commit missing from the checkout was judged against:\n{}",
        reported(&output)
    );
    assert!(
        reported(&output).contains(&absent)
            && reported(&output).contains("missing from this checkout"),
        "the target did not refuse the commit itself — the wrapper behind it \
         reports a base it cannot diff against in its own words, which would let \
         this pass with the target's own guard gone:\n{}",
        reported(&output)
    );
    assert!(fixture.judge_calls().is_empty());
}
// llmlint: ignore-end[tests_mirror_real_usage]

/// An annotated tag is a name for a commit, and a tag object is not that commit.
/// The base is resolved through `^{commit}` so both names for one tree reach one
/// verdict, rather than the tag being judged all over again.
#[test]
fn a_tag_and_the_commit_it_names_share_one_verdict() {
    let fixture = Fixture::new();
    git(
        &fixture.workspace(),
        &[
            "tag",
            "-a",
            "v9.9.9",
            &fixture.base,
            "-m",
            "the base, under a name",
        ],
    );

    let by_commit = fixture.run();
    let by_tag = fixture.run_full("v9.9.9", &[], &[]);

    assert!(by_commit.status.success(), "{}", stderr(&by_commit));
    assert!(by_tag.status.success(), "{}", stderr(&by_tag));
    assert_eq!(provenance(&by_commit), Provenance::Judged);
    assert_eq!(
        provenance(&by_tag),
        Provenance::Replayed,
        "the tag was judged again, so it keyed on the tag object rather than on \
         the commit it names"
    );
    assert_eq!(fixture.judge_calls().len(), 1);
    assert!(
        stderr(&by_tag).contains(&fixture.base),
        "the verdict should be reported against the commit, not the tag:\n{}",
        stderr(&by_tag)
    );
}

/// `llmlint config` names the files it merged by absolute path, so the only
/// path-dependent thing in it is the checkout root. It is folded out, because two
/// checkouts of one repository — a worktree and the clone a publication cuts —
/// are judging the same configuration and must share the entry, not each roll
/// their own.
#[test]
fn two_checkouts_of_one_repository_fingerprint_the_same_judge_configuration() {
    let here = Fixture::new();
    let elsewhere = Fixture::new();

    let one = here.judge_fingerprint();
    let other = elsewhere.judge_fingerprint();

    assert_ne!(
        one, "",
        "the fingerprint is empty, so it distinguishes nothing"
    );
    assert_ne!(
        here.workspace(),
        elsewhere.workspace(),
        "both checkouts are at one path, so this journey proves nothing"
    );
    assert_eq!(
        one, other,
        "the checkout path reached the fingerprint, so every checkout of one \
         repository keys its own verdict"
    );
}

/// A base that does not resolve is a usage error, and nothing is judged against
/// it — the same contract the tier had before it was memoized.
#[test]
fn a_base_that_does_not_resolve_is_a_usage_error() {
    let fixture = Fixture::new();

    let output = fixture.run_full("no-such-ref", &[], &[]);

    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("no-such-ref"),
        "the message should name the base it could not resolve:\n{}",
        stderr(&output)
    );
    assert!(
        fixture.judge_calls().is_empty(),
        "the judge was asked about a base that does not resolve"
    );
}
