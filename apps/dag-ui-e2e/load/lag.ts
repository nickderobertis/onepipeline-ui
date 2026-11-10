/**
 * Append-to-render lag, per record, from what the load journey records: each
 * record's append instant from the writer, the instant the page rendered it
 * from the DOM observer, and the instant each frame arrived from the DevTools
 * protocol. Pure, so `load-lag.spec.ts` holds it to records of known timing.
 */

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

/** The `p`th percentile, nearest rank, or `null` for no values. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ] ?? null
  );
}

const seconds = (ms: number) => Math.round(ms) / 1000;

/**
 * When the page showed the record numbered `seq` or what followed it: its own
 * row's appearance on a node timeline, or else the first rise of a view root to
 * it or past it.
 *
 * A node timeline holds the node's latest rows, so a record a burst carried past
 * that window before the page drew it never has a row of its own: what is read
 * for it is the first row after it appearing, the window having moved past it,
 * as a root's rise past a record is read for that record.
 */
export function shownBy(
  rendered: Rendered,
  rowsShown: boolean,
  seq: number,
): number | undefined {
  if (!rowsShown) return rendered.roots.find(([shown]) => shown >= seq)?.[1];
  const own = rendered.rows[String(seq)];
  if (own !== undefined) return own;
  const later = Object.entries(rendered.rows)
    .filter(([shown]) => Number(shown) > seq)
    .map(([, at]) => at);
  return later.length === 0 ? undefined : Math.min(...later);
}

/** Each shown record's lag in seconds, and the summary of them. */
export function lagStats(
  appended: readonly Appended[],
  rendered: Rendered,
  rowsShown: boolean,
) {
  const lags = appended.flatMap(({ seq, at }) => {
    const shown = shownBy(rendered, rowsShown, seq);
    return shown === undefined ? [] : [seconds(shown - at)];
  });
  return {
    records: appended.length,
    shown: lags.length,
    never_shown: appended.length - lags.length,
    p50_s: percentile(lags, 50),
    p95_s: percentile(lags, 95),
    max_s: lags.length === 0 ? null : Math.max(...lags),
  };
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
