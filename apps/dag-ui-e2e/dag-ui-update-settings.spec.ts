/**
 * The two update settings, end to end: the navigation and the main area each take
 * what the tab's one stream delivers as their own setting says, and the settings
 * add no request to the tab's traffic.
 *
 * Everything real that can be: the built view served by a real read API, journals
 * grown through the fixture writer the engine's receipts are held to, and items
 * raised by the real `onepipeline human-items` CLI. The browser's clock is the one
 * thing controlled, because an interval is what is under test, and it is paused
 * before a setting is chosen so that a tick falls exactly where the journey says.
 * The stream itself runs on real time, which is why a frame is waited for and a
 * tick is run for.
 */

import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_V2_PATHS,
  type SubscriptionFrame,
  subscriptionFrameSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { appendRecords } from "./load/journal";
import { expandProjects } from "./observatory-locators";

/** How long a journey waits for a change the server pushes: a row can take 5 s. */
const PUSH_PATIENCE = 20_000;
const SUPERVISOR = "claude-code-supervising-session";

const liveFactsSchema = z.object({
  openLiveRun: z.string().min(1),
  otherLiveRuns: z.array(z.string().min(1)).min(2),
  stoppedRun: z.string().min(1),
  liveNode: z.string().min(1),
});
const worldFactsSchema = z.object({
  engine: z.string(),
  cwd: z.string(),
  environment: z.record(z.string(), z.string()),
  removed: z.array(z.string()),
});

let server: FixtureServer | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});
test.use({ viewport: { width: 1440, height: 900 } });

const NAVIGATION = "Navigation updates";
const MAIN = "Main area updates";
type Area = typeof NAVIGATION | typeof MAIN;

const setting = (page: Page, area: Area) =>
  page.getByRole("combobox", { name: area, exact: true });
const waiting = (page: Page, area: Area) =>
  page.getByRole("status", { name: `${area} waiting`, exact: true });
const choose = (page: Page, area: Area, label: string) =>
  setting(page, area).selectOption({ label });

/** What the page sent and what its streams were sent, as it happened. */
interface Wire {
  /** Every API request, as `METHOD path?search`. */
  readonly requests: string[];
  /** Streams the page has open now, and the most it ever had open at once. */
  open: number;
  mostOpen: number;
  /** Every frame received, and the id of the snapshot each subscription answered. */
  readonly frames: SubscriptionFrame[];
  readonly snapshots: string[];
}

async function watch(page: Page): Promise<Wire> {
  const wire: Wire = {
    requests: [],
    open: 0,
    mostOpen: 0,
    frames: [],
    snapshots: [],
  };
  const isStream = (url: URL) => url.pathname === API_V2_PATHS.events;
  const streams = new Set<unknown>();
  const ended = (request: unknown) => {
    if (streams.delete(request)) wire.open -= 1;
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    wire.requests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (isStream(url)) {
      streams.add(request);
      wire.open += 1;
      wire.mostOpen = Math.max(wire.mostOpen, wire.open);
    }
  });
  page.on("requestfailed", ended);
  page.on("requestfinished", ended);
  page.on("response", async (response) => {
    if (
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === API_V2_PATHS.subscriptions &&
      response.status() === 201
    ) {
      const answer = z
        .object({
          initial: z.object({ snapshot: z.object({ id: z.string() }) }),
        })
        .parse(await response.json());
      wire.snapshots.push(answer.initial.snapshot.id);
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    const parsed = subscriptionFrameSchema.safeParse(JSON.parse(event.data));
    if (parsed.success) wire.frames.push(parsed.data);
  });
  return wire;
}

/** Each frame names the one before it as its base, from `from` on. */
function expectInOrder(frames: readonly SubscriptionFrame[], from: string) {
  let cursor = from;
  for (const frame of frames) {
    if (frame.type !== "reset")
      expect(frame.base, `${frame.type} ${frame.id}`).toBe(cursor);
    cursor = frame.id;
  }
}

const journalOf = (served: FixtureServer, run: string) =>
  join(served.workspace, "runs", run, "events.jsonl");
const nextSeq = (served: FixtureServer, run: string) =>
  readFileSync(journalOf(served, run), "utf8").split("\n").filter(Boolean)
    .length;

