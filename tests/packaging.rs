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

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn read(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

/// The console command every distribution installs.
const COMMAND: &str = "onepipeline-api";

/// The distribution name the PyPI and npm wrappers publish under.
const WRAPPER: &str = "onepipeline-api-cli";

/// The crate name, on crates.io and in `cargo install`.
const CRATE: &str = "onepipeline-ui";

/// The npm distribution that carries the frontend rather than a binary.
const FRONTEND: &str = "onepipeline-ui";

/// The `name = "..."` a Cargo manifest sets inside `header`, e.g. `[[bin]]`.
///
/// Reading the section rather than the whole file is the point: the manifest
/// declares two different names, and a substring search would let either one
/// satisfy an assertion about the other.
fn manifest_name(cargo: &str, header: &str) -> String {
    let mut inside = false;
    for line in cargo.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == header;
        } else if inside {
            if let Some(value) = line.strip_prefix("name = ") {
                return value.trim_matches('"').to_owned();
            }
        }
    }
    panic!("Cargo.toml declares no name under {header}");
}

#[test]
fn the_crate_ships_the_binary_the_wrappers_wrap() {
    let cargo = read("Cargo.toml");
    assert_eq!(
        manifest_name(&cargo, "[package]"),
        CRATE,
        "the crate is not named {CRATE}, so `cargo install {CRATE}` installs nothing"
    );
    assert_eq!(
        manifest_name(&cargo, "[[bin]]"),
        COMMAND,
        "the binary the wrappers carry is not the command they claim to install"
    );
}

