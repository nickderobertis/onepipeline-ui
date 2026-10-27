//! The npm distribution's journeys.
//!
//! Every test here reaches the command a user typed: the packages are assembled
//! for real, and the committed launcher runs under a real node, resolving its
//! platform package through node's own module resolution. Nothing about that
//! resolution is simulated — which matters, because the launcher's whole job is
//! that resolution, and it is the one part of the pipeline a release job would
//! otherwise discover broken in public.
//!
//! What the *packages* must contain, rather than what running them does, is
//! `tests/packaging.rs`.

use std::fs;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;

use crate::http;
#[cfg(unix)]
use crate::serving::Stop;
use crate::serving::{self, STOP_DEADLINE};

/// The Rust target triple for the host, as `.github/workflows/release.yml`
/// spells it. The release matrix builds exactly these four, so a host outside
/// them is a platform this repo does not ship — a failure to see, not to skip.
fn host_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        (os, arch) => panic!(
            "no release target for {os}/{arch}; add it to the matrix in \
             .github/workflows/release.yml, scripts/npm-build.mjs, and the \
             launcher's PACKAGES map, or drop this host"
        ),
    }
}

/// The npm platform package name for the host, as the launcher's `PACKAGES` map
/// spells it.
fn host_package() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("onepipeline-api-cli-{platform}-{arch}")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Run `scripts/npm-build.mjs` and return the package directory it printed.
fn npm_build(args: &[&str]) -> PathBuf {
    let output = Command::new("node")
        .arg(repo_root().join("scripts/npm-build.mjs"))
        .args(args)
        .current_dir(repo_root())
        .output()
        .expect("node is on PATH");
    assert!(
        output.status.success(),
        "npm-build.mjs {args:?} failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    PathBuf::from(String::from_utf8(output.stdout).expect("utf-8 path").trim())
}

/// The smallest SBOM `npm-build.mjs platform` packs (`scripts/sbom.mjs`), for
/// journeys whose subject is the launcher and the binary rather than the
/// document; `tests/release/sbom.test.mjs` holds the real one.
const MINIMAL_SBOM: &str = r#"{"bomFormat":"CycloneDX","specVersion":"1.3","metadata":{"component":{"name":"onepipeline-ui","bom-ref":"onepipeline-ui"}},"components":[],"dependencies":[]}"#;

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create destination");
    for entry in fs::read_dir(from).expect("read source") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

/// Assemble the launcher and, when `with_platform`, the host's platform package
/// into a node-resolvable tree, and return the launcher's entry point.
fn install(root: &Path, with_platform: bool) -> PathBuf {
    let staging = root.join("staging");
    let modules = root.join("node_modules");
    let launcher = npm_build(&["launcher", "--out", staging.to_str().expect("utf-8 path")]);
    copy_tree(&launcher, &modules.join("onepipeline-api-cli"));
    if with_platform {
        let binary = assert_cmd::cargo::cargo_bin("onepipeline-api");
        let sbom = root.join("onepipeline-api.cdx.json");
        fs::write(&sbom, MINIMAL_SBOM).expect("write the SBOM");
        let platform = npm_build(&[
            "platform",
            "--target",
            host_target(),
            "--binary",
            binary.to_str().expect("utf-8 path"),
            "--sbom",
            sbom.to_str().expect("utf-8 path"),
            "--out",
            staging.to_str().expect("utf-8 path"),
        ]);
        copy_tree(&platform, &modules.join(host_package()));
    }
    modules.join("onepipeline-api-cli/bin/onepipeline-api.js")
}

/// The binary the host's platform package carries, where [`install`] put it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn installed_binary(root: &Path) -> PathBuf {
    root.join("node_modules")
        .join(host_package())
        .join("bin")
        .join("onepipeline-api")
}

