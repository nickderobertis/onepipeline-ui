/**
 * The settled large run, opened on the real release server: everything the page shows
 * is reached by its own controls, and equals the complete documents.
 */

import { timelineEventsPageSchema } from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  buildWorld,
  LARGE_WORKLOAD,
  metricText,
  NEVER,
  removeWorld,
  type Served,
  serve,
  settledDetail,
  settledTimeline,
  stop,
  visibleOf,
  type World,
} from "./journey-world";

const HISTORY_LOADING = "The rest of this run's history is still loading";

type Json = Record<string, unknown> & { events?: Json[]; id?: string };

let world: World;
let served: Served;
test.beforeAll(async () => {
  world = buildWorld(LARGE_WORKLOAD, "settled");
  served = await serve(world);
});
test.afterAll(async () => {
  await stop(served);
  removeWorld(world);
});

const open = (page: Page, view: "graph" | "overall" | "node", node?: string) =>
  page.goto(
    `${served.origin}${addressOf(world.facts.openLiveRun, view, node)}`,
  );

test("Overall reaches its line, tiles, run records and disclosures", async ({
  page,
}) => {
  await open(page, "overall");
  const detail = await settledDetail(world, served, world.facts.openLiveRun);
  const run = detail.run as { state: string; turns: number; nodes: unknown[] };
  await expect(metricText(page, "Turns")).toHaveText(String(run.turns), {
    timeout: NEVER,
  });
  await expect(metricText(page, "Status")).toHaveText(run.state);
  await expect(metricText(page, "Nodes")).toHaveText(String(run.nodes.length));
  await expect(
    page.getByRole("heading", { name: "Graph timeline" }),
  ).toBeVisible();
  await expect(page.getByText(HISTORY_LOADING)).toHaveCount(0, {
    timeout: NEVER,
  });
  for (const label of [
    "Timing and usage",
    "Goal and repository identities",
    "Recorded results",
    "Provider health",
  ]) {
    const disclosure = page.getByRole("group", { name: label });
    await disclosure.getByText(label).click();
    await expect(disclosure, label).not.toHaveText(/Loading…/u);
  }
  const goal = detail.graph.plan.goal?.text;
  if (goal === undefined) throw new Error("the corpus's run states no goal");
  await expect(
    page.getByRole("group", { name: "Goal and repository identities" }),
  ).toContainText(goal);
});

const pageAsks = (page: Page) => {
  const asked: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/timeline/events")) asked.push(url);
  });
  return asked;
};

test("every session link is served as the complete document names it, once the rest arrives", async ({
  page,
}) => {
  const run = world.facts.openLiveRun;
  const timeline = await settledTimeline(world, served, run);
  const links = (timeline.spans as Json[]).filter(
    (span) => span.harness_scope !== undefined,
  );
  expect(links.length).toBeGreaterThan(0);
  await open(page, "overall");
  await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
    timeout: NEVER,
  });
  const answered: unknown = await page.evaluate(async (runId) => {
    const response = await fetch("/api/v2/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        view: { type: "timeline", run_id: runId, scope: "run" },
      }),
    });
    return response.json();
  }, run);
  const { timeline: shown } = visibleOf(answered);
  if (shown === undefined)
    throw new Error("Overall's answer holds no timeline");
  expect(shown.progress?.complete).toBe(true);
  const held = new Map<string, Json>(
    shown.spans.map((span) => [span.id, span as Json]),
  );
  for (const link of links) {
    const served_span = held.get(String(link.id));
    expect(served_span, `${link.id}`).toBeDefined();
    expect(served_span?.reference).toEqual(link.reference);
    expect(served_span?.started_at).toEqual(link.started_at);
    expect(served_span?.ended_at).toEqual(link.ended_at);
  }
});

test("zooming a node's category lanes asks for that stretch, and only then", async ({
  page,
}) => {
  const node = world.facts.large.busiestNode;
  const asked = pageAsks(page);
  await open(page, "overall");
  await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
    timeout: NEVER,
  });
  await page
    .getByRole("region", { name: "Graph timeline", exact: true })
    .getByRole("button", { name: "Expand timeline" })
    .click();
  const row = page.getByRole("region", {
    name: `${node} timeline`,
    exact: true,
  });
  await row.getByRole("button", { name: "Expand timeline" }).click();
  expect(asked.filter((url) => url.searchParams.has("from"))).toHaveLength(0);
  // llmlint: ignore[e2e_uses_accessible_selectors] the lanes' spans are positioned SVG geometry that no role or name carries; the journey only finds where one is drawn and then zooms there with the pointer, as a person does.
  const plot = row.locator('[data-timeline-shape="span"]').first();
  await plot.scrollIntoViewIfNeeded({ timeout: 60_000 });
  const bounds = await plot.boundingBox();
  if (bounds === null) throw new Error("the lanes' plot has no box");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await expect
    .poll(() => asked.some((url) => url.searchParams.has("from")), {
      timeout: 60_000,
    })
    .toBe(true);
  const stretch = asked.find((url) => url.searchParams.has("from"));
  // Opening a run-level span, which is what clicking one selects, asks for it whole.
  const timeline = await settledTimeline(
    world,
    served,
    world.facts.openLiveRun,
  );
  const runSpan = (timeline.spans as Json[]).find(
    (span) => span.node_id === undefined && span.harness_scope === undefined,
  );
  if (runSpan === undefined) throw new Error("no run-level span");
  const before = asked.length;
  await page.goto(
    `${page.url()}&event=${encodeURIComponent(String(runSpan.id))}`,
  );
  await expect
    .poll(
      () =>
        asked
          .slice(before)
          .some((url) => url.searchParams.get("span") === runSpan.id),
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(
    Date.parse(stretch?.searchParams.get("from") ?? ""),
  ).toBeLessThanOrEqual(Date.parse(stretch?.searchParams.get("to") ?? ""));
});

