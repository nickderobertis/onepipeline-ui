//! `scripts/release-probe.sh`, driven the way a consumer waiting on a release
//! drives it: as a direct subprocess, from this repository's root, with an
//! environment carrying nothing but a search path and a home.
//!
//! What these journeys hold is the one distinction the release-target contract
//! calls the most damaging thing to get wrong: **not answered is never no
//! release yet**. A consumer holds indefinitely on the first and launches on the
//! second, so a probe that reported an unreachable registry as an empty answer
//! would let dependent work start against a release that never happened — which
//! is the failure this whole mechanism exists to prevent. Every way the probe
//! can fail to establish an answer is driven here, and each one has to exit
//! non-zero with an empty stdout.
//!
//! The two answers that need a live public registry — the version one serves,
//! and the emptiness of one that has never released a name — are not here. The
//! deterministic gate is offline (AGENTS.md), so they are proven where this
//! repository already verifies against real registries: the `probe` job in
//! `.github/workflows/published-smoke.yml`, which drives this same script.
//!
//! One thing is stood in for, at three sites collected into [`Registry`]:
//! `curl` on PATH. A public registry cannot be made unreachable, made to answer
//! 503, or made to serve something that is not JSON, and those are exactly the
//! states the distinction above turns on. The script under test is the real
//! script, spawned the way the contract says a consumer spawns it.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

use crate::stub_bin;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn probe() -> PathBuf {
    repo_root().join("scripts/release-probe.sh")
}

/// One of the three answers the contract allows, as a caller reads it off the
/// process: an exit code and a stream.
#[derive(Debug)]
enum Answer {
    /// Exit 0 with a version: that is what the registry serves.
    Serves(String),
    /// Exit 0 with nothing: the registry has no release of it yet.
    NoReleaseYet,
    /// Any non-zero exit: not answered, and never to be read as the one above.
    NotAnswered { code: Option<i32>, reason: String },
}

/// Read a finished run as one of the three answers.
///
/// The invariant every caller depends on is checked once, here: a run that did
/// not answer must leave stdout empty, because a caller that trusted a version
/// printed beside a failure would be reading a release out of a failure.
fn answer(output: &Output) -> Answer {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        let served = stdout.trim_end_matches(['\n', '\r']).to_owned();
        if served.is_empty() {
            Answer::NoReleaseYet
        } else {
            Answer::Serves(served)
        }
    } else {
        assert!(
            stdout.trim().is_empty(),
            "the probe failed and still wrote `{stdout}` to stdout, where a caller \
             reads the version a registry serves"
        );
        Answer::NotAnswered {
            code: output.status.code(),
            reason: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }
}

/// Assert a run was not answered, and that it said why in terms naming `about`.
///
/// "Not answered" is only actionable if the reason reaches the operator, so the
/// exit code and the explanation are held together rather than separately.
fn refused(output: &Output, about: &str) {
    match answer(output) {
        Answer::NotAnswered { code, reason } => {
            assert_ne!(code, Some(0), "a refusal that exited 0 reads as an answer");
            assert!(
                reason.contains(about),
                "the refusal does not say anything about `{about}`:\n{reason}"
            );
            assert!(
                reason.contains("ACTION:"),
                "the refusal names nothing to do next:\n{reason}"
            );
        }
        answered => panic!(
            "the probe answered `{answered:?}`, so a caller would act on it; this \
             call could not have established either answer"
        ),
    }
}

/// A run of the real probe, with the environment the contract promises it and
/// nothing else.
struct Probe {
    /// Kept alive for as long as a stand-in it holds is on the search path, and
    /// absent for a run that stands in for nothing.
    _dir: Option<TempDir>,
    search_path: OsString,
}

impl Probe {
    /// The environment a consumer spawns it in: this process's own search path,
    /// no stand-in ahead of anything.
    fn plain() -> Self {
        Self {
            _dir: None,
            search_path: std::env::var_os("PATH").expect("PATH is set"),
        }
    }

    /// The same, with a `curl` ahead of the real one that behaves as `script`
    /// says.
    ///
    /// llmlint: ignore-block[e2e_not_mocked] a live public registry cannot be
    /// made unreachable, made to answer 503, or made to serve something that is
    /// not JSON — and those three states are precisely what the "not answered is
    /// never no release yet" distinction turns on, so a journey that could not
    /// reach them would leave the contract's most damaging failure untested.
    /// Standing in for the program on PATH is the narrowest cut available: the
    /// script under test is the real script, spawned the way the contract says a
    /// consumer spawns it, and the two answers a real registry *can* produce are
    /// driven against real registries by the `probe` job in
    /// `.github/workflows/published-smoke.yml`. This constructor is the whole of
    /// the substitution.
    fn with_curl(script: &str) -> Self {
        let dir = TempDir::new().expect("temp dir");
        let search_path = stub_bin::install(&dir.path().join("stub-bin"), "curl", script);
        Self {
            _dir: Some(dir),
            search_path,
        }
    }
    // llmlint: ignore-end[e2e_not_mocked]