/// Start the installed command serving an empty runs root on a kernel-chosen
/// port, the way a host's supervisor would: `node <launcher> serve ...`, its
/// stdout piped so [`served_at`] can read the address the server announces.
fn serve_through(launcher: &mut Command, runs: &Path) -> std::process::Child {
    launcher
        .arg("serve")
        .arg("--runs-root")
        .arg(runs)
        .args(["--bind", "127.0.0.1:0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node is on PATH")
}

/// The address the server announced, read through the launcher's stdout — so
/// this also proves the launcher did not swallow it — and answering there.
fn served_at(launcher: &mut std::process::Child) -> std::net::SocketAddr {
    let address = serving::address_of(launcher);
    assert_eq!(
        http::get(address, "/healthz").status,
        200,
        "the launcher started something that does not serve"
    );
    address
}

fn run_launcher(entry: &Path, args: &[&str]) -> std::process::Output {
    Command::new("node")
        .arg(entry)
        .args(args)
        .output()
        .expect("node is on PATH")
}

#[test]
fn the_launcher_runs_the_binary_its_platform_package_carries() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let output = run_launcher(&entry, &["--version"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains(env!("CARGO_PKG_VERSION")), "{stdout}");
}

#[test]
fn the_launcher_propagates_the_binarys_exit_code_and_stderr() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let output = run_launcher(&entry, &["serve", "--runs-root", "/no/such/runs/root"]);
    // A caller scripting against the documented exit codes has to see the
    // binary's `2`, not the shim's own `1` — which is what it exits when the
    // resolution it exists to do fails.
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("is not a readable directory"),
        "the shim swallowed the binary's diagnostics"
    );
}

/// Kill whatever the launcher left behind, so a failing journey cannot leave a
/// server listening for as long as the machine is up.
///
/// The launcher is spawned as its own process group leader, which is what lets
/// this reach the binary *it* started — the defect this journey exists for is
/// precisely a launcher that exits without taking that binary with it, and there
/// is no other handle on the grandchild. Disarmed on the way out of a journey
/// that proved the group is already empty.
#[cfg(unix)]
struct Survivors {
    group: i32,
    armed: bool,
}

#[cfg(unix)]
impl Survivors {
    fn of(launcher: &std::process::Child) -> Self {
        Self {
            group: i32::try_from(launcher.id()).expect("a pid fits in an i32"),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(unix)]
impl Drop for Survivors {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // SAFETY: `group` is the pid of a process this journey spawned as its
        // own group leader, so the negated pid names that group and nothing
        // else. Only reached on the failure path, where that group still has a
        // live member holding the pid — the success path disarms first.
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
    }
}

/// A request the server has begun and cannot finish until this journey says so:
/// its head and half its body are sent, and the handler is left waiting on the
/// rest.
///
/// A graceful shutdown waits for in-flight requests, and a terminated process
/// waits for nothing. So a stop that reached the server *as a stop* leaves it
/// alive until [`InFlight::finish`] sends the rest, and then it answers; a stop
/// that ended it outright has dropped the connection long before. That makes
/// the difference a fact about the server rather than a race against how fast
/// it can shut down. The request is a malformed host shutdown, which the server
/// refuses without asking the engine to do anything.
struct InFlight(std::net::TcpStream);

const IN_FLIGHT_BODY: &[u8] = b"not-json";

/// How long a held request is left before the stop and again after it: far
/// longer than it takes the server to read a request head, or the launcher to
/// end a child it means to end.
const SETTLE: std::time::Duration = std::time::Duration::from_secs(1);

impl InFlight {
    fn begin(address: std::net::SocketAddr) -> Self {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect(address).expect("connect to the server");
        stream
            .set_read_timeout(Some(STOP_DEADLINE))
            .expect("bound the read");
        let (sent, _) = IN_FLIGHT_BODY.split_at(IN_FLIGHT_BODY.len() / 2);
        let head = format!(
            "POST /api/v2/shutdown HTTP/1.1\r\nHost: {address}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n",
            IN_FLIGHT_BODY.len()
        );
        stream.write_all(head.as_bytes()).expect("send the head");
        stream.write_all(sent).expect("send half the body");
        std::thread::sleep(SETTLE);
        Self(stream)
    }

