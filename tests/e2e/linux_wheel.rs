//! `scripts/build-linux-wheel.sh`, driven as `just wheel-linux` drives it.
//!
//! `docker` and the image's tools are stand-ins on PATH, because the real build
//! is minutes of network-bound compile inside a manylinux image — which ci.yml's
//! `wheel` legs run for real on every pull request that reaches the crate, and
//! then install and smoke-test. Everything above that boundary is real: the
//! recipe, the script, and the in-container script it hands the image, run by
//! bash from the checkout with the environment the script gave it. The two
//! workflows are read rather than restated, so the targets and the maturin they
//! name cannot drift from what the script builds.
//!
//! llmlint: ignore-file[e2e_not_mocked] the real `docker run` of this script is a
//! manylinux image compiling the whole release binary — four to nine minutes of
//! network-bound build per target — which an offline, quick suite cannot drive.
//! It is driven for real instead by ci.yml's `wheel` legs on every pull request
//! that reaches the crate, which build both targets through this same recipe and
//! then install and smoke-test the wheel. Here only `docker` and the image's own
//! tools are stand-ins on PATH; the recipe, the script and the in-container
//! script it hands the image are the real ones, run by bash with the environment
//! the script gave the container. `docker_double` and `container_double` are the
//! whole of that substitution, and every journey below rests on one of them.
//!
//! llmlint: ignore-file[tests_mirror_real_usage] what this script does is ask a
//! container runtime to run a build: which image, on which platform, with which
//! prerequisites and which maturin invocation. With the runtime stood in for,
//! that request — recorded by the stand-ins — is the only place those facts can
//! be read, and they are the facts v0.16.0 got wrong (no Perl modules for
//! OpenSSL's `Configure`). Every journey still drives the user's command, `just
//! wheel-linux`, and asserts on its exit code and its stderr; the recordings are
//! read beside them, never instead. The observable outcome — a wheel that
//! installs and runs — is asserted by ci.yml's `wheel` legs against the real image.

