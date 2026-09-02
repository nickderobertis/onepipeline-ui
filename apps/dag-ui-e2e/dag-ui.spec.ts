// llmlint: ignore-file[e2e_uses_accessible_selectors] the same constraint as
// dag-ui-navigation.spec.ts: every region, control and reading asserted on here is
// reached by role or by text — graph cards and metric tiles through
// `observatory-locators.ts`, which asks for them by the accessible names the app now
// gives them. What is left is the copied markup's own structural containers — the run
// list's rows among them, counted by class where the assertion is how many there are
// rather than which — which carry no accessible name and no role to ask for. Naming
// those is a change to the app this app was imported
// precisely so as not to rewrite (apps/dag-ui/AGENTS.md), and these journeys are the
// only thing that would catch what such a pass moved.
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EVENT_CATEGORIES } from "@onepipeline-ui/timeline-categories";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { fixture, runs } from "./fixture-facts";
import {
  graphNodeList,
  graphNodes,
  metric as metricTile,
  metrics as metricTiles,
} from "./observatory-locators";
import {
  FIXTURE_WORKSPACE,
  OFFLINE_UI_URL,
  STALLED_UI_URL,
} from "./playwright.config";
import { PHONE } from "./viewports";

/**
 * The DAG Observatory driven end to end against a real `onepipeline-api serve`
 * serving a real recorded run directory (see `e2e/fixtures/serve-fixture.mjs`, started
 * by `playwright.config.ts`). Nothing between the browser and the read model is
 * doubled: the app's own telemetry client makes the HTTP and SSE requests, and the
 * server projects them from journal files the executor's own writers produced. Live
 * updates are provoked by changing that run directory, never by faking an event. The
 * pagination recovery journey takes the browser offline; its online retry still
 * reaches this real server and renders its next recorded page.
 */

/**
 * Open the app and wait for it to have mounted; each journey then asserts its own state.
 *
 * The default names the graph because an address that names no view lands on the
 * overall reading of the run — which is a journey of its own below, and what every
 * graph journey here would otherwise have to walk out of first.
 */
async function openObservatory(
  page: Page,
  path = "/?view=graph",
): Promise<void> {
  await page.goto(path);
  await expect(page.getByText("DAG Observatory")).toBeVisible();
}

/**
 * Whether repeated Tab presses ever land on `target`, i.e. it is in the tab order.
 *
 * The element is resolved once and answers for itself, because `Locator.evaluate`
 * re-queries and waits for a match: a target that leaves the document mid-walk would
 * otherwise park the loop until the test budget expired, reporting that expiry rather
 * than the disappearance behind it.
 */
async function tabTo(
  page: Page,
  target: Locator,
  presses = 40,
): Promise<boolean> {
  const element = await target.elementHandle();
  if (element === null)
    throw new Error("nothing to tab to: the target is not in the document");
  try {
    for (let index = 0; index < presses; index += 1) {
      await page.keyboard.press("Tab");
      const walked = await element.evaluate((node) => ({
        focused: node === document.activeElement,
        attached: node.isConnected,
      }));
      if (walked.focused) return true;
      if (!walked.attached)
        throw new Error(
          `the target left the document after ${index + 1} Tab presses, before focus reached it`,
        );
    }
    return false;
  } finally {
    await element.dispose();
  }
}

async function backgroundColor(locator: Locator): Promise<string> {
  return locator.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
}

/** The brightest channel of a serialized colour — how a dark surface is told from a light one. */
function brightestChannel(color: string): number {
  return Math.max(...(color.match(/\d+/g) ?? ["255"]).slice(0, 3).map(Number));
}

/**
 * Painting a throwaway element is what makes a token comparable to a surface: reading
 * the custom property back gives its declaration text, which is never the `rgb(…)` the
 * browser reports for a `background-color`, so the two could not be compared directly.
 */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const computed = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return computed;
  }, token);
}

/**
 * The fixture command, named absolutely.
 *
 * These journeys are launched from the workspace root — Playwright resolves a
 * relative `--config` against the nearest `package.json` rather than against the
 * working directory, so the tier names its config from the root and every path a
 * journey spawns has to be independent of where that left `process.cwd()`.
 */
const FIXTURE_COMMAND = join(import.meta.dirname, "fixtures/serve-fixture.mjs");

/** The run-list route, whichever question is being asked of it. */
const RUN_LIST_PATH = "/api/v2/runs";

/** How far a scrolling region has been scrolled, in pixels from its top. */
const scrollOffset = (locator: Locator): Promise<number> =>
  locator.evaluate((element) => element.scrollTop);

/** One run's detail read, and never the timeline or the list beside it. */
const RUN_DETAIL_READ = /\/api\/v2\/runs\/[^/?]+(\?|$)/;
/** The run list, page or selection alike. */
const RUN_LIST_READ = /\/api\/v2\/runs(\?|$)/;

// llmlint: ignore-block[e2e_not_mocked] the three helpers below are one construct with one reason: nothing is doubled and no response is fabricated. Every request is forwarded to the same `onepipeline-api serve` every other journey drives, and every byte the browser reads back — including both refusals — is that server's own. What each changes is a condition on the way there, exactly as `context.setOffline` changes whether a request arrives at all, which this tier already relies on to reach its pagination-failure journey: `delayReads` changes how long the answer takes, `sweepDuringRead` takes the run off the served root before forwarding, and `readUnderProfile` asks for a reading the app has no control for. None of the three is reachable from a fixture — the defects behind them are races between a server's poll interval and the time a fold of a journal takes (the operator reported a twenty-second read against a stream invalidating twice a second), no run this tier can write reads slowly enough, and the browser's own toolbar offers only the two profiles every run answers to.
// llmlint: ignore-block[tests_mirror_real_usage] same three sites, same reason: each reproduces a reader who really is in that position — a read slower than the run is moving, a run swept while it was being opened, a reading the run has no profile for — and what the journeys then assert about each is entirely what that reader sees on screen.
/**
 * Hold every read of a matching route open for `ms` before letting it through.
 *
 * The response is the real server's; only its timing is this journey's.
 */
async function delayReads(
  page: Page,
  route: RegExp,
  ms: number,
): Promise<void> {
  await page.route(route, async (intercepted) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await intercepted.continue();
  });
}

/**
 * Take `runId` off the served root while the browser's first read of it is in
 * flight, then forward that read.
 *
 * The race the detail route's one swallowed failure is about, made to happen: the
 * run was there when the list named it and gone by the time the read of it reached
 * the server. The removal is the fixture's own, the refusal is the server's own
 * `404 run_not_found`, and this journey writes neither.
 *
 * Resolves to what the interception saw, so a journey can say the read really was
 * taken after the run had gone rather than passing on a read that beat it.
 */
function sweepDuringRead(page: Page, runId: string): { swept: () => boolean } {
  let swept = false;
  void page.route(RUN_DETAIL_READ, async (intercepted) => {
    const read = new URL(intercepted.request().url());
    if (!swept && read.pathname.endsWith(`/${runId}`)) {
      swept = true;
      changeServedRuns(["--remove-run", runId]);
    }
    await intercepted.continue();
  });
  return { swept: () => swept };
}

/**
 * Ask for every run-detail read under `profile`.
 *
 * The browser's own toolbar offers `planner` and `monitor`, which every run answers
 * to, so a reading a run has no profile for cannot be asked for from the app — and
 * that refusal is the other half of what the detail route's swallow must not cover.
 * The name is put on the request the app was going to make anyway; what comes back
 * is the server's own `404 unknown_filter_profile`.
 */
async function readUnderProfile(page: Page, profile: string): Promise<void> {
  await page.route(RUN_DETAIL_READ, async (intercepted) => {
    const read = new URL(intercepted.request().url());
    read.searchParams.set("filter", profile);
    await intercepted.continue({ url: read.toString() });
  });
}
// llmlint: ignore-end[e2e_not_mocked]
// llmlint: ignore-end[tests_mirror_real_usage]

/**
 * Watch, for the whole of a journey, whether a failure banner is ever on screen —
 * not whether one is on screen now.
 *
 * The property one of the journeys below is about is that the reader is *never*
 * shown a failure, and a snapshot cannot say that: the banner it must not raise
 * would be cleared again by the next stream frame, half a second later, so a check
 * taken after that frame cannot tell a banner that was raised from one that never
 * was. This watches the same document the reader is looking at, from before the
 * first paint.
 */
async function watchForBanners(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const seen = { total: 0 };
    (window as unknown as { __banners: { total: number } }).__banners = seen;
    new MutationObserver(() => {
      if (document.querySelector('[role="alert"]') !== null) seen.total += 1;
      // `document` rather than `document.documentElement`: an init script runs
      // before there is an element to observe, and `observe` on nothing watches
      // nothing — which reports every journey as having raised no banner.
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { __banners?: { total: number } }).__banners
          ?.total ?? 0,
    );
}

/**
 * Keep the live run recording for `seconds`, without waiting for it.
 *
 * The server invalidates a subscriber when the journal it watches has grown since
 * the last poll, so one append raises one invalidation and nothing a journey does
 * synchronously can outpace a read. This leaves the run moving while the journey
 * asserts against it, which is the state an operator's graph is actually in.
 */
function churnLiveRun(seconds: number): { stop: () => void } {
  const interval = 120;
  const child = spawn(
    process.execPath,
    [
      FIXTURE_COMMAND,
      "--workspace",
      FIXTURE_WORKSPACE,
      "--churn-live",
      String(Math.ceil((seconds * 1000) / interval)),
      "--churn-interval",
      String(interval),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return { stop: () => child.kill() };
}

/**
 * Run the fixture command over a workspace and wait for it to finish.
 *
 * Every invocation this file makes goes through here — the ones that change what
 * the server is serving, and the ones that ask it to serve and are refused before
 * it can. `env` is empty unless a case is about what the command reads from it.
 */
function invokeFixture(
  args: string[],
  workspace = FIXTURE_WORKSPACE,
  env: NodeJS.ProcessEnv = {},
): void {
  execFileSync(
    process.execPath,
    [FIXTURE_COMMAND, "--workspace", workspace, ...args],
    { stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, ...env } },
  );
}

/**
 * Change what the server is serving — record progress, or take a run away — through
 * the fixture module that wrote the run directory in the first place.
 */
function changeServedRuns(args: string[], workspace = FIXTURE_WORKSPACE): void {
  invokeFixture(args, workspace);
}

/**
 * What the fixture command said and how it ended, for an invocation it refuses.
 *
 * `workspace` is this run's own unless a case is about that option itself.
 */
function refusedInvocation(
  args: string[],
  workspace = FIXTURE_WORKSPACE,
  env: NodeJS.ProcessEnv = {},
): { status: number; stderr: string } {
  try {
    invokeFixture(args, workspace, env);
  } catch (refused) {
    // Node decorates the error `execFileSync` throws with the child's own exit
    // status and captured stderr, and types neither: a caught value is `unknown`
    // and `ExecFileSyncException` is not what a failed spawn is typed as here.
    // Reading them off the shape is the only way to assert the exit contract,
    // and both are read defensively so a differently-shaped throw still reports.
    const failure = refused as { status?: number; stderr?: Buffer };
    return {
      status: failure.status ?? 0,
      stderr: failure.stderr?.toString() ?? "",
    };
  }
  throw new Error(`serve-fixture accepted ${args.join(" ")}`);
}

/** The node view's pinned plot, once a node has been opened. */
const timeline = (page: Page): Locator =>
  page.getByRole("region", { name: "Node timeline" });

/** The node view's detail region: whichever timeline item is open, expanded. */
const itemDetail = (page: Page): Locator =>
  page.getByRole("region", { name: "Timeline item detail" });

/** The overall view's single line: the whole graph collapsed to one clock. */
const graphLine = (page: Page): Locator =>
  page.getByRole("region", { name: "Graph timeline" });

/** One row of that graph, once the line has been opened into rows. */
const graphRow = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name} timeline` });

/** The whole row, plot and heading: the heading is where its name and totals are. */
const graphRowCard = (page: Page, name: string): Locator =>
  page.locator(".graph-row").filter({ has: graphRow(page, name) });

/** Open the line into one row per node beside the run's own driving sessions. */
async function expandGraphRows(page: Page): Promise<void> {
  await graphLine(page)
    .getByRole("button", { name: "Expand timeline" })
    .click();
  await expect(
    page.getByRole("region", { name: "Run-level timeline" }),
  ).toBeVisible();
}

/** What one plot's clock currently reads: its two axis ticks, in order. */
async function axisTicks(plot: Locator): Promise<string> {
  return plot.getByTestId("timeline-axis").innerText();
}

test("tracks every node state and kind of a live run", async ({ page }) => {
  await openObservatory(page);

  await expect(
    graphNodes(page, "done").filter({ hasText: "foundation" }),
  ).toContainText("foundation");
  await expect(graphNodes(page, "running")).toContainText("dashboard");
  await expect(
    graphNodes(page, "failed").filter({ hasText: "publish" }),
  ).toContainText("publish");
  await expect(graphNodes(page, "waiting")).toContainText("approval");
  await expect(graphNodes(page, "pending")).toContainText("followup");
  await expect(graphNodes(page, "cancelled")).toContainText("obsolete");
  // The two statuses the scheduler derives and journals nothing about. The served
  // graph re-derives them, so they reach the canvas as themselves rather than as the
  // "pending" a client used to invent for every node the journal never mentioned.
  await expect(graphNodes(page, "blocked")).toContainText("queued");
  await expect(graphNodes(page, "skipped")).toContainText("abandoned");

  // Each card names the kind of work it stands for, so an operator can tell the two
  // apart without opening either: agent work runs itself, a human action does not.
  await expect(graphNodes(page, "running")).toContainText("agent");
  await expect(graphNodes(page, "waiting")).toContainText("human");

  // And a card that is not moving says why in one line, so a graph of red and amber
  // is a diagnosis rather than an invitation to open every node in it.
  await expect(graphNodes(page, "blocked")).toContainText(
    "blocked by approval",
  );
  await expect(graphNodes(page, "skipped")).toContainText("blocked by publish");
  await expect(
    graphNodes(page, "failed").filter({ hasText: "publish" }),
  ).toContainText("Deploy failed");
  await expect(graphNodes(page, "cancelled")).toContainText(
    "cancelled cooperatively",
  );
  // Work that is fine gets no such line at all. Asked of the accessible node list,
  // which reads out the same reason the card truncates and appends it after an em
  // dash — so "no `done` node has one" is one count rather than a rule per node.
  await expect(
    graphNodeList(page).getByRole("button", { name: /: done — / }),
  ).toHaveCount(0);
});

test("leads a node that is not moving with the reason it is not", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=publish`);
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("This node failed: agent");
  await expect(banner).toContainText("Deploy failed");
  await expect(banner).toContainText("publication exited non-zero");
  await expect(banner).toContainText("2");
  // It is the first thing in the view: above the disclosures, not inside one.
  const bannerBox = await banner.boundingBox();
  const taskBox = await page.getByRole("tab", { name: "Task" }).boundingBox();
  expect(bannerBox?.y ?? 0).toBeLessThan(taskBox?.y ?? 0);

  // A held node states what holds it, by the plan node the server named.
  await openObservatory(page, `/?run=${runs().live}&node=queued`);
  await expect(page.getByRole("alert")).toContainText("This node is blocked");
  await expect(page.getByRole("alert")).toContainText("approval");

  // The same for the node its failed prerequisite made unreachable.
  await openObservatory(page, `/?run=${runs().live}&node=abandoned`);
  await expect(page.getByRole("alert")).toContainText("This node is skipped");
  await expect(page.getByRole("alert")).toContainText("publish");

  // Abandoned work is lost work: it reads with the failures rather than with the
  // held nodes, and the scheduler's own words for it are what the banner shows.
  await openObservatory(page, `/?run=${runs().live}&node=obsolete`);
  await expect(page.getByRole("alert")).toContainText(
    "This node was cancelled",
  );
  await expect(page.getByRole("alert")).toContainText(
    "cancelled cooperatively",
  );
});

test("renders the outcomes only a recorded result carries", async ({
  page,
}) => {
  // The result a driver writes as it closes out holds statuses no settlement
  // journals. Each has to reach the canvas as itself and read as the kind of
  // outcome it is.
  await openObservatory(page, `/?run=${runs().outcomes}&view=graph`);
  await expect(graphNodes(page, "not-completed")).toContainText("backfill");
  await expect(graphNodes(page, "unknown")).toContainText("verify");

  // Unfinished work is lost work, not held work; a status the vocabulary does not
  // hold has no outcome to claim and must not borrow one.
  await expect(graphNodes(page, "not-completed")).toHaveCSS(
    "background-color",
    await tokenColor(page, "--destructive-surface"),
  );
  await expect(graphNodes(page, "unknown")).toHaveCSS(
    "background-color",
    await tokenColor(page, "--card"),
  );

  await graphNodes(page, "not-completed").click();
  await expect(page.getByRole("alert")).toContainText("did not complete");
  await expect(page.getByRole("alert")).toContainText("step 'load' timed out");

  // And a node that failed with nothing recorded about why says exactly that,
  // rather than leaving a banner with an empty body under a heading.
  await openObservatory(page, `/?run=${runs().outcomes}&node=migrate`);
  await expect(page.getByRole("alert")).toContainText(
    "No reason was recorded for this outcome.",
  );

  // And a failure whose only recorded explanation is its outcome word still puts
  // that word on the card, rather than saying nothing the run did not already know.
  await openObservatory(page, `/?run=${runs().outcomes}&view=graph`);
  await expect(
    graphNodes(page, "failed").filter({ hasText: "rollback" }),
  ).toContainText("gate-failed");
  // The banner reads the same chain, so the card and the view it opens cannot
  // explain one failure two ways.
  await openObservatory(page, `/?run=${runs().outcomes}&node=rollback`);
  await expect(page.getByRole("alert")).toContainText("This node failed: gate");
  await expect(page.getByRole("alert")).toContainText("gate-failed");

  // A blocked node names the human action refs its own result recorded, not only
  // the plan nodes the server derived — the two are different locators.
  await openObservatory(page, `/?run=${runs().outcomes}&node=stalled`);
  await expect(page.getByRole("alert")).toContainText("migrate/sign-off");

  // And one recorded blocked with nothing recorded about what blocks it — a legacy
  // result, or one whose gate has since settled — says exactly that.
  await openObservatory(page, `/?run=${runs().outcomes}&node=orphaned`);
  await expect(page.getByRole("alert")).toContainText(
    "Nothing recorded; the run has not written what holds it.",
  );

  // The lifecycle's prose and the dispatch's error are separate fields that are
  // sometimes the same sentence; the banner states it once, under one heading.
  await openObservatory(page, `/?run=${runs().outcomes}&node=retry`);
  const once = page.getByRole("alert");
  await expect(once).toContainText("gate rejected the push");
  await expect(once).not.toContainText("Error");
});

