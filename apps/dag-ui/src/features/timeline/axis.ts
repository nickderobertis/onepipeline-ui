/**
 * How every visual timeline in this view marks time: an axis marker at round
 * second, minute or hour steps no closer than this many pixels apart, adapting to
 * the plot's width and zoom, and a crosshair that reads the hovered point's time
 * and the time elapsed since the plot's origin.
 *
 * One declaration for the run's and a node's timelines, so a reader measuring a
 * gap on one reads it the same way on the other. The marking itself is the
 * design system's `Timeline`; this says only that it is on, and how dense.
 */
export const TIMELINE_TIME_MARKS = {
  crosshair: true,
  ticks: { minSpacingPx: 80 },
} as const;

/**
 * The narrowest window a reader may zoom a timeline to, in milliseconds.
 *
 * The axis marks round steps no finer than a second, so a window narrower than
 * one holds no marker at all and the reader is left with no time on screen. Two
 * seconds always holds at least one whole second, so the clock stays readable
 * at every zoom this view allows.
 */
export const MIN_ZOOM_MS = 2_000;

/**
 * `next`, widened about its middle to at least {@link MIN_ZOOM_MS}, so a zoom the
 * reader asks for never leaves the axis without a labelled time.
 */
export function boundedZoom(
  next: readonly [number, number],
): readonly [number, number] {
  const [start, end] = next;
  if (end - start >= MIN_ZOOM_MS) return next;
  const middle = (start + end) / 2;
  return [middle - MIN_ZOOM_MS / 2, middle + MIN_ZOOM_MS / 2];
}