#![cfg(target_os = "linux")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A scratch directory under the checkout's ignored `target/`, because `--out`
/// must resolve inside the checkout.
fn scratch(name: &str) -> (Scratch, PathBuf) {
    let dir = repo_root()
        .join("target")
        .join(format!("linux-wheel-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("bin")).expect("the scratch directory is created");
    (Scratch(dir.clone()), dir)
}

fn executable(path: &Path, body: String) {
    fs::write(path, body).expect("the stand-in is written");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .expect("the stand-in is made executable");
}

/// The channel the script reads, from the same file it reads it from.
fn channel() -> String {
    fs::read_to_string(repo_root().join("rust-toolchain.toml"))
        .expect("rust-toolchain.toml is readable")
        .lines()
        .find_map(|line| {
            line.strip_prefix("channel = \"")?
                .strip_suffix('"')
                .map(str::to_string)
        })
        .expect("rust-toolchain.toml pins a channel")
}

/// A `docker` that records its arguments to `docker.log` and exits `status`.
fn docker_double(dir: &Path, status: i32) {
    executable(
        &dir.join("bin/docker"),
        format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > '{}'\nexit {status}\n",
            dir.join("docker.log").display()
        ),
    );
}

/// A `docker` that records its arguments as [`docker_double`] does, then runs the
/// build's in-container script as the image would — from the mounted checkout,
/// with the `-e` environment it was given — except that the image's tools are
/// stand-ins that record each call to `container.log` and succeed, bar the one
/// whose call begins with `fail_at`, which exits 1. Nothing on the host's PATH is
/// reachable from it, so no real `rustup` or `yum` can answer instead.
fn container_double(dir: &Path, fail_at: Option<&str>) {
    let bash = which("bash");
    let bash = bash.display();
    let fail_at = fail_at.unwrap_or("no call begins with this");
    let log = dir.join("container.log");
    let log = log.display();
    fs::create_dir_all(dir.join("container-bin")).expect("the image's tool directory");
    fs::create_dir_all(dir.join("home")).expect("the image's home directory");
    let record = |tool: &str| {
        format!(
            "#!{bash}\ncall=\"{tool} $*\"\nprintf '%s\\n' \"$call\" >> '{log}'\n\
             [[ \"$call\" != '{fail_at}'* ]] || exit 1\n"
        )
    };
    for tool in ["yum", "chmod", "rustup", "python3.12", "chown"] {
        executable(&dir.join("container-bin").join(tool), record(tool));
    }
    // The script pipes the pinned checksum into `sha256sum -c -` under
    // pipefail, so a stand-in that exits without reading it can kill the `echo`
    // with SIGPIPE and fail a step no test asked to fail. This one drains its
    // stdin through the host's `cat` before anything else, even when it is the
    // call that fails.
    let cat = which("cat");
    executable(
        &dir.join("container-bin/sha256sum"),
        record("sha256sum").replacen('\n', &format!("\n'{}' > /dev/null\n", cat.display()), 1),
    );
    // What `curl -o` downloads is the installer the script then runs, so this
    // one also leaves a recording `rustup-init` where it was asked to write.
    let chmod = which("chmod");
    let chmod = chmod.display();
    executable(
        &dir.join("container-bin/curl"),
        format!(
            "{}while [ $# -gt 0 ]; do [ \"$1\" != -o ] || out=\"$2\"; shift; done\n\
             read -r -d '' stub <<'STUB' || true\n{}\nSTUB\n\
             printf '%s\\n' \"$stub\" > \"$out\"\n'{chmod}' +x \"$out\"\n",
            record("curl"),
            record("rustup-init").trim_end()
        ),
    );
    executable(
        &dir.join("bin/docker"),
        format!(
            "#!{bash}\nprintf '%s\\n' \"$@\" > '{docker_log}'\nenvs=()\n\
             while [ $# -gt 0 ]; do\n  case \"$1\" in\n\
             -e) envs+=(\"$2\"); shift 2 ;;\n\
             -v) [[ \"$2\" != *:/io:ro ]] || mount=\"${{2%%:*}}\"; shift 2 ;;\n\
             -c) script=\"$2\"; shift 2 ;;\n\
             *) shift ;;\n  esac\ndone\ncd \"$mount\"\n\
             exec env -i HOME='{home}' PATH='{bin}' \"${{envs[@]}}\" '{bash}' -euo pipefail -c \"$script\"\n",
            docker_log = dir.join("docker.log").display(),
            home = dir.join("home").display(),
            bin = dir.join("container-bin").display(),
        ),
    );
}

fn which(tool: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("the host has a PATH"))
        .map(|candidate| candidate.join(tool))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("{tool} is on this host's PATH"))
}

fn container_calls(dir: &Path) -> Vec<String> {
    fs::read_to_string(dir.join("container.log"))
        .expect("the container ran its tools")
        .lines()
        .map(str::to_string)
        .collect()
}

fn host_owner() -> String {
    let id = |flag: &str| {
        let output = Command::new("id").arg(flag).output().expect("id runs");
        String::from_utf8(output.stdout)
            .expect("id prints text")
            .trim()
            .to_string()
    };
    format!("{}:{}", id("-u"), id("-g"))
}

fn run(dir: &Path, path: &std::ffi::OsStr, args: &[&str]) -> Output {
    let output = Command::new("just")
        .current_dir(repo_root())
        .arg("wheel-linux")
        .args(args)
        .env("PATH", path)
        .output()
        .expect("just runs");
    logged(output, dir)
}

