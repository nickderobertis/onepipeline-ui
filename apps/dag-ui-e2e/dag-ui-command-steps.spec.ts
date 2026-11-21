import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { graphNodes } from "./observatory-locators";

/**
 * A plan of command steps, read in the browser: each node the engine ran itself
 * is drawn as a `command`, with how it ended, and the live edits the run refused
 * are shown beside the graph, the plan-edit hook's refusal naming that hook.
 *
 * Its corpus is its own (`runs.mjs`'s command-steps corpus, the records
 * `tests/e2e/server.rs` writes through the engine's own envelope and serves),
 * served by a server this file starts, because a run added to the shared one is
 * counted by every listing journey and photographed by the gallery.
 */

const factsSchema = z.object({
  run: z.string().min(1),
  hook: z.string().min(1),
  logs: z.record(z.string(), z.string()),
});

const detailSchema = z.object({
  graph: z.object({ node_status: z.record(z.string(), z.string()) }),
});

const OUTCOMES: Readonly<Record<string, string>> = {
  lint: "command-failed",
  integration: "command-timed-out",
};

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/**
 * Collects every error the page throws and every request it makes that does not
 * come back answered, so a journey can say nothing about a refused edit or a
 * command kind broke the page on the way.
 */
function watchFailures(page: Page): {
  thrown: string[];
  unanswered: string[];
} {
  const thrown: string[] = [];
  const unanswered: string[] = [];
  page.on("pageerror", (error) => thrown.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    // A node's whole-timeline read is cancelled by the view itself when the reader
    // leaves the node before it lands: a read nobody waits for, not one unanswered.
    if (
      failure === "net::ERR_ABORTED" &&
      new URL(request.url()).pathname.endsWith("/timeline/node-stream")
    )
      return;
    unanswered.push(`${request.url()}: ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      unanswered.push(`${response.url()}: ${response.status()}`);
  });
  return { thrown, unanswered };
}

async function served(page: Page): Promise<{
  origin: string;
  facts: z.infer<typeof factsSchema>;
  status: Readonly<Record<string, string>>;
}> {
  server = await startFixtureServer("command-steps", [
    "--command-steps-corpus",
  ]);
  const facts = factsSchema.parse(server.facts);
  const detail = detailSchema.parse(
    await (
      await page.request.get(`${server.origin}/api/v2/runs/${facts.run}`)
    ).json(),
  );
  return { origin: server.origin, facts, status: detail.graph.node_status };
}

test("draws each command step with its kind and outcome, and nothing over the graph for the edits the run refused", async ({
  page,
}) => {
  const { origin, facts, status } = await served(page);
  const { thrown, unanswered } = watchFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${origin}/?run=${facts.run}&view=graph`);
  const nodes = Object.keys(status);
  expect(nodes.sort()).toEqual([
    "build",
    "changelog",
    "docs",
    "integration",
    "lint",
    "package",
  ]);
  await expect(graphNodes(page)).toHaveCount(nodes.length);
  // llmlint: ignore[e2e_uses_accessible_selectors] the app replaces the first screen with no visible jump by design, so nothing a person can perceive says which of the two is drawn; this marker is the one difference, and only waiting for the app to have taken over is read from it.
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);

  for (const node of nodes) {
    const card = page.getByRole("article", {
      name: `${node}: ${status[node]}`,
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText("command");
    await expect(card).not.toContainText("agent");
    const outcome = OUTCOMES[node];
    if (outcome !== undefined) await expect(card).toContainText(outcome);
  }
  await expect(
    page.getByRole("article", { name: "build: done", exact: true }),
  ).not.toContainText("command-");

  // The edits the run refused are events of the run, read in its event list
  // (`dag-ui-refusals.spec.ts`), and nothing is drawn over the graph for them.
  await expect(page.getByRole("region", { name: "Refused edits" })).toHaveCount(
    0,
  );

  expect(thrown).toEqual([]);
  expect(unanswered).toEqual([]);
});

test("opens a command step to what it ran, how it ended and the end of its log", async ({
  page,
}) => {
  const { origin, facts, status } = await served(page);
  const { thrown, unanswered } = watchFailures(page);
  const command = page.getByRole("region", { name: "Command", exact: true });
  const log = command.getByRole("figure", { name: "Command log" });

  for (const [node, said] of Object.entries(facts.logs)) {
    await page.goto(`${origin}/?run=${facts.run}&node=${node}`);
    await expect(
      page.getByRole("region", { name: `Timeline for ${node}` }),
    ).toBeVisible();
    await expect(command).toContainText("cargo");
    await expect(command).toContainText(OUTCOMES[node] ?? status[node] ?? "");
    await expect(command).toContainText(`commands/${node}.log`);
    await expect(log).toContainText(said.trimEnd().split("\n").at(-1) ?? "");
  }

  // The timed step states its deadline, and its log is longer than the view is
  // served, so it says the start is cut.
  await page.goto(`${origin}/?run=${facts.run}&node=integration`);
  await expect(command).toContainText("30 seconds");
  await expect(log).toHaveText(/^Command log…/u);

  await page.goto(`${origin}/?run=${facts.run}&node=lint`);
  await expect(page.getByRole("alert")).toContainText(
    "command-failed: the command exited with status 101",
  );

  // A log the run no longer holds, and a step that never started.
  await page.goto(`${origin}/?run=${facts.run}&node=docs`);
  await expect(command).toContainText("commands/docs.log");
  await expect(command).toContainText("The log is not readable from this run.");
  await expect(log).toHaveCount(0);
  await page.goto(`${origin}/?run=${facts.run}&node=package`);
  await expect(command).toContainText("cargo package");
  await expect(command).toContainText("The command has not started.");

  expect(thrown).toEqual([]);
  expect(unanswered).toEqual([]);
});

test("shows a step its guard found not needed as done, with outcome not-needed", async ({
  page,
}) => {
  const { origin, facts, status } = await served(page);
  const { thrown, unanswered } = watchFailures(page);
  expect(status.changelog).toBe("done");

  await page.goto(`${origin}/?run=${facts.run}&view=graph`);
  await expect(
    page.getByRole("article", { name: "changelog: done", exact: true }),
  ).toBeVisible();
  await expect(graphNodes(page, "unknown")).toHaveCount(0);

  // The guard answered before the command ran: the node is settled with the
  // guard's outcome and detail, and its command never started.
  await page.goto(`${origin}/?run=${facts.run}&node=changelog`);
  const command = page.getByRole("region", { name: "Command", exact: true });
  await expect(command).toContainText("Outcomenot-needed");
  await expect(command).toContainText("The command has not started.");
  await page.getByRole("tab", { name: "Task", exact: true }).click();
  const task = page.getByRole("tabpanel", { name: "Task", exact: true });
  await expect(task).toContainText("Settled asnot-needed");
  await expect(task).toContainText(
    "Outcomeno commits since v0.4.0 touch a released file",
  );

  // The guard's two records on the node's timeline, each drawn as a verification
  // — a gate on the node — read off the glyph the icon set drew its marker with,
  // as `dag-ui.spec.ts` reads every category's, and named here rather than
  // derived from the mapping under test.
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  const timeline = page.getByRole("region", { name: "Node timeline" });
  for (const kind of ["guard-started", "guard-evaluated"]) {
    const marker = timeline.getByRole("button", {
      name: `${kind}, marker`,
      exact: true,
    });
    await expect(marker).toBeVisible();
    // llmlint: ignore[e2e_uses_accessible_selectors] the UI exposes a timeline record's category only as an aria-hidden glyph, so the glyph the icon set drew is the one reading of it there is; `dag-ui.spec.ts` reads every category's the same way under this rule's ignore.
    await expect(marker.locator("svg")).toHaveClass(/\blucide-shield-check\b/u);
  }

  expect(thrown).toEqual([]);
  expect(unanswered).toEqual([]);
});
