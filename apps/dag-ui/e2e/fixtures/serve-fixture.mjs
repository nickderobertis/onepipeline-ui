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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
 * `70` is this side failing at something it was asked to do correctly. A server
 * binary that was never built is the second, and telling a Playwright run which of
 * the two it hit is the difference between fixing the invocation and fixing the tree.
 */
function stop(code, message, action) {
  process.stderr.write(`serve-fixture: ${message}\nACTION: ${action}\n`);
  process.exit(code);
}

/** A usage error: the invocation cannot mean anything this script can do. */
function die(message, action) {
  stop(2, message, action);
}

/**
 * The directory `dag-ui:build-api-server` built into: `CARGO_TARGET_DIR` when
 * cargo was told one, and the default `target/` otherwise.
 *
 * Honoured because that build step is a cargo invocation from the repository
 * root, so a relative one resolves the way cargo itself resolves it. Validated
 * rather than trusted, like every other input here: this value chooses the path
 * this script spawns, and one that is set but empty is a mistyped export rather
 * than a directory — resolved, it would name the repository root and be reported
 * as a tree that was never built, sending a reader to fix the wrong thing.
 */
function targetRoot() {
  const configured = process.env.CARGO_TARGET_DIR;
  if (configured === undefined) {
    return join(REPO_ROOT, "target");
  }
  if (configured.trim() === "") {
    die(
      "CARGO_TARGET_DIR is set to an empty path",
      "unset CARGO_TARGET_DIR, or set it to the directory cargo was told to build into",
    );
  }
  return resolve(REPO_ROOT, configured);
}

/**
 * The compiled server this fixture serves through — located, never built.
 *
 * Compiling here would put a debug build inside the readiness window Playwright
 * gives a `webServer`, and that window is budgeted for a process binding a port.
 * A warm `target/` hides it; a cold one on a CI runner, sharing the cargo lock
 * with the sibling task compiling the crate's own tests, spends minutes there and
 * Playwright reports the one thing that was not wrong — a server that would not
 * start. So the build is a step of its own, `dag-ui:build-api-server`, which
 * `dag-ui:test` and `dag-ui:bootstrap` depend on, and its absence is answered
 * here in milliseconds rather than waited out.
 */