test("counts a run the strict fold cannot read at all", async ({ page }) => {
  await openObservatory(page);
  // The served run recorded a result with no authoritative journal behind it, which
  // is what a run predating the journal looks like. The per-node derivation cannot run, so
  // the row is counted from the tolerant telemetry index instead — whose statuses are
  // an open string, and whose words the navigation still has to show rather than drop.
  await expect(
    page.getByRole("button", { name: RegExp(runs().legacy) }),
  ).toContainText("1 improvised");
});

test("counts a run's own nodes on the row that opens it", async ({ page }) => {
  await openObservatory(page);
  // The row and the graph it opens are counted from one derivation on the server, so
  // a run whose row says only "running" can no longer hide a node already blocked.
  const liveRow = page.getByRole("button", { name: RegExp(runs().live) });
  await expect(liveRow).toContainText("1 blocked");
  await expect(liveRow).toContainText("1 skipped");
  await expect(liveRow).toContainText("1 pending");
});

test("opens a node's timeline, reads one recorded moment, and returns", async ({
  page,
}) => {
  await openObservatory(page);
  await graphNodes(page, "running").click();

  // The node takes the working area: the graph is gone, and a breadcrumb stands
  // where it was.
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).toBeVisible();
  await expect(graphNodes(page)).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toContainText("dashboard");
  await expect(page.locator(".node-view-facts")).toContainText("running");

  await expect(
    page.getByRole("region", { name: "Node transcript" }),
  ).toBeVisible();

  // The upstream plot distinguishes duration bars from instant icons and moves the
  // old row metadata into a compact hover tooltip.
  const worker = timeline(page).getByRole("button", {
    name: /engineer-dashboard/,
  });
  await worker.hover();
  await expect(page.getByRole("tooltip")).toContainText("Duration:");
  await expect(page.getByRole("tooltip")).toContainText("Status: running");
  await expect(timeline(page).getByRole("button")).not.toHaveCount(0);
  // And it says which session it was, served on the row rather than read out of a
  // transcript: every dispatch on this node read "dispatch" and nothing else, so
  // the worker, the judge that supervised it, and the lint run under it were three
  // rows a reader could not tell apart. Neither name contains its own role.
  await expect(worker).toHaveAccessibleName(/Worker \(engineer-dashboard\)/);
  await expect(
    timeline(page).getByRole("button", { name: "Expand timeline" }),
  ).toBeVisible();
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  await expect(
    timeline(page).getByRole("button", { name: /^Judge/ }),
  ).toBeVisible();
  await expect(
    timeline(page).getByRole("button", { name: /^Check-in/ }),
  ).toBeVisible();
  const plot = timeline(page).getByLabel(/Timeline plot/);
  // The categories the reader was promised, and no served identifier among them.
  // The whole vocabulary is offered whatever this run recorded: a lane this node
  // has nothing in — the lock waits, which its publication never met — is a lane an
  // operator still has to be able to read as absent rather than as missing.
  await expect(page.getByRole("list", { name: "Timeline legend" })).toHaveText(
    [
      "Worker",
      "Judge",
      "Lint",
      "Orchestrator",
      "Check-in",
      "PR author",
      "Verification",
      "Publication",
      "Lock waits",
      "Human wait",
    ].join(""),
  );
  // Not the rail alone: the words are banned from the whole reading, and a lifecycle
  // step is named in the transcript rather than plotted over its own contents. Read
  // without word boundaries on purpose — this matches the concatenated text content
  // of the whole view, where a banned word runs straight into the next label.
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).not.toContainText(/phase|rollup/i);
  await timeline(page)
    .getByRole("button", { name: "Collapse timeline" })
    .click();
  await expect(worker).toHaveAttribute("data-timeline-shape", "span");
  await expect(
    page.getByRole("list", { name: "Timeline legend" }),
  ).toBeVisible();
  await plot.hover();
  await page.mouse.wheel(0, -120);
  await expect(
    page.getByRole("button", { name: "Reset timeline zoom" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Reset timeline zoom" }).click();
  const plotBox = await plot.boundingBox();
  if (plotBox === null)
    throw new Error("timeline plot has no brushable bounds");
  await page.mouse.move(plotBox.x + plotBox.width * 0.2, plotBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(plotBox.x + plotBox.width * 0.7, plotBox.y + 10);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Reset timeline zoom" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Reset timeline zoom" }).click();

  await worker.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("event"))
    .toBe(`dispatch.${fixture().sessions.worker}`);
  await expect(itemDetail(page)).toContainText(
    "Implementing the dashboard now",
  );
  // The dispatch it belongs to and the role it played in it, on the transcript's
  // own header rather than left to be inferred from the session name.
  await expect(itemDetail(page)).toContainText("Dispatch 1 · Worker · worker");
  await expect(
    itemDetail(page)
      .getByRole("article", { name: /^Turn / })
      .first(),
  ).toBeVisible();
  // The detail region is where the reading happens, so it holds the majority of
  // the width rather than a fixed narrow column.
  const detailWidth = (await itemDetail(page).boundingBox())?.width ?? 0;
  const workingWidth =
    (await page.locator(".workspace").boundingBox())?.width ?? 0;
  expect(detailWidth / workingWidth).toBeCloseTo(2 / 3, 1);

  // The conversation's own timeline is pinned above its turns and drives them: it
  // stays where it is while they scroll, and picking a moment on it moves the
  // reading to that turn.
  const conversationTimeline = itemDetail(page).getByRole("region", {
    name: "Conversation timeline",
  });
  await expect(conversationTimeline).toBeVisible();
  const reading = itemDetail(page).locator("[data-radix-scroll-area-viewport]");
  const readingTop = () =>
    reading.evaluate((element) => Math.round(element.scrollTop));
  expect(await readingTop()).toBe(0);
  // Expanded first, because a collapsed line stacks turns and the tool calls inside
  // them on one row — which is what collapsing is for, and what makes any single one
  // of them unreachable by pointer.
  await conversationTimeline
    .getByRole("button", { name: "Expand timeline" })
    .click();
  await conversationTimeline
    .getByRole("button", { name: /oneagentgraph turn/ })
    .last()
    .click();
  await expect.poll(readingTop).toBeGreaterThan(0);
  // Pinned, not carried off: the turns scroll under it and it is still on screen.
  await expect(conversationTimeline).toBeInViewport();
  await reading.hover();
  await page.mouse.wheel(0, -20_000);
  await expect.poll(readingTop).toBe(0);

  // A span contains its events, and opening it discloses them: one turn here.
  const turn = timeline(page).getByRole("button", {
    name: /turn-started/,
  });
  await expect(turn.first()).toBeVisible();
  await turn.first().click();
  await expect(itemDetail(page)).toContainText(
    "Implementing the dashboard now",
  );

  // Escape closes detail first, then returns to the graph.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(graphNodes(page, "running")).toContainText("dashboard");
});

test("restores a bookmarked moment inside a session from the address alone", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await timeline(page)
    .getByRole("button", { name: /engineer-dashboard/ })
    .click();
  const turn = timeline(page)
    .getByRole("button", { name: /turn-started/ })
    .first();
  await turn.click();
  const bookmarked = new URL(page.url());
  expect(bookmarked.searchParams.get("event")).not.toBe(
    `dispatch.${fixture().sessions.worker}`,
  );

  // Loading the graph in between is what makes the next load cold: nothing the
  // clicks left behind can be what reopens the moment, only the address.
  await openObservatory(page, "/?view=graph");
  await openObservatory(page, `${bookmarked.pathname}${bookmarked.search}`);
  const bookmarkedId = bookmarked.searchParams.get("event");
  if (bookmarkedId === null) throw new Error("bookmark lost its event id");
  // The address alone reopens the moment: its marker is the pressed one among the
  // node's journal icons, and its item is the focused one in the transcript.
  await expect(
    timeline(page).locator('[data-selected="true"]'),
  ).toHaveAccessibleName(/turn-started, marker/);
  await expect(
    page
      .getByRole("region", { name: "Node transcript" })
      .locator('[data-selected="true"]'),
  ).toHaveCount(1);
  await expect(itemDetail(page)).toContainText(
    "Implementing the dashboard now",
  );
});

test("keeps timeline, transcript, and nested judge conversation in time sync", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const axis = timeline(page).getByTestId("timeline-axis");
  await expect(axis.locator("span")).toHaveCount(2);
  for (const tick of await axis.locator("span").allTextContents()) {
    expect(tick).toMatch(/\d{2}:\d{2}:\d{2}.*[+−]\d/u);
  }

  // Scrolled the way a reader scrolls it — a wheel over the transcript — because the
  // cursor tracks the real scroll path, not a value written into `scrollTop`.
  const timelineTop = (await timeline(page).boundingBox())?.y;
  const cursor = timeline(page).getByTestId("timeline-cursor");
  const before = await cursor.getAttribute("style");
  await transcript.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => cursor.getAttribute("style")).not.toBe(before);
  // And the timeline stays exactly where it was while the reading moves under it.
  expect((await timeline(page).boundingBox())?.y).toBe(timelineTop);

  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  const judge = timeline(page).getByRole("button", { name: /^Judge/ });
  await expect(judge).toHaveAttribute("data-timeline-shape", "span");
  // Read as a share of the plot, not as pixels: a supervising session projected
  // against a window nothing else occupied still clears the minimum bar width the
  // design system paints, which is exactly the sliver this has to rule out.
  const plotWidth = (
    await timeline(page)
      .getByLabel(/Timeline plot/)
      .boundingBox()
  )?.width;
  if (plotWidth === undefined) throw new Error("timeline plot has no bounds");
  expect((await judge.boundingBox())?.width ?? 0).toBeGreaterThan(
    plotWidth * 0.05,
  );
  await judge.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("event"))
    .toBe(`dispatch.${fixture().sessions.judge}`);

  const judgeItem = transcript
    .getByRole("article")
    .filter({ hasText: "you-are-a-strict-careful-evaluator" });
  await expect(judgeItem).toHaveAttribute("data-selected", "true");
  await expect(judgeItem).toHaveAttribute("data-dispatch-group", "Dispatch 1");
  await expect(judgeItem).toContainText("Judge");
  const workerItem = transcript
    .getByRole("article")
    .filter({ hasText: "engineer-dashboard" });
  await expect(workerItem).toHaveAttribute("data-dispatch-group", "Dispatch 1");

  await expect(itemDetail(page)).toContainText("Judge");
  await expect(itemDetail(page)).toContainText(
    "you-are-a-strict-careful-evaluator",
  );
  await expect(
    itemDetail(page).locator(".conversation-timeline-sticky"),
  ).toHaveCSS("position", "sticky");
  await expect(
    itemDetail(page)
      .getByRole("article", { name: /^Turn / })
      .first(),
  ).toContainText("Judge");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Item detail panel")).toHaveCount(0);
});

/**
 * The reading a planner acts on before they act on anything else.
 *
 * A node with a controllable turn in flight can be corrected; one without it can only
 * be cancelled, which is the expensive move. Absent an answer the safe assumption is
 * the expensive one, so both nodes still working here have to say which they are —
 * and the one whose run has no turn to reach has to say so rather than reading as
 * an error or as nothing at all.
 */
test("says which of the nodes still working have a turn a note can reach", async ({
  page,
}) => {
  // Asked for by the accessible name the badge carries, which is the word an
  // operator reads plus the reason behind it — the whole of what this states.
  const control = page.getByLabel(/^(Turn reachable|No turn to reach): /);

  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await expect(control).toHaveText("Turn reachable");
  // The whole reason, for a pointer and for a screen reader alike: the header is the
  // one thing above a plot sized from what it leaves, so the clause cannot be painted
  // there — but it must still be reachable without leaving the view.
  await expect(control).toHaveAccessibleName(
    /^Turn reachable: a planner's note can be delivered into the worker turn in flight$/,
  );

  // The run whose node is working on a harness with no lever at all.
  await openObservatory(page, `/?run=${runs().unattributed}&node=orphan`);
  await expect(control).toHaveText("No turn to reach");
  // The producing library's own words for what the lever found, which is the only
  // account of this node's control anything in the stack has recorded.
  await expect(control).toHaveAccessibleName(
    `No turn to reach: ${fixture().redirection.no_control_reason}`,
  );

  // A node with no turn is not a node whose turn cannot be reached, and the two must
  // not read alike: the settled node says nothing here, and its state badge beside
  // this one is what says why.
  await openObservatory(page, `/?run=${runs().live}&node=foundation`);
  await expect(page.locator(".node-view-state")).toHaveText("done");
  await expect(control).toHaveCount(0);
});

/**
 * A turn whose behaviour changed mid-flight is unreadable afterwards unless the
 * redirection that caused it is on the record beside it.
 */
test("shows the moment a planner redirected a running turn", async ({
  page,
}) => {
  const transcript = page.getByRole("region", { name: "Node transcript" });

  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  const redirected = transcript
    .getByRole("article")
    .filter({ hasText: "Redirected into the running turn" });
  await expect(redirected).toHaveCount(1);
  await redirected.click();
  // Opened, it says which of the two things happened and what was offered — never the
  // planner's prose, which is not what a reader of the turn is asking for.
  await expect(itemDetail(page)).toContainText("Redirection");
  await expect(itemDetail(page)).toContainText(
    "Live — into the turn that was already running",
  );
  await expect(itemDetail(page)).toContainText(
    `${fixture().redirection.live_note.length} bytes offered`,
  );
  await expect(itemDetail(page)).not.toContainText(
    fixture().redirection.live_note,
  );
  // A delivery that landed carries no reason it did not.
  await expect(itemDetail(page)).not.toContainText("Why it was not delivered");
  await page.keyboard.press("Escape");

  // The other half: the lever pulled at a node with none, which is a record of its
  // own rather than silence — and it says why in the words the sibling refused with.
  await openObservatory(page, `/?run=${runs().unattributed}&node=orphan`);
  const deferred = transcript
    .getByRole("article")
    .filter({ hasText: "Redirection deferred to the next dispatch" });
  await expect(deferred).toHaveCount(1);
  await deferred.click();
  await expect(itemDetail(page)).toContainText(
    "Deferred — onto the node's next dispatch",
  );
  await expect(itemDetail(page)).toContainText("Why it was not delivered");
  await expect(itemDetail(page)).toContainText(
    fixture().redirection.no_control_reason,
  );
});

/**
 * The name the icon set gives the glyph a record is drawn with.
 *
 * Read off what was rendered rather than off any attribute this app added for a
 * test: `lucide-git-branch` is the drawing's own identity, so a category swapped
 * onto the wrong icon changes it, and a wrong icon behind a right label — the one
 * failure these journeys exist to catch — cannot pass. Compared as identity rather
 * than pixel for pixel, because a marker is tinted by the status beside it and two
 * transcript rows sit at different sub-pixel offsets, so the *same* glyph paints
 * differently in both places.
 */
async function glyphName(drawn: Locator): Promise<string> {
  const rendered = await drawn.locator("svg").getAttribute("class");
  const named = /\blucide-[a-z-]+\b/.exec(rendered ?? "")?.[0];
  // The identity is the icon set's, so a release of it that stopped naming its
  // drawings has to fail here rather than compare two empty strings as equal.
  expect(
    named,
    `no glyph was drawn: the icon carries "${rendered}"`,
  ).toBeDefined();
  return named ?? "";
}

/**
 * The glyph a reader should find on a record, by the name its marker carries.
 *
 * Written out rather than derived from the mapping under test, and that is the whole
 * point of it: an expectation computed from that table would agree with any
 * permutation of it — every category still drawn apart from the others, every kind
 * still drawn consistently, and every one of them wrong. So this is a second,
 * independent statement of what the reader is owed, and the two have to agree.
 *
 * A record is keyed by the words its marker names it with rather than by the wire
 * kind, because that is how a reader picks it out: a redirection and a human
 * hand-over are both drawn under words of their own.
 */
const EXPECTED_GLYPH: Readonly<Record<string, string>> = {
  "node-dispatched": "lucide-milestone", // lifecycle
  "node-settled": "lucide-milestone",
  "session-opened": "lucide-messages-square", // session
  "turn-started": "lucide-messages-square",
  push: "lucide-git-branch", // repository
  "change-opened": "lucide-git-pull-request", // publication
  "change-merged": "lucide-git-pull-request",
  "hand-over": "lucide-user-round-check", // human
  "gate-verdict": "lucide-shield-check", // verification
  "criterion-checked": "lucide-shield-check",
  "lock-wait": "lucide-hourglass", // contention
  "release-wait": "lucide-hourglass",
  "node-held": "lucide-hourglass",
  "node-unheld": "lucide-hourglass",
  "release-arrived": "lucide-git-pull-request", // publication
  "release-adopted": "lucide-git-pull-request",
  "Redirected into the running turn": "lucide-rotate-ccw", // recovery
  "member-died": "lucide-triangle-alert", // failure
  "decision-pending": "lucide-clipboard-list", // planning
};

/**
 * The glyph a kind no rule and no exception names is drawn with.
 *
 * The default is a category like any other — the eleventh, with a glyph of its own —
 * and that is why it is named here rather than left to fall out of the eleven being
 * different from each other. What it must never be drawn as is one of the *other
 * ten*: swap its icon with a neighbour's and all eleven are still drawn apart, while
 * an unrecognized record stops saying this build has no reading for it and starts
 * claiming to be a session, or a failure, or whatever it borrowed.
 */
const DEFAULT_GLYPH = "lucide-circle";

/** What a marker named `named` should be carrying, the fixture's unknown included. */
function expectedGlyph(named: string): string {
  const glyph =
    named === fixture().unfiled_kind ? DEFAULT_GLYPH : EXPECTED_GLYPH[named];
  expect(
    glyph,
    `no glyph is stated for a record named "${named}"`,
  ).toBeDefined();
  return glyph ?? "";
}

