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
 * One named lane of an opened timeline row.
 *
 * A closed row is a single unnamed strip; opening it draws one lane per category and
 * names each for a reader who cannot see the plot, which makes the name the signal
 * that the lanes have arrived. Asked for inside the plot rather than anywhere in the
 * row, because the legend beside it lists the same categories whether the row is open
 * or shut — and that legend is what a journey waiting on "Worker" would settle for.
 */
export const timelineLane = (row: Locator, label: string): Locator =>
  row
    .getByLabel("Timeline plot. Scroll to zoom or drag to select a range.")
    .getByText(label, { exact: true });
