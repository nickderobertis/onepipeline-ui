import { expect, type Locator, type Page, test } from "@playwright/test";
import { fixture, runs } from "./fixture-facts";
import { graphNodeList, graphNodes } from "./observatory-locators";
import { SERVED_UI_URL } from "./playwright.config";

/**
 * Finished work held for a release, read the way a person supervising the run
 * reads it: off `onepipeline-api serve --ui`'s own origin, at the desktop width.
 *
 * The run holds one node `complete-but-held` — its branch kept unlanded on its
 * origin — awaiting one release, and one `complete-but-draft` awaiting two from two
 * producers, whose recorded `detail` names neither. So every word the view says
 * about what a node waits on can only have come from the served `awaiting`: a view
 * reading the prose would say nothing for the draft, and one reading only the first
 * entry would name one producer where the run recorded two.
 */

const awaiting = () => fixture().awaiting;

/** A producer's last path segment, which is what a card has room for. */
const lastSegment = (origin: string): string =>
  origin.split("/").filter(Boolean).at(-1) ?? origin;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** The card a node is drawn as, by the name the app gives it. */
const card = (page: Page, node: string, status: string): Locator =>
  page.getByRole("article", { name: `${node}: ${status}`, exact: true });

/** Whether an element shows its whole text rather than clipping it. */
const shownWhole = (element: Locator): Promise<boolean> =>
  element.evaluate(
    (node: HTMLElement) =>
      node.scrollWidth <= node.clientWidth && node.clientWidth > 0,
  );

test("a held and a draft node show their own words and the releases each awaits on the card", async ({
  page,
}) => {
  const { held, draft, producer } = awaiting();
  const engine = lastSegment(producer);
  await page.goto(`${SERVED_UI_URL}/?run=${runs().awaiting}&view=graph`);

  const heldCard = card(page, held, "complete-but-held");
  const draftCard = card(page, draft, "complete-but-draft");
  await expect(heldCard).toBeVisible();
  await expect(draftCard).toBeVisible();
  await expect(heldCard.locator(".node-status")).toHaveText(
    "complete-but-held",
  );
  await expect(draftCard.locator(".node-status")).toHaveText(
    "complete-but-draft",
  );

  // One short line each: the first release's target and producer, and a count of
  // the rest — shown whole, not clipped by the 200-pixel card.
  const heldLine = heldCard.locator(".node-awaits");
  const draftLine = draftCard.locator(".node-awaits");
  await expect(heldLine).toHaveText(`awaits crate of ${engine}`);
  await expect(draftLine).toHaveText(`awaits crate of ${engine} +1`);
  expect(await shownWhole(heldLine)).toBe(true);
  expect(await shownWhole(draftLine)).toBe(true);

  // Neither is in flight and neither is a word the view does not know.
  for (const word of ["running", "unknown"]) {
    await expect(graphNodes(page, word)).toHaveCount(0);
  }

  // The view's own classification of each: no own work lost (the danger token a
  // failed or cancelled card wears) and no reason line, which the graph gives
  // exactly the nodes it reads as unhealthy — blocked, skipped or lost.
  for (const drawn of [heldCard, draftCard]) {
    await expect(drawn).not.toHaveClass(/token-danger/);
    await expect(drawn.locator(".node-reason")).toHaveCount(0);
  }
  // The keyboard reading of the graph says the same, with no blocker named.
  const list = graphNodeList(page);
  await expect(
    list.getByRole("button", {
      name: `${held}: complete-but-held — awaits crate of ${engine}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", {
      name: `${draft}: complete-but-draft — awaits crate of ${engine} +1`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(list.getByText(/blocked by/)).toHaveCount(0);
});

test("a held node's view names every release it awaits in full above its detail, and raises no alarm", async ({
  page,
}) => {
  const { held, draft, producer, second_producer } = awaiting();

  for (const [node, status, entries] of [
    [held, "complete-but-held", [["crate", producer]]],
    [
      draft,
      "complete-but-draft",
      [
        ["crate", producer],
        ["npm", second_producer],
      ],
    ],
  ] as const) {
    await page.goto(`${SERVED_UI_URL}/?run=${runs().awaiting}&node=${node}`);
    const view = page.getByRole("region", { name: `Timeline for ${node}` });
    await expect(view).toBeVisible();
    await expect(view.locator(".node-view-state")).toHaveText(status);

    const panel = view.getByRole("region", { name: "Awaited releases" });
    await expect(panel).toBeVisible();
    // Every entry, target and full producer origin, in the record's order.
    await expect(panel.getByRole("listitem")).toHaveText(
      entries.map(([target, origin]) => `the ${target} release of ${origin}`),
    );
    // Above the settlement's own sentence.
    const listed = panel.getByRole("list");
    const detail = panel.getByRole("definition").last();
    await expect(detail).toHaveText(/^complete, and held /);
    const listedBox = await listed.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(listedBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    expect((listedBox?.y ?? 0) + (listedBox?.height ?? 0)).toBeLessThanOrEqual(
      detailBox?.y ?? 0,
    );

    // Not unhealthy: nothing went wrong, so opening it announces nothing.
    await expect(view.getByRole("alert")).toHaveCount(0);
  }

  // The draft's sentence names no release, so its entries came off `awaiting`.
  await expect(
    page
      .getByRole("region", { name: "Awaited releases" })
      .getByRole("definition")
      .last(),
  ).not.toContainText("github.com");
});
