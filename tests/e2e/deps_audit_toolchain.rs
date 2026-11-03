//! `scripts/deps-audit.mjs` under a toolchain rustup has not installed yet: the
//! `advisories` job's case on `main`, whose first `cargo` call installed the
//! toolchain rust-toolchain.toml pins and printed rustup's progress on the
//! stderr cargo-deny writes its records to.
//!
//! Rustup is not stood in for. Each journey runs the real rustup proxy under a
//! `RUSTUP_HOME` of its own, against a `file://` distribution server: one built
//! from the components of the toolchain this suite runs under, so the
//! installation is real and so is its output, and an empty one where nothing may
//! be installed. Nothing is fetched from the network. The fixture repositories,
//! advisory database and recipe are `deps_audit`'s, shared with it.
//!
//! A tier of its own (`onepipeline-ui-deps-audit-toolchain`): the installation
//! packs and unpacks a toolchain, so only a change to what it reads runs it.
//! Linux only, as `deps_audit` is.
#![cfg(target_os = "linux")]

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::deps_audit::{project, run_in, Project, Run, CLEAN, ROOT, VULN, VULNERABLE};

/// Builds a rustup distribution server at `MIRROR` serving one toolchain,
/// `VERSION` for `TARGET`, in its minimal profile cut to what `cargo metadata`
/// needs: the `rustc` and `cargo` components, each a zstd rust-installer tarball
/// of the files the installed toolchain at `SYSROOT` records for it.
const RUSTUP_MIRROR: &str = r#"set -euo pipefail
sysroot="$1" mirror="$2" version="$3" target="$4"
dist="$mirror/dist"
mkdir -p "$dist/pkgs"
manifest="$dist/channel-rust-$version.toml"
printf 'manifest-version = "2"\ndate = "2026-07-16"\n' > "$manifest"
for comp in rustc cargo; do
  name="$comp-$version-$target"
  root="$mirror/work/$name"
  mkdir -p "$root/$comp"
  echo 3 > "$root/rust-installer-version"
  echo "$comp" > "$root/components"
  grep -E '^file:(bin/(rustc|cargo)$|lib/[^/]+\.so|lib/libLLVM)' \
    "$sysroot/lib/rustlib/manifest-$comp-$target" > "$root/$comp/manifest.in"
  while IFS= read -r entry; do
    file="${entry#file:}"
    mkdir -p "$root/$comp/$(dirname "$file")"
    cp -L "$sysroot/$file" "$root/$comp/$file"
  done < "$root/$comp/manifest.in"
  tar -C "$mirror/work" -cf - "$name" | zstd -q -1 -T0 > "$dist/pkgs/$name.tar.zst"
  rm -rf "$root"
  hash="$(sha256sum "$dist/pkgs/$name.tar.zst" | cut -d' ' -f1)"
  printf '\n[pkg.%s]\nversion = "%s"\n\n[pkg.%s.target.%s]\navailable = true\nzst_url = "file://%s"\nzst_hash = "%s"\ncomponents = []\nextensions = []\n' \
    "$comp" "$version" "$comp" "$target" "$dist/pkgs/$name.tar.zst" "$hash" >> "$manifest"
done
printf '\n[pkg.rust]\nversion = "%s"\n\n[pkg.rust.target.%s]\navailable = true\n' "$version" "$target" >> "$manifest"
for comp in rustc cargo; do
  printf '\n[[pkg.rust.target.%s.components]]\npkg = "%s"\ntarget = "%s"\nis_extension = false\n' \
    "$target" "$comp" "$target" >> "$manifest"
done
printf '\n[profiles]\nminimal = ["rustc", "cargo"]\n\n[renames]\n' >> "$manifest"
(cd "$dist" && sha256sum "channel-rust-$version.toml" > "channel-rust-$version.toml.sha256")
"#;

/// `rustc`'s answer to `args`, as the toolchain this suite runs under gives it.
fn host_rustc(args: &[&str]) -> String {
    let output = Command::new("rustc")
        .args(args)
        .current_dir(ROOT)
        .output()
        .expect("run rustc");
    assert!(output.status.success(), "rustc {args:?} failed");
    String::from_utf8(output.stdout)
        .expect("rustc prints UTF-8")
        .trim()
        .to_owned()
}

/// The real rustup proxy, a distribution server of the journey's own, and a
/// `RUSTUP_HOME` per report that starts with no toolchain.
struct Rustup {
    proxies: PathBuf,
    mirror: PathBuf,
    version: String,
    scratch: PathBuf,
}

impl Rustup {
    /// The proxy and a distribution server under `project`'s scratch directory:
    /// one serving the toolchain this suite runs under when `serve`, an empty
    /// one otherwise, so nothing is ever fetched from the network.
    fn new(project: &Project, serve: bool) -> Self {
        let rustup = Command::new("sh")
            .args(["-c", "command -v rustup"])
            .output()
            .expect("look rustup up");
        let rustup = PathBuf::from(
            String::from_utf8(rustup.stdout)
                .expect("a UTF-8 path")
                .trim(),
        );
        assert!(
            rustup.is_file(),
            "these journeys run the real rustup proxy, and no rustup is on PATH"
        );
        let proxies = rustup
            .parent()
            .expect("rustup is in a directory")
            .to_owned();
        assert!(
            proxies.join("cargo").is_file(),
            "no rustup `cargo` proxy beside {}",
            rustup.display()
        );
        let version = host_rustc(&["--version"])
            .split_whitespace()
            .nth(1)
            .expect("rustc names its version")
            .to_owned();
        let scratch = project.repo.parent().expect("a scratch parent").to_owned();
        let mirror = scratch.join("rustup-mirror");
        fs::create_dir_all(mirror.join("dist")).expect("create the distribution server");
        if serve {
            let target = host_rustc(&["-vV"])
                .lines()
                .find_map(|line| line.strip_prefix("host: ").map(str::to_owned))
                .expect("rustc names its host");
            let built = Command::new("bash")
                .args(["-c", RUSTUP_MIRROR, "rustup-mirror"])
                .arg(host_rustc(&["--print", "sysroot"]))
                .arg(&mirror)
                .args([version.as_str(), target.as_str()])
                .output()
                .expect("run bash");
            assert!(
                built.status.success(),
                "could not build the distribution server: {}",
                String::from_utf8_lossy(&built.stderr)
            );
        }
        let rustup = Self {
            proxies,
            mirror,
            version,
            scratch,
        };
        rustup.pin(project);
        rustup
    }

