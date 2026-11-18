import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTimelineSchema } from "@onepipeline-ui/dag-model";
import { NODE_TIMELINE_PARTIAL_DELAY_MS } from "@onepipeline-ui/timeline-categories";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

/**
 * A busy node's Timeline tab loads the node whole, on its own, through one streamed
 * read: the chart and the event list each come to hold every record the node's
 * journal wrote, a slow read is drawn as partial past the budget's delay, a failed
 * one is retried and then offered again, and no loading mark is left standing over
 * what is held.
 *
 * The corpus is `load/corpus.mjs`'s large run at a size a journey reads whole
 * (`serve-fixture.mjs --node-timeline-corpus`): a live node of over 3,000 records
 * interleaving every record family, its turns' openings and closes sharing a row id.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  node: z.string().min(1),
});

/** What the view's completion probe reports: the records the chart and list hold. */
interface Held {
  readonly chart: readonly string[];
  readonly list: readonly string[];
}

let server: FixtureServer;
let facts: z.infer<typeof factsSchema>;
/** Every record of the node's complete timeline, keyed as a row reads one. */
let expected: ReadonlySet<string>;

test.beforeAll(async ({ request }) => {
  server = await startFixtureServer("node-timeline", [
    "--node-timeline-corpus",
  ]);
  facts = factsSchema.parse(server.facts);
  const timeline = runTimelineSchema.parse(
    await (
      await request.get(
        `${server.origin}/api/v2/runs/${facts.run}/timeline?scope=node&node=${facts.node}`,
      )
    ).json(),
  );
  const records = new Set<string>();
  const byRowId = new Map<string, Set<string>>();
  for (const span of timeline.spans)
    for (const event of span.events) {
      const record = event.record_id ?? event.id;
      records.add(record);
      const sharing = byRowId.get(event.id) ?? new Set<string>();
      sharing.add(record);
      byRowId.set(event.id, sharing);
    }
  expected = records;
  // The fixture holds what the journeys are about: a node past 3,000 records, and
  // turns whose two records share one row id.
  expect(records.size).toBeGreaterThanOrEqual(3_000);
  expect(
    [...byRowId.values()].filter((sharing) => sharing.size > 1).length,
  ).toBeGreaterThan(0);
});

test.afterAll(async () => {
  await server?.stop();
});

/**
 * Hand the view a probe, before it loads, that keeps what its chart's data and its
 * event list hold after each commit.
 */