    fn run(&self, arguments: &[&str]) -> Output {
        let mut command = spawn();
        command
            .args(arguments)
            // The working directory the contract names: this repository's root.
            .current_dir(repo_root());
        // Exactly what the contract allows the probe to assume, and nothing the
        // caller happened to be holding — no credential, no registry token, no
        // proxy setting. Driving it this way is what proves it needs none.
        // Windows is left with its own environment: the shebang cannot start the
        // script there, so `bash` is interposed, and stripping a Windows shell to
        // two variables would be testing that shell rather than this script.
        #[cfg(unix)]
        command
            .env_clear()
            .env("PATH", &self.search_path)
            .env("HOME", std::env::var_os("HOME").expect("HOME is set"));
        #[cfg(not(unix))]
        command.env("PATH", &self.search_path);
        command.output().expect("spawn the probe")
    }
}

/// Spawn the script the way the contract says a consumer does: directly, with no
/// shell interposed, which is also what holds it to being executable and to
/// carrying a usable `#!` line.
///
/// Windows has neither an execute bit nor `#!` handling, so there the launcher
/// is `bash` — the same way every other script journey in this suite reaches one.
#[cfg(unix)]
fn spawn() -> Command {
    Command::new(probe())
}

#[cfg(not(unix))]
fn spawn() -> Command {
    let mut command = Command::new("bash");
    command.arg(probe());
    command
}

#[test]
fn an_identifier_naming_no_registry_is_not_answered() {
    // The whole point of qualifying an identifier: one bare name can be a
    // project on one registry and a different package on another, so a consumer
    // handed one cannot say which release it got.
    refused(
        &Probe::plain().run(&["onepipeline-ui"]),
        "names no registry",
    );
}

#[test]
fn a_registry_the_probe_does_not_read_is_not_answered() {
    // Not empty output: an identifier the probe does not recognise has to be
    // "not answered", or a consumer would read "this probe has never heard of
    // your registry" as "your release has not happened".
    refused(
        &Probe::plain().run(&["docker:onepipeline-ui"]),
        "is not a registry this probe reads",
    );
}

#[test]
fn a_name_no_registry_could_serve_is_not_answered() {
    let probe = Probe::plain();
    for (identifier, about) in [
        ("npm:Not A Package", "is not an npm package name"),
        ("crate:onepipeline ui", "is not a crate name"),
        ("pypi:", "names no artifact"),
        // A name that would climb out of the URL path rather than be looked up
        // in it.
        ("crate:../../etc/passwd", "is not a crate name"),
    ] {
        refused(&probe.run(&[identifier]), about);
    }
}

#[test]
fn a_call_that_does_not_name_exactly_one_target_is_not_answered() {
    let probe = Probe::plain();
    refused(&probe.run(&[]), "exactly one argument");
    refused(
        &probe.run(&["crate:onepipeline-ui", "npm:onepipeline-ui"]),
        "exactly one argument",
    );
}

#[test]
fn a_registry_it_cannot_reach_is_not_answered_rather_than_reported_as_unreleased() {
    // curl's own exit for "could not connect", which is what a consumer's host
    // produces on a network it cannot leave. The release it is waiting for may
    // well exist, so answering "no release yet" here would launch dependent work
    // against a version nothing published.
    let probe =
        Probe::with_curl("#!/usr/bin/env bash\necho 'curl: (7) Failed to connect' >&2\nexit 7\n");
    for identifier in [
        "crate:onepipeline-ui",
        "pypi:onepipeline-api-cli",
        "npm:onepipeline-ui",
    ] {
        refused(&probe.run(&[identifier]), "could not reach the registry");
    }
}

#[test]
fn a_registry_that_answers_with_an_error_is_not_answered() {
    // A reachable registry having a bad day. Only 404 and 410 mean "nothing is
    // served under this name"; every other status is a reading that did not
    // happen.
    let probe = Probe::with_curl(&stub_curl("503", ""));
    refused(
        &probe.run(&["npm:onepipeline-api-cli"]),
        "answered HTTP 503",
    );
}