test("draws a node's journal records as the categories they belong to", async ({
  page,
}) => {
  // The node whose record really is several different things: a workspace session
  // opened, a branch pushed, a change opened and merged, a person handing the work
  // over — and one record whose kind this build has never seen, which is the
  // ordinary state of a store four separately released producers write into.
  await openObservatory(page, `/?run=${runs().live}&node=foundation`);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const marker = (named: string): Locator =>
    timeline(page).getByRole("button", {
      name: `${named}, marker`,
      exact: true,
    });

  await expect(marker("node-dispatched")).toBeVisible();
  const unfiled = fixture().unfiled_kind;
  const drawn = new Map<string, string>();
  for (const named of [
    "node-dispatched",
    "node-settled",
    "session-opened",
    "turn-started",
    "change-opened",
    "change-merged",
    unfiled,
  ]) {
    drawn.set(named, await glyphName(marker(named)));
  }

  // Each of them drawn as the glyph that record is owed — including the one no rule
  // names, which is owed the default's own and not whichever neighbour a permuted
  // mapping would have handed it.
  expect(Object.fromEntries(drawn)).toEqual(
    Object.fromEntries(
      [...drawn.keys()].map((named) => [named, expectedGlyph(named)]),
    ),
  );
  // And read the same way, drawn the same way: two agent turns and a workspace
  // session are all one unit of work opened and closed, a change opened and merged
  // are two moments of one publication, and the node's own dispatch and settlement
  // are both the graph moving. Stated beside the identities above rather than
  // derived from them, because this is the claim a reader actually makes of the
  // plot — that these belong together — and it would survive the pair moving to
  // some other glyph together.
  expect(drawn.get("session-opened")).toBe(drawn.get("turn-started"));
  expect(drawn.get("change-opened")).toBe(drawn.get("change-merged"));
  expect(drawn.get("node-dispatched")).toBe(drawn.get("node-settled"));

  // Reached the way a reader without a pointer reaches it: from the top of the
  // document, by Tab, which is the whole of what makes a marker a control. The walk
  // goes to the unrecognized record so one record proves both halves — that a kind
  // nobody filed is drawn at all, and that it can be got to. The budget crosses the
  // run navigation and the graph ahead of it, a walk of some seventy stops, rather
  // than being tight around a count that moves with any new control.
  expect(await tabTo(page, marker(unfiled), 120)).toBe(true);
  await page.keyboard.press("Enter");
  // Enter opens the moment it names, which is a reading the address carries.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("event"))
    .not.toBeNull();
  // And the record it opened is drawn the same way in the transcript as on the plot,
  // which is what makes one scanned on one surface recognisable on the other.
  const row = transcript.getByRole("button", { name: `Open ${unfiled}` });
  await expect(row).toHaveCount(1);
  expect(await glyphName(row)).toBe(drawn.get(unfiled));
  // The glyph is decoration beside a row that already names the record; it is not a
  // second control the reader has to step through to reach the row itself.
  await expect(row.locator("svg")).toHaveAttribute("aria-hidden", "true");
});

test("draws every category a record can be as a glyph of its own", async ({
  page,
}) => {
  // One record of each category the scheme has, and the node a reader meets it on.
  // Named by what its marker calls itself rather than by the wire kind, because that
  // is how a reader picks it out: a redirection and a human hand-over are both drawn
  // under words of their own rather than under the kind that produced them.
  const records: readonly (readonly [string, string])[] = [
    ["foundation", "node-dispatched"], // lifecycle
    ["foundation", "session-opened"], // session
    ["foundation", "push"], // repository
    ["foundation", "change-opened"], // publication
    ["foundation", "hand-over"], // human
    ["foundation", fixture().unfiled_kind], // the default, for a kind no rule names
    ["remote-open", "gate-verdict"], // verification
    ["remote-open", "lock-wait"], // contention
    ["dashboard", "Redirected into the running turn"], // recovery
    ["publish", "member-died"], // failure
    ["approval", "decision-pending"], // planning
  ];
  // One per category, held to the scheme rather than counted here: a category added
  // to it fails this until a record of it is driven in a browser rather than only in
  // a unit test.
  expect(records).toHaveLength(EVENT_CATEGORIES.length);

  const drawn: string[] = [];
  let showing = "";
  for (const [node, named] of records) {
    if (node !== showing) {
      await openObservatory(page, `/?run=${runs().live}&node=${node}`);
      showing = node;
    }
    // The first of them: a node waits on its lock and observes its checks more than
    // once, and every record of one category is drawn the same way by construction.
    const found = timeline(page)
      .getByRole("button", { name: `${named}, marker`, exact: true })
      .first();
    await expect(found).toBeVisible();
    drawn.push(await glyphName(found));
  }
  // Every category drawn as the glyph it is owed. Named one by one rather than only
  // held apart from each other: eleven categories can be permuted onto each other's
  // icons and stay eleven distinct drawings, and the reader would be told the wrong
  // thing about every record on every plot.
  expect(drawn).toEqual(records.map(([, named]) => expectedGlyph(named)));
  // And a different drawing each: a plot where two categories share a glyph is a
  // plot with one fewer category in it, and a reader scanning it cannot tell which
  // of the two they are looking at.
  expect(new Set(drawn).size).toBe(records.length);

  // The same claim for a kind the scheme files by *name* rather than by a word in
  // it: `criterion-checked` is one acceptance criterion ruled on, and `checked` is
  // not `check`, so nothing but the exception table puts it with the verifications.
  // Read here rather than in a journey of its own because it is one more record on
  // a node this one already opens, and the servers are already up.
  await openObservatory(page, `/?run=${runs().live}&node=remote-open`);
  const named = (kind: string): Locator =>
    timeline(page).getByRole("button", {
      name: `${kind}, marker`,
      exact: true,
    });
  const checked = named("criterion-checked");
  await expect(checked).toBeVisible();
  expect(await glyphName(checked)).toBe(expectedGlyph("criterion-checked"));
  // Drawn as the gate verdict beside it, because one category is one drawing: a
  // kind filed under a neighbour would still be drawn, and drawn apart from the
  // verification it belongs with.
  expect(await glyphName(checked)).toBe(await glyphName(named("gate-verdict")));
  // And the pair the engine writes when it is *not* running a node it has not
  // settled: read as the contention a reader scanning for why nothing is moving
  // came with, rather than as a lifecycle step of the node they are about. Two
  // kinds no word of the scheme reached until the engine declared them, so this
  // is where a browser meets one rather than only a unit corpus.
  for (const held of ["node-held", "node-unheld"]) {
    const marker = named(held).first();
    await expect(marker).toBeVisible();
    expect(await glyphName(marker)).toBe(expectedGlyph(held));
    // Drawn as the wait beside it, because one category is one drawing — and this
    // node really does wait on its lock more than once, so the comparison is
    // against the first of them.
    expect(await glyphName(marker)).toBe(
      await glyphName(named("lock-wait").first()),
    );
  }

  // And said in words for the reader who does not read glyphs.
  await checked.hover();
  await expect(page.getByTestId("timeline-popover")).toContainText(
    "Verification",
  );
});

test("scrolls the transcript to the journal record a marker names", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  // A journal record occupies no lane: it is a marker over all of them, which is why
  // clicking one is the only way to reach an instant from the plot.
  const markers = timeline(page).getByRole("button", { name: /, marker$/ });
  await expect(markers.first()).toBeVisible();
  const marked = await markers.last().getAttribute("aria-label");
  if (marked === null) throw new Error("a marker carries no accessible name");

  const before = await transcript.evaluate((element) => element.scrollTop);
  await markers.last().click();
  const focused = transcript.locator('[data-selected="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAccessibleName(marked.replace(", marker", ""));
  // Focusing is a move, not just a highlight: the reading position follows.
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);
  // And the moment it moved to is in the address, so the reading is bookmarkable.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("event"))
    .not.toBeNull();

  // The sessions of one dispatch are nested under its own name, not listed beside
  // it: the agent session and the lint run it made of its own work read as one unit.
  const dispatch = transcript.getByRole("region", { name: "Dispatch 1" });
  await expect(
    dispatch.getByRole("article", { name: /^Worker \(engineer-dashboard\)/ }),
  ).toBeVisible();
  await expect(
    dispatch.getByRole("article", { name: /^Judge \(/ }),
  ).toBeVisible();
  // A separately dispatched role is its own group rather than a member of the first.
  await expect(
    transcript
      .getByRole("region", { name: "Dispatch 2" })
      .getByRole("article", { name: /^Check-in \(/ }),
  ).toBeVisible();
});

test("opens a node from the keyboard-accessible node list and walks back", async ({
  page,
}) => {
  // Eighty-odd Tab presses, each a browser round trip: latency-bound rather than slow.
  test.slow();
  await openObservatory(page);
  // The run navigation precedes the workspace in the tab order, so the walk means
  // nothing until it has arrived: setting off first reached the node list only because
  // the fifty run links were still missing from it.
  await expect(
    page.getByRole("navigation", { name: "DAG runs" }).locator(".run-link"),
  ).toHaveCount(50);
  // The canvas is a pointer surface, so the list beside it is the keyboard path to
  // every node; it has to reach the same node view a click does.
  const node = page
    .getByRole("list", { name: "DAG nodes" })
    .getByRole("button", { name: "dashboard: running" });
  // Enough to cross that navigation and the workspace behind it: the node answers at
  // the 82nd tab stop.
  expect(await tabTo(page, node, 120)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).toBeVisible();

  // The way back is in the tab order too, not only under the Escape key.
  const back = page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("button", { name: /Graph/ });
  expect(await tabTo(page, back)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(graphNodes(page, "running")).toContainText("dashboard");
});

test("shows a verification and a publication as the records they are", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=foundation`);

  // The verification carries this push's own verdict and bounded output, then loads
  // the preserved log through its opaque artifact id without exposing a host path.
  await timeline(page)
    .getByRole("button", { name: new RegExp(fixture().artifacts.gate) })
    .click();
  await expect(
    timeline(page).getByRole("button", {
      name: new RegExp(fixture().artifacts.gate),
    }),
  ).toHaveAttribute("data-timeline-shape", "span");
  await expect(itemDetail(page)).toContainText("Verification record");
  await expect(itemDetail(page)).toContainText("pre-push verification passed");
  await expect(itemDetail(page)).toContainText("full verification output");
  await expect(itemDetail(page)).not.toContainText(
    "oldest verification output",
  );
  await itemDetail(page).getByRole("button", { name: "Expand log" }).click();
  await expect(itemDetail(page)).toContainText("oldest verification output");
  await expect(
    itemDetail(page).getByRole("button", { name: "Collapse log" }),
  ).toBeVisible();
  await expect(itemDetail(page)).not.toContainText("foundation/gate.log");
  await page.getByRole("button", { name: "Close detail" }).click();

  // The publication carries the change it published and says, rather than implies,
  // that nothing observed a check on it: this node was merged with no host check
  // reported against it, and the panel states that rather than leaving a blank.
  // Read from the opened plot, where each category has a row of its own —
  // collapsed, the branch this node worked on lies under the session that opened
  // it, which is what the one line is for.
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  await timeline(page)
    .getByRole("button", { name: /^Publication/ })
    .click();
  await expect(
    itemDetail(page).getByRole("link", {
      name: new RegExp(fixture().foundation_pr),
    }),
  ).toBeVisible();
  await expect(itemDetail(page)).toContainText("Observed checks");
  await expect(itemDetail(page)).toContainText(
    "No checks were observed on this node.",
  );
  await page.getByRole("button", { name: "Close detail" }).click();

  // The merge `onevcs` relayed sits inside the node's own record and opens as the
  // publication it reported, not as an untyped line of journal.
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "change-merged" })
    .getByRole("button")
    .click();
  await expect(itemDetail(page)).toContainText("Publication");
  await expect(
    itemDetail(page).getByRole("link", {
      name: new RegExp(fixture().foundation_pr),
    }),
  ).toBeVisible();
});

/**
 * A run's releases, end to end: what the server derived, and what the reader sees.
 *
 * Two halves of one sequencing, and both are driven here because either alone is
 * the wrong reading. The server's half is a **join through the landing commit**:
 * `onevcs` observes a release long after the dispatch that produced the work has
 * settled and outside any session of it, so nothing stamps that envelope with a
 * node — the fixture writes it with none, exactly as a real one has none, and this
 * asserts that the node-scoped timeline (which is every record labelled with the
 * node) holds no such record while the node's own item carries the release anyway.
 * A reading that had joined on the label would pass every other assertion here and
 * serve this key absent on every run in existence.
 *
 * The reader's half is the wait. A node held on a machine will clear itself; a node
 * held on a **person** will not, and that is the one thing an operator has to be
 * able to see without opening anything else — so the two are drawn apart, and the
 * one that needs somebody told carries the action they have to perform.
 */
test("shows the release that carried a node's work and the waits before it", async ({
  page,
}) => {
  const facts = fixture();
  const detail = await (
    await page.request.get(`/api/v2/runs/${runs().live}`)
  ).json();

  // The release the node's work went out in, beside the change request it opened.
  expect(detail.graph.node_results.foundation.release).toEqual({
    identity: facts.release.identity,
    target: facts.release.target,
    style: "automated",
    version: facts.release.version,
  });
  // Joined by the commit that node's work landed as, and by nothing else: the
  // publication says which commit that was, and the node-scoped timeline — every
  // record the run labelled with this node — carries no `release-observed` at all.
  expect(detail.node_details.foundation.publication.commit).toBe(
    facts.foundation_commit,
  );
  const atNode = await (
    await page.request.get(
      `/api/v2/runs/${runs().live}/timeline?scope=node&node=foundation`,
    )
  ).json();
  const kindsAtNode: string[] = atNode.spans.flatMap(
    (span: { events: { kind: string }[] }) =>
      span.events.map((event) => event.kind),
  );
  expect(kindsAtNode).not.toContain("release-observed");
  expect(kindsAtNode).toContain("release-wait");
  // Absent, never null, for a node the run recorded no release for.
  expect("release" in detail.graph.node_results.dashboard).toBe(false);

  // Every one of the six kinds really reached the reader. That they are each
  // *filed* under a category is held over this same served store by
  // `event-category.test.tsx`, which reads the fixture's own kinds and fails on
  // one nobody decided a category for; what this asserts is the half that suite
  // cannot — that the server actually serves them.
  const atRun = await (
    await page.request.get(`/api/v2/runs/${runs().live}/timeline?scope=run`)
  ).json();
  const served = new Set<string>(
    atRun.spans.flatMap((span: { events: { kind: string }[] }) =>
      span.events.map((event) => event.kind),
    ),
  );
  expect(
    [
      "release-probed",
      "release-acknowledged",
      "release-observed",
      "release-wait",
      "release-arrived",
      "release-adopted",
    ].filter((kind) => !served.has(kind)),
  ).toEqual([]);

  // What the reader sees. The node's own release sits beside its change request,
  // and is read under its own heading rather than off the panel as a whole: the
  // two rows say different things and a reader has to be able to tell which one
  // said nothing.
  const fact = (label: string): Locator =>
    page
      .locator(".facts > div")
      .filter({
        has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }),
      })
      .locator("dd");
  await openObservatory(page, `/?run=${runs().live}&node=foundation`);
  await page.getByRole("tab", { name: "PR" }).click();
  await expect(fact("Release")).toContainText(facts.release.version);
  await expect(fact("Release")).toContainText(facts.release.target);

  // And a node the run recorded no release for says exactly that, about the
  // release alone: this one opened a change request, so its publication row is
  // recorded and only the row beside it is not. A panel-wide reading would pass
  // on a node that recorded neither and prove nothing about this row.
  await openObservatory(page, `/?run=${runs().live}&node=remote-open`);
  await page.getByRole("tab", { name: "PR" }).click();
  await expect(fact("Release")).toHaveText("Not recorded");
  await expect(
    fact("Publication").getByRole("link", { name: "Pull request" }),
  ).toHaveAttribute("href", facts.remote_open_pr);
  await openObservatory(page, `/?run=${runs().live}&node=foundation`);

  // And the waits before it, opened from the node's own transcript. The wait on a
  // person names the action somebody has to perform; the wait beside it, on the
  // same record, does not — which is the whole of how a reader tells them apart.
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "release-wait" })
    .getByRole("button")
    .click();
  await expect(itemDetail(page)).toContainText("Waiting on a person");
  await expect(itemDetail(page)).toContainText(facts.release.human_action);
  await expect(itemDetail(page)).toContainText(
    "Waiting on an automated release",
  );
  await expect(itemDetail(page)).toContainText(facts.release.dep_identity);
  // The third wait is the same human step written with no action: `action` is
  // optional on the wire, so a rule can name a person without naming what they
  // do. It is still drawn as a wait on a person — the reader is told somebody is
  // needed and told that the run did not say what for, rather than shown a blank
  // where the instruction should be.
  const unspoken = itemDetail(page)
    .getByRole("listitem")
    .filter({ hasText: facts.release.unspoken_target });
  await expect(unspoken).toContainText("Waiting on a person");
  await expect(unspoken).toContainText(
    "The release is a human step and the run recorded no action for it.",
  );
  await page.getByRole("button", { name: "Close detail" }).click();

  // The arrival that ended one of them, read as the release it was.
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "release-arrived" })
    .first()
    .getByRole("button")
    .click();
  await expect(itemDetail(page)).toContainText(facts.release.dep_version);
  await expect(itemDetail(page)).toContainText("Release target");
  await page.getByRole("button", { name: "Close detail" }).click();

  // The adoption that wrote both versions into the node's own context.
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "release-adopted" })
    .getByRole("button")
    .click();
  await expect(itemDetail(page)).toContainText("Versions adopted");
  await expect(itemDetail(page)).toContainText(facts.release.dep_version);

  // And drawn as the categories they belong to, which is what a reader scanning
  // the plot is answering: the wait apart from the two releases beside it, each
  // against a glyph stated independently of the table that assigns it.
  const marker = (named: string): Locator =>
    timeline(page).getByRole("button", {
      name: `${named}, marker`,
      exact: true,
    });
  for (const named of ["release-wait", "release-arrived", "release-adopted"]) {
    expect(await glyphName(marker(named).first())).toBe(expectedGlyph(named));
  }
  expect(await glyphName(marker("release-wait").first())).not.toBe(
    await glyphName(marker("release-arrived").first()),
  );

  // The three `onevcs` writes are the run's own rather than any node's — that is
  // why the node item is joined to one by a commit — so they are read where the
  // run-level lane plots them, and each opens as the record it is.
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  await expandGraphRows(page);
  const runLevel = page.getByRole("region", { name: "Run-level timeline" });
  await runLevel.getByRole("button", { name: "Expand timeline" }).click();
  // Opened from the keyboard, which is the path a marker on this plot is reached
  // by: the graph line paints a cursor over its whole height as the pointer moves
  // across it, so a click lands on the reading of the moment rather than on the
  // record. Enter on the focused marker is what a reader without a pointer does.
  const openRunMarker = async (kind: string, which: "first" | "last") => {
    const marker = runLevel.getByRole("button", {
      name: `Run-level · ${kind}, marker`,
    });
    // llmlint: ignore-block[tests_mirror_real_usage] focusing the marker *is* the user path here rather than a way around one: the graph line paints a cursor over its whole height as the pointer crosses it, so a click on this plot lands on the reading of the moment and never on the record. What is left for a reader to do is reach the marker in the tab order and press Enter, which is what this drives.
    await (which === "first" ? marker.first() : marker.last()).focus();
    await page.keyboard.press("Enter");
    // llmlint: ignore-end[tests_mirror_real_usage]
  };

  // A probe names what it asked and what it was told, and no commit: it is a
  // question to a registry rather than a record of what a release carried.
  await openRunMarker("release-probed", "first");
  await expect(itemDetail(page)).toContainText("Probe outcome");
  await expect(itemDetail(page)).toContainText("released");
  await expect(itemDetail(page)).not.toContainText("Landed as");

  // An acknowledgement names the person, because a human step has one.
  await openRunMarker("release-acknowledged", "first");
  await expect(itemDetail(page)).toContainText("Acknowledged by");
  await expect(itemDetail(page)).toContainText(facts.release.human_actor);

  // And the observation carries the commit the node item's own release is joined
  // to it by, which is the whole of that derivation shown to a reader.
  await openRunMarker("release-observed", "last");
  await expect(itemDetail(page)).toContainText(facts.release.version);
  await expect(itemDetail(page)).toContainText(facts.foundation_commit);
  await expect(itemDetail(page)).toContainText("Landed as");
});

/**
 * The report a settled member left, read in the run the operator is looking at.
 *
 * This is the document a reader opens a settlement for — the ruling against each
 * acceptance criterion, the follow-ups the worker surfaced, why it stopped — and
 * it is the run's *own* retained copy, asked for by the opaque artifact id the
 * settlement recorded. Both halves are driven: the report this run kept, and the
 * settlement whose report it refused to keep, which has to be said rather than
 * left as a blank pane.
 */
test("reads the report a settled node's member left behind", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=foundation`);

  const served = page.waitForResponse(
    (response) =>
      response.url().includes(`/artifacts/${fixture().artifacts.report}`) &&
      response.status() === 200,
  );
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "member-settled" })
    .getByRole("button")
    .click();

  // Asserted before the response is awaited, so a panel that renders nothing
  // fails saying what is missing rather than as a wait that never ended — and
  // the read is still proven to have gone to the API below.
  await expect(itemDetail(page)).toContainText("Worker report");
  await served;

  // The end of the report first — the verdicts it closed on and the follow-ups it
  // surfaced are what the operator came for — and never a path on the producing
  // host, which is a stranger's directory this stack deliberately never opens.
  await expect(itemDetail(page)).toContainText(
    "the last ruling this report recorded",
  );
  await expect(itemDetail(page)).toContainText(
    "the gate logs onevcs stores are retained by nothing",
  );
  await expect(itemDetail(page)).not.toContainText(
    "/a/producing/librarys/scratch",
  );
  await expect(itemDetail(page)).not.toContainText(
    "the earliest ruling this report recorded",
  );

  // The rest of it is one control away, and that control is in the tab order and
  // answers the keyboard like every other one here.
  const expand = itemDetail(page).getByRole("button", {
    name: "Expand report",
  });
  // llmlint: ignore-block[tests_mirror_real_usage] what this asserts is that the control answers the keyboard, so the focused-then-Enter path is the behaviour rather than a shortcut to it — a click would exercise the pointer path and prove nothing about the other one. The pointer path over this same control is driven by the collapse below it.
  await expand.focus();
  await page.keyboard.press("Enter");
  // llmlint: ignore-end[tests_mirror_real_usage]
  await expect(itemDetail(page)).toContainText(
    "the earliest ruling this report recorded",
  );
  await expect(
    itemDetail(page).getByRole("button", { name: "Collapse report" }),
  ).toBeVisible();

  // The record itself stays beside the report rather than being replaced by it.
  await expect(itemDetail(page)).toContainText("Recorded at");
  await expect(itemDetail(page)).toContainText(fixture().artifacts.report);

  // The other half: a settlement whose report the engine refused to retain. The
  // run holds no copy, the route answers 404, and the panel says so.
  await openObservatory(page, `/?run=${runs().live}&node=missing-artifact`);
  const refused = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/artifacts/${fixture().artifacts.unretained_report}`) &&
      response.status() === 404,
  );
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "member-settled" })
    .getByRole("button")
    .click();
  await expect(itemDetail(page)).toContainText(
    "This run kept no readable copy of that report.",
  );
  await refused;
});

/**
 * The two readings of what an agent did, from one node's timeline: the turns the
 * run relayed, and the oneharness conversation behind them.
 *
 * They are different documents and they come from different places. A turn is
 * what `oneagentgraph` relayed into the run — reachable only because the producer
 * stamps the conversation onto it — and the transcript route serves it out of the
 * run's own journal. The oneharness conversation is what the harness itself wrote
 * down, in a store no run owns: nothing copies it, the record only points at it,
 * and the API opens that store to serve it. An operator who can read the first
 * and not the second is left inferring what happened from event kinds, which is
 * the state this journey exists to keep the app out of.
 */
test("reads a relayed turn and the oneharness conversation behind it", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);

  // The relayed turn first, opened from the node's own timeline.
  const turn = timeline(page).getByRole("button", { name: /turn-started/ });
  await expect(turn.first()).toBeVisible();
  await turn.first().click();
  await expect(itemDetail(page)).toContainText(
    "Implementing the dashboard now",
  );
  // Closed before the next reading is opened: on a narrow viewport the detail is
  // a drawer over the timeline, so the second record is reached the way an
  // operator reaches it — by putting the first one away.
  await page.keyboard.press("Escape");

  // Then the record that names where that member's conversation was written
  // down. The read is proven to have gone to the API, and to have been asked for
  // by the history id the record carries and nothing else.
  const served = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/artifacts/${fixture().artifacts.harness_session}`) &&
      response.status() === 200,
  );
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "oneharness-session" })
    .getByRole("button")
    .click();
  // Asserted before the response is awaited, so a panel that renders nothing
  // fails saying what is missing rather than as a wait that never ended.
  await expect(itemDetail(page)).toContainText("Oneharness conversation");
  await served;

  // What the agent actually said, which is what an operator opens this for. The
  // record's own fields are the document and are shown as written; what never
  // reaches the browser is the *pointer* — the store this server opened to find
  // it — because the panel asks by the history id and renders only the record.
  await expect(itemDetail(page)).toContainText(fixture().harness_session_text);
  await expect(itemDetail(page)).not.toContainText("oneharness-history");

  // The record itself stays beside the conversation rather than being replaced
  // by it, and it is reachable from the keyboard like every other control here.
  await expect(itemDetail(page)).toContainText("Recorded at");
  await expect(itemDetail(page)).toContainText(
    fixture().artifacts.harness_session,
  );

  // The other half: a pointer at a conversation the store no longer holds. The
  // record is still in the run, the route answers 404, and the panel says which
  // of the two it is rather than leaving a blank pane — "nothing was written
  // down" and "something was, and it is gone" send a reader to different places.
  await openObservatory(page, `/?run=${runs().live}&node=missing-artifact`);
  const swept = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/artifacts/${fixture().artifacts.swept_harness_session}`) &&
      response.status() === 404,
  );
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "oneharness-session" })
    .getByRole("button")
    .click();
  // Announced, not merely painted: the reader asked for a document and the panel
  // answers in a live region, so a screen reader is told the read did not land
  // rather than being left on a pane that silently stopped changing.
  await expect(itemDetail(page).locator('[aria-live="polite"]')).toContainText(
    "The history store holds no readable copy of that conversation.",
  );
  await swept;
});

/**
 * A reference this API cannot be asked for is stated, never turned into a
 * request for some other route.
 *
 * An artifact id is the producing library's own string and nothing on the
 * envelope constrains its characters, so one carrying a separator really does
 * reach a reader. Both kinds that fetch have to decline it the same way — as the
 * recorded reference, with the id visible — because a panel that pasted it into
 * a URL would be asking for a path the operator never named.
 */
test("states a reference whose id no route can be asked for", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=local-direct`);
  const transcript = page.getByRole("region", { name: "Node transcript" });

  // The third value is the heading that reading would have carried: a document
  // this API cannot be asked for is not a document that failed to load, so the
  // panel must not head one and then explain its absence underneath.
  const declined: readonly (readonly [string, string, string])[] = [
    ["member-settled", fixture().artifacts.unaskable_report, "Worker report"],
    [
      "oneharness-session",
      fixture().artifacts.unaskable_harness_session,
      "Oneharness conversation",
    ],
  ];
  for (const [record, artifact, heading] of declined) {
    // Nothing is asked for on the reader's behalf: a request naming this id is
    // the failure, so it is watched for rather than waited on.
    const asked: string[] = [];
    const listen = (response: { url(): string }) => {
      if (response.url().includes("/artifacts/")) asked.push(response.url());
    };
    page.on("response", listen);
    await transcript
      .getByRole("article", { name: record })
      .getByRole("button")
      .click();
    // The record itself, with the reference on it — not a read that failed and
    // not a blank pane.
    await expect(itemDetail(page)).toContainText("Recorded at");
    await expect(itemDetail(page)).toContainText(artifact);
    await expect(itemDetail(page)).not.toContainText(heading);
    await expect(itemDetail(page)).not.toContainText("Loading");
    expect(asked).toEqual([]);
    page.off("response", listen);
    await page.keyboard.press("Escape");
  }
});