/// Echoes a run's outcome, so a failing assertion reads beside what produced it.
fn logged(output: Output, dir: &Path) -> Output {
    eprintln!(
        "[{}] exit {:?}\nstdout:\n{}\nstderr:\n{}",
        dir.display(),
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn path_with_double(dir: &Path) -> std::ffi::OsString {
    let host = std::env::var_os("PATH").expect("the host has a PATH");
    let mut dirs = vec![dir.join("bin")];
    dirs.extend(std::env::split_paths(&host));
    std::env::join_paths(dirs).expect("the PATH joins")
}

fn out_arg(dir: &Path) -> String {
    dir.join("dist")
        .strip_prefix(repo_root())
        .expect("the scratch directory is inside the checkout")
        .display()
        .to_string()
}

/// One job's block of a workflow: from `  <job>:` to the next job key at the
/// same indentation.
fn job_block(workflow: &str, job: &str) -> String {
    let text = fs::read_to_string(repo_root().join(".github/workflows").join(workflow))
        .unwrap_or_else(|error| panic!("{workflow} is readable: {error}"));
    let header = format!("  {job}:");
    let mut lines = text.lines().skip_while(|line| *line != header);
    let first = lines
        .next()
        .unwrap_or_else(|| panic!("{workflow} has a `{job}` job"));
    let body = lines.take_while(|line| {
        let inner = line.strip_prefix("  ").unwrap_or("");
        !(line.starts_with("  ") && !inner.starts_with([' ', '#']) && inner.ends_with(':'))
    });
    std::iter::once(first)
        .chain(body)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// Each `- target:` in a job's matrix, with the `os:` beside it.
fn matrix_legs(block: &str) -> Vec<(String, String)> {
    let mut legs = Vec::new();
    let mut target = None;
    for line in block.lines().map(str::trim) {
        let line = line.trim_start_matches("- ");
        if let Some(value) = line.strip_prefix("target: ") {
            if !value.contains("${{") {
                target = Some(value.to_string());
            }
        } else if let Some(os) = line.strip_prefix("os: ") {
            if let Some(target) = target.take() {
                legs.push((target, os.to_string()));
            }
        }
    }
    legs
}

fn release_linux_legs() -> Vec<(String, String)> {
    let legs = matrix_legs(&job_block("release.yml", "build-wheels"));
    assert!(
        !legs.is_empty(),
        "release.yml's build-wheels matrix has legs"
    );
    legs.into_iter()
        .filter(|(_, os)| os.starts_with("ubuntu"))
        .collect()
}

/// The one maturin release.yml pins for the legs maturin-action still builds.
fn release_maturin_version() -> String {
    let text = fs::read_to_string(repo_root().join(".github/workflows/release.yml"))
        .expect("release.yml is readable");
    let pins: Vec<&str> = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("maturin-version: v"))
        .collect();
    assert!(!pins.is_empty(), "release.yml pins a maturin version");
    assert!(
        pins.iter().all(|pin| *pin == pins[0]),
        "release.yml pins one maturin version, found {pins:?}"
    );
    pins[0].to_string()
}

#[test]
fn every_linux_target_the_release_builds_is_handed_to_its_own_manylinux_image() {
    let targets: Vec<String> = release_linux_legs()
        .into_iter()
        .map(|(target, _)| target)
        .collect();
    assert_eq!(
        targets,
        ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
        "release.yml's Linux wheel targets"
    );
    let maturin = release_maturin_version();
    for target in &targets {
        let (_scratch, dir) = scratch(target);
        container_double(&dir, None);
        let out = out_arg(&dir);
        let output = run(&dir, &path_with_double(&dir), &[target, &out]);
        assert!(output.status.success(), "{target}: the build succeeds");
        let invocation = fs::read_to_string(dir.join("docker.log")).expect("docker was run");
        let arch = target.split('-').next().expect("a triple names its arch");
        let platform = if arch == "x86_64" {
            "linux/amd64"
        } else {
            "linux/arm64"
        };
        let args: Vec<&str> = invocation.lines().collect();
        for expected in [
            platform,
            &format!("quay.io/pypa/manylinux2014_{arch}")[..],
            &format!("MATURIN_VERSION={maturin}")[..],
            &format!("CHANNEL={}", channel())[..],
            "RUSTFLAGS=-D warnings",
        ] {
            assert!(
                args.contains(&expected),
                "{target}: docker got {expected}; it got {args:?}"
            );
        }
        let calls = container_calls(&dir);
        let cargo_target = format!("target/wheel-{target}");
        for expected in [
            // What v0.16.0's image lacked: OpenSSL's vendored `Configure` stops
            // on `Can't locate IPC/Cmd.pm` without it.
            "yum install -y -q perl-IPC-Cmd perl-Time-Piece".to_string(),
            "rustup-init -y -q --profile minimal --default-toolchain none".to_string(),
            format!("python3.12 -m pip install -q maturin=={maturin}"),
            // `bundled-ui`: the binary every prebuilt distribution ships embeds
            // the browser view, and refuses to build without it (build.rs).
            format!(
                "python3.12 -m maturin build --release --locked --features bundled-ui \
                 --target {target} --compatibility manylinux2014 --out {out}"
            ),
            format!("chown -R {} {cargo_target} {out}", host_owner()),
        ] {
            assert!(
                calls.contains(&expected),
                "{target}: the container ran `{expected}`; it ran {calls:?}"
            );
        }
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(&format!("built the {target} wheel")),
            "{target}: success names the wheel it built"
        );
    }
}

#[test]
fn a_container_step_that_fails_is_named_with_its_action_and_its_files_are_still_handed_back() {
    let rustup =
        "check that static.rust-lang.org serves rustup 1.29.1 for x86_64-unknown-linux-gnu \
                  with the SHA-256 this script pins";
    let toolchain = format!(
        "check that {}, rust-toolchain.toml's channel, is a published release",
        channel()
    );
    for (fail_at, step, action) in [
        (
            "yum",
            "installing OpenSSL's Perl prerequisites with yum",
            "check that the image's yum repositories answer",
        ),
        ("curl", "installing rustup 1.29.1", rustup),
        ("sha256sum", "installing rustup 1.29.1", rustup),
        ("chmod", "installing rustup 1.29.1", rustup),
        ("rustup-init", "installing rustup 1.29.1", rustup),
        ("rustup toolchain install", "installing Rust", &toolchain),
        ("python3.12 -m pip", "installing maturin", "check that PyPI serves maturin"),
        (
            "python3.12 -m maturin",
            "compiling the wheel",
            "fix the compile error above; 'just wheel-linux x86_64-unknown-linux-gnu' reproduces it",
        ),
    ] {
        let (_scratch, dir) = scratch("failed-step");
        container_double(&dir, Some(fail_at));
        let out = out_arg(&dir);
        let output = run(
            &dir,
            &path_with_double(&dir),
            &["x86_64-unknown-linux-gnu", &out],
        );
        assert_eq!(output.status.code(), Some(1), "{fail_at}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(&format!("the build stopped {step}")), "{stderr}");
        assert!(stderr.contains(&format!("ACTION: {action}")), "{stderr}");
        let calls = container_calls(&dir);
        assert!(
            calls.last().is_some_and(|call| call.starts_with("chown -R ")),
            "{fail_at}: the files are handed back after the failure; the container ran {calls:?}"
        );
    }
}

#[test]
fn a_hand_back_that_fails_fails_a_build_that_compiled() {
    let (_scratch, dir) = scratch("failed-hand-back");
    container_double(&dir, Some("chown"));
    let out = out_arg(&dir);
    let output = run(
        &dir,
        &path_with_double(&dir),
        &["x86_64-unknown-linux-gnu", &out],
    );
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("could not return target/wheel-x86_64-unknown-linux-gnu"),
        "{stderr}"
    );
    assert!(stderr.contains("ACTION: chown -R "), "{stderr}");
    assert!(!stderr.contains("the build stopped"), "{stderr}");
}

/// The acceptance this module exists for: a pull request builds the release's
/// Linux wheels through the one definition the release uses, on its runners.
#[test]
fn the_pull_request_check_builds_the_release_linux_legs_through_the_recipe() {
    let block = job_block("ci.yml", "wheel");
    assert_eq!(
        matrix_legs(&block),
        release_linux_legs(),
        "ci.yml's wheel legs build the release's Linux targets on the release's runners"
    );
    assert!(
        block.contains("run: just wheel-linux \"$TARGET\""),
        "ci.yml's wheel builds through the recipe"
    );
    assert!(
        block.contains("if: needs.changes.outputs.crate == 'true'"),
        "ci.yml's wheel runs on every pull request that reaches the crate"
    );
    // What the leg built is installed and smoke-tested, from the directory the
    // recipe writes to by default — the call above passes no `out`.
    let justfile = fs::read_to_string(repo_root().join("justfile")).expect("the justfile");
    assert!(
        justfile.contains("wheel-linux target out=\"dist\":"),
        "`just wheel-linux` writes to dist/ by default"
    );
    let built = block.find("just wheel-linux").expect("the wheel is built");
    let installed = block
        .find("bin/pip\" install --no-index dist/*.whl")
        .expect("ci.yml's wheel installs the wheel it built, and only that");
    let smoked = block
        .find("bash scripts/smoke-published.sh")
        .expect("ci.yml's wheel smoke-tests the installed binary");
    assert!(
        built < installed && installed < smoked,
        "ci.yml's wheel builds, then installs, then smoke-tests"
    );
    assert!(
        block.contains("--expect-version \"$version\""),
        "the smoke test holds the installed binary to this tree's version"
    );
    let release = job_block("release.yml", "build-wheels");
    assert!(
        release.contains("run: just wheel-linux \"$TARGET\"")
            && release.contains("if: runner.os == 'Linux'"),
        "release.yml's Linux legs build through the recipe"
    );
    // Every step of both that builds the browser view comes before the wheel.
    for (name, block) in [
        ("ci.yml wheel", &block),
        ("release.yml build-wheels", &release),
    ] {
        let built = block.find("run: just build").expect("the view is built");
        let wheel = block.find("just wheel-linux").expect("the wheel is built");
        assert!(
            built < wheel,
            "{name} builds the browser view before the wheel"
        );
    }
}

#[test]
fn an_undefined_target_is_refused_before_docker_is_reached() {
    let (_scratch, dir) = scratch("undefined-target");
    docker_double(&dir, 0);
    let output = run(
        &dir,
        &path_with_double(&dir),
        &["riscv64gc-unknown-linux-gnu"],
    );
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no manylinux build is defined for riscv64gc-unknown-linux-gnu"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: run 'build-linux-wheel.sh --target"),
        "{stderr}"
    );
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