#[test]
fn an_answer_the_probe_cannot_read_is_not_answered() {
    // A 200 carrying something that is not the document this reads — a captive
    // portal, a proxy's error page, a registry that changed its shape.
    let probe = Probe::with_curl(&stub_curl("200", "<html>we are upgrading</html>"));
    refused(
        &probe.run(&["pypi:onepipeline-api-cli"]),
        "could not read a version",
    );
}

#[test]
fn each_registry_is_read_for_the_version_that_registry_itself_serves() {
    // Three registries answer in three shapes, and the field that *is* "what
    // this registry currently serves" is different in each. Reading the wrong
    // one would report a version no installer would resolve to, which a consumer
    // cannot tell from a correct answer — so each shape is driven here, where the
    // expected version is known. That a live registry really answers in these
    // shapes is what the `probe` job in published-smoke.yml holds.
    for (identifier, document, serves) in [
        // crates.io names the newest stable release, and the newest of any kind
        // for a crate that has never cut a stable one.
        (
            "crate:onepipeline-ui",
            "{\"crate\":{\"max_stable_version\":\"0.6.3\",\"newest_version\":\"0.7.0-rc.1\"}}",
            "0.6.3",
        ),
        (
            "crate:onepipeline-ui",
            "{\"crate\":{\"max_stable_version\":null,\"newest_version\":\"0.7.0-rc.1\"}}",
            "0.7.0-rc.1",
        ),
        (
            "pypi:onepipeline-api-cli",
            "{\"info\":{\"name\":\"onepipeline-api-cli\",\"version\":\"0.6.3\"}}",
            "0.6.3",
        ),
        // npm answers `/latest` with the manifest the `latest` dist-tag points
        // at, which is the release an install resolves to.
        (
            "npm:onepipeline-api-cli",
            "{\"name\":\"onepipeline-api-cli\",\"version\":\"0.6.3\"}",
            "0.6.3",
        ),
    ] {
        let probe = Probe::with_curl(&stub_curl("200", document));
        match answer(&probe.run(&[identifier])) {
            Answer::Serves(version) => assert_eq!(
                version, serves,
                "{identifier} was reported as a version its registry does not serve"
            ),
            other => panic!("{identifier} was answered `{other:?}` rather than `{serves}`"),
        }
    }
}

#[test]
fn a_document_that_names_no_version_is_read_as_no_release_yet() {
    // The other side of the line above: a well-formed document that simply names
    // no version is the registry saying it serves nothing, which is an answer.
    let probe = Probe::with_curl(&stub_curl("200", "{\"crate\":{}}"));
    assert!(
        matches!(
            answer(&probe.run(&["crate:onepipeline-ui"])),
            Answer::NoReleaseYet
        ),
        "a registry document naming no version was not read as `no release yet`"
    );
}

/// A host missing one of the two programs the probe needs cannot establish
/// anything, and must say so rather than answer.
#[cfg(unix)]
#[test]
fn a_host_without_the_tools_it_needs_is_not_answered() {
    let dir = TempDir::new().expect("temp dir");
    let only_bash = dir.path().join("only-bash");
    fs::create_dir_all(&only_bash).expect("create the search path");
    // The `#!` line resolves `bash` through PATH, so the one program this leaves
    // reachable is the interpreter itself: no curl, no node.
    let bash = String::from_utf8(
        Command::new("bash")
            .args(["-c", "command -v bash"])
            .output()
            .expect("bash is on PATH")
            .stdout,
    )
    .expect("utf-8 path");
    std::os::unix::fs::symlink(bash.trim(), only_bash.join("bash")).expect("link bash");

    let output = Command::new(probe())
        .arg("npm:onepipeline-ui")
        .current_dir(repo_root())
        .env_clear()
        .env("PATH", &only_bash)
        .env("HOME", std::env::var_os("HOME").expect("HOME is set"))
        .output()
        .expect("spawn the probe");
    refused(&output, "is not on PATH");
}

/// A stand-in `curl` that writes `body` where the real one was told to put the
/// document, and reports `status` where it was told to write the code.
fn stub_curl(status: &str, body: &str) -> String {
    format!(
        "#!/usr/bin/env bash\n\
         set -eu\n\
         document=\"\"\n\
         while [ \"$#\" -gt 0 ]; do\n\
           case \"$1\" in\n\
             --output) document=\"$2\"; shift 2 ;;\n\
             *) shift ;;\n\
           esac\n\
         done\n\
         printf '%s' '{body}' > \"$document\"\n\
         printf '%s' '{status}'\n"
    )
}
