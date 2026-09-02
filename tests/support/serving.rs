//! A real `onepipeline-api serve` process, on a real port.
//!
//! The journeys that use it drive the compiled binary the way an operator does —
//! spawn it, read the address it says it took, and make requests over a socket.
//! Nothing about the server is constructed in-process, so a change that breaks
//! argument parsing, the runtime, the bind, or the router breaks these.

#![allow(dead_code)] // Each test binary uses the part of the harness it needs.

use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;

/// How long a process asked to stop may take before a journey calls it hung.
///
/// A shutdown here is bounded work — stop accepting, finish the requests in
/// flight, end the open streams — so the number only has to separate "a loaded
/// CI runner" from "never". Generous for the first, and far inside the patience
/// of anything supervising this process: `systemd` waits 90 seconds by default
/// and `docker stop` 10 before they escalate to `SIGKILL`, which is the outcome
/// this bound exists to catch before a release does.
pub const STOP_DEADLINE: Duration = Duration::from_secs(20);

/// How often [`wait_within`] looks. Short enough that the assertion is about the
/// server's shutdown rather than about this poll.
const WAIT_POLL: Duration = Duration::from_millis(10);

/// The two ways a caller asks this process to stop.
///
/// Both mean the same thing to the server, and it installs a handler for each:
/// a supervisor sends the first, a terminal the second. They are a journey's
/// parameter because a server honouring only one of them is killed by whichever
/// it ignored, and that is invisible to a test that only ever sends the other.
#[derive(Debug, Clone, Copy)]
pub enum Stop {
    /// What `systemd`, `docker stop`, and `kill` with no argument send.
    Terminate,
    /// What a terminal sends on Ctrl-C.
    Interrupt,
}

#[cfg(unix)]
impl Stop {
    fn signal(self) -> libc::c_int {
        match self {
            Self::Terminate => libc::SIGTERM,
            Self::Interrupt => libc::SIGINT,
        }
    }
}

/// A serving process, stopped when it goes out of scope.
pub struct Serving {
    child: Child,
    /// The address the kernel gave it, read off its own first line of output.
    pub address: SocketAddr,
    /// The runs root it is serving, kept alive for as long as it is.
    pub runs: TempDir,
    /// What it has said on its own log, when a journey asked for that to be
    /// captured rather than inherited.
    log: Option<Arc<Mutex<String>>>,
    stopped: bool,
}

impl Serving {
    /// Start a server over a fresh runs root and wait until it names its port.
    ///
    /// `--bind 127.0.0.1:0` asks the kernel for a free port rather than guessing
    /// one, which is what lets these journeys run beside each other — and beside
    /// another checkout doing the same thing.
    pub fn start(build: impl FnOnce(&Path)) -> Self {
        let runs = tempfile::tempdir().expect("temp dir");
        build(runs.path());
        Self::start_in(runs, &[])
    }

    /// The same, with the server's environment changed.
    ///
    /// The one thing a journey needs to say about that environment is which
    /// `onepipeline` the server asks for a run's telemetry — including that it
    /// cannot have one, which is a state an operator really meets and a payload
    /// with no clock in it is the answer to.
    pub fn start_with_env(build: impl FnOnce(&Path), environment: &[(&str, &str)]) -> Self {
        let runs = tempfile::tempdir().expect("temp dir");
        build(runs.path());
        Self::start_in(runs, environment)
    }

    /// The same, reading the server's own log rather than letting it through to
    /// the terminal.
    ///
    /// For the journeys where what the operator is *told* is part of the
    /// behaviour under test. Inherited otherwise, so a failing journey still
    /// prints the server's own account of what it did.
    pub fn start_with_log(build: impl FnOnce(&Path)) -> Self {
        let runs = tempfile::tempdir().expect("temp dir");
        build(runs.path());
        Self::spawn(runs, &[], true)
    }

    /// Start a server over a runs root the caller already built.
    pub fn start_in(runs: TempDir, environment: &[(&str, &str)]) -> Self {
        Self::spawn(runs, environment, false)
    }

