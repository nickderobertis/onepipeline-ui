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

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

// This repository's boundary check on the canonical release-target schema, and
// the reader the assertions below take the declaration through. Shared with
// `tests/e2e/release_probe.rs`, which drives the probe over every identifier the
// same document declares.
#[path = "support/release_declaration.rs"]
mod release_declaration;

use release_declaration::{Declaration, FILE};

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

/// The `name = "..."` a TOML manifest sets inside `header`, e.g. `[[bin]]`.
///
/// Reading the section rather than the whole file is the point: `Cargo.toml`
/// declares two different names, and a substring search would let either one
/// satisfy an assertion about the other.
fn manifest_name(manifest: &str, header: &str) -> String {
    let mut inside = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == header;
        } else if inside {
            if let Some(value) = line.strip_prefix("name = ") {
                return value.trim_matches('"').to_owned();
            }
        }
    }
    panic!("no name is declared under {header}");
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

/// The version of `dependency` that `package` resolved to, as `Cargo.lock`
/// records the edge.
///
/// The lock disambiguates an edge by version only when more than one of that
/// package is in the graph, so an entry with no version is the single resolution
/// — read back off that package's own block.
fn locked_dependency(lock: &str, package: &str, dependency: &str) -> String {
    let block = lock
        .split("\n[[package]]\n")
        .find(|block| {
            block
                .lines()
                .any(|line| line == format!("name = \"{package}\""))
        })
        .unwrap_or_else(|| panic!("Cargo.lock does not resolve {package}"));
    let edge = block
        .lines()
        .map(str::trim)
        .find_map(|line| {
            line.trim_matches(|c| c == '"' || c == ',')
                .strip_prefix(dependency)
                .map(|rest| rest.trim().to_owned())
        })
        .unwrap_or_else(|| panic!("Cargo.lock records no {dependency} under {package}"));
    if edge.is_empty() {
        return locked_version(lock, dependency);
    }
    edge
}

