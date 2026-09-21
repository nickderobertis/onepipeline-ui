import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_V2_PATHS } from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";

/**
 * Shutting a run, the session's runs, or the whole host down from the browser.
 *
 * These journeys **confirm real shutdowns**, and a shutdown really signals
 * processes and really pushes branches — so each one drives a server of its own
 * over a corpus written for it alone (`runs.mjs`'s shutdown corpus), in a fresh
 * workspace, started before the journey and stopped after it. Nothing another
 * journey reads is touched, and every journey starts from runs no shutdown has
 * held yet.
 *
 * What the corpus names on this host, and so what a shutdown here can signal, is
 * nothing but the one process the live-dispatch journey spawns for that purpose:
 * every launch record is another host's, and no registry names any other pid.
 * The server runs under an empty `ONEVCS_HOME` in the workspace, so the one
 * branch the corpus names is refused preservation before any repository is
 * touched, and the host's other unpublished branches are read from nothing.
 *
 * The network is held or ended only where a journey is about exactly that — a
 * request held open, and a connection that drops — and even then the answer read
 * back is the server's own, forwarded; nothing here writes a response.
 */

const FIXTURE_COMMAND = join(import.meta.dirname, "fixtures/serve-fixture.mjs");
const LOOPBACK = "127.0.0.1";

/** What the shutdown corpus published about itself. */
const factsSchema = z.object({
  runs: z.object({
    mine: z.string().min(1),
    idle: z.string().min(1),
    elsewhere: z.string().min(1),
    unattributed: z.string().min(1),
  }),
  identity: z.string().min(1),
  branch: z.string().min(1),
  live_node: z.string().min(1),
});
type ShutdownFacts = z.infer<typeof factsSchema>;

interface ShutdownServer {
  readonly origin: string;
  readonly workspace: string;
  readonly facts: ShutdownFacts;
  readonly stop: () => Promise<void>;
}

/** A port the kernel says is free now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("the kernel named no port")),
      );
    });
  });
}

/** Wait for `child` to exit, however it ends. */
const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()));

/**
 * Start a read API over a fresh shutdown corpus, the view beside it, and wait
 * until it answers. `livePid` is a process this journey started, recorded as
 * the in-flight run's live dispatch.
 */
