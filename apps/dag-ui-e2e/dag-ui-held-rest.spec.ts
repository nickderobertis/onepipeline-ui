/**
 * What a page draws while the rest of a run is still on its way: each value the
 * first answer does not carry reads "Loading…" — never an empty, a zero or a
 * default — and becomes the served value once the rest arrives. The rest is held
 * at the network boundary, the one doubled party: the page's event stream, which
 * carries it, does not open until the journey lets it. And the app replacing the
 * first screen moves nothing that screen drew.
 */
import { runDetailSchema } from "@onepipeline-ui/dag-model";
import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { runs } from "./fixture-facts";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

const LOADING = "Loading…";

/** Hold every request `pattern` matches until the returned release is called. */
async function hold(page: Page, pattern: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the network boundary is the only doubled party: the request is held as a slow host holds it, then passed to the real server unchanged.
  await page.route(pattern, async (route: Route) => {
    await released;
    await route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  return release;
}

/** The complete detail document, as `server` serves it. */
async function completeDetail(page: Page, server: FixtureServer, run: string) {
  const response = await page.request.get(
    `${server.origin}/api/v2/runs/${run}?include_conversations=false`,
  );
  expect(response.ok()).toBe(true);
  return runDetailSchema.parse(await response.json());
}

test("Run details reads its launching session and last progress as loading, then as served", async ({
  page,
}) => {
  // A server of its own: one that has read the run answers with it complete.
  const server = await startFixtureServer("held-rest", []);
  try {
    const run = runs().live;
    const release = await hold(page, "**/api/v2/events?*");
    await page.goto(`${server.origin}/?run=${run}&view=overall`);
    await page.getByText("Run details", { exact: true }).click();
    const details = page.getByRole("group", {
      name: "Run details",
      exact: true,
    });
    await expect(details).toContainText(`Launching session: ${LOADING}`);
    const lastProgress = details.getByRole("status", {
      name: "Last progress",
      exact: true,
    });
    await expect(lastProgress).toHaveText(LOADING);
    release();
    const detail = await completeDetail(page, server, run);
    await expect(details).not.toContainText(`Launching session: ${LOADING}`);
    await expect(details).toContainText(/Launching session: Codex session/u);
    if (detail.run.last_progress_at === undefined)
      await expect(lastProgress).toHaveText("Not recorded");
    else
      await expect(lastProgress.getByRole("time")).toHaveAttribute(
        "datetime",
        new Date(detail.run.last_progress_at * 1000).toISOString(),
      );
  } finally {
    await server.stop();
  }
});

test("Channel reads its ready human actions as loading, then as served", async ({
  page,
}) => {
  // A server of its own: one that has read the run answers with it complete.
  const server = await startFixtureServer("held-rest", []);
  try {
    const run = runs().supervised;
    const release = await hold(page, "**/api/v2/events?*");
    await page.goto(`${server.origin}/?run=${run}&view=channel`);
    const actions = page.getByRole("region", { name: "Ready human actions" });
    await expect(actions).toContainText(LOADING);
    await expect(actions).not.toContainText("No decision point");
    release();
    const detail = await completeDetail(page, server, run);
    await expect(actions).not.toContainText(LOADING);
    const decisions = detail.graph?.decisions ?? [];
    if (decisions.length === 0)
      await expect(actions).toContainText(
        "No decision point is holding the graph.",
      );
    else
      await expect(actions.getByRole("listitem")).toHaveCount(decisions.length);
  } finally {
    await server.stop();
  }
});

test("a node's turns, task, overrides, criteria and remote read as loading, then as served", async ({
  page,
}) => {
  // A server of its own: one that has read the run answers with it complete.
  const server = await startFixtureServer("held-rest", []);
  try {
    const run = runs().live;
    const node = "foundation";
    const release = await hold(page, "**/api/v2/events?*");
    await page.goto(`${server.origin}/?run=${run}&node=${node}`);
    const header = page.getByText(/ node · /u);
    await expect(header).toContainText(`turns ${LOADING}`);
    const tabs = page.getByRole("tablist", { name: "Node details" });
    const panel = (name: string) =>
      page.getByRole("tabpanel", { name, exact: true });
    await tabs.getByRole("tab", { name: "Task" }).click();
    await expect(
      panel("Task").getByText(LOADING, { exact: true }).first(),
    ).toBeVisible();
    const overrides = panel("Task")
      .getByRole("term")
      .filter({ hasText: "Graph overrides" })
      .locator("xpath=following-sibling::dd[1]");
    await expect(overrides).toHaveText(LOADING);
    await tabs.getByRole("tab", { name: "Acceptance criteria" }).click();
    await expect(panel("Acceptance criteria")).toHaveText(LOADING);
    await tabs.getByRole("tab", { name: "Remote" }).click();
    await expect(
      panel("Remote").getByText(LOADING, { exact: true }),
    ).toBeVisible();
    await expect(
      panel("Remote").getByText("Publication", { exact: true }),
    ).toBeHidden();
    release();
    const detail = await completeDetail(page, server, run);
    await expect(header).toContainText(/\d+ turns · \d+ lint turns/u);
    await expect(
      panel("Remote").getByText(LOADING, { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel("Remote").getByText("Publication", { exact: true }),
    ).toBeVisible();
    await tabs.getByRole("tab", { name: "Acceptance criteria" }).click();
    await expect(panel("Acceptance criteria")).not.toHaveText(LOADING);
    await expect(panel("Acceptance criteria")).not.toHaveText("");
    await tabs.getByRole("tab", { name: "Task" }).click();
    await expect(panel("Task").getByText(LOADING, { exact: true })).toHaveCount(
      0,
    );
    const sets =
      detail.graph?.plan.tasks.find((task) => task.id === node)?.sets ?? [];
    if (sets.length === 0) await expect(overrides).toHaveText("None");
    else
      await expect(
        overrides
          .getByRole("list", { name: "Graph overrides" })
          .getByRole("listitem"),
      ).toHaveText(sets);
  } finally {
    await server.stop();
  }
});

/** What each view's first screen draws, found as the app finds the same thing. */
const DRAWN: Record<
  "overall" | "graph" | "node",
  (page: Page) => Record<string, Locator>
> = {
  overall: (page) => ({
    "the run's heading": page.locator(".overall-hero h2"),
    ...Object.fromEntries(
      ["Status", "Nodes", "Wall time", "Turns"].flatMap((name) => {
        const tile = page.getByRole("group", { name, exact: true });
        return [
          [`the ${name} tile`, tile],
          [`the ${name} value`, tile.locator("strong")],
        ];
      }),
    ),
    "the graph timeline's plot": page.getByLabel(/^Timeline plot/u).first(),
  }),
  graph: (page) => ({
    "the first node card": page
      .getByRole("article")
      .filter({ hasText: "archive" })
      .first(),
    "its name": page
      .getByRole("article")
      .filter({ hasText: "archive" })
      .first()
      .locator("strong"),
  }),
  node: (page) => ({
    "the node's name": page.locator(".breadcrumb-node"),
    "its state": page.locator(".node-view-state"),
    "its turns": page.locator(".node-view-meta"),
    "the node's plot": page.getByLabel(/^Timeline plot/u).first(),
    "the transcript": page.getByRole("region", { name: "Node transcript" }),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6, 7].map((index) => [
        `transcript row ${index + 1}`,
        page
          .getByRole("region", { name: "Node transcript" })
          .getByRole("article")
          .nth(index),
      ]),
    ),
  }),
};

const BOOKMARKS = {
  overall: () => `/?run=${runs().history}&view=overall`,
  graph: () => `/?run=${runs().history}&view=graph`,
  node: () => `/?run=${runs().live}&node=foundation`,
} as const;

for (const view of ["overall", "graph", "node"] as const)
  test(`the app replacing ${view}'s first screen moves nothing the first screen drew`, async ({
    page,
  }) => {
    const server = await startFixtureServer("held-rest", []);
    try {
      // The app is its own chunk, fetched after the first screen is drawn: held,
      // the first screen stays up to be measured.
      const release = await hold(page, "**/assets/mount-*.js");
      // And the rest, so the app draws the same answer the first screen did: a value
      // the rest changes is an update, not a move.
      await hold(page, "**/api/v2/events?*");
      await page.goto(`${server.origin}${BOOKMARKS[view]()}`);
      const drawn = DRAWN[view](page);
      const boxes = async () => {
        const measured: Record<
          string,
          { x: number; y: number; width: number }
        > = {};
        for (const [name, element] of Object.entries(drawn)) {
          await expect(element, name).toBeVisible();
          const box = await element.boundingBox();
          if (box === null) throw new Error(`${name} has no box`);
          measured[name] = box;
        }
        return measured;
      };
      // llmlint: ignore[e2e_uses_accessible_selectors] the first screen marks its root for the swap; that attribute is the only thing telling it from the app, whose own tabs are the sign it has arrived.
      await expect(page.locator("[data-first-screen]")).toHaveCount(1);
      const first = await boxes();
      release();
      await expect(page.locator("[data-first-screen]")).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
      const app = await boxes();
      for (const [name, before] of Object.entries(first)) {
        const after = app[name];
        if (after === undefined) throw new Error(`${name} went`);
        for (const axis of ["x", "y", "width"] as const)
          expect(
            Math.abs(after[axis] - before[axis]),
            `${name} ${axis}: ${before[axis]} -> ${after[axis]}`,
          ).toBeLessThanOrEqual(1);
      }
    } finally {
      await server.stop();
    }
  });