    /// Send the rest of the body and return the status line the server
    /// answered with, or why there was no answer.
    fn finish(mut self) -> std::io::Result<String> {
        use std::io::{Read, Write};
        let (_, rest) = IN_FLIGHT_BODY.split_at(IN_FLIGHT_BODY.len() / 2);
        self.0.write_all(rest)?;
        let mut answer = String::new();
        self.0.read_to_string(&mut answer)?;
        Ok(answer.lines().next().unwrap_or_default().to_owned())
    }
}

/// Hold a request in flight, ask the launcher to stop with `ask`, and prove the
/// stop reached the server as a request to shut down gracefully: the launcher is
/// still running a moment later, the held request is still answered, and only
/// then does the launcher exit, with the server's own `0`.
fn assert_stops_gracefully(
    launcher: &mut std::process::Child,
    address: std::net::SocketAddr,
    ask: impl FnOnce(&mut std::process::Child),
) {
    let held = InFlight::begin(address);
    ask(launcher);
    std::thread::sleep(SETTLE);
    assert!(
        launcher
            .try_wait()
            .expect("the launcher is waitable")
            .is_none(),
        "the launcher exited while the server still had a request in flight, so the server \
         was ended rather than asked to stop"
    );
    let answer = held.finish();
    assert!(
        matches!(&answer, Ok(status) if status.starts_with("HTTP/1.1 422")),
        "the server did not finish the request it held when it was asked to stop: {answer:?}"
    );
    let status = serving::wait_within(launcher, STOP_DEADLINE);
    assert_eq!(
        status.code(),
        Some(0),
        "a stopped server exits 0, and the launcher must report that: {status}"
    );
}

/// The npm distribution's shutdown journey on Unix: the command a supervisor
/// started, asked to stop, shuts the server down and answers with the status
/// the server chose.
///
/// This is the whole of what `scripts/smoke-published.sh` asks a published
/// artifact to do — serve on a kernel-chosen port, answer `/healthz`, then stop
/// on a signal and exit `0` — run against the launcher a user actually types.
/// It is the command a supervisor signals, so it and not the binary is what has
/// to survive the signal: nothing here can be proven by starting the binary
/// directly, which is why v0.3.1 shipped exiting 143. On Unix the launcher execs
/// the binary, so the two are one process and this holds the exec'd server.
#[cfg(unix)]
fn assert_the_launcher_stops_the_server(stop: Stop) {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let runs = tempfile::tempdir().expect("runs root");
    let mut launcher = serve_through(
        Command::new("node").arg(&entry).process_group(0),
        runs.path(),
    );
    let mut survivors = Survivors::of(&launcher);
    let address = served_at(&mut launcher);

    assert_stops_gracefully(&mut launcher, address, |launcher| {
        serving::ask_to_stop(launcher, stop);
    });
    // And the stop reached the *binary*, not only the shim: a launcher that
    // exits on its own and leaves the server running is a stop that did not
    // happen, however clean its status looks.
    assert!(
        std::net::TcpStream::connect(address).is_err(),
        "the launcher exited but the server it started is still listening on {address}"
    );
    survivors.disarm();
}

/// Unix only, for the reason `tests/support/serving.rs` gives and
/// `scripts/smoke-published.sh` repeats: Windows offers a parent no way to *ask*.
#[cfg(unix)]
#[test]
fn the_launcher_stops_the_server_when_a_supervisor_asks() {
    assert_the_launcher_stops_the_server(Stop::Terminate);
}

#[cfg(unix)]
#[test]
fn the_launcher_stops_the_server_on_a_terminals_interrupt() {
    assert_the_launcher_stops_the_server(Stop::Interrupt);
}

/// The executable the process `pid` is running, as the kernel reports it.
#[cfg(target_os = "linux")]
fn executable_of(pid: u32) -> PathBuf {
    fs::read_link(format!("/proc/{pid}/exe")).expect("the kernel names the process's executable")
}

/// The executable the process `pid` is running, as the kernel reports it.
#[cfg(target_os = "macos")]
fn executable_of(pid: u32) -> PathBuf {
    use std::os::unix::ffi::OsStringExt;
    let mut path = vec![0_u8; usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).expect("a size")];
    // SAFETY: `path` is a writable buffer of exactly the length passed, and
    // `proc_pidpath` writes at most that many bytes into it.
    let length = unsafe {
        libc::proc_pidpath(
            i32::try_from(pid).expect("a pid fits in an i32"),
            path.as_mut_ptr().cast(),
            u32::try_from(path.len()).expect("a size"),
        )
    };
    assert!(length > 0, "the kernel names no executable for pid {pid}");
    path.truncate(usize::try_from(length).expect("a length"));
    PathBuf::from(std::ffi::OsString::from_vec(path))
}

