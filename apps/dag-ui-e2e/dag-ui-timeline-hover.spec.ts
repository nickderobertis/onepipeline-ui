import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { type FixtureServer, startFixtureServer } from "./fixture-server";
import { backdrop, computedColour, contrast, over } from "./rendered-colour";

/**
 * The timeline's hover reading follows the pointer across the whole plot, on the
 * two timelines a person reads a run by: a node's, and the run's Overall graph
 * timeline. Over the refusals corpus (`fixtures/runs.mjs`, `buildRefusalsRuns`),
 * whose last node settled before the monitor sent three more refusals naming it,
 * so each plot holds several markers after its last bar of work — on Overall, over
 * the recorded silence it draws to the run's settlement.
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
  /** The marker the pointer is on, which the package must resolve it to. */
  readonly marker?: Marker;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Bar extends Box {
  /** A stretch the run recorded nothing in, which Overall draws as `Idle · …`. */
  readonly silence: boolean;
}

interface Marker extends Box {
  /** The marker's accessible name, which says what it marks. */
  readonly label: string;
}

interface Laid {
  readonly plot: Box;
  readonly bars: readonly Bar[];
  readonly markers: readonly Marker[];
}

/**
 * The right edge of the plot's last bar of work. Overall's plot ends at the run's
 * settlement and draws every stretch of it no work covers as an `Idle` span, the
 * last one reaching the plot's end, so a bar lies under every instant there; the
 * markers a person reads past the run's work lie past its last work bar, over that
 * recorded silence. With no work drawn at all, that is the plot's own left edge.
 */
const lastBarOf = (laid: Laid): number =>
  Math.max(
    laid.plot.x,
    ...laid.bars.filter((bar) => !bar.silence).map((bar) => bar.x + bar.width),
  );

/** The markers drawn past the plot's last bar, left to right. */
const markersAfter = (laid: Laid): readonly Marker[] =>
  laid.markers
    .filter((marker) => marker.x > lastBarOf(laid))
    .sort((left, right) => left.x - right.x);

/**
 * The plot as drawn once it has stopped moving — records still arriving re-lay it
 * out — and holds at least `markers` past its last bar. A layout is settled when
 * two readings half a second apart agree, and one with fewer markers past the last
 * bar is waited past rather than taken, because the run's own records, which are
 * those markers, can arrive after the bars have stopped moving.
 */
// llmlint: ignore-block[e2e_uses_accessible_selectors] where the walk goes is read off the geometry of every bar and glyph the package draws, which it marks `data-timeline-entry` and which no role query lists apart from the plot's other buttons; nothing here is clicked or asserted by selector.
async function settledLayout(plot: Locator, markers: number): Promise<Laid> {
  let previous = "";
  let laid: Laid | undefined;
  await expect
    .poll(
      async () => {
        const now = await plot.evaluate((element): Laid => {
          const box = (node: Element): Box => {
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
          };
          const entries = [
            ...element.querySelectorAll("[data-timeline-entry]"),
          ];
          return {
            plot: box(element),
            bars: entries
              .filter((entry) => entry.hasAttribute("aria-describedby"))
              .map((entry) => ({
                ...box(entry),
                silence: /^Idle · /u.test(
                  entry.getAttribute("aria-label") ?? "",
                ),
              })),
            markers: entries
              .filter((entry) => !entry.hasAttribute("aria-describedby"))
              .map((entry) => ({
                ...box(entry),
                label: entry.getAttribute("aria-label") ?? "",
              })),
          };
        });
        const reading = JSON.stringify(
          [now.plot, ...now.bars, ...now.markers].map((entry) =>
            Math.round(entry.x),
          ),
        );
        const settled = reading === previous;
        previous = reading;
        laid = now;
        if (!settled || now.bars.length === 0) return -1;
        return markersAfter(now).length;
      },
      {
        message: `the plot settles with bars and ${markers} markers past its last bar`,
        intervals: [500],
        timeout: 30_000,
      },
    )
    .toBeGreaterThanOrEqual(markers);
  if (laid === undefined) throw new Error("the plot was never read");
  return laid;
}
// llmlint: ignore-end[e2e_uses_accessible_selectors]

/**
 * Where the walk goes over `plot`: the middle of each bar, the lanes beside the
 * bars where nothing is drawn, and along the marker row past the last bar — on
 * each marker there and between them.
 */
