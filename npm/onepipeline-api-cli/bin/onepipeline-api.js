#!/usr/bin/env node
// Launcher for the `onepipeline-api` command installed from the
// `onepipeline-api-cli` npm package.
//
// Like the PyPI wheels (maturin `bindings = "bin"`, see pyproject.toml), the npm
// distribution carries the *prebuilt* Rust binary — no Rust toolchain, no
// compile, no download at install time. The platform-specific binary ships
// inside a per-platform package (`onepipeline-api-cli-<platform>-<arch>`)
// declared in this package's `optionalDependencies`; npm installs only the one
// whose `os`/`cpu` match the host, and this shim resolves it and execs it with
// the caller's argv.
//
// This file is committed source; the version and the optionalDependency
// versions are stamped from Cargo.toml at publish time by scripts/npm-build.mjs,
// which also generates the per-platform packages from the release binaries.

"use strict";

const { spawn } = require("node:child_process");

// process.platform-process.arch -> the platform package that carries the binary.
// The keys mirror the Rust target matrix in .github/workflows/release.yml and
// the optionalDependencies in package.json; keep the three in lockstep.
const PACKAGES = {
  "linux-x64": "onepipeline-api-cli-linux-x64",
  "linux-arm64": "onepipeline-api-cli-linux-arm64",
  "darwin-x64": "onepipeline-api-cli-darwin-x64",
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

function binaryPath() {
  const key = `${process.platform}-${process.arch}`;
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

// The signals that mean "stop", and the reason this launcher is asynchronous.
//
// A supervisor — systemd, Docker, a CI job, the smoke test in
// scripts/smoke-published.sh — stops this command by signalling the process it
// started, which is *this* one and not the binary behind it. Under a synchronous
// spawn node has no chance to react: the default disposition kills the launcher
// where it stands, so the caller sees 128+15 instead of the server's own `0`,
// and the binary is left running with nothing waiting on it. So the child is
// spawned asynchronously and each of these is passed on to it, which is what
// lets the server run the graceful shutdown it already has and lets its exit
// status be the one the caller observes.
//
// Exactly the two the server installs handlers for (`StopSignal` in
// src/server.rs). Listening for a signal replaces node's default disposition, so
// forwarding one the binary does not handle would trade a clean kill for a
// launcher that outlives its terminal.
const STOP_SIGNALS = ["SIGTERM", "SIGINT"];

const child = spawn(binaryPath(), process.argv.slice(2), { stdio: "inherit" });

child.on("error", (error) => {
  fail(`failed to launch the onepipeline-api binary: ${error.message}`);
});

for (const signal of STOP_SIGNALS) {
  // Passed to the child alone. A terminal's Ctrl-C already reached the whole
  // foreground group, and the server treats the repeat as the same request to
  // stop that it is already answering.
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (status, signal) => {
  // Re-raise a terminating signal so callers observe the true cause; otherwise
  // propagate the child's exit code verbatim — a caller scripting against the
  // documented exit codes depends on seeing them. The listeners go first:
  // re-raising into one of them would be this process signalling itself in a
  // loop instead of dying of what killed the binary.
  for (const stop of STOP_SIGNALS) {
    process.removeAllListeners(stop);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(status === null ? 1 : status);
});