/** A tool call a node's worker reported, which the run's detail shows. */
function recordActivity(
  served: FixtureServer,
  run: string,
  node: string,
  detail: string,
): void {
  const seq = nextSeq(served, run);
  const stream = `a-recording-host-${run}`;
  appendRecords(journalOf(served, run), [
    {
      v: 1,
      ts: new Date().toISOString(),
      stream,
      seq,
      source: "agentgraph",
      kind: "turn-activity",
      labels: {
        run_id: run,
        node,
        member: "worker",
        persona: "worker",
        session: `${stream}-${node}.worker`,
      },
      payload: {
        kind: "tool_call",
        name: "Bash",
        detail,
        truncated: false,
        index: seq,
      },
      artifacts: [],
    },
  ]);
}

/** The run stops, as far as its row says: what the navigation and Host page show. */
function stopRun(served: FixtureServer, run: string): void {
  appendRecords(journalOf(served, run), [
    {
      v: 1,
      ts: new Date().toISOString(),
      stream: `a-recording-host-${run}`,
      seq: nextSeq(served, run),
      source: "pipeline",
      kind: "run-stopped",
      labels: { run_id: run },
      payload: { forced: false },
      artifacts: [],
    },
  ]);
}

const navigation = (page: Page) =>
  page.getByRole("navigation", { name: "Projects" });
const rowOf = (page: Page, run: string): Locator =>
  navigation(page).getByRole("button", { name: new RegExp(`${run}`) });
/** The state a run's row shows. */
const rowState = (page: Page, run: string): Locator =>
  rowOf(page, run).getByRole("img");

/** The activity line says what the open run's node last did: the main area's change. */
const activity = (page: Page, node: string, marker: string) =>
  page.getByRole("button", { name: `${node}: ${marker}` });

async function serveLive(
  env: Readonly<Record<string, string>> = {},
): Promise<{ served: FixtureServer; facts: z.infer<typeof liveFactsSchema> }> {
  const served = await startFixtureServer(
    "update-settings",
    ["--live-updates-corpus"],
    env,
  );
  server = served;
  return { served, facts: liveFactsSchema.parse(served.facts) };
}

/**
 * Open `path` under a browser clock this journey moves, with every project open.
 * Paused before anything is chosen, so an interval starts exactly when it is chosen.
 */
async function openClocked(page: Page, origin: string, path: string) {
  await page.clock.install();
  await page.goto(`${origin}${path}`);
  await expect(setting(page, NAVIGATION)).toBeVisible();
  await expect(navigation(page).getByRole("status")).toHaveCount(0);
  await page.clock.pauseAt(Date.now() + 1_000);
  await expandProjects(page);
}

const runViewPath = (run: string, node: string) =>
  `/?run=${run}&view=graph&node=${node}`;

test("a first visit shows the defaults, and each setting survives a reload on its own", async ({
  page,
}) => {
  const { served } = await serveLive();
  await page.goto(served.origin);
  await expect(setting(page, NAVIGATION)).toHaveValue("30");
  await expect(setting(page, MAIN)).toHaveValue("live");
  await expect(setting(page, MAIN).getByRole("option")).toHaveText([
    "Live",
    "Every 10 seconds",
    "Every 30 seconds",
    "Every minute",
    "Every 5 minutes",
    "Off",
  ]);

  await choose(page, MAIN, "Every minute");
  await page.reload();
  await expect(setting(page, MAIN)).toHaveValue("60");
  await expect(setting(page, NAVIGATION)).toHaveValue("30");

  await choose(page, NAVIGATION, "Off");
  await page.reload();
  await expect(setting(page, NAVIGATION)).toHaveValue("off");
  await expect(setting(page, MAIN)).toHaveValue("60");
});

test("a remembered word that is no setting, and storage the browser refuses, leave the defaults", async ({
  page,
}) => {
  const { served } = await serveLive();
  await page.addInitScript(() => {
    window.localStorage.setItem("dag-ui.updates.navigation", "whenever");
  });
  await page.goto(served.origin);
  await expect(setting(page, NAVIGATION)).toHaveValue("30");
  await expect(setting(page, MAIN)).toHaveValue("live");

  // A browser that refuses storage still gives the page its settings for the visit.
  const refusing = await page.context().newPage();
  await refusing.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("refused", "SecurityError");
      },
    });
  });
  await refusing.goto(served.origin);
  await expect(setting(refusing, NAVIGATION)).toHaveValue("30");
  await choose(refusing, MAIN, "Off");
  await expect(setting(refusing, MAIN)).toHaveValue("off");
  await expect(refusing.getByRole("alert")).toHaveCount(0);
  await refusing.close();
});