/// The one version of `package` the lock resolved, for an edge that named none.
fn locked_version(lock: &str, package: &str) -> String {
    let block = lock
        .split("\n[[package]]\n")
        .find(|block| {
            block
                .lines()
                .any(|line| line == format!("name = \"{package}\""))
        })
        .unwrap_or_else(|| panic!("Cargo.lock does not resolve {package}"));
    block
        .lines()
        .find_map(|line| line.strip_prefix("version = "))
        .unwrap_or_else(|| panic!("Cargo.lock resolves {package} to no version"))
        .trim_matches('"')
        .to_owned()
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

/// The release takes the reading, and release-plz versions from the same resolve.
///
/// `scripts/semver-check.sh` is the reading itself and `tests/e2e/semver_check.rs`
/// drives it; what is left to hold here is that the release still runs it, over
/// both the baseline the worktree step made *and* the tag it made it of — the tag
/// is what says whether the pending release claims compatibility, and so whether
/// a baseline nobody can build stops it — and that release-plz's own check
/// resolves off what it fetched rather than today's registry, which is the resolve
/// that fails and is reported as compatible.
#[test]
fn the_release_workflow_reads_the_surface_before_release_plz_versions_from_it() {
    let workflow = read(".github/workflows/release-plz.yml");
    let reading = workflow
        .lines()
        .find(|line| line.trim_start().starts_with("run: just semver-check"))
        .expect(
            "no step reads the public surface, leaving release-plz's silent \
             \"API compatible\" as the only reading a release gets",
        );
    for output in ["steps.baseline.outputs.root", "steps.baseline.outputs.ref"] {
        assert!(
            reading.contains(output),
            "the reading is not given `{output}`, so it reads a surface without \
             the release it is being compared to: {reading}"
        );
    }
    assert!(
        workflow.contains("CARGO_NET_OFFLINE"),
        "release-plz resolves its own check against today's registry, so the bump \
         comes from a baseline that may no longer compile"
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

/// The oneharness history store is read by linking its library, never by
/// spawning its CLI.
///
/// Both halves matter and only one of them is visible in a manifest. A
/// `oneharness_session` artifact's bytes live in a store this crate does not
/// own, and the two ways to reach them are not equivalent: the library reads,
/// while the CLI is a program on `PATH` whose version nothing here pins, whose
/// arguments are a second contract, and whose lookups reconcile the store's own
/// index. So the requirement is declared under `[dependencies]` — not
/// `[dev-dependencies]`, which would leave the shipped binary unable to serve
/// one — and no source or suite spawns a `oneharness` process.
#[test]
fn the_history_store_is_read_by_linking_its_library_and_never_by_spawning_its_cli() {
    let requirement = dependency_requirement(&read("Cargo.toml"), "oneharness-core");
    assert!(
        !requirement.is_empty(),
        "oneharness-core is declared with no version requirement"
    );
    // The reader and the producer of the pointer it resolves must be the same
    // release of that library, and the requirement string alone cannot say so:
    // a caret admits a whole 0.x line and nothing reconciles the two ends. The
    // lockfile does — it records what each side resolved — so this reads both
    // edges rather than restating one of them in prose.
    let lock = read("Cargo.lock");
    let resolved = |package: &str| locked_dependency(&lock, package, "oneharness-core");
    assert_eq!(
        resolved("onepipeline-ui"),
        resolved("oneagentgraph"),
        "this crate reads the oneharness history store through a different release of \
         oneharness-core than `oneagentgraph`, which writes the pointer into it"
    );
    for path in files_under("src")
        .into_iter()
        .chain(files_under("tests"))
        .filter(|path| path.ends_with(".rs"))
    {
        let source = read(&path);
        // Spelled in halves so this assertion is not itself a hit. What it looks
        // for is the program being *run* — the spawn spellings — rather than the
        // word, which is also a directory in the store's own default path.
        let program = format!("{}{}", "onehar", "ness");
        for spawned in [
            format!("new(\"{program}"),
            format!("arg(\"{program}"),
            format!("args([\"{program}"),
        ] {
            assert!(
                !source.contains(&spawned),
                "{path} names the `{program}` program as a string: its history store is \
                 read by linking that library, and a process is a second contract \
                 nothing here pins"
            );
        }
    }
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

// A repository that declares no release target releases nothing as far as the
// mechanism sequencing work across repositories is concerned: a dependency
// landing here would earn a consumer no hold at all, silently. So
// `release-targets.toml` declares what this repository publishes, and the
// assertions below derive the published set from the release configuration
// *itself* — the workflow that publishes, the manifests it publishes under, and
// the script that writes the manifests it generates. A hand-written inventory is
// the thing that goes stale without saying so, which is the whole failure this
// declaration exists to stop.

/// The registries a release target may be qualified by.
const REGISTRIES: &[&str] = &["crate", "pypi", "npm"];

/// Every job `release.yml` declares, at the one indentation `jobs:` nests them
/// at.
///
/// Enumerated rather than looked for by name: a new publishing job is a new
/// artifact, and it has to reach [`published_names`] as something that fails
/// rather than as something nobody thought to look for.
fn workflow_jobs(workflow: &str) -> Vec<String> {
    workflow
        .lines()
        .skip_while(|line| *line != "jobs:")
        .filter_map(|line| {
            let id = line.strip_prefix("  ")?.strip_suffix(':')?;
            (!id.is_empty() && id.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
                .then(|| id.to_owned())
        })
        .collect()
}

/// The lines of `release.yml` that are one job: its id, and everything nested
/// under it up to the next thing declared beside it.
fn workflow_job(workflow: &str, job: &str) -> String {
    let header = format!("  {job}:");
    let mut lines = workflow.lines().skip_while(|line| **line != *header);
    let first = lines
        .next()
        .unwrap_or_else(|| panic!("release.yml declares no `{job}` job"));
    std::iter::once(first)
        .chain(lines.take_while(|line| {
            line.strip_prefix("  ")
                .is_none_or(|rest| rest.starts_with(' ') || rest.is_empty())
        }))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The committed package directory `scripts/npm-build.mjs` assembles `mode`
/// from, read out of that mode's own function.
///
/// The directory is where the published name comes from — the manifest in it is
/// shipped verbatim — so this follows the script to it rather than restating it.
fn npm_build_source_dir(build: &str, mode: &str) -> String {
    let mut characters = mode.chars();
    let function = format!(
        "function build{}{}(",
        characters.next().expect("a mode name").to_ascii_uppercase(),
        characters.as_str()
    );
    let (_, body) = build
        .split_once(&function)
        .unwrap_or_else(|| panic!("scripts/npm-build.mjs has no `{function})`"));
    let body = body.split("\nfunction ").next().expect("a function body");
    // `const src = ...` and not merely the first `npm/` path in the body: the
    // output root is written just above it and is `npm/dist`, which is a
    // directory this reads nothing from and a package nobody publishes.
    let (_, source) = body
        .split_once("const src = join(REPO_ROOT, \"npm\", \"")
        .unwrap_or_else(|| panic!("`{function})` assembles no committed package under npm/"));
    source
        .split_once('"')
        .expect("an unterminated directory name")
        .0
        .to_owned()
}

/// The npm package name `scripts/npm-build.mjs` generates for a Rust target.
///
/// A platform package has no committed manifest, so the script's own template
/// and its target table are the only source of the name — read here rather than
/// spelled a second time.
fn npm_platform_package(build: &str, target: &str) -> String {
    let (_, entry) = build
        .split_once(&format!("\"{target}\": {{"))
        .unwrap_or_else(|| panic!("scripts/npm-build.mjs maps no {target}"));
    let entry = entry
        .split_once('}')
        .expect("an unterminated target entry")
        .0;
    let fact = |key: &str| {
        let (_, value) = entry
            .split_once(&format!("{key}: \""))
            .unwrap_or_else(|| panic!("scripts/npm-build.mjs gives {target} no {key}"));
        value.split_once('"').expect("an unterminated value").0
    };
    let (_, template) = build
        .split_once("const pkgName = `")
        .expect("scripts/npm-build.mjs names no platform package");
    template
        .split_once('`')
        .expect("an unterminated package-name template")
        .0
        .replace("${facts.platform}", fact("platform"))
        .replace("${facts.arch}", fact("arch"))
}

/// Every name this repository publishes, registry-qualified, derived from the
/// release configuration.
///
/// Nothing here is a transcribed list. Each publishing job in `release.yml`
/// names the registry, and the name is read from whatever that job publishes
/// under: `Cargo.toml` for the crate, `pyproject.toml` for the wheels, and for
/// npm the committed manifest of each package `scripts/npm-build.mjs` assembles
/// plus the per-platform names it generates over the release matrix. A publish
/// job this cannot read is a panic rather than a silent omission — a new
/// artifact has to fail here, not pass unnoticed.
fn published_names() -> BTreeSet<String> {
    let workflow = read(".github/workflows/release.yml");
    let mut published = BTreeSet::new();
    for job in workflow_jobs(&workflow) {
        let Some(registry) = job.strip_prefix("publish-") else {
            continue;
        };
        let block = workflow_job(&workflow, &job);
        match registry {
            "crate" => {
                assert!(
                    block.contains("cargo publish"),
                    "the publish-crate job no longer runs `cargo publish`, so what it \
                     puts on crates.io is not what Cargo.toml names"
                );
                published.insert(format!(
                    "crate:{}",
                    manifest_name(&read("Cargo.toml"), "[package]")
                ));
            }
            "pypi" => {
                assert!(
                    block.contains("pypa/gh-action-pypi-publish"),
                    "the publish-pypi job no longer uploads the maturin wheels, so what \
                     it puts on PyPI is not what pyproject.toml names"
                );
                published.insert(format!(
                    "pypi:{}",
                    manifest_name(&read("pyproject.toml"), "[project]")
                ));
            }
            "npm" => {
                assert!(
                    block.contains("scripts/publish-npm.sh"),
                    "the publish-npm job no longer publishes through scripts/publish-npm.sh"
                );
                let build = read("scripts/npm-build.mjs");
                // Read from the whole workflow, not this job: the per-platform
                // packages are assembled on the native runners in `build-npm`
                // and published from the tarballs it hands over, so a mode this
                // job never types is still a package this job publishes.
                let modes = names_after(&workflow, "node scripts/npm-build.mjs ", |character| {
                    character.is_ascii_alphabetic()
                });
                assert!(
                    !modes.is_empty(),
                    "release.yml assembles no npm package at all, yet publishes to npm"
                );
                for mode in modes {
                    if mode == "platform" {
                        let targets = names_after(
                            &workflow_job(&workflow, "build-npm"),
                            "- target: ",
                            |character| !character.is_whitespace(),
                        );
                        assert!(
                            !targets.is_empty(),
                            "the build-npm job builds no target, so no platform package \
                             is published for the launcher to resolve"
                        );
                        for target in targets {
                            published
                                .insert(format!("npm:{}", npm_platform_package(&build, &target)));
                        }
                    } else {
                        let directory = npm_build_source_dir(&build, &mode);
                        let manifest: serde_json::Value =
                            serde_json::from_str(&read(&format!("npm/{directory}/package.json")))
                                .expect("parse a committed npm manifest");
                        published.insert(format!(
                            "npm:{}",
                            manifest["name"].as_str().expect("a package name")
                        ));
                    }
                }
            }
            other => panic!(
                "release.yml has a `publish-{other}` job whose artifact this gate cannot \
                 name. Teach `published_names` what it publishes and declare it in \
                 release-targets.toml — an artifact nobody declares earns a consumer no \
                 hold on the release that carries it."
            ),
        }
    }
    assert!(
        !published.is_empty(),
        "release.yml publishes nothing, so release-targets.toml describes a repository \
         this is not"
    );
    published
}

/// Every name a declared target accounts for, mapped to the target accounting
/// for it: the target's own identifier, and each per-platform package it covers.
///
/// The schema check has already refused a malformed identifier and one two
/// entries both account for. What is left here is this repository's own half:
/// the registries `scripts/release-probe.sh` can read, because a target it
/// cannot ask about is one a consumer can never be answered for.
fn declared_coverage(declaration: &Declaration) -> BTreeMap<String, String> {
    let mut coverage: BTreeMap<String, String> = BTreeMap::new();
    for target in &declaration.targets {
        let id = target.id.as_str().to_owned();
        for accounted in std::iter::once(&target.id).chain(target.covers.iter()) {
            assert!(
                REGISTRIES.contains(&accounted.registry()),
                "`{accounted}` names the registry `{registry}`, which nothing here publishes to \
                 and scripts/release-probe.sh cannot read",
                accounted = accounted.as_str(),
                registry = accounted.registry()
            );
            coverage.insert(accounted.as_str().to_owned(), id.clone());
        }
    }
    coverage
}

/// Reconcile what the declaration says this repository publishes against what
/// the release configuration actually publishes — in both directions.
///
/// Undeclared is the damaging direction: a consumer waiting on a release of this
/// repository gets no hold on an artifact nobody declared, so its dependency
/// lands and dependent work launches against a version that never published.
/// Over-declared is the other: a target naming something this repository does
/// not publish is a wait that can never end. A separate function from the test
/// that runs it over the real tree, because a drift check nothing has ever seen
/// refuse is a check nobody knows the direction of: the two tests below hand it
/// each kind of drift.
fn reconcile(declaration: &Declaration, published: &BTreeSet<String>) -> Result<(), String> {
    let coverage = declared_coverage(declaration);
    let declared: BTreeSet<String> = coverage.keys().cloned().collect();
    let listed = |names: Vec<&String>| {
        names
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join("\n  ")
    };

    let undeclared: Vec<&String> = published.difference(&declared).collect();
    if !undeclared.is_empty() {
        return Err(format!(
            "release.yml publishes these, and {FILE} accounts for none of them — a consumer \
             waiting on a release that carries one would be told there is nothing to wait \
             for:\n  {}",
            listed(undeclared)
        ));
    }

    let unpublished: Vec<&String> = declared.difference(published).collect();
    if !unpublished.is_empty() {
        return Err(format!(
            "{FILE} declares these, and nothing in the release configuration publishes them — a \
             consumer waiting on one waits forever:\n  {}",
            listed(unpublished)
        ));
    }

    // A name published under a retired identifier would hand a consumer a hold
    // on a package frozen at 0.1.0 (see AGENTS.md), which is worse than no hold.
    // That it is not *also* a live target is the schema's own refusal.
    for entry in &declaration.retired {
        let id = entry.id.as_str();
        if published.contains(id) {
            return Err(format!(
                "`{id}` is declared retired and the release configuration publishes it"
            ));
        }
    }
    Ok(())
}

/// The declaration and the release configuration describe the same set of
/// artifacts.
#[test]
fn every_name_this_repository_publishes_is_accounted_for_by_exactly_one_release_target() {
    if let Err(drift) = reconcile(&release_declaration::declared(), &published_names()) {
        panic!("{drift}");
    }
}

/// The undeclared direction, driven: a name the release configuration publishes
/// and the declaration does not account for.
///
/// A new per-platform package added to the `build-npm` matrix is exactly how
/// this arrives in practice — the workflow publishes it, nothing declares it,
/// and a consumer holding on the launcher that resolves it is told there is
/// nothing to wait for.
#[test]
fn a_name_this_repository_publishes_and_does_not_declare_fails_the_reconciliation() {
    let mut published = published_names();
    published.insert("npm:onepipeline-api-cli-freebsd-x64".to_owned());

    let drift = reconcile(&release_declaration::declared(), &published)
        .expect_err("a published name nothing declares reconciled");
    assert!(
        drift.contains("npm:onepipeline-api-cli-freebsd-x64"),
        "the refusal does not name the undeclared artifact: {drift}"
    );
}

/// The over-declared direction, driven: a target the declaration names and
/// nothing in the release configuration publishes.
///
/// Appended to this repository's own document rather than written beside it, so
/// what is reconciled is the real declaration plus one target — the shape a
/// retired or renamed artifact left behind in it would have.
#[test]
fn a_name_this_repository_declares_and_does_not_publish_fails_the_reconciliation() {
    let document = format!(
        "{}\n[[target]]\nid = \"npm:onepipeline-ui-nothing-publishes\"\nname = \"phantom\"\n\
         what = \"An artifact no job in the release workflow assembles.\"\n\
         published_by = \"Nothing: this target is the drift this reconciliation exists to \
         refuse.\"\n",
        read(FILE)
    );
    let declaration = release_declaration::validate(&document, FILE).expect("a valid declaration");

    let drift = reconcile(&declaration, &published_names())
        .expect_err("a declared name nothing publishes reconciled");
    assert!(
        drift.contains("npm:onepipeline-ui-nothing-publishes"),
        "the refusal does not name the unpublished artifact: {drift}"
    );
}

/// The document this repository carries is one the canonical schema accepts.
///
/// The schema is `onevcs`'s, not this repository's; `tests/support/release_declaration.rs`
/// is this repository's boundary check on it, and what it refuses is held to
/// below. This is the pass side of that check, over the real document.
#[test]
fn the_declaration_this_repository_carries_conforms_to_the_canonical_schema() {
    let declaration = release_declaration::declared();
    assert_eq!(
        declaration.schema_version,
        release_declaration::SCHEMA_VERSION
    );

    let mut names: Vec<&str> = declaration
        .targets
        .iter()
        .map(|target| target.name.as_str())
        .collect();
    let short = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(
        names.len(),
        short,
        "two targets are waited on by one short name"
    );
}

/// The refusal side of the same check, driven document by document.
///
/// A schema check nobody has watched refuse is a check nobody knows the shape
/// of, and this one is what stops a sixth shape of this document appearing. Each
/// row is a document that is wrong in exactly one way the canonical schema names
/// — a required field dropped, an identifier malformed, a short name repeated,
/// and the rest of what only a whole document can be wrong about.
#[test]
fn a_declaration_the_canonical_schema_refuses_is_refused_here() {
    // One well-formed target, spelled out so each row below can be one edit away
    // from a document that reads.
    const TARGET: &str = "\n[[target]]\nid = \"crate:onepipeline-ui\"\nname = \"crate\"\n\
                          what = \"The read API itself.\"\n\
                          published_by = \"release.yml, the publish-crate job.\"\n";

    let refusals: Vec<(&str, String, &str)> = vec![
        (
            "no schema_version",
            TARGET.to_owned(),
            "declares no schema_version",
        ),
        (
            "a schema_version older than this check reads",
            format!("schema_version = 0\n{TARGET}"),
            "reads schema_version 1 and newer",
        ),
        (
            "a key the schema does not declare",
            format!("schema_version = 1\nprobes = \"scripts/release-probe.sh\"\n{TARGET}"),
            "\"probes\"",
        ),
        (
            "a misspelled key inside a target",
            format!("schema_version = 1\n{TARGET}manifset = \"Cargo.toml\"\n"),
            "\"manifset\"",
        ),
        (
            "a required field dropped",
            format!("schema_version = 1\n{}", TARGET.replace("name = \"crate\"\n", "")),
            "missing field `name`",
        ),
        (
            "an identifier that names no registry",
            format!("schema_version = 1\n{}", TARGET.replace("crate:onepipeline-ui", "onepipeline-ui")),
            "names no registry",
        ),
        (
            "an identifier whose name no registry serves",
            format!("schema_version = 1\n{}", TARGET.replace("crate:onepipeline-ui", "crate:not a package")),
            "is not a name a registry serves",
        ),
        (
            "an identifier whose registry is not one word",
            format!("schema_version = 1\n{}", TARGET.replace("crate:onepipeline-ui", "Crates.IO:onepipeline-ui")),
            "not one word of lowercase letters",
        ),
        (
            "a short name outside the alphabet a target name is spelled in",
            format!("schema_version = 1\n{}", TARGET.replace("name = \"crate\"", "name = \"the crate\"")),
            "may hold only letters, digits",
        ),
        (
            "a short name that does not open with a letter or a digit",
            format!("schema_version = 1\n{}", TARGET.replace("name = \"crate\"", "name = \"-crate\"")),
            "must start with a letter or a digit",
        ),
        (
            "a blank sentence",
            format!("schema_version = 1\n{}", TARGET.replace("The read API itself.", "  ")),
            "none of them may be blank",
        ),
        (
            "a sentence longer than one line's worth",
            format!("schema_version = 1\n{}", TARGET.replace("The read API itself.", &"x".repeat(401))),
            "longer than 400 characters",
        ),
        (
            "a probe that leaves the repository root",
            format!("schema_version = 1\nprobe = \"../elsewhere/release-probe.sh\"\n{TARGET}"),
            "leaves the repository root",
        ),
        (
            "a probe on the reader's own machine",
            format!("schema_version = 1\nprobe = \"/usr/local/bin/release-probe.sh\"\n{TARGET}"),
            "is absolute",
        ),
        (
            "a probe naming a drive on the reader's own machine",
            format!("schema_version = 1\nprobe = \"C:release-probe.sh\"\n{TARGET}"),
            "names a drive",
        ),
        (
            "a probe that is no path at all",
            format!("schema_version = 1\nprobe = \"\"\n{TARGET}"),
            "empty path",
        ),
        (
            "a declaration with no target at all",
            "schema_version = 1\n".to_owned(),
            "declares no [[target]]",
        ),
        (
            "two targets taking one short name",
            format!("schema_version = 1\n{TARGET}{}", TARGET.replace("crate:onepipeline-ui", "npm:onepipeline-ui")),
            "already takes",
        ),
        (
            "two targets declaring one identifier",
            format!("schema_version = 1\n{TARGET}{}", TARGET.replace("name = \"crate\"", "name = \"crate-again\"")),
            "one artifact is one target",
        ),
        (
            "a covered identifier that is a target of its own",
            format!("schema_version = 1\n{TARGET}covers = [\"crate:onepipeline-ui\"]\n"),
            "declares as a target of its own",
        ),
        (
            "one identifier two targets both cover",
            format!(
                "schema_version = 1\n{TARGET}covers = [\"npm:onepipeline-api-cli-linux-x64\"]\n{}covers = [\"npm:onepipeline-api-cli-linux-x64\"]\n",
                TARGET
                    .replace("crate:onepipeline-ui", "npm:onepipeline-api-cli")
                    .replace("name = \"crate\"", "name = \"npm-cli\"")
            ),
            "already covers",
        ),
        (
            "a retired artifact this repository still publishes",
            format!("schema_version = 1\n{TARGET}\n[[retired]]\nid = \"crate:onepipeline-ui\"\nwhy = \"Frozen at 0.1.0.\"\n"),
            "retiring what [[target]] 1 publishes",
        ),
        (
            "one artifact retired twice",
            format!("schema_version = 1\n{TARGET}\n[[retired]]\nid = \"npm:onepipeline-ui-cli\"\nwhy = \"Frozen at 0.1.0.\"\n[[retired]]\nid = \"npm:onepipeline-ui-cli\"\nwhy = \"Frozen at 0.1.0, again.\"\n"),
            "already records",
        ),
        (
            "a document that is not TOML at all",
            "schema_version =\n".to_owned(),
            "is not TOML",
        ),
    ];

    for (wrong, document, refusal) in refusals {
        let answer = release_declaration::validate(&document, "the document under test");
        let Err(said) = answer else {
            panic!("a declaration with {wrong} was accepted");
        };
        assert!(
            said.contains(refusal),
            "a declaration with {wrong} was refused, and the refusal does not say why:\n{said}"
        );
    }
}

/// A later schema is read as this one, with what it names beyond it ignored.
///
/// The promise the document makes to a consumer one release behind: refusing a
/// key it has never heard of would leave a reader that could have listed every
/// artifact this repository publishes listing none of them.
#[test]
fn a_declaration_written_against_a_later_schema_is_still_read() {
    let declaration = release_declaration::validate(
        "schema_version = 2\nnot_a_key_this_check_knows = true\n\
         [[target]]\nid = \"crate:onepipeline-ui\"\nname = \"crate\"\n\
         what = \"The read API itself.\"\n\
         published_by = \"release.yml, the publish-crate job.\"\n",
        "a document from one release ahead",
    )
    .expect("a later schema was refused rather than read as this one");
    assert_eq!(declaration.targets.len(), 1);
}

/// The declaration names the probe that answers it, the probe and every manifest
/// it names are in the tree, and something drives the probe against a live
/// registry.
///
/// A declaration is only worth anything if something can ask the registry what
/// it currently serves for each name in it. `tests/e2e/release_probe.rs` drives
/// every way that probe can fail to answer, and every identifier this document
/// declares through it; the two answers only a real registry can give it are
/// driven by the sweep — which is outside the gate because the gate is offline,
/// and so is the one part of this nothing else would notice the loss of.
#[test]
fn the_declaration_names_a_probe_and_manifests_this_repository_carries() {
    let declaration = release_declaration::declared();
    let carried = |relative: &str| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(relative)
            .is_file()
    };

    let probe = declaration
        .probe
        .as_ref()
        .unwrap_or_else(|| panic!("{FILE} names no probe"))
        .as_str()
        .to_owned();
    assert!(
        carried(&probe),
        "{FILE} names `{probe}`, which this repository does not carry"
    );
    assert!(
        read(".github/workflows/published-smoke.yml").contains(&probe),
        "nothing asks a live registry what `{probe}` answers, so the version it \
         serves and the emptiness of a name it has never released are verified \
         nowhere — the gate is offline and cannot verify either"
    );

    // The other path the schema lets a declaration carry, and the reason it is
    // worth carrying: a manifest is where this target's version is read from, so
    // one naming a file this repository does not have is a version nobody can read.
    for target in &declaration.targets {
        let Some(manifest) = target.manifest.as_ref() else {
            continue;
        };
        assert!(
            carried(manifest.as_str()),
            "{FILE} reads `{name}`'s version from `{manifest}`, which this repository \
             does not carry",
            name = target.name.as_str(),
            manifest = manifest.as_str()
        );
    }
}

/// The one alarm on a published-smoke failure is wired to a job that can
/// actually run it.
///
/// `tests/e2e/report_workflow_failure.rs` holds what the reporter *does*; what
/// it cannot hold is whether the workflow reaches it, and there are exactly two
/// ways that goes wrong silently. A job that never checks the repository out has
/// no `scripts/` in its workspace, so the reporter is missing on the one run it
/// exists for — that is the defect this was copied from. And a job that does not
/// declare `issues: write` gets a token that cannot open the issue, because a
/// workflow-run leg is given no more than the workflow declares. Neither shows
/// up until a smoke has already failed and told nobody, which is the whole
/// failure this repository is trying to stop having.
#[test]
fn the_published_smoke_can_reach_and_run_its_own_failure_reporter() {
    const REPORTER: &str = "scripts/report-workflow-failure.sh";
    let workflow = read(".github/workflows/published-smoke.yml");

    assert!(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(REPORTER)
            .is_file(),
        "the published smoke reports its failures with `{REPORTER}`, which this \
         repository does not carry"
    );

    let report = workflow
        .split_once("\n  report:\n")
        .map(|(_, rest)| rest)
        .expect(
            "published-smoke.yml declares no `report` job, so a failure of it is announced nowhere",
        );

    assert!(
        report.contains("actions/checkout@"),
        "the `report` job does not check this repository out, so `{REPORTER}` is \
         not in its workspace and the failure it exists to announce is announced \
         nowhere"
    );
    assert!(
        report.contains(REPORTER),
        "the `report` job does not run `{REPORTER}`"
    );
    assert!(
        report.contains("issues: write"),
        "the `report` job does not ask for `issues: write`, so its token cannot \
         open the issue it exists to open"
    );

    // The title is how the reporter finds the thread it already opened, so it
    // has to be the same text on every run. One `${{ … }}` in it — a run number,
    // a ref, the release it followed — and every failure opens its own issue,
    // which is the pile this was built to avoid.
    let title = report
        .lines()
        .find_map(|line| line.trim().strip_prefix("TITLE:"))
        .expect("the `report` job passes the reporter no TITLE, so it has nothing to file under");
    assert!(
        !title.contains("${{"),
        "the `report` job's title is computed per run (`{}`), so a second failure \
         would not find the issue the first one opened",
        title.trim()
    );
}

/// The smoke is triggered by a workflow it names in prose, so the name has to
/// still be that workflow's.
///
/// `workflow_run` matches on a workflow's *display name*, and GitHub says
/// nothing when it matches none: renaming `release.yml` would leave the smoke
/// silently never running again, which is indistinguishable from a smoke that
/// keeps passing. The name is not derivable at trigger time — a workflow cannot
/// reference another workflow's `name:` — so this is the drift gate that keeps
/// the restatement honest.
#[test]
fn the_published_smoke_is_triggered_by_the_workflow_that_actually_releases() {
    let released_by = read(".github/workflows/release.yml")
        .lines()
        .find_map(|line| line.strip_prefix("name:"))
        .map(|name| name.trim().to_owned())
        .expect("release.yml declares no name for `workflow_run` to match on");

    let workflow = read(".github/workflows/published-smoke.yml");
    let (trigger, _) = workflow
        .split_once("\n\njobs:\n")
        .expect("published-smoke.yml declares no jobs");
    let watched = trigger
        .lines()
        .find_map(|line| line.trim().strip_prefix("workflows:"))
        .expect("published-smoke.yml does not run on another workflow's completion");

    assert!(
        watched.contains(&format!("\"{released_by}\"")),
        "the published smoke waits on {watched}, and the workflow that publishes \
         this repository is named `{released_by}` — a `workflow_run` that matches \
         nothing never runs and never says so"
    );
}
