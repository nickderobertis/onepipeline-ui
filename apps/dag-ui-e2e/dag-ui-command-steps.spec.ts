import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { graphNodes } from "./observatory-locators";

/**
 * A plan of command steps, read in the browser: each node the engine ran itself
 * is drawn as a `command`, with how it ended, and a live edit the run's
 * plan-edit hook refused is shown beside the graph naming that hook.
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

/** Each node, the state the run settled it in, and the outcome it recorded. */
const STEPS = [
  { node: "build", state: "done", outcome: undefined },
  { node: "lint", state: "failed", outcome: "command-failed" },
  { node: "integration", state: "failed", outcome: "command-timed-out" },
] as const;

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Everything the page throws, and every request that does not come back answered. */
function watchFailures(page: Page): {
  thrown: string[];
  unanswered: string[];
} {
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
  return { thrown, unanswered };
}

test("draws each command step with its kind and outcome, and shows the edit the plan-edit hook refused", async ({
  page,
}) => {
  server = await startFixtureServer("command-steps", [
    "--command-steps-corpus",
  ]);
  const { origin } = server;
  const { run, hook } = factsSchema.parse(server.facts);
  const { thrown, unanswered } = watchFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${origin}/?run=${run}&view=graph`);
  await expect(graphNodes(page)).toHaveCount(STEPS.length);
  // The app takes over from the first screen before the cards are read, so what is
  // read is what the live view draws.
  // llmlint: ignore[e2e_uses_accessible_selectors] the app replaces the first screen with no visible jump by design, so nothing a person can perceive says which of the two is drawn; this marker is the one difference, and only waiting for the app to have taken over is read from it.
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);

  for (const { node, state, outcome } of STEPS) {
    const card = page.getByRole("article", {
      name: `${node}: ${state}`,
      exact: true,
    });
    await expect(card).toBeVisible();
    // The kind badge: a command, never folded into an agent.
    await expect(card).toContainText("command");
    await expect(card).not.toContainText("agent");
    await expect(card).toContainText(state);
    if (outcome !== undefined) await expect(card).toContainText(outcome);
  }
  // A step that succeeded recorded no failure outcome to show.
  await expect(
    page.getByRole("article", { name: "build: done", exact: true }),
  ).not.toContainText("command-");

  const refused = page.getByRole("region", { name: "1 refused edit" });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText("planner: add deploy");
  await expect(refused).toContainText(
    `the plan-edit hook \`${hook}\` refused node 'deploy'`,
  );

  expect(thrown).toEqual([]);
  expect(unanswered).toEqual([]);
});

test("opens a command step to what it ran, how it ended and the end of its log", async ({
  page,
}) => {
  server = await startFixtureServer("command-steps", [
    "--command-steps-corpus",
  ]);
  const { origin } = server;
  const { run, logs } = factsSchema.parse(server.facts);
  const { thrown, unanswered } = watchFailures(page);

  for (const { node, state, outcome } of STEPS) {
    await page.goto(`${origin}/?run=${run}&node=${node}`);
    await expect(
      page.getByRole("region", { name: `Timeline for ${node}` }),
    ).toBeVisible();
    const command = page.getByRole("region", { name: "Command", exact: true });
    await expect(command).toContainText("cargo");
    await expect(command).toContainText(outcome ?? state);
    await expect(command).toContainText(`commands/${node}.log`);
    const log = logs[node];
    if (log === undefined)
      throw new Error(`the corpus wrote no log for ${node}`);
    // The log's last line, as the command wrote it.
    const lastLine = log.trimEnd().split("\n").at(-1) ?? "";
    await expect(
      command.getByRole("figure", { name: "Command log" }),
    ).toContainText(lastLine);
  }

  // The failed step's view leads with its outcome before the command's own words.
  await page.goto(`${origin}/?run=${run}&node=lint`);
  await expect(page.getByRole("alert")).toContainText(
    "command-failed: the command exited with status 101",
  );

  expect(thrown).toEqual([]);
  expect(unanswered).toEqual([]);
});
