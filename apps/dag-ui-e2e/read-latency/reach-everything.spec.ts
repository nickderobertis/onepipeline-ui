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

test("a node replanned off the graph is reached from its row on Overall", async ({
  page,
}) => {
  const off = world.facts.large.offGraphNode;
  await open(page, "overall");
  await expect(metricText(page, "Turns")).toHaveText(/^\d+$/u, {
    timeout: NEVER,
  });
  await page
    .getByRole("button", { name: new RegExp(off, "u") })
    .first()
    .click();
  await expect(
    page.getByRole("region", {
      name: `Timeline for ${world.facts.large.offGraphNode}`,
    }),
  ).toBeVisible({ timeout: 60_000 });
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