/// The process the installed command starts *is* the server: the PID a caller
/// holds runs the read API binary, not node.
///
/// That is the whole defect a child-process launcher has. A host that records
/// the PID it started — to stop the server later, or to check whether a process
/// is its own child — otherwise holds node's, so its signals reach node, its
/// parent-PID checks see node, and a node killed outright orphans the server.
/// Checked by the executable the kernel says that PID runs, so a launcher that
/// merely forwards signals well cannot pass.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn the_installed_command_runs_the_server_in_the_process_the_caller_started() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let runs = tempfile::tempdir().expect("runs root");
    let mut launcher = serve_through(
        Command::new("node").arg(&entry).process_group(0),
        runs.path(),
    );
    let mut survivors = Survivors::of(&launcher);
    let address = served_at(&mut launcher);

    let running = executable_of(launcher.id());
    let binary = installed_binary(root.path())
        .canonicalize()
        .expect("the platform package carries the binary");
    assert_eq!(
        running.canonicalize().unwrap_or(running),
        binary,
        "the PID the caller started is not the read API binary, so something sits between \
         the caller and the server"
    );

    serving::ask_to_stop(&mut launcher, Stop::Terminate);
    assert_eq!(
        serving::wait_within(&mut launcher, STOP_DEADLINE).code(),
        Some(0)
    );
    assert!(std::net::TcpStream::connect(address).is_err());
    survivors.disarm();
}