async function walkOver(plot: Locator): Promise<{
  readonly laid: Laid;
  readonly points: readonly Point[];
}> {
  const laid = await settledLayout(plot, 3);
  const lastBar = lastBarOf(laid);
  const after = markersAfter(laid);
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
  const lane = laid.bars.find((bar) => !bar.silence) ?? laid.bars[0];
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
      where: `on marker ${index + 1} past the last bar (${marker.label})`,
      marker,
    });
    const next = after[index + 1];
    if (next !== undefined)
      points.push({
        x: (marker.x + marker.width + next.x) / 2,
        y: marker.y + marker.height / 2,
        where: `between markers ${index + 1} and ${index + 2}`,
      });
  }
  return { laid, points };
}

/** Whether a recorded-silence span is drawn under `marker`'s x. */
const underSilence = (laid: Laid, marker: Marker): boolean =>
  laid.bars.some(
    (bar) =>
      bar.silence &&
      bar.x <= marker.x + marker.width / 2 &&
      marker.x + marker.width / 2 <= bar.x + bar.width,
  );

/** The reading the package's resolved entry carries: its own text, or its glyph's. */
async function resolvedReading(plot: Locator): Promise<string> {
  // llmlint: ignore[e2e_uses_accessible_selectors] `data-timeline-hovered` is the package's documented mark of the entry it resolved the pointer to, and the criterion is about that entry.
  const hovered = plot.locator('[data-timeline-hovered="true"]');
  await expect(hovered).toHaveCount(1);
  return hovered.evaluate((entry) => {
    const described = entry.getAttribute("aria-describedby");
    if (described !== null)
      return document.getElementById(described)?.textContent?.trim() ?? "";
    // llmlint: ignore[e2e_uses_accessible_selectors] the reading a glyph carries is hung on it as this attribute, which is the text the layer shows; it is read, not selected.
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
async function walk(
  page: Page,
  timeline: Locator,
  options: {
    /**
     * Hold that some run-level marker past the run's work lies under the recorded
     * silence Overall draws to its settlement, so that pointing at it — the
     * reported bug — is walked and resolved to the marker, never the span.
     */
    readonly runMarkerUnderSilence?: boolean;
  } = {},
): Promise<void> {
  // llmlint: ignore[e2e_uses_accessible_selectors] the app replaces the first screen with no visible jump by design, so nothing a person can perceive says which of the two is drawn; this marker is the one difference, and only waiting for the app to have taken over is read from it.
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);
  const plot = plotOf(timeline);
  await expect(plot).toBeVisible();
  await plot.scrollIntoViewIfNeeded();
  const { laid, points } = await walkOver(plot);
  if (options.runMarkerUnderSilence === true)
    expect(
      points.filter(
        ({ marker }) =>
          marker?.label.startsWith("Run-level · ") === true &&
          underSilence(laid, marker),
      ).length,
      "a run-level marker under the Idle span is walked",
    ).toBeGreaterThan(0);
  let last: number | undefined;
  for (const point of points) {
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await expect(reading(page), `a reading ${point.where}`).toBeVisible();
    if (point.marker !== undefined) {
      // The nearest event, not a span drawn under it: the entry the package marks
      // hovered is the marker itself, where the marker is drawn.
      // llmlint: ignore[e2e_uses_accessible_selectors] `data-timeline-hovered` is the package's documented mark of the entry it resolved the pointer to; several markers share one accessible name, so the entry is told apart by where it is drawn.
      const hovered = plot.locator('[data-timeline-hovered="true"]');
      await expect(hovered, `one entry resolved ${point.where}`).toHaveCount(1);
      await expect(
        hovered,
        `the marker itself is resolved ${point.where}`,
      ).toHaveAttribute("aria-label", point.marker.label);
      const resolved = await hovered.boundingBox();
      if (resolved === null)
        throw new Error("the resolved entry is not laid out");
      expect(
        Math.abs(resolved.x - point.marker.x),
        `the resolved marker is the one under the pointer ${point.where}`,
      ).toBeLessThanOrEqual(1);
    }
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
  await walk(page, timeline, { runMarkerUnderSilence: true });
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
  // llmlint: ignore[e2e_uses_accessible_selectors] the app replaces the first screen with no visible jump by design, so nothing a person can perceive says which of the two is drawn; this marker is the one difference, and only waiting for the app to have taken over is read from it.
  await expect(page.locator("[data-first-screen]")).toHaveCount(0);
  const timeline = page.getByRole("region", { name: "Timeline for ship" });
  const plot = plotOf(timeline);
  await expect(plot).toBeVisible();
  await plot.scrollIntoViewIfNeeded();
  // Over the plot as it finally lies, not where it was before its records arrived.
  const { plot: box } = await settledLayout(plot, 0);
  const crosshair = crosshairOf(plot);
  await expect(async () => {
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2, {
      steps: 4,
    });
    await expect(crosshair).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
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