test("the navigation's setting holds its rows: live as they arrive, an interval until it elapses, off until turned on", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const [one, two] = facts.otherLiveRuns as [string, string];
  const three = facts.openLiveRun;
  const wire = await watch(page);
  await openClocked(
    page,
    served.origin,
    runViewPath(facts.openLiveRun, facts.liveNode),
  );
  await expect(setting(page, MAIN)).toHaveValue("live");

  // Live: a row changes as its frame arrives, the clock standing still.
  await choose(page, NAVIGATION, "Live");
  stopRun(served, one);
  await expect(rowState(page, one)).toHaveAccessibleName("ended-stopped", {
    timeout: PUSH_PATIENCE,
  });

  // An interval: the frames arrive and are counted, and nothing shows until it elapses.
  await choose(page, NAVIGATION, "Every 10 seconds");
  const cursor = wire.frames.at(-1)?.id ?? "";
  const rowsBefore = await rowState(page, two).getAttribute("aria-label");
  stopRun(served, two);
  stopRun(served, three);
  await expect(waiting(page, NAVIGATION)).toHaveText("2 waiting", {
    timeout: PUSH_PATIENCE,
  });
  await page.clock.runFor(9_000);
  await expect(rowState(page, two)).toHaveAccessibleName(rowsBefore ?? "");
  await expect(rowState(page, three)).not.toHaveAccessibleName("ended-stopped");
  await page.clock.runFor(1_000);
  await expect(rowState(page, two)).toHaveAccessibleName("ended-stopped");
  await expect(rowState(page, three)).toHaveAccessibleName("ended-stopped");
  await expect(waiting(page, NAVIGATION)).toHaveCount(0);
  const taken = wire.frames.slice(
    wire.frames.findIndex(({ id }) => id === cursor) + 1,
  );
  expect(taken.filter(({ type }) => type === "run.changed")).toHaveLength(2);
  expectInOrder(taken, cursor);

  // Off: nothing shows however long it holds, and the stream stays open for the
  // main area, which is still live.
  await choose(page, NAVIGATION, "Off");
  const gone = facts.stoppedRun;
  await expect(rowOf(page, gone)).toBeVisible();
  rmSync(join(served.workspace, "runs", gone), { recursive: true });
  await expect(waiting(page, NAVIGATION)).toHaveText("1 waiting", {
    timeout: PUSH_PATIENCE,
  });
  await page.clock.runFor(600_000);
  await expect(rowOf(page, gone)).toBeVisible();
  expect(wire.open).toBe(1);

  // Turned on, what was held shows at once.
  await choose(page, NAVIGATION, "Live");
  await expect(rowOf(page, gone)).toHaveCount(0);
  await expect(waiting(page, NAVIGATION)).toHaveCount(0);
  expect(wire.mostOpen).toBe(1);
});

test("the main area's setting holds its view: live as it arrives, an interval until it elapses, off until turned on", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  const wire = await watch(page);
  await openClocked(page, served.origin, runViewPath(run, node));
  await choose(page, NAVIGATION, "Off");

  await expect(setting(page, MAIN)).toHaveValue("live");
  recordActivity(served, run, node, "live change");
  await expect(activity(page, node, "live change")).toBeVisible({
    timeout: PUSH_PATIENCE,
  });

  await choose(page, MAIN, "Every 30 seconds");
  const cursor = wire.frames.at(-1)?.id ?? "";
  recordActivity(served, run, node, "first held change");
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  recordActivity(served, run, node, "second held change");
  await expect
    .poll(
      () =>
        wire.frames.filter(
          ({ type }, at, all) =>
            at > all.findIndex(({ id }) => id === cursor) &&
            type === "detail.patch",
        ).length,
      { timeout: PUSH_PATIENCE },
    )
    .toBeGreaterThanOrEqual(2);
  await page.clock.runFor(29_000);
  await expect(activity(page, node, "live change")).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(activity(page, node, "second held change")).toBeVisible();
  await expect(waiting(page, MAIN)).toHaveCount(0);
  expectInOrder(
    wire.frames.slice(wire.frames.findIndex(({ id }) => id === cursor) + 1),
    cursor,
  );

  // Off: nothing shows however long it holds, and the stream stays open for the
  // navigation, which is on.
  await choose(page, NAVIGATION, "Every minute");
  await choose(page, MAIN, "Off");
  recordActivity(served, run, node, "change under off");
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  await page.clock.runFor(600_000);
  await expect(activity(page, node, "second held change")).toBeVisible();
  expect(wire.open).toBe(1);

  await choose(page, MAIN, "Live");
  await expect(activity(page, node, "change under off")).toBeVisible();
  await expect(waiting(page, MAIN)).toHaveCount(0);
  expect(wire.mostOpen).toBe(1);
});