    fn spawn(runs: TempDir, environment: &[(&str, &str)], capture: bool) -> Self {
        let binary = assert_cmd::cargo::cargo_bin("onepipeline-api");
        let mut child = Command::new(binary)
            .arg("serve")
            .arg("--runs-root")
            .arg(runs.path())
            .args(["--bind", "127.0.0.1:0"])
            // Fast enough that a journey asserting on a live append finishes in
            // about a second, and still a real poll of the real runs root.
            .args(["--poll-interval-ms", "50"])
            .envs(environment.iter().copied())
            .stdout(Stdio::piped())
            .stderr(if capture {
                Stdio::piped()
            } else {
                Stdio::inherit()
            })
            .spawn()
            .expect("the binary is built and runnable");

        // Drained by a thread rather than read on demand: a captured pipe
        // nobody empties fills, and a server blocked writing to it would be a
        // hang in the journey rather than the answer it was asked for.
        let log = child.stderr.take().map(|stderr| {
            let said = Arc::new(Mutex::new(String::new()));
            let writing = Arc::clone(&said);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let mut said = writing.lock().expect("the log is not poisoned");
                    said.push_str(&line);
                    said.push('\n');
                }
            });
            said
        });

        let address = address_of(&mut child);
        Self {
            child,
            address,
            runs,
            log,
            stopped: false,
        }
    }

    /// Everything the server has said on its log so far.
    ///
    /// Only a server started by [`Serving::start_with_log`] has one to read;
    /// asking any other is the journey's own mistake rather than an empty log.
    pub fn said(&self) -> String {
        self.log
            .as_ref()
            .expect("this server's log is captured")
            .lock()
            .expect("the log is not poisoned")
            .clone()
    }

    /// Wait until the server has said `line`, or fail the journey.
    ///
    /// A bounded wait rather than an immediate read: the server writes its log
    /// before it answers, but this side reads it through a pipe and a thread, so
    /// the two are ordered only by the deadline. Bounded so a line that never
    /// comes is a named failure rather than a suite that hangs.
    pub fn wait_until_said(&self, line: &str) -> String {
        let asked = Instant::now();
        loop {
            let said = self.said();
            if said.contains(line) {
                return said;
            }
            assert!(
                asked.elapsed() < STOP_DEADLINE,
                "the server never said {line:?}; it said: {said}"
            );
            std::thread::sleep(WAIT_POLL);
        }
    }

    /// The run directory of `run` under this server's root.
    pub fn run_dir(&self, run: &str) -> std::path::PathBuf {
        self.runs.path().join(run)
    }

    /// The root it is serving, for a journey that asks the sibling about the same
    /// runs this server is reading.
    pub fn runs_root(&self) -> &Path {
        self.runs.path()
    }

    /// Ask the server to stop the given way, and return the status it exited
    /// with — or fail the journey if it has not exited [`STOP_DEADLINE`] later.
    ///
    /// This is the journey for the clean-shutdown path: a signalled server
    /// finishes and exits `0` rather than being killed, and does it in bounded
    /// time. Both halves matter — a shutdown that never completes is answered by
    /// a supervisor's `SIGKILL`, which is the same non-zero status by a slower
    /// route. Unix only — see [`ask_to_stop`] for what a parent can and cannot
    /// say on Windows.
    #[cfg(unix)]
    pub fn stop_on(mut self, stop: Stop) -> ExitStatus {
        ask_to_stop(&mut self.child, stop);
        let status = wait_within(&mut self.child, STOP_DEADLINE);
        self.stopped = true;
        status
    }
}

/// The address a serving process names on its own first line of output.
///
/// Reading it rather than choosing it is what lets `--bind 127.0.0.1:0` be the
/// rule here: the kernel picks a free port, so journeys run beside each other
/// and beside another checkout doing the same thing.
pub fn address_of(child: &mut Child) -> SocketAddr {
    let stdout = child.stdout.take().expect("stdout is piped");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("the server names the address it took");
    line.rsplit_once("http://")
        .and_then(|(_, rest)| rest.trim().parse().ok())
        .unwrap_or_else(|| panic!("the server did not name an address: {line:?}"))
}