function serverBinary() {
  const directory = join(targetRoot(), "debug");
  // Both names cargo gives that binary, looked for rather than chosen from the
  // platform: what is on disk is what this has to spawn, and asking the disk is
  // one path a run on any OS takes — where branching on `process.platform` would
  // leave the branch the browser tier does not run on unproven.
  const binary = ["onepipeline-api", "onepipeline-api.exe"]
    .map((name) => join(directory, name))
    .find(existsSync);
  if (binary === undefined) {
    stop(
      70,
      `no read API binary in ${directory}`,
      "run 'npx nx run dag-ui:build-api-server' from the repository root — the browser tier builds it in a step of its own, before any server starts",
    );
  }
  return binary;
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
async function stall(port, refusePort) {
  const held = [];
  if (refusePort !== undefined) {
    const reservation = createServer();
    // Bound without listening: `listen` would accept, and accepting is the opposite
    // of what this port is for. Node has no bind-only primitive, so the reservation
    // listens and immediately destroys anything that arrives — a connection refused
    // as far as the browser's first read is concerned.
    reservation.on("connection", (socket) => socket.destroy());
    await bound(reservation, refusePort, "hold refused");
    held.push(reservation);
  }
  const listener = createServer((socket) => {
    // Held open, never written to and never closed: closing would let the client fail
    // fast, which is the opposite of what this proves.
    held.push(socket);
  });
  await bound(listener, port, "stall");
  held.push(listener);
  // Said out loud for the same reason the read API says it: this is the only server
  // the browser tier starts that answers nothing by design, so a run that waits for
  // it and gives up has, without this line, no way to tell a port it never took from
  // one it took and held. Playwright reports a `webServer` that did not become ready
  // as a bare timeout naming neither the server nor the reason.
  process.stdout.write(
    `serve-fixture: stalling on 127.0.0.1:${port}${
      refusePort === undefined ? "" : `, refusing 127.0.0.1:${refusePort}`
    }\n`,
  );
  // Nothing resolves this: the process lives until Playwright stops it.
  return new Promise(() => {});
}

/**
 * Take `port` on loopback for `purpose`, or stop saying which port and why.
 *
 * A `net.Server` reports a port it could not take by emitting `error`, and an
 * `error` nothing is listening for is an uncaught exception — a stack trace and
 * an exit code outside this script's contract, for the one failure a reader can
 * act on. `2`, as the read API answers the same failure: the caller named an
 * address and the host will not give it, which is a usage error rather than this
 * side failing at something it could have done.
 */
function bound(server, port, purpose) {
  return new Promise((listening) => {
    server.once("error", (refused) => {
      die(
        `cannot ${purpose} on 127.0.0.1:${port}: ${refused.message}`,
        "give this run a free port — playwright.config.ts asks the kernel for one per run, so a port taken between that answer and this bind is what this reports",
      );
    });
    server.listen(port, "127.0.0.1", listening);
  });
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

// One change per invocation. The dispatch below is a chain, so a second action
// would be silently dropped by the first branch that matched — and a caller who
// asked for two changes and got one is reading a run that recorded something
// they never asked for, which is the whole failure this script's guards exist to
// prevent. `--activity-detail` is not counted: it is the other half of
// `--record-activity`, and arriving alone is already its own refusal.
const ACTIONS = [
  "stall",
  "settle-dashboard",
  "remove-page-runs",
  "remove-run",
  "grow-worker-session",
  "record-activity",
];
const asked = ACTIONS.filter((action) => args[action] !== undefined);
if (asked.length > 1) {
  die(
    `${asked.map((action) => `--${action}`).join(" and ")} are more than one change`,
    "run this once per change, so each one is the change the caller asked for",
  );
}
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
  // And one this script is allowed to own. Absolute is not enough in front of a
  // recursive delete: `serve` removes the whole directory before rebuilding it,
  // so an absolute path that is somebody else's — a home directory, a source
  // tree, `/` — is exactly the argument that must not be honoured. The temp root
  // is the bound because `playwright.config.ts` makes every workspace with
  // `mkdtempSync(join(tmpdir(), …))`, so nothing this may delete is ever outside
  // it, and the temp root itself is not a workspace either.
  const workspace = resolve(args.workspace);
  const temporary = resolve(tmpdir());
  if (workspace === temporary || !workspace.startsWith(`${temporary}${sep}`)) {
    die(
      `'${args.workspace}' is not a directory under ${temporary}`,
      "pass --workspace a fixture directory inside the temp root, as playwright.config.ts creates it",
    );
  }
  const runsRoot = join(workspace, "runs");
  // The writers guard their own inputs — a run id that reaches a recursive
  // delete, a tool summary that reaches a journal a server is reading — and they
  // do it by throwing. Every one of those is the caller having asked for
  // something this cannot mean, so it is reported as the usage error it is
  // rather than as a stack trace and an undocumented exit code.
  try {
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
      // Both halves or neither, checked in both directions: a tool summary is
      // the tool's name *and* what it was given, and the half of it that arrived
      // alone is a mistyped command rather than a request to serve.
      if (args["activity-detail"] === undefined) {
        die(
          "--record-activity needs --activity-detail",
          "pass --activity-detail the summary the tool call carried",
        );
      }
      recordActivity(
        runsRoot,
        args["record-activity"],
        args["activity-detail"],
      );
    } else if (args["activity-detail"] !== undefined) {
      die(
        "--activity-detail needs --record-activity",
        "pass --record-activity the name of the tool the summary came from",
      );
    } else {
      process.exit(await serve(workspace, port));
    }
  } catch (refused) {
    die(
      refused instanceof Error ? refused.message : String(refused),
      "give the command a value the recorded run could really have held",
    );
  }
}
