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

test("loading earlier rows that all fall into a collapsed run still shows the reader more", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  const pages: z.infer<typeof pageSchema>[] = [];
  const windowed = new Set<string>();
  page.on("response", async (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.endsWith("/timeline/events"))
      pages.push(pageSchema.parse(await response.json()));
    else if (
      pathname === "/api/v2/subscriptions" &&
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
  const shownBefore = await rows.count();

  await transcript.getByRole("button", { name: "Load earlier rows" }).click();

  await expect.poll(() => rows.count()).toBeGreaterThan(shownBefore);
  await expect(transcript.getByRole("status")).toHaveText(
    "No earlier history remains",
  );
  // What the first page the click took brought beyond the window was nothing but
  // checks — the shape that left the reading unchanged — and the read went on
  // past it to the node's start.
  expect(windowed.size).toBeGreaterThan(0);
  expect(pages.length).toBeGreaterThan(1);
  const brought = (pages[0]?.rows ?? []).filter((row) => !windowed.has(row.id));
  expect(brought.length).toBeGreaterThan(0);
  expect(new Set(brought.map((row) => row.kind))).toStrictEqual(
    new Set(["change-check"]),
  );
  await expect(
    transcript.getByRole("button", { name: /^Load(ing)? earlier rows/ }),
  ).toHaveCount(0);
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
