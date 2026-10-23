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

/** A measured figure: finite and never negative. */
const figure = z.number().finite().nonnegative();
const seconds = figure.nullable();
const lagStats = z.object({
  records: z.number().int().nonnegative(),
  shown: z.number().int().nonnegative(),
  never_shown: z.number().int().nonnegative(),
  p50_s: seconds,
  p95_s: seconds,
  max_s: seconds,
});
export const lagSchema = lagStats.extend({
  measured_as: z.string().min(1),
  during_burst: lagStats,
  frame_arrival: z.object({ p50_s: seconds, p95_s: seconds, max_s: seconds }),
});
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
  frames_by_type: z.record(
    z.string(),
    z.object({ frames_per_min: figure, bytes_per_min: figure }),
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
});
export type Measured = z.infer<typeof variantSchema>;

export const telemetrySchema = z.object({
  schema_version: z.literal(1),
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
      (variants) => VARIANTS.every(({ name }) => name in variants),
      `every variant is recorded: ${VARIANTS.map(({ name }) => name).join(", ")}`,
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
