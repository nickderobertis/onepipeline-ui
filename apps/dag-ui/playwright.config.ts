import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineConfig } from "@playwright/test";
import { z } from "zod";

/**
 * The loopback address every server here binds, every URL here names, and every
 * readiness check here connects to — one literal, because the whole failure it
 * exists to prevent is two of them disagreeing.
 *
 * An address rather than `localhost`, and named rather than defaulted, because
 * `localhost` is a name a host resolves and this is a number a socket binds. Vite's
 * dev server binds whatever `--host` resolves to and defaults to `localhost`, so on
 * a host whose `/etc/hosts` gives `::1` first — as Ubuntu images with
 * `::1 localhost` do, and Node resolves verbatim since 17 — it listens on `[::1]`
 * alone while Playwright waits on `http://127.0.0.1:<port>`, which is refused for
 * the whole readiness budget. It prints `ready in 253 ms` either way, so the log
 * says a server started and Playwright says one never did. That is a CI failure
 * this tier cannot see from a host where the same name resolves to `127.0.0.1`.
 */
export const LOOPBACK = "127.0.0.1";

/**
 * Everything one run of this tier must not share with another: its ports and the
 * fixture directory its servers build.
 *
 * Concurrent worktrees are the normal state on this host, so two runs of this tier
 * overlapping is normal too — and fixed ports plus one shared fixture path made them
 * collide by construction. The second run's `--strictPort` Vite refuses to start on a
 * port the first is holding, and its fixture server rebuilds, from scratch, the very
 * run directory the first run is asserting against.
 *
 * The choice is made once per *run* rather than once per process: Playwright loads this
 * file again in every worker it forks, and a worker that chose ports of its own would
 * drive servers nobody started. Workers are forked with the runner's environment, so
 * the runner records what it chose there and every later process — worker, teardown —
 * reads that back instead of choosing again.
 */
const port = z.number().int().min(1).max(65535);
/**
 * The fixture directory, held to being one this run could have made.
 *
 * `DAG_UI_E2E_SESSION` is read back from the environment by every process this
 * tier forks, and this value is interpolated into a `webServer` command that
 * Playwright runs through a shell — so it is a trust boundary, and a string is
 * not enough at one. It has to be an absolute path under the OS temp directory
 * carrying the prefix `chooseSession` makes it with, and nothing that a shell
 * would read as anything but a path. `serve-fixture.mjs` refuses a workspace
 * outside the temp root too, because it removes the directory before rebuilding
 * it; this is the same fact checked on the near side of the shell.
 */
const WORKSPACE_PREFIX = "dag-ui-e2e-fixture-";
const fixtureWorkspace = z
  .string()
  .refine((value) => value === join(tmpdir(), basename(value)), {
    message: `must be a path directly under ${tmpdir()}`,
  })
  .refine((value) => basename(value).startsWith(WORKSPACE_PREFIX), {
    message: `must be named ${WORKSPACE_PREFIX}…`,
  })
  .refine((value) => /^[\w./-]+$/.test(value), {
    message:
      "must not carry characters a shell would read as anything but a path",
  });
const sessionSchema = z.object({
  api: port,
  ui: port,
  offlineApi: port,
  offlineUi: port,
  stalledApi: port,
  stalledUi: port,
  workspace: fixtureWorkspace,
});
type Session = z.infer<typeof sessionSchema>;

/**
 * The program that asks the kernel which ports are free; running it is what produces
 * the six numbers.
 *
 * It binds all six at once so they come back distinct, then releases them together —
 * nothing here reserves anything, because a port has to be free for a server to take
 * it. So the answer is "what was free at that instant", and a run choosing at the same
 * instant could in principle be handed the same number; what that produces is a
 * `--strictPort` Vite or the stall server refusing to start, never a run quietly
 * attached to another run's server. Choosing by arithmetic from a base would not even
 * give that: only the kernel knows what is free.
 *
 * It runs in a child process because the answer has to be produced synchronously,
 * before this module finishes evaluating, and binding a socket in Node is not.
 */
const FREE_PORTS_SCRIPT = `
const { createServer } = require("node:net");
const held = Array.from({ length: 6 }, () => createServer());
let bound = 0;
for (const server of held) {
  server.listen(0, "${LOOPBACK}", () => {
    bound += 1;
    if (bound < held.length) return;
    console.log(JSON.stringify(held.map((s) => s.address().port)));
    for (const open of held) open.close();
  });
}
`;

function chooseSession(): Session {
  const [api, ui, offlineApi, offlineUi, stalledApi, stalledUi] = z
    .tuple([port, port, port, port, port, port])
    .parse(
      JSON.parse(
        execFileSync(process.execPath, ["-e", FREE_PORTS_SCRIPT], {
          encoding: "utf8",
        }),
      ),
    );
  return {
    api,
    ui,
    offlineApi,
    offlineUi,
    stalledApi,
    stalledUi,
    workspace: mkdtempSync(join(tmpdir(), WORKSPACE_PREFIX)),
  };
}

function currentSession(): Session {
  const recorded = process.env.DAG_UI_E2E_SESSION;
  if (recorded !== undefined) {
    return sessionSchema.parse(JSON.parse(recorded));
  }
  const chosen = chooseSession();
  process.env.DAG_UI_E2E_SESSION = JSON.stringify(chosen);
  return chosen;
}

const session = currentSession();

/**
 * A second UI origin whose proxy points at a port that refuses every connection. It is
 * how the unreachable-API journey reaches the real failure — a real browser making real
 * requests that really fail — without mocking anything. The stall server below holds
 * that port bound but unlistened, which is what makes it refuse: merely leaving a port
 * free would let a concurrent run's API server take it, and this journey would quietly
 * be driving a reachable API.
 */
