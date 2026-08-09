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
use std::process::{Child, Command, Stdio};

use tempfile::TempDir;

/// A serving process, stopped when it goes out of scope.
pub struct Serving {
    child: Child,
    /// The address the kernel gave it, read off its own first line of output.
    pub address: SocketAddr,
    /// The runs root it is serving, kept alive for as long as it is.
    pub runs: TempDir,
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
        Self::start_in(runs)
    }

    /// Start a server over a runs root the caller already built.
    pub fn start_in(runs: TempDir) -> Self {
        let binary = assert_cmd::cargo::cargo_bin("onepipeline-api");
        let mut child = Command::new(binary)
            .arg("serve")
            .arg("--runs-root")
            .arg(runs.path())
            .args(["--bind", "127.0.0.1:0"])
            // Fast enough that a journey asserting on a live append finishes in
            // about a second, and still a real poll of the real runs root.
            .args(["--poll-interval-ms", "50"])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the binary is built and runnable");

        let stdout = child.stdout.take().expect("stdout is piped");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("the server names the address it took");
        let address = line
            .rsplit_once("http://")
            .and_then(|(_, rest)| rest.trim().parse().ok())
            .unwrap_or_else(|| panic!("the server did not name an address: {line:?}"));
        Self {
            child,
            address,
            runs,
            stopped: false,
        }
    }

    /// The run directory of `run` under this server's root.
    pub fn run_dir(&self, run: &str) -> std::path::PathBuf {
        self.runs.path().join(run)
    }

    /// Ask the server to stop the way a supervisor does, and return its status.
    ///
    /// This is the journey for the clean-shutdown path: a signalled server
    /// finishes and exits `0` rather than being killed. Unix only — see
    /// [`ask_to_stop`] for what a parent can and cannot say on Windows.
    #[cfg(unix)]
    pub fn stop(mut self) -> std::process::ExitStatus {
        ask_to_stop(&mut self.child);
        let status = self.child.wait().expect("the server exits");
        self.stopped = true;
        status
    }
}

/// Send the platform's "please stop" to a child.
///
/// On Unix that is `SIGTERM`, which the server handles and answers by finishing
/// what it was doing. Windows offers a parent no equivalent: `kill` there is
/// `TerminateProcess`, which ends the process unconditionally and reports a
/// status the server never chose. That is why the clean-shutdown journey is
/// asserted on Unix alone — a Windows assertion would be about the harness's
/// own termination, not the server's shutdown.
fn ask_to_stop(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: `child` is a live process this test started, and SIGTERM is
        // the signal the server installs a handler for.
        unsafe {
            libc::kill(
                i32::try_from(child.id()).expect("a pid fits in an i32"),
                libc::SIGTERM,
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        // Asked to stop rather than killed, so a journey that ends without
        // calling `stop` still leaves the process to finish what it was doing —
        // and, under coverage, to write what it measured.
        ask_to_stop(&mut self.child);
        let _ = self.child.wait();
    }
}
