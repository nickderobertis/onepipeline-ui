import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * `dag-ui-e2e:test` runs the browser tier as two runs of its config at once
 * (`DAG_UI_E2E_RUN=first` and `second`, `playwright.config.ts`'s `SECOND_RUN`), each
 * over servers of its own. What that split owes is the tier itself: every journey
 * one run of the config selects is selected by exactly one of the two, so a spec
 * added anywhere still runs, once. Asked of Playwright's own selection (`--list`),
 * which is what each run then executes.
 */
const TIER_CONFIG = join(import.meta.dirname, "..", "playwright.config.ts");

interface Listing {
  ok: boolean;
  output: string;
  journeys: string[];
}

/** What one selection of the tier's config would run: `file › title` per journey. */
function list(run: string | undefined): Promise<Listing> {
  // Loading the config makes the run's fixture directory, and a listing runs no
  // teardown to remove it, so each listing makes it under a directory of its own.
  const scratch = mkdtempSync(join(tmpdir(), "dag-ui-e2e-split-"));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
  delete env.DAG_UI_E2E_SESSION;
  delete env.DAG_UI_E2E_RUN;
  if (run !== undefined) env.DAG_UI_E2E_RUN = run;
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["playwright", "test", "--config", TIER_CONFIG, "--list"],
      { env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        rmSync(scratch, { recursive: true, force: true });
        const journeys = stdout
          .split("\n")
          .filter((line) => line.includes(" › "))
          .map((line) => line.replace(/^\s*\[[^\]]+\] › /, "").trim());
        resolve({ ok: error === null, output: stdout + stderr, journeys });
      },
    );
  });
}

test("the tier's two runs select every journey of one run, each exactly once", async () => {
  const [whole, first, second] = await Promise.all([
    list(undefined),
    list("first"),
    list("second"),
  ]);
  for (const listing of [whole, first, second])
    expect(listing.ok, listing.output).toBe(true);
  // Both halves carry journeys, so an empty selection cannot pass as a partition.
  expect(first.journeys.length).toBeGreaterThan(0);
  expect(second.journeys.length).toBeGreaterThan(0);
  const both = new Set(first.journeys);
  expect(second.journeys.filter((journey) => both.has(journey))).toEqual([]);
  expect([...first.journeys, ...second.journeys].sort()).toEqual(
    [...whole.journeys].sort(),
  );
});

test("a run the config does not name is refused before anything starts", async () => {
  const refused = await list("third");
  expect(refused.ok).toBe(false);
  expect(refused.output).toContain(
    "DAG_UI_E2E_RUN is first, second, or unset for the whole tier",
  );
  expect(refused.journeys).toEqual([]);
});