async function startServer(livePid?: number): Promise<ShutdownServer> {
  // `dag-ui-e2e-…` directly under the temp root: the one shape
  // `serve-fixture.mjs` agrees to remove and rebuild.
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-e2e-shutdown-"));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      FIXTURE_COMMAND,
      "--workspace",
      workspace,
      "--port",
      String(port),
      "--ui",
      "--shutdown-corpus",
      ...(livePid === undefined
        ? []
        : ["--live-dispatch-pid", String(livePid)]),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const origin = `http://${LOOPBACK}:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`the shutdown fixture server exited ${child.exitCode}`);
    const ready = await fetch(`${origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error(
        `the shutdown fixture server never answered on ${origin}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    origin,
    workspace,
    facts: factsSchema.parse(
      JSON.parse(readFileSync(join(workspace, "fixture-facts.json"), "utf8")),
    ),
    stop: async () => {
      child.kill("SIGTERM");
      await exited(child);
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** One shutdown request the browser sent: where, and the body as it went. */
interface Sent {
  readonly path: string;
  readonly body: string | null;
}

/** Every shutdown request the page sends from now on, as sent. */
function shutdownsSent(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/shutdown"))
      sent.push({ path: url.pathname, body: request.postData() });
  });
  return sent;
}

/** A run timeline, as far as this file reads one: the kinds of its events. */
const timelineSchema = z.object({
  spans: z.array(
    z.object({
      events: z.array(z.object({ kind: z.string() })).optional(),
    }),
  ),
});

/**
 * The corpus runs whose own record, read through the API, says a host shutdown
 * put them down — the `host-shutdown` the engine journals once it is done with
 * a run.
 */
async function shutDownRuns(server: ShutdownServer): Promise<string[]> {
  const runs = Object.values(server.facts.runs);
  const recorded = await Promise.all(
    runs.map(async (run) => {
      const response = await fetch(
        `${server.origin}/api/v2/runs/${run}/timeline?scope=run`,
      );
      expect(response.status).toBe(200);
      const timeline = timelineSchema.parse(await response.json());
      return timeline.spans.some((span) =>
        (span.events ?? []).some(({ kind }) => kind === "host-shutdown"),
      );
    }),
  );
  return runs.filter((_, index) => recorded[index]);
}

const FORCE_WORDS =
  "Force: skip the interrupt and the wait and go straight to the teardown — whatever a worker had not committed is lost.";

const dialogOf = (page: Page): Locator => page.getByRole("dialog");

/** The items of one named list, as their text. */
const itemsOf = (list: Locator): Promise<string[]> =>
  list.getByRole("listitem").allInnerTexts();

/** Open a run's view on the server's own origin, with its header acting. */
async function openRun(
  page: Page,
  server: ShutdownServer,
  run: string,
): Promise<void> {
  await page.goto(`${server.origin}/?list=runs&run=${run}`);
  // The header's title, which the overall view repeats beneath it.
  await expect(
    page.getByRole("heading", { name: run, exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByLabel(/^\d+ unwatched$/)).toBeVisible();
}

/** Set the dialog's grace and read back that it holds it. */
async function setGrace(
  dialog: Locator,
  amount: string,
  unit: "minutes" | "seconds",
): Promise<void> {
  const grace = dialog.getByRole("spinbutton", { name: "Grace" });
  await grace.fill(amount);
  await dialog.getByRole("combobox", { name: "Grace unit" }).selectOption(unit);
  await expect(grace).toHaveValue(amount);
}

/** The force checkbox, held to the words it is labelled with and its default. */
async function expectForceOffAndSaid(dialog: Locator): Promise<Locator> {
  const force = dialog.getByRole("checkbox");
  await expect(force).toHaveAccessibleName(FORCE_WORDS);
  await expect(dialog).toContainText(
    "whatever a worker had not committed is lost",
  );
  await expect(force).not.toBeChecked();
  return force;
}

let server: ShutdownServer | undefined;
let sleeper: ChildProcess | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
  // Only ever the process this file started, by the handle it was started with.
  if (sleeper !== undefined && sleeper.exitCode === null) sleeper.kill();
  sleeper = undefined;
});

// llmlint: ignore-block[expensive_tests_stay_behind_their_own_edge] measured rather than assumed: the eight journeys below took 26.4 s together on this host (2.3 s to 5.8 s each, the longest waiting out a real three-second grace), the same per-journey cost as the rest of this project (133 journeys in 4.7 min). Each needs only what `dag-ui-e2e:test` already depends on — the built bundle and the API server — and what they exercise is the app's header, navigation and shutdown feature, so an edge narrower than `dag-ui` would drop them out of `nx affected` for exactly the changes they exist to catch.
test("shuts one run down: the dialog names it and its owner, cancel sends nothing, and the grace confirmed is the grace sent", async ({
  page,
}) => {
  server = await startServer();
  const { runs, identity, branch } = server.facts;
  const sent = shutdownsSent(page);
  await openRun(page, server, runs.mine);

  const control = page.getByRole("button", { name: "Shut down this run" });
  await control.click();
  let dialog = dialogOf(page);
  await expect(dialog).toHaveAccessibleName(`Shut down ${runs.mine}?`);
  const named = dialog.getByRole("list", {
    name: "Runs this shutdown acts on",
  });
  await expect(named.getByRole("listitem")).toHaveCount(1);
  expect(await itemsOf(named)).toEqual([
    expect.stringMatching(
      new RegExp(`^${runs.mine} — owned by this session \\(Claude session · `),
    ),
  ]);
  await expectForceOffAndSaid(dialog);
  await expect(dialog.getByRole("spinbutton", { name: "Grace" })).toHaveValue(
    "10",
  );
  await expect(
    dialog.getByRole("combobox", { name: "Grace unit" }),
  ).toHaveValue("minutes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toEqual([]);

  // The keyboard path, all the way to the request.
  await control.focus();
  await page.keyboard.press("Enter");
  dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await setGrace(dialog, "45", "seconds");
  await dialog.getByRole("button", { name: "Shut down run" }).focus();
  const request = page.waitForRequest(
    (sentRequest) =>
      sentRequest.method() === "POST" &&
      sentRequest.url().endsWith(API_V2_PATHS.runShutdown(runs.mine)),
  );
  await page.keyboard.press("Enter");
  await request;
  await expect(dialog).toBeHidden();

  // The report: this run's branch is on an identity no registry holds, so the
  // engine could not preserve it — and the report says the shutdown is not
  // complete rather than reading as a success.
  const report = page.getByRole("alert", { name: "Run shutdown report" });
  await expect(report).toContainText("Shutdown incomplete");
  await expect(report).not.toContainText("Shutdown complete");
  await expect(report).toContainText("Not everything went as asked");
  await expect(report).toContainText("scope run");
  await expect(report).toContainText("grace 45 seconds");
  await expect(
    report.getByRole("region", { name: `Shutdown of ${runs.mine}` }),
  ).toContainText(`${runs.mine} · owner [mine]`);
  await expect(report).toContainText("No live dispatch to interrupt.");
  await expect(report).toContainText("Teardown: elsewhere");
  await expect(
    report.getByRole("list", { name: `Branches of ${runs.mine}` }),
  ).toContainText(
    `${identity}@${branch}: could not be preserved — invalid input: "${identity}" is not a registered repository`,
  );
  await expect(report).toContainText(
    "Other unpublished branches on this host: none.",
  );
  expect(sent).toEqual([
    {
      path: API_V2_PATHS.runShutdown(runs.mine),
      body: '{"grace":45,"force":false}',
    },
  ]);
  expect(await shutDownRuns(server)).toEqual([runs.mine]);
});

test("shuts one run down forced when the force is ticked, and a complete shutdown reads as complete", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  const sent = shutdownsSent(page);
  await openRun(page, server, runs.idle);
  await page.getByRole("button", { name: "Shut down this run" }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toContainText(
    `${runs.idle} — owned by this session (Claude session · `,
  );
  const force = await expectForceOffAndSaid(dialog);
  await force.check();
  await dialog.getByRole("button", { name: "Shut down run" }).click();
  const report = page.getByRole("alert", { name: "Run shutdown report" });
  await expect(report).toContainText("Shutdown complete");
  await expect(report).toContainText("forced");
  await expect(report).toContainText("No branch this run's records name.");
  expect(sent).toEqual([
    {
      path: API_V2_PATHS.runShutdown(runs.idle),
      body: '{"grace":600,"force":true}',
    },
  ]);
});

test("shuts down all my runs: the dialog names exactly the runs this session owns, and the scope and grace are what is sent", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  const sent = shutdownsSent(page);
  await page.goto(`${server.origin}/?list=runs`);
  await page
    .getByRole("group", { name: "Shut down runs on this host" })
    .getByRole("button", { name: "Shut down all my runs" })
    .click();
  const dialog = dialogOf(page);
  await expect(dialog).toHaveAccessibleName("Shut down all my runs?");
  const named = dialog.getByRole("list", {
    name: "Runs this shutdown acts on",
  });
  await expect(named.getByRole("listitem")).toHaveCount(2);
  const items = await itemsOf(named);
  for (const run of [runs.mine, runs.idle])
    expect(items).toContainEqual(
      expect.stringMatching(
        new RegExp(`^${run} — owned by this session \\(Claude session · `),
      ),
    );
  await expect(dialog).toContainText(
    "It acts on the 2 runs this session owns, and on no other session's",
  );
  await expect(dialog).not.toContainText(runs.elsewhere);
  await expect(dialog).not.toContainText(runs.unattributed);
  await expectForceOffAndSaid(dialog);
  await setGrace(dialog, "1", "minutes");
  await dialog.getByRole("button", { name: "Shut down my runs" }).click();

  const report = page.getByRole("alert", {
    name: "Shutdown of all my runs report",
  });
  await expect(report).toContainText("scope mine");
  for (const run of [runs.mine, runs.idle])
    await expect(
      report.getByRole("region", { name: `Shutdown of ${run}` }),
    ).toContainText(`${run} · owner [mine]`);
  await expect(report).not.toContainText(runs.elsewhere);
  expect(sent).toEqual([
    {
      path: API_V2_PATHS.shutdown,
      body: '{"scope":"mine","grace":60,"force":false}',
    },
  ]);
  expect((await shutDownRuns(server)).sort()).toEqual(
    [runs.idle, runs.mine].sort(),
  );
});

test("shuts the entire host down: the dialog says in words it acts on runs other sessions own, and names them and their owners", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  const sent = shutdownsSent(page);
  await page.goto(`${server.origin}/?list=runs`);
  await page
    .getByRole("group", { name: "Shut down runs on this host" })
    .getByRole("button", { name: "Shut down the entire host" })
    .click();
  const dialog = dialogOf(page);
  await expect(dialog).toHaveAccessibleName("Shut down the entire host?");
  await expect(dialog).toContainText(
    "It acts on 2 runs other sessions own (or that no session is recorded as owning), over their owners — each is interrupted, torn down and pushed as if it were yours",
  );
  const others = dialog.getByRole("list", { name: "Runs other sessions own" });
  const otherItems = await itemsOf(others);
  expect(otherItems).toHaveLength(2);
  expect(otherItems).toContainEqual(
    expect.stringMatching(
      new RegExp(`^${runs.elsewhere} — owned by Codex session · `),
    ),
  );
  expect(otherItems).toContainEqual(
    expect.stringMatching(
      new RegExp(`^${runs.unattributed} — owned by Unattributed launch · `),
    ),
  );
  const own = await itemsOf(
    dialog.getByRole("list", { name: "Runs this session owns" }),
  );
  expect(own).toHaveLength(2);
  await expectForceOffAndSaid(dialog);
  await setGrace(dialog, "30", "seconds");
  await dialog.getByRole("button", { name: "Shut down the host" }).click();

  const report = page.getByRole("alert", {
    name: "Shutdown of the entire host report",
  });
  await expect(report).toContainText("Shutdown incomplete");
  await expect(
    report.getByRole("region", { name: `Shutdown of ${runs.elsewhere}` }),
  ).toContainText(
    `${runs.elsewhere} · owner [codex:160c290a] — another session's run, acted on over its owner`,
  );
  await expect(
    report.getByRole("region", { name: `Shutdown of ${runs.unattributed}` }),
  ).toContainText("another session's run, acted on over its owner");
  expect(sent).toEqual([
    {
      path: API_V2_PATHS.shutdown,
      body: '{"scope":"host","grace":30,"force":false}',
    },
  ]);
  expect((await shutDownRuns(server)).sort()).toEqual(
    Object.values(runs).sort(),
  );
});

test("cancelling any of the three sends nothing and holds no run", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  const sent = shutdownsSent(page);
  await openRun(page, server, runs.mine);

  await page.getByRole("button", { name: "Shut down this run" }).click();
  await expect(dialogOf(page)).toContainText(runs.mine);
  await dialogOf(page).getByRole("checkbox").check();
  await dialogOf(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialogOf(page)).toBeHidden();

  const host = page.getByRole("group", { name: "Shut down runs on this host" });
  await host.getByRole("button", { name: "Shut down all my runs" }).click();
  await expect(
    dialogOf(page).getByRole("list", { name: "Runs this shutdown acts on" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toBeHidden();

  await host.getByRole("button", { name: "Shut down the entire host" }).click();
  await expect(
    dialogOf(page).getByRole("list", { name: "Runs other sessions own" }),
  ).toBeVisible();
  await dialogOf(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialogOf(page)).toBeHidden();

  // A confirm sends as it is clicked, so a dialog that sent anything has done
  // so by now; nothing did, and no run records having been shut down.
  expect(sent).toEqual([]);
  expect(await shutDownRuns(server)).toEqual([]);
  // And no control shows a shutdown under way: every status region is absent.
  await expect(page.getByRole("region", { name: /shutdown/i })).toHaveCount(0);
});

// llmlint: ignore-block[e2e_not_mocked] nothing is doubled: the request is forwarded to the real `onepipeline-api serve` this journey started, the engine performs the real shutdown, and the bytes the browser reads are that server's own answer, fulfilled unchanged. What the route changes is *when* the browser receives it — the one condition this journey is about, which no corpus can produce on demand: a shutdown with nothing live to wait for answers in milliseconds, and one with a real grace to wait out answers in minutes.
test("while the answer is held open the control shows the shutdown proceeding, with the engine's records as evidence, then the report", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let forwarded = false;
  await page.route(
    `**${API_V2_PATHS.runShutdown(runs.idle)}`,
    async (route) => {
      const answer = await route.fetch();
      forwarded = true;
      await released;
      await route.fulfill({ response: answer });
    },
  );
  await openRun(page, server, runs.idle);
  await page.getByRole("button", { name: "Shut down this run" }).click();
  await setGrace(dialogOf(page), "20", "seconds");
  await dialogOf(page).getByRole("button", { name: "Shut down run" }).click();

  const status = page.getByRole("region", { name: "Run shutdown" });
  const proceeding = status.getByRole("status");
  await expect(proceeding).toContainText("Shutdown in progress");
  await expect(proceeding).toContainText(
    "still waiting for the engine's answer",
  );
  await expect(proceeding).toContainText(
    /Waiting out the 20 seconds grace until \d{2}:\d{2}:\d{2}/,
  );
  // The engine has done its work while the answer is held: the run's record of
  // it reaches the view through the live listing, and is shown as progress.
  await expect.poll(() => forwarded).toBe(true);
  await expect(
    proceeding.getByRole("list", { name: "Recorded so far" }),
  ).toContainText(`${runs.idle}: put down — host-shutdown recorded`);
  await expect(proceeding).toContainText("1 of 1 run has recorded");
  await expect(
    page.getByRole("button", { name: "Shut down this run" }),
  ).toBeDisabled();
  await expect(status.getByRole("alert")).toHaveCount(0);

  release();
  const report = status.getByRole("alert", { name: "Run shutdown report" });
  await expect(report).toContainText("Shutdown complete");
  await expect(status.getByRole("status")).toHaveCount(0);
});
// llmlint: ignore-end[e2e_not_mocked]

// llmlint: ignore-block[e2e_not_mocked] nothing answers in the server's place: the request is held and then its connection is reset, which is a network condition — the one this journey is about — and never a response. No corpus can make a server drop a connection mid-request on cue, and stopping the whole server would take the page's own view with it, since this origin serves both.
test("a request whose connection drops is shown lost — not proceeding, and with no report", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  let drop: () => void = () => undefined;
  const dropped = new Promise<void>((resolve) => {
    drop = resolve;
  });
  await page.route(
    `**${API_V2_PATHS.runShutdown(runs.idle)}`,
    async (route) => {
      await dropped;
      await route.abort("connectionreset");
    },
  );
  await openRun(page, server, runs.idle);
  await page.getByRole("button", { name: "Shut down this run" }).click();
  await dialogOf(page).getByRole("button", { name: "Shut down run" }).click();
  const status = page.getByRole("region", { name: "Run shutdown" });
  await expect(status.getByRole("status")).toContainText(
    "Shutdown in progress",
  );

  drop();
  const lost = status.getByRole("alert", { name: "Run shutdown lost" });
  await expect(lost).toContainText("Shutdown lost: no answer came back");
  await expect(lost).toContainText(
    "The engine may still be carrying out the shutdown — check the runs before sending another",
  );
  await expect(status.getByRole("status")).toHaveCount(0);
  await expect(status).not.toContainText("Shutdown in progress");
  await expect(status).not.toContainText(/Shutdown (complete|incomplete)/);
  await expect(
    page.getByRole("alert", { name: "Run shutdown report" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Shut down this run" }),
  ).toBeEnabled();
});
// llmlint: ignore-end[e2e_not_mocked]

test("a live dispatch that outlasts the grace is killed, and the report says so and reads as not complete", async ({
  page,
}) => {
  // The engine proves a dispatch by the start token Linux keeps for it; there is
  // no such record to write for a process on another platform.
  test.skip(
    process.platform !== "linux",
    "a dispatch's start token is read from /proc",
  );
  // The one process a shutdown here may signal: this journey's own, which
  // ignores the interrupt it has no turn for and outlasts any grace below.
  sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  const pid = sleeper.pid;
  if (pid === undefined) throw new Error("sleep did not start");
  const ended = exited(sleeper);
  server = await startServer(pid);
  const { runs, live_node } = server.facts;
  await openRun(page, server, runs.mine);
  await page.getByRole("button", { name: "Shut down this run" }).click();
  await setGrace(dialogOf(page), "3", "seconds");
  await dialogOf(page).getByRole("button", { name: "Shut down run" }).click();
  await expect(
    page.getByRole("region", { name: "Run shutdown" }).getByRole("status"),
  ).toContainText(/Waiting out the 3 seconds grace until \d{2}:\d{2}:\d{2}/);

  const report = page.getByRole("alert", { name: "Run shutdown report" });
  await expect(report).toContainText("Shutdown incomplete");
  await expect(
    report.getByRole("list", { name: `Dispatches of ${runs.mine}` }),
  ).toContainText(`${live_node} (pid ${pid}): interrupt no-turn; ended killed`);
  await expect(report).toContainText("Teardown: signalled");
  await ended;
  expect(sleeper.signalCode).toBe("SIGTERM");
});
// llmlint: ignore-end[expensive_tests_stay_behind_their_own_edge]
