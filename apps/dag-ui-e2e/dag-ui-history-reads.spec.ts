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
 * when it is read again or the panel closes. The history run, whose own rows a
 * fresh Overall has not read, is where the control that loads them is offered.
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
  const answer = await read;
  expect(answer.status()).toBe(200);
  // The session has no rows of its own: its page is whole, and empty.
  expect(await answer.json()).toMatchObject({ rows: [], total: 0 });
  expect(new URL(page.url()).searchParams.get("event")).toMatch(/^harness\./u);
  await expect(panel(page)).not.toContainText(FAILED);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText(FAILED)).toHaveCount(0);
  // Every row of the run's own is shown, and the harness session — which has none —
  // is not counted as one still to load, so the control is not offered on its
  // account.
  await expect(
    page
      .getByRole("region", { name: "Run events" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load the run's own records" }),
  ).toHaveCount(0);

  // A run whose own rows this view has not read yet offers to load them, through
  // the page's own control, and they load with nothing failed.
  await page.goto(`/?run=${runs().history}&view=overall`);
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

test("a node timeline's span page that failed is said in its panel alone, read again on Try again, and gone when another span is opened", async ({
  page,
}) => {
  await watch(page, { failure: { text: FAILED } });
  const isNodeSpanPage = (url: string) =>
    url.includes("/timeline/events?") && url.includes("span=");
  let refusing = true;
  // A page held is one whose answer the panel waits on: what it shows meanwhile is
  // what it remembers of the span.
  let holding = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // llmlint: ignore-block[e2e_not_mocked] a span page has to fail for its panel to say so, and a refused connection cannot be earned from the real server; a held page is passed to the real server unchanged once released, as is every other.
  await page.route(
    (url) => isNodeSpanPage(url.toString()),
    async (route) => {
      if (refusing) return route.abort("connectionrefused");
      if (holding) await held;
      await route.continue();
    },
  );
  // llmlint: ignore-end[e2e_not_mocked]

  await page.goto(`/?run=${runs().live}&node=dashboard`);
  const view = page.getByRole("region", { name: /^Timeline for / });
  await expect(view).toBeVisible();
  await view
    .getByRole("button", { name: /^Open worker · judge/ })
    .first()
    .click();
  const failure = panel(page).getByRole("alert").filter({ hasText: FAILED });
  await expect(failure).toBeVisible();
  // The panel's failure is its own: said once, there, and nowhere else.
  await expect(page.getByText(FAILED)).toHaveCount(1);

  // The network back, the panel still open: Try again reads the page afresh.
  refusing = false;
  const read = page.waitForResponse((response) =>
    isNodeSpanPage(response.url()),
  );
  await failure.getByRole("button", { name: "Try again" }).click();
  expect((await read).status()).toBe(200);
  await expect(page.getByText(FAILED)).toHaveCount(0);

  // Refused again on a fresh view; another span opened takes the first's failure
  // with its panel, and its own page, served, says nothing failed.
  refusing = true;
  await page.reload();
  await view
    .getByRole("button", { name: /^Open worker · judge/ })
    .first()
    .click();
  await expect(
    panel(page).getByRole("alert").filter({ hasText: FAILED }),
  ).toBeVisible();
  refusing = false;
  const other = page.waitForResponse((response) =>
    isNodeSpanPage(response.url()),
  );
  // The open panel covers the list at this width, so the next row is reached as a
  // keyboard user reaches it.
  const checkIn = view.getByRole("button", { name: /^Open check-in/ }).first();
  await checkIn.focus();
  await checkIn.press("Enter");
  expect((await other).status()).toBe(200);
  await resetSeen(page);
  await expect(page.getByText(FAILED)).toHaveCount(0);

  // The first span reopened while its page is still on its way: the failure its
  // closed panel took with it is not shown again.
  holding = true;
  const reread = page.waitForResponse((response) =>
    isNodeSpanPage(response.url()),
  );
  const judge = view
    .getByRole("button", { name: /^Open worker · judge/ })
    .first();
  await judge.focus();
  await judge.press("Enter");
  await expect(panel(page)).toContainText("worker · judge");
  await expect(page.getByText(FAILED)).toHaveCount(0);
  release();
  expect((await reread).status()).toBe(200);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await seen(page), "the first span's failure came back").toEqual({
    failure: false,
  });
});
