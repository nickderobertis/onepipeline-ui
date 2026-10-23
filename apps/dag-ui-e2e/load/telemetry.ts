/**
 * `telemetry/request-load.json`, declared once: the variants `load.spec.ts`
 * measures, and the document it records — which it parses through this before
 * writing it, and which `request-load-budget.mjs` parses through this before
 * reading a figure off it. Producer and consumer cannot drift apart because
 * there is one declaration for both to fail against.
 */

import { z } from "zod";

export const VIEWS = ["graph", "overall", "node"] as const;
export const KINDS = [
  "nothing-open",
  "settled",
  "stopped",
  "live",
  "host",
] as const;

export interface Variant {
  readonly name: string;
  readonly kind: (typeof KINDS)[number];
  readonly view?: (typeof VIEWS)[number] | "channel";
  readonly tabs: number;
}

/** Every page state measured, and every live view at one tab and at two. */
export const VARIANTS: readonly Variant[] = [
  { name: "nothing-open", kind: "nothing-open", tabs: 1 },
  ...VIEWS.map((view) => ({
    name: `settled-${view}`,
    kind: "settled" as const,
    view,
    tabs: 1,
  })),
  ...VIEWS.map((view) => ({
    name: `stopped-${view}`,
    kind: "stopped" as const,
    view,
    tabs: 1,
  })),
  ...[...VIEWS, "channel" as const].flatMap((view) =>
    [1, 2].map((tabs) => ({
      name: `live-${view}${tabs === 1 ? "" : "-2-tabs"}`,
      kind: "live" as const,
      view,
      tabs,
    })),
  ),
  { name: "host", kind: "host", tabs: 1 },
];

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

/** One appended record's own lag, as `lag.ts` measures it. */
export interface RecordLag {
  readonly seq: number;
  readonly burst: boolean;
  readonly lag_s: number | null;
  readonly frame_s: number | null;
}

/** The counts and percentiles of `records`' lags: what a summary states. */
export function summarizeLags(records: readonly RecordLag[]) {
  const lags = records.flatMap(({ lag_s }) => (lag_s === null ? [] : [lag_s]));
  return {
    records: records.length,
    shown: lags.length,
    never_shown: records.length - lags.length,
    p50_s: percentile(lags, 50),
    p95_s: percentile(lags, 95),
    max_s: lags.length === 0 ? null : Math.max(...lags),
  };
}

/** A measured figure: finite and never negative. */
const figure = z.number().finite().nonnegative();
const seconds = figure.nullable();
/**
 * Percentiles over the records a view showed: present exactly when it showed
 * any, and the counts adding up — never a missing figure read as no lag.
 */
const lagStats = z
  .object({
    records: z.number().int().nonnegative(),
    shown: z.number().int().nonnegative(),
    never_shown: z.number().int().nonnegative(),
    p50_s: seconds,
    p95_s: seconds,
    max_s: seconds,
  })
  .refine(
    (lag) =>
      lag.shown + lag.never_shown === lag.records &&
      [lag.p50_s, lag.p95_s, lag.max_s].every(
        (figure) => (figure === null) === (lag.shown === 0),
      ),
    "a lag's percentiles are present exactly when it showed records",
  );
const recordLag = z.object({
  seq: z.number().int().nonnegative(),
  burst: z.boolean(),
  lag_s: seconds,
  frame_s: seconds,
});
const sameSummary = (
  stated: z.infer<typeof lagStats>,
  records: readonly RecordLag[],
) => JSON.stringify(stated) === JSON.stringify(summarizeLags(records));
/**
 * A live view's lag: one entry per appended record, and the summaries, which
 * are exactly what those entries add up to — a figure no record carries is
 * refused rather than read.
 */
