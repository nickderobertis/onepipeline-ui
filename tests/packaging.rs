//! The distribution contract: one binary name and one version source across
//! crates.io, PyPI, and npm.
//!
//! Three manifests describe the same artifact, and only one of them — the npm
//! launcher — is driven end to end by `tests/e2e/packaging.rs`. The wheel is
//! built by maturin inside the release workflow, where a name or binding that
//! had drifted would surface as a public, half-published release. These
//! assertions are what make that drift fail here instead.
//!
//! The two `npm_build` tests below assemble a package without running it: what
//! a released package must *contain*. Running the launcher a user installed is
//! `tests/e2e/packaging.rs`.

use std::fs;
use std::path::{Path, PathBuf};

fn read(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

/// The console command every distribution installs.
const COMMAND: &str = "onepipeline-ui";

/// The distribution name the PyPI and npm wrappers publish under.
const WRAPPER: &str = "onepipeline-api-cli";

#[test]
fn the_crate_ships_the_binary_the_wrappers_wrap() {
    let cargo = read("Cargo.toml");
    assert!(
        cargo.contains(&format!("name = \"{COMMAND}\"")),
        "the crate is not named {COMMAND}"
    );
    assert!(
        cargo.contains("[[bin]]"),
        "the crate builds no binary for the wrappers to carry"
    );
}

#[test]
fn the_wheel_wraps_the_binary_and_takes_its_version_from_cargo() {
    let pyproject = read("pyproject.toml");
    assert!(pyproject.contains(&format!("name = \"{WRAPPER}\"")));
    // maturin's `bin` bindings are what make the wheel carry the prebuilt
    // binary rather than a Python extension module.
    assert!(pyproject.contains("bindings = \"bin\""));
    assert!(pyproject.contains("manifest-path = \"Cargo.toml\""));
    // release-plz is the single version driver: a literal version here would be
    // a second source to drift.
    assert!(pyproject.contains("dynamic = [\"version\"]"));
    assert!(
        !pyproject.contains("\nversion = "),
        "pyproject.toml pins a version; maturin must source it from Cargo.toml"
    );
}

#[test]
fn the_npm_launcher_wraps_the_binary_and_carries_no_version_of_its_own() {
    let manifest: serde_json::Value =
        serde_json::from_str(&read("npm/onepipeline-api-cli/package.json")).expect("parse manifest");
    assert_eq!(manifest["name"], WRAPPER);
    assert_eq!(manifest["bin"][COMMAND], format!("bin/{COMMAND}.js"));
    // The committed manifest carries a placeholder; scripts/npm-build.mjs stamps
    // the crate version in at publish time (proven by tests/e2e/packaging.rs).
    assert_eq!(manifest["version"], "0.0.0-managed");
}

#[test]
fn every_release_target_has_a_platform_package_on_both_sides() {
    let workflow = read(".github/workflows/release.yml");
    let build = read("scripts/npm-build.mjs");
    let launcher = read("npm/onepipeline-api-cli/bin/onepipeline-ui.js");
    let manifest = read("npm/onepipeline-api-cli/package.json");
    for (target, package) in [
        ("x86_64-unknown-linux-gnu", "onepipeline-api-cli-linux-x64"),
        (
            "aarch64-unknown-linux-gnu",
            "onepipeline-api-cli-linux-arm64",
        ),
        ("x86_64-apple-darwin", "onepipeline-api-cli-darwin-x64"),
        ("aarch64-apple-darwin", "onepipeline-api-cli-darwin-arm64"),
        ("x86_64-pc-windows-msvc", "onepipeline-api-cli-win32-x64"),
    ] {
        assert!(workflow.contains(target), "release.yml builds no {target}");
        assert!(build.contains(target), "npm-build.mjs maps no {target}");
        assert!(
            launcher.contains(package),
            "the launcher resolves no {package}"
        );
        assert!(
            manifest.contains(package),
            "the launcher declares no {package}"
        );
    }
}

#[test]
fn every_secret_the_workflows_read_is_in_the_manifest() {
    let manifest: serde_json::Value =
        serde_json::from_str(&read("gh-secrets.json")).expect("parse gh-secrets.json");
    let declared: Vec<&str> = manifest["secrets"]
        .as_array()
        .expect("secrets is an array")
        .iter()
        .map(|entry| entry["name"].as_str().expect("secret name"))
        .collect();
    for secret in [
        "RELEASE_PLZ_TOKEN",
        "CARGO_REGISTRY_TOKEN",
        "PYPI_TOKEN",
        "NPM_TOKEN",
        "OPENAI_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ] {
        assert!(
            declared.contains(&secret),
            "gh-secrets.json does not name {secret}"
        );
    }
    assert_eq!(
        manifest["destinations"][0]["repository"], "nickderobertis/onepipeline-ui",
        "the manifest syncs to another repository"
    );
}

fn npm_build(args: &[&str]) -> std::process::Output {
    std::process::Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/npm-build.mjs"))
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("node is on PATH")
}

#[test]
fn the_assembled_launcher_pins_every_platform_package_to_the_crate_version() {
    let out = tempfile::tempdir().expect("temp dir");
    let built = npm_build(&[
        "launcher",
        "--out",
        out.path().to_str().expect("utf-8 path"),
    ]);
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let dir = PathBuf::from(String::from_utf8(built.stdout).expect("utf-8 path").trim());

    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package.json")).expect("read manifest"))
            .expect("parse manifest");
    let version = env!("CARGO_PKG_VERSION");
    assert_eq!(
        manifest["version"], version,
        "the launcher carries a version of its own"
    );
    // Pinned exactly, so an install can never pair a launcher with a stale
    // binary — the failure npm's own semver resolution would otherwise allow.
    let optional = manifest["optionalDependencies"]
        .as_object()
        .expect("optionalDependencies");
    assert!(!optional.is_empty());
    for (name, pinned) in optional {
        assert_eq!(pinned, version, "{name} is not pinned to this version");
    }
}

#[test]
fn npm_build_refuses_a_target_it_has_no_platform_package_for() {
    let out = npm_build(&[
        "platform",
        "--target",
        "riscv64gc-unknown-linux-gnu",
        "--binary",
        "/dev/null",
    ]);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("unknown target"), "{stderr}");
    assert!(stderr.contains("ACTION:"), "{stderr}");
}
