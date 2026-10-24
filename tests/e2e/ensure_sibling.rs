//! The gate's own provisioning: `just _ensure-sibling`, and the task graph that
//! reaches it.
//!
//! `.tools/` is the one thing the tiers need that lives inside the clone rather
//! than in a user-wide cache, so it is the one thing a fresh clone lacks — and a
//! gate is asked to rule in exactly such a tree, because a publication clone is
//! disposable and nobody bootstraps it by hand. These journeys are the two halves
//! of that: what the recipe does with a tree that has no sibling, a stray one, or
//! the pinned one, and whether the suites that start the read API reach the recipe
//! at all.
//!
//! Two things are stood in for: `cargo` on PATH, because the real provisioning
//! downloads and compiles the sibling CLI, which is neither offline nor quick;
//! and the Releases the recipe fetches the CLI's own archive from, which are a
//! local mirror directory laid out as a Release is — empty unless a journey puts
//! an archive in it, so a Release with no archive for this host is the default.
//! The recipe under test is the real one, run out of a copy of the real justfile
//! over the real `Cargo.lock`, so the version it pins to is the version this
//! tree resolves — and what it asked cargo for is readable here. The one line of
//! that lock a journey sets is where the library resolves from, crates.io or one
//! git commit, because each journey is about one of the two whichever this tree
//! links today. The copy is the
//! point rather than a shortcut: the recipe writes into `justfile_directory()`,
//! and a journey that let it write into the repository would provision over the
//! very binary the rest of the suite is reading.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

use onepipeline_ui::contract::Release;

use crate::stub_bin;

/// The tasks that start the read API beside the sibling, and so cannot run
/// before the sibling is provisioned: the crate's e2e journeys — instrumented,
/// and as the cross-platform legs run them — the baseline comparison, which
/// starts two servers rather than one, and the browser tier, whose Playwright
/// journeys drive a real server over a fixture runs root.
///
/// Several targets and not one, because each of them is a tier a reader can ask
/// for by name — that is what having an edge of their own means — and a tier
/// reached on its own is exactly the one whose provisioning nothing else has done.
const SUITES_THAT_START_THE_READ_API: [&str; 4] = [
    "onepipeline-ui-e2e:test",
    "onepipeline-ui-e2e:test-quick",
    "onepipeline-ui-baseline:test-baseline",
    "dag-ui-e2e:test",
];

/// The targets those tasks are reached through, which is what Nx is asked for.
const TIERS: &str = "test,test-quick,test-baseline";

const PROVISIONING: &str = "onepipeline-ui:ensure-sibling";

/// Every task that compiles the read API for a suite to drive.
///
/// The binary embeds the browser view `dag-ui:build` produces (`build.rs`),
/// and the `ui::` journeys and the browser tier's `--ui` origin read that
/// view back off a port — so a binary compiled before the view was built is
/// one that refuses `--ui`, and the tier fails in a clean clone naming a
/// missing bundle rather than proving anything.
///
/// Every tier of the crate's suite is here, because each compiles the same test
/// binaries: the ones whose journeys never ask for the view compile the same
/// binary into the same target directory as the tiers that do, and `check` runs
/// them beside each other. A tier that compiled a bundle-less binary there would
/// leave the next one to rebuild it, which is minutes of the gate spent producing
/// a binary that was already correct the run before. `test-quick` is each tier as
/// the cross-platform legs run it, where nothing else builds the view first. The
/// packaging targets, the lints, the docs and the MSRV check compile the crate
/// too, and one Nx run of a CI job runs them beside the view's build — a view
/// rebuilt under a compile deletes a file `build.rs` is embedding.
const TASKS_THAT_COMPILE_THE_READ_API: [&str; 19] = [
    "onepipeline-ui:test",
    "onepipeline-ui:test-quick",
    "onepipeline-ui-e2e:test",
    "onepipeline-ui-e2e:test-quick",
    "onepipeline-ui-repo-tooling:test",
    "onepipeline-ui-repo-tooling:test-quick",
    "onepipeline-ui-baseline:test-baseline",
    "onepipeline-ui-baseline-reuse:test",
    "onepipeline-ui-baseline-reuse:test-quick",
    "onepipeline-ui-cost:test-cost",
    "onepipeline-ui-linked-report:test",
    "onepipeline-ui-judged-tier:test",
    "dag-ui:build-api-server",
    "onepipeline-ui:install-smoke",
    "onepipeline-ui:wheel-smoke",
    "onepipeline-ui:lint",
    "onepipeline-ui:doc",
    "onepipeline-ui:msrv",
    "dag-ui-build-cache:lint",
];

/// The targets those tasks are reached through.
const COMPILING_TIERS: &str =
    "test,test-quick,test-baseline,test-cost,install-smoke,wheel-smoke,lint,doc,msrv";

/// What builds the view the binary embeds.
const VIEW_BUILD: &str = "dag-ui:build";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The lock's source for a library resolved from crates.io.
const REGISTRY: &str = "registry+https://github.com/rust-lang/crates.io-index";

/// The repository a fast adoption links the engine from.
const GIT_REPOSITORY: &str = "https://github.com/nickderobertis/onepipeline";

/// The commit those journeys pin it to, as a lock names an exact `rev`.
const GIT_COMMIT: &str = "f06d041c5e3e398d348858207d9f8e5d9add017a";

/// The lock's source for the library linked at [`GIT_COMMIT`].
fn git_source() -> String {
    format!("git+{GIT_REPOSITORY}?rev={GIT_COMMIT}#{GIT_COMMIT}")
}

/// A scratch tree carrying the real recipe, the real pin, and a `cargo` that
/// records rather than installs.
struct Fixture {
    dir: TempDir,
    search_path: std::ffi::OsString,
}

impl Fixture {
    /// A tree with no `.tools/` at all — a clone nobody has bootstrapped — whose
    /// lock resolves the library from crates.io.
    fn new() -> Self {
        let fixture = Self::copied();
        fixture.pin_source(REGISTRY);
        fixture
    }

    /// The same, with the lock linking the library at [`GIT_COMMIT`]: a fast
    /// adoption, whose commit reports the release version it was cut after.
    fn git() -> Self {
        let fixture = Self::copied();
        fixture.pin_source(&git_source());
        fixture
    }

    /// Set where the copied lock resolves `onepipeline` from, leaving every other
    /// line of it as this tree resolves it.
    fn pin_source(&self, source: &str) {
        let path = self.dir.path().join("Cargo.lock");
        let lock = fs::read_to_string(&path).expect("the copied lock");
        let blocks: Vec<String> = lock
            .split("\n[[package]]\n")
            .map(|block| {
                if !block.lines().any(|line| line == "name = \"onepipeline\"") {
                    return block.to_owned();
                }
                let mut lines: Vec<String> = block
                    .lines()
                    .filter(|line| !line.starts_with("source = "))
                    .map(str::to_owned)
                    .collect();
                let version = lines
                    .iter()
                    .position(|line| line.starts_with("version = "))
                    .expect("the engine's block names its version");
                lines.insert(version + 1, format!("source = \"{source}\""));
                lines.join("\n") + if block.ends_with('\n') { "\n" } else { "" }
            })
            .collect();
        fs::write(&path, blocks.join("\n[[package]]\n")).expect("rewrite the copied lock");
    }

