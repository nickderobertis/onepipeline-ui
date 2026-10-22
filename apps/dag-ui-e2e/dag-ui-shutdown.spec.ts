import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { API_V2_PATHS, runListSchema } from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { exited, startFixtureServer } from "./fixture-server";

/**
 * Shutting the whole host down from the browser.
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

/**
 * Start a read API over a fresh shutdown corpus, the view beside it, and wait
 * until it answers. `livePid` is a process this journey started, recorded as
 * the in-flight run's live dispatch.
 */
async function startServer(livePid?: number): Promise<ShutdownServer> {
  const server = await startFixtureServer("shutdown", [
    "--shutdown-corpus",
    ...(livePid === undefined ? [] : ["--live-dispatch-pid", String(livePid)]),
  ]);
  return { ...server, facts: factsSchema.parse(server.facts) };
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

// llmlint: ignore-block[expensive_tests_stay_behind_their_own_edge] these host-shutdown journeys need only the built browser and read API already owned by this tier. Each uses an isolated fixture server; the one real grace waits three seconds. There is no additional host prerequisite or reusable expensive setup to put behind a narrower project edge.

test("shuts the entire host down: the dialog says in words it acts on runs other sessions own, and names them and their owners", async ({
  page,
}) => {
  server = await startServer();
  const { runs } = server.facts;
  const sent = shutdownsSent(page);
  const listing = await page.request.get(`${server.origin}/api/v2/runs`);
  expect(listing.status()).toBe(200);
  const rows = runListSchema.parse(await listing.json()).runs;
  const ownSession = rows.find((row) => row.run_id === runs.mine)?.launch
    ?.session_key;
  const otherSession = rows.find((row) => row.run_id === runs.elsewhere)?.launch
    ?.session_key;
  expect(ownSession).toBeDefined();
  expect(otherSession).toBeDefined();
  expect(otherSession).not.toBe(ownSession);
  await page.goto(`${server.origin}/?list=runs`);
  await page
    .getByRole("group", { name: "Shut down runs on this host" })
    .getByRole("button", { name: "Shut down the entire host" })
    .click();
  const dialog = dialogOf(page);
  await expect(dialog).toHaveAccessibleName("Shut down the entire host?");
  await expect(dialog).toContainText("over their owners");
  const items = await itemsOf(
    dialog.getByRole("list", { name: "Runs on this host" }),
  );
  expect(items).toHaveLength(4);
  expect(items).toEqual(
    expect.arrayContaining([
      `${runs.mine} — owned by Claude session · ${ownSession}`,
      `${runs.idle} — owned by Claude session · ${ownSession}`,
      `${runs.elsewhere} — owned by Codex session · ${otherSession}`,
      `${runs.unattributed} — owned by Unattributed launch · shutdown…`,
    ]),
  );
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

test("confirms an empty host shutdown after correcting an invalid grace", async ({
  page,
}) => {
  server = await startServer();
  const root = join(server.workspace, "runs");
  rmSync(root, { recursive: true });
  mkdirSync(root);
  const sent = shutdownsSent(page);
  await page.goto(`${server.origin}/?list=runs`);
  await page.getByRole("button", { name: "Shut down the entire host" }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toContainText("all 0 runs on this host");
  await expect(
    dialog.getByRole("list", { name: "Runs on this host" }),
  ).toBeAttached();
  await expect(dialog.getByRole("listitem")).toHaveCount(0);
  const confirm = dialog.getByRole("button", { name: "Shut down the host" });
  await setGrace(dialog, "-1", "seconds");
  await expect(confirm).toBeDisabled();
  expect(sent).toEqual([]);
  await setGrace(dialog, "0", "seconds");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    page.getByRole("alert", { name: "Shutdown of the entire host report" }),
  ).toContainText("Shutdown complete");
  expect(sent).toEqual([
    {
      path: API_V2_PATHS.shutdown,
      body: '{"scope":"host","grace":0,"force":false}',
    },
  ]);
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
  await page.route(`**${API_V2_PATHS.shutdown}`, async (route) => {
    const answer = await route.fetch();
    forwarded = true;
    await released;
    await route.fulfill({ response: answer });
  });
  await openRun(page, server, runs.idle);
  await page.getByRole("button", { name: "Shut down the entire host" }).click();
  await setGrace(dialogOf(page), "20", "seconds");
  await dialogOf(page)
    .getByRole("button", { name: "Shut down the host" })
    .click();

  const status = page.getByRole("region", {
    name: "Shutdown of the entire host",
  });
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
  await expect(proceeding).toContainText("4 of 4 runs have recorded");
  await expect(
    page.getByRole("button", { name: "Shut down the entire host" }),
  ).toBeDisabled();
  await expect(status.getByRole("alert")).toHaveCount(0);

  release();
  const report = status.getByRole("alert", {
    name: "Shutdown of the entire host report",
  });
  await expect(report).toContainText("Shutdown incomplete");
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
  await page.route(`**${API_V2_PATHS.shutdown}`, async (route) => {
    await dropped;
    await route.abort("connectionreset");
  });
  await openRun(page, server, runs.idle);
  await page.getByRole("button", { name: "Shut down the entire host" }).click();
  await dialogOf(page)
    .getByRole("button", { name: "Shut down the host" })
    .click();
  const status = page.getByRole("region", {
    name: "Shutdown of the entire host",
  });
  await expect(status.getByRole("status")).toContainText(
    "Shutdown in progress",
  );

  drop();
  const lost = status.getByRole("alert", {
    name: "Shutdown of the entire host lost",
  });
  await expect(lost).toContainText("Shutdown lost: no answer came back");
  await expect(lost).toContainText(
    "The engine may still be carrying out the shutdown — check the runs before sending another",
  );
  await expect(status.getByRole("status")).toHaveCount(0);
  await expect(status).not.toContainText("Shutdown in progress");
  await expect(status).not.toContainText(/Shutdown (complete|incomplete)/);
  await expect(
    page.getByRole("alert", { name: "Shutdown of the entire host report" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Shut down the entire host" }),
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
  await page.getByRole("button", { name: "Shut down the entire host" }).click();
  await setGrace(dialogOf(page), "3", "seconds");
  await dialogOf(page)
    .getByRole("button", { name: "Shut down the host" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Shutdown of the entire host" })
      .getByRole("status"),
  ).toContainText(/Waiting out the 3 seconds grace until \d{2}:\d{2}:\d{2}/);

  const report = page.getByRole("alert", {
    name: "Shutdown of the entire host report",
  });
  await expect(report).toContainText("Shutdown incomplete");
  await expect(
    report.getByRole("list", { name: `Dispatches of ${runs.mine}` }),
  ).toContainText(`${live_node} (pid ${pid}): interrupt no-turn; ended killed`);
  await expect(report).toContainText("Teardown: signalled");
  await ended;
  expect(sleeper.signalCode).toBe("SIGTERM");
});
// llmlint: ignore-end[expensive_tests_stay_behind_their_own_edge]