/** `onepipeline ARGS…` in the served world, as the session that owns its items. */
function cli(served: FixtureServer, args: string[]): string {
  const facts = worldFactsSchema.parse(served.facts);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of facts.removed) delete env[name];
  Object.assign(env, facts.environment, {
    ONEPIPELINE_LAUNCHER_SESSION: SUPERVISOR,
  });
  return execFileSync(facts.engine, args, {
    cwd: facts.cwd,
    env,
    encoding: "utf8",
  });
}

/** Raise an item through the real CLI: its change reaches a page as a frame. */
function raise(served: FixtureServer, title: string): void {
  const { cwd } = worldFactsSchema.parse(served.facts);
  const input = join(cwd, `raise-${title.replaceAll(" ", "-")}.json`);
  writeFileSync(
    input,
    JSON.stringify({
      schema_version: 1,
      dedup_key: title.replaceAll(" ", "-"),
      kind: "task",
      title,
      body: `What ${title} needs from a person.`,
      priority: "medium",
      owner: { session: SUPERVISOR, run: null, plan: null },
      block: { scope: "nothing" },
      approval: null,
    }),
  );
  cli(served, ["human-items", "raise", "--input", input]);
}

async function serveWorld(): Promise<FixtureServer> {
  server = await startFixtureServer("update-settings-items", [
    "--human-items-world",
    "queue",
  ]);
  return server;
}

const itemList = (page: Page) =>
  page.getByRole("region", { name: "Action item list" });
const itemCard = (page: Page, title: string) =>
  itemList(page).getByRole("heading", { name: title, exact: true });

test("Action items are held the same way as raised items arrive through the real CLI", async ({
  page,
}) => {
  const served = await serveWorld();
  const wire = await watch(page);
  await openClocked(page, served.origin, "/human-items");
  await expect(itemCard(page, "Restore the build service")).toBeVisible();
  await choose(page, NAVIGATION, "Off");

  // Live: a raised item shows as its frame arrives.
  raise(served, "Raised while live");
  await expect(itemCard(page, "Raised while live")).toBeVisible({
    timeout: PUSH_PATIENCE,
  });
  await expect(page.getByRole("status", { name: /waiting/ })).toHaveCount(0);
  const answered = wire.frames.filter(
    ({ type }) => type === "human-items.patch",
  );
  expect(answered.length).toBeGreaterThan(0);

  // An interval: nothing until it elapses, then every raised item, in order.
  await choose(page, MAIN, "Every 10 seconds");
  raise(served, "First raised while held");
  raise(served, "Second raised while held");
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  await expect
    .poll(
      () =>
        wire.frames.filter(({ type }) => type === "human-items.patch").length,
      { timeout: PUSH_PATIENCE },
    )
    .toBeGreaterThan(answered.length);
  await page.clock.runFor(9_000);
  await expect(itemCard(page, "First raised while held")).toHaveCount(0);
  await page.clock.runFor(1_000);
  await expect(itemCard(page, "First raised while held")).toBeVisible();
  // The second may have reached the server after the tick's frame: it takes one more.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(10_000);
        return itemCard(page, "Second raised while held").count();
      },
      { timeout: PUSH_PATIENCE },
    )
    .toBe(1);
  const titles = await itemList(page).allInnerTexts();
  expect(titles.join("\n").indexOf("First raised while held")).toBeLessThan(
    titles.join("\n").indexOf("Second raised while held"),
  );

  // Off: none shows, and the count says so; a later Live shows them.
  await choose(page, NAVIGATION, "Every 5 minutes");
  await choose(page, MAIN, "Off");
  raise(served, "Raised under off");
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  await page.clock.runFor(600_000);
  await expect(itemCard(page, "Raised under off")).toHaveCount(0);
  expect(wire.open).toBe(1);
  await choose(page, MAIN, "Live");
  await expect(itemCard(page, "Raised under off")).toBeVisible();
  await expect(waiting(page, MAIN)).toHaveCount(0);
  expect(wire.mostOpen).toBe(1);
});

