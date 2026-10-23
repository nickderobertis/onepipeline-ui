/**
 * Append-to-render lag, per record, from what the load journey records: each
 * record's append instant from the writer, the instant the page rendered it
 * from the DOM observer, and the instant each frame arrived from the DevTools
 * protocol. Pure, so `load-lag.spec.ts` holds it to records of known timing.
 */

import { percentile, type RecordLag, summarizeLags } from "./telemetry";

export { percentile };

/** One record the writer appended to the open run. */
export interface Appended {
  readonly seq: number;
  readonly at: number;
  readonly burst: boolean;
}

/** What the page shows of the records: a row per record, or a root's rise. */
export interface Rendered {
  /** When each record's own row first appeared, by its sequence number. */
  readonly rows: Readonly<Record<string, number>>;
  /** Each rise of a view root's sequence number, with when it rose. */
  readonly roots: readonly (readonly [number, number])[];
}

const seconds = (ms: number) => Math.round(ms) / 1000;

/**
 * When the page rendered the record numbered `seq`: its row's appearance on a
 * node timeline, or else the first rise of a view root to it or past it.
 */
export function renderedAt(
  rendered: Rendered,
  rowsShown: boolean,
  seq: number,
): number | undefined {
  return rowsShown
    ? rendered.rows[String(seq)]
    : rendered.roots.find(([shown]) => shown >= seq)?.[1];
}

/**
 * Every appended record's own lag, in append order: its sequence number,
 * whether the burst wrote it, the seconds from its append to the page
 * rendering it (`null` when it never did), and the seconds until the first
 * frame reached the page after it (`null` when none did).
 */
export function recordLags(
  appended: readonly Appended[],
  rendered: Rendered,
  rowsShown: boolean,
  frames: readonly { readonly at: number }[] = [],
): RecordLag[] {
  return appended.map(({ seq, at, burst }) => {
    const shown = renderedAt(rendered, rowsShown, seq);
    const arrived = frames.find((frame) => frame.at >= at)?.at;
    return {
      seq,
      burst,
      lag_s: shown === undefined ? null : seconds(shown - at),
      frame_s: arrived === undefined ? null : seconds(arrived - at),
    };
  });
}

/** Each shown record's lag in seconds, and the summary of them. */
export function lagStats(
  appended: readonly Appended[],
  rendered: Rendered,
  rowsShown: boolean,
) {
  return summarizeLags(recordLags(appended, rendered, rowsShown));
}

/** For each record, how long until the first frame arrived after its append. */
export function frameArrivals(
  appended: readonly Appended[],
  frames: readonly { readonly at: number }[],
): number[] {
  return appended.flatMap(({ at }) => {
    const first = frames.find((frame) => frame.at >= at);
    return first === undefined ? [] : [seconds(first.at - at)];
  });
}