    fn copied() -> Self {
        let dir = TempDir::new().expect("temp dir");
        fs::create_dir_all(dir.path().join("scripts")).expect("the copy's scripts directory");
        for name in [
            "justfile",
            "Cargo.lock",
            "Cargo.toml",
            "scripts/ensure-sibling.sh",
        ] {
            fs::copy(repo_root().join(name), dir.path().join(name))
                .unwrap_or_else(|error| panic!("copy {name} into the scratch tree: {error}"));
        }
        fs::create_dir_all(dir.path().join("releases")).expect("the empty release mirror");

        // Records what the recipe asked for, and answers with the status the case
        // under test is about. A successful install leaves a program in
        // `<root>/bin` reporting the version it was asked for — or
        // INSTALL_REPORTS — as `cargo install` leaves the CLI there, and records
        // the package it installed in `<root>/.crates2.json` under the id cargo
        // gives it: the version and the source, the commit for a git install —
        // or INSTALL_RECORDS. A git install's package version is the pinned one.
        // Unforced, it skips a package its record already lists, as cargo does,
        // leaving whatever is at the path. STAMP_BLOCKED leaves a directory where the recipe writes its stamp, the
        // way a stray `mkdir` or a botched cache restore would.
        //
        // llmlint: ignore-block[e2e_not_mocked] the real call downloads and
        // compiles the sibling CLI, which is the one thing an offline,
        // deterministic gate cannot drive — `just bootstrap` and this recipe in
        // the gate both run the real one. The recipe under test is the real
        // recipe, out of the real justfile, pinning off the real `Cargo.lock`;
        // standing in for the program on PATH is what makes the version it asked
        // to install readable. This call is the whole of that substitution.
        let stub_dir = dir.path().join("stub-bin");
        let search_path = stub_bin::install(
            &stub_dir,
            "cargo",
            "#!/usr/bin/env bash\n\
             set -eu\n\
             printf '%s\\n' \"$*\" >> \"$CARGO_CALLS\"\n\
             [ \"${INSTALL_STATUS:-0}\" = 0 ] || exit \"$INSTALL_STATUS\"\n\
             version=; root=; git=; rev=; force=\n\
             while [ $# -gt 0 ]; do case \"$1\" in --version) version=\"$2\"; shift 2 ;; --root) root=\"$2\"; shift 2 ;; --git) git=\"$2\"; shift 2 ;; --rev) rev=\"$2\"; shift 2 ;; --force) force=1; shift ;; *) shift ;; esac; done\n\
             source=registry+https://github.com/rust-lang/crates.io-index\n\
             if [ -n \"$git\" ]; then version=\"$GIT_PACKAGE_VERSION\"; source=\"git+$git?rev=$rev#$rev\"; fi\n\
             if [ -z \"$force\" ] && grep -qF \"onepipeline $version ($source)\" \"$root/.crates2.json\" 2>/dev/null; then exit 0; fi\n\
             mkdir -p \"$root/bin\"\n\
             printf '#!/usr/bin/env bash\\nprintf \"onepipeline %s\\\\n\"\\n' \"${INSTALL_REPORTS:-$version}\" > \"$root/bin/onepipeline$SIBLING_EXE\"\n\
             chmod +x \"$root/bin/onepipeline$SIBLING_EXE\"\n\
             printf '{\"installs\":{\"onepipeline %s (%s)\":{}}}\\n' \"$version\" \"${INSTALL_RECORDS:-$source}\" > \"$root/.crates2.json\"\n\
             [ -z \"${STAMP_BLOCKED:-}\" ] || mkdir -p \"$root/bin/onepipeline$SIBLING_EXE.source\"\n",
        );
        // llmlint: ignore-end[e2e_not_mocked]

        Self { dir, search_path }
    }

    /// Put a build of the sibling where the recipe looks, reporting `version`.
    fn sibling_in_the_tree(&self, version: &str) {
        self.write_stub_sibling(&self.dir.path().join(".tools/bin"), version);
    }

    /// Put a build of the sibling on PATH — where the recipe must never look.
    fn sibling_on_path(&self, version: &str) {
        self.write_stub_sibling(&self.dir.path().join("stub-bin"), version);
    }

    // llmlint: ignore[e2e_not_mocked] this stands in for the *provisioned
    // artifact*, not for the recipe under test: what the journeys need is a
    // program that answers `--version`, and building the real CLI to ask it that
    // is the download this suite exists without.
    fn write_stub_sibling(&self, dir: &Path, version: &str) {
        stub_bin::install(
            dir,
            &provisioned_sibling(),
            &format!("#!/usr/bin/env bash\nprintf 'onepipeline {version}\\n'\n"),
        );
    }

    /// Run the recipe the way `bootstrap` and the `ensure-sibling` target run it.
    fn run(&self) -> Output {
        self.run_with(&[])
    }

    /// The same, with `environment` deciding what the stand-in answers.
    fn run_with(&self, environment: &[(&str, &str)]) -> Output {
        let mut command = Command::new("just");
        command
            .arg("_ensure-sibling")
            .current_dir(self.dir.path())
            .env("PATH", &self.search_path)
            .env("CARGO_CALLS", self.dir.path().join("cargo-calls"))
            .env("SIBLING_EXE", std::env::consts::EXE_SUFFIX)
            .env("GIT_PACKAGE_VERSION", Release::linked().as_str())
            .env(
                "ONEPIPELINE_UI_SIBLING_RELEASES",
                self.dir.path().join("releases"),
            );
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("just is on PATH")
    }

    /// Publish an archive of a CLI reporting `reports` in the mirror's Release
    /// for the pinned version, under the name the recipe asks for on this host,
    /// with a checksum file beside it: the archive's own digest for `None`,
    /// `Some(Some(digest))` for another, and none at all for `Some(None)`.
    #[cfg(unix)]
    fn publish_archive(&self, reports: &str, checksum: Option<Option<&str>>) {
        let pin = Release::linked().as_str().to_owned();
        let triple = host_triple();
        let release = self.dir.path().join("releases").join(format!("v{pin}"));
        let staging = self.dir.path().join("archive-staging");
        // llmlint: ignore-block[e2e_not_mocked] the archived program stands in
        // for the released CLI the way `write_stub_sibling` does: what the recipe
        // is asked to prove is that it installs the archive it verified and asks
        // it its version, which a program answering `--version` is enough to
        // observe, and downloading the real one is what this suite runs without.
        stub_bin::install(
            &staging,
            "onepipeline",
            &format!(
                "#!/usr/bin/env bash\nprintf 'onepipeline {reports}\\n'\nexit \"${{ARCHIVED_EXIT:-0}}\"\n"
            ),
        );
        // llmlint: ignore-end[e2e_not_mocked]
        fs::create_dir_all(&release).expect("the mirror's release directory");
        let archive = release.join(format!("onepipeline-v{pin}-{triple}.tar.gz"));
        let packed = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .arg("onepipeline")
            .output()
            .expect("tar is on PATH");
        assert!(packed.status.success(), "tar: {}", stderr(&packed));
        let digest = match checksum {
            Some(Some(checksum)) => checksum.to_owned(),
            Some(None) => return,
            None => {
                use sha2::Digest;
                let bytes = fs::read(&archive).expect("read the archive");
                sha2::Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect()
            }
        };
        fs::write(
            release.join(format!("onepipeline-v{pin}-{triple}.sha256")),
            format!("{digest}  onepipeline-v{pin}-{triple}.tar.gz\n"),
        )
        .expect("write the published checksum");
    }

