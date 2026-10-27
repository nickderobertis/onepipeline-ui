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

/**
 * Whether every piece of text a card draws lies inside the card's border box: its
 * kind, its name, its status word and any line beneath them.
 */
const textInsideCard = (drawn: Locator): Promise<boolean> =>
  drawn.evaluate((article: HTMLElement) => {
    const border = article.getBoundingClientRect();
    return [...article.querySelectorAll("*")]
      .filter((element) =>
        [...element.childNodes].some(
          (child) =>
            child.nodeType === Node.TEXT_NODE &&
            (child.textContent ?? "").trim() !== "",
        ),
      )
      .every((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        return (
          box.top >= border.top &&
          box.bottom <= border.bottom &&
          box.left >= border.left &&
          box.right <= border.right
        );
      });
  });

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
  await expect(
    heldCard.getByText("complete-but-held", { exact: true }),
  ).toBeVisible();
  await expect(
    draftCard.getByText("complete-but-draft", { exact: true }),
  ).toBeVisible();

  // One short line each: the first release's target and producer, and a count of
  // the rest — shown whole, not clipped by the 200-pixel card.
  const heldLine = heldCard.getByText(`awaits crate of ${engine}`, {
    exact: true,
  });
  const draftLine = draftCard.getByText(`awaits crate of ${engine} +1`, {
    exact: true,
  });
  await expect(heldLine).toBeVisible();
  await expect(draftLine).toBeVisible();
  expect(await shownWhole(heldLine)).toBe(true);
  expect(await shownWhole(draftLine)).toBe(true);
  // Inside the card: the line's box within the card's, and nothing the card
  // writes crossing its border.
  for (const [drawn, line] of [
    [heldCard, heldLine],
    [draftCard, draftLine],
  ] as const) {
    const cardBox = await drawn.boundingBox();
    const lineBox = await line.boundingBox();
    if (cardBox === null || lineBox === null)
      throw new Error("the card or its line is drawn nowhere");
    expect(lineBox.y).toBeGreaterThanOrEqual(cardBox.y);
    expect(lineBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(
      cardBox.y + cardBox.height,
    );
    expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width,
    );
    expect(await textInsideCard(drawn)).toBe(true);
  }

  // Neither is in flight and neither is a word the view does not know.
  for (const word of ["running", "unknown"]) {
    await expect(graphNodes(page, word)).toHaveCount(0);
  }

  // The view's own classification of each: no own work lost (the danger token a
  // failed or cancelled card wears) and no reason line, which the graph gives
  // exactly the nodes it reads as unhealthy — blocked, skipped or lost. Each card
  // says its kind, its name, its word and what it awaits, and nothing else.
  await expect(heldCard).toHaveText(
    `agent${held}complete-but-heldawaits crate of ${engine}`,
  );
  await expect(draftCard).toHaveText(
    `agent${draft}complete-but-draftawaits crate of ${engine} +1`,
  );
  for (const drawn of [heldCard, draftCard]) {
    await expect(drawn).not.toHaveClass(/token-danger/);
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
    await expect(view.getByText(status, { exact: true }).first()).toBeVisible();

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

  // A node awaiting nothing — the one that landed — has no such panel.
  await page.goto(`${SERVED_UI_URL}/?run=${runs().awaiting}&node=engine`);
  const landed = page.getByRole("region", { name: "Timeline for engine" });
  await expect(landed.getByText("done", { exact: true }).first()).toBeVisible();
  await expect(
    landed.getByRole("region", { name: "Awaited releases" }),
  ).toHaveCount(0);

  // The draft's sentence names no release, so its entries came off `awaiting`.
  await page.goto(`${SERVED_UI_URL}/?run=${runs().awaiting}&node=${draft}`);
  await expect(
    page
      .getByRole("region", { name: "Awaited releases" })
      .getByRole("definition")
      .last(),
  ).not.toContainText("github.com");
});
