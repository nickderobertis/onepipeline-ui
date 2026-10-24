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