#[test]
fn an_out_directory_that_leaves_the_checkout_is_refused() {
    let (_scratch, dir) = scratch("escaping-out");
    docker_double(&dir, 0);
    let elsewhere =
        std::env::temp_dir().join(format!("linux-wheel-elsewhere-{}", std::process::id()));
    fs::create_dir_all(&elsewhere).expect("a directory outside the checkout");
    let _elsewhere = Scratch(elsewhere.clone());
    std::os::unix::fs::symlink(&elsewhere, dir.join("dist")).expect("the escaping symlink");
    let absolute = dir.join("dist").display().to_string();
    for (out, says) in [
        (out_arg(&dir), "outside the repository"),
        (absolute, "is absolute"),
    ] {
        let output = script(
            &["--target", "x86_64-unknown-linux-gnu", "--out", &out],
            &dir,
        );
        assert_eq!(output.status.code(), Some(2), "{out}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(says), "{out}: {stderr}");
    }
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

#[test]
fn docker_that_cannot_run_the_image_exits_one_naming_it() {
    let (_scratch, dir) = scratch("failed-build");
    docker_double(&dir, 101);
    let output = run(&dir, &path_with_double(&dir), &["x86_64-unknown-linux-gnu"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "the x86_64-unknown-linux-gnu wheel did not build in \
             quay.io/pypa/manylinux2014_x86_64 (docker exited 101)"
        ),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: follow the ACTION above"),
        "{stderr}"
    );
}

#[test]
fn a_host_without_docker_is_told_to_install_it() {
    let (_scratch, dir) = scratch("no-docker");
    let bin = dir.join("bin");
    for tool in [
        "just", "bash", "awk", "dirname", "realpath", "sed", "id", "mkdir",
    ] {
        std::os::unix::fs::symlink(which(tool), bin.join(tool)).expect("the tool is linked");
    }
    let output = run(&dir, bin.as_os_str(), &["x86_64-unknown-linux-gnu"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("docker not found"), "{stderr}");
    assert!(
        stderr.contains("ACTION: install Docker, then re-run"),
        "{stderr}"
    );
}

fn script(args: &[&str], dir: &Path) -> Output {
    let output = Command::new("bash")
        .current_dir(repo_root())
        .arg("scripts/build-linux-wheel.sh")
        .args(args)
        .env("PATH", path_with_double(dir))
        .output()
        .expect("the script runs");
    logged(output, dir)
}

#[test]
fn a_malformed_invocation_is_refused_with_the_usage() {
    let (_scratch, dir) = scratch("malformed");
    docker_double(&dir, 0);
    for (args, says) in [
        (&["--target"][..], "--target needs a value"),
        (
            &["--target", "x86_64-unknown-linux-gnu", "--out"][..],
            "--out needs a value",
        ),
        (&["--bogus"][..], "unknown argument: --bogus"),
        (&[][..], "--target is required"),
    ] {
        let output = script(args, &dir);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(says), "{args:?}: {stderr}");
        assert!(
            stderr.contains("ACTION: run 'build-linux-wheel.sh --target"),
            "{stderr}"
        );
    }
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

/// A copy of the script at the root of a scratch checkout of its own, whose
/// `rust-toolchain.toml` pins `channel` and whose browser view is built: the
/// script reads the checkout it sits in, so this is how a checkout other than
/// this one is put in front of it.
fn checkout_with_channel(dir: &Path, channel: &str) -> PathBuf {
    let checkout = dir.join("checkout");
    fs::create_dir_all(checkout.join("scripts")).expect("the scratch checkout");
    fs::create_dir_all(checkout.join("apps/dag-ui/dist")).expect("the view's directory");
    fs::write(
        checkout.join("apps/dag-ui/dist/index.html"),
        "<!doctype html>",
    )
    .expect("the view's index");
    fs::copy(
        repo_root().join("scripts/build-linux-wheel.sh"),
        checkout.join("scripts/build-linux-wheel.sh"),
    )
    .expect("the script is copied");
    fs::write(
        checkout.join("rust-toolchain.toml"),
        format!("[toolchain]\nchannel = \"{channel}\"\n"),
    )
    .expect("the toolchain file is written");
    checkout
}

fn script_in(checkout: &Path, dir: &Path) -> Output {
    let output = Command::new("bash")
        .current_dir(checkout)
        .args([
            "scripts/build-linux-wheel.sh",
            "--target",
            "x86_64-unknown-linux-gnu",
        ])
        .env("PATH", path_with_double(dir))
        .output()
        .expect("the script runs");
    logged(output, dir)
}

#[test]
fn a_checkout_whose_browser_view_is_not_built_is_told_to_build_it() {
    let (_scratch, dir) = scratch("unbuilt-view");
    docker_double(&dir, 0);
    let checkout = checkout_with_channel(&dir, &channel());
    fs::remove_dir_all(checkout.join("apps/dag-ui/dist")).expect("the view is removed");
    let output = script_in(&checkout, &dir);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("the browser view is not built at"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: run 'just build', then re-run"),
        "{stderr}"
    );
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

#[test]
fn a_toolchain_channel_that_is_not_one_exact_release_is_refused() {
    let (_scratch, dir) = scratch("inexact-channel");
    docker_double(&dir, 0);
    let checkout = checkout_with_channel(&dir, "stable");
    let output = script_in(&checkout, &dir);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("rust-toolchain.toml's channel is 'stable', not one exact release"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: restore its single [toolchain] channel"),
        "{stderr}"
    );
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

#[test]
fn a_missing_toolchain_file_is_named() {
    let (_scratch, dir) = scratch("missing-toolchain");
    docker_double(&dir, 0);
    let checkout = checkout_with_channel(&dir, &channel());
    fs::remove_file(checkout.join("rust-toolchain.toml")).expect("the toolchain file is removed");
    let output = script_in(&checkout, &dir);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("cannot read"), "{stderr}");
    assert!(
        stderr.contains("ACTION: restore rust-toolchain.toml at the repository root"),
        "{stderr}"
    );
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

#[test]
fn a_build_directory_that_cannot_be_created_is_named() {
    let (_scratch, dir) = scratch("uncreatable");
    docker_double(&dir, 0);
    let checkout = checkout_with_channel(&dir, &channel());
    fs::write(checkout.join("target"), "").expect("the obstructing file");
    let output = script_in(&checkout, &dir);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("could not create"), "{stderr}");
    assert!(
        stderr.contains("target/wheel-x86_64-unknown-linux-gnu"),
        "{stderr}"
    );
    assert!(
        stderr.contains("ACTION: remove whatever file stands on either path"),
        "{stderr}"
    );
    assert!(!dir.join("docker.log").exists(), "docker was not run");
}

/// ci.yml's `gate` job's verdict command, as the runner assembles it from the
/// folded `run: >-` scalar: its lines joined by single spaces.
fn gate_command() -> String {
    let block = job_block("ci.yml", "gate");
    let mut lines = block.lines().skip_while(|line| line.trim() != "run: >-");
    lines
        .next()
        .expect("ci.yml's gate rules through a folded `run: >-` step");
    lines
        .map(str::trim)
        .take_while(|line| !line.is_empty() && !line.starts_with('-'))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Runs ci.yml's own `gate` command, with the three job results the runner
/// would hand it.
fn gate(changes: &str, quality: &str, wheel: &str) -> Output {
    let output = Command::new("bash")
        .current_dir(repo_root())
        .args(["-c", &gate_command()])
        .env("CHANGES", changes)
        .env("QUALITY", quality)
        .env("WHEEL", wheel)
        .output()
        .expect("bash runs");
    eprintln!(
        "[gate {changes} {quality} {wheel}] exit {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// The acceptance the review asked for: a Linux wheel that cannot build fails the
/// `gate` context branch protection requires, without the quality sweep having to
/// wait on it.
#[test]
fn the_required_gate_context_rules_on_both_wheel_legs_and_the_quality_sweep() {
    let block = job_block("ci.yml", "gate");
    assert!(
        block.contains("needs: [changes, quality, wheel]"),
        "ci.yml's gate waits on the changes, quality and wheel jobs:\n{block}"
    );
    assert!(
        block.contains("if: always()"),
        "ci.yml's gate runs when a job it needs failed, rather than being skipped — \
         which protection reads as passing:\n{block}"
    );
    for result in [
        "CHANGES: ${{ needs.changes.result }}",
        "QUALITY: ${{ needs.quality.result }}",
        "WHEEL: ${{ needs.wheel.result }}",
    ] {
        assert!(
            block.contains(result),
            "ci.yml's gate reads {result}:\n{block}"
        );
    }
    let quality = job_block("ci.yml", "quality");
    assert!(
        quality.contains("run: just check") && !quality.contains("needs:"),
        "the quality sweep runs `just check` and waits on nothing, so it runs beside the wheels"
    );
    assert!(
        job_block("ci.yml", "install").contains("needs: [changes, quality]"),
        "install still waits on the quality sweep it smoke-tests after"
    );
}

#[test]
fn a_wheel_that_did_not_build_fails_the_gate_and_is_named() {
    for wheel in ["failure", "cancelled"] {
        let output = gate("success", "success", wheel);
        assert_eq!(output.status.code(), Some(1), "{wheel}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("gate: `wheel` reported {wheel}")),
            "{stderr}"
        );
        assert!(
            stderr.contains("ACTION: open the jobs named above"),
            "{stderr}"
        );
    }
}

#[test]
fn the_gate_passes_only_when_every_job_it_needs_passed() {
    let passed = gate("success", "success", "success");
    assert!(passed.status.success());
    assert!(String::from_utf8_lossy(&passed.stdout).contains("gate: every required job passed"));
    // A change that cannot reach the crate skips the wheels, and that is a pass.
    assert!(gate("success", "success", "skipped").status.success());
    // Anything else is not: a skipped sweep proves nothing, and a `changes` that
    // failed is what would otherwise have let a skipped wheel through.
    for (changes, quality, wheel, named) in [
        (
            "success",
            "failure",
            "success",
            "`quality` reported failure",
        ),
        (
            "success",
            "skipped",
            "success",
            "`quality` reported skipped",
        ),
        (
            "failure",
            "success",
            "skipped",
            "`changes` reported failure",
        ),
    ] {
        let output = gate(changes, quality, wheel);
        assert_eq!(output.status.code(), Some(1), "{changes} {quality} {wheel}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(named), "{stderr}");
    }
}

#[test]
fn a_malformed_gate_verdict_invocation_is_refused_with_the_usage() {
    for (args, says) in [
        (&[][..], "no job results to rule on"),
        (&["--may-skip"][..], "--may-skip needs a job name"),
        (&["--bogus", "a=success"][..], "unknown option: --bogus"),
        (&["quality"][..], "not JOB=RESULT: 'quality'"),
        (&["quality="][..], "not JOB=RESULT: 'quality='"),
    ] {
        let output = Command::new("bash")
            .current_dir(repo_root())
            .arg("scripts/gate-verdict.sh")
            .args(args)
            .output()
            .expect("the script runs");
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(says), "{args:?}: {stderr}");
        assert!(stderr.contains("ACTION: run 'gate-verdict.sh"), "{stderr}");
    }
}
