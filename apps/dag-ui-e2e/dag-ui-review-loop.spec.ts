import { expect, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { graphNodes } from "./observatory-locators";

/**
 * A stacked change set taken through review, read in the browser.
 *
 * The view knows none of the engine's stacking, rework and readjustment records
 * by name, and a reader still has to be shown the run and every node in it,
 * with nothing the page asked for refused and nothing thrown on the way.
 *
 * Its corpus is its own (`runs.mjs`'s review-loop corpus, the same records
 * `tests/e2e/server.rs` serves), served by a server this
 * file starts, because a run added to the shared one is counted by every
 * listing journey and photographed by the gallery.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  replied_node: z.string().min(1),
});

const detailSchema = z.object({
  graph: z.object({
    plan: z.object({ tasks: z.array(z.object({ id: z.string().min(1) })) }),
    node_states: z.record(z.string(), z.string()),
  }),
});

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test("renders a reworked, continued and readjusted stack and every node in it with nothing refused", async ({
  page,
}) => {
  server = await startFixtureServer("review-loop", ["--review-loop-corpus"]);
  const { origin } = server;
  const { run, replied_node: replied } = factsSchema.parse(server.facts);

  // Everything the page throws, and every request it makes that does not come
  // back answered, from the first navigation on.
  const thrown: string[] = [];
  const unanswered: string[] = [];
  page.on("pageerror", (error) => thrown.push(error.message));
  page.on("requestfailed", (request) =>
    unanswered.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      unanswered.push(`${response.url()}: ${response.status()}`);
  });

  // What the browser is handed, read as any HTTP client reads it: the
  // replacement in place of the node it reworked, beside the rest of the stack.
  const detail = detailSchema.parse(
    await (await page.request.get(`${origin}/api/v2/runs/${run}`)).json(),
  );
  const nodes = detail.graph.plan.tasks.map((task) => task.id);
  expect([...nodes].sort()).toEqual([
    "api",
    "cli",
    "docs",
    "helper",
    "schema",
    "ui-rework-1",
  ]);

  await page.goto(`${origin}/?run=${run}&view=graph`);
  await expect(page.getByText("DAG Observatory")).toBeVisible();
  await expect(graphNodes(page)).toHaveCount(nodes.length);
  for (const node of nodes) {
    await expect(
      page.getByRole("article", {
        name: `${node}: ${detail.graph.node_states[node]}`,
      }),
    ).toBeVisible();
  }

  for (const node of nodes) {
    await page.goto(`${origin}/?run=${run}&node=${node}`);
    await expect(
      page.getByRole("region", { name: `Timeline for ${node}` }),
    ).toBeVisible();
  }

  // The agents: the reply drafter a review pass launched for a node's comments
  // is grouped under a scope of its own, after the node's dispatch.
  await page.goto(`${origin}/?run=${run}&view=agents`);
  const panel = page.getByRole("region", { name: "Agents" });
  await expect(panel).toContainText("2 agents");
  const drafting = panel.getByRole("list", {
    name: "Review comment reply · attempt 1",
  });
  await expect(drafting).toContainText(`node ${replied}`);
  expect(
    await panel.getByRole("heading", { level: 4 }).allTextContents(),
  ).toEqual(["Node dispatch · attempt 1", "Review comment reply · attempt 1"]);

  expect(thrown).toEqual([]);
  expect(unanswered).toEqual([]);
});