    /// Publish `bytes` as this host's archive in the mirror's Release for the
    /// pinned version, with their own digest beside them — a release whose
    /// checksum vouches for whatever it ships.
    #[cfg(unix)]
    fn publish_bytes(&self, bytes: &[u8]) {
        use sha2::Digest;
        let pin = Release::linked().as_str().to_owned();
        let triple = host_triple();
        let release = self.dir.path().join("releases").join(format!("v{pin}"));
        fs::create_dir_all(&release).expect("the mirror's release directory");
        let name = format!("onepipeline-v{pin}-{triple}.tar.gz");
        fs::write(release.join(&name), bytes).expect("write the archive");
        let digest: String = sha2::Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        fs::write(
            release.join(format!("onepipeline-v{pin}-{triple}.sha256")),
            format!("{digest}  {name}\n"),
        )
        .expect("write the published checksum");
    }

    /// This fixture's PATH with `programs` — name and script — in front of it.
    #[cfg(unix)]
    fn path_with(&self, label: &str, programs: &[(&str, &str)]) -> String {
        let dir = self.dir.path().join(label);
        for (name, script) in programs {
            // llmlint: ignore[e2e_not_mocked] each stand-in is the host condition its journey is about — a toolchain that fails, a hasher that cannot run — and PATH is the only place to arrange one on a host that has the real program.
            stub_bin::install(&dir, name, script);
        }
        std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&self.search_path)))
            .expect("join PATH")
            .into_string()
            .expect("a UTF-8 PATH")
    }

    /// What the provisioned path answers to `--version`, or nothing when the
    /// recipe left no program there.
    #[cfg(unix)]
    fn provisioned_version(&self) -> Option<String> {
        let binary = self
            .dir
            .path()
            .join(".tools/bin")
            .join(provisioned_sibling());
        let output = Command::new(&binary).arg("--version").output().ok()?;
        Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn provisioned_path(&self) -> PathBuf {
        self.dir
            .path()
            .join(".tools/bin")
            .join(provisioned_sibling())
    }

    fn stamp_path(&self) -> PathBuf {
        self.dir
            .path()
            .join(".tools/bin")
            .join(format!("{}.source", provisioned_sibling()))
    }

    /// Everything the recipe asked `cargo` for, in order.
    fn calls(&self) -> String {
        fs::read_to_string(self.dir.path().join("cargo-calls")).unwrap_or_default()
    }

    /// Forget what the recipe asked `cargo` for so far, so a journey's next run
    /// is read on its own.
    fn forget_calls(&self) {
        let _ = fs::remove_file(self.dir.path().join("cargo-calls"));
    }
}

/// The file a `cargo install` of the sibling leaves in `.tools/bin`, named the
/// way the platform running this suite names an executable.
///
/// Read from Rust's own executable extension — the one cargo appends to the
/// binary it writes — so this journey derives that name from the platform and
/// the recipe derives it from the platform, separately. A recipe that probed the
/// extensionless name on Windows would find nothing here either, which is the
/// reinstall-every-run these journeys are here to refuse.
fn provisioned_sibling() -> String {
    format!("onepipeline{}", std::env::consts::EXE_SUFFIX)
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Whether this suite runs as root, for whom no file mode refuses a read.
#[cfg(unix)]
fn running_as_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "0")
        .unwrap_or(false)
}

/// This host's target triple as rustc reports it — what the recipe names the
/// archive it fetches by.
#[cfg(unix)]
fn host_triple() -> String {
    let output = Command::new("rustc")
        .arg("-vV")
        .output()
        .expect("rustc is on PATH");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("host: "))
        .expect("rustc names its host")
        .to_owned()
}

/// The install the recipe must ask for, spelled out: the release this build
/// links, from the SDK's own package version rather than a second reading of the
/// lockfile, and into the tree rather than onto the machine.
fn pinned_install() -> String {
    format!(
        "install onepipeline --version {} --locked --force --root .tools --quiet",
        Release::linked().as_str()
    )
}

/// A tree nobody bootstrapped provisions the sibling itself, at the version this
/// tree's lockfile resolves.
///
/// This is the whole reason the recipe is on the gate's path: `just check` in a
/// fresh clone used to fail every journey that starts the read API on a missing
/// binary.
#[test]
fn a_tree_with_no_sibling_provisions_the_pinned_one() {
    let fixture = Fixture::new();
    let output = fixture.run();

    assert!(
        output.status.success(),
        "provisioning a fresh tree failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        pinned_install(),
        "the recipe did not install the release this build links, into the tree"
    );
}

/// The install the recipe must ask for under a git pin: that exact commit,
/// forced past cargo's own record, into the tree.
fn git_install() -> String {
    format!(
        "install onepipeline --git {GIT_REPOSITORY} --rev {GIT_COMMIT} --locked --force --root .tools --quiet"
    )
}

/// A sibling the recipe provisioned is left alone, so the gate pays the version
/// probe and nothing else on every run after the first.
#[test]
fn a_sibling_the_recipe_provisioned_is_not_reinstalled() {
    let fixture = Fixture::new();
    let first = fixture.run();
    assert!(first.status.success(), "{}", stderr(&first));
    fixture.forget_calls();

    let output = fixture.run();

    assert!(
        output.status.success(),
        "a provisioned tree failed the check:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the pinned sibling was reinstalled, so every gate run pays for a build"
    );
}

/// A build copied over one cargo installed is rebuilt, not skipped: cargo's own
/// record still lists the version, and an unforced install would leave the copy
/// at the path for the recipe to stamp as the pinned build.
#[test]
fn a_build_copied_over_a_cargo_install_is_rebuilt() {
    for (fixture, install) in [
        (Fixture::new(), pinned_install()),
        (Fixture::git(), git_install()),
    ] {
        let first = fixture.run();
        assert!(first.status.success(), "{}", stderr(&first));
        let installed = fs::read(fixture.provisioned_path()).expect("the installed build");
        fixture.sibling_in_the_tree(Release::linked().as_str());
        fixture.forget_calls();

        let output = fixture.run();

        assert!(output.status.success(), "{}", stderr(&output));
        assert_eq!(fixture.calls().trim_end(), install);
        assert_eq!(
            fs::read(fixture.provisioned_path()).expect("the provisioned build"),
            installed,
            "the copied build was left at the path, and stamped as the pinned one"
        );
    }
}

