/**
 * What a page draws while the rest of a run is still on its way: each value the
 * first answer does not carry reads "Loading…" — never an empty, a zero or a
 * default — and becomes the served value once the rest arrives. The rest is held
 * at the network boundary, the one doubled party: the page's event stream, which
 * carries it, does not open until the journey lets it.
 */
import { runDetailSchema } from "@onepipeline-ui/dag-model";
import { expect, type Page, type Route, test } from "@playwright/test";
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