export const lagSchema = z
  .intersection(
    lagStats,
    z.object({
      measured_as: z.string().min(1),
      during_burst: lagStats,
      frame_arrival: z.object({
        p50_s: seconds,
        p95_s: seconds,
        max_s: seconds,
      }),
      per_record: z.array(recordLag),
    }),
  )
  .refine(
    (lag) =>
      new Set(lag.per_record.map(({ seq }) => seq)).size ===
        lag.per_record.length &&
      sameSummary(
        {
          records: lag.records,
          shown: lag.shown,
          never_shown: lag.never_shown,
          p50_s: lag.p50_s,
          p95_s: lag.p95_s,
          max_s: lag.max_s,
        },
        lag.per_record,
      ) &&
      sameSummary(
        lag.during_burst,
        lag.per_record.filter(({ burst }) => burst),
      ),
    "a lag's summaries are what its per-record entries add up to, one per record",
  );
/** The host's load averages and its cores, as `os.loadavg()` reads them. */
const hostLoad = z.object({
  load_1m: figure,
  load_5m: figure,
  load_15m: figure,
  cores: z.number().int().positive(),
});
const framesByType = z.record(
  z.string(),
  z.object({ frames_per_min: figure, bytes_per_min: figure }),
);
const resent = z.object({
  frames: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export const variantSchema = z.object({
  kind: z.enum(KINDS),
  view: z.enum([...VIEWS, "channel"]).optional(),
  tabs: z.number().int().positive(),
  load_s: z.array(figure),
  requests_per_min: figure,
  requests_per_min_by_route: z.record(z.string(), figure),
  mb_per_min: figure,
  bytes_per_min_by_route: z.record(z.string(), figure),
  frames_per_min: figure,
  frames_by_type: framesByType,
  // Each event stream the first tab held in the window, by the view its
  // subscription was for and the order the tab opened it: its frames, the
  // bytes they carried and the bytes the wire took for them.
  frames_by_stream: z.record(
    z.string(),
    z.object({
      view: z.string().min(1),
      frames_per_min: figure,
      bytes_per_min: figure,
      wire_bytes_per_min: figure,
      frames_by_type: framesByType,
    }),
  ),
  repeated_snapshot: z.object({
    in_window: resent,
    at_load: resent,
    after_reconnect: resent,
  }),
  server_cpu: z.object({
    seconds: figure,
    window_s: z.number().positive(),
    cores: figure,
    cores_per_tab: figure,
  }),
  lag: lagSchema.optional(),
  // How busy the host was as the window opened and closed: a wall-clock
  // figure measured on a contended host reads as the host's, not the view's.
  host_load: z.object({ start: hostLoad, end: hostLoad }),
});
export type Measured = z.infer<typeof variantSchema>;

export const telemetrySchema = z.object({
  schema_version: z.literal(3),
  recorded_at: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  dirty: z.boolean(),
  window_s: z.number().positive(),
  workload: z.object({
    runs: z.literal(150),
    projects: z.literal(30),
    other_live_runs: z.literal(10),
    records_per_minute_per_live_run: z.literal(50),
    burst_records: z.literal(400),
    open_live_run_records_at_start: z.literal(116_000),
    fresh_server_and_corpus_per_variant: z.literal(true),
  }),
  // Every variant is recorded: a figure missing from the telemetry is an
  // unrecorded state, never a state that cost nothing.
  variants: z
    .record(z.string(), variantSchema)
    .refine(
      (variants) =>
        VARIANTS.every(({ name, kind, view, tabs }) => {
          const recorded = variants[name];
          return (
            recorded !== undefined &&
            recorded.kind === kind &&
            recorded.view === view &&
            recorded.tabs === tabs
          );
        }),
      `every variant is recorded, as itself: ${VARIANTS.map(({ name }) => name).join(", ")}`,
    )
    .refine(
      (variants) =>
        Object.values(variants)
          .filter((variant) => variant.kind === "live" && variant.tabs === 1)
          .every(
            (variant) =>
              variant.lag !== undefined &&
              variant.lag.records > 0 &&
              variant.lag.never_shown === 0,
          ),
      "every one-tab live variant shows every record it was appended",
    ),
});
export type Telemetry = z.infer<typeof telemetrySchema>;