/// A build at the pinned version that the recipe did not stamp is replaced rather
/// than used: its `--version` cannot say which source it was built from, and a
/// build of the same version from the other source speaks for an engine this tree
/// does not link.
#[test]
fn an_unstamped_sibling_at_the_pinned_version_is_replaced() {
    for (fixture, install) in [
        (Fixture::new(), pinned_install()),
        (Fixture::git(), git_install()),
    ] {
        fixture.sibling_in_the_tree(Release::linked().as_str());

        let output = fixture.run();

        assert!(output.status.success(), "{}", stderr(&output));
        assert_eq!(
            fixture.calls().trim_end(),
            install,
            "a build nobody stamped was taken for the pinned sibling"
        );
        assert!(
            stderr(&output).contains("is not stamped as built from"),
            "the replacement does not say why:\n{}",
            stderr(&output)
        );
    }
}

/// A sibling at any other release is refused rather than used. It speaks a
/// different telemetry document, and reading one as the other is how a run gets
/// served with no clock at all.
#[test]
fn a_sibling_at_another_release_is_refused_and_replaced() {
    let fixture = Fixture::new();
    fixture.sibling_in_the_tree("0.0.1-stray");

    let output = fixture.run();

    assert!(
        output.status.success(),
        "replacing a stray build failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        pinned_install(),
        "a build at another release was accepted instead of replaced"
    );
}

/// A build on PATH is not the provisioned one, whatever release it reports. The
/// recipe looks at one path and PATH is not it.
#[test]
fn a_sibling_on_path_is_never_taken_for_the_provisioned_one() {
    let fixture = Fixture::new();
    fixture.sibling_on_path(Release::linked().as_str());

    let output = fixture.run();

    assert!(
        output.status.success(),
        "provisioning past a build on PATH failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        pinned_install(),
        "a build on PATH was taken for the provisioned sibling"
    );
}

/// Provisioning that could not happen stops the run and says what is missing,
/// because the alternative is every journey after it failing on a missing file
/// with no reason attached — which is what sent this change.
///
/// Under a git pin it names the commit's source as well, since the version alone
/// names a release that is not what failed to build.
#[test]
fn provisioning_that_fails_says_which_release_could_not_be_installed() {
    for (fixture, source) in [(Fixture::new(), None), (Fixture::git(), Some(git_source()))] {
        let output = fixture.run_with(&[("INSTALL_STATUS", "1")]);

        assert!(
            !output.status.success(),
            "an install that failed reported success"
        );
        let stderr = stderr(&output);
        assert!(
            stderr.contains(Release::linked().as_str())
                && stderr.contains("onepipeline")
                && stderr.contains("ACTION:"),
            "the failure does not name the release that could not be provisioned:\n{stderr}"
        );
        if let Some(source) = source {
            assert!(
                stderr.contains(&source),
                "the failure does not name the source it could not build:\n{stderr}"
            );
        }
    }
}

/// A build the recipe cannot stamp is not provisioned: without the stamp no
/// later run could tell it from a same-version build of another source, so the
/// recipe fails naming the stamp and what to do rather than reporting success.
#[test]
fn a_build_that_cannot_be_stamped_fails_the_recipe() {
    for fixture in [Fixture::new(), Fixture::git()] {
        let output = fixture.run_with(&[("STAMP_BLOCKED", "1")]);

        assert!(
            !output.status.success(),
            "an unstamped build reported success"
        );
        let stderr = stderr(&output);
        assert!(
            stderr.contains("could not write")
                && stderr.contains(".source")
                && stderr.contains("ACTION:"),
            "the failure does not name the stamp and what to do:\n{stderr}"
        );
    }
}

/// A stamp that is not two lines naming a source and a digest — cut short, or
/// overwritten — is no stamp, and the build is provisioned again rather than the
/// recipe failing on it.
#[test]
fn a_malformed_stamp_is_provisioned_over() {
    for (fixture, install) in [
        (Fixture::new(), pinned_install()),
        (Fixture::git(), git_install()),
    ] {
        for stamp in ["", "only a source line\n", "\0\0\0"] {
            let first = fixture.run();
            assert!(first.status.success(), "{}", stderr(&first));
            fs::write(fixture.stamp_path(), stamp).expect("damage the stamp");
            fixture.forget_calls();

            let output = fixture.run();

            assert!(output.status.success(), "{stamp:?}: {}", stderr(&output));
            assert_eq!(fixture.calls().trim_end(), install, "{stamp:?}");
        }
    }
}

/// A host on which nothing can hash the provisioned binary fails the recipe naming
/// both hashers and what to do — when it asks whether a stamped build is still the
/// stamped bytes, and when it stamps a build it just installed — rather than
/// reading the failure as a match or as a stamp.
#[cfg(unix)]
#[test]
fn a_host_that_cannot_hash_the_binary_fails_naming_the_hashers() {
    let no_hashers = [
        (
            "sha256sum",
            "#!/usr/bin/env bash\necho 'no GNU hasher here' >&2\nexit 127\n",
        ),
        (
            "shasum",
            "#!/usr/bin/env bash\necho 'no perl hasher here' >&2\nexit 127\n",
        ),
    ];
    let said = "(sha256sum: no GNU hasher here; shasum: no perl hasher here)";

    // Probing a build an earlier run stamped: nothing is installed over it.
    let stamped = Fixture::git();
    let first = stamped.run();
    assert!(first.status.success(), "{}", stderr(&first));
    stamped.forget_calls();
    let path = stamped.path_with("no-hashers", &no_hashers);
    let probing = stamped.run_with(&[("PATH", &path)]);
    assert!(
        !probing.status.success(),
        "an unhashable build passed its probe"
    );
    assert!(
        stderr(&probing).contains(said) && stderr(&probing).contains("ACTION:"),
        "{}",
        stderr(&probing)
    );
    assert_eq!(
        stamped.calls(),
        "",
        "the recipe reinstalled over a build it could not hash"
    );

    // Stamping a build it just installed: the install happens, the stamp does not.
    for fixture in [Fixture::new(), Fixture::git()] {
        let path = fixture.path_with("no-hashers", &no_hashers);
        let stamping = fixture.run_with(&[("PATH", &path)]);
        assert!(
            !stamping.status.success(),
            "an unhashable build was stamped"
        );
        assert!(
            stderr(&stamping).contains(said) && stderr(&stamping).contains("ACTION:"),
            "{}",
            stderr(&stamping)
        );
        assert!(
            !fixture.stamp_path().is_file(),
            "a stamp was written without a digest"
        );
    }
}