/**
 * Run every interval through several ticks and hold under Off, with one setting at
 * a time and then both, while `arrive` keeps changes coming; the page sends nothing.
 */
async function holdsWithoutARequest(
  page: Page,
  wire: Wire,
  arrive: (turn: number) => void,
): Promise<void> {
  const before = wire.requests.length;
  let turn = 0;
  for (const [label, seconds] of [
    ["Every 10 seconds", 10],
    ["Every 30 seconds", 30],
    ["Every minute", 60],
    ["Every 5 minutes", 300],
  ] as const) {
    await choose(page, NAVIGATION, label);
    await choose(page, MAIN, label);
    turn += 1;
    arrive(turn);
    for (let tick = 0; tick < 3; tick += 1)
      await page.clock.runFor(seconds * 1000);
  }
  await choose(page, NAVIGATION, "Off");
  arrive(turn + 1);
  await page.clock.runFor(600_000);
  await choose(page, NAVIGATION, "Every 10 seconds");
  await choose(page, MAIN, "Off");
  arrive(turn + 2);
  await page.clock.runFor(600_000);
  // Real time, for the frames that are arriving to reach a page that says nothing.
  await page.waitForTimeout(1_500);
  expect(wire.requests.slice(before)).toStrictEqual([]);
  expect(wire.open).toBe(1);
  expect(wire.mostOpen).toBe(1);
}

test("on a run view, Action items and the Host page, ticks and holds send no request", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const wire = await watch(page);
  await openClocked(
    page,
    served.origin,
    runViewPath(facts.openLiveRun, facts.liveNode),
  );
  await holdsWithoutARequest(page, wire, (turn) =>
    recordActivity(served, facts.openLiveRun, facts.liveNode, `change ${turn}`),
  );

  // The Host page, moved to as a person does: its own reads are taken as it
  // opens and not again.
  await choose(page, MAIN, "Live");
  await navigation(page).getByRole("button", { name: "Host" }).click();
  await expect(
    page.getByRole("region", { name: "Runs on the host" }),
  ).toContainText(facts.openLiveRun);
  await holdsWithoutARequest(page, wire, (turn) =>
    recordActivity(served, facts.openLiveRun, facts.liveNode, `host ${turn}`),
  );
  await server?.stop();
  server = undefined;

  const world = await serveWorld();
  const items = await watch(page);
  await page.goto(`${world.origin}/human-items`);
  await expect(itemCard(page, "Restore the build service")).toBeVisible();
  // The clock stays where this context paused it, across the navigation.
  await holdsWithoutARequest(page, items, (turn) =>
    raise(world, `Arrived on turn ${turn}`),
  );
});

test("a person's write and a navigation choice show at once with both areas held", async ({
  page,
}) => {
  const served = await serveWorld();
  const wire = await watch(page);
  await page.goto(`${served.origin}/human-items`);
  const title = "Restore the build service";
  await expect(itemCard(page, title)).toBeVisible();
  await choose(page, NAVIGATION, "Off");
  await choose(page, MAIN, "Off");
  await expect.poll(() => wire.open).toBe(0);

  await page.getByRole("button", { name: `Complete: ${title}` }).click();
  await expect(itemCard(page, title)).toHaveCount(0, {
    timeout: PUSH_PATIENCE,
  });
  expect(wire.mostOpen).toBeLessThanOrEqual(1);

  // A filter is a person's act too: its answer shows, held or not.
  await page.getByLabel("Priority", { exact: true }).selectOption("low");
  await expect(itemCard(page, "Review the dashboard layout")).toHaveCount(0);

  // As is a navigation choice: the Host page, then a run from its row.
  await navigation(page).getByRole("button", { name: "Host" }).click();
  await expect(
    page.getByRole("region", { name: "Host", exact: true }),
  ).toBeVisible();
});