async function probeHeld(page: Page): Promise<() => Promise<Held>> {
  await page.addInitScript(() => {
    const held = { chart: [] as string[], list: [] as string[] };
    Object.assign(window, {
      __nodeLoadProbe: (now: typeof held) => {
        held.chart = [...now.chart];
        held.list = [...now.list];
      },
      __nodeLoadHeld: held,
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __nodeLoadHeld: Held }).__nodeLoadHeld,
    );
}

/** How many of the node's records `held` lacks, in the chart and in the list. */
function lacking(held: Held): { chart: number; list: number } {
  const chart = new Set(held.chart);
  const list = new Set(held.list);
  let inChart = 0;
  let inList = 0;
  for (const record of expected) {
    if (!chart.has(record)) inChart += 1;
    if (!list.has(record)) inList += 1;
  }
  return { chart: inChart, list: inList };
}

const openNode = (page: Page) =>
  page.goto(`${server.origin}/?run=${facts.run}&view=graph&node=${facts.node}`);

/** The node panel's chart and event list. */
function panel(page: Page): { chart: Locator; list: Locator } {
  return {
    chart: page.getByRole("region", { name: "Node timeline" }),
    list: page.getByRole("region", { name: "Node transcript" }),
  };
}

/** Every loading, partial or Load earlier mark the node panel could show. */
function loadingMarks(page: Page): Locator {
  const { chart, list } = panel(page);
  return chart
    .getByText("Still loading")
    .or(chart.getByText("Partial — loading"))
    .or(list.getByRole("button", { name: /^Load(ing)? earlier rows/ }));
}

/** The node panel holds every record, and says nothing is loading. */
async function heldWhole(page: Page, held: () => Promise<Held>) {
  await expect
    .poll(async () => lacking(await held()), { timeout: 60_000 })
    .toStrictEqual({ chart: 0, list: 0 });
  const { chart, list } = panel(page);
  await expect(chart).toHaveAttribute("aria-busy", "false");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(loadingMarks(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
}

const isTimelineRead = (url: string) => {
  const path = new URL(url).pathname;
  return (
    path.endsWith("/timeline/events") || path.endsWith("/timeline/node-stream")
  );
};

test("opening a busy node's Timeline loads every record into its chart and event list, and leaves no loading mark over what is held", async ({
  page,
}) => {
  const held = await probeHeld(page);
  // The page's own request log: every read of rows in flight, and what the chart
  // showed each time the last of them completed.
  let inFlight = 0;
  let completed = 0;
  const checks: Promise<void>[] = [];
  page.on("request", (request) => {
    if (isTimelineRead(request.url())) inFlight += 1;
  });
  const settle = (url: string) => {
    if (!isTimelineRead(url)) return;
    inFlight -= 1;
    completed += 1;
    if (inFlight > 0) return;
    // Nothing is in flight, and a successful load queues nothing: whatever the
    // chart drew as loading has to be gone.
    checks.push(
      (async () => {
        await expect(loadingMarks(page)).toHaveCount(0, { timeout: 2_000 });
        expect(inFlight).toBe(0);
      })(),
    );
  };
  page.on("requestfinished", (request) => settle(request.url()));
  page.on("requestfailed", (request) => settle(request.url()));

  await openNode(page);

  await heldWhole(page, held);
  expect(completed).toBeGreaterThan(0);
  await Promise.all(checks);
  // And after the load, with nothing asked since, nothing is drawn as loading.
  expect(inFlight).toBe(0);
  await expect(loadingMarks(page)).toHaveCount(0);
});

/**
 * A server between the page and the read API that answers the node's stream with
 * its start and first rows lines, and holds the rest until `release`.
 */
async function holdingProxy(origin: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const proxy: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const upstream = await fetch(`${origin}${incoming.url ?? "/"}`);
      const lines = (await upstream.text())
        .split("\n")
        .filter((line) => line !== "");
      outgoing.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "",
      });
      outgoing.write(`${lines.slice(0, 2).join("\n")}\n`);
      await released;
      outgoing.end(`${lines.slice(2).join("\n")}\n`);
    })();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}`,
    release,
    stop: () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

test("a node still loading past the partial-render delay is drawn from what has arrived, marked partial, and whole once the rest lands", async ({
  page,
}) => {
  const held = await probeHeld(page);
  const proxy = await holdingProxy(server.origin);
  try {
    // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the node's read reaches the real server through a proxy that only holds its later lines back, as a slow host's network would; every byte is the server's own.
    await page.route("**/timeline/node-stream?*", (route) => {
      const asked = new URL(route.request().url());
      return route.continue({
        url: `${proxy.address}${asked.pathname}${asked.search}`,
      });
    });
    // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
    // The page's clock stands still from the moment it loads, so the delay passes
    // only as the journey runs it forward.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
    await openNode(page);
    // The first lines have landed: part of the node is held, not all of it.
    await expect
      .poll(async () => (await held()).list.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const { chart } = panel(page);
    const partial = chart.getByRole("status").filter({
      hasText: "Partial — loading",
    });
    expect(lacking(await held()).list).toBeGreaterThan(0);
    // Not before the delay has passed since the read began...
    await page.clock.runFor(NODE_TIMELINE_PARTIAL_DELAY_MS - 1);
    await expect(partial).toHaveCount(0);
    // ...and from then on, saying how much of the node has loaded.
    await page.clock.runFor(1);
    await expect(partial).toBeVisible();
    await expect(partial).toContainText(
      new RegExp(`of ${expected.size.toLocaleString("en-US")} records loaded`),
    );
    await expect(
      chart.getByText("Partial — loading", { exact: true }).first(),
    ).toBeVisible();
    await expect(chart).toHaveAttribute("aria-busy", "true");

    proxy.release();
    await page.clock.resume();
    await heldWhole(page, held);
    await expect(partial).toHaveCount(0);
  } finally {
    proxy.release();
    await proxy.stop();
  }
});

test("a node read that fails twice is tried again and loads the node whole", async ({
  page,
}) => {
  const held = await probeHeld(page);
  let asked = 0;
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the network boundary is the only doubled party: the first two reads are answered 503 as a failing host answers them, and the third reaches the real server.
  await page.route("**/timeline/node-stream?*", (route) => {
    asked += 1;
    return asked <= 2
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  await openNode(page);
  await heldWhole(page, held);
  expect(asked).toBe(3);
});

test("a node read that keeps failing says so with Try again, which loads the node whole", async ({
  page,
}) => {
  const held = await probeHeld(page);
  let failing = true;
  let asked = 0;
  // llmlint: ignore-block[e2e_not_mocked, tests_mirror_real_usage] the network boundary is the only doubled party: every read is answered 503 until the host recovers, then reaches the real server.
  await page.route("**/timeline/node-stream?*", (route) => {
    asked += 1;
    return failing
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.continue();
  });
  // llmlint: ignore-end[e2e_not_mocked, tests_mirror_real_usage]
  await openNode(page);
  const failed = panel(page)
    .list.getByRole("alert")
    .filter({ hasText: "This node's timeline did not load" });
  await expect(failed).toBeVisible({ timeout: 30_000 });
  // It was tried more than once before saying so, and nothing reads as loading
  // while nothing is being read.
  const tries = asked;
  expect(tries).toBeGreaterThan(1);
  await expect(panel(page).chart).toHaveAttribute("aria-busy", "false");
  await expect(loadingMarks(page)).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(asked).toBe(tries);

  failing = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await heldWhole(page, held);
  await expect(failed).toHaveCount(0);
});