    /// Pin `project`'s checkout to the served toolchain, as this repository's
    /// rust-toolchain.toml pins its own.
    fn pin(&self, project: &Project) {
        fs::write(
            project.repo.join("rust-toolchain.toml"),
            format!(
                "[toolchain]\nchannel = \"{}\"\nprofile = \"minimal\"\n",
                self.version
            ),
        )
        .expect("write rust-toolchain.toml");
    }

    /// `just advisories-report` under the real proxy and the empty
    /// `RUSTUP_HOME` named `home`, with rustup's own `extra` variables.
    fn report(&self, project: &Project, home: &str, extra: &[(&str, &OsStr)]) -> Run {
        let rustup_home = self.scratch.join(home);
        let mut path = vec![self.proxies.clone()];
        path.extend(std::env::split_paths(
            &std::env::var_os("PATH").expect("PATH is set"),
        ));
        let path = std::env::join_paths(path).expect("join PATH");
        let server = format!("file://{}", self.mirror.display());
        let no_updates = format!("file://{}", self.scratch.join("no-updates").display());
        let mut command = Command::new("just");
        command
            .arg("--justfile")
            .arg(Path::new(ROOT).join("justfile"))
            .arg("--working-directory")
            .arg(&project.repo)
            .arg("advisories-report");
        // What the proxy that started this suite exported for its own toolchain,
        // which would choose one for the journey's proxy too.
        for variable in ["RUSTUP_TOOLCHAIN", "CARGO", "RUSTC", "RUSTDOC"] {
            command.env_remove(variable);
        }
        let mut env: Vec<(&str, &OsStr)> = vec![
            ("PATH", path.as_os_str()),
            ("RUSTUP_HOME", rustup_home.as_os_str()),
            ("RUSTUP_DIST_SERVER", OsStr::new(&server)),
            ("RUSTUP_UPDATE_ROOT", OsStr::new(&no_updates)),
        ];
        env.extend_from_slice(extra);
        run_in(project, command, &env)
    }
}

#[test]
fn a_toolchain_installed_on_first_use_is_not_read_as_cargo_denys_output() {
    // The report is the half that calls cargo-deny's advisories check first,
    // which is where the `advisories` job's rustup installed the toolchain.
    let clean = project(&CLEAN, &CLEAN);
    let rustup = Rustup::new(&clean, true);
    let run = rustup.report(&clean, "rustup-home", &[]);
    assert_eq!(
        run.code,
        Some(0),
        "installing the toolchain failed a report with nothing to report:\n{}",
        run.all()
    );
    assert!(
        run.stderr.contains(&format!(
            "info: syncing channel updates for {}",
            rustup.version
        )) && run.stderr.contains("info: downloading 2 components"),
        "rustup did not install the toolchain on first use:\n{}",
        run.all()
    );
    assert!(
        run.stdout
            .contains("no advisory matches the resolved graph"),
        "the report did not reach its verdict:\n{}",
        run.all()
    );

    // A red report still means an advisory: the one it reads after the
    // installation, and nothing about the installation itself.
    let vulnerable = project(&VULNERABLE, &VULNERABLE);
    rustup.pin(&vulnerable);
    let run = rustup.report(&vulnerable, "rustup-home-vulnerable", &[]);
    assert_ne!(run.code, Some(0), "the report passed:\n{}", run.all());
    assert!(
        run.stderr.contains("info: downloading 2 components")
            && run.stderr.contains(&format!("advisory {VULN}"))
            && !run.stderr.contains("unparseable output")
            && !run
                .stderr
                .contains("ACTION: fix the cargo-deny error above"),
        "the report did not fail on the advisory alone:\n{}",
        run.all()
    );
}

#[test]
fn a_toolchain_rustup_will_not_install_fails_the_check_saying_so() {
    // With auto-install off, the pinned toolchain is never installed, and the
    // server serves nothing for a fallback to fetch: the check did not run,
    // which is never an empty graph.
    let clean = project(&CLEAN, &CLEAN);
    let rustup = Rustup::new(&clean, false);
    let run = rustup.report(
        &clean,
        "rustup-home",
        &[("RUSTUP_AUTO_INSTALL", OsStr::new("0"))],
    );
    assert_ne!(run.code, Some(0), "the report passed:\n{}", run.all());
    assert!(
        run.stderr
            .contains(&format!("error: toolchain '{}-", rustup.version))
            && run.stderr.contains("is not installed")
            && run
                .stderr
                .contains("'cargo --version' exited 1 resolving the toolchain")
            && run
                .stderr
                .contains("ACTION: fix the cargo-deny error above")
            && !run.stdout.contains("no advisory matches"),
        "the report did not say the toolchain could not be resolved:\n{}",
        run.all()
    );
}