test("states when a verification artifact is unavailable", async ({ page }) => {
  await openObservatory(page, `/?run=${runs().live}&node=missing-artifact`);
  await page.getByRole("tab", { name: "Checks" }).click();
  await expect(
    page.locator(".facts").filter({ hasText: "Verification coverage" }),
  ).toContainText("Hook: not recorded");
  await page.getByRole("tab", { name: "Timeline" }).click();
  // Opened: the one collapsed line says which activity dominated the node, and what
  // this node kept is read in the lane the categories live in.
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  const rejected = page.waitForResponse(
    (response) =>
      response.url().includes("/artifacts/") && response.status() === 404,
  );
  const failedVerification = timeline(page).getByRole("button", {
    name: new RegExp(fixture().artifacts.missing),
  });
  await failedVerification.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Failure: log was removed",
  );
  await failedVerification.click();
  await rejected;
  await expect(itemDetail(page)).toContainText("No readable log was recorded.");
});

/**
 * What the API can say about a node's publication, node by node.
 *
 * `onevcs` records the branch a node opened, the outcome it reached, the change url
 * it published and the commit a merge landed as — but no url for that commit and
 * none for the branch, because those are the host's own and it writes neither. So
 * the two halves of the upstream matrix that were links are gone rather than
 * asserted against invented ones; the commit itself is held by the read API's own
 * journeys. See AGENTS.md's list of what no record fills.
 */
for (const scenario of [
  {
    name: "local direct merge",
    node: "local-direct",
    change: undefined,
  },
  {
    name: "remote change request left open",
    node: "remote-open",
    change: "https://example.invalid/changes/13",
  },
  {
    name: "remote change request merged",
    node: "foundation",
    change: undefined,
  },
] satisfies readonly {
  name: string;
  node: string;
  change: string | undefined;
}[]) {
  test(`renders the ${scenario.name} publication from the API`, async ({
    page,
  }) => {
    await openObservatory(page, `/?run=${runs().live}&node=${scenario.node}`);
    await page.getByRole("tab", { name: "PR" }).click();
    const facts = page.locator(".facts");
    const change = scenario.change ?? fixture().foundation_pr;
    if (scenario.change === undefined && scenario.node === "local-direct") {
      // Merged straight from a local workflow: no change was ever opened, and the
      // panel says so rather than linking a page that does not exist.
      await expect(facts).toContainText("Not recorded");
      await expect(facts.getByRole("link")).toHaveCount(0);
      return;
    }
    await expect(
      facts.getByRole("link", { name: "Pull request" }),
    ).toHaveAttribute("href", change);
  });
}

/**
 * The checks a host ran on a publication, which is the evidence the planner's own
 * bar is read against: reviewing gate evidence rather than a verdict alone means
 * seeing which checks ran, which are required, and that none of them skipped.
 *
 * `onevcs` reports every transition of every check it waits on, and the server
 * serves the last account of each — so this reads the words that library wrote.
 */
test("reads the checks a host observed on a publication", async ({ page }) => {
  await openObservatory(page, `/?run=${runs().live}&node=remote-open`);
  await page.getByRole("tab", { name: "Checks" }).click();
  const facts = page.locator(".facts");
  // The repository's own pre-push hook left a verdict, which is the only record
  // that it ran at all.
  await expect(facts).toContainText("Hook: present");
  await expect(facts).toContainText("Required checks: gate, e2e");
  // Each check's own state: the conclusion once it reached one, and the host's
  // status while it has not — so a required check still running cannot read as
  // one that passed, and one that never ran cannot hide.
  await expect(facts).toContainText("gate: success");
  await expect(facts).toContainText("published-smoke: failure");
  await expect(facts).toContainText("e2e: in_progress");

  // And the same checks are read beside the change they ran on, from the
  // publication the plot draws.
  await page.getByRole("tab", { name: "PR" }).click();
  await expect(
    page.locator(".facts").getByRole("link", { name: "Pull request" }),
  ).toHaveAttribute("href", fixture().remote_open_pr);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  await timeline(page)
    .getByRole("button", { name: /^Publication/ })
    .click();
  await expect(itemDetail(page)).toContainText("Observed checks");
  await expect(itemDetail(page)).not.toContainText(
    "No checks were observed on this node.",
  );
  await expect(itemDetail(page)).toContainText("published-smoke");
});

test("opens the log the failing check stored", async ({ page }) => {
  await openObservatory(page, `/?run=${runs().live}&node=remote-open`);
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  const log = page.waitForResponse(
    (response) =>
      response.url().includes(`/artifacts/${fixture().artifacts.check}`) &&
      response.status() === 200,
  );
  await timeline(page)
    .getByRole("button", { name: new RegExp(fixture().artifacts.check) })
    .click();
  await log;
  await expect(itemDetail(page)).toContainText(
    "published-smoke could not reach the published wheel",
  );
  await expect(itemDetail(page)).toContainText("Verification failed.");
});

/**
 * The contention a publication met, which is how an operator tells a slow run
 * from a queued one.
 *
 * `onevcs` times every wait on an identity's lock and relays it; a real
 * publication takes thousands of them, so the reading is the count and the total
 * rather than one segment each.
 */
test("reads the contention a publication met as one summary", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=remote-open`);
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  const waits = timeline(page).getByRole("button", { name: /^Lock waits/ });
  await expect(waits).toBeVisible();
  await expect(waits).toHaveAccessibleName(/3 recorded/);
  // Plotted at the total it carries rather than across the window the waits fell
  // in, which is what the aggregate lane is for.
  await waits.click();
  await expect(itemDetail(page)).toContainText("12s");
});

/**
 * The lint transport, which is the reason a session is served under a *pair* of
 * roles: this member has the same semantic role as the work it is reading, and
 * only the transport half tells the two apart.
 */
test("tells the lint member apart from the work it is reading", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  const lint = timeline(page).getByRole("button", { name: /^Lint/ });
  await expect(lint).toBeVisible();
  await expect(lint).toHaveAccessibleName(new RegExp(fixture().sessions.lint));
  await lint.click();
  await expect(itemDetail(page)).toContainText("The diff reads as written");
});

test("keeps a node's task, criteria, dependencies and verification reachable", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Overall" }).click();
  await expandGraphRows(page);
  await graphRowCard(page, "dashboard")
    .getByRole("button", { name: "dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(/node=dashboard/);
  await page.getByRole("tab", { name: "Task" }).click();
  await expect(page.getByText(/Build the live dashboard/)).toBeVisible();
  // Plan schema 2 retired `done_when`: a node's bar is the `## Acceptance
  // criteria` section of its own task, which is the text handed to the judge, and
  // the tab shows that section alone rather than the whole prose again.
  await page.getByRole("tab", { name: "Acceptance criteria" }).click();
  await expect(page.getByText("Users can inspect transcripts")).toBeVisible();

  await page.getByRole("tab", { name: "Dependencies" }).click();
  await expect(page.locator(".facts")).toContainText("foundation");
  await page.getByRole("tab", { name: "PR" }).click();
  await expect(page.locator(".facts")).toContainText("Not recorded");
  await expect(page.locator(".facts").getByRole("link")).toHaveCount(0);

  await openObservatory(page, `/?run=${runs().live}&node=foundation`);
  await page.getByRole("tab", { name: "PR" }).click();
  const pr = page.locator(".facts").getByRole("link", { name: "Pull request" });
  await expect(pr).toHaveAttribute("href", fixture().foundation_pr);
  await expect(pr).toHaveAttribute("target", "_blank");
  await expect(pr).toHaveAttribute("rel", "noreferrer");

  // A human action names work for a person and states no bar of its own; the
  // summary has to say that rather than render an empty criteria block.
  await openObservatory(page, `/?run=${runs().live}&node=approval`);
  await page.getByRole("tab", { name: "Acceptance criteria" }).click();
  await expect(
    page.getByText("No acceptance criteria recorded in this node's task."),
  ).toBeVisible();
});

/**
 * The one affordance a viewer has over how much of a run they are reading, driven
 * in a real browser against the real read API.
 *
 * The component tier proves the switch asks the server for the right profile; only
 * this proves the server answers, that what comes back is genuinely narrower, and
 * that the narrowed reading is an address a reader can send someone.
 */
