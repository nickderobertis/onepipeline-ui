import { expect, type Page, test } from "@playwright/test";
import { resetSeen, seen, watch } from "./dom-watch";
import { runs } from "./fixture-facts";

/**
 * A history read's failure belongs to the read that failed and the view that asked
 * for it.
 *
 * Over the shared fixture's live run (`fixtures/runs.mjs`), whose observer graph's
 * monitor ran a oneharness session with no node label: Overall draws it on the
 * run-level lane as `harness.<history id>`, and opening it reads that span's page
 * through the real read API. Every span a timeline draws answers a page, so opening
 * it says nothing failed; a page the network refuses is said in its panel only, gone
 * when it is read again or the panel closes.
 */

const FAILED = "did not load:";

const graph = (page: Page) =>
  page.getByRole("region", { name: "Graph timeline", exact: true });
const panel = (page: Page) =>
  page.getByRole("complementary", { name: "Item detail panel" });
const isSpanPage = (url: string) =>
  url.includes("/timeline/events?") && url.includes("span=harness.");

/** Overall on the live run, its run-level lane open. */
async function openRunLevel(page: Page): Promise<void> {
  await page.goto(`/?run=${runs().live}&view=overall`);
  await expect(
    page.getByRole("tab", { name: "Overall", selected: true }),
  ).toBeVisible();
  await graph(page).getByRole("button", { name: "Expand timeline" }).click();
  await page
    .getByRole("region", { name: "Run-level timeline", exact: true })
    .getByRole("button", { name: "Expand timeline" })
    .click();
}

/** Open the observer's oneharness dispatch from the run-level lane. */
async function openObserver(page: Page): Promise<void> {
  await page
    .getByRole("region", { name: "Run-level timeline", exact: true })
    .getByRole("button", { name: /^Run-level · observer/ })
    .first()
    .click();
  await expect(panel(page)).toContainText("Oneharness conversation");
}

test("an observer's oneharness dispatch opens with nothing failed, and the run's own records then load", async ({
  page,
}) => {
  await watch(page, { failure: { text: FAILED } });
  // Opened from the run-level lane, which reads the run's own rows as it opens.
  await openRunLevel(page);
  const read = page.waitForResponse((response) => isSpanPage(response.url()));
  await openObserver(page);
  expect((await read).status()).toBe(200);
  expect(new URL(page.url()).searchParams.get("event")).toMatch(/^harness\./u);
  await expect(panel(page)).not.toContainText(FAILED);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText(FAILED)).toHaveCount(0);
  // Every row of the run's own is held, and a harness session — which has none —
  // offers nothing more to load.
  await expect(
    page
      .getByRole("region", { name: "Run events" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load the run's own records" }),
  ).toHaveCount(0);

  // A fresh view of the same run holds none of its own rows, and offers to load
  // them through the page's own control.
  await page.goto(`/?run=${runs().live}&view=overall`);
  await expect(
    page.getByRole("tab", { name: "Overall", selected: true }),
  ).toBeVisible();
  const rows = page.waitForResponse(
    (response) =>
      response.url().includes("/timeline/events?") &&
      !response.url().includes("span="),
  );
  await page
    .getByRole("button", { name: "Load the run's own records" })
    .click();
  expect((await rows).status()).toBe(200);
  await expect(
    page
      .getByRole("region", { name: "Run events" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load the run's own records" }),
  ).toHaveCount(0);
  await expect(page.getByText(FAILED)).toHaveCount(0);
  expect(await seen(page), "a failure appeared at some moment").toEqual({
    failure: false,
  });
});

test("a span page that failed is said in its panel alone, read again on Try again, and gone with the panel", async ({
  page,
}) => {
  await watch(page, { failure: { text: FAILED } });
  let refusing = true;
  const asked: string[] = [];
  // A refused connection is the one fault a browser test cannot earn from the real
  // server; every page not refused goes through to it unchanged.
  // llmlint: ignore-block[e2e_not_mocked] the acceptance criterion requires one span page forced to fail at the network boundary and then the network restored; a refused connection cannot be earned from the real server, and every request not refused is passed to it unchanged.
  await page.route(
    (url) => isSpanPage(url.toString()),
    async (route) => {
      asked.push(route.request().url());
      if (refusing) await route.abort("connectionrefused");
      else await route.continue();
    },
  );
  // llmlint: ignore-end[e2e_not_mocked]

  await openRunLevel(page);
  await openObserver(page);
  const failure = panel(page).getByRole("alert").filter({ hasText: FAILED });
  await expect(failure).toBeVisible();
  // The panel's failure is its own: nothing is said under the graph.
  await expect(graph(page).getByText(FAILED)).toHaveCount(0);

  // The network back, the panel still open: Try again reads the page afresh.
  refusing = false;
  const before = asked.length;
  const read = page.waitForResponse((response) => isSpanPage(response.url()));
  await failure.getByRole("button", { name: "Try again" }).click();
  expect((await read).status()).toBe(200);
  expect(asked.length).toBeGreaterThan(before);
  await expect(panel(page).getByText(FAILED)).toHaveCount(0);
  await expect(graph(page).getByText(FAILED)).toHaveCount(0);

  // Again, from a fresh view: refused, then the panel closed with it said.
  refusing = true;
  await openRunLevel(page);
  await openObserver(page);
  await expect(
    panel(page).getByRole("alert").filter({ hasText: FAILED }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(panel(page)).toHaveCount(0);
  await resetSeen(page);
  await expect(page.getByText(FAILED)).toHaveCount(0);

  // Reopened once the network recovered, the span is read and loads.
  refusing = false;
  const reread = page.waitForResponse((response) => isSpanPage(response.url()));
  await openObserver(page);
  expect((await reread).status()).toBe(200);
  await expect(panel(page).getByText(FAILED)).toHaveCount(0);
  expect(await seen(page), "the closed panel's failure came back").toEqual({
    failure: false,
  });
});
