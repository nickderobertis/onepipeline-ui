/**
 * The load journey's lag arithmetic, held to records of known timing: what it
 * reports for each record is the time from that record's append to the page
 * rendering it — on a node timeline that record's own row, elsewhere the first
 * time a view root reached its number — and a record the page never rendered
 * is counted as never shown, not as no lag. No browser is opened.
 */

import { expect, test } from "@playwright/test";
import {
  frameArrivals,
  lagStats,
  percentile,
  recordLags,
  renderedAt,
} from "./load/lag";
import { summarizeLags } from "./load/telemetry";

const appended = [
  { seq: 10, at: 1_000, burst: false },
  { seq: 11, at: 2_000, burst: false },
  { seq: 12, at: 3_000, burst: true },
  { seq: 13, at: 3_000, burst: true },
];

test("a view root's rise renders every record at or below it", () => {
  const rendered = {
    rows: {},
    // Rose to 10 at 1.25 s, then to 13 at 3.5 s, covering 11 to 13 at once.
    roots: [
      [10, 1_250],
      [13, 3_500],
    ] as const,
  };
  expect(renderedAt(rendered, false, 11)).toBe(3_500);
  expect(lagStats(appended, rendered, false)).toStrictEqual({
    records: 4,
    shown: 4,
    never_shown: 0,
    p50_s: 0.5,
    p95_s: 1.5,
    max_s: 1.5,
  });
});

test("a node timeline renders a record only when its own row appears", () => {
  const rendered = { rows: { "10": 1_100, "12": 3_200 }, roots: [] };
  // 11 and 13 never had a row: never shown, and never read as quick.
  expect(lagStats(appended, rendered, true)).toStrictEqual({
    records: 4,
    shown: 2,
    never_shown: 2,
    p50_s: 0.1,
    p95_s: 0.2,
    max_s: 0.2,
  });
  expect(lagStats([], rendered, true).p95_s).toBeNull();
});

test("frame arrival is the first frame at or after each append", () => {
  const frames = [{ at: 900 }, { at: 1_040 }, { at: 3_010 }];
  expect(frameArrivals(appended, frames)).toStrictEqual([
    0.04, 1.01, 0.01, 0.01,
  ]);
  expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
});

test("every appended record carries its own lag and frame arrival, in append order", () => {
  const rendered = { rows: {}, roots: [[11, 2_500]] as const };
  const frames = [{ at: 1_040 }, { at: 2_400 }];
  // 12 and 13 never rendered and no frame followed them: each is still an
  // entry of its own, its lag absent rather than zero.
  expect(recordLags(appended, rendered, false, frames)).toStrictEqual([
    { seq: 10, burst: false, lag_s: 1.5, frame_s: 0.04 },
    { seq: 11, burst: false, lag_s: 0.5, frame_s: 0.4 },
    { seq: 12, burst: true, lag_s: null, frame_s: null },
    { seq: 13, burst: true, lag_s: null, frame_s: null },
  ]);
  expect(
    summarizeLags(recordLags(appended, rendered, false, frames)),
  ).toStrictEqual(lagStats(appended, rendered, false));
});
