#!/usr/bin/env node
/**
 * Serve this repository's own read API over a recorded run fixture, or change what an
 * already-running one is serving.
 *
 * The browser journeys drive the shipped UI against the actual `onepipeline-api serve`
 * process, so the app's fetch and SSE paths, the telemetry client, and the read model
 * are all exercised for real. What this fabricates is only what a browser test cannot
 * afford to earn: the recorded run directory an orchestration would have written,
 * which `runs.mjs` writes in the SDK's own on-disk shape.
 *
 * Everything lands in a fresh workspace the caller names and `e2e/global-teardown.ts`
 * removes, so a browser run never reads or writes the operator's own runs.
 *
 * Usage:
 *   serve-fixture.mjs --workspace DIR --port N     build the fixture and serve it
 *   serve-fixture.mjs --workspace DIR --settle-dashboard | --remove-run ID
 *                     | --remove-page-runs | --grow-worker-session N
 *                     | --record-activity NAME --activity-detail TEXT
 *   serve-fixture.mjs --stall --port N [--refuse-port N]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRuns,
  facts,
  growTranscript,
  recordActivity,
  removePageRuns,
  removeRun,
  settleDashboard,
} from "./runs.mjs";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Published beside the runs root so a spec names what this wrote, not a copy of it. */
export const FIXTURE_FACTS_NAME = "fixture-facts.json";

/**
 * Report a failure and stop, under the same exit-code contract the crate serves:
 * `2` is a usage error — the caller asked for something this cannot mean — and
 * `70` is this side failing at something it was asked to do correctly. A build
 * that did not build is the second, and telling a Playwright run which of the two
 * it hit is the difference between fixing the invocation and fixing the tree.
 */
function stop(code, message, action) {
  process.stderr.write(`serve-fixture: ${message}\nACTION: ${action}\n`);
  process.exit(code);
}

/** A usage error: the invocation cannot mean anything this script can do. */
function die(message, action) {
  stop(2, message, action);
}

/** The compiled server this fixture serves through, built if it is not there yet. */
function serverBinary() {
  const built = spawnSync("cargo", ["build", "--locked", "--quiet"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (built.status !== 0) {
    stop(
      70,
      "the read API binary did not build",
      "run 'cargo build --locked' in the repository root and fix what it reports",
    );
  }
  return join(REPO_ROOT, "target", "debug", "onepipeline-api");
}

/**
 * Accept connections on `port` and never answer them.
 *
 * A read that is in flight is the only way to observe a loading view, and a browser
 * reaches that state only while a real request is outstanding. This is a network
 * condition, not a stand-in for the API: it serves nothing and answers nothing, so the
 * app's own request stays pending exactly as it would against a wedged server.
 *
 * With `--refuse-port`, a second port is held bound but never listened on, so the
 * kernel refuses every connection to it — which merely leaving a port free cannot
 * promise, because a concurrent run's API server could take it.
 */
function stall(port, refusePort) {
  const held = [];
  if (refusePort !== undefined) {
    const reservation = createServer();
    // Bound without listening: `listen` would accept, and accepting is the opposite
    // of what this port is for. Node has no bind-only primitive, so the reservation
    // listens and immediately destroys anything that arrives — a connection refused
    // as far as the browser's first read is concerned.
    reservation.on("connection", (socket) => socket.destroy());
    reservation.listen(refusePort, "127.0.0.1");
    held.push(reservation);
  }
  const listener = createServer((socket) => {
    // Held open, never written to and never closed: closing would let the client fail
    // fast, which is the opposite of what this proves.
    held.push(socket);
  });
  listener.listen(port, "127.0.0.1");
  held.push(listener);
  // Nothing resolves this: the process lives until Playwright stops it.
  return new Promise(() => {});
}

/** Build the fixture in `workspace` and serve it on a loopback port. */
async function serve(workspace, port) {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const runsRoot = join(workspace, "runs");
  buildRuns(runsRoot);
  writeFileSync(
    join(workspace, FIXTURE_FACTS_NAME),
    `${JSON.stringify(facts(), null, 2)}\n`,
  );

  const binary = serverBinary();
  const server = spawn(
    binary,
    [
      "serve",
      "--runs-root",
      runsRoot,
      "--bind",
      `127.0.0.1:${port}`,
      // A quarter of the default: the live-update journeys wait for the stream to
      // notice a change on disk, and that wait is the slowest part of each of them.
      "--poll-interval-ms",
      "125",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const stop = () => server.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return new Promise((resolveExit) => {
    server.on("exit", (code) => resolveExit(code ?? 0));
  });
}

function parseArgs(argv) {
  const flags = new Set([
    "--settle-dashboard",
    "--remove-page-runs",
    "--stall",
  ]);
  const valued = new Set([
    "--workspace",
    "--port",
    "--remove-run",
    "--grow-worker-session",
    "--record-activity",
    "--activity-detail",
    "--refuse-port",
  ]);
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (flags.has(name)) {
      out[name.slice(2)] = true;
      continue;
    }
    if (!valued.has(name)) {
      die(
        `unknown option ${name}`,
        `pass one of ${[...flags, ...valued].join(", ")}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      die(`${name} needs a value`, `give ${name} a value`);
    }
    out[name.slice(2)] = value;
    index += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
/** One port option, checked before anything binds or connects to it. */
function portOf(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    die(
      `'${value}' is not a port`,
      `pass ${name} a number between 1 and 65535`,
    );
  }
  return port;
}

const port = portOf(args.port ?? 8765, "--port");

if (args.stall) {
  const refuse =
    args["refuse-port"] === undefined
      ? undefined
      : portOf(args["refuse-port"], "--refuse-port");
  await stall(port, refuse);
} else {
  if (args.workspace === undefined) {
    die(
      "--workspace is required",
      "pass --workspace the fixture directory to use",
    );
  }
  // An absolute path, because this one is removed and rebuilt: a relative
  // workspace resolves against whatever directory the caller happened to be in,
  // and the directory this deletes must be the one Playwright chose.
  if (!isAbsolute(args.workspace)) {
    die(
      `'${args.workspace}' is not an absolute path`,
      "pass --workspace the absolute fixture directory Playwright recorded",
    );
  }
  const runsRoot = join(args.workspace, "runs");
  if (args["settle-dashboard"]) {
    settleDashboard(runsRoot);
  } else if (args["remove-page-runs"]) {
    removePageRuns(runsRoot);
  } else if (args["remove-run"] !== undefined) {
    removeRun(runsRoot, args["remove-run"]);
  } else if (args["grow-worker-session"] !== undefined) {
    const turns = Number(args["grow-worker-session"]);
    if (!Number.isInteger(turns) || turns < 1) {
      die(
        `'${args["grow-worker-session"]}' is not a turn count`,
        "pass --grow-worker-session the whole number of turns to record up to",
      );
    }
    growTranscript(runsRoot, turns);
  } else if (args["record-activity"] !== undefined) {
    // Both halves or neither: a summary the producing library bounds to 160
    // characters is a tool's name *and* what it was given, and one recorded with
    // an empty detail is a record no member would have written.
    if (args["activity-detail"] === undefined) {
      die(
        "--record-activity needs --activity-detail",
        "pass --activity-detail the summary the tool call carried",
      );
    }
    recordActivity(runsRoot, args["record-activity"], args["activity-detail"]);
  } else {
    process.exit(await serve(args.workspace, port));
  }
}