/// A stamp the recipe cannot take away before replacing the build it describes
/// stops the recipe naming it, before anything is installed: the stale stamp would
/// otherwise outlive the build it vouched for.
#[test]
fn a_stamp_that_cannot_be_removed_stops_the_recipe_before_installing() {
    for fixture in [Fixture::new(), Fixture::git()] {
        fixture.sibling_in_the_tree(Release::linked().as_str());
        fs::create_dir_all(fixture.stamp_path().join("held")).expect("a directory at the stamp");

        let output = fixture.run();

        assert!(
            !output.status.success(),
            "the recipe went on past its stamp"
        );
        let stderr = stderr(&output);
        assert!(
            stderr.contains("could not remove")
                && stderr.contains(".source")
                && stderr.contains("ACTION:"),
            "the refusal does not name the stamp and what to do:\n{stderr}"
        );
        assert_eq!(fixture.calls(), "", "the recipe installed past its stamp");
    }
}

/// The package id the recipe reads a git install's source out of is the one a
/// real `cargo install --git` records: `NAME VERSION (git+URL?rev=SHA#SHA)` in
/// the root's `.crates2.json`. The cargo stand-in the other journeys use writes
/// the same id, so this is what holds both to cargo itself.
///
/// Asked of a one-file crate in a local repository, so it compiles in seconds and
/// reaches no network; the URL scheme differs from the https one the recipe
/// accepts, and the shape around it is what the recipe matches.
#[cfg(unix)]
#[test]
fn cargo_records_a_git_install_under_the_id_the_recipe_reads() {
    let scratch = TempDir::new().expect("temp dir");
    let repository = scratch.path().join("probe");
    fs::create_dir_all(repository.join("src")).expect("the probe crate");
    fs::write(
        repository.join("Cargo.toml"),
        "[package]\nname = \"record-probe\"\nversion = \"0.3.7\"\nedition = \"2021\"\n",
    )
    .expect("the probe manifest");
    fs::write(repository.join("src/main.rs"), "fn main() {}\n").expect("the probe source");
    let git = |arguments: &[&str]| {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=probe",
                "-c",
                "user.email=probe@example.invalid",
            ])
            .args(arguments)
            .current_dir(&repository)
            .output()
            .expect("git is on PATH");
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            stderr(&output)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "probe"]);
    let commit = git(&["rev-parse", "HEAD"]);
    let url = format!("file://{}", repository.display());
    let root = scratch.path().join("root");

    let installed = Command::new("cargo")
        .args([
            "install",
            "record-probe",
            "--git",
            &url,
            "--rev",
            &commit,
            "--force",
            "--quiet",
            "--root",
        ])
        .arg(&root)
        .env("CARGO_TARGET_DIR", scratch.path().join("target"))
        .output()
        .expect("cargo is on PATH");
    assert!(
        installed.status.success(),
        "cargo install: {}",
        stderr(&installed)
    );

    let record: Value = serde_json::from_str(
        &fs::read_to_string(root.join(".crates2.json")).expect("cargo's install record"),
    )
    .expect("the record parses");
    let ids: Vec<&String> = record["installs"]
        .as_object()
        .expect("the record lists installs")
        .keys()
        .collect();
    assert_eq!(
        ids,
        [&format!(
            "record-probe 0.3.7 (git+{url}?rev={commit}#{commit})"
        )],
        "cargo records a git install under another id than the recipe reads"
    );
}

/// A Release that publishes this host's archive is installed from it, checked
/// against its published checksum, and nothing is compiled: the archive is the
/// same release the lock pins, and compiling it is the largest single cost of a
/// clean bootstrap.
#[cfg(unix)]
#[test]
fn a_release_archive_for_this_host_is_installed_without_compiling() {
    let fixture = Fixture::new();
    fixture.publish_archive(Release::linked().as_str(), None);

    let output = fixture.run();

    assert!(
        output.status.success(),
        "installing the published archive failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the recipe compiled the CLI although its release publishes an archive"
    );
    assert_eq!(
        fixture.provisioned_version().as_deref(),
        Some(format!("onepipeline {}", Release::linked().as_str()).as_str()),
        "the archive's binary is not the provisioned sibling"
    );
}

/// Under a git pin the CLI is compiled from that exact commit, although a Release
/// of the same version publishes an archive for this host: that release is the
/// build without the commit the lock links. Once provisioned it is left alone,
/// and a build copied over it afterwards is replaced.
#[cfg(unix)]
#[test]
fn a_git_pin_is_compiled_from_its_exact_commit_and_never_fetched() {
    let fixture = Fixture::git();
    fixture.publish_archive(Release::linked().as_str(), None);

    let output = fixture.run();

    assert!(
        output.status.success(),
        "provisioning the pinned commit failed:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls().trim_end(),
        git_install(),
        "the recipe did not compile the commit the lock links"
    );
    assert_eq!(
        fixture.provisioned_version().as_deref(),
        Some(format!("onepipeline {}", Release::linked().as_str()).as_str())
    );

    fixture.forget_calls();
    let again = fixture.run();
    assert!(again.status.success(), "{}", stderr(&again));
    assert_eq!(
        fixture.calls(),
        "",
        "the provisioned commit was rebuilt, so every gate run pays for a build"
    );

    fixture.sibling_in_the_tree(Release::linked().as_str());
    let replaced = fixture.run();
    assert!(replaced.status.success(), "{}", stderr(&replaced));
    assert_eq!(
        fixture.calls().trim_end(),
        git_install(),
        "a build copied over the provisioned one was kept"
    );
}

/// A tree that provisioned a release's archive and then moved its lock to an
/// engine commit of the same version — the start of every fast adoption — has the
/// release build replaced by the commit's, and moving back provisions the release
/// from its archive again without compiling.
#[cfg(unix)]
#[test]
fn a_release_build_of_the_same_version_is_replaced_once_the_lock_links_a_commit() {
    let fixture = Fixture::new();
    fixture.publish_archive(Release::linked().as_str(), None);
    let released = fixture.run();
    assert!(released.status.success(), "{}", stderr(&released));
    assert_eq!(fixture.calls(), "", "the release was compiled, not fetched");

    fixture.pin_source(&git_source());
    let adopted = fixture.run();

    assert!(adopted.status.success(), "{}", stderr(&adopted));
    assert_eq!(
        fixture.calls().trim_end(),
        git_install(),
        "the release build of the same version was taken for the linked commit"
    );
    assert!(
        stderr(&adopted).contains(&format!("is not stamped as built from {}", git_source())),
        "the replacement does not name the source it was held to:\n{}",
        stderr(&adopted)
    );

    fixture.forget_calls();
    fixture.pin_source(REGISTRY);
    let returned = fixture.run();
    assert!(returned.status.success(), "{}", stderr(&returned));
    assert_eq!(
        fixture.calls(),
        "",
        "a registry pin compiled instead of fetching its release's archive"
    );
}

