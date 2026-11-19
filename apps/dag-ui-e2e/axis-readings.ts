import { expect, type Locator, type Page } from "@playwright/test";

/**
 * What a timeline's axis and its crosshair say, read the way a reader reads them.
 *
 * `@oneharness/ui`'s timeline lists its axis as `Timeline axis`, one item per tick,
 * each a wall-clock time over the time elapsed since the plot's origin; the crosshair
 * under the pointer reads the same two lines. A tick sits centred on its instant
 * unless that would put its label past an end of the axis, where it is held inside
 * the axis instead — so only a centred tick says by its place where its instant is.
 */

/** The ticks of `region`'s timeline axis, left to right. */
export const axisTicks = (region: Locator): Locator =>
  region.getByRole("list", { name: "Timeline axis" }).getByRole("listitem");

/** A wall-clock time: `11:00`, `11:00:30`, `11:00:30.5`. */
export const CLOCK = /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/u;
/** An elapsed time: `+0 s`, `+12.5 s`, `+1 min 30 s`, `+1 h 30 min`. */
export const OFFSET =
  /^[+-]\d+(?:\.\d+)? (?:h|min|s)(?: \d+(?:\.\d+)? (?:min|s))*$/u;

export interface AxisTick {
  /** The instant it stands for, epoch milliseconds. */
  readonly at: number;
  /** Where its label is drawn: on its instant, or held inside an end of the axis. */
  readonly alignment: "center" | "start" | "end";
  /** Its label's middle, in page pixels: its instant's place when centred. */
  readonly x: number;
  readonly box: { x: number; y: number; width: number; height: number };
  readonly clock: string;
  readonly offset: string;
}

/** The two lines a tick or the crosshair reads, in order: its clock and its offset. */
export async function lines(label: Locator): Promise<[string, string]> {
  const read = await label.evaluate((element) =>
    Array.from(
      (element.querySelector(":scope > span:only-child") ?? element).children,
      (line) => line.textContent ?? "",
    ),
  );
  const [clock = "", offset = ""] = read;
  return [clock.trim(), offset.trim()];
}

/** Every tick `region`'s axis draws, read once at least two are drawn. */
export async function readAxis(region: Locator): Promise<AxisTick[]> {
  const ticks = axisTicks(region);
  await expect(ticks.nth(1)).toBeVisible();
  const read: AxisTick[] = [];
  for (const tick of await ticks.all()) {
    const box = await tick.boundingBox();
    if (box === null) throw new Error("a tick drawn nowhere");
    const [clock, offset] = await lines(tick);
    const style = await tick.evaluate((element) => ({
      left: element.style.left,
      right: element.style.right,
      transform: element.style.transform,
    }));
    const alignment = style.transform.includes("-50%")
      ? "center"
      : style.right !== ""
        ? "end"
        : "start";
    read.push({
      at: Number(await tick.getAttribute("data-tick-time")),
      alignment,
      x: box.x + box.width / 2,
      box,
      clock,
      offset,
    });
  }
  return read;
}

/** An elapsed reading, `+1 h 30 min` or `+12.5 s`, in milliseconds. */
export function offsetMs(text: string): number {
  const sign = text.startsWith("-") ? -1 : 1;
  let total = 0;
  for (const [, value = "0", unit] of text.matchAll(
    /(\d+(?:\.\d+)?) (h|min|s)/gu,
  ))
    total +=
      Number(value) *
      (unit === "h" ? 3_600_000 : unit === "min" ? 60_000 : 1_000);
  return sign * total;
}

/**
 * What the crosshair rounds its reading to over a plot drawing `msPerPixel`: the
 * finest of a millisecond, ten, a hundred, a second or a minute one pixel resolves.
 */
export const readoutPrecisionMs = (msPerPixel: number): number =>
  [1, 10, 100, 1_000].find((precision) => precision >= msPerPixel) ?? 60_000;

/** What the crosshair over `region`'s plot reads now. */
export async function crosshairReading(
  region: Locator,
): Promise<{ clock: string; offset: string }> {
  const crosshair = region.getByLabel("Timeline crosshair");
  await expect(crosshair).toBeVisible();
  const [clock, offset] = await lines(crosshair);
  return { clock, offset };
}

/**
 * The instant a wall-clock reading names, in the browser's own time zone: the one
 * of the days around `near` the reading is closest to.
 */
export async function instantOfClock(
  page: Page,
  clock: string,
  near: number,
): Promise<number> {
  expect(clock).toMatch(CLOCK);
  return page.evaluate(
    ({ clock, near }) => {
      const [hours = 0, minutes = 0, seconds = 0] = clock
        .split(":")
        .map(Number);
      const whole = Math.floor(seconds);
      const millis = Math.round((seconds - whole) * 1_000);
      return [-1, 0, 1]
        .map((days) => {
          const date = new Date(near + days * 86_400_000);
          date.setHours(hours, minutes, whole, millis);
          return date.valueOf();
        })
        .reduce((best, candidate) =>
          Math.abs(candidate - near) < Math.abs(best - near) ? candidate : best,
        );
    },
    { clock, near },
  );
}

/** Whether two label boxes overlap by any area. */
export const intersects = (
  left: AxisTick["box"],
  right: AxisTick["box"],
): boolean =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;
