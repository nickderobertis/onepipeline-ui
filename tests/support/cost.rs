//! What a request actually cost, counted from the kernel's own record of it.
//!
//! The criteria this server is now held to are about **operations**, not about
//! elapsed time: bytes read from the runs root, file opens, filesystem metadata
//! lookups, and processes started. That choice is the whole reason this module
//! exists. A CPU measurement taken on a host that also runs every dispatch is a
//! property of the host — the operator's own figures were 19.8 CPU-seconds for
//! one idle stream and 2m44s for a page of one, and neither reproduces anywhere
//! — where the work a read does is a property of the finished tree and is the
//! same on every machine that runs it.
//!
//! **Nothing here is a double.** The real `onepipeline-api` binary is started,
//! over a real runs root, and driven over a real socket; what is added is
//! `strace`, which watches the syscalls it makes. So a journey cannot pass by
//! counting what a test harness *thinks* a read costs — it counts what the
//! kernel was actually asked for, including every byte the linked SDK read
//! without this crate's code being involved, which is precisely where the cost
//! being removed here lived.
//!
//! Linux only, and deliberately not skipped elsewhere: the module is compiled
//! away on the platforms whose gate legs do not run it, exactly as the coverage
//! floor is Linux-only, so nothing anywhere reports a cost journey as passing
//! when it did not run. `strace` must be installed for the same reason a journey
//! that quietly skipped would be guarding nothing — its absence is a named
//! failure telling the reader what to install.
//!
//! # How one request is separated from another
//!
//! By a **marker**, not by a clock. A trace is one chronological record of the
//! whole process, so a journey that wanted the cost of its third request needs
//! somewhere to start counting from — and correlating wall-clock stamps against
//! a test's own clock is a race waiting to be flaky. Instead the journey asks
//! the server about a run id that cannot exist, which makes the server look for
//! exactly that name and nothing else: an unmistakable, self-identifying
//! landmark in the trace, produced by a real request over the real route.

#![cfg(target_os = "linux")]
#![allow(dead_code)] // Each journey counts the operations it is about.

use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use tempfile::TempDir;

use crate::http;
use crate::serving::{address_of, ask_to_stop, wait_within, Stop, STOP_DEADLINE};

/// The syscalls a read of a runs root is made of.
///
/// Named rather than traced wholesale, because everything else a server does —
/// sockets, futexes, clocks — is noise this is not about, and a trace that
/// carried it would be slower to take and no more informative. `statx` and
/// `newfstatat` are both here because which one a metadata lookup compiles to is
/// the libc's business rather than this server's, and a count that saw only one
/// of them would report a lookup as free on half the machines that run it.
const TRACED: &str = "openat,read,pread64,newfstatat,statx,fstat,execve";

/// How much of each string argument strace prints.
///
/// Long enough for a temporary directory's whole path, which is what every count
/// here is keyed by; a truncated path would silently stop matching the run it
/// belongs to and read as a cost nobody paid.
const STRING_LEN: usize = 400;

/// One thing the server asked the kernel for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// A file was opened.
    Open(PathBuf),
    /// Bytes were read from an open file.
    Read(PathBuf, u64),
    /// A path's metadata was looked up.
    Lookup(PathBuf),
    /// A directory was opened to list its entries.
    List(PathBuf),
    /// A program was started.
    Exec(String),
}

impl Op {
    /// The path this operation was against, for the ones that have one.
    fn path(&self) -> Option<&Path> {
        match self {
            Self::Open(path) | Self::Read(path, _) | Self::Lookup(path) | Self::List(path) => {
                Some(path)
            }
            Self::Exec(_) => None,
        }
    }
}