test("a navigation choice shows the chosen run at once, and a manual Refresh applies what is held", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  const [other] = facts.otherLiveRuns as [string];
  const wire = await watch(page);
  await page.goto(`${served.origin}${runViewPath(run, node)}`);
  await expect(setting(page, NAVIGATION)).toBeVisible();
  await expandProjects(page);
  await choose(page, NAVIGATION, "Off");
  await choose(page, MAIN, "Every 5 minutes");

  recordActivity(served, run, node, "held for Refresh");
  stopRun(served, other);
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  await expect(waiting(page, NAVIGATION)).toBeVisible({
    timeout: PUSH_PATIENCE,
  });

  // Refresh shows both and sends the read it always has: a new subscription.
  const before = wire.requests.length;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(activity(page, node, "held for Refresh")).toBeVisible();
  await expect(rowState(page, other)).toHaveAccessibleName("ended-stopped");
  await expect(waiting(page, MAIN)).toHaveCount(0);
  await expect(waiting(page, NAVIGATION)).toHaveCount(0);
  await expect
    .poll(() =>
      wire.requests
        .slice(before)
        .some((request) => request === `POST ${API_V2_PATHS.subscriptions}`),
    )
    .toBe(true);

  // With both off, that one read and no stream.
  await choose(page, MAIN, "Off");
  await expect.poll(() => wire.open).toBe(0);
  const closed = wire.requests.length;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect
    .poll(() =>
      wire.requests
        .slice(closed)
        .filter((request) => request.startsWith("POST")),
    )
    .toHaveLength(1);
  await page.waitForTimeout(1_000);
  expect(wire.open).toBe(0);
  expect(
    wire.requests.slice(closed).filter((r) => r.includes(API_V2_PATHS.events)),
  ).toStrictEqual([]);

  // A navigation choice is a new subscription whose snapshot shows, held or not.
  await rowOf(page, other).click();
  await expect(page.getByRole("heading", { name: other })).toBeVisible();
  await expect(
    page.getByRole("application", { name: "DAG execution graph" }),
  ).toBeVisible();
  expect(wire.open).toBe(0);
});

test("both off closes the stream; turning one on replays from the last applied event with no whole re-send", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  const wire = await watch(page);
  await page.goto(`${served.origin}${runViewPath(run, node)}`);
  await expect(setting(page, NAVIGATION)).toBeVisible();
  recordActivity(served, run, node, "before closing");
  await expect(activity(page, node, "before closing")).toBeVisible({
    timeout: PUSH_PATIENCE,
  });
  await choose(page, NAVIGATION, "Off");
  await choose(page, MAIN, "Off");
  await expect.poll(() => wire.open).toBe(0);
  const last = wire.frames.at(-1)?.id ?? wire.snapshots.at(-1) ?? "";
  const before = wire.requests.length;
  const framesBefore = wire.frames.length;

  recordActivity(served, run, node, "first while closed");
  recordActivity(served, run, node, "second while closed");
  await page.waitForTimeout(1_500);
  await expect(activity(page, node, "before closing")).toBeVisible();
  expect(wire.requests.slice(before)).toStrictEqual([]);

  await choose(page, MAIN, "Live");
  await expect(activity(page, node, "second while closed")).toBeVisible({
    timeout: PUSH_PATIENCE,
  });
  const resumed = wire.requests.slice(before);
  expect(resumed).toHaveLength(1);
  const url = new URL(resumed[0]?.split(" ")[1] ?? "", served.origin);
  expect(url.pathname).toBe(API_V2_PATHS.events);
  expect(url.searchParams.get("after")).toBe(last);
  const replayed = wire.frames.slice(framesBefore);
  expect(replayed.length).toBeGreaterThan(0);
  expect(replayed.map(({ type }) => type)).not.toContain("reset");
  expectInOrder(replayed, last);
  expect(wire.mostOpen).toBe(1);
});

test("a held replay waits for an interval's next tick, and a Live one shows at once", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  await openClocked(page, served.origin, runViewPath(run, node));
  await choose(page, NAVIGATION, "Off");
  await choose(page, MAIN, "Off");
  recordActivity(served, run, node, "replayed at a tick");
  await page.waitForTimeout(1_500);
  await choose(page, MAIN, "Every 10 seconds");
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  await expect(activity(page, node, "replayed at a tick")).toHaveCount(0);
  await page.clock.runFor(10_000);
  await expect(activity(page, node, "replayed at a tick")).toBeVisible();
});