export const OFFLINE_UI_URL = `http://${LOOPBACK}:${session.offlineUi}`;
/**
 * A third UI origin whose proxy points at a listener that accepts and never answers,
 * so the app's first read stays in flight and its loading view stays on screen long
 * enough for a real browser to observe it.
 */
export const STALLED_UI_URL = `http://${LOOPBACK}:${session.stalledUi}`;
/**
 * Where the fixture server writes the run directory it serves, rebuilt on every start.
 * A journey needs to name it to change what the server is serving; it is this run's
 * own directory, and it sits outside the checkout, so no tool has to be told to ignore
 * it. `e2e/global-teardown.ts` removes it when the run ends.
 */
export const FIXTURE_WORKSPACE = session.workspace;

export default defineConfig({
  testDir: "./e2e",
  // The gallery lives beside the journeys because it drives the same surfaces against
  // the same stack, but it asserts nothing and writes images; `screenshots.config.ts`
  // selects it, and `just dag-ui-screens` is when it runs.
  testIgnore: "**/*.screens.spec.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  /**
   * Budgeted for this host rather than inherited. Every wait here crosses the browser,
   * the dev server, the axum server and a disk read, and this host runs live agent dispatches
   * beside its own tests, which roughly doubles a journey. Playwright's 5 s / 30 s
   * defaults assume a dedicated runner; the sibling configs driving the same servers
   * already budget for that (`isolation.config.ts`, `screenshots.config.ts`).
   *
   * Neither value can make a failing assertion pass — an element that never arrives
   * still fails, 15 s later.
   */
  expect: { timeout: 15_000 },
  timeout: 120_000,
  // One server serves one run directory, and the live-update journeys change what it
  // is serving, so the journeys share that state and must not run against each other.
  workers: 1,
  fullyParallel: false,
  use: { baseURL: `http://${LOOPBACK}:${session.ui}` },
  /**
   * Every timeout below is a *readiness* budget: how long a process may take to bind
   * its port, not how long it may take to exist. So no command here may build
   * anything. The read API the fixture server serves through is built by
   * `dag-ui:build-api-server`, which `dag-ui:test` and `dag-ui:bootstrap` depend on;
   * `serve-fixture.mjs` finds that binary and refuses in milliseconds when it is
   * absent. A compile here is a wait whose length is the runner's and whatever else
   * holds the cargo lock, and Playwright can only report it as a server that would
   * not start — which is the one thing that was not wrong.
   *
   * Every entry is named and keeps its stdout, because the whole of what Playwright
   * reports when one of them does not become ready is `Timed out waiting 120000ms
   * from config.webServer` — which names neither the server nor the reason. It
   * starts them one at a time, so on a host where that happens the run ends with no
   * record of which of the five it was waiting for, and none of what the four that
   * did start had said. `name` puts that on every line; `stdout: "pipe"` keeps the
   * line each server prints when it binds, which is the one that answers whether it
   * ever did. Playwright discards stdout by default, and here it is the evidence.
   */
  webServer: [
    {
      name: "fixture-api",
      command: `node e2e/fixtures/serve-fixture.mjs --workspace ${FIXTURE_WORKSPACE} --host ${LOOPBACK} --port ${session.api}`,
      url: `http://${LOOPBACK}:${session.api}/healthz`,
      reuseExistingServer: false,
      stdout: "pipe",
      timeout: 120_000,
    },
    {
      name: "ui",
      command: `npx vite --config vite.config.ts --host ${LOOPBACK} --port ${session.ui} --strictPort`,
      url: `http://${LOOPBACK}:${session.ui}`,
      env: { DAG_UI_API_URL: `http://${LOOPBACK}:${session.api}` },
      reuseExistingServer: false,
      stdout: "pipe",
      timeout: 120_000,
    },
    {
      name: "stalled-api",
      command: `node e2e/fixtures/serve-fixture.mjs --stall --host ${LOOPBACK} --port ${session.stalledApi} --refuse-port ${session.offlineApi}`,
      /**
       * Readiness is what this server says, because it is the one server here that
       * answers nothing when it is working — an accepted connection is all a
       * reader could ask it for, and Playwright's `port` check asks the host that
       * question rather than this process: it says *something* is listening on that
       * number, which is also true of anything else that took it. The line says
       * this process took both of its ports. `port` stays alongside it for the
       * check Playwright makes before starting anything, which is what refuses a
       * port another run is already holding.
       */
      port: session.stalledApi,
      wait: {
        stdout: new RegExp(
          `serve-fixture: stalling on ${LOOPBACK.replaceAll(".", "\\.")}:${session.stalledApi}\\b`,
        ),
      },
      reuseExistingServer: false,
      stdout: "pipe",
      timeout: 120_000,
    },
    {
      name: "stalled-ui",
      command: `npx vite --config vite.config.ts --host ${LOOPBACK} --port ${session.stalledUi} --strictPort`,
      url: STALLED_UI_URL,
      env: { DAG_UI_API_URL: `http://${LOOPBACK}:${session.stalledApi}` },
      reuseExistingServer: false,
      stdout: "pipe",
      timeout: 120_000,
    },
    {
      name: "offline-ui",
      command: `npx vite --config vite.config.ts --host ${LOOPBACK} --port ${session.offlineUi} --strictPort`,
      url: OFFLINE_UI_URL,
      env: { DAG_UI_API_URL: `http://${LOOPBACK}:${session.offlineApi}` },
      reuseExistingServer: false,
      stdout: "pipe",
      timeout: 120_000,
    },
  ],
});
