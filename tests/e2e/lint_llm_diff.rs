//! The LLM-judge tier's journey: `scripts/lint-llm-diff.sh`, driven the way
//! `just lint-llm-diff` drives it, over a real git repository.
//!
//! One thing is stood in for. `llmlint` on PATH is a recording stand-in rather than
//! the real command, because the real one bills a model call per shard and answers
//! differently each time — a journey that drove it could assert nothing about what
//! this script did. What the script decides is entirely deterministic, and the
//! stand-in is what makes it observable: it is the boundary the script talks across,
//!
//! Which files a shard judges, that the excludes it passes are exactly the rest of
//! the change, that
//! every changed file is judged exactly once, that no shard carries more diff
//! than the character budget a harness caps, that a failing shard does not stop
//! the ones after it, and which exit code the caller ends up with are all
//! asserted against the same script CI runs.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

/// The budget the sharding journeys run under. Small enough that a handful of
/// fixture files must span several shards, so the split is exercised rather
/// than assumed.
const TEST_BUDGET: usize = 2_500;

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

fn write(dir: &Path, path: &str, contents: &str) {
    let target = dir.join(path);
    fs::create_dir_all(target.parent().expect("a parent directory")).expect("create directory");
    fs::write(target, contents).expect("write file");
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod the stub");
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {
    // The shell reads the `#!` line to decide a file is a program it can run,
    // so there is no mode bit here to set.
}

/// One judge run the script asked for: which changed files it left in view, and
/// which it excluded.
struct Call {
    judged: Vec<String>,
    excluded: BTreeSet<String>,
    argv: String,
}

/// A repository whose branch commit changed `files`, with an `llmlint` on PATH
/// that appends each call's arguments to a log and exits with the next code it
/// was handed.
struct Fixture {
    dir: TempDir,
    base: String,
    files: Vec<String>,
}

impl Fixture {
    /// One changed file per entry in `sizes`, padded to that many bytes, so a
    /// shard's measured diff is a property of the fixture rather than of
    /// whatever the file happened to contain.
    fn new(sizes: &[usize]) -> Self {
        let named: Vec<(String, usize)> = sizes
            .iter()
            .enumerate()
            .map(|(index, size)| (format!("feature{index:02}/changed{index:02}.txt"), *size))
            .collect();
        Self::with_paths(&named)
    }

    fn with_paths(named: &[(String, usize)]) -> Self {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path();
        git(root, &["init", "--quiet"]);
        write(root, "README.md", "the base commit\n");
        git(root, &["add", "-A"]);
        git(root, &["commit", "--quiet", "-m", "base"]);
        // A commit sha rather than a branch name: what `--diff-base` resolves to
        // is the point, and a sha resolves the same however this git was
        // configured to name its first branch.
        let base = git(root, &["rev-parse", "HEAD"]).trim().to_owned();

        let mut files = Vec::new();
        for (path, size) in named {
            write(root, path, &format!("{}\n", "x".repeat(*size)));
            files.push(path.clone());
        }
        git(root, &["add", "-A"]);
        git(
            root,
            &["commit", "--quiet", "-m", "the change under judgement"],
        );
        files.sort();

        let stub_dir = root.join("stub-bin");
        fs::create_dir_all(&stub_dir).expect("create the stub directory");
        let stub = stub_dir.join("llmlint");
        fs::write(
            &stub,
            "#!/usr/bin/env bash\n\
             printf '%s\\n' \"$*\" >> \"$LLMLINT_CALLS\"\n\
             called=$(wc -l < \"$LLMLINT_CALLS\")\n\
             codes=($LLMLINT_EXITS)\n\
             exit \"${codes[$((called - 1))]:-0}\"\n",
        )
        .expect("write the stub");
        make_executable(&stub);

        Self { dir, base, files }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn calls_log(&self) -> PathBuf {
        self.root().join("llmlint-calls.log")
    }

    /// Run the script the way the justfile recipe does: `budget` characters per
    /// shard (the committed default when `None`), with `exits` handed to the
    /// stub one call at a time.
    fn run(&self, budget: Option<usize>, exits: &str, args: &[&str]) -> Output {
        self.run_against(&self.base, budget, exits, args)
    }

    fn run_against(&self, base: &str, budget: Option<usize>, exits: &str, args: &[&str]) -> Output {
        let mut path = vec![self.root().join("stub-bin")];
        path.extend(std::env::split_paths(
            &std::env::var_os("PATH").expect("PATH is set"),
        ));
        let mut command = Command::new("bash");
        command
            .arg(repo_root().join("scripts/lint-llm-diff.sh"))
            .arg(base)
            .args(args)
            .current_dir(self.root())
            .env("PATH", std::env::join_paths(path).expect("join PATH"))
            .env("LLMLINT_CALLS", self.calls_log())
            .env("LLMLINT_EXITS", exits);
        match budget {
            Some(budget) => command.env("LLMLINT_SHARD_BUDGET_CHARS", budget.to_string()),
            None => command.env_remove("LLMLINT_SHARD_BUDGET_CHARS"),
        };
        command.output().expect("bash is on PATH")
    }

    /// Each recorded call, split into the changed files it judged and the ones
    /// it excluded. A rule's own `files:` glob outranks a positional path, so
    /// what a call judges is the change minus what it excluded — the same thing
    /// llmlint resolves.
    fn calls(&self) -> Vec<Call> {
        let Ok(log) = fs::read_to_string(self.calls_log()) else {
            return Vec::new();
        };
        log.lines()
            .map(|argv| {
                let tokens: Vec<&str> = argv.split_whitespace().collect();
                let excluded: BTreeSet<String> = tokens
                    .windows(2)
                    .filter(|pair| pair[0] == "--exclude")
                    .map(|pair| pair[1].to_owned())
                    .collect();
                Call {
                    judged: self
                        .files
                        .iter()
                        .filter(|file| !excluded.contains(*file))
                        .cloned()
                        .collect(),
                    excluded,
                    argv: argv.to_owned(),
                }
            })
            .collect()
    }

    /// The characters of `git diff` a shard carries — the quantity the budget
    /// bounds, measured over the range the script measures it over.
    fn diff_chars(&self, shard: &[String]) -> usize {
        let range = format!("{}...HEAD", self.base);
        shard
            .iter()
            .map(|file| git(self.root(), &["diff", &range, "--", file]).len())
            .sum()
    }
}

/// The property that makes sharding a split rather than a quiet exclusion: the
/// shards partition the changed files, so a rule matching any file is judged in
/// at least one of them.
#[test]
fn every_changed_file_is_judged_in_exactly_one_shard() {
    let fixture = Fixture::new(&[900; 6]);

    let output = fixture.run(Some(TEST_BUDGET), "", &[]);

    assert!(output.status.success(), "{}", stderr(&output));
    let calls = fixture.calls();
    assert!(
        calls.len() > 1,
        "the budget should have forced a split: {} call(s)",
        calls.len()
    );
    let judged: Vec<&String> = calls.iter().flat_map(|call| &call.judged).collect();
    assert_eq!(
        judged,
        fixture.files.iter().collect::<Vec<_>>(),
        "the shards must carry every changed file exactly once, in path order"
    );
}

/// The excludes are what make a shard a shard, so they are asserted as passed
/// rather than as interpreted: a changed file is held back from every shard but
/// the one that judges it, and nothing else is ever denied — a broader pattern
/// would silence files no shard makes up for.
#[test]
fn every_changed_file_is_held_back_from_every_shard_but_its_own() {
    let fixture = Fixture::new(&[900; 6]);

    let output = fixture.run(Some(TEST_BUDGET), "", &[]);

    assert!(output.status.success(), "{}", stderr(&output));
    let calls = fixture.calls();
    assert!(calls.len() > 1, "the budget should have forced a split");
    let changed: BTreeSet<&String> = fixture.files.iter().collect();
    for call in &calls {
        let denied: BTreeSet<&String> = call.excluded.iter().collect();
        assert!(
            denied.is_subset(&changed),
            "a shard denied something outside the change: {}",
            call.argv
        );
    }
    for file in &fixture.files {
        let held_back = calls
            .iter()
            .filter(|call| call.excluded.contains(file))
            .count();
        assert_eq!(
            held_back,
            calls.len() - 1,
            "{file} should be held back from every shard but one of {}",
            calls.len()
        );
    }
}

#[test]
fn no_shard_carries_more_diff_than_the_budget_allows() {
    let fixture = Fixture::new(&[900; 6]);

    let output = fixture.run(Some(TEST_BUDGET), "", &[]);

    assert!(output.status.success(), "{}", stderr(&output));
    for call in fixture.calls() {
        let chars = fixture.diff_chars(&call.judged);
        assert!(
            chars <= TEST_BUDGET,
            "a shard of {chars} chars exceeds the {TEST_BUDGET} budget"
        );
    }
}

/// A file too large for any shard is still judged. Dropping it would be the one
/// outcome worse than the harness refusing the call, because a refusal is
/// reported as an error and a drop reads as a clean run.
#[test]
fn a_file_larger_than_the_budget_is_judged_alone_rather_than_dropped() {
    let fixture = Fixture::new(&[900, TEST_BUDGET * 2, 900]);

    let output = fixture.run(Some(TEST_BUDGET), "", &[]);

    assert!(output.status.success(), "{}", stderr(&output));
    let calls = fixture.calls();
    assert!(
        calls
            .iter()
            .any(|call| call.judged == [fixture.files[1].clone()]),
        "the oversized file should occupy a shard of its own: {:?}",
        calls.iter().map(|call| &call.judged).collect::<Vec<_>>()
    );
}

/// A change small enough for one call is the run this script replaced: a single
/// invocation with no excludes at all, and the caller's own arguments forwarded
/// untouched.
#[test]
fn a_small_change_runs_as_a_single_unmodified_call() {
    let fixture = Fixture::new(&[200, 200]);

    let output = fixture.run(None, "", &["--rule", "no_hardcoded_secrets"]);

    assert!(output.status.success(), "{}", stderr(&output));
    let calls = fs::read_to_string(fixture.calls_log()).expect("the stub was called");
    assert_eq!(
        calls.trim_end(),
        format!(
            "--diff --diff-base {} --rule no_hardcoded_secrets",
            fixture.base
        ),
    );
}

/// A path a glob cannot name exactly would exclude more than its own file, and
/// the difference would go unjudged while the run still reported success. The
/// script refuses instead — and only when it is about to shard, because the
/// single-call path passes no excludes.
#[test]
fn a_path_a_glob_cannot_name_exactly_is_refused_rather_than_over_excluded() {
    let named = vec![
        ("feature00/changed.txt".to_owned(), 900),
        ("feature01/chan[ge]d.txt".to_owned(), 900),
        ("feature02/changed.txt".to_owned(), 900),
    ];
    let fixture = Fixture::with_paths(&named);

    let sharded = fixture.run(Some(TEST_BUDGET), "", &[]);

    assert_eq!(sharded.status.code(), Some(2), "{}", stderr(&sharded));
    assert!(
        stderr(&sharded).contains("chan[ge]d.txt"),
        "the message should name the path it cannot exclude: {}",
        stderr(&sharded)
    );
    assert!(
        !fixture.calls_log().exists(),
        "nothing should be judged when the shards could not be honoured"
    );

    // The same change under a budget that needs no shard is judged as one call,
    // so the refusal is scoped to the excludes rather than to the path.
    let whole = fixture.run(None, "", &[]);

    assert!(whole.status.success(), "{}", stderr(&whole));
    let calls = fs::read_to_string(fixture.calls_log()).expect("the stub was called");
    assert_eq!(
        calls.trim_end(),
        format!("--diff --diff-base {}", fixture.base)
    );
}

/// Why every shard runs: stopping at the first failure would leave the rules in
/// the shards after it unjudged, while the non-zero exit made the run look like
/// it had reported everything there was to report.
#[test]
fn a_failing_shard_does_not_stop_the_shards_after_it() {
    let fixture = Fixture::new(&[900; 6]);

    let output = fixture.run(Some(TEST_BUDGET), "1 0 2", &[]);

    let calls = fixture.calls();
    assert!(
        calls.len() >= 3,
        "expected at least three shards, got {}",
        calls.len()
    );
    let judged: Vec<&String> = calls.iter().flat_map(|call| &call.judged).collect();
    assert_eq!(judged, fixture.files.iter().collect::<Vec<_>>());
    assert_eq!(
        output.status.code(),
        Some(2),
        "a judge that never reached a verdict (2) must outrank a violation (1): {}",
        stderr(&output)
    );
}

#[test]
fn a_violation_in_any_shard_fails_the_run() {
    let fixture = Fixture::new(&[900; 6]);

    let output = fixture.run(Some(TEST_BUDGET), "0 1 0", &[]);

    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
}

#[test]
fn a_base_this_repository_cannot_diff_against_is_a_usage_error() {
    let fixture = Fixture::new(&[200]);

    let output = fixture.run_against("no-such-ref", None, "", &[]);

    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("no-such-ref"),
        "{}",
        stderr(&output)
    );
    assert!(
        !fixture.calls_log().exists(),
        "nothing should be judged against a base that does not resolve"
    );
}

#[test]
fn a_budget_that_is_not_a_character_count_is_a_usage_error() {
    let fixture = Fixture::new(&[200]);

    let output = fixture.run(Some(0), "", &[]);

    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("LLMLINT_SHARD_BUDGET_CHARS"),
        "the message should name the setting to correct: {}",
        stderr(&output)
    );
}

/// Nothing to judge is not a reason to call the judge.
#[test]
fn an_unchanged_branch_judges_nothing_and_succeeds() {
    let fixture = Fixture::new(&[200]);
    let head = git(fixture.root(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();

    let output = fixture.run_against(&head, None, "", &[]);

    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        !fixture.calls_log().exists(),
        "no changed files means no judge call"
    );
}