test("switches the reading between decisions and detailed activity", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await expect(timeline(page).getByTestId("timeline-axis")).toBeVisible();

  const choice = (name: string) =>
    page.getByRole("group", { name: "Level of detail" }).getByRole("button", {
      name,
    });
  // The journal records the plot draws over its lanes. A record is exactly what a
  // filter admits or excludes, so this is the count that has to move.
  const markers = () =>
    timeline(page).getByRole("button", { name: /, marker$/ });

  // A reader who asked for nothing is reading everything, and the control says so.
  await expect(choice("Detailed activity")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(markers().first()).toBeVisible();
  const detailed = await markers().count();

  // Narrowing to the decisions is one click, and fewer records are drawn — but
  // not none, because a decision is a record too.
  await choice("Decisions").click();
  await expect(page).toHaveURL(/detail=decisions/);
  await expect(choice("Decisions")).toHaveAttribute("aria-pressed", "true");
  await expect(timeline(page).getByTestId("timeline-axis")).toBeVisible();
  await expect.poll(() => markers().count()).toBeLessThan(detailed);
  expect(await markers().count()).toBeGreaterThan(0);
  // The node's own dispatch is still drawn at the bounds the run recorded: a
  // filter narrows what is listed, never what the run did.
  await expect(
    timeline(page).getByRole("button", {
      name: /Worker \(engineer-dashboard\)/,
    }),
  ).toBeVisible();

  // The narrowed reading is an address: opened cold it arrives on the same one
  // rather than showing the detailed reading first.
  await page.reload();
  await expect(choice("Decisions")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => markers().count()).toBeLessThan(detailed);

  // And back returns to the detailed reading, so the switch is undoable the way
  // the rest of the drill-down is.
  await page.goBack();
  await expect(choice("Detailed activity")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => markers().count()).toBe(detailed);

  // An address naming a reading this app does not have is a hand-edited or an
  // outgrown link, and it lands on the detailed one — everything — rather than on
  // an empty view or a refusal. A reader who mistyped it still sees their run.
  await openObservatory(
    page,
    `/?run=${runs().live}&node=dashboard&detail=whatever`,
  );
  await expect(choice("Detailed activity")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => markers().count()).toBe(detailed);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keeps a node of hundreds of recorded sessions scannable", async ({
  page,
}) => {
  // The served run really did record hundreds of sessions on this node, which is
  // the shape that made the old detail panel unreadable.
  await openObservatory(page, `/?run=${runs().busy}&node=sweep`);
  const rows = timeline(page).getByRole("button");
  await expect(rows.first()).toBeVisible();
  const grouped = timeline(page).getByRole("button", {
    name: /grouped worker activities/,
  });
  await expect(grouped).toBeVisible();
  expect(
    await timeline(page).locator("[data-timeline-shape]").count(),
  ).toBeLessThan(12);
  await timeline(page).getByRole("button", { name: "Expand timeline" }).click();
  await expect(
    timeline(page).getByRole("button", { name: "Collapse timeline" }),
  ).toBeVisible();
  await timeline(page)
    .getByRole("button", { name: "Collapse timeline" })
    .click();

  // And one long session's own turns are handed out a page at a time in the panel,
  // so opening it does not render thirty of them at once either.
  await page
    .getByRole("article")
    .filter({ hasText: /engineer-sweep-7\b/ })
    .getByRole("button")
    .click();
  await expect(itemDetail(page)).toContainText("Swept batch 7 (0)");
  const groupedBookmark = new URL(page.url());
  await openObservatory(page, "/?view=graph");
  await openObservatory(
    page,
    `${groupedBookmark.pathname}${groupedBookmark.search}`,
  );
  await expect(itemDetail(page)).toContainText("Swept batch 7 (0)");
  await expect(itemDetail(page)).not.toContainText("Swept batch 7 (29)");
  await itemDetail(page)
    .getByRole("button", { name: /Show more of 30 turns/ })
    .click();
  await expect(itemDetail(page)).toContainText("Swept batch 7 (29)");
});