/// A git install is held to cargo's own record of where it installed from: an
/// install cargo records from any other source is refused, and nothing is left
/// where the journeys look.
#[cfg(unix)]
#[test]
fn a_git_install_cargo_records_from_another_source_is_refused() {
    let fixture = Fixture::git();

    let output = fixture.run_with(&[("INSTALL_RECORDS", REGISTRY)]);

    assert!(
        !output.status.success(),
        "an install from another source was accepted"
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains(".crates2.json")
            && stderr.contains(&git_source())
            && stderr.contains("ACTION:"),
        "the refusal does not name the record, the source and what to do:\n{stderr}"
    );
    assert_eq!(
        fixture.provisioned_version(),
        None,
        "the unverified build was left where the journeys look"
    );
}

/// A commit whose binary reports another version than the lock resolves for it is
/// refused rather than stamped.
#[cfg(unix)]
#[test]
fn a_git_install_that_reports_another_version_is_refused() {
    let fixture = Fixture::git();

    let output = fixture.run_with(&[("INSTALL_REPORTS", "0.0.1-stray")]);

    assert!(!output.status.success(), "a stray version was accepted");
    let stderr = stderr(&output);
    assert!(
        stderr.contains("answers 'onepipeline 0.0.1-stray'") && stderr.contains("ACTION:"),
        "the refusal does not say what the binary answered and what to do:\n{stderr}"
    );
    assert_eq!(fixture.provisioned_version(), None);
}

/// An archive that does not match the checksum published beside it is refused,
/// and the recipe neither installs it nor compiles around it: a release that is
/// not what it says it is has to be looked at, not papered over.
#[cfg(unix)]
#[test]
fn an_archive_that_fails_its_checksum_is_refused_and_not_compiled_around() {
    let fixture = Fixture::new();
    fixture.publish_archive(Release::linked().as_str(), Some(Some(&"0".repeat(64))));

    let output = fixture.run();

    assert!(
        !output.status.success(),
        "an archive failing its checksum was accepted"
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("checksum") && stderr.contains("ACTION:"),
        "the refusal does not say the checksum failed and what to do:\n{stderr}"
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the recipe compiled around a bad archive"
    );
    assert_eq!(
        fixture.provisioned_version(),
        None,
        "an unverified archive was installed"
    );
}

/// An archive whose binary reports another release is refused and removed:
/// whatever the file is named, the journeys need the release the lock pins.
#[cfg(unix)]
#[test]
fn an_archive_whose_binary_reports_another_release_is_refused() {
    let fixture = Fixture::new();
    fixture.publish_archive("0.0.1-stray", None);

    let output = fixture.run();

    assert!(
        !output.status.success(),
        "an archive of another release was accepted"
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains("0.0.1-stray") && stderr.contains(Release::linked().as_str()),
        "the refusal does not name both releases:\n{stderr}"
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the recipe compiled around a mislabelled archive"
    );
    assert_eq!(
        fixture.provisioned_version(),
        None,
        "the mislabelled binary was left where the journeys look"
    );
}

/// A release that publishes this host's archive with no checksum beside it is
/// refused: nothing unverified is installed, and nothing is compiled around it.
#[cfg(unix)]
#[test]
fn an_archive_published_without_its_checksum_is_refused_and_not_compiled_around() {
    let fixture = Fixture::new();
    fixture.publish_archive(Release::linked().as_str(), Some(None));

    let output = fixture.run();

    assert!(
        !output.status.success(),
        "an archive with no checksum was accepted"
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains(".sha256") && stderr.contains("ACTION:"),
        "the refusal does not name the missing checksum and what to do:\n{stderr}"
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the recipe compiled around an unverifiable archive"
    );
    assert_eq!(
        fixture.provisioned_version(),
        None,
        "an unverified archive was installed"
    );
}

/// Where GNU's `sha256sum` cannot run — macOS ships `shasum` instead — the
/// archive is checked with `shasum`, and still installed only when it matches.
#[cfg(unix)]
#[test]
fn the_checksum_is_read_with_shasum_where_sha256sum_cannot_run() {
    let fixture = Fixture::new();
    fixture.publish_archive(Release::linked().as_str(), None);
    let path = fixture.path_with(
        "no-sha256sum",
        &[("sha256sum", "#!/usr/bin/env bash\nexit 127\n")],
    );

    let output = fixture.run_with(&[("PATH", &path)]);

    assert!(
        output.status.success(),
        "the archive was not installed with shasum:\n{}",
        stderr(&output)
    );
    assert_eq!(
        fixture.calls(),
        "",
        "the recipe compiled although the archive verified"
    );
    assert_eq!(
        fixture.provisioned_version().as_deref(),
        Some(format!("onepipeline {}", Release::linked().as_str()).as_str())
    );
}

/// A compiled sibling is held to the same version probe an archive is: a
/// `cargo install` that leaves something reporting another release fails the
/// recipe instead of reporting success.
#[test]
fn a_compiled_sibling_that_reports_another_release_is_refused() {
    let fixture = Fixture::new();
    let output = fixture.run_with(&[("INSTALL_REPORTS", "0.0.1-stray")]);

    assert!(
        !output.status.success(),
        "a compiled stray release was accepted"
    );
    let stderr = stderr(&output);
    assert!(
        stderr.contains(Release::linked().as_str()) && stderr.contains("ACTION:"),
        "the refusal does not name the pinned release and what to do:\n{stderr}"
    );
    assert!(
        stderr.contains("answers 'onepipeline 0.0.1-stray'"),
        "the refusal does not say what the compiled binary answered:\n{stderr}"
    );
}

/// A binary that prints the pinned version and then fails is not the pinned
/// sibling: the probe reads the exit as well as the words.
#[cfg(unix)]
#[test]
fn an_archived_binary_that_fails_its_version_probe_is_refused() {
    let fixture = Fixture::new();
    fixture.publish_archive(Release::linked().as_str(), None);

    let output = fixture.run_with(&[("ARCHIVED_EXIT", "1")]);

    assert!(
        !output.status.success(),
        "a binary whose --version failed was accepted:\n{}",
        stderr(&output)
    );
    assert!(stderr(&output).contains("ACTION:"), "{}", stderr(&output));
    assert_eq!(
        fixture.calls(),
        "",
        "the recipe compiled around the failing binary"
    );
    assert!(
        !fixture
            .dir
            .path()
            .join(".tools/bin")
            .join(provisioned_sibling())
            .exists(),
        "the failing binary was left where the journeys look"
    );
}

