import type { Locator, Page } from "@playwright/test";

/**
 * The two readings these journeys reach for most, by the name a reader has for them
 * rather than by the class the stylesheet paints them with.
 *
 * A graph card and a metric tile are both a heading and a value with nothing tying
 * the two together, so each carries an accessible name the app puts there on purpose
 * — `"<node>: <state>"` for a card, the metric's own label for a tile. These helpers
 * are the one place that knows the shape of those names, so a journey asks for a node
 * in a state, not for a selector that a rename of the stylesheet would break.
 */

/** A regular-expression-safe rendering of `text`. */
const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every graph card currently drawn, or every one of them in `state`.
 *
 * Matched on the tail of the card's name so the node it belongs to is left open:
 * `graphNodes(page, "running")` is "whatever is running", which is what a journey
 * about a state is asking. The `: ` keeps it off any other article on the page — a
 * transcript turn names itself "Turn 3", with no colon in it.
 */
export const graphNodes = (page: Page, state?: string): Locator =>
  page.getByRole("article", {
    name: new RegExp(`: ${state === undefined ? "[a-z-]+" : literal(state)}$`),
  });

/**
 * The accessible rendering of the whole graph: one list item per node, and the only
 * reading of it that exists without the canvas.
 *
 * A journey asserting that no graph is drawn asserts on this rather than counting
 * cards — the list is built from the same nodes and it says the thing being claimed,
 * that there is no graph here to read.
 */
export const graphNodeList = (page: Page): Locator =>
  page.getByRole("list", { name: "DAG nodes" });

/** One metric tile of the overall view, by the label it shows. */
export const metric = (page: Page, label: string): Locator =>
  page.getByRole("group", { name: label, exact: true });

/** Every metric tile of the overall view, in the order they are laid out. */
export const metrics = (page: Page): Locator =>
  page.getByRole("region", { name: "Run metrics" }).getByRole("group");

/**
 * The app's own timeline plot inside `region`, named for what it does.
 *
 * A run's address is first drawn by the first screen, whose plot is named
 * `Timeline plot <view>` and does nothing, and the app then replaces that screen,
 * every element of it, when its chunk arrives. A journey that finds a region or a
 * transcript before then acts on an element about to be removed, which a loaded host
 * makes likely: a focus lost with the screen, or a scroll on a node no longer
 * attached (CI run 43007707623). Waiting for this name to be visible is waiting for
 * the app, because only the app draws a plot a reader can zoom. Waiting for the first
 * screen's plot to be gone is not: it is also gone before the first screen is drawn.
 */
export const appPlot = (region: Locator): Locator =>
  region.getByLabel("Timeline plot. Scroll to zoom or drag to select a range.");

/**
 * One named lane of an opened timeline row.
 *
 * A closed row is a single unnamed strip; opening it draws one lane per category and
 * names each for a reader who cannot see the plot, which makes the name the signal
 * that the lanes have arrived. Asked for inside the plot rather than anywhere in the
 * row, because the legend beside it lists the same categories whether the row is open
 * or shut — and that legend is what a journey waiting on "Worker" would settle for.
 */
export const timelineLane = (row: Locator, label: string): Locator =>
  appPlot(row).getByText(label, { exact: true });

/**
 * Open every collapsed project of the navigation, so a journey about runs can reach
 * each of their rows: only the selected run's project starts open.
 */
export async function expandProjects(page: Page): Promise<void> {
  const toggles = page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("button", { name: /^Expand / });
  await page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("group", { name: /^Project / })
    .first()
    .waitFor();
  while ((await toggles.count()) > 0) await toggles.first().click();
}

/**
 * Have the navigation take rows as they arrive, as a person chooses it, for a
 * journey about what a frame does to a row rather than about holding it.
 */
export async function navigationTakesRowsLive(page: Page): Promise<void> {
  await page
    .getByRole("combobox", { name: "Navigation updates" })
    .selectOption({ label: "Live" });
}

/**
 * Read a node's whole transcript back through the page's own control. Its first
 * answer holds each span's latest rows, so what comes before them is asked for;
 * a page that fails on the way fails here, naming what failed.
 */
export async function loadAllEarlierRows(page: Page): Promise<void> {
  const more = page.getByRole("button", { name: /^Load(ing)? earlier rows/ });
  // A short window: a transcript short enough to hold whole offers no control.
  await more
    .first()
    .waitFor({ state: "attached", timeout: 3_000 })
    .catch(() => undefined);
  while ((await more.count()) > 0) {
    await more
      .first()
      .click({ timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(50);
  }
  // A failed page replaces the control with its error, which ends the loop above
  // with rows still missing: that is a failure, not the transcript's start.
  const failed = page.getByRole("alert").filter({
    hasText: "Earlier rows did not load",
  });
  if ((await failed.count()) > 0)
    throw new Error(
      `the transcript stopped short: ${await failed.first().innerText()}`,
    );
}

/**
 * Open Overall's run-level records through the page's own control. Overall's spans
 * list no rows of their own (schema 28), so the records after execution, and the
 * run's other records, arrive when a person asks for them.
 */
export async function loadRunRecords(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Load the run's own records" })
    .click();
}