/// The three of the four operations that are **against a path**.
///
/// One value rather than three assertions side by side, so a journey that means
/// "nothing was done to this run" says so once and cannot leave one of them out
/// — which is exactly how an expensive operation goes uncounted. The fourth,
/// starting a process, is against no path and is counted by
/// [`Cost::processes_started`]; every journey that asserts one of these asserts
/// that one too.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    /// Bytes read from files under the path counted.
    pub bytes: u64,
    /// Files opened under it.
    pub opens: usize,
    /// Metadata lookups against it or anything under it.
    pub lookups: usize,
}

impl Counts {
    /// Whether nothing at all was done.
    #[must_use]
    pub fn is_nothing(self) -> bool {
        self == Self::default()
    }
}

/// Everything one traced process did, in order.
#[derive(Debug, Clone)]
pub struct Cost {
    ops: Vec<Op>,
}

impl Cost {
    /// The four counts against `path` and anything under it.
    #[must_use]
    pub fn under(&self, path: &Path) -> Counts {
        let mut counts = Counts::default();
        for op in &self.ops {
            let Some(against) = op.path() else { continue };
            if !against.starts_with(path) {
                continue;
            }
            match op {
                Op::Open(_) => counts.opens += 1,
                Op::Read(_, bytes) => counts.bytes += bytes,
                Op::Lookup(_) => counts.lookups += 1,
                // A listing is neither an open nor a lookup: it is the one
                // operation a run-list read is allowed per tick, and counting it
                // as either would hide it inside a number that is allowed to be
                // non-zero.
                Op::List(_) | Op::Exec(_) => {}
            }
        }
        counts
    }

    /// How many times `directory` itself was listed.
    #[must_use]
    pub fn listings_of(&self, directory: &Path) -> usize {
        self.ops
            .iter()
            .filter(|op| matches!(op, Op::List(listed) if listed == directory))
            .count()
    }

    /// How many programs this server started, not counting itself.
    ///
    /// The traced process's own `execve` is the one strace records before the
    /// server exists at all; every other one is a process the server started.
    #[must_use]
    pub fn processes_started(&self) -> usize {
        self.ops
            .iter()
            .filter(|op| matches!(op, Op::Exec(_)))
            .count()
            .saturating_sub(1)
    }

    /// Everything done between two landmarks: after the last mention of `from`
    /// and before the first mention of `to`.
    ///
    /// What a journey comparing two requests needs — [`since`](Self::since) runs
    /// to the end of the trace, so measuring the first of two requests with it
    /// measures both.
    #[must_use]
    pub fn between(&self, from: &str, to: &str) -> Self {
        let after = self.since(from);
        let until = after
            .ops
            .iter()
            .position(|op| {
                op.path()
                    .is_some_and(|path| path.to_string_lossy().contains(to))
            })
            .unwrap_or(after.ops.len());
        Self {
            ops: after.ops[..until].to_vec(),
        }
    }

    /// Everything done **after** the last mention of `marker`.
    ///
    /// See this module's header: a marker is a run id the store cannot hold, so
    /// the server looks for exactly that name and nothing else, and the trace
    /// carries an unmistakable landmark at the moment the journey asked for one.
    #[must_use]
    pub fn since(&self, marker: &str) -> Self {
        let at = self
            .ops
            .iter()
            .rposition(|op| {
                op.path()
                    .is_some_and(|path| path.to_string_lossy().contains(marker))
            })
            .unwrap_or_else(|| {
                panic!(
                    "the trace carries no mention of the marker {marker:?}, so there is \
                        nothing to count from"
                )
            });
        Self {
            ops: self.ops[at + 1..].to_vec(),
        }
    }

    /// Every operation, for a journey that needs to say why a count is what it
    /// is when it fails.
    #[must_use]
    pub fn recorded(&self) -> &[Op] {
        &self.ops
    }
}