/// Every way the recipe can be unable to provision fails it with a sentence and
/// an `ACTION:`, installs nothing, and compiles nothing around the refusal.
#[cfg(unix)]
#[test]
fn every_refusal_names_what_to_do_and_compiles_nothing() {
    type Arrange = fn(&Fixture) -> Vec<(String, String)>;
    let cases: [(&str, Arrange, &str); 10] = [
        (
            "a mirror whose archive cannot be read",
            |f| {
                use std::os::unix::fs::PermissionsExt;
                f.publish_archive(Release::linked().as_str(), None);
                let pin = Release::linked().as_str().to_owned();
                let archive = f
                    .dir
                    .path()
                    .join("releases")
                    .join(format!("v{pin}"))
                    .join(format!("onepipeline-v{pin}-{}.tar.gz", host_triple()));
                fs::set_permissions(&archive, fs::Permissions::from_mode(0o000))
                    .expect("make the archive unreadable");
                Vec::new()
            },
            "could not copy",
        ),
        (
            "a mirror directory that is not there",
            |f| {
                vec![(
                    "ONEPIPELINE_UI_SIBLING_RELEASES".into(),
                    f.dir.path().join("no-mirror").display().to_string(),
                )]
            },
            "is not a readable directory",
        ),
        (
            "a release source that is neither https nor a directory",
            |_| {
                vec![(
                    "ONEPIPELINE_UI_SIBLING_RELEASES".into(),
                    "ftp://example.invalid".into(),
                )]
            },
            "neither an https URL nor a directory",
        ),
        (
            "rustc that cannot run",
            |f| {
                vec![(
                    "PATH".into(),
                    f.path_with(
                        "rustc-fails",
                        &[("rustc", "#!/usr/bin/env bash\necho broken >&2\nexit 1\n")],
                    ),
                )]
            },
            "rustc -vV failed",
        ),
        (
            "rustc that names no host",
            |f| {
                vec![(
                    "PATH".into(),
                    f.path_with(
                        "rustc-hostless",
                        &[("rustc", "#!/usr/bin/env bash\necho 'rustc 1.0.0'\n")],
                    ),
                )]
            },
            "named no host triple",
        ),
        (
            "no temporary storage",
            |f| {
                vec![(
                    "TMPDIR".into(),
                    f.dir.path().join("no-such-dir").display().to_string(),
                )]
            },
            "temporary storage",
        ),
        (
            "an archive that is not one, though its checksum matches",
            |f| {
                f.publish_bytes(b"not a gzip stream");
                Vec::new()
            },
            "could not unpack",
        ),
        (
            "an archive without the CLI in it",
            |f| {
                let staging = f.dir.path().join("wrong-member");
                fs::create_dir_all(&staging).expect("staging");
                fs::write(staging.join("README.md"), "no binary here").expect("member");
                let packed = Command::new("tar")
                    .arg("-czf")
                    .arg(f.dir.path().join("wrong.tar.gz"))
                    .arg("-C")
                    .arg(&staging)
                    .arg("README.md")
                    .output()
                    .expect("tar is on PATH");
                assert!(packed.status.success(), "tar: {}", stderr(&packed));
                f.publish_bytes(&fs::read(f.dir.path().join("wrong.tar.gz")).expect("archive"));
                Vec::new()
            },
            "lacks onepipeline",
        ),
        (
            "no hasher that runs",
            |f| {
                f.publish_archive(Release::linked().as_str(), None);
                let path = f.path_with(
                    "no-hashers",
                    &[
                        (
                            "sha256sum",
                            "#!/usr/bin/env bash\necho 'no GNU hasher here' >&2\nexit 127\n",
                        ),
                        (
                            "shasum",
                            "#!/usr/bin/env bash\necho 'no perl hasher here' >&2\nexit 127\n",
                        ),
                    ],
                );
                vec![("PATH".into(), path)]
            },
            // What each hasher said, not only that both failed.
            "(sha256sum: no GNU hasher here; shasum: no perl hasher here)",
        ),
        (
            "a destination that cannot be written",
            |f| {
                f.publish_archive(Release::linked().as_str(), None);
                fs::create_dir_all(f.dir.path().join(".tools")).expect(".tools");
                fs::write(
                    f.dir.path().join(".tools/bin"),
                    "a file where the directory goes",
                )
                .expect("block the destination");
                Vec::new()
            },
            "could not install",
        ),
    ];
    for (what, arrange, says) in cases {
        // macOS's `mktemp` falls back to /tmp when TMPDIR names nothing, so
        // that refusal is only reachable on Linux.
        if what == "no temporary storage" && !cfg!(target_os = "linux") {
            continue;
        }
        // Root reads a file whatever its mode, so an unreadable mirror cannot
        // be arranged for it.
        if what == "a mirror whose archive cannot be read" && running_as_root() {
            continue;
        }
        let fixture = Fixture::new();
        let environment = arrange(&fixture);
        let pairs: Vec<(&str, &str)> = environment
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let output = fixture.run_with(&pairs);
        let stderr = stderr(&output);
        assert!(
            !output.status.success(),
            "{what}: the recipe succeeded:\n{stderr}"
        );
        assert!(
            stderr.contains(says) && stderr.contains("ACTION:"),
            "{what}: the refusal does not say `{says}` and what to do:\n{stderr}"
        );
        assert_eq!(
            fixture.calls(),
            "",
            "{what}: the recipe compiled around the refusal"
        );
        assert_eq!(
            fixture.provisioned_version(),
            None,
            "{what}: something was installed"
        );
    }
}

/// A call the recipe would never make is refused as a usage error, before
/// anything is fetched. Unix only, as the archive journeys are: the script is
/// called by its own `bash` here, which on Windows is not the shell the recipe
/// runs under.
#[cfg(unix)]
#[test]
fn a_malformed_call_is_refused_as_usage() {
    let fixture = Fixture::new();
    let bin = ".tools/bin/onepipeline";
    let short = format!("git+{GIT_REPOSITORY}?rev=f06d041#{GIT_COMMIT}");
    let branch = format!("git+{GIT_REPOSITORY}?branch=main#{GIT_COMMIT}");
    let unpinned = format!("git+{GIT_REPOSITORY}#{GIT_COMMIT}");
    let elsewhere = format!("git+{GIT_REPOSITORY}?rev={GIT_COMMIT}#{}", "0".repeat(40));
    let plain = format!("git+http://example.invalid/onepipeline?rev={GIT_COMMIT}#{GIT_COMMIT}");
    for (arguments, binary) in [
        (&[][..], bin),
        (&["not-a-version", REGISTRY][..], bin),
        // One good line is not a good version: the rest would reach the URL.
        (&["1.2.3\n../../elsewhere", REGISTRY][..], bin),
        // The source is required: the version alone cannot name the build.
        (&["1.2.3"][..], bin),
        // A third argument is refused as usage rather than ignored.
        (&["1.2.3", REGISTRY, "--unknown"][..], bin),
        (&["1.2.3", REGISTRY][..], ""),
        // A source this script cannot provision exactly: another registry, a
        // path, and git sources that name no one full commit — a short rev, a
        // branch, none at all, a resolved commit other than the rev — or that
        // would be fetched over plain http.
        (&["1.2.3", "sparse+https://example.invalid/index/"][..], bin),
        (&["1.2.3", "path+file:///elsewhere"][..], bin),
        (&["1.2.3", short.as_str()][..], bin),
        (&["1.2.3", branch.as_str()][..], bin),
        (&["1.2.3", unpinned.as_str()][..], bin),
        (&["1.2.3", elsewhere.as_str()][..], bin),
        (&["1.2.3", plain.as_str()][..], bin),
    ] {
        let output = Command::new("bash")
            .arg("scripts/ensure-sibling.sh")
            .args(arguments)
            .current_dir(fixture.dir.path())
            .env("ONEPIPELINE_UI_ONEPIPELINE_BIN", binary)
            .output()
            .expect("bash is on PATH");
        assert_eq!(
            output.status.code(),
            Some(2),
            "{arguments:?} was not refused as usage"
        );
        assert!(
            stderr(&output).contains("ACTION:"),
            "{arguments:?}: {}",
            stderr(&output)
        );
    }
}

