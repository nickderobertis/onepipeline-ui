import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";

/**
 * A node whose plan said `publish: "preserve"`, read in the browser.
 *
 * The engine settles such a node `done` as `preserved`: its branch is on its
 * origin, the settlement names the commit that branch stands at, and nothing was
 * published, so nothing landed. A reader has to see it finished, where its work
 * is, and none of what a landed node is shown — the commit it merged as, the
 * release that carried it. The node beside it on the same run did land, which is
 * what keeps "not shown" from passing on a view that shows nobody anything.
 *
 * Its corpus is its own (`runs.mjs`'s preserve corpus), served by a server this
 * file starts, because a run added to the shared one is counted by every listing
 * journey and photographed by the gallery.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  node: z.string().min(1),
  landed_node: z.string().min(1),
  branch: z.string().min(1),
  head: z.string().min(1),
  landed_commit: z.string().min(1),
  landed_version: z.string().min(1),
});

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Open one node of the run on the server's own origin, and its named tab. */
async function openTab(
  page: Page,
  origin: string,
  run: string,
  node: string,
  tab: string,
): Promise<Locator> {
  await page.goto(`${origin}/?run=${run}&node=${node}`);
  const view = page.getByRole("region", { name: `Timeline for ${node}` });
  // The node's state, as its header's badge says it.
  await expect(view.getByText("done", { exact: true })).toBeVisible();
  await view.getByRole("tab", { name: tab }).click();
  return view.getByRole("tabpanel", { name: tab });
}

test("shows a node its plan kept as done, on its branch at its head, and never as landed", async ({
  page,
}) => {
  server = await startFixtureServer("preserve", ["--preserved-corpus"]);
  const facts = factsSchema.parse(server.facts);

  // What the browser is handed, read as any HTTP client reads it.
  const detail = await (
    await page.request.get(`${server.origin}/api/v2/runs/${facts.run}`)
  ).json();
  const kept = detail.graph.node_results[facts.node];
  expect(kept).toMatchObject({
    status: "done",
    outcome: "preserved",
    branch: facts.branch,
  });
  expect(kept.detail).toContain(facts.head);
  expect("release" in kept).toBe(false);
  expect(detail.node_details[facts.node].publication).toEqual({
    branch: facts.branch,
    merged: false,
    base_branch: "main",
  });
  expect(detail.node_details[facts.landed_node].publication).toMatchObject({
    merged: true,
    commit: facts.landed_commit,
  });
  expect(detail.graph.node_results[facts.landed_node].release.version).toBe(
    facts.landed_version,
  );

  // What a reader sees: finished, and where the work is.
  const task = await openTab(
    page,
    server.origin,
    facts.run,
    facts.node,
    "Task",
  );
  await expect(task).toContainText(`kept on ${facts.branch} at ${facts.head}`);
  // And nothing a landed node is shown: no change request it merged through, and
  // no release.
  const keptPr = await openTab(
    page,
    server.origin,
    facts.run,
    facts.node,
    "PR",
  );
  await expect(keptPr).toHaveText(
    /^\s*Publication\s*Not recorded\s*Release\s*Not recorded\s*$/,
  );
  await expect(keptPr.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Pull request" })).toHaveCount(0);

  // The node beside it landed, and is shown so — the treatment the kept node
  // was not given: the change request it merged through, and the release its
  // commit went out in.
  const landed = await openTab(
    page,
    server.origin,
    facts.run,
    facts.landed_node,
    "PR",
  );
  await expect(
    landed.getByRole("link", { name: "Pull request" }),
  ).toBeVisible();
  await expect(landed).toContainText(facts.landed_version);
});