/// A real serving process whose every filesystem call is on the record.
///
/// The shape [`crate::serving::Serving`] has, plus the trace: same binary, same
/// arguments, same socket. What it does not have is `Serving`'s `Drop`, because
/// the trace is only complete once the process has exited — so a journey ends by
/// calling [`Traced::finish`], and forgetting to is a journey that never asserts
/// rather than one that asserts something wrong.
pub struct Traced {
    child: Child,
    /// The address the kernel gave it, read off its own first line of output.
    pub address: SocketAddr,
    /// The runs root it is serving, kept alive for as long as it is.
    pub runs: TempDir,
    traces: TempDir,
}

/// How often a traced server re-reads the runs root, unless a journey says
/// otherwise.
///
/// Slower than the suite's usual 50ms because a traced tick is a *counted*
/// thing: the journeys that bound what an idle subscriber costs divide a
/// measured interval by this to say how many ticks should have happened, and a
/// fast poll makes that quotient large enough that one scheduling hiccup reads
/// as a broken bound.
pub const TRACED_POLL_MS: u64 = 200;

impl Traced {
    /// Start a traced server over a fresh runs root.
    pub fn start(build: impl FnOnce(&Path)) -> Self {
        let runs = tempfile::tempdir().expect("temp dir");
        build(runs.path());
        Self::start_in(runs, TRACED_POLL_MS)
    }