/// Every suite that starts the read API reaches the provisioning through Nx's
/// own task graph.
///
/// Asked of Nx rather than of the files it reads, because a `dependsOn` naming
/// another project is resolved rather than copied: an entry Nx does not
/// understand is dropped silently, and the tier goes back to failing in a clean
/// clone with the configuration still looking correct.
#[test]
fn every_suite_that_starts_the_read_api_provisions_the_sibling_first() {
    // Through `just nx`, this workspace's one way in to Nx, rather than either
    // hand-rolled equivalent: `scripts/nx.sh` is a `.sh` file, which is not a
    // program on Windows, and a bare `bash` is not the shell there either — the
    // system directory outranks PATH, and the `bash` in it is a Windows
    // Subsystem for Linux launcher with nothing installed behind it.
    //
    // Answered onto stdout rather than into a file the journey names: a recipe
    // pastes its arguments into a shell line, and a Windows temporary directory
    // is separated by backslashes, which that line would spend as escapes — so
    // Nx would write the graph somewhere nobody is reading and exit happily.
    // `--graph=stdout` is the same document with no path to lose.
    let output = Command::new("just")
        .args(["nx", "run-many", "-t", TIERS, "--graph=stdout"])
        .current_dir(repo_root())
        .output()
        .expect("just is on PATH");
    assert!(
        output.status.success(),
        "Nx could not build the task graph for `{TIERS}` ({}):\n{}{}",
        output.status,
        stderr(&output),
        String::from_utf8_lossy(&output.stdout)
    );

    let dependencies = task_dependencies(&output.stdout);
    for suite in SUITES_THAT_START_THE_READ_API {
        assert!(
            dependencies.contains_key(suite),
            "{suite} is not in the graph `{TIERS}` runs; the list here names a \
             project that no longer has that test target"
        );
        assert!(
            reaches(&dependencies, suite, PROVISIONING),
            "{suite} starts the read API and does not depend on {PROVISIONING}, so \
             it fails in a tree nobody bootstrapped"
        );
    }
    assert_eq!(
        dependencies
            .keys()
            .filter(|task| *task == PROVISIONING)
            .count(),
        1,
        "the provisioning is more than one task, so two of them can install into \
         `.tools/` at once"
    );
}

/// Every task that compiles the read API for a suite builds the view first,
/// through the same graph.
///
/// The same question as above, asked of the other thing a clean clone lacks:
/// `build.rs` embeds whatever `apps/dag-ui/dist` holds when the binary is
/// compiled, and only Nx's own resolution of the edge says whether the build
/// that fills it runs first.
#[test]
fn every_suite_that_compiles_the_read_api_builds_the_view_first() {
    let output = Command::new("just")
        .args(["nx", "run-many", "-t", COMPILING_TIERS, "--graph=stdout"])
        .current_dir(repo_root())
        .output()
        .expect("just is on PATH");
    assert!(
        output.status.success(),
        "Nx could not build the task graph for `{COMPILING_TIERS}` ({}):\n{}{}",
        output.status,
        stderr(&output),
        String::from_utf8_lossy(&output.stdout)
    );
    let dependencies = task_dependencies(&output.stdout);
    for task in TASKS_THAT_COMPILE_THE_READ_API {
        assert!(
            dependencies.contains_key(task),
            "{task} is not in the graph `{COMPILING_TIERS}` runs; the list here names a task \
             nothing reaches any more"
        );
        assert!(
            reaches(&dependencies, task, VIEW_BUILD),
            "{task} compiles the read API and does not depend on {VIEW_BUILD}, so the \
             binary it compiles in a clean clone embeds no browser view"
        );
    }
}

/// `check-cross` reaches cargo only through the graph above.
///
/// The cross-platform legs run that recipe rather than the Linux tiers, and the
/// suite it runs is the same binary those tiers compile — so it needs the view
/// built first and the sibling provisioned just as they do. It gets both by
/// running `test-quick` through Nx, whose edges the two tests above hold; a step
/// of its own that drove cargo directly would have no such edge, and the leg
/// would pass having proved the `ui::` journeys against a binary carrying nothing.
///
/// Asked of `just` rather than of the justfile's text, because what a recipe
/// runs and in what order is `just`'s own resolution of its dependencies and
/// not something a reading of the file can settle. `--dry-run` prints those
/// lines, to stderr, and runs none of them.
#[test]
fn check_cross_reaches_the_suite_only_through_the_graph() {
    let output = Command::new("just")
        .args(["--dry-run", "check-cross"])
        .current_dir(repo_root())
        .output()
        .expect("just is on PATH");
    assert!(
        output.status.success(),
        "`just --dry-run check-cross` failed ({}):\n{}",
        output.status,
        stderr(&output)
    );
    // `--dry-run` prints the recipe to stderr and leaves stdout to the recipe,
    // which runs nothing here.
    let planned = stderr(&output);
    assert!(
        planned.contains("run-many -t test-quick"),
        "check-cross no longer runs the suite's `test-quick` targets:\n{planned}"
    );
    assert!(
        !planned.contains("cargo "),
        "check-cross drives cargo outside the graph, where no edge builds the view or \
         provisions the sibling first:\n{planned}"
    );
}

/// The graph's `task -> its dependencies` edges, as Nx answered them.
fn task_dependencies(graph: &[u8]) -> BTreeMap<String, Vec<String>> {
    let document: Value =
        serde_json::from_slice(graph).expect("Nx answered with the graph as JSON");
    document["tasks"]["dependencies"]
        .as_object()
        .expect("the graph names each task's dependencies")
        .iter()
        .map(|(task, dependencies)| {
            let edges = dependencies
                .as_array()
                .expect("a task's dependencies are a list")
                .iter()
                .map(|edge| edge.as_str().expect("a task name").to_owned())
                .collect();
            (task.clone(), edges)
        })
        .collect()
}

/// Whether `target` is reachable from `from` along those edges, so a dependency
/// declared one hop away counts as much as a direct one.
fn reaches(dependencies: &BTreeMap<String, Vec<String>>, from: &str, target: &str) -> bool {
    let mut seen = BTreeSet::new();
    let mut pending = vec![from.to_owned()];
    while let Some(task) = pending.pop() {
        if task == target {
            return true;
        }
        if !seen.insert(task.clone()) {
            continue;
        }
        pending.extend(dependencies.get(&task).into_iter().flatten().cloned());
    }
    false
}
