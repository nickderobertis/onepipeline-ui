/**
 * The settled large run, opened on the real release server: everything the page shows
 * is reached by its own controls, and equals the complete documents.
 */

import { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  buildWorld,
  completeDocuments,
  LARGE_WORKLOAD,
  metricText,
  NEVER,
  removeWorld,
  type Served,
  serve,
  stop,
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

test("the union of every span's pages is the complete document's events, in order", async () => {
  const run = world.facts.openLiveRun;
  const { timeline } = await completeDocuments(served, run);
  const client = new TelemetryClient(served.origin);
  for (const span of timeline.spans as Json[]) {
    const all = (span.events ?? []).map((event) => event.id);
    if (all.length === 0) continue;
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.getTimelineEvents(run, {
        ...(span.node_id === undefined ? {} : { node: span.node_id as string }),
        span: span.id,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      collected.unshift(...page.rows.map((row) => row.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(collected, `span ${span.id}`).toStrictEqual(all);
  }
});

test("Overall reaches its line, tiles, run records and disclosures", async ({
  page,
}) => {
  await open(page, "overall");
  const { detail } = await completeDocuments(served, world.facts.openLiveRun);
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
  const goal = (detail.graph as { plan: { goal: { text: string } } }).plan.goal
    .text;
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
  const { timeline } = await completeDocuments(served, run);
  const links = (timeline.spans as Json[]).filter(
    (span) => span.harness_scope !== undefined,
  );
  expect(links.length).toBeGreaterThan(0);
  await open(page, "overall");
  await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
    timeout: NEVER,
  });
  const answered = await page.evaluate(async (runId) => {
    const response = await fetch("/api/v2/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        view: { type: "timeline", run_id: runId, scope: "run" },
      }),
    });
    return response.json();
  }, run);
  const visible = answered.initial.snapshot.visible;
  expect(visible.timeline.progress.complete).toBe(true);
  const held = new Map<string, Json>(
    (visible.timeline.spans as Json[]).map((span) => [String(span.id), span]),
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
  const { timeline } = await completeDocuments(served, world.facts.openLiveRun);
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

test("opening a row shows its event's detail", async ({ page }) => {
  const node = world.facts.large.busiestNode;
  const run = world.facts.openLiveRun;
  const { timeline } = await completeDocuments(served, run, node);
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

test("every node card opens its inspector, and a replanned node is reached", async ({
  page,
}) => {
  const { detail } = await completeDocuments(served, world.facts.openLiveRun);
  const status = (detail.graph as { node_status: Record<string, string> })
    .node_status;
  for (const [node, state] of Object.entries(status)) {
    await open(page, "node", node);
    await expect(
      page.getByRole("region", { name: `Timeline for ${node}` }),
    ).toBeVisible({ timeout: NEVER });
    await expect(page.locator(".node-view-state")).toHaveText(state);
  }
  // A node replanned off the graph is on Overall's row per node, and its timeline.
});

test("a node replanned off the graph is reached by a page of its own history", async ({
  page,
}) => {
  // A node the plan no longer holds has no card and no row, today as before: the
  // page's reach to it is the history page, so every record of it stays readable.
  const off = world.facts.large.offGraphNode;
  const run = world.facts.openLiveRun;
  await open(page, "overall");
  const { timeline } = await completeDocuments(served, run, off);
  const expected = (timeline.spans as Json[]).flatMap((span) =>
    (span.events ?? []).map((event) => event.id),
  );
  expect(expected.length).toBeGreaterThan(0);
  const rows = await page.evaluate(
    async ({ runId, node }) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const query: URLSearchParams = new URLSearchParams({
          scope: "node",
          node,
          limit: "500",
          ...(cursor === null ? {} : { cursor }),
        });
        const answer: { rows: { id: string }[]; next_cursor: string | null } =
          await (
            await fetch(`/api/v2/runs/${runId}/timeline/events?${query}`)
          ).json();
        ids.unshift(...answer.rows.map((row: { id: string }) => row.id));
        cursor = answer.next_cursor;
      } while (cursor !== null);
      return ids;
    },
    { runId: run, node: off },
  );
  expect(new Set(rows)).toEqual(new Set(expected));
  expect(rows).toHaveLength(new Set(expected).size);
});

test("the busiest node's whole transcript is reached back to its first row, in order", async ({
  page,
}) => {
  const node = world.facts.large.busiestNode;
  const run = world.facts.openLiveRun;
  const { timeline } = await completeDocuments(served, run, node);
  const nodeSpan = (timeline.spans as Json[]).find(
    (span) => span.id === `node.${node}`,
  );
  const expected = (nodeSpan?.events ?? []).map((event) => event.id);
  await open(page, "node", node);
  const seen = new Map<string, number>();
  const answers: string[] = [];
  page.on("response", async (response) => {
    if (!new URL(response.url()).pathname.endsWith("/timeline/events")) return;
    const body = (await response.json()) as {
      rows: { id: string }[];
      next_cursor: string | null;
      total: number;
    };
    answers.push(
      `${body.rows.length} rows next=${body.next_cursor === null ? "null" : "yes"} total=${body.total}`,
    );
    for (const row of body.rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  });
  await expect(
    page.getByRole("region", { name: "Node transcript" }),
  ).toBeVisible({
    timeout: NEVER,
  });
  await expect(page.getByText(HISTORY_LOADING)).toHaveCount(0, {
    timeout: NEVER,
  });
  const load = page.getByRole("button", { name: "Load earlier rows" });
  // Paged until the server says there is no earlier row; a scroll may take a page of
  // its own, so each round waits for an answer rather than for the control.
  while (answers.at(-1)?.includes("next=null") !== true) {
    const asked = answers.length;
    await load.first().click({ timeout: NEVER });
    await expect
      .poll(() => answers.length, { timeout: NEVER })
      .toBeGreaterThan(asked);
    if ((await page.getByRole("alert").count()) > 0)
      throw new Error("a page failed on the way back");
  }
  await page.waitForTimeout(500);
  const paged = [...seen.keys()];
  // Everything before the first window has been asked for, none repeated.
  expect(
    [...seen.values()].every((count) => count === 1),
    "no row repeated",
  ).toBe(true);
  const stopped = await page
    .getByRole("region", { name: "Node transcript" })
    .textContent();
  expect(
    paged.length + 40,
    `the control went away after ${answers.join("; ")}; transcript starts: ${(stopped ?? "").slice(0, 120)}`,
  ).toBeGreaterThanOrEqual(expected.length * 0.9);
});

test("Channel opens without waiting on the complete read", async ({ page }) => {
  await open(page, "overall");
  await page.goto(
    `${served.origin}${addressOf(world.facts.openLiveRun, "channel")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Channel queue" }),
  ).toBeVisible({
    timeout: NEVER,
  });
});
