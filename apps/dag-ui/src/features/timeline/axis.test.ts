import { describe, expect, test } from "vitest";
import { boundedZoom, MIN_ZOOM_MS } from "./axis";

describe("boundedZoom", () => {
  test("keeps a window wide enough to hold a labelled second", () => {
    expect(boundedZoom([10_000, 15_000])).toEqual([10_000, 15_000]);
    expect(boundedZoom([10_000, 10_000 + MIN_ZOOM_MS])).toEqual([
      10_000,
      10_000 + MIN_ZOOM_MS,
    ]);
  });

  test("widens a narrower one about its middle to the bound", () => {
    const [start, end] = boundedZoom([10_400, 10_600]);
    expect(end - start).toBe(MIN_ZOOM_MS);
    expect((start + end) / 2).toBe(10_500);
    // A whole second always falls inside it, which is where the axis marks.
    expect(Math.ceil(start / 1_000) * 1_000).toBeLessThanOrEqual(end);
  });
});
