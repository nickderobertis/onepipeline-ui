import { runTimelineSchema } from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

/**
 * Three views a measurement on a real host's large runs found failing, each held
 * here against the shape that broke it (`runs.mjs`'s large-run views corpus):
 * a page of earlier history that lands wholly inside a collapsed run, a run whose
 * name is too long to key one node's dispatch by, and a link to a node the run
 * recorded work for that its graph does not hold.
 *
 * The corpus is its own, served by a server this file starts, because a run added
 * to the shared one is counted by every listing journey and photographed by the
 * gallery.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  history: z.string().min(1),
  unkeyed: z.string().min(1),
  offGraph: z.string().min(1),
  checks: z.number().int().positive(),
  historyId: z.string().min(1),
});
type Facts = z.infer<typeof factsSchema>;

const pageSchema = z.object({
  rows: z.array(z.object({ id: z.string(), kind: z.string() })),
});

/** The rows a node's first answer held: its latest window. */
const firstAnswerSchema = z.object({
  initial: z.object({
    snapshot: z.object({
      visible: z.object({
        timeline: z
          .object({
            spans: z.array(
              z.object({ events: z.array(z.object({ id: z.string() })) }),
            ),
          })
          .optional(),
      }),
    }),
  }),
});

/** What the page says while the rest of a run's history is on its way. */
const HISTORY_LOADING_TEXT = "The rest of this run's history is still loading";

let server: FixtureServer;
let facts: Facts;

test.beforeAll(async () => {
  server = await startFixtureServer("large-run-views", [
    "--large-run-views-corpus",
  ]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server.stop();
});

/** Everything the page throws, from the first navigation on. */
function thrownBy(page: Page): string[] {
  const thrown: string[] = [];
  page.on("pageerror", (error) => thrown.push(error.message));
  return thrown;
}

/** One page of earlier rows as the page asked for and was answered it. */
interface Asked {
  readonly limit: string | null;
  readonly rows: z.infer<typeof pageSchema>["rows"];
}

/**
 * Open the history node, recording every page of earlier rows it is answered and
 * the rows its first answer held, and return its transcript once it shows the
 * run of checks collapsed at the top of its window.
 */
async function openHistory(page: Page) {
  const pages: Asked[] = [];
  const windowed = new Set<string>();
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/timeline/events")) {
      if (!response.ok()) return;
      pages.push({
        limit: url.searchParams.get("limit"),
        rows: pageSchema.parse(await response.json()).rows,
      });
    } else if (
      url.pathname === "/api/v2/subscriptions" &&
      response.request().method() === "POST"
    ) {
      const { timeline } = firstAnswerSchema.parse(await response.json())
        .initial.snapshot.visible;
      for (const span of timeline?.spans ?? [])
        for (const event of span.events) windowed.add(event.id);
    }
  });
  await page.goto(
    `${server.origin}/?run=${facts.run}&view=graph&node=${facts.history}`,
  );
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const rows = transcript.getByRole("article");
  await expect(rows.first()).toBeVisible();
  // The latest window ends inside the run of checks, which stands collapsed.
  await expect(
    transcript.getByRole("button", { name: /^Show \d+ more change-check/ }),
  ).toBeVisible();
  return { pages, windowed, transcript, rows };
}

test("loading earlier rows that all fall into a collapsed run still shows the reader more", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  const { pages, windowed, transcript, rows } = await openHistory(page);
  const load = transcript.getByRole("button", { name: "Load earlier rows" });
  const shownBefore = await rows.count();

  await load.click();

  await expect.poll(() => rows.count()).toBeGreaterThan(shownBefore);
  // The first page the click took brought nothing beyond the window but checks —
  // the shape that left the reading unchanged — so the read went on, one page
  // more, and stopped there: the reading gained rows and earlier history is left.
  expect(windowed.size).toBeGreaterThan(0);
  const brought = (pages[0]?.rows ?? []).filter((row) => !windowed.has(row.id));
  expect(brought.length).toBeGreaterThan(0);
  expect(new Set(brought.map((row) => row.kind))).toStrictEqual(
    new Set(["change-check"]),
  );
  await expect(load).toBeEnabled();
  expect(pages).toHaveLength(2);
  await expect(transcript.getByRole("status")).toHaveCount(0);

  // A reading that no longer opens on a collapsed run reads one ordinary page,
  // here the last: the view then says nothing earlier remains.
  const shownAfterFirst = await rows.count();
  await load.click();
  await expect(transcript.getByRole("status")).toHaveText(
    "No earlier history remains",
  );
  expect(await rows.count()).toBeGreaterThan(shownAfterFirst);
  expect(pages.at(-1)?.limit).toBeNull();
  await expect(
    transcript.getByRole("button", { name: /^Load(ing)? earlier rows/ }),
  ).toHaveCount(0);
  expect(thrown).toStrictEqual([]);
});

