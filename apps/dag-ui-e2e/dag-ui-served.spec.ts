import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runListSchema } from "@onepipeline-ui/dag-model";
import { expect, test } from "@playwright/test";
import { runs } from "./fixture-facts";
import { graphNodes } from "./observatory-locators";
import { SERVED_UI_URL } from "./playwright.config";

/**
 * The view opened through `onepipeline-api serve --ui` alone.
 *
 * Every other journey here reaches the built bundle through a Vite preview
 * proxying to the read API — the arrangement a consumer used to have to build
 * for itself. This one opens the origin the API itself serves, with no static
 * server in front of it, and holds it to three things: the page a browser gets
 * is the bundle `dag-ui:build` produced, the app it runs reads its data from
 * that same origin, and a deep link at a path the bundle has no file for still
 * opens the app rather than a 404.
 *
 * It shares the fixture server with `dag-ui.spec.ts`, whose last journeys take
 * every served run away, and sorts ahead of it by name.
 */

/** The bundle on disk, which is what the binary under test embedded. */
const BUILT_INDEX = join(import.meta.dirname, "../dag-ui/dist/index.html");

test("the API's own origin serves the built view, its data, and a deep link", async ({
  page,
}) => {
  // The bytes: the page is the bundle's index, byte for byte.
  const index = await page.request.get(`${SERVED_UI_URL}/`);
  expect(index.status()).toBe(200);
  expect(index.headers()["content-type"]).toBe("text/html; charset=utf-8");
  expect(await index.text()).toBe(readFileSync(BUILT_INDEX, "utf8"));

  // The data: the same origin answers the contract, and it is what the app reads.
  const served = await page.request.get(`${SERVED_UI_URL}/api/v2/runs`);
  expect(served.ok()).toBe(true);
  const list = runListSchema.parse(await served.json());
  expect(list.runs.map((run) => run.run_id)).toContain(runs().live);

  // The app, from that origin, drawing the live run's graph out of that data.
  await page.goto(`${SERVED_UI_URL}/?list=runs&run=${runs().live}&view=graph`);
  await expect(page.getByText("DAG Observatory")).toBeVisible();
  await expect(graphNodes(page).first()).toBeVisible();

  // A deep link at a path the bundle has no file for is the app too: the
  // server answers it with the index, and the index names its assets absolutely.
  await page.goto(
    `${SERVED_UI_URL}/observatory/runs?list=runs&run=${runs().live}&view=graph`,
  );
  await expect(page.getByText("DAG Observatory")).toBeVisible();
  await expect(graphNodes(page).first()).toBeVisible();

  // And under the API's own prefix nothing is a page: a route the API does not
  // have is the error contract, as it is without the view.
  const refused = await page.request.get(
    `${SERVED_UI_URL}/api/v2/no-such-route`,
  );
  expect(refused.status()).toBe(404);
  expect(refused.headers()["content-type"]).toContain("application/json");
  expect(await refused.json()).toEqual({
    error: { code: "no_such_route", message: "no such route" },
  });
});