/// Send the platform's "please stop" to a child.
///
/// On Unix that is a signal the server handles by finishing what it was doing.
/// Windows offers a parent no equivalent: `kill` there is `TerminateProcess`,
/// which ends the process unconditionally and reports a status the server never
/// chose. That is why the clean-shutdown journeys are asserted on Unix alone — a
/// Windows assertion would be about the harness's own termination, not the
/// server's shutdown. `scripts/smoke-published.sh` draws the same line, for the
/// same reason.
pub fn ask_to_stop(child: &mut Child, stop: Stop) {
    #[cfg(unix)]
    {
        // SAFETY: `child` is a live process this test started, and both signals
        // are ones the server installs a handler for.
        unsafe {
            libc::kill(
                i32::try_from(child.id()).expect("a pid fits in an i32"),
                stop.signal(),
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = stop;
        let _ = child.kill();
    }
}

/// Wait for `child` to exit, failing the journey if it takes longer than
/// `deadline`.
///
/// Bounded rather than `wait()`: a process that was asked to stop and never
/// does is the failure these journeys exist to catch, and an unbounded wait
/// reports it as a suite that hangs — no status, no message, and on CI a job
/// killed minutes later with nothing said about which test it was in.
pub fn wait_within(child: &mut Child, deadline: Duration) -> ExitStatus {
    wait_or_kill(child, deadline).unwrap_or_else(|| {
        panic!("the process was asked to stop and had still not exited {deadline:?} later")
    })
}

/// The same wait, but killing rather than failing — what a cleanup path needs.
fn wait_or_kill(child: &mut Child, deadline: Duration) -> Option<ExitStatus> {
    let asked = Instant::now();
    loop {
        match child.try_wait().expect("the child is waitable") {
            Some(status) => return Some(status),
            None if asked.elapsed() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(WAIT_POLL),
        }
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        // Asked to stop rather than killed, so a journey that ends without
        // calling `stop_on` still leaves the process to finish what it was doing
        // — and, under coverage, to write what it measured. Bounded all the
        // same: a wedged server must not turn the whole suite into a hang, and
        // a `Drop` cannot report the failure anyway.
        ask_to_stop(&mut self.child, Stop::Terminate);
        let _ = wait_or_kill(&mut self.child, STOP_DEADLINE);
    }
}

/// A serving process this build did not compile, over a runs root it does not
/// own.
///
/// [`Serving`] is the shape every other journey needs: one binary, this build's,
/// over a directory it created for the test. The baseline comparison needs
/// neither — it starts the **base commit's** binary over the **same** directory
/// this build's server is already reading, because a store served twice is the
/// only way to ask whether the two served the same thing. So the two pieces
/// `Serving` owns are the two this one deliberately borrows.
pub struct ForeignServing {
    child: Child,
    /// The address the kernel gave it, read off its own first line of output.
    pub address: SocketAddr,
}

impl ForeignServing {
    /// Start `binary` over `root`, and wait until it names its port.
    pub fn start(binary: &Path, root: &Path, environment: &[(&str, &str)]) -> Self {
        let mut child = Command::new(binary)
            .arg("serve")
            .arg("--runs-root")
            .arg(root)
            .args(["--bind", "127.0.0.1:0"])
            .args(["--poll-interval-ms", "50"])
            .envs(environment.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|err| panic!("start {}: {err}", binary.display()));
        let address = address_of(&mut child);
        Self { child, address }
    }
}

impl Drop for ForeignServing {
    fn drop(&mut self) {
        ask_to_stop(&mut self.child, Stop::Terminate);
        let _ = wait_or_kill(&mut self.child, STOP_DEADLINE);
    }
}