test("a page the read went on to that fails says so, and Try again takes it", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  const { pages, transcript, rows } = await openHistory(page);
  // The second page of the click's read is refused once, by the server.
  let asked = 0;
  const retried: string[] = [];
  await page.route("**/timeline/events?*", async (route) => {
    asked += 1;
    if (asked === 2) {
      await route.fulfill({ status: 503, body: "unavailable" });
      return;
    }
    if (asked > 2) retried.push(route.request().url());
    await route.continue();
  });
  const shownBefore = await rows.count();

  await transcript.getByRole("button", { name: "Load earlier rows" }).click();

  const failed = transcript
    .getByRole("alert")
    .filter({ hasText: "Earlier rows did not load" });
  await expect(failed).toBeVisible();
  expect(await rows.count()).toBe(shownBefore);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(shownBefore);
  await expect(failed).toHaveCount(0);
  // The retry asked for the same wide page from the same place.
  expect(retried).toHaveLength(1);
  const retry = new URL(retried[0] ?? "");
  expect(retry.searchParams.get("limit")).toBe(pages[0]?.limit);
  expect(retry.searchParams.get("cursor")).not.toBeNull();
  expect(thrown).toStrictEqual([]);
});

test("a run whose dispatch spans have no dispatch id opens its Overall view whole", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  await page.goto(`${server.origin}/?run=${facts.run}&view=overall`);
  const overall = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  // The rest arrives as patches over the stream; one the view's schema refused
  // used to leave "Timeline unavailable" where the plot should be.
  await expect(
    page.getByRole("heading", { name: "Graph timeline" }),
  ).toBeVisible();
  await expect(page.getByText(HISTORY_LOADING_TEXT)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(overall).toBeVisible();
  await overall.getByRole("button", { name: "Expand timeline" }).click();
  await expect(
    page.getByRole("region", { name: `${facts.unkeyed} timeline` }),
  ).toBeVisible();
  await expect(page.getByText("Timeline unavailable")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // What the server serves for the run, read as the view's own schema reads it:
  // the unkeyed node's harness span is served with no dispatch id at all.
  const served = runTimelineSchema.parse(
    await (
      await page.request.get(
        `${server.origin}/api/v2/runs/${facts.run}/timeline?scope=run`,
      )
    ).json(),
  );
  const harness = served.spans.find(
    (span) => span.id === `harness.${facts.historyId}`,
  );
  expect(harness).toMatchObject({
    kind: "dispatch",
    harness_scope: "node",
    status: "no-recorded-end",
    node_id: facts.unkeyed,
  });
  expect(harness).not.toHaveProperty("dispatch_id");
  expect(thrown).toStrictEqual([]);
});

test("a link to a node the run recorded but its graph does not hold opens that node's timeline", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  const asked: string[] = [];
  page.on("request", (request) => asked.push(request.url()));
  await page.goto(
    `${server.origin}/?run=${facts.run}&view=graph&node=${facts.offGraph}`,
  );
  const view = page.getByRole("region", {
    name: `Timeline for ${facts.offGraph}`,
  });
  await expect(view).toBeVisible();
  await expect(view.getByText("off-graph node")).toBeVisible();
  const transcript = view.getByRole("region", { name: "Node transcript" });
  await expect(transcript.getByRole("article").first()).toBeVisible();
  await expect(transcript).toContainText("push");
  // The node's own timeline was what the page read, not the graph's.
  expect(
    asked.some((url) => url.includes(encodeURIComponent(facts.offGraph))),
  ).toBe(true);
  // What the plan does not hold is said, not invented.
  await view.getByRole("tab", { name: "Task" }).click();
  await expect(view).toContainText("not on the run's graph");
  await expect(page.getByRole("article", { name: /: done$/ })).toHaveCount(0);
  expect(thrown).toStrictEqual([]);
});
