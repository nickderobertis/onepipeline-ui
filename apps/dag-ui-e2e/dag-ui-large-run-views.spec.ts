import { runTimelineSchema } from "@onepipeline-ui/dag-model";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
  unrecorded: z.string().min(1),
  onlyChecks: z.string().min(1),
  checks: z.number().int().positive(),
  historyId: z.string().min(1),
});
type Facts = z.infer<typeof factsSchema>;

/** A line of the node's stream, read for the kinds of the rows it carried. */
const streamLineSchema = z.object({
  kind: z.string(),
  rows: z.array(z.object({ kind: z.string() })).optional(),
});

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

/** The definition a facts list gives for `term`, read by role in list order. */
async function fact(panel: Locator, term: string): Promise<Locator> {
  const terms = await panel.getByRole("term").allTextContents();
  expect(terms).toContain(term);
  return panel.getByRole("definition").nth(terms.indexOf(term));
}

function thrownBy(page: Page): string[] {
  const thrown: string[] = [];
  page.on("pageerror", (error) => thrown.push(error.message));
  return thrown;
}

/**
 * Open a node and wait until its whole timeline is held, returning its transcript
 * and the rows the node's read carried.
 */
async function openWhole(page: Page, node: string) {
  const streamed = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/timeline/node-stream"),
  );
  await page.goto(`${server.origin}/?run=${facts.run}&view=graph&node=${node}`);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  await expect(transcript).toHaveAttribute("aria-busy", "false");
  const read = (await (await streamed).text())
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((text) => streamLineSchema.parse(JSON.parse(text)).rows ?? [])
    .map((row) => row.kind);
  return { transcript, read };
}

test("a node whose earlier rows all fall into a collapsed run shows them inside it once its read lands", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  const { transcript, read } = await openWhole(page, facts.history);
  // The read brought rows beyond the run of checks, and the run of checks whole:
  // the collapsed run counts every check the node recorded, and the rows before it
  // are listed above it.
  expect(read.length).toBeGreaterThan(facts.checks);
  await expect(
    transcript.getByRole("region", {
      name: `1 event repeated ${facts.checks} times: change-check`,
    }),
  ).toBeVisible();
  expect(read.filter((kind) => kind !== "change-check").length).toBeGreaterThan(
    0,
  );
  await expect(
    transcript.getByRole("button", { name: /^Load(ing)? earlier rows/ }),
  ).toHaveCount(0);
  expect(thrown).toStrictEqual([]);
});

test("a node of nothing but collapsed checks reads as one run of all of them", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  const { transcript, read } = await openWhole(page, facts.onlyChecks);
  await expect(
    transcript.getByRole("region", {
      name: `1 event repeated ${facts.checks} times: change-check`,
    }),
  ).toBeVisible();
  expect(read.filter((kind) => kind === "change-check")).toHaveLength(
    facts.checks,
  );
  await expect(transcript.getByRole("status")).toHaveCount(0);
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
  // The status and failure the run's closing result recorded for it.
  await expect(view.getByText("cancelled", { exact: true })).toBeVisible();
  await expect(view.getByText("This node was cancelled: agent")).toBeVisible();
  const transcript = view.getByRole("region", { name: "Node transcript" });
  await expect(transcript.getByRole("article").first()).toBeVisible();
  await expect(transcript).toContainText("push");
  // The node's own timeline was what the page read, not the graph's.
  expect(
    asked.some((url) => url.includes(encodeURIComponent(facts.offGraph))),
  ).toBe(true);
  // What the plan does not hold is said, not invented.
  const panel = view.getByRole("tabpanel");
  await view.getByRole("tab", { name: "Task" }).click();
  await expect(panel).toContainText("not on the run's graph");
  await expect(await fact(panel, "Graph overrides")).toHaveText("None");
  await view.getByRole("tab", { name: "Acceptance criteria" }).click();
  await expect(panel).toContainText("not on the run's graph");
  await view.getByRole("tab", { name: "Dependencies" }).click();
  await expect(await fact(panel, "Dependencies")).toHaveText("None");
  await expect(await fact(panel, "Unblocks")).toHaveText("None");
  await view.getByRole("tab", { name: "Remote" }).click();
  await expect(await fact(panel, "Release")).toHaveText("Not recorded");
  await expect(page.getByRole("article", { name: /: done$/ })).toHaveCount(0);
  expect(thrown).toStrictEqual([]);
});

test("a node off the graph that no record gives a status reads as unknown", async ({
  page,
}) => {
  const thrown = thrownBy(page);
  await page.goto(
    `${server.origin}/?run=${facts.run}&view=graph&node=${facts.unrecorded}`,
  );
  const view = page.getByRole("region", {
    name: `Timeline for ${facts.unrecorded}`,
  });
  await expect(view.getByText("off-graph node")).toBeVisible();
  await expect(view.getByText("unknown", { exact: true })).toBeVisible();
  await expect(
    view
      .getByRole("region", { name: "Node transcript" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
  expect(thrown).toStrictEqual([]);
});
