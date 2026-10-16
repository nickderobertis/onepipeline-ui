//! The server's own report of the libraries it links: the dependency record
//! `cargo auditable` embeds in the executable it builds, read back with the
//! `auditable-info` reader an auditor's tooling uses, beside the engine release
//! the same server answers over `/healthz`.
//!
//! The read API copies no plans itself, so what a host can prove about the plan
//! store behind it is which release that is. Both reports are read off one
//! binary, built from this tree under the lock, and held to the
//! `onepipeline`/`onetaskgraph-*` releases `Cargo.lock` resolves — exactly, so a
//! member of the plan-store family left behind, or a second copy of one at
//! another release, is a disagreement rather than a pass.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::http;
use crate::serving::Serving;

/// One linked crate, as `(name, version)`.
type Release = (String, String);

/// The engine and the plan-store family whose releases this journey holds.
fn in_family(name: &str) -> bool {
    name == "onepipeline" || name.starts_with("onetaskgraph-")
}

/// The family's releases as `Cargo.lock` resolves them.
fn locked_releases() -> BTreeSet<Release> {
    let lock: toml::Table =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock"))
            .expect("Cargo.lock")
            .parse()
            .expect("Cargo.lock parses");
    lock["package"]
        .as_array()
        .expect("the lock lists packages")
        .iter()
        .filter_map(|package| {
            let name = package["name"].as_str()?;
            in_family(name).then(|| {
                (
                    name.to_owned(),
                    package["version"].as_str().expect("a version").to_owned(),
                )
            })
        })
        .collect()
}

/// Build `onepipeline-api` from this tree with `cargo auditable`, under the
/// lock, and answer the binary.
///
/// Its own target directory under this clone's `target`, so the suite's build
/// is not rebuilt with another wrapper and a later run reuses this one's
/// dependencies. Whatever the suite's own compile was told — coverage
/// instrumentation above all — is not what a release compiles with, so it is
/// cleared here.
fn an_auditable_build() -> PathBuf {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/auditable");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let mut build = std::process::Command::new(cargo);
    build.current_dir(env!("CARGO_MANIFEST_DIR"));
    for variable in [
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_BUILD_RUSTFLAGS",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "LLVM_PROFILE_FILE",
    ] {
        build.env_remove(variable);
    }
    build
        .args([
            "auditable",
            "build",
            "--offline",
            "--locked",
            "--bin",
            "onepipeline-api",
            "--target-dir",
        ])
        .arg(&target);
    let output = build
        .output()
        .unwrap_or_else(|err| panic!("cargo auditable build could not start: {err}"));
    assert!(
        output.status.success(),
        "cargo auditable build failed — `just bootstrap` provisions cargo-auditable:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    target
        .join("debug")
        .join(format!("onepipeline-api{}", std::env::consts::EXE_SUFFIX))
}

/// The family's releases as the binary's embedded dependency record names them.
fn reported_releases(binary: &Path) -> BTreeSet<Release> {
    let report = auditable_info::audit_info_from_file(binary, auditable_info::Limits::default())
        .unwrap_or_else(|err| {
            panic!(
                "{} carries no readable dependency record: {err}",
                binary.display()
            )
        });
    report
        .packages
        .iter()
        .filter(|package| in_family(&package.name))
        .map(|package| (package.name.clone(), package.version.to_string()))
        .collect()
}

/// What a report says that an expectation does not, and the reverse — empty
/// when the two name the same releases.
fn disagreement(reported: &BTreeSet<Release>, expected: &BTreeSet<Release>) -> Vec<String> {
    let unexpected = reported
        .difference(expected)
        .map(|(name, version)| format!("links {name} {version}, which was not expected"));
    let missing = expected
        .difference(reported)
        .map(|(name, version)| format!("does not link {name} {version}"));
    unexpected.chain(missing).collect()
}

/// The release the server answers over `/healthz`.
fn served_engine(binary: &Path) -> Value {
    let serving = Serving::start_binary_with_args(binary, |_| {}, &[]);
    let response = http::get(serving.address, "/healthz");
    assert_eq!(response.status, 200);
    response.json()["onepipeline_version"].clone()
}

/// A server built under the lock reports linking exactly the engine and
/// plan-store releases the lock resolves, and answers that engine release over
/// `/healthz` — the release the checked-in golden pins.
#[test]
fn a_built_server_reports_linking_the_engine_and_plan_store_the_lock_resolves() {
    let expected = locked_releases();
    let engine = expected
        .iter()
        .find(|(name, _)| name == "onepipeline")
        .expect("the lock resolves onepipeline")
        .1
        .clone();
    assert!(
        expected
            .iter()
            .any(|(name, _)| name.starts_with("onetaskgraph-")),
        "the lock resolves no onetaskgraph crate"
    );

    let binary = an_auditable_build();
    let reported = reported_releases(&binary);
    let disagrees = disagreement(&reported, &expected);
    assert!(
        disagrees.is_empty(),
        "the built server's dependency record disagrees with Cargo.lock: it {}",
        disagrees.join("; ")
    );

    let golden: Value = serde_json::from_str(include_str!("../fixtures/healthz.json"))
        .expect("tests/fixtures/healthz.json parses");
    let served = served_engine(&binary);
    assert_eq!(served, Value::String(engine));
    assert_eq!(served, golden["onepipeline_version"]);
}

/// The same reading refuses an expectation one release off: a lock that named
/// another engine or plan-store release than the one the server links is a
/// disagreement naming both, not a pass.
#[test]
fn a_built_server_disagrees_with_an_expectation_one_release_off() {
    let binary = an_auditable_build();
    let reported = reported_releases(&binary);
    for name in ["onepipeline", "onetaskgraph-core"] {
        let mut expected = locked_releases();
        let linked = expected
            .iter()
            .find(|(candidate, _)| candidate == name)
            .unwrap_or_else(|| panic!("the lock resolves {name}"))
            .clone();
        let mut bumped: Vec<u64> = linked
            .1
            .split('.')
            .map(|part| part.parse().expect("a numeric release"))
            .collect();
        *bumped.last_mut().expect("a patch number") += 1;
        let bumped = bumped
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(".");
        expected.remove(&linked);
        expected.insert((name.to_owned(), bumped.clone()));

        assert_eq!(
            disagreement(&reported, &expected),
            vec![
                format!("links {name} {}, which was not expected", linked.1),
                format!("does not link {name} {bumped}"),
            ]
        );
    }
}