/// The command must not collide with the frontend package, which ships assets
/// and no binary. Naming both `onepipeline-ui` is what this rename undid: an
/// install of one would hand you the name the other's users type.
#[test]
fn the_command_does_not_collide_with_the_frontend_package() {
    assert_ne!(
        COMMAND, FRONTEND,
        "the command shares a name with a package that installs no command"
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
        serde_json::from_str(&read("npm/onepipeline-api-cli/package.json"))
            .expect("parse manifest");
    assert_eq!(manifest["name"], WRAPPER);
    assert_eq!(manifest["bin"][COMMAND], format!("bin/{COMMAND}.js"));
    // `files` is what npm actually uploads: a shim the `bin` key points at but
    // `files` omits publishes a package whose command cannot start.
    assert_eq!(
        manifest["files"],
        serde_json::json!([format!("bin/{COMMAND}.js")])
    );
    // The committed manifest carries a placeholder; scripts/npm-build.mjs stamps
    // the crate version in at publish time (proven by tests/e2e/packaging.rs).
    assert_eq!(manifest["version"], "0.0.0-managed");
}

#[test]
fn the_frontend_package_carries_the_bundle_and_no_binary() {
    let manifest: serde_json::Value =
        serde_json::from_str(&read("npm/onepipeline-ui/package.json")).expect("parse manifest");
    assert_eq!(manifest["name"], FRONTEND);
    // Two deliverables, split by what they contain: this one is the built view,
    // so a `bin` or a platform dependency here would make it a second wrapper.
    assert!(
        manifest.get("bin").is_none(),
        "the frontend package declares a binary"
    );
    assert!(
        manifest.get("optionalDependencies").is_none(),
        "the frontend package pins per-platform binaries"
    );
    assert_eq!(manifest["files"], serde_json::json!(["dist"]));
    // The same placeholder discipline as the launcher: release-plz is the one
    // version driver, so a real number here would be a second source to drift.
    assert_eq!(manifest["version"], "0.0.0-managed");
}

#[test]
fn the_frontend_package_refuses_to_ship_without_a_built_bundle() {
    let out = tempfile::tempdir().expect("temp dir");
    let path = out.path().to_str().expect("utf-8 path");
    // Pointed at a directory nothing has built into, `ui` must say so rather than
    // publish a package whose `dist/` is empty.
    let built = npm_build(&["ui", "--out", path, "--bundle", path]);
    assert!(!built.status.success());
    let stderr = String::from_utf8_lossy(&built.stderr);
    assert!(stderr.contains("no built frontend"), "{stderr}");
    assert!(stderr.contains("ACTION:"), "{stderr}");
}

/// Every `prefix<name>` in `source`, taking `name` for as long as `keep` holds.
///
/// Enough of a parser for the three declarations below and no more: each is a
/// list of identifiers a compiler already checks the spelling of, so what is
/// left to check is that the three lists say the same thing.
fn names_after(source: &str, prefix: &str, keep: fn(char) -> bool) -> BTreeSet<String> {
    source
        .match_indices(prefix)
        .map(|(at, _)| {
            source[at + prefix.len()..]
                .chars()
                .take_while(|character| keep(*character))
                .collect()
        })
        .collect()
}

/// `src/server.rs` is the one source for which stops this process honours, and
/// the two `tokio::signal` kinds it names are read out of it here.
///
/// Adding one there is the whole of the change; this fails until the launcher
/// and the journeys follow, which is the point.
fn stop_signals_the_server_installs() -> BTreeSet<String> {
    // tokio spells a signal by its disposition, POSIX by its number's name.
    let posix = |kind: &str| match kind {
        "terminate" => "SIGTERM",
        "interrupt" => "SIGINT",
        "hangup" => "SIGHUP",
        "quit" => "SIGQUIT",
        other => panic!(
            "src/server.rs installs SignalKind::{other}(), which this gate cannot name — \
             add it here, to the launcher's STOP_SIGNALS, and to tests/support/serving.rs's Stop"
        ),
    };
    let kinds = names_after(&read("src/server.rs"), "SignalKind::", |character| {
        character.is_ascii_alphanumeric() || character == '_'
    });
    assert!(
        !kinds.is_empty(),
        "src/server.rs installs no signal handler at all, so nothing can stop the server cleanly"
    );
    kinds.iter().map(|kind| posix(kind).to_owned()).collect()
}

/// The launcher forwards exactly the stops the server handles — no fewer, and
/// no more.
///
/// The npm distribution puts a node process in front of the binary, and a
/// supervisor signals *that*. So the two agree about this set or the command
/// cannot be stopped cleanly, and they are written in different languages with
/// no compiler between them — which is how v0.3.1 shipped forwarding none of
/// them and exiting 143. Neither too few (the stop never reaches the server) nor
/// too many: listening for a signal replaces node's default disposition, so
/// forwarding one the binary does not handle leaves the launcher outliving it.
///
/// `tests/support/serving.rs` is held to the same set, so the journeys in
/// `tests/e2e/` cannot cover only some of what the server promises.
#[test]
fn the_launcher_and_the_journeys_carry_exactly_the_stops_the_server_handles() {
    let installed = stop_signals_the_server_installs();

    let launcher = read(&format!("npm/{WRAPPER}/bin/{COMMAND}.js"));
    let (_, declared) = launcher
        .split_once("const STOP_SIGNALS = [")
        .expect("the launcher declares no STOP_SIGNALS");
    let (declared, _) = declared.split_once(']').expect("STOP_SIGNALS is unclosed");
    let forwarded: BTreeSet<String> = declared
        .split(',')
        .map(|name| name.trim().trim_matches('"').to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    assert_eq!(
        forwarded, installed,
        "the npm launcher forwards a different set of stops than src/server.rs handles"
    );

    let signalled = names_after(
        &read("tests/support/serving.rs"),
        "libc::SIG",
        char::is_alphanumeric,
    )
    .iter()
    .map(|name| format!("SIG{name}"))
    .collect::<BTreeSet<String>>();
    assert_eq!(
        signalled, installed,
        "the e2e harness sends a different set of stops than src/server.rs handles"
    );
}

#[test]
fn every_release_target_has_a_platform_package_on_both_sides() {
    let workflow = read(".github/workflows/release.yml");
    let build = read("scripts/npm-build.mjs");
    let launcher = read(&format!("npm/{WRAPPER}/bin/{COMMAND}.js"));
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

/// The requirement string a dependency is declared at under `[dependencies]`.
///
/// Section-scoped for the same reason [`manifest_name`] is: `onepipeline` is
/// named in the dev-dependencies' prose and in `[package]`'s, and a substring
/// search would read either as the requirement the resolver uses.
fn dependency_requirement(cargo: &str, name: &str) -> String {
    let mut inside = false;
    for line in cargo.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == "[dependencies]";
        } else if inside {
            if let Some(value) = line.strip_prefix(&format!("{name} = ")) {
                return value.trim_matches('"').to_owned();
            }
        }
    }
    panic!("Cargo.toml declares no dependency on {name}");
}

/// The tools the workflow's `taiki-e/install-action` step provisions, read out of
/// its `tool:` block.
///
/// The block rather than the file: every name here is also written in the prose
/// around it, and a comment must not be able to satisfy an assertion about what
/// the release run can execute.
fn provisioned_tools(workflow: &str) -> Vec<String> {
    let mut lines = workflow.lines().skip_while(|line| line.trim() != "tool: |");
    let header = lines
        .next()
        .expect("release-plz.yml has no `tool: |` install block");
    let indent = header.len() - header.trim_start().len();
    lines
        .take_while(|line| line.trim().is_empty() || line.len() - line.trim_start().len() > indent)
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect()
}

/// A `${{ env.NAME }}` reference resolved against the workflow's own `env:`, so
/// the pin is read where it is written rather than assumed to be one.
fn workflow_env(workflow: &str, reference: &str) -> String {
    let Some(name) = reference
        .strip_prefix("${{ env.")
        .and_then(|rest| rest.strip_suffix(" }}"))
    else {
        return reference.to_owned();
    };
    workflow
        .lines()
        .find_map(|line| line.trim().strip_prefix(&format!("{name}:")))
        .unwrap_or_else(|| panic!("release-plz.yml references {name}, which it never sets"))
        .trim()
        .trim_matches('"')
        .to_owned()
}

/// release-plz's semver check is enabled and the workflow running it provisions
/// the tool it shells out to, at a version.
///
/// release-plz skips a check whose tool it cannot find, warning where nobody is
/// reading, so neither half is worth anything without the other.
#[test]
fn the_release_workflow_provisions_the_semver_check_it_enables() {
    assert!(
        read("release-plz.toml").contains("semver_check = true"),
        "release-plz.toml does not enable semver_check, so a breaking change \
         releases as whatever its commit type claimed"
    );
    let workflow = read(".github/workflows/release-plz.yml");
    let installed = provisioned_tools(&workflow)
        .into_iter()
        .find_map(|tool| {
            tool.strip_prefix("cargo-semver-checks@")
                .map(|pin| workflow_env(&workflow, pin))
        })
        .expect(
            "release-plz.yml provisions no cargo-semver-checks, so the check \
             release-plz.toml enables is skipped with a warning nobody reads",
        );
    let exact = installed.split('.').count() == 3
        && installed
            .split('.')
            .all(|part| part.parse::<u32>().is_ok() && !part.is_empty());
    assert!(
        exact,
        "cargo-semver-checks is provisioned as `{installed}` rather than an exact \
         x.y.z, so what reads the public surface is whatever was current that day"
    );
}

/// The release path builds the baseline from what the tag locked, and stops when
/// the check returns no verdict.
///
/// Both halves are the check. cargo-semver-checks reads a lockfile on neither
/// side, so a released manifest's open requirement resolves to whatever is newest
/// — for v0.3.3 an SDK that no longer compiles — and release-plz reports the
/// resulting failure as "API compatible". Fetching each side's locked versions is
/// what makes the baseline the tag's; running the check for its exit code is what
/// makes a missing verdict visible.
#[test]
fn the_release_workflow_reads_the_baseline_the_tag_locked_or_fails() {
    let workflow = read(".github/workflows/release-plz.yml");
    assert!(
        workflow.contains(
            "cargo fetch --locked --manifest-path \"${RUNNER_TEMP}/release-baseline/Cargo.toml\""
        ),
        "the baseline's own locked dependencies are never fetched, so the check \
         resolves today's registry and builds a baseline that may not compile"
    );
    assert!(
        workflow.contains("CARGO_NET_OFFLINE"),
        "nothing holds the resolve to what was fetched, so both surfaces are built \
         against whatever the registry serves that day"
    );
    assert!(
        workflow.contains("cargo semver-checks --baseline-root"),
        "no step runs the check for its exit code, leaving release-plz's silent \
         \"API compatible\" as the only reading a release gets"
    );
}

/// The SDK requirement is exact, and is the version the lockfile carries.
///
/// A crates.io consumer and cargo-semver-checks both resolve this crate without
/// our `Cargo.lock`, so a range hands them an SDK the tree never tested.
#[test]
fn the_sdk_requirement_is_the_exact_version_the_lockfile_carries() {
    let requirement = dependency_requirement(&read("Cargo.toml"), "onepipeline");
    let pinned = requirement.strip_prefix('=').unwrap_or_else(|| {
        panic!(
            "onepipeline is required as `{requirement}`, a range: an unlocked resolve \
             of this crate would build against an SDK the tree never tested"
        )
    });
    let lock = read("Cargo.lock");
    let (_, after) = lock
        .split_once("\nname = \"onepipeline\"\n")
        .expect("Cargo.lock does not resolve onepipeline");
    let locked = after
        .lines()
        .find_map(|line| line.trim().strip_prefix("version = "))
        .expect("Cargo.lock resolves onepipeline to no version")
        .trim_matches('"');
    assert_eq!(
        pinned, locked,
        "Cargo.toml pins onepipeline {pinned} and Cargo.lock resolves {locked}, so \
         `just bootstrap` provisions a CLI that speaks a different telemetry document \
         than a consumer's build of this crate reads"
    );
}

/// Directories whose every file reaches a published artifact, so a file added to
/// one has to be covered without anyone remembering this test exists.
const ARTIFACT_TREES: &[&str] = &[
    "src",
    "apps/dag-ui/src",
    "packages/dag-layout/src",
    "packages/dag-model/src",
    "packages/telemetry-client/src",
    "npm/onepipeline-api-cli/bin",
];

/// Single files a published artifact ships, or is described by.
const ARTIFACT_FILES: &[&str] = &[
    "README.md",
    "LICENSE",
    "docs/contract.md",
    "pyproject.toml",
    "npm/onepipeline-api-cli/package.json",
    "npm/onepipeline-ui/package.json",
    "npm/onepipeline-ui/README.md",
    // The per-platform packages have no committed manifest: this is the only
    // source of the bytes theirs is written from.
    "scripts/npm-build.mjs",
    // What Vite emits into the frontend bundle is decided by these, and what it
    // inlines is pinned by the lockfile.
    "apps/dag-ui/index.html",
    "apps/dag-ui/vite.config.ts",
    "apps/dag-ui/tsconfig.json",
    "apps/dag-ui/package.json",
    "tsconfig.base.json",
    "package.json",
    "package-lock.json",
];

/// The files `cargo package` would upload, which is exactly the set release-plz
/// diffs to decide a release is due — spelled the way `files_under` spells one.
fn packaged_files() -> Vec<String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let listed = std::process::Command::new(cargo)
        // `--offline` and `--locked` because the gate is offline and
        // deterministic; `just bootstrap` has fetched everything this resolves.
        // `--allow-dirty` because a working tree under review is usually dirty.
        .args([
            "package",
            "--list",
            "--offline",
            "--locked",
            "--allow-dirty",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo is on PATH");
    assert!(
        listed.status.success(),
        "cargo package --list failed:\n{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    String::from_utf8(listed.stdout)
        .expect("utf-8 file list")
        .lines()
        // `--list` prints each path the way the host spells one, so on Windows the
        // separators are backslashes — even though the tarball it is describing
        // always uses `/`, and so does the `include` glob that selected the file.
        // Normalised here rather than at the comparison, so this stays a list of
        // packaged files and not a list of Windows ones.
        .map(|line| line.replace('\\', "/"))
        .collect()
}

/// Every file under `directory`, relative to the repository root and spelled the
/// way `cargo package --list` spells one.
///
/// `AGENTS.md` is the one thing skipped: those are instructions to whoever works
/// on the tree next, they reach no artifact, and registries reject the
/// `CLAUDE.md` symlink beside the root one anyway.
fn files_under(directory: &str) -> Vec<String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join(directory);
    let mut found = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).unwrap_or_else(|err| panic!("read {dir:?}: {err}")) {
            let path = entry.expect("read a directory entry").path();
            if path.is_dir() {
                pending.push(path);
            } else if path.file_name().is_some_and(|name| name != "AGENTS.md") {
                let relative = path.strip_prefix(&root).expect("a path under the root");
                let relative = relative.to_str().expect("utf-8 path").replace('\\', "/");
                found.push(format!("{directory}/{relative}"));
            }
        }
    }
    assert!(!found.is_empty(), "{directory} holds no files");
    found
}

/// The packaged set is release-plz's only signal that a release is due: it opens
/// no release PR unless one of these files changed. This repository stamps one
/// version onto three deliverables, so anything whose bytes reach any of them has
/// to be in here — the alternative is what happened to v0.2.0 and v0.3.0, where
/// the fixes lived under `apps/dag-ui/` and no release was ever cut for them.
#[test]
fn every_file_a_published_artifact_ships_is_a_packaged_file() {
    let packaged = packaged_files();
    let mut missing = Vec::new();
    for path in ARTIFACT_TREES
        .iter()
        .flat_map(|tree| files_under(tree))
        .chain(ARTIFACT_FILES.iter().map(|path| (*path).to_owned()))
    {
        if !packaged.contains(&path) {
            missing.push(path);
        }
    }
    missing.sort();
    assert!(
        missing.is_empty(),
        "a change to these files would ship in a release but cannot cut one — \
         add them to `include` in Cargo.toml:\n  {}",
        missing.join("\n  ")
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
