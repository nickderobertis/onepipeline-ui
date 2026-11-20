import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { backdrop, computedColour, contrast, over } from "./rendered-colour";

/**
 * The timeline's hover reading follows the pointer across the whole plot, on the
 * two timelines a person reads a run by: a node's, and the run's Overall graph
 * timeline. Over the refusals corpus (`fixtures/runs.mjs`, `buildRefusalsRuns`),
 * whose last node settled before the monitor sent three more refusals naming it,
 * so each plot holds several markers after its last bar.
 *
 * One walk, run on both: over bars, over empty lanes, along the marker row past
 * the last bar, and off the plot. At every position over the plot the reading is
 * shown, names the entry the package resolved — the one it marks
 * `data-timeline-hovered` — and the crosshair is drawn under the pointer; off the
 * plot neither is. So the Overall pass cannot keep the old hover while the node's
 * passes.
 */

const factsSchema = z.object({ run: z.string().min(1) });

let server: FixtureServer | undefined;
let facts: z.infer<typeof factsSchema>;

test.beforeAll(async () => {
  server = await startFixtureServer("timeline-hover", ["--refusals-corpus"]);
  facts = factsSchema.parse(server.facts);
});

test.afterAll(async () => {
  await server?.stop();
  server = undefined;
});

function origin(): string {
  if (server === undefined) throw new Error("the fixture server is not up");
  return server.origin;
}

/** The plot a timeline region draws, which the package names for itself. */
const plotOf = (timeline: Locator): Locator =>
  timeline.getByLabel(/^Timeline plot/u);

/** The crosshair the package draws over a plot. */
const crosshairOf = (plot: Locator): Locator =>
  plot.getByLabel("Timeline crosshair");

const reading = (page: Page): Locator => page.getByTestId("timeline-popover");

interface Point {
  readonly x: number;
  readonly y: number;
  readonly where: string;
}

/**
 * Where the walk goes over `plot`: the middle of each bar, the lanes beside the
 * bars where nothing is drawn, and along the marker row past the last bar — on
 * each marker there and between them.
 */
async function walkOver(plot: Locator): Promise<readonly Point[]> {
  // Taken once the plot has stopped moving: records still arriving re-lay it out.
  let previous = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(
          await plot.evaluate((element) =>
            [...element.querySelectorAll("[data-timeline-entry]")].map(
              (entry) => Math.round(entry.getBoundingClientRect().x),
            ),
          ),
        );
        const settled = now === previous;
        previous = now;
        return settled;
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBe(true);
  const laid = await plot.evaluate((element) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const entries = [...element.querySelectorAll("[data-timeline-entry]")];
    const bars = entries.filter((entry) =>
      entry.hasAttribute("aria-describedby"),
    );
    const markers = entries.filter(
      (entry) => !entry.hasAttribute("aria-describedby"),
    );
    return {
      plot: box(element),
      bars: bars.map(box),
      markers: markers.map(box),
    };
  });
  const lastBar = Math.max(...laid.bars.map((bar) => bar.x + bar.width));
  const after = laid.markers
    .filter((marker) => marker.x > lastBar)
    .sort((left, right) => left.x - right.x);
  expect(laid.bars.length, "the plot draws bars").toBeGreaterThan(0);
  expect(
    after.length,
    "several markers lie after the last bar",
  ).toBeGreaterThanOrEqual(3);
  const points: Point[] = [];
  for (const bar of laid.bars.slice(0, 3))
    points.push({
      x: bar.x + bar.width / 2,
      y: bar.y + bar.height / 2,
      where: "over a bar",
    });
  const lane = laid.bars[0];
  if (lane !== undefined) {
    const right = laid.plot.x + laid.plot.width;
    points.push({
      x: Math.min(right - 6, lastBar + (right - lastBar) / 3),
      y: lane.y + lane.height / 2,
      where: "in a lane past the last bar",
    });
    points.push({
      x: Math.min(right - 6, lastBar + 4),
      y: laid.plot.y + laid.plot.height - 6,
      where: "below the lanes",
    });
  }
  for (const [index, marker] of after.entries()) {
    points.push({
      x: marker.x + marker.width / 2,
      y: marker.y + marker.height / 2,
      where: `on marker ${index + 1} past the last bar`,
    });
    const next = after[index + 1];
    if (next !== undefined)
      points.push({
        x: (marker.x + marker.width + next.x) / 2,
        y: marker.y + marker.height / 2,
        where: `between markers ${index + 1} and ${index + 2}`,
      });
  }
  return points;
}