test("reports a node whose recorded work the run has not written yet", async ({
  page,
}) => {
  // `followup` never started, so the run recorded no span or event for it at all.
  // That is a real state of a live graph, and it has to be said rather than shown
  // as an empty pane that reads like a broken view.
  await openObservatory(page, `/?run=${runs().live}&node=followup`);
  await expect(
    page.getByText("This node has no recorded timeline yet."),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("zooms and reframes the graph through its canvas controls", async ({
  page,
}) => {
  await openObservatory(page);
  const viewport = page.locator(".react-flow__viewport");
  const transform = async (): Promise<string> =>
    viewport.evaluate((element) => getComputedStyle(element).transform);

  // These graphs are a handful of nodes that fit the canvas, so there is no minimap
  // over them: the zoom controls are the whole of the canvas chrome.
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  // The framing to compare against is the one the canvas settles on, not the
  // identity it mounts with: reading it before the graph has been fitted compares
  // "fit view" against a transform the reader never saw.
  await expect(graphNodes(page).first()).toBeVisible();
  await expect.poll(transform).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  const framed = await transform();
  await page.getByRole("button", { name: "zoom in" }).click();
  await expect.poll(transform).not.toBe(framed);
  // Fit view returns the whole graph to frame, which is how an operator recovers
  // from a zoom that lost the nodes.
  await page.getByRole("button", { name: "fit view" }).click();
  await expect.poll(transform).toBe(framed);
});

test("renders a graph whose node depends on another run", async ({ page }) => {
  await openObservatory(page);
  // The served plan gives `dashboard` a `run:<run_id>#<node_id>` prerequisite. It
  // names a node this graph does not hold, so it cannot be an edge — and it must not
  // take the whole view down with it either.
  await expect(graphNodes(page, "running")).toContainText("dashboard");
  await expect(
    page.getByText("The DAG view could not be displayed."),
  ).toHaveCount(0);

  // The prerequisite itself stays visible where the node's dependencies are listed.
  await graphNodes(page, "running").click();
  await page.getByRole("tab", { name: "Dependencies" }).click();
  await expect(page.locator(".facts")).toContainText(
    `run:${runs().history}#archive`,
  );
});

test("navigates historical DAGs from one list tagged by launching session", async ({
  page,
}) => {
  await openObservatory(page);
  await expect(page.getByText(/Codex session/).first()).toBeVisible();
  await expect(page.getByText(/Claude session/).first()).toBeVisible();

  // Every row states the run's own state and whether it is still moving, so the list
  // is readable without opening a run.
  const liveRow = page.getByRole("button", { name: RegExp(runs().live) });
  const historyRow = page.getByRole("button", { name: RegExp(runs().history) });
  await expect(liveRow).toContainText("active");
  await expect(historyRow).toContainText("settled");

  // The state is carried a second time by the colour of the row's mark, and never
  // by that colour alone: an active run and a settled one are two different tones,
  // and both rows say the word as well.
  const markColor = (row: Locator) =>
    row.locator(".run-dot").evaluate((mark) => getComputedStyle(mark).color);
  expect(await markColor(liveRow)).toBe(await tokenColor(page, "--info"));
  expect(await markColor(historyRow)).toBe(await tokenColor(page, "--success"));
  // And it is that mark rather than a pill of its own: the row keeps its width for
  // the run id, which is the one thing a list has to be identifiable from.
  await expect(liveRow.locator('[data-slot="badge"]')).toHaveCount(0);

  // The live marker is a bare dot, so it carries a name of its own and repeats it on
  // hover rather than leaving colour to say the only thing that distinguishes it.
  const liveMarker = liveRow.getByRole("img", { name: "Live" });
  await expect(liveMarker).toBeVisible();
  await liveMarker.hover();
  await expect(page.getByRole("tooltip")).toContainText("Live");

  await page.getByRole("button", { name: RegExp(runs().history) }).click();
  await expect(graphNodes(page, "done")).toContainText("archive");
  // The graph is what this reader is in, so the address keeps saying so as they move
  // between runs — the same way it keeps saying `overall` for a reader in that.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("view"))
    .toBe("graph");
  await page.getByRole("button", { name: RegExp(runs().live) }).click();
  await expect(graphNodes(page, "running")).toContainText("dashboard");
  await page.goBack();
  await expect(graphNodes(page, "done")).toContainText("archive");
});

test("loads another run-list page when navigation reaches the end", async ({
  page,
}) => {
  await page.goto("/?view=graph");
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  await expect(navigation.locator(".run-link")).toHaveCount(50);
  await navigation.locator("[data-radix-scroll-area-viewport]").hover();
  await page.mouse.wheel(0, 10_000);
  await expect(navigation.locator(".run-link")).toHaveCount(52);
});

test("says the next run-list page is loading while it is", async ({ page }) => {
  // Held open long enough for a reader to see it: a list that reaches its end and
  // shows nothing is a list that looks like it has simply stopped, which is what
  // an operator who could not scroll past the first page was looking at.
  await delayReads(page, RUN_LIST_READ, 1_500);
  await page.goto("/?view=graph");
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  await expect(navigation.locator(".run-link")).toHaveCount(50);

  await navigation.locator("[data-radix-scroll-area-viewport]").hover();
  await page.mouse.wheel(0, 10_000);
  await expect(navigation.getByText("Loading more runs…")).toBeVisible();
  await expect(navigation.locator(".run-link")).toHaveCount(52);
  // And it stops saying so once the page has arrived, rather than announcing a
  // read that is over.
  await expect(navigation.getByText("Loading more runs…")).toHaveCount(0);
});

/**
 * A window tall enough to hold the whole first page of runs: those fifty rows measure
 * 4350px, so this leaves room for ten more before the list would scroll again.
 */
const RUN_LIST_FITS_HEIGHT = 5200;

test("loads another run-list page from the keyboard", async ({ page }) => {
  // Fifty-odd Tab presses, each a browser round trip: the journey is latency-bound
  // rather than slow, so it needs the budget rather than the speed.
  test.slow();
  // The keyboard path and the scroll path are otherwise the same path: walking the run
  // list scrolls it, the navigation pages itself from that scroll, and `hasMore` going
  // false unmounts the control being tabbed towards. A list that fits cannot scroll.
  await page.setViewportSize({ width: 1280, height: RUN_LIST_FITS_HEIGHT });
  await page.goto("/?view=graph");
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  const loadMore = page.getByRole("button", { name: "Load more runs" });
  await expect(navigation.locator(".run-link")).toHaveCount(50);
  // Asserted rather than assumed: a first page that outgrew the window would scroll.
  expect(
    await navigation
      .locator("[data-radix-scroll-area-viewport]")
      .evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBe(0);

  expect(await tabTo(page, loadMore, 70)).toBe(true);
  // Still on the first page once the walk has arrived, so the only thing that can
  // account for the next one is the keypress below.
  await expect(navigation.locator(".run-link")).toHaveCount(50);
  await page.keyboard.press("Enter");
  await expect(navigation.locator(".run-link")).toHaveCount(52);
});

test("recovers when loading another run-list page fails", async ({
  context,
  page,
}) => {
  await page.goto("/?view=graph");
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  const viewport = navigation.locator("[data-radix-scroll-area-viewport]");
  await expect(navigation.locator(".run-link")).toHaveCount(50);

  await context.setOffline(true);
  await viewport.hover();
  await page.mouse.wheel(0, 10_000);
  await expect(page.getByRole("alert")).toContainText(
    "Telemetry request failed",
  );

  await context.setOffline(false);
  await page.mouse.wheel(0, -200);
  await page.mouse.wheel(0, 10_000);
  await expect(navigation.locator(".run-link")).toHaveCount(52);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("restores a bookmarked view and refreshes through the read API", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  const metric = (label: string) => metricTile(page, label);
  await expect(metric("Status")).toContainText("active");
  await expect(metric("Nodes")).toContainText(/[1-9]\d*/);
  // A duration in the units it is read in, never the raw second count the contract
  // serves: `58000.0s` is arithmetic homework, `16h 6m 40s` is an answer. And a
  // duration at all rather than "not measured", which is what this reads when the
  // sibling that aggregates a run's clock could not be asked.
  await expect(metric("Wall time").locator("strong")).toHaveText(
    /^(\d{1,3}ms|[1-5]?\ds|\d+m [1-5]?\ds|\d+h [1-5]?\dm [1-5]?\ds)$/,
  );
  await expect(metric("Turns")).toContainText(/\d+/);
  await expect(graphLine(page)).toBeVisible();
  await expect(page.getByText("Observe the live DAG safely")).toBeVisible();
  await expect(page.getByText(/^Codex session · /).first()).toBeVisible();

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(graphLine(page)).toBeVisible();

  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(graphNodes(page, "running")).toContainText("dashboard");
  await expect(graphLine(page)).toHaveCount(0);

  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).toBeVisible();
});

test("lands on the run as a whole, with every deep link still opening", async ({
  page,
}) => {
  // An address that names no view is an operator arriving at the observatory, and
  // what they came to read is the run — not the shape of its graph.
  await page.goto("/");
  await expect(page.getByText("DAG Observatory")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overall" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(graphLine(page)).toBeVisible();
  await expect(graphNodes(page)).toHaveCount(0);

  // Picking a second run is an operator comparing the two, so the reading they are
  // comparing them in survives the move — only the run under it changes.
  await page.getByRole("button", { name: RegExp(runs().history) }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(runs().history);
  await expect(page.getByRole("tab", { name: "Overall" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(graphLine(page)).toBeVisible();
  await expect(graphNodes(page)).toHaveCount(0);

  // Every address that does name where it is going still opens there.
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).toBeVisible();

  // The node cannot survive a move to a run that never recorded it, so leaving one
  // this way lands on the run as a whole — the reading a bare address gets — rather
  // than on the graph the node bookmark was being read through.
  await page.getByRole("button", { name: RegExp(runs().history) }).click();
  await expect(page.getByRole("tab", { name: "Overall" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).toHaveCount(0);

  await openObservatory(page);
  await expect(graphNodes(page, "running")).toContainText("dashboard");

  // An address naming a view this app does not have is an address naming none: a
  // stale bookmark lands where a bare one does rather than on an empty pane.
  await openObservatory(page, `/?run=${runs().live}&view=timeline`);
  await expect(page.getByRole("tab", { name: "Overall" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(graphLine(page)).toBeVisible();
  await expect(graphNodes(page)).toHaveCount(0);
});

test("restores node tabs and moves between them from the keyboard", async ({
  page,
}) => {
  await openObservatory(
    page,
    `/?run=${runs().live}&node=dashboard&tab=criteria`,
  );
  const criteria = page.getByRole("tab", { name: "Acceptance criteria" });
  await expect(criteria).toHaveAttribute("aria-selected", "true");
  // Clicked rather than focused: clicking the tab that is already selected is how
  // a reader with a pointer puts the tablist in focus, and it changes nothing
  // about which tab is selected — so what `ArrowRight` then moves is a rove a
  // keyboard user really reaches.
  await criteria.click();
  await expect(criteria).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Dependencies" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page).toHaveURL(/tab=dependencies/);

  await page.getByRole("tab", { name: "Timeline" }).click();
  await timeline(page)
    .getByRole("button", { name: /engineer-dashboard/ })
    .click();
  await expect(page).toHaveURL(/event=/);
  await page.getByRole("tab", { name: "Task" }).click();
  await expect(page).not.toHaveURL(/event=/);

  await page.getByRole("button", { name: /Graph/ }).click();
  await expect(page).not.toHaveURL(/tab=/);
  const foundation = page.getByRole("button", { name: "foundation: done" });
  // llmlint: ignore-block[tests_mirror_real_usage] this journey is named for the keyboard and this is the half of it a pointer cannot stand in for: selecting a graph node by clicking it is driven elsewhere in this file, and what is left to prove is that a reader who reached the node in the tab order can open it with Enter.
  await foundation.focus();
  await page.keyboard.press("Enter");
  // llmlint: ignore-end[tests_mirror_real_usage]
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Nothing observed a check on *this* node's publication, so the tab states that
  // rather than leaving an empty panel; the node that did observe some is read in
  // its own journey above.
  await page.getByRole("tab", { name: "Checks" }).click();
  await expect(page.locator(".facts")).toContainText("No checks observed");
  await expect(page.locator(".facts").getByRole("link")).toHaveCount(0);
  await page.getByRole("tab", { name: "Task" }).click();
  await expect(page.locator(".facts")).toContainText(
    "Gate completed successfully",
  );

  await page.getByRole("tab", { name: "Task" }).click();
  await page.getByRole("tab", { name: "Overall" }).click();
  await expect(page).not.toHaveURL(/tab=/);

  await openObservatory(page, `/?run=${runs().live}&node=dashboard&tab=bogus`);
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("tab", { name: "Task" }).click();
  await page.getByRole("button", { name: RegExp(runs().history) }).click();
  await expect(page).not.toHaveURL(/tab=/);
});

test("reads every recorded moment as words rather than as its stamp", async ({
  page,
}) => {
  // `approval` recorded work the run never closed, so its one item is shown as the
  // typed record it is — which is where two raw ISO strings used to reach the reader.
  await openObservatory(page, `/?run=${runs().live}&node=approval`);
  await timeline(page)
    .getByRole("button", { name: /approval/ })
    .click();
  await expect(itemDetail(page)).toContainText("Recorded at");
  await expect(itemDetail(page)).toContainText("Still running");
  // The detail reading stays human-formatted; the exact stamp belongs to the
  // timeline's accessible tooltip, where it can be copied when needed.
  await expect(itemDetail(page)).not.toContainText(/\d{4}-\d\d-\d\dT/);
  await expect(itemDetail(page)).not.toContainText(/\d+\.\d+s/);
  // The whole instant stays reachable: it is the reading's own tooltip, and the
  // recorded stamp is on the element the browser can read it off.
  // What a fact list is asked is how recent the record is, so it is read as an age —
  // the run wrote this journal moments ago, and that is what it says.
  const recorded = itemDetail(page).locator(".facts time").first();
  await expect(recorded).toHaveText(/^\d+ (second|minute|hour|day)s? ago$/);
  await expect(recorded).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
  await expect(recorded).toHaveAttribute("title", /\d{4}/);

  // Across a populated node, metadata stays in the visualization's hover detail.
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  const dashboardWorker = timeline(page).getByRole("button", {
    name: /engineer-dashboard/,
  });
  await dashboardWorker.hover();
  // The dispatch ran for as long as the run recorded it running, not the instant a
  // start stamp alone gives it: a real duration, in seconds, rather than the
  // "not recorded" a point carries.
  await expect(page.getByRole("tooltip")).toContainText(
    /Duration: \d+(\.\d+)? (s|min)/,
  );
});

test("tags every run of one launching session with it, in one flat list", async ({
  page,
}) => {
  await openObservatory(page);
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  // One list, ordered by what moved last. Nothing gathers the rows into sections,
  // because a grouping outranks that order: the run an operator came to look at
  // stops being at the top, and on a host with fifty of them stops being on the
  // first page at all.
  await expect(navigation.locator(".run-link").first()).toBeVisible();
  await expect(navigation.getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(navigation.locator("section")).toHaveCount(0);

  // Three of the served runs record the same launch id, as one planner session
  // driving several graphs does. Each of the three carries that session as a tag on
  // its own row rather than sharing a heading with the others.
  for (const runId of [runs().live, runs().sibling, runs().busy]) {
    await expect(
      navigation.getByRole("button", { name: RegExp(runId) }),
    ).toContainText(/Codex session · /);
  }
  // The claude launch has no protected provenance record at all — the state every
  // launch reaches once that short-lived record expires — and its run is still
  // named by the session that launched it, from what the run directory recorded.
  await expect(page.getByText(/Claude session/).first()).toBeVisible();

  await navigation
    .getByRole("button", { name: RegExp(runs().sibling) })
    .click();
  await expect(graphNodes(page, "running")).toContainText("sibling");
});

test("tags a run with no recorded launch as unattributed", async ({ page }) => {
  await openObservatory(page);
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  await expect(page.getByText(/Codex session/).first()).toBeVisible();
  // The server serves this run with no launch join and no transcripts at all; it
  // still has to be reachable rather than dropped from the navigation, and it reads
  // as honestly unattributed rather than as an unknown session.
  await expect(
    navigation.getByRole("button", { name: RegExp(runs().unattributed) }),
  ).toContainText("Unattributed");
  // A run recorded before attribution reached the run directory, whose protected
  // record is gone too: nothing can name its session, so it is named by the launch
  // it did record rather than pooled with the runs that recorded nothing at all.
  await expect(
    navigation.getByRole("button", { name: RegExp(runs().eventless) }),
  ).toContainText(`Unattributed launch · ${runs().eventless.slice(0, 8)}…`);

  await navigation
    .getByRole("button", { name: RegExp(runs().unattributed) })
    .click();
  await expect(graphNodes(page, "running")).toContainText("orphan");
  await expect(page.getByText("Continue unattributed work")).toHaveCount(0);
});

test("lists a run that has recorded no event beside the runs that have", async ({
  page,
}) => {
  await openObservatory(page);
  // The served root mixes both shapes: four runs with journalled events and one that
  // has journalled none. The client parses the run list as a whole, so a run whose
  // `last_event` it rejected would take every other run down with it and leave the
  // operator looking at "No DAG runs found" — the state this fixture would have
  // reproduced before `last_event` became nullable.
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  for (const runId of Object.values(runs())) {
    await expect(
      navigation.getByRole("button", { name: RegExp(runId) }),
    ).toBeVisible();
  }
  await expect(page.getByText("No DAG runs found")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Its overall view names the absence instead of trailing off after "last event".
  await openObservatory(page, `/?run=${runs().eventless}&view=overall`);
  const hero = page.locator(".overall-hero");
  await expect(hero).toContainText("no events recorded yet");
  await expect(hero).not.toContainText("null");
  await expect(hero).not.toContainText("last event");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("opens a run-level session other than the one shown on arrival", async ({
  page,
}) => {
  // Which transcripts the browser really asked the server for — counted by session
  // rather than by request, since a development build mounts every effect twice.
  const transcripts = new Set<string>();
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.includes("/conversations/"))
      transcripts.add(decodeURIComponent(pathname.split("/").at(-1) ?? ""));
  });

  // The served run records two sessions at no node: the orchestrator's own, and the
  // run's check-in beside it. The graph view plots them and reads neither, because
  // it is a reading of the record rather than a download of it.
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  await expandGraphRows(page);
  const runLevel = page.getByRole("region", { name: "Run-level timeline" });
  await expect(runLevel).toBeVisible();
  await expect.poll(() => transcripts.size).toBe(0);
  // Opened into its own lanes: two sessions the run never closed both run to the
  // moment this payload was read, so on the one collapsed line the later one lies
  // inside the earlier and only one of them can own a moment.
  await runLevel.getByRole("button", { name: "Expand timeline" }).click();

  // Each opens in the two-thirds panel beside the plot, with the turns labelled by
  // the role the segment that opened them was named with.
  await runLevel
    .getByRole("button", { name: /^Run-level · Orchestrator/ })
    .click();
  await expect(itemDetail(page)).toContainText(
    "Coordinating the execution frontier",
  );
  await expect(
    itemDetail(page)
      .getByRole("article", { name: /^Turn / })
      .first(),
  ).toBeVisible();
  await expect.poll(() => transcripts.size).toBe(1);

  // The panel takes two thirds of the working area and lies over the plot it was
  // opened from, so reading the next session means closing this one — which Escape
  // does here exactly as it does in the node view.
  await page.keyboard.press("Escape");
  await expect(itemDetail(page)).toHaveCount(0);
  await runLevel.getByRole("button", { name: /^Run-level · Check-in/ }).click();
  await expect(itemDetail(page)).toContainText("Progress reported");
  await expect(itemDetail(page)).toContainText("Check-in");
  await expect.poll(() => transcripts.size).toBe(2);
});

test("draws a run that recorded no run-level session as a silent row", async ({
  page,
}) => {
  // The settled run's history holds a worker session and no orchestrator one, so its
  // run-level row recorded nothing at all — which is a row of idle rather than a row
  // that has been left out, and it is drawn beside the node that did work.
  await openObservatory(page, `/?run=${runs().history}&view=overall`);
  await expandGraphRows(page);
  const runLevel = page.getByRole("region", { name: "Run-level timeline" });
  await expect(runLevel.getByRole("button", { name: /^Idle · / })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("region", { name: "archive timeline" }),
  ).toBeVisible();
});

test("reads the whole run as one clock, node by node, from one line", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&view=overall`);

  // Collapsed, the run is a single line covering everything it has recorded. Its
  // clock runs from the launch to the moment the record was read, which for a run
  // still going is now — and no row of any kind is drawn yet.
  await expect(graphLine(page)).toBeVisible();
  await expect(page.getByRole("region", { name: /\stimeline$/ })).toHaveCount(
    1,
  );
  await expect(
    graphLine(page).getByRole("button", { name: /^Idle · / }),
  ).not.toHaveCount(0);

  // Opened once: one row per plan node, and the run's own driving sessions beside
  // them rather than folded into a node that never dispatched them.
  await expandGraphRows(page);
  for (const node of ["foundation", "dashboard", "publish", "queued"]) {
    await expect(graphRow(page, node)).toBeVisible();
  }
  const dashboard = graphRow(page, "dashboard");
  // Collapsed, a row is one line whatever it holds.
  await expect(dashboard.getByTestId("timeline-lane")).toHaveCount(1);

  // Opened again: that node's own category lanes, the same vocabulary its node view
  // draws, one row per role the run recorded a session under.
  await dashboard.getByRole("button", { name: "Expand timeline" }).click();
  for (const lane of ["worker", "judge", "check-in"]) {
    await expect(
      dashboard
        .getByTestId("timeline-lane")
        .and(page.locator(`[data-lane-id="${lane}"]`)),
    ).toHaveCount(1);
  }
  // And the other rows are untouched: opening one node is not opening the graph.
  await expect(
    graphRow(page, "publish").getByTestId("timeline-lane"),
  ).toHaveCount(1);
});

test("keeps every graph row on one scale when any of them is zoomed", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  await expandGraphRows(page);
  const dashboard = graphRow(page, "dashboard");
  const runLevel = page.getByRole("region", { name: "Run-level timeline" });

  // Every plot starts on the same clock, which is what makes a column of one row
  // mean the same instant as the column above it.
  const before = await axisTicks(graphLine(page));
  expect(await axisTicks(dashboard)).toBe(before);
  expect(await axisTicks(runLevel)).toBe(before);

  // Zooming *one* row reframes all of them, because there is one range and every
  // plot is drawn against it.
  await dashboard.getByLabel(/^Timeline plot/).hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(() => axisTicks(dashboard)).not.toBe(before);
  const zoomed = await axisTicks(dashboard);
  expect(await axisTicks(graphLine(page))).toBe(zoomed);
  expect(await axisTicks(runLevel)).toBe(zoomed);

  // And resetting from any of them puts every one of them back.
  await runLevel.getByRole("button", { name: "Reset timeline zoom" }).click();
  await expect.poll(() => axisTicks(graphLine(page))).toBe(before);
  expect(await axisTicks(dashboard)).toBe(before);
});

test("draws the stretches the run recorded nothing in", async ({ page }) => {
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  await expandGraphRows(page);
  const runLevel = page.getByRole("region", { name: "Run-level timeline" });

  // The run-level row records the driver, then a gap, then the run's check-in.
  // That gap is drawn as a segment of its own: blank space is the one reading to
  // avoid here, because it cannot be told from a record that is missing.
  const idle = runLevel.getByRole("button", { name: /^Idle · / }).first();
  await expect(idle).toBeVisible();
  // Distinct to look at, not merely to a screen reader: work is a solid bar and
  // silence is hatched, so a glance at the row already separates the two.
  const hatching = await idle.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  expect(hatching).toContain("repeating-linear-gradient");
  const working = await runLevel
    .getByRole("button", { name: /^Run-level · Orchestrator/ })
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(working).not.toContain("repeating-linear-gradient");

  // And how long it was silent is on the segment itself rather than left to be
  // measured off the axis.
  await idle.hover();
  await expect(page.getByRole("tooltip")).toContainText("Lane: idle");

  // A node the run never reached is that same reading for its whole life.
  const queued = graphRow(page, "queued");
  await expect(queued.getByRole("button", { name: /^Idle · / })).toHaveCount(1);
  await expect(queued.getByRole("button", { name: /^queued · / })).toHaveCount(
    0,
  );

  // A gap too narrow to see is not drawn at all. This run's journal is written in
  // one pass, so `foundation` verified and published milliseconds apart inside a
  // window of minutes — a hairline nobody could read or click. Only the two gaps at
  // the ends survive, and they always do: they are what makes every row span the
  // same interval, which is what one shared zoom rests on.
  await expect(
    graphRow(page, "foundation").getByRole("button", { name: /^Idle · / }),
  ).toHaveCount(2);

  // How much of its life each row spent working, and how much it did not, is on the
  // row rather than left to be measured off the plot.
  await expect(
    graphRowCard(page, "queued").locator(".graph-row-facts"),
  ).toHaveText(/^0ms recorded · \d+m \d+s idle$/);
});

test("frames a different run from scratch when the reader moves to it", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  await expandGraphRows(page);
  const dashboard = graphRow(page, "dashboard");
  await dashboard.getByRole("button", { name: "Expand timeline" }).click();
  await dashboard.getByLabel(/^Timeline plot/).hover();
  await page.mouse.wheel(0, -300);
  await expect(
    graphLine(page).getByRole("button", { name: "Reset timeline zoom" }),
  ).toBeEnabled();

  // A different run is a different clock, so none of that framing follows it there:
  // one run's zoom over another run's record would be a plot of nothing.
  await page.getByRole("button", { name: RegExp(runs().history) }).click();
  await expect(graphLine(page)).toBeVisible();
  await expect(page.getByRole("region", { name: /\stimeline$/ })).toHaveCount(
    1,
  );
  await expect(
    graphLine(page).getByRole("button", { name: "Reset timeline zoom" }),
  ).toBeDisabled();
});

test("says a run has recorded no timeline rather than drawing an empty one", async ({
  page,
}) => {
  // The served `dag-ui-eventless` run has its plan written and has journalled
  // nothing at all — what every run looks like for its first moments. There is no
  // clock to plot, and saying so is not the same answer as an empty plot.
  await openObservatory(page, `/?run=${runs().eventless}&view=overall`);
  await expect(
    page.getByText("This run has recorded no timeline yet."),
  ).toBeVisible();
  await expect(graphLine(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("drills from a graph row into that node's own view", async ({ page }) => {
  await openObservatory(page, `/?run=${runs().live}&view=overall`);
  await expandGraphRows(page);
  // The row's own name is one way in, from the level where the rows first appear.
  await graphRowCard(page, "foundation")
    .getByRole("button", { name: "foundation", exact: true })
    .click();
  await expect(page).toHaveURL(/node=foundation/);
  await expect(
    page.getByRole("region", { name: "Timeline for foundation" }),
  ).toBeVisible();

  // And so is any segment of it, at the level where each category has its own lane.
  await page.getByRole("tab", { name: "Overall" }).click();
  await expandGraphRows(page);
  const foundation = graphRow(page, "foundation");
  await foundation.getByRole("button", { name: "Expand timeline" }).click();
  // The first of them: this node kept two pieces of evidence — its member's report
  // and its gate's log — and either segment is the same way in.
  await foundation
    .getByRole("button", { name: /^foundation · Verification/ })
    .first()
    .click();
  await expect(page).toHaveURL(/node=foundation/);

  // Silence counts as one of its segments: the row *is* the node, working or not.
  await page.getByRole("tab", { name: "Overall" }).click();
  await expandGraphRows(page);
  await graphRow(page, "dashboard")
    .getByRole("button", { name: /^Idle · / })
    .first()
    .click();
  await expect(page).toHaveURL(/node=dashboard/);
  await expect(
    page.getByRole("region", { name: "Timeline for dashboard" }),
  ).toBeVisible();
});

test("connects to the server's event stream on load", async ({ page }) => {
  await openObservatory(page);
  // The server opens every connection with a snapshot, so the header gains a
  // last-updated reading only once the browser's EventSource really connected. The
  // journeys below then change the served run and assert what the stream carries.
  await expect(page.getByText(/Last updated/)).toBeVisible();
});

test("recovers the selection when a bookmarked run is not being served", async ({
  page,
}) => {
  await openObservatory(page, "/?run=absent-run&node=dashboard");
  // The server serves no such run, so the view falls back to a real one and
  // rewrites the address rather than stranding the operator on an empty graph.
  await expect(graphNodes(page, "running")).toContainText("dashboard");
  await expect
    .poll(() => new URL(page.url()).search)
    .toContain(`run=${runs().live}`);

  // The same fallback from the overall reading keeps the operator in it: only the
  // run under the view is rewritten, so a stale bookmark never also moves them.
  await openObservatory(page, "/?run=absent-run");
  await expect(graphLine(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overall" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(() => new URL(page.url()).search)
    .toContain(`run=${runs().live}`);
});

test("reflows navigation, detail, and metrics at a narrow viewport", async ({
  page,
}) => {
  const width = async (locator: Locator): Promise<number | undefined> =>
    (await locator.boundingBox())?.width;
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  const metrics = metricTiles(page);
  /**
   * Which way, if either, the whole reading spills out of the viewport it was given.
   *
   * A view that overflows the document does not merely look wrong: the widest row
   * sized the working area and clipped every other one against the right edge, and
   * a document with anywhere to scroll to gets scrolled by the first
   * `scrollIntoView` the transcript makes — taking the navigation and the pinned
   * timeline off screen with it.
   */
  const viewportOverflow = async () =>
    page.evaluate(() => {
      const root = document.documentElement;
      return {
        overflowsX: root.scrollWidth > root.clientWidth,
        overflowsY: root.scrollHeight > root.clientHeight,
      };
    });

  await page.setViewportSize({ width: 1400, height: 900 });
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  expect(await viewportOverflow()).toEqual({
    overflowsX: false,
    overflowsY: false,
  });
  await timeline(page)
    .getByRole("button", { name: /engineer-dashboard/ })
    .click();
  await expect(navigation).toBeVisible();
  expect(await width(navigation)).toBe(280);
  // The plot keeps the full working width for its bars, and whatever is opened over
  // it takes two thirds of that width — enough to read a turn in.
  expect(await width(timeline(page))).toBeGreaterThan(380);
  expect((await width(itemDetail(page))) ?? 0).toBeCloseTo(
    (1400 - 280) * (2 / 3),
    -1,
  );
  await page.getByRole("button", { name: "Close detail" }).click();
  // Four metrics across one row while there is room for them.
  await page.getByRole("tab", { name: "Overall" }).click();
  await expect(metrics).toHaveCount(4);
  const wideRows = await metrics.evaluateAll((tiles) =>
    tiles.map((tile) => tile.getBoundingClientRect().top),
  );
  expect(new Set(wideRows).size).toBe(1);

  await page.setViewportSize({ width: 800, height: 700 });
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  // Below the layout's breakpoint the six named readings wrap onto a second row
  // rather than widening the view that holds them — and rather than overflowing a
  // centred row, which spilled the first and last of them past both edges of a
  // scroller that could only ever reach one of the two.
  expect(await viewportOverflow()).toEqual({
    overflowsX: false,
    overflowsY: false,
  });
  const tabStrip = page.getByRole("tablist", { name: "Node details" });
  const stripBox = await tabStrip.boundingBox();
  if (stripBox === null) throw new Error("the node tab strip has no bounds");
  const labels = await tabStrip.getByRole("tab").all();
  expect(labels).toHaveLength(6);
  for (const label of labels) {
    // Both axes: the row they spill past horizontally is only reachable one way, and
    // the row they spill past vertically is drawn under the reading below and reaches
    // nobody at all.
    const box = await label.boundingBox();
    if (box === null) throw new Error("a node tab has no bounds");
    expect(box.x).toBeGreaterThanOrEqual(stripBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(stripBox.x + stripBox.width);
    expect(box.y).toBeGreaterThanOrEqual(stripBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(
      stripBox.y + stripBox.height,
    );
    await expect(label).toBeInViewport();
  }
  await timeline(page)
    .getByRole("button", { name: /engineer-dashboard/ })
    .click();
  // Everything stays on screen: the navigation and the rail each give up width,
  // and the metrics wrap onto a second row instead of being squeezed.
  await expect(navigation).toBeVisible();
  expect(await width(navigation)).toBe(220);
  expect(await width(timeline(page))).toBeGreaterThan(190);
  expect((await width(itemDetail(page))) ?? 0).toBeCloseTo(
    (800 - 220) * (2 / 3),
    -1,
  );
  await page.getByRole("button", { name: "Close detail" }).click();
  // The panel opened and closed over the view without ever giving the document
  // somewhere to scroll to.
  expect(await viewportOverflow()).toEqual({
    overflowsX: false,
    overflowsY: false,
  });
  await page.getByRole("tab", { name: "Overall" }).click();
  await expect(metrics).toHaveCount(4);
  const narrowRows = await metrics.evaluateAll((tiles) =>
    tiles.map((tile) => tile.getBoundingClientRect().top),
  );
  expect(new Set(narrowRows).size).toBe(2);
});

test("keeps the timeline's clock readable when its lanes outgrow the view", async ({
  page,
}) => {
  /** How far the axis falls outside the region that holds it, in pixels. */
  const clipped = async (): Promise<number> => {
    const region = await timeline(page).boundingBox();
    const axis = await timeline(page)
      .getByTestId("timeline-axis")
      .boundingBox();
    if (region === null || axis === null)
      throw new Error("the timeline has no bounds to read");
    return Math.max(
      0,
      region.y - axis.y,
      axis.y + axis.height - (region.y + region.height),
    );
  };
  /** Whether the plot really is taller than the room it was given. */
  const overflowing = async (): Promise<boolean> =>
    timeline(page).evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    );

  // The laptop the layout is designed against, the compact size below its breakpoint,
  // and the phone the matrix ends at: ten lanes and a reading do not both fit the
  // last two at any share of them, so the viewports state different things about the
  // expanded plot. The collapsed one they all state the same thing about.
  for (const viewport of [
    { width: 1400, height: 900, expandedFits: true },
    { width: 800, height: 700, expandedFits: false },
    { width: PHONE.width, height: PHONE.height, expandedFits: false },
  ]) {
    await page.setViewportSize(viewport);
    await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
    await expect(timeline(page).getByTestId("timeline-axis")).toBeVisible();
    // The view an operator lands on is never cut: the collapsed plot is one line, and
    // the region holds it and its clock whole at every width — including the one
    // whose ten lane names wrap the legend onto a second row.
    expect(await overflowing()).toBe(false);
    expect(await clipped()).toBe(0);

    await timeline(page)
      .getByRole("button", { name: "Expand timeline" })
      .click();
    expect(await overflowing()).toBe(!viewport.expandedFits);
    if (!viewport.expandedFits) {
      // Where the lanes cannot fit, the region scrolls rather than dropping what it
      // could not draw, and the clock is at the end of that scroll — whole, not the
      // half-drawn line of digits the bottom edge used to leave. The wheel over the
      // region is how an operator reaches that end, so it is what carries the journey
      // there; a `scrollTop` written from script would prove the layout without ever
      // proving the region really scrolls under one.
      await timeline(page).hover();
      await page.mouse.wheel(0, 10_000);
      await expect
        .poll(() =>
          timeline(page).evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    expect(await clipped()).toBe(0);
    // Still the axis it was, not a stub of one: both ticks, each naming the wall
    // clock and the elapsed time the reader tracks lanes against.
    const ticks = timeline(page).getByTestId("timeline-axis").locator("span");
    await expect(ticks).toHaveCount(2);
    for (const tick of await ticks.allTextContents()) {
      expect(tick).toMatch(/\d{2}:\d{2}:\d{2}.*[+−]\d/u);
    }
    await expect(ticks.first()).toBeInViewport();
  }
});

test("paints the design system's components in the application's dark palette", async ({
  page,
}) => {
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);

  // `dark` on the document element is the switch @oneharness/ui's stylesheet selects
  // its dark tokens with. Without it every component the package ships renders its
  // light default inside this dark application shell.
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  // The node view's own cards are the package's Card, so their surface proves two
  // things at once: that the utilities its components are written in are generated
  // for this app at all, and that they resolve to the dark token rather than white.
  await timeline(page)
    .getByRole("button", { name: /engineer-dashboard/ })
    .click();
  const card = await backgroundColor(
    itemDetail(page).locator('[data-slot="card"]').first(),
  );
  // An opaque `rgb(…)`: a token this build never defined would leave the utility
  // invalid and the surface transparent, which is the shape this must not accept.
  expect(card).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  expect(card).toBe(await tokenColor(page, "--card"));
  expect(brightestChannel(card)).toBeLessThan(80);

  // The transcripts the package renders sit on that same surface, which is the
  // defect an operator saw on every node they opened.
  const turn = page.getByRole("article", { name: /^Turn / }).first();
  await expect(turn).toBeVisible();
  expect(
    await backgroundColor(
      turn.locator("xpath=ancestor::*[@data-slot='card'][1]"),
    ),
  ).toBe(card);

  // And the application's own chrome is painted from the same token set rather than
  // a hand-picked palette beside it.
  const panel = await backgroundColor(timeline(page));
  expect(panel).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  expect(panel).toBe(await tokenColor(page, "--background"));

  // The graph canvas scopes its own variables, so it needs its own switch; without
  // it the zoom controls stay white inside the dark workspace. They are reached by
  // leaving the node view, which is the only place the canvas renders.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  expect(
    brightestChannel(
      await backgroundColor(
        page.locator(".react-flow__controls-button").first(),
      ),
    ),
  ).toBeLessThan(80);
});

test("tells each outcome apart by the palette's semantic tones", async ({
  page,
}) => {
  await openObservatory(page);
  // The node view states its node's state in words beside the graph's colour, which
  // is the only reading of it available to anyone who cannot rely on that colour.
  // Each reading is checked against its word too, so a selector that drifted onto
  // one of the view's other badges would fail rather than pass quietly.
  const stateBadge = page.locator(
    '.node-view-facts > [data-slot="badge"].node-view-state',
  );

  /**
   * Open one node's view, retrying the *click* and not only the reading of what it
   * produced: closing a view mounts a fresh canvas, and a click delivered into that
   * remount selects nothing, which no assertion under it can wait out. Only this
   * journey opens eight views in sequence, so only it is exposed. See [The three ways
   * a wall-clock assertion is
   * fixed](../../../docs/repo-lifecycle.md#the-three-ways-a-wall-clock-assertion-is-fixed).
   */
  const openNode = async (card: Locator, state: string): Promise<void> => {
    await expect(async () => {
      // Whatever a previous attempt opened has to close again before the canvas is
      // back on screen to be clicked at all.
      if ((await page.locator(".node-view").count()) > 0) {
        await page.keyboard.press("Escape");
        await expect(page.locator(".node-view")).toHaveCount(0);
      }
      await card.click();
      await expect(stateBadge).toHaveText(state);
    }).toPass({ timeout: 45_000 });
  };

  // Reading a state costs an operator nothing only while the outcomes look different:
  // settled work green, work that was lost red, work still moving blue. The design
  // system's own status vocabulary stops at four states and includes none of these
  // words, so without the app's mapping every one of them paints the same neutral
  // pill. `toHaveCSS` rather than one reading of the computed style: the badge
  // transitions its colour, so an immediate read catches it partway between two.
  for (const { state, token } of [
    { state: "done", token: "--success" },
    { state: "cancelled", token: "--destructive" },
    { state: "failed", token: "--destructive" },
    { state: "running", token: "--info" },
  ]) {
    await openNode(graphNodes(page, state).first(), state);
    await expect(stateBadge).toHaveCSS("color", await tokenColor(page, token));
    await page.keyboard.press("Escape");
  }

  // Held work is neither settled nor lost: it needs something outside it to move, and
  // painting it neutral would say there is nothing to report about a node that is
  // going nowhere. `waiting` keeps its neutral badge beside its amber card — a human
  // action is the graph's own normal shape, and the card is where that is said.
  const held = await tokenColor(page, "--warning");
  for (const state of ["blocked", "skipped"]) {
    await openNode(graphNodes(page, state), state);
    await expect(stateBadge).toHaveCSS("color", held);
    await page.keyboard.press("Escape");
  }

  // Work that has not started has no outcome to report, so it must not borrow one of
  // those meanings — which is also what stops the assertions above from passing on a
  // mapping that simply paints everything.
  const neutral = await tokenColor(page, "--foreground");
  for (const state of ["waiting", "pending"]) {
    await openNode(graphNodes(page, state), state);
    await expect(stateBadge).toHaveCSS("color", neutral);
    await page.keyboard.press("Escape");
  }

  // The run list is the other surface that states an outcome, and `settled` — the
  // word this executor's own CLI prints — is a state the package's badge does not
  // know at all.
  const runRow = (runId: string): Locator =>
    page.getByRole("button", { name: RegExp(runId) });
  const runMark = (runId: string): Locator => runRow(runId).locator(".run-dot");
  await expect(runRow(runs().history)).toContainText("settled");
  await expect(runMark(runs().history)).toHaveCSS(
    "color",
    await tokenColor(page, "--success"),
  );
  await expect(runRow(runs().live)).toContainText("active");
  await expect(runMark(runs().live)).toHaveCSS(
    "color",
    await tokenColor(page, "--info"),
  );
  // A run's state is an open string in the read contract, and the sibling run's
  // driver is gone without a result having been recorded — a real state with no
  // outcome in it. The list says the word and paints its mark with no meaning in
  // it rather than borrowing one of the tones above.
  await expect(runRow(runs().sibling)).toContainText("driver-dead");
  await expect(runMark(runs().sibling)).toHaveCSS(
    "color",
    await tokenColor(page, "--muted-foreground"),
  );

  // And the canvas says the same things on its own surfaces, out of the same tokens
  // rather than the hex values it used to carry. `waiting` is blocked work, the one
  // meaning the cards state and the badges deliberately do not.
  for (const { state, token } of [
    { state: "done", token: "--success-surface" },
    { state: "failed", token: "--destructive-surface" },
    { state: "running", token: "--info-surface" },
    { state: "waiting", token: "--warning-surface" },
    { state: "blocked", token: "--warning-surface" },
    { state: "skipped", token: "--warning-surface" },
  ]) {
    await expect(graphNodes(page, state).first()).toHaveCSS(
      "background-color",
      await tokenColor(page, token),
    );
  }
});

test("shows the loading view while its first read is still in flight", async ({
  page,
}) => {
  // A UI origin proxying to a listener that accepts and never answers: the app's
  // own request really is outstanding, which is the only honest way to hold the
  // loading view still long enough to look at.
  await page.goto(STALLED_UI_URL);
  await expect(page.getByText("Loading execution history…")).toBeVisible();
  // Placeholder bars stand where the run will be, so the wait reads as work in
  // progress rather than as a screen that has finished and found nothing.
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(page.getByText("No DAG runs found")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("surfaces a telemetry read it cannot complete", async ({ page }) => {
  // A UI origin whose proxy target is not listening: the browser's own fetch and
  // EventSource both fail for real, and the operator must be told rather than shown
  // an empty graph that looks like "no runs yet".
  await page.goto(OFFLINE_UI_URL);
  const banner = page.getByRole("alert");
  await expect(banner).toContainText("Live telemetry issue");
  // The banner names the failure as well as announcing one: an operator who cannot
  // see what broke cannot tell a wedged server from a mistyped API address.
  await expect(
    banner.locator('[data-slot="alert-description"]'),
  ).not.toBeEmpty();
  await expect(page.getByText("Waiting for first update")).toBeVisible();

  // The one control that can retry the read stays reachable while the read is
  // failing, and reporting the failure again is the honest outcome of pressing it.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(banner).toContainText("Live telemetry issue");
});

test("reports a reading the served run has no profile for", async ({
  page,
}) => {
  // The other half of the detail route's one swallowed failure. That swallow is
  // matched on the code and never on the status, because `404` is no longer only
  // the swept-run race: a filter naming a profile the run does not have is one too,
  // and it is a reading the viewer asked for and did not get. Swallowed on the
  // status, it would leave them looking at the previous reading with nothing said.
  await readUnderProfile(page, "auditor");
  await page.goto(`/?run=${runs().live}&view=graph`);

  const banner = page.getByRole("alert");
  await expect(banner).toContainText("Live telemetry issue");
  // In the server's own words, naming the reading it refused — an operator who
  // cannot see which reading was refused cannot tell it from a wedged read.
  await expect(banner).toContainText('"auditor" is not a filter profile');
  // And nothing is drawn under the name of a reading that was never served.
  await expect(page.getByText("Loading execution history…")).toBeVisible();
});

// The remaining journeys change what the server is serving, so they run last and in
// order: each one leaves the fixture advanced for the ones after it.

test("streams real progress the server observes on disk", async ({ page }) => {
  await openObservatory(page);
  await expect(graphNodes(page, "running")).toContainText("dashboard");

  // Record progress the way the executor does: one appended authoritative event.
  // The server's own poll notices it and invalidates the run over SSE.
  changeServedRuns(["--settle-dashboard"]);

  await expect(
    graphNodes(page, "done").filter({ hasText: "dashboard" }),
  ).toBeVisible();
  await expect(graphNodes(page, "running")).toHaveCount(0);
  await expect(page.getByText(/Last updated/)).toBeVisible();
});

test("shows a turn the dispatch relays while its transcript is open", async ({
  page,
}) => {
  // Two live readings of one open transcript: what the member is doing *inside* the
  // turn it is taking, which `oneagentgraph` publishes as it works and the server
  // relays over `activity.changed`, and the turn itself arriving after it.
  await openObservatory(page, `/?run=${runs().live}&view=graph`);
  await page
    .getByRole("button", { name: /dashboard: (running|done)/ })
    .press("Enter");
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("button", { name: /^Open Worker \(engineer-dashboard\)/ })
    .click();
  await expect(
    page.getByText("Implementing the dashboard now").first(),
  ).toBeVisible();

  // Recorded the way the member records one: a bounded tool summary, published
  // from inside a turn that has not finished. The reader is told what it is doing
  // rather than waiting for the turn to end to find out.
  changeServedRuns([
    "--record-activity",
    "Bash",
    "--activity-detail",
    "just gate",
  ]);
  await expect(page.getByText("dashboard: Bash just gate")).toBeVisible();

  // Recorded the way the executor records one: an appended authoritative event.
  // Grown past what the session already holds — the fixture opens four turns on
  // this member, the last of them the one the planner redirected — so what this
  // waits for is a record that did not exist when the page was opened.
  changeServedRuns(["--grow-worker-session", "5"]);
  await expect(
    page.getByText("Dashboard turn 4 arrived").first(),
  ).toBeVisible();

  // A newly opened run-scoped stream receives what is already recorded, rather than
  // waiting for the next change to it.
  await page.reload();
  await expect(
    page.getByText("Dashboard turn 4 arrived").first(),
  ).toBeVisible();
});

/**
 * The fixture command's own contract, which is the one thing standing between a
 * mistyped journey and a served run that records something no library could have
 * written.
 *
 * Driven the way a journey drives it — the real script, over the real workspace —
 * because a guard nobody has watched refuse is a guard nobody knows is there.
 */
test("refuses a change no recorded run could have held", () => {
  for (const [args, said] of [
    [["--record-activity", "Bash"], "needs --activity-detail"],
    [["--activity-detail", "just gate"], "needs --record-activity"],
    [
      ["--record-activity", "Bash", "--activity-detail", ""],
      "a tool summary is 1 to 160 characters",
    ],
    [
      ["--record-activity", "not a tool", "--activity-detail", "just gate"],
      "is not a tool name",
    ],
    [["--grow-worker-session", "many"], "is not a turn count"],
    [["--churn-live", "5"], "needs --churn-interval"],
    [["--churn-interval", "50"], "needs --churn-live"],
    [
      ["--churn-live", "many", "--churn-interval", "50"],
      "a churn is 1 to 1000 records",
    ],
    [
      ["--churn-live", "5", "--churn-interval", "0"],
      "a churn interval is 1 to 5000 ms",
    ],
    [["--remove-run", "../etc"], "is not a usable run id"],
    [["--stall", "--refuse-port", "no"], "is not a port"],
    // Two changes in one invocation: the dispatch is a chain, so the second
    // would be dropped by whichever branch matched first and the caller would
    // read a run that recorded only half of what they asked for.
    [["--settle-dashboard", "--remove-page-runs"], "are more than one change"],
  ] satisfies readonly [string[], string][]) {
    const refused = refusedInvocation(args);
    expect(refused.status, args.join(" ")).toBe(2);
    expect(refused.stderr, args.join(" ")).toContain(said);
    expect(refused.stderr, args.join(" ")).toContain("ACTION:");
  }

  // The workspace is the one option this script *deletes* through, so it is
  // refused rather than resolved against whatever directory the caller was in.
  const relative = refusedInvocation(["--settle-dashboard"], "runs");
  expect(relative.status).toBe(2);
  expect(relative.stderr).toContain("is not an absolute path");

  // Absolute is not enough in front of that delete: a workspace outside the temp
  // root Playwright makes them in is somebody else's directory, and this refuses
  // it before it reads or removes anything under it — `/etc` is still here.
  const elsewhere = refusedInvocation(["--settle-dashboard"], "/etc");
  expect(elsewhere.status).toBe(2);
  expect(elsewhere.stderr).toContain("directory");
  expect(existsSync("/etc/hosts")).toBe(true);

  // And the temp root is shared with every other program on this host, so being
  // under it is not enough either: a directory there that this tier did not make
  // is somebody's, and one *inside* a workspace would let an argument delete
  // within another run's. Both are refused with the run's own files still there.
  const somebodyElses = mkdtempSync(join(tmpdir(), "not-this-tiers-"));
  writeFileSync(join(somebodyElses, "theirs.txt"), "theirs\n");
  const outsider = refusedInvocation(["--settle-dashboard"], somebodyElses);
  expect(outsider.status).toBe(2);
  expect(outsider.stderr).toContain("dag-ui-e2e-");
  expect(existsSync(join(somebodyElses, "theirs.txt"))).toBe(true);

  const nested = join(FIXTURE_WORKSPACE, "runs");
  const under = refusedInvocation(["--settle-dashboard"], nested);
  expect(under.status).toBe(2);
  expect(existsSync(nested)).toBe(true);
  rmSync(somebodyElses, { recursive: true, force: true });
});

/**
 * What the fixture server does when the read API it serves through was never built.
 *
 * It finds that binary rather than building it, because building it here would put a
 * cargo compile inside the readiness window Playwright gives a `webServer` — a window
 * budgeted for a process binding a port, which a cold `target/` on a CI runner blows
 * through while Playwright reports the one thing that was not wrong. The build is
 * `dag-ui:build-api-server`, a step of its own; the absence is this, immediately.
 *
 * Driven by pointing the child's `CARGO_TARGET_DIR` at an empty directory, which is
 * exactly what an unbuilt tree looks like to it — and leaves the binary this run is
 * being served through where it is.
 */
test("refuses to serve when the read API has not been built", () => {
  const unbuilt = mkdtempSync(join(tmpdir(), "dag-ui-e2e-unbuilt-"));
  const workspace = mkdtempSync(
    join(tmpdir(), "dag-ui-e2e-unbuilt-workspace-"),
  );
  try {
    const refused = refusedInvocation([], workspace, {
      CARGO_TARGET_DIR: unbuilt,
    });
    // 70, not 2: the invocation was answerable, the tree was not ready for it.
    expect(refused.status, refused.stderr).toBe(70);
    expect(refused.stderr).toContain(
      `no read API binary in ${join(unbuilt, "debug")}`,
    );
    // The action names the step that builds it, so a reader of a failed run does
    // not have to know that the tier stopped building it on their behalf.
    expect(refused.stderr).toContain(
      "ACTION: run 'npx nx run dag-ui:build-api-server'",
    );

    // The same variable set to nothing is a mistyped export, not a directory, and
    // it is refused as the usage error it is: resolved, it would name the
    // repository root and report a tree that was never built.
    const blank = refusedInvocation([], workspace, { CARGO_TARGET_DIR: "" });
    expect(blank.status, blank.stderr).toBe(2);
    expect(blank.stderr).toContain("CARGO_TARGET_DIR is set to an empty path");
  } finally {
    rmSync(unbuilt, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * The binary `dag-ui:build-api-server` built, which this run is already being served
 * through. Named from this file rather than from the working directory, for the
 * reason `FIXTURE_COMMAND` is: the tier is launched from the workspace root, and a
 * path that counted directories up from there named one outside the checkout.
 */
const API_BINARY = resolve(
  import.meta.dirname,
  "../../target/debug/onepipeline-api",
);

/** Hold `port` on loopback for the duration of a case, so the fixture cannot take it. */
function holdPort(port: number): Promise<() => void> {
  return new Promise((held, failed) => {
    const squatter = createServer();
    squatter.on("error", failed);
    squatter.listen(port, "127.0.0.1", () =>
      held(() => {
        squatter.close();
      }),
    );
  });
}

/**
 * What the stall server says — the one server this tier starts that answers nothing.
 *
 * It is started as a `webServer` whose readiness is the accepted connection, and
 * Playwright reports a `webServer` that never became ready as a bare `Timed out
 * waiting 120000ms from config.webServer` naming neither the server nor the reason.
 * That left this the only one of the five whose failure could not be told from its
 * success, because saying nothing is what it does when it works. So it says which
 * ports it took, and refuses — under the same exit-code contract the crate serves,
 * `2` for an address this host will not give — rather than dying on an unhandled
 * `error` with a stack and a status outside that contract.
 */
test("says which ports the stall server took, and refuses one it cannot", async () => {
  const port = await freePort();
  const refusePort = await freePort();
  const stalling = spawn(
    process.execPath,
    [
      FIXTURE_COMMAND,
      "--stall",
      "--port",
      String(port),
      "--refuse-port",
      String(refusePort),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let announced = "";
  stalling.stdout.on("data", (chunk: Buffer) => {
    announced += chunk.toString();
  });
  try {
    // What it is about to take, then one line per port as each becomes its own, so
    // a run that stops partway says how far it got — and one that never started
    // says that too, by saying nothing. The last is the readiness its `webServer`
    // entry waits for, and it comes last because by then both ports are its own.
    await expect
      .poll(() => announced, { timeout: 15_000 })
      .toBe(
        `serve-fixture: taking 127.0.0.1:${port} to stall, 127.0.0.1:${refusePort} to refuse\n` +
          `serve-fixture: refusing 127.0.0.1:${refusePort}\n` +
          `serve-fixture: stalling on 127.0.0.1:${port}\n`,
      );
    // And that readiness is the truth: the connection is accepted, and then never
    // answered.
    const accepted = await new Promise<boolean>((connected) => {
      const socket = createConnection(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        connected(true);
      });
      socket.on("error", () => connected(false));
    });
    expect(accepted).toBe(true);
  } finally {
    stalling.kill("SIGTERM");
  }

  // And the failure this could only report as a timeout before: a port taken between
  // the kernel answering `playwright.config.ts` and this bind. Both of them, because
  // the refused port is taken by a second server whose `error` was unhandled too.
  const stalledTaken = await freePort();
  const releaseStalled = await holdPort(stalledTaken);
  try {
    const taken = refusedInvocation([
      "--stall",
      "--port",
      String(stalledTaken),
    ]);
    expect(taken.status, taken.stderr).toBe(2);
    expect(taken.stderr).toContain(
      `cannot start stalling on 127.0.0.1:${stalledTaken}`,
    );
    expect(taken.stderr).toContain("EADDRINUSE");
  } finally {
    releaseStalled();
  }

  const refusalTaken = await freePort();
  const releaseRefused = await holdPort(refusalTaken);
  try {
    const takenRefusal = refusedInvocation([
      "--stall",
      "--port",
      String(await freePort()),
      "--refuse-port",
      String(refusalTaken),
    ]);
    expect(takenRefusal.status, takenRefusal.stderr).toBe(2);
    expect(takenRefusal.stderr).toContain(
      `cannot start refusing 127.0.0.1:${refusalTaken}`,
    );
  } finally {
    releaseRefused();
  }
});

/** A port the kernel says is free, asked for the way `playwright.config.ts` asks. */
function freePort(): Promise<number> {
  return new Promise((chosen, failed) => {
    const probe = createServer();
    probe.on("error", failed);
    probe.listen(0, "127.0.0.1", () => {
      const bound = probe.address();
      if (typeof bound !== "object" || bound === null) {
        failed(new Error("the probe socket reported no port"));
        return;
      }
      probe.close(() => chosen(bound.port));
    });
  });
}

/**
 * The served binary at `path`: linked if this host can, copied if it cannot.
 *
 * A link rather than a copy where one is possible — it is the same 160 MB binary
 * this run is already being served through. A hard link needs both paths on one
 * filesystem, though, and `tmpdir()` is a different one from the checkout on
 * plenty of hosts: a container with `/tmp` on tmpfs, or a workspace on its own
 * mount. That is a fact about where the test happens to be running and not about
 * the thing under test, so it costs a copy rather than the journey.
 */
function stageBinary(path: string): void {
  try {
    linkSync(API_BINARY, path);
  } catch (caught) {
    // Narrowed rather than asserted: `catch` binds `unknown`, and the one thing
    // that distinguishes the cross-device refusal from a real failure to stage
    // the binary is the `code` Node puts on its own errors. Anything else — a
    // missing binary, an unwritable destination — is rethrown, because a copy
    // would fail for that reason too and report it a second time.
    if (
      !(caught instanceof Error) ||
      !("code" in caught) ||
      caught.code !== "EXDEV"
    ) {
      throw caught;
    }
    copyFileSync(API_BINARY, path);
  }
}

/**
 * And what the server does when the binary is where `CARGO_TARGET_DIR` says: it
 * serves through that one, under either name cargo writes.
 *
 * Both names are driven here rather than only this platform's, because the browser
 * tier runs on Linux and a name chosen from `process.platform` would leave the
 * other one proven nowhere.
 */
for (const name of ["onepipeline-api", "onepipeline-api.exe"]) {
  test(`serves through the ${name} a custom CARGO_TARGET_DIR names`, async () => {
    const target = mkdtempSync(join(tmpdir(), "dag-ui-e2e-target-"));
    const workspace = mkdtempSync(join(tmpdir(), "dag-ui-e2e-target-space-"));
    mkdirSync(join(target, "debug"), { recursive: true });
    stageBinary(join(target, "debug", name));
    const port = await freePort();
    const served = spawn(
      process.execPath,
      [FIXTURE_COMMAND, "--workspace", workspace, "--port", String(port)],
      {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, CARGO_TARGET_DIR: target },
      },
    );
    try {
      // The read the fixture server's own `webServer` entry waits on, made here
      // against a server started from the directory this case named.
      await expect
        .poll(
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
            } catch {
              return 0;
            }
          },
          { timeout: 15_000 },
        )
        .toBe(200);
      // Serving, not merely listening: the runs this workspace was built with are
      // what came back.
      const listed = await (
        await fetch(`http://127.0.0.1:${port}/api/v2/runs?limit=50`)
      ).json();
      expect(Array.isArray(listed.runs) && listed.runs.length).toBeGreaterThan(
        0,
      );
    } finally {
      served.kill("SIGTERM");
      rmSync(target, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

async function detailScroll(
  page: Page,
): Promise<{ top: number; bottom: number }> {
  return itemDetail(page)
    .locator('[data-slot="scroll-area-viewport"]')
    .evaluate((element) => ({
      top: element.scrollTop,
      bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    }));
}

async function wheelDetail(page: Page, delta: number): Promise<void> {
  const panel = await itemDetail(page).boundingBox();
  if (panel === null) throw new Error("the detail panel is not on screen");
  await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
  await page.mouse.wheel(0, delta);
}

/** A wheel this far in either direction reaches the end of any transcript here. */
const WHEEL_TO_THE_END = 100_000;

test("follows a growing transcript only while the reader is at its end", async ({
  page,
}) => {
  test.slow();
  await openObservatory(page, `/?run=${runs().live}&node=dashboard`);
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("button", { name: /^Open Worker \(engineer-dashboard\)/ })
    .click();
  await expect(itemDetail(page)).toContainText(
    "Implementing the dashboard now",
  );

  // Long enough that the panel really scrolls, and short enough that the reader is
  // still handed every turn rather than a page of them. One fewer than it was: the
  // worker's own record gained the open turn a planner redirected, and the count that
  // matters here is the whole session's — one page of it, not one page plus a turn
  // nobody asked to see hidden behind a `Show more`.
  changeServedRuns(["--grow-worker-session", "19"]);
  await expect(itemDetail(page)).toContainText("Dashboard turn 18 arrived");
  await wheelDetail(page, WHEEL_TO_THE_END);
  await expect
    .poll(async () => (await detailScroll(page)).bottom)
    .toBeLessThan(40);
  // The panel really does overflow, so being at its end is a position a reader chose
  // rather than the only one there is.
  expect((await detailScroll(page)).top).toBeGreaterThan(0);

  // Read at the end, the panel follows what the run writes next.
  changeServedRuns(["--grow-worker-session", "20"]);
  await expect(itemDetail(page)).toContainText("Dashboard turn 19 arrived");
  await expect
    .poll(async () => (await detailScroll(page)).bottom)
    .toBeLessThan(40);

  // Read anywhere else, it does not: the reader keeps the position they chose while
  // the transcript keeps growing underneath them.
  await wheelDetail(page, -WHEEL_TO_THE_END);
  await expect.poll(async () => (await detailScroll(page)).top).toBe(0);
  changeServedRuns(["--grow-worker-session", "21"]);
  await expect(itemDetail(page)).toContainText("Dashboard turn 20 arrived");
  expect((await detailScroll(page)).top).toBe(0);
  // And the turn it was opened on was never taken away and put back.
  await expect(itemDetail(page)).toContainText(
    "Implementing the dashboard now",
  );

  // Opening this long a session lands at its beginning: following a transcript that
  // is still being written is not the same as skipping to the last thing it said.
  await page.reload();
  await expect(itemDetail(page)).toContainText("Dashboard turn 20 arrived");
  expect((await detailScroll(page)).top).toBe(0);
});

test("keeps the pages a reader scrolled to when a run moves", async ({
  page,
}) => {
  // llmlint: ignore-block[tests_mirror_real_usage] what a live update *costs* has no rendering, and it is the property this journey exists for. The rows and the scroll position a reader keeps are asserted below from the screen — and they are equally consistent with a first-page refetch that happened to come back the same, so the route the refresh went to is the only evidence that it did not. That is the same reason `tests/e2e/cost.rs` holds a read's cost by counting the kernel's record of it rather than by looking at what the read produced. Nothing recorded here stands in for a user-observable outcome; it sits beside two.
  const listReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === RUN_LIST_PATH) listReads.push(url.search);
  });
  await page.goto("/?view=graph");
  const navigation = page.getByRole("navigation", { name: "DAG runs" });
  const viewport = navigation.locator("[data-radix-scroll-area-viewport]");
  await expect(navigation.locator(".run-link")).toHaveCount(50);
  await viewport.hover();
  await page.mouse.wheel(0, 10_000);
  await expect(navigation.locator(".run-link")).toHaveCount(52);
  const scrolled = await scrollOffset(viewport);
  expect(scrolled).toBeGreaterThan(0);

  // A run moves for real: one appended record the server's own poll notices.
  listReads.length = 0;
  changeServedRuns([
    "--record-activity",
    "Grep",
    "--activity-detail",
    "one row moved",
  ]);

  // The row that moved is refreshed by naming it, so the reading costs one row …
  await expect
    .poll(() =>
      listReads.some((search) => search.includes(`select=${runs().live}`)),
    )
    .toBe(true);
  // … and the first page is never asked for again, which is what used to discard
  // every page the reader had scrolled to, twice a second, on any moving host.
  expect(listReads.filter((search) => !search.includes("select="))).toEqual([]);
  // llmlint: ignore-end[tests_mirror_real_usage]
  await expect(navigation.locator(".run-link")).toHaveCount(52);
  // The reader keeps the position they scrolled to, not just the rows.
  expect(await scrollOffset(viewport)).toBe(scrolled);
});

test("opens a run that is recording faster than a read of it completes", async ({
  page,
}) => {
  // Two seconds a read against a stream invalidating twice a second, held for
  // twenty: the operator's own report, at a scale a journey can wait out.
  test.slow();
  await delayReads(page, RUN_DETAIL_READ, 2_000);
  const churn = churnLiveRun(20);
  try {
    await page.goto(`/?run=${runs().live}&view=graph`);
    await expect(page.getByText("Loading execution history…")).toBeVisible();

    // Every read of this run is invalidated before it lands. It still lands: a read
    // that is current for the run, the scope and the attention it was taken under is
    // not discarded merely because something moved while it was in flight, and no
    // second read of it is started to make the first one slower. Bounded well inside
    // the churn, so a detail that only arrives once the run stops moving fails here.
    await expect(
      graphNodeList(page).getByRole("button", { name: /^dashboard: / }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Loading execution history…")).toHaveCount(0);
  } finally {
    churn.stop();
  }
});

test("never renders one run's detail under another run's name", async ({
  page,
}) => {
  await delayReads(page, RUN_DETAIL_READ, 2_000);
  // The read the reader is about to move away from, so this journey asserts on a
  // stale read that has actually landed rather than on one that may not have.
  const staleRead = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/runs/${runs().live}`),
  );
  await page.goto(`/?run=${runs().live}&view=graph`);
  await expect(page.getByText("Loading execution history…")).toBeVisible();

  await page.getByRole("button", { name: RegExp(runs().history) }).click();
  await staleRead;

  // Letting a still-current read land is not the same as letting any read land: the
  // run the reader moved away from is a different reading, and its detail is
  // discarded rather than drawn under the name of the run they are on.
  await expect(graphNodes(page, "done")).toContainText("archive");
  await expect(
    page.getByRole("heading", { name: runs().history }),
  ).toBeVisible();
  await expect(graphNodes(page).filter({ hasText: "dashboard" })).toHaveCount(
    0,
  );
});

test("stays quiet when the run it is opening is swept out from under it", async ({
  page,
}) => {
  // The one read failure that is not a failure, driven end to end: the run is on
  // the list the browser was served and off the root by the time the read of it
  // reaches the server, so what answers is that server's own `404 run_not_found`.
  // The next list is what resolves the race, and a banner about it would describe
  // the race rather than anything the reader can act on.
  const swept = runs().outcomes;
  const banners = await watchForBanners(page);
  const sweep = sweepDuringRead(page, swept);

  await page.goto(`/?run=${swept}&view=graph`);

  // The row goes, which is the whole of what the reader is told about it.
  await expect(
    page
      .getByRole("navigation", { name: "DAG runs" })
      .getByRole("button", { name: RegExp(swept) }),
  ).toHaveCount(0);
  // And the reader lands on a run the server still serves rather than on the one
  // that went away.
  await expect(graphNodeList(page).getByRole("button").first()).toBeVisible();
  // The read really was taken after the run had gone — a read that beat the
  // removal would have proven nothing about the refusal this journey is for.
  expect(sweep.swept()).toBe(true);
  // Nothing was ever shown to fail.
  expect(await banners()).toBe(0);
});

test("drops a run the server stops serving", async ({ page }) => {
  // What the server said about the run that went away, read off the answer the
  // browser actually got: `missing` is the companion list a selection names an id
  // it could not find in, and it is the whole of why the row goes.
  //
  // llmlint: ignore-block[tests_mirror_real_usage] a row that disappears is what a reader sees, and it is asserted below — but it looks the same whichever answer removed it: a `missing` entry, an empty selection, or a refetched first page. This repository's contract makes those three different facts to a caller, so which one the browser acted on is read from the answer the browser was given rather than guessed from the row that went.
  const missing: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname !== RUN_LIST_PATH || !url.searchParams.has("select"))
      return;
    void response
      .json()
      .then((body: unknown) => {
        const answer = z
          .object({ missing: z.array(z.string()).optional() })
          .safeParse(body);
        if (answer.success) missing.push(...(answer.data.missing ?? []));
      })
      .catch(() => {
        // A body the browser never read is nothing to assert on.
      });
  });
  // llmlint: ignore-end[tests_mirror_real_usage]
  await openObservatory(page);
  await expect(
    page.getByRole("button", { name: RegExp(runs().history) }),
  ).toBeVisible();

  changeServedRuns(["--remove-run", runs().history]);

  await expect(
    page.getByRole("button", { name: RegExp(runs().history) }),
  ).toHaveCount(0);
  await expect.poll(() => missing).toContain(runs().history);
  await expect(
    page.getByRole("button", { name: RegExp(runs().live) }),
  ).toBeVisible();
});

test("falls back to the empty state once no run is left", async ({ page }) => {
  await openObservatory(page);
  changeServedRuns(["--remove-page-runs"]);

  // Every remaining run except one — the journey before this removed the historical
  // one. The empty state means the server serves none, so it must not appear while
  // any run is still there to show, whatever shape that run is.
  for (const runId of [
    runs().live,
    runs().outcomes,
    runs().legacy,
    runs().unattributed,
    runs().eventless,
    runs().busy,
  ]) {
    changeServedRuns(["--remove-run", runId]);
    await expect(page.getByText("No DAG runs found")).toHaveCount(0);
  }
  changeServedRuns(["--remove-run", runs().sibling]);

  await expect(page.getByText("No DAG runs found")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