test("past a disconnected subscription's expiry, turning a setting on recreates the view with resume and renders the reset", async ({
  page,
}) => {
  const { served, facts } = await serveLive({
    ONEPIPELINE_UI_SUBSCRIPTION_GRACE_MS: "1500",
  });
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  const wire = await watch(page);
  await page.goto(`${served.origin}${runViewPath(run, node)}`);
  await expect(setting(page, NAVIGATION)).toBeVisible();
  await expect.poll(() => wire.open).toBe(1);
  await choose(page, NAVIGATION, "Off");
  await choose(page, MAIN, "Off");
  await expect.poll(() => wire.open).toBe(0);
  // Well past the grace above, with nothing asking: a stream opened to look would
  // be what keeps it from expiring.
  await page.waitForTimeout(4_000);
  recordActivity(served, run, node, "past the expiry");

  await choose(page, MAIN, "Live");
  await expect
    .poll(
      () =>
        wire.requests.filter((r) => r === `POST ${API_V2_PATHS.subscriptions}`)
          .length,
      { timeout: PUSH_PATIENCE },
    )
    .toBeGreaterThanOrEqual(2);
  await expect(
    page.getByRole("status").filter({ hasText: "re-sent whole" }),
  ).toContainText("unknown-cursor");
  await expect(activity(page, node, "past the expiry")).toBeVisible({
    timeout: PUSH_PATIENCE,
  });
  expect(wire.mostOpen).toBe(1);
});

test("after the real server restarted, turning a setting on recreates the view with resume and renders the reset", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const run = facts.openLiveRun;
  const node = facts.liveNode;
  const wire = await watch(page);
  await page.goto(`${served.origin}${runViewPath(run, node)}`);
  await expect(setting(page, NAVIGATION)).toBeVisible();
  await expect.poll(() => wire.open).toBe(1);
  await choose(page, NAVIGATION, "Off");
  await choose(page, MAIN, "Off");
  await expect.poll(() => wire.open).toBe(0);
  await served.stopServing();
  await served.serveRebuilt();

  await choose(page, MAIN, "Live");
  await expect(
    page.getByRole("status").filter({ hasText: "re-sent whole" }),
  ).toContainText("server-restarted", { timeout: PUSH_PATIENCE });
  recordActivity(served, run, node, "after the restart");
  await expect(activity(page, node, "after the restart")).toBeVisible({
    timeout: PUSH_PATIENCE,
  });
  expect(wire.mostOpen).toBe(1);
});

test("the Host page's rows take a shown value from the stream, with no new run-list request", async ({
  page,
}) => {
  const { served, facts } = await serveLive();
  const [other] = facts.otherLiveRuns as [string];
  const wire = await watch(page);
  await page.goto(`${served.origin}/?page=host`);
  const listed = page.getByRole("region", { name: "Runs on the host" });
  await expect(listed).toContainText(other);
  await expect(listed.getByText(new RegExp(`^${other} · `))).not.toContainText(
    "ended-stopped",
  );
  const before = wire.requests.length;

  stopRun(served, other);
  await expect(listed.getByText(new RegExp(`^${other} · `))).toContainText(
    "ended-stopped",
    { timeout: PUSH_PATIENCE },
  );
  expect(
    wire.requests
      .slice(before)
      .filter((request) => request.includes(API_V2_PATHS.runs)),
  ).toStrictEqual([]);
  expect(wire.requests.slice(before)).toStrictEqual([]);

  // A run the listing was taken before is listed from its row; a removed one goes.
  const gone = facts.stoppedRun;
  const arrived = "a-run-after-the-listing";
  await expect(listed.getByText(new RegExp(`^${gone} · `))).toBeVisible();
  rmSync(join(served.workspace, "runs", gone), { recursive: true });
  await expect(listed.getByText(new RegExp(`^${gone} · `))).toHaveCount(0, {
    timeout: PUSH_PATIENCE,
  });
  cpSync(
    join(served.workspace, "runs", other),
    join(served.workspace, "runs", arrived),
    { recursive: true },
  );
  await expect(listed.getByText(new RegExp(`^${arrived} · `))).toBeVisible({
    timeout: PUSH_PATIENCE,
  });
  expect(wire.requests.slice(before)).toStrictEqual([]);

  // The main area's setting holds them like any other view of it.
  await choose(page, MAIN, "Off");
  const [, second] = facts.otherLiveRuns as [string, string];
  stopRun(served, second);
  await expect(waiting(page, MAIN)).toBeVisible({ timeout: PUSH_PATIENCE });
  await expect(listed.getByText(new RegExp(`^${second} · `))).not.toContainText(
    "ended-stopped",
  );
  await choose(page, MAIN, "Live");
  await expect(listed.getByText(new RegExp(`^${second} · `))).toContainText(
    "ended-stopped",
  );
});