/** The reading the package's resolved entry carries: its own text, or its glyph's. */
async function resolvedReading(plot: Locator): Promise<string> {
  // llmlint: ignore[e2e_uses_accessible_selectors] `data-timeline-hovered` is the package's documented mark of the entry it resolved the pointer to, and the criterion is about that entry.
  const hovered = plot.locator('[data-timeline-hovered="true"]');
  await expect(hovered).toHaveCount(1);
  return hovered.evaluate((entry) => {
    const described = entry.getAttribute("aria-describedby");
    if (described !== null)
      return document.getElementById(described)?.textContent?.trim() ?? "";
    const hung = entry
      .querySelector("[data-timeline-reading]")
      ?.getAttribute("data-timeline-reading")
      ?.trim();
    // A glyph with no reading hung on it is named by the package itself.
    return (
      hung ?? entry.getAttribute("aria-label")?.replace(/, marker$/u, "") ?? ""
    );
  });
}

/**
 * Walk `timeline`'s plot with the real pointer and hold the reading and the
 * crosshair to it at every point, then leave the plot and hold that both go.
 */
async function walk(page: Page, timeline: Locator): Promise<void> {
  // llmlint: ignore[e2e_uses_accessible_selectors] the app replaces the first screen with no visible jump by design, so nothing a person can perceive says which of the two is drawn; this marker is the one difference, and only waiting for the app to have taken over is read from it.
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);
  const plot = plotOf(timeline);
  await expect(plot).toBeVisible();
  await plot.scrollIntoViewIfNeeded();
  const points = await walkOver(plot);
  let last: number | undefined;
  for (const point of points) {
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await expect(reading(page), `a reading ${point.where}`).toBeVisible();
    const named = await resolvedReading(plot);
    expect(
      named.length,
      `the resolved entry ${point.where} reads`,
    ).toBeGreaterThan(0);
    await expect(
      reading(page),
      `the reading names the resolved entry ${point.where}`,
    ).toHaveText(named);
    const crosshair = crosshairOf(plot);
    await expect(crosshair, `the crosshair ${point.where}`).toBeVisible();
    const line = await crosshair.boundingBox();
    if (line === null) throw new Error("the crosshair is not laid out");
    const centre = line.x + line.width / 2;
    expect(
      Math.abs(centre - point.x),
      `the crosshair is under the pointer ${point.where}`,
    ).toBeLessThanOrEqual(1);
    if (last !== undefined && Math.abs(point.x - last) > 2)
      expect(
        Math.abs(centre - last),
        `the crosshair moved ${point.where}`,
      ).toBeGreaterThan(1);
    last = centre;
    // Visible as the view renders it: the line against the plot behind it.
    const colour = await computedColour(crosshair, "background-color");
    const behind = await backdrop(plot);
    expect(
      contrast(over(colour, behind), behind),
      `the crosshair stands out ${point.where}`,
    ).toBeGreaterThanOrEqual(3);
  }
  // Off the plot: above the timeline, where nothing of it is.
  const box = await timeline.boundingBox();
  if (box === null) throw new Error("the timeline is not laid out");
  await page.mouse.move(box.x + box.width / 2, Math.max(1, box.y - 12), {
    steps: 4,
  });
  await expect(reading(page), "no reading off the plot").toHaveCount(0);
  await expect(crosshairOf(plot), "no crosshair off the plot").toHaveCount(0);
}

test("the reading follows the pointer over a node's whole plot, markers past the last bar included", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin()}/?run=${facts.run}&node=ship&view=graph`);
  const timeline = page.getByRole("region", { name: "Timeline for ship" });
  await expect(timeline).toBeVisible();
  await walk(page, timeline);
});

test("the reading follows the pointer over the run's Overall graph timeline the same way", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin()}/?run=${facts.run}&view=overall`);
  const timeline = page.getByRole("region", {
    name: "Graph timeline",
    exact: true,
  });
  await expect(timeline).toBeVisible();
  // The run's own records, those after its last node settled among them, are
  // read when asked for; they are the markers past the plot's last bar.
  await page
    .getByRole("button", { name: "Load the run's own records" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Run events" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
  await walk(page, timeline);
});

test("the crosshair and its readout keep their contrast in the view's dark theme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin()}/?run=${facts.run}&node=ship&view=graph`);
  expect(
    await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    ),
    "the view renders its dark theme",
  ).toBe(true);
  const timeline = page.getByRole("region", { name: "Timeline for ship" });
  const plot = plotOf(timeline);
  await expect(plot).toBeVisible();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("the plot is not laid out");
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2, {
    steps: 4,
  });
  const crosshair = crosshairOf(plot);
  await expect(crosshair).toBeVisible();
  const behind = await backdrop(plot);
  const line = over(
    await computedColour(crosshair, "background-color"),
    behind,
  );
  expect(
    contrast(line, behind),
    "the crosshair line against the plot",
  ).toBeGreaterThanOrEqual(3);
  // llmlint: ignore[e2e_uses_accessible_selectors] the readout is the crosshair's own label span, which carries no role of its own.
  const readout = crosshair.locator("span").first();
  await expect(readout).toBeVisible();
  const text = await computedColour(readout, "color");
  const under = await backdrop(readout);
  expect(
    contrast(over(text, under), under),
    "the readout against what is behind it",
  ).toBeGreaterThanOrEqual(4.5);
});