/// Wait for nothing to be listening on `address` any more, failing the journey
/// if something still is at the deadline.
#[cfg(windows)]
fn assert_stops_serving(address: std::net::SocketAddr, after: &str) {
    let asked = std::time::Instant::now();
    while std::net::TcpStream::connect(address).is_ok() {
        assert!(
            asked.elapsed() < STOP_DEADLINE,
            "{after}, and the server it started is still listening on {address} {STOP_DEADLINE:?} later"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// A console of the launcher's own, so a console event sent to it reaches the
/// launcher and the server it started and never this suite's own console.
///
/// Windows has no signals a parent can send: a console's processes are
/// interrupted by the console. This process attaches to the launcher's console
/// to raise an event there, swallowing it itself while attached.
#[cfg(windows)]
mod console {
    #[link(name = "kernel32")]
    extern "system" {
        fn FreeConsole() -> i32;
        fn AttachConsole(process: u32) -> i32;
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
        fn GenerateConsoleCtrlEvent(event: u32, group: u32) -> i32;
    }

    /// `CREATE_NEW_CONSOLE`, for `CommandExt::creation_flags`.
    pub const NEW_CONSOLE: u32 = 0x0000_0010;
    /// What a terminal's Ctrl-C raises.
    pub const CTRL_C: u32 = 0;
    /// What Ctrl-Break raises, and what a console supervisor sends a group it
    /// wants ended.
    pub const CTRL_BREAK: u32 = 1;
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;

    /// Handles every console event, so this process outlives the ones it raises.
    unsafe extern "system" fn swallow(_event: u32) -> i32 {
        1
    }

    /// Let the processes this one starts handle Ctrl-C. Whether a process
    /// ignores it is inherited, and a runner that started this suite ignoring
    /// it would hand that on to the launcher and the server, which would then
    /// never hear the interrupt these journeys are about.
    pub fn hand_on_interrupts() {
        // SAFETY: a null handler with `FALSE` changes only this process's
        // inherited ignore flag; no function pointer is registered.
        unsafe {
            SetConsoleCtrlHandler(None, 0);
        }
    }

    /// Raise `event` in the console `process` is attached to.
    pub fn raise(event: u32, process: u32) {
        // SAFETY: kernel32 calls on this process's own console state, and
        // `swallow` is a `'static` function that touches nothing. Each test runs
        // in a process of its own under nextest, so detaching from this one's
        // console affects no other test.
        unsafe {
            FreeConsole();
            assert_ne!(
                AttachConsole(process),
                0,
                "could not attach to the launcher's console"
            );
            SetConsoleCtrlHandler(Some(swallow), 1);
            assert_ne!(
                GenerateConsoleCtrlEvent(event, 0),
                0,
                "could not raise console event {event} in the launcher's console"
            );
            // Delivered on a thread of each attached process; keep swallowing
            // it until this one's has run.
            std::thread::sleep(std::time::Duration::from_millis(500));
            FreeConsole();
            SetConsoleCtrlHandler(Some(swallow), 0);
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

/// Start the installed command in a console of its own.
#[cfg(windows)]
fn serve_in_own_console(entry: &Path, runs: &Path) -> (std::process::Child, std::net::SocketAddr) {
    use std::os::windows::process::CommandExt;
    console::hand_on_interrupts();
    let mut launcher = serve_through(
        Command::new("node")
            .arg(entry)
            .creation_flags(console::NEW_CONSOLE),
        runs,
    );
    let address = served_at(&mut launcher);
    (launcher, address)
}

/// Where the launcher cannot become the server, a terminal's Ctrl-C still
/// reaches the server as a Ctrl-C: it shuts down the way it does when run
/// directly, finishing the request it holds, and the launcher exits with the
/// server's own `0` rather than ending it with `TerminateProcess` — the only
/// "signal" a Windows parent can send a child, and what a launcher that passed
/// the interrupt on with `child.kill` did.
#[cfg(windows)]
#[test]
fn on_windows_an_interrupt_reaches_the_server_as_an_interrupt() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let runs = tempfile::tempdir().expect("runs root");
    let (mut launcher, address) = serve_in_own_console(&entry, runs.path());

    assert_stops_gracefully(&mut launcher, address, |launcher| {
        console::raise(console::CTRL_C, launcher.id());
    });
    assert_stops_serving(address, "the launcher exited on an interrupt");
}

/// A launcher ended abruptly — `TerminateProcess`, what Task Manager, a CI
/// runner's timeout and node's own `kill()` do on Windows — leaves no server
/// behind.
#[cfg(windows)]
#[test]
fn on_windows_a_killed_launcher_leaves_no_server_running() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let runs = tempfile::tempdir().expect("runs root");
    let (mut launcher, address) = serve_in_own_console(&entry, runs.path());

    launcher.kill().expect("terminate the launcher");
    let _ = launcher.wait();
    assert_stops_serving(address, "the launcher was terminated");
}

/// A launcher that ends gracefully — Ctrl-Break, which a console supervisor
/// sends a group it wants ended and which node answers by running its own exit
/// — leaves no server behind either.
#[cfg(windows)]
#[test]
fn on_windows_a_launcher_ended_by_ctrl_break_leaves_no_server_running() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), true);
    let runs = tempfile::tempdir().expect("runs root");
    let (mut launcher, address) = serve_in_own_console(&entry, runs.path());

    console::raise(console::CTRL_BREAK, launcher.id());
    let _ = serving::wait_within(&mut launcher, STOP_DEADLINE);
    assert_stops_serving(address, "the launcher ended on Ctrl-Break");
}

#[test]
fn a_missing_platform_package_fails_with_the_other_install_paths() {
    let root = tempfile::tempdir().expect("temp dir");
    let entry = install(root.path(), false);
    let output = run_launcher(&entry, &["--version"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(&host_package()), "{stderr}");
    assert!(stderr.contains("optional dependencies"), "{stderr}");
    assert!(
        stderr.contains("pip install onepipeline-api-cli"),
        "{stderr}"
    );
    assert!(stderr.contains("cargo install onepipeline-ui"), "{stderr}");
}