test("expanding a node's row on Overall reads every page of that node's rows", async ({
  page,
}) => {
  const node = world.facts.large.busiestNode;
  const run = world.facts.openLiveRun;
  const timeline = await settledTimeline(world, served, run, node);
  // The node's rows across its spans, each once, as a page lists them.
  const expected = new Set(
    timeline.spans.flatMap((span) =>
      (span.events ?? []).map((event) => event.id),
    ),
  );
  // More than one of the widest page the client asks for.
  expect(expected.size).toBeGreaterThan(500);
  const pages: { cursor: string | null; ids: string[] }[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      !url.pathname.endsWith("/timeline/events") ||
      url.searchParams.get("node") !== node ||
      url.searchParams.has("span") ||
      url.searchParams.has("from")
    )
      return;
    const body = timelineEventsPageSchema.parse(await response.json());
    pages.push({
      cursor: body.next_cursor,
      ids: body.rows.map((row) => row.id),
    });
  });
  await open(page, "overall");
  await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
    timeout: NEVER,
  });
  await page
    .getByRole("region", { name: "Graph timeline", exact: true })
    .getByRole("button", { name: "Expand timeline" })
    .click();
  await page
    .getByRole("region", { name: `${node} timeline`, exact: true })
    .getByRole("button", { name: "Expand timeline" })
    .click();
  await expect
    .poll(() => pages.some(({ cursor }) => cursor === null), {
      timeout: NEVER,
    })
    .toBe(true);
  expect(pages.length).toBeGreaterThan(1);
  const read = pages.flatMap(({ ids }) => ids);
  expect(read, "no row read twice").toHaveLength(new Set(read).size);
  expect(new Set(read)).toEqual(expected);
});

test("opening a row shows its event's detail", async ({ page }) => {
  const node = world.facts.large.busiestNode;
  const run = world.facts.openLiveRun;
  const timeline = await settledTimeline(world, served, run, node);
  const events = new Map<string, Json>();
  for (const span of timeline.spans as Json[])
    for (const event of span.events ?? []) {
      events.set(String(event.id), event);
      events.set(String(event.record_id), event);
    }
  const asked = pageAsks(page);
  await open(page, "node", node);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const row = transcript.getByRole("button", { name: /^Open / }).last();
  await expect(row).toBeVisible({ timeout: NEVER });
  expect(asked).toHaveLength(0);
  await row.click();
  await expect(page).toHaveURL(/[?&]event=/u, { timeout: 60_000 });
  const id = new URL(page.url()).searchParams.get("event") ?? "";
  const event = events.get(id);
  expect(event, `event ${id} is in the complete document`).toBeDefined();
  await expect(
    page.getByRole("region", { name: "Timeline item detail" }),
  ).toContainText(String(event?.kind), { timeout: 60_000 });
});

test("every node's view, opened by its address, shows its state as the complete document records it", async ({
  page,
}) => {
  const detail = await settledDetail(world, served, world.facts.openLiveRun);
  const status = (detail.graph as { node_status: Record<string, string> })
    .node_status;
  for (const [node, state] of Object.entries(status)) {
    await open(page, "node", node);
    const view = page.getByRole("region", { name: `Timeline for ${node}` });
    await expect(view).toBeVisible({ timeout: NEVER });
    // The heading's state badge, the first place the view names a state.
    await expect(view.getByText(state, { exact: true }).first()).toBeVisible();
  }
});

test("a node replanned off the graph is reached by a page of its own history", async ({
  page,
}) => {
  // A node the plan no longer holds has no card and no row, today as before: the
  // page's reach to it is the history page, so every record of it stays readable.
  const off = world.facts.large.offGraphNode;
  const run = world.facts.openLiveRun;
  await open(page, "overall");
  const timeline = await settledTimeline(world, served, run, off);
  const expected = (timeline.spans as Json[]).flatMap((span) =>
    (span.events ?? []).map((event) => event.id),
  );
  expect(expected.length).toBeGreaterThan(0);
  const rows: string[] = [];
  let cursor: string | null = null;
  do {
    const query: URLSearchParams = new URLSearchParams({
      scope: "node",
      node: off,
      limit: "500",
      ...(cursor === null ? {} : { cursor }),
    });
    // Asked from the page, as its own reads are, and read through the contract.
    const answer = timelineEventsPageSchema.parse(
      await page.evaluate(
        async (path) => (await fetch(path)).json(),
        `/api/v2/runs/${run}/timeline/events?${query}`,
      ),
    );
    rows.unshift(...answer.rows.map((row) => row.id));
    cursor = answer.next_cursor;
  } while (cursor !== null);
  expect(new Set(rows)).toEqual(new Set(expected));
  expect(rows).toHaveLength(new Set(expected).size);
});

test("Channel opens its queue on the large run, reached from Overall", async ({
  page,
}) => {
  await open(page, "overall");
  // By the view tabs, as a reader on Overall moves to Channel: the app is the one
  // that replaced the first screen, so its tabs are the sign it has arrived.
  const tab = page.getByRole("tab", { name: "Channel", exact: true });
  await expect(tab).toBeVisible({ timeout: NEVER });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/[?&]view=channel(?:&|$)/u);
  await expect(
    page.getByRole("heading", { name: "Channel queue" }),
  ).toBeVisible({
    timeout: NEVER,
  });
});
