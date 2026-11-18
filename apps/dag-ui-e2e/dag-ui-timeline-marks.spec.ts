import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  axisTicks,
  CLOCK,
  crosshairReading,
  instantOfClock,
  intersects,
  lines,
  OFFSET,
  offsetMs,
  readAxis,
  readoutPrecisionMs,
} from "./axis-readings";
import { runs } from "./fixture-facts";
import { appPlot } from "./observatory-locators";

/**
 * Time marked on the run's and a node's visual timeline: axis markers at round
 * steps across the plot, and a crosshair that reads the hovered point's time and
 * the time elapsed since the plot's origin.
 *
 * Every figure is held to the page's own geometry rather than to a number written
 * here: where each marker is drawn says what time it stands for, so the time the
 * crosshair names at a point can be held to the markers either side of it, and
 * the elapsed time it names to the elapsed time the markers name.
 */

/**
 * Hover a timeline's plot and hold what its crosshair reads to its axis: the wall
 * clock to the instants the centred ticks either side stand for, and the elapsed
 * time to the elapsed time those ticks name.
 */
async function crosshairAgrees(page: Page, timeline: Locator): Promise<void> {
  // The first screen's region is replaced when the app takes over, so scrolling to
  // it before then scrolls a removed element: wait for the app's own plot, as the
  // zoom journeys below do.
  await expect(appPlot(timeline)).toBeVisible();
  await timeline.scrollIntoViewIfNeeded();
  const ticks = await readAxis(timeline);
  for (const tick of ticks) {
    expect(tick.clock).toMatch(CLOCK);
    expect(tick.offset).toMatch(OFFSET);
  }
  // Round steps, never crowded: each label clear of the next, and every centred
  // tick at least the requested 80 px from the next.
  for (const [index, tick] of ticks.slice(1).entries()) {
    const before = ticks[index];
    if (before === undefined) continue;
    expect(tick.at).toBeGreaterThan(before.at);
    expect(intersects(before.box, tick.box)).toBe(false);
    expect((tick.at - before.at) % 1_000).toBe(0);
  }
  const centred = ticks.filter((tick) => tick.alignment === "center");
  for (const [index, tick] of centred.slice(1).entries()) {
    const before = centred[index];
    if (before !== undefined)
      expect(tick.x - before.x).toBeGreaterThanOrEqual(79);
  }
  const first = centred[0];
  const last = centred.at(-1);
  if (first === undefined || last === undefined || first === last)
    throw new Error("fewer than two ticks drawn on their instants");
  // Between the outer centred ticks, where each is a known instant.
  const x = (first.x + last.x) / 2;
  const plot = timeline.getByLabel(
    "Timeline plot. Scroll to zoom or drag to select a range.",
  );
  const box = await plot.boundingBox();
  if (box === null) throw new Error("a plot drawn nowhere");
  await page.mouse.move(x, box.y + box.height / 2);
  const reading = await crosshairReading(timeline);
  const label = `${reading.clock} ${reading.offset}`;
  // The time at the point: the ticks either side say where it lies, to within a
  // pixel's worth of time and the step the readout rounds to.
  const perPixel = (last.at - first.at) / (last.x - first.x);
  const precision = readoutPrecisionMs(perPixel);
  const expected = first.at + (x - first.x) * perPixel;
  const at = await instantOfClock(page, reading.clock, expected);
  expect(Math.abs(at - expected), label).toBeLessThanOrEqual(
    2 * perPixel + precision + 1,
  );
  // The elapsed time: the same origin the ticks count from. A tick's elapsed
  // reading is rounded to the step its grid needs, a second or a minute.
  expect(reading.offset).toMatch(OFFSET);
  const step = Math.min(
    ...ticks.slice(1).map((tick, index) => tick.at - (ticks[index]?.at ?? 0)),
  );
  const tickPrecision = step >= 60_000 ? 60_000 : step >= 1_000 ? 1_000 : step;
  expect(
    Math.abs(
      offsetMs(reading.offset) - offsetMs(first.offset) - (at - first.at),
    ),
    `${label} against ${first.offset} at ${first.at}`,
  ).toBeLessThanOrEqual(tickPrecision + precision);
  // Leaving the plot takes it away.
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await expect(timeline.getByLabel("Timeline crosshair")).toHaveCount(0);
}

test("the Overall view marks time on its axis and reads it under the pointer", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().live}&view=overall`);
  const timeline = page.getByRole("region", { name: "Graph timeline" });
  await expect(timeline).toBeVisible();
  await crosshairAgrees(page, timeline);
});

test("a node's timeline marks time on its axis and reads it under the pointer", async ({
  page,
}) => {
  await page.goto(`/?run=${runs().live}&node=dashboard`);
  const timeline = page.getByRole("region", { name: "Node timeline" });
  await expect(timeline).toBeVisible();
  await crosshairAgrees(page, timeline);
});

for (const [where, url, region] of [
  ["Overall", (run: string) => `/?run=${run}&view=overall`, "Graph timeline"],
  ["a node's", (run: string) => `/?run=${run}&node=dashboard`, "Node timeline"],
] as const) {
  test(`${where} timeline keeps a time on screen at the deepest zoom it allows`, async ({
    page,
  }) => {
    await page.goto(url(runs().live));
    const timeline = page.getByRole("region", { name: region });
    // Only the app's plot zooms, and the first screen's region is replaced when the
    // app takes over; scrolling to it before then scrolls a removed element.
    const plot = appPlot(timeline);
    await expect(plot).toBeVisible();
    await timeline.scrollIntoViewIfNeeded();
    // Far past the narrowest window the view allows. The wheel scrolls the page as
    // well as zooming the plot, which can carry the plot out from under the pointer
    // and leave the rest of the wheel scrolling nothing, so each step points at it.
    for (let step = 0; step < 60; step += 1) {
      await plot.hover();
      await page.mouse.wheel(0, -300);
    }
    await expect(
      timeline.getByRole("button", { name: "Reset timeline zoom" }),
    ).toBeEnabled();
    // The wheel scrolls the page as well as zooming the plot; look at it again.
    await timeline.scrollIntoViewIfNeeded();
    const labels = axisTicks(timeline);
    await expect(labels.first()).toBeInViewport();
    const [clock, offset] = await lines(labels.first());
    expect(clock).toMatch(CLOCK);
    expect(offset).toMatch(OFFSET);
  });
}
