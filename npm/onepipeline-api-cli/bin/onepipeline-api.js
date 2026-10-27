#!/usr/bin/env node
// Launcher for the `onepipeline-api` command installed from the
// `onepipeline-api-cli` npm package.
//
// Like the PyPI wheels (maturin `bindings = "bin"`, see pyproject.toml), the npm
// distribution carries the *prebuilt* Rust binary — no Rust toolchain, no
// compile, no download at install time. The platform-specific binary ships
// inside a per-platform package (`onepipeline-api-cli-<platform>-<arch>`)
// declared in this package's `optionalDependencies`; npm installs only the one
// whose `os`/`cpu` match the host, and this shim resolves it and runs it with
// the caller's argv.
//
// On Linux and macOS it *becomes* the binary (`process.execve`): the PID the
// caller started is the server's own, so a signal sent to it reaches the server,
// a parent-PID check sees the server, and there is no node process left to
// orphan anything. There is no other path on those platforms: a node without
// `process.execve` (before 22.15, or 23.0 through 23.10 — outside this
// package's `engines`) is refused before anything starts. Windows has no exec,
// so there the binary runs as a child this process supervises; `supervise`
// below says how that child is kept faithful.
//
// This file is committed source; the version and the optionalDependency
// versions are stamped from Cargo.toml at publish time by scripts/npm-build.mjs,
// which also generates the per-platform packages from the release binaries.

"use strict";

const { spawn } = require("node:child_process");

// process.platform-process.arch -> the platform package that carries the binary.
// The keys mirror the release targets in scripts/release.mjs and the
// optionalDependencies in package.json; keep the three in lockstep.
const PACKAGES = {
  "linux-x64": "onepipeline-api-cli-linux-x64",
  "linux-arm64": "onepipeline-api-cli-linux-arm64",
  "darwin-arm64": "onepipeline-api-cli-darwin-arm64",
  "win32-x64": "onepipeline-api-cli-win32-x64",
};

// Every failure here is a failed install, so say what to do about it rather than
// only what went wrong.
const OTHER_INSTALLS =
  "Install another way instead: 'pip install onepipeline-api-cli', or " +
  "'cargo install onepipeline-ui --locked'.";

function fail(message) {
  process.stderr.write(`onepipeline-api: ${message}\n`);
  process.exit(1);
}

// Platforms an earlier release carried and no later one does, each with the way
// to install there now, rather than sending the user looking for an optional
// dependency that never existed. Intel macOS stopped when Darwin builds moved to
// one Apple Silicon job.
const DISCONTINUED = {
  "darwin-x64":
    "Intel macOS is no longer supported: prebuilt binaries ship for Apple " +
    `Silicon (darwin-arm64) only. ${OTHER_INSTALLS}`,
};

function binaryPath() {
  const key = `${process.platform}-${process.arch}`;
  if (DISCONTINUED[key]) {
    fail(DISCONTINUED[key]);
  }
  const pkg = PACKAGES[key];
  // llmlint: ignore-block[changed_behavior_has_e2e] reaching this branch means running
  // where no prebuilt package exists, and a test can only get there by lying to node
  // about process.platform — which would prove the lie. The sibling branches are driven
  // for real by tests/e2e/packaging.rs (npm omits the optional dependency; the binary
  // resolves and execs), and npm's own os/cpu fields keep a user from installing a
  // platform package this map does not name.
  if (!pkg) {
    fail(
      `unsupported platform ${key}. Prebuilt binaries exist for: ` +
        `${Object.keys(PACKAGES).join(", ")}. ${OTHER_INSTALLS}`
    );
  }
  // llmlint: ignore-end[changed_behavior_has_e2e]

  const binName =
    process.platform === "win32" ? "onepipeline-api.exe" : "onepipeline-api";
  try {
    // Resolve the platform package's manifest, then locate the binary beside it.
    // Resolving package.json (rather than the binary file directly) is portable
    // across Node resolution modes and does not require an `exports` entry for a
    // non-JS asset.
    const path = require("node:path");
    const manifest = require.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(manifest), "bin", binName);
  } catch (_err) {
    fail(
      `the platform package ${pkg} is not installed. This usually means npm ` +
        "skipped optional dependencies (e.g. --no-optional / --omit=optional) " +
        "or the install was for a different platform. Reinstall with optional " +
        `dependencies enabled. ${OTHER_INSTALLS}`
    );
  }
}

// The signals that mean "stop", for the Windows launcher, which runs the binary
// as a child rather than becoming it.
//
// Listening for one replaces node's default disposition, which would end the
// launcher where it stands and report a status the server never chose. Exactly
// the two the server installs handlers for (`StopSignal` in src/server.rs);
// listening for one the binary does not handle would trade a clean end for a
// launcher that outlives its terminal. On Windows node only ever raises
// `SIGINT`, for the console's Ctrl-C.
const STOP_SIGNALS = ["SIGTERM", "SIGINT"];

// Windows: run the binary as a child and make it indistinguishable from running
// it directly — its stdio is this process's, an interrupt reaches it as the same
// interrupt, it cannot outlive this process, and this process exits with its
// status.
function supervise(binary, args) {
  // Not detached: libuv puts every attached child in a job object that closes
  // with this process, so a launcher that is ended — even by `TerminateProcess`
  // — takes the server with it rather than orphaning it.
  const child = spawn(binary, args, { stdio: "inherit" });

  child.on("error", (error) => {
    fail(`failed to launch the onepipeline-api binary: ${error.message}`);
  });

  for (const signal of STOP_SIGNALS) {
    // Caught, never passed on. The console already delivered the Ctrl-C to
    // every process attached to it, the server included, and `child.kill` on
    // Windows is `TerminateProcess`, which would cut short the very shutdown
    // the interrupt started. This process only has to outlive it and report
    // how it ended.
    process.on(signal, () => {});
  }

  child.on("exit", (status, signal) => {
    // Propagate the child's exit code verbatim — a caller scripting against the
    // documented exit codes depends on seeing them — or re-raise what ended it.
    // The listeners go first: re-raising into one of them would swallow it.
    for (const stop of STOP_SIGNALS) {
      process.removeAllListeners(stop);
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(status === null ? 1 : status);
  });
}

// Linux and macOS: replace this process with the binary, or fail before
// anything has started.
function become(binary, args) {
  // An ignored signal stays ignored across exec, and node ignores these two at
  // startup. Listening and then not listening hands each back to the default
  // disposition, so the binary starts with the signals a shell would give it.
  for (const inherited of ["SIGPIPE", "SIGXFSZ"]) {
    process.on(inherited, () => {});
    process.removeAllListeners(inherited);
  }
  // Returns only by throwing: the kernel refused to run the file, or this node
  // has no `process.execve` to call. Either way nothing was started, and
  // nothing will be — running the binary as a child instead is the process
  // tree this launcher exists not to build.
  try {
    process.execve(binary, [binary, ...args], process.env);
  } catch (error) {
    fail(
      `failed to launch the onepipeline-api binary: ${error.message}. ` +
        "This command replaces itself with the binary through process.execve, " +
        "which needs Node 22.15 or later (23.11 or later on Node 23); this is " +
        `Node ${process.versions.node}. Upgrade Node. ${OTHER_INSTALLS}`
    );
  }
}

const binary = binaryPath();
const args = process.argv.slice(2);
if (process.platform === "win32") {
  supervise(binary, args);
} else {
  become(binary, args);
}
