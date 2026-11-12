/**
 * The settled large run's busiest node, opened on the real release server: its
 * whole transcript is reached back to its first row by the page's own control.
 *
 * Apart from `reach-everything.spec.ts`, which it belongs beside, because its
 * hundred pages are as long as every other journey there together: as a file of
 * its own it runs in another worker, beside them rather than after them.
 */

import { timelineEventsPageSchema } from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import {
  addressOf,
  buildWorld,
  LARGE_WORKLOAD,
  NEVER,
  removeWorld,
  type Served,
  serve,
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

test("the busiest node's whole transcript is reached back to its first row, in order", async ({
  page,
}) => {
  const node = world.facts.large.busiestNode;
  const run = world.facts.openLiveRun;
  const timeline = await settledTimeline(world, served, run, node);
  // A span is the SDK's record, which the API passes through untyped
  // as a JSON value (AGENTS.md); this reads only its id and events.
  const nodeSpan = (timeline.spans as Json[]).find(
    (span) => span.id === `node.${node}`,
  );
  const expected = (nodeSpan?.events ?? []).flatMap((event) =>
    event.id === undefined ? [] : [event.id],
  );
  await open(page, "node", node);
  const seen = new Map<string, number>();
  const answers: string[] = [];
  // Each page's rows, newest page first; and the first answer's window.
  const pages: string[][] = [];
  const windowed = new Set<string>();
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      url.pathname === "/api/v2/subscriptions" &&
      response.request().method() === "POST"
    ) {
      const { timeline: first } = visibleOf(await response.json());
      for (const span of first?.spans ?? [])
        for (const event of span.events) windowed.add(event.id);
      return;
    }
    if (!url.pathname.endsWith("/timeline/events")) return;
    const body = timelineEventsPageSchema.parse(await response.json());
    pages.push(body.rows.map((row) => row.id));
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
  // Every row before the first window has been asked for, none repeated, and the
  // pages, oldest first, hold the complete document's rows in its order.
  expect(
    [...seen.values()].every((count) => count === 1),
    "no row repeated",
  ).toBe(true);
  expect(windowed.size, "the first answer's window").toBeGreaterThan(0);
  // Two records the engine renders under one turn's id are listed twice by the
  // complete document and once by the pages, which merge by id as the client does:
  // order is held over the ids listed once, and every id is reached.
  const listed = new Map<string, number>();
  for (const id of expected) listed.set(id, (listed.get(id) ?? 0) + 1);
  const wanted = new Set(expected.filter((id) => listed.get(id) === 1));
  const oldestFirst = pages.toReversed().flat();
  const reached = new Set([...oldestFirst, ...windowed]);
  expect(
    expected.filter((id) => !reached.has(id)),
    `rows never reached, after ${answers.join("; ")}`,
  ).toStrictEqual([]);
  const paged = new Set(oldestFirst);
  expect(oldestFirst.filter((id) => wanted.has(id))).toStrictEqual(
    expected.filter((id) => wanted.has(id) && paged.has(id)),
  );
});
