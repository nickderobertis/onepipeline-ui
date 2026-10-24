import { expect, type Locator, type Page, test } from "@playwright/test";
import { runs } from "./fixture-facts";

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

/** A marker's label, `HH:MM:SS +<elapsed>`, and what it stands for. */
interface Tick {
  readonly at: number;
  readonly x: number;
  readonly elapsedMs: number;
  readonly unitMs: number;
}

/** `+1.5 s`, `+2.3 min`, `+120 ms` — the elapsed reading — in milliseconds. */
function elapsed(text: string): { ms: number; unitMs: number } {
  const match = /\+(\d+(?:\.\d+)?) (ms|s|min)$/.exec(text.trim());
  if (match === null) throw new Error(`'${text}' names no elapsed time`);
  const [, value = "", unit] = match;
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000;
  // The reading is rounded to a tenth of its unit, or a whole millisecond.
  return { ms: Number(value) * scale, unitMs: unit === "ms" ? 1 : scale / 10 };
}

/** The markers drawn on one timeline's axis, left to right. */
async function ticksOf(timeline: Locator): Promise<Tick[]> {
  const axis = timeline.getByTestId("timeline-axis");
  const marks = axis.locator("[data-tick-time]");
  await expect(marks.nth(1)).toBeVisible();
  const ticks: Tick[] = [];
  for (const mark of await marks.all()) {
    const box = await mark.boundingBox();
    const at = Number(await mark.getAttribute("data-tick-time"));
    const reading = elapsed((await mark.textContent()) ?? "");
    // The last marker is drawn right-aligned on its instant; every other one
    // starts at it.
    const transform = await mark.evaluate((node) => node.style.transform);
    if (box === null) throw new Error("a marker drawn nowhere");
    ticks.push({
      at,
      x: transform.includes("-100%") ? box.x + box.width : box.x,
      elapsedMs: reading.ms,
      unitMs: reading.unitMs,
    });
  }
  return ticks;
}

/** Hover a timeline's plot and hold what its crosshair reads to its markers. */
async function crosshairAgrees(page: Page, timeline: Locator): Promise<void> {
  await timeline.scrollIntoViewIfNeeded();
  const ticks = await ticksOf(timeline);
  expect(ticks.length).toBeGreaterThanOrEqual(2);
  // Round steps, never crowded: each at least the requested 80 px from the next.
  for (const [index, tick] of ticks.slice(1).entries()) {
    const before = ticks[index];
    if (before === undefined) continue;
    expect(tick.at).toBeGreaterThan(before.at);
    expect(tick.x - before.x).toBeGreaterThanOrEqual(79);
    expect((tick.at - before.at) % 1_000).toBe(0);
  }
  const first = ticks[0];
  const last = ticks.at(-1);
  if (first === undefined || last === undefined) throw new Error("no markers");
  // Between the outer markers, where each is a known instant.
  const x = (first.x + last.x) / 2;
  const plot = timeline.getByLabel(
    "Timeline plot. Scroll to zoom or drag to select a range.",
  );
  const box = await plot.boundingBox();
  if (box === null) throw new Error("a plot drawn nowhere");
  await page.mouse.move(x, box.y + box.height / 2);
  const crosshair = timeline.getByLabel("Timeline crosshair");
  await expect(crosshair).toBeVisible();
  const label = ((await crosshair.textContent()) ?? "").trim();
  const [stamp = "", ...rest] = label.split(" ");
  const at = Date.parse(stamp);
  expect(Number.isFinite(at), label).toBe(true);
  // The time at the point: the markers either side say where it lies, to
  // within a pixel's worth of time.
  const perPixel = (last.at - first.at) / (last.x - first.x);
  const expected = first.at + (x - first.x) * perPixel;
  expect(Math.abs(at - expected)).toBeLessThanOrEqual(2 * perPixel + 1);
  // The elapsed time: the same origin the markers count from.
  const reading = elapsed(rest.join(" "));
  const sinceFirst = reading.ms - first.elapsedMs;
  expect(
    Math.abs(sinceFirst - (at - first.at)),
    `${label} against ${first.elapsedMs}ms at ${first.at}`,
  ).toBeLessThanOrEqual(Math.max(reading.unitMs, first.unitMs));
  // Leaving the plot takes it away.
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await expect(crosshair).toHaveCount(0);
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