    /// The same, over a runs root the caller already built, polling as it says.
    pub fn start_in(runs: TempDir, poll_ms: u64) -> Self {
        require_strace();
        let traces = tempfile::tempdir().expect("temp dir");
        let binary = assert_cmd::cargo::cargo_bin("onepipeline-api");
        let mut child = Command::new("strace")
            // The tracer runs as a grandchild, so the process this journey
            // holds — and signals to stop — is the server itself rather than
            // strace standing in front of it.
            .arg("-D")
            // One file per thread, which is what makes the record parseable: a
            // single stream from a multi-threaded server interleaves syscalls
            // and splits them across `<unfinished ...>` continuations.
            .arg("-ff")
            // Render each descriptor as the path it was opened on, which is the
            // only way a `read` can be attributed to the run it is reading.
            .arg("-y")
            // Every line stamped with the instant it happened, which is the only
            // thing that puts one thread's record beside another's: `-ff` writes
            // a file per thread, and a server answers a request on one worker
            // while its open stream polls on a second.
            .arg("-ttt")
            .args(["-s", &STRING_LEN.to_string()])
            .args(["-e", &format!("trace={TRACED}")])
            .arg("-o")
            .arg(traces.path().join("trace"))
            .arg(binary)
            .arg("serve")
            .arg("--runs-root")
            .arg(runs.path())
            .args(["--bind", "127.0.0.1:0"])
            .args(["--poll-interval-ms", &poll_ms.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("strace is installed and the binary is built");
        let address = address_of(&mut child);
        Self {
            child,
            address,
            runs,
            traces,
        }
    }

    /// The root it is serving.
    pub fn runs_root(&self) -> &Path {
        self.runs.path()
    }

    /// Where one run's state lives under that root.
    pub fn run_dir(&self, run: &str) -> PathBuf {
        self.runs.path().join(run)
    }

    /// Leave a landmark in the trace, and answer the name of it.
    ///
    /// A real request over the real route, naming a run this store cannot hold,
    /// so the server looks that name up and finds nothing. What comes back is
    /// asserted on, because a marker that silently stopped being made would be a
    /// journey counting from the beginning of time.
    pub fn mark(&self, name: &str) -> String {
        let answered = http::get(self.address, &format!("/api/v2/runs?select={name}")).json();
        assert_eq!(
            answered["missing"],
            serde_json::json!([name]),
            "the marker request did not name the run it could not find"
        );
        name.to_owned()
    }

    /// Stop the server and read what it did.
    ///
    /// The trace is only whole once the process has exited, so this is the only
    /// way to a [`Cost`].
    pub fn finish(mut self) -> Cost {
        ask_to_stop(&mut self.child, Stop::Terminate);
        let status = wait_within(&mut self.child, STOP_DEADLINE);
        assert!(
            status.success(),
            "the traced server did not stop cleanly: {status}"
        );
        Cost {
            ops: read_trace(self.traces.path()),
        }
    }
}

/// Fail with what to do about it, rather than skipping.
fn require_strace() {
    let found = Command::new("strace")
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    assert!(
        found.is_ok_and(|status| status.success()),
        "these journeys count what the server asked the kernel for, and `strace` is how they \
         count it — install it (`apt-get install strace`) and run them again. Skipping would \
         report a cost bound as held when nothing measured it."
    );
}

/// Every operation the trace files under `dir` recorded, **in the order they
/// happened**.
///
/// One file per thread, and the order across those files is the whole
/// correctness of a marker: a server answers a request on one blocking worker
/// while its open stream polls on another, so concatenating the files by name
/// puts a landmark after work that came before it and a journey counting from
/// that landmark measures nothing. They are merged on the instant strace stamps
/// each line with instead.
fn read_trace(dir: &Path) -> Vec<Op> {
    let mut stamped: Vec<(f64, Op)> = Vec::new();
    for entry in std::fs::read_dir(dir)
        .expect("the trace directory")
        .flatten()
    {
        let reading = BufReader::new(std::fs::File::open(entry.path()).expect("a trace file"));
        for line in reading.lines().map_while(Result::ok) {
            let Some((stamp, call)) = line.split_once(' ') else {
                continue;
            };
            let Ok(at) = stamp.parse::<f64>() else {
                continue;
            };
            if let Some(op) = parse(call) {
                stamped.push((at, op));
            }
        }
    }
    stamped.sort_by(|left, right| left.0.total_cmp(&right.0));
    stamped.into_iter().map(|(_, op)| op).collect()
}

/// One traced line as the operation it records, or `None` for anything else —
/// a signal, an exit, a call that failed, or a syscall this is not about.
fn parse(line: &str) -> Option<Op> {
    let call = line.split('(').next()?;
    let returned = line.rsplit_once(" = ")?.1.trim();
    // A call that failed did nothing: an `openat` that found no file opened
    // none, and counting it would report a cost the kernel never paid. A lookup
    // is the exception and is counted whatever it answered — asking is the cost,
    // and "is this directory there" is a question a reader really does pay for.
    let failed = returned.starts_with('-');
    match call {
        // A directory opened for reading is a **listing**, and it is one however
        // many `getdents64` calls the C library then makes against it — which is
        // two for a directory that fits in one buffer, and more for one that does
        // not. Counting the opens is what makes "one listing of the runs root per
        // tick" a number rather than a number times however many runs there are.
        "openat" if line.contains("O_DIRECTORY") => {
            let path = PathBuf::from(quoted(line)?);
            (!failed).then_some(Op::List(path))
        }
        "openat" => {
            let path = PathBuf::from(quoted(line)?);
            (!failed).then_some(Op::Open(path))
        }
        "read" | "pread64" => {
            let bytes = returned.parse::<u64>().ok()?;
            Some(Op::Read(PathBuf::from(descriptor(line)?), bytes))
        }
        "newfstatat" | "statx" => Some(Op::Lookup(PathBuf::from(quoted(line)?))),
        // `fstat` names no path of its own; it describes a descriptor this trace
        // has already attributed, and counting it would double every open.
        "fstat" => None,
        "execve" => Some(Op::Exec(quoted(line)?.to_owned())),
        _ => None,
    }
}

/// The first quoted string on a traced line, which for the calls that take a
/// path is the path.
fn quoted(line: &str) -> Option<&str> {
    let opened = line.find('"')? + 1;
    let rest = &line[opened..];
    Some(&rest[..rest.find('"')?])
}

/// The path strace rendered a descriptor as, which is the file that descriptor
/// is open on.
fn descriptor(line: &str) -> Option<&str> {
    let opened = line.find('<')? + 1;
    let rest = &line[opened..];
    Some(&rest[..rest.find('>')?])
}
