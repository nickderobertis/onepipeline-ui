import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseRunTimeline } from "@onepipeline-ui/dag-model";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { FIXTURE_WORKSPACE } from "./playwright.config";

/**
 * A `kind: human` step is attested from Action items, now that no Channel tab
 * holds an Attest control: a person completes the step's item there, the engine
 * attests the node through the real read API, and the node's event list shows the
 * `human-attested` record with who resolved it.
 *
 * The world is the engine's own (`human-items-world.mjs`'s `attest`): a run the
 * provisioned CLI started over a plan of two human steps — a question offering
 * choices and a task — whose items that CLI raised.
 */

const factsSchema = z.object({
  ids: z.object({ columns: z.string(), signoff: z.string() }),
  runs: z.object({ release: z.string() }),
  engine: z.string(),
  cwd: z.string(),
  environment: z.record(z.string(), z.string()),
  removed: z.array(z.string()),
});
type Facts = z.infer<typeof factsSchema>;

const detailSchema = z.object({
  graph: z.object({ node_status: z.record(z.string(), z.string()) }),
});

/** Where this run keeps each world it built, removed with the run's fixtures. */
const WORLD_TEMPLATES = join(FIXTURE_WORKSPACE, "human-items-worlds");

let server: FixtureServer | undefined;

test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test.use({ viewport: { width: 1440, height: 900 } });

/** The provisioned CLI, as the world's own session, in the world's environment. */
function cli(facts: Facts, args: readonly string[]): string {
  const env = { ...process.env, ...facts.environment };
  for (const name of facts.removed) delete env[name];
  return execFileSync(facts.engine, args, {
    cwd: facts.cwd,
    env,
    encoding: "utf8",
  });
}

/** Each node's status, as the read API serves the run. */
async function nodeStatus(
  page: Page,
  origin: string,
  run: string,
): Promise<Readonly<Record<string, string>>> {
  const response = await page.request.get(`${origin}/api/v2/runs/${run}`);
  expect(response.ok()).toBe(true);
  return detailSchema.parse(await response.json()).graph.node_status;
}

/** The `human-attested` records the read API serves on `node`'s timeline. */
async function attestations(
  page: Page,
  origin: string,
  run: string,
  node: string,
) {
  const response = await page.request.get(
    `${origin}/api/v2/runs/${run}/timeline?scope=node&node=${node}`,
  );
  expect(response.ok()).toBe(true);
  return parseRunTimeline(await response.json())
    .spans.flatMap((span) => span.events)
    .filter((event) => event.kind === "human-attested");
}

test("a human step completed from Action items attests its node, and its event list says who completed it", async ({
  page,
}) => {
  server = await startFixtureServer(
    "human-items-attest",
    ["--human-items-world", "attest"],
    { DAG_UI_E2E_WORLD_TEMPLATES: WORLD_TEMPLATES },
    { samePath: true },
  );
  const facts = factsSchema.parse(server.facts);
  const run = facts.runs.release;
  const before = await nodeStatus(page, server.origin, run);
  expect(before.signoff).toBe("waiting");

  // The question is answered as the user, with a choice and words, by the CLI a
  // manager runs; the task is completed by a person on Action items.
  cli(facts, [
    "human-items",
    "answer",
    facts.ids.columns,
    "--choice",
    "keep",
    "--text",
    "Keep them for one more release.",
    "--as",
    "user",
  ]);
  await page.goto(`${server.origin}/human-items`);
  await page
    .getByRole("button", { name: "Complete: Sign off the release notes" })
    .click();
  await expect(
    page.getByRole("article", { name: "Sign off the release notes" }),
  ).toHaveCount(0);

  // The engine attested the node, read back through the real read API.
  await expect
    .poll(
      async () => (await nodeStatus(page, server?.origin ?? "", run)).signoff,
    )
    .toBe("done");
  const [attested] = await attestations(page, server.origin, run, "signoff");
  const item = z
    .object({
      action: z.literal("completed"),
      resolution: z.object({ actor: z.string().min(1) }),
    })
    .parse(attested?.fields?.item);

  await page.goto(`${server.origin}/?run=${run}&node=signoff&view=graph`);
  const transcript = page.getByRole("region", { name: "Node transcript" });
  const row = transcript.getByRole("article", { name: "human-attested" });
  await expect(row).toContainText(" · attested");
  await row.getByRole("button").click();
  const detail = page.getByRole("complementary", { name: "Item detail panel" });
  await expect(
    detail.getByRole("heading", { name: "Human item" }),
  ).toBeVisible();
  await expect(detail).toContainText(item.resolution.actor);
  await expect(detail).toContainText("completed");

  // The question's record names the choice by its title, read from its item.
  await page.goto(`${server.origin}/?run=${run}&node=columns&view=graph`);
  await page
    .getByRole("region", { name: "Node transcript" })
    .getByRole("article", { name: "human-attested" })
    .getByRole("button")
    .click();
  const answered = page.getByRole("complementary", {
    name: "Item detail panel",
  });
  for (const said of [
    "user:operator",
    "user",
    "Keep the v1 columns (keep)",
    "Keep them for one more release.",
  ])
    await expect(answered).toContainText(said);
});
