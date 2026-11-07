/**
 * `telemetry/read-latency.json`, declared once: the document
 * `read-latency.spec.ts` parses through this before writing it, and which
 * `read-latency-budget.mjs` parses through this before reading a figure off it.
 * The workload is held here too, so telemetry recorded over anything smaller than
 * what the budgets state is refused rather than read as a pass.
 */

import { z } from "zod";
import workload from "./workload.json" with { type: "json" };

/** Each page the human-item budgets are the slowest of, as the page sets it. */
export const PAGES = ["unfiltered", "filtered"] as const;

/** A measured figure: finite and never negative. */
const figure = z.number().finite().nonnegative();
const seconds = figure.nullable();
const count = z.number().int().nonnegative();

/** How busy the host was: a wall-clock figure on a busy host reads as the host's. */
const hostLoad = z.object({
  load_1m: figure,
  load_5m: figure,
  load_15m: figure,
  cores: z.number().int().positive(),
});

const pageSchema = z
  .object({
    filter: z.record(z.string(), z.unknown()),
    window_s: z.number().positive(),
    writes_by_kind: z.object({
      raise: count,
      answer: count,
      complete: count,
      dismiss: count,
    }),
    journal_at_start: z.object({ events: count, bytes: count }),
    requests: count,
    requests_per_min: figure,
    requests_by_route: z.record(z.string(), count),
    connections_opened: count,
    lag: z.object({
      writes: count,
      shown: count,
      never_shown: count,
      p50_s: seconds,
      p95_s: seconds,
      max_s: seconds,
      frame_arrival: z.object({
        p50_s: seconds,
        p95_s: seconds,
        max_s: seconds,
      }),
    }),
    host_load: z.object({ start: hostLoad, end: hostLoad }),
  })
  .superRefine((page, context) => {
    const refuse = (message: string) =>
      context.addIssue({ code: "custom", message });
    const { raise, answer, complete, dismiss } = page.writes_by_kind;
    if (raise + answer + complete + dismiss !== workload.writes)
      refuse(`a page's window holds ${workload.writes} writes`);
    if ([raise, answer, complete, dismiss].includes(0))
      refuse("a page's window raises, answers, completes and dismisses");
    if (page.journal_at_start.events !== workload.human_item_events_at_start)
      refuse(
        `a page starts on ${workload.human_item_events_at_start} journal events`,
      );
    const bytes = workload.human_item_bytes_at_start;
    if (Math.abs(page.journal_at_start.bytes - bytes) > bytes * 0.05)
      refuse(`a page starts on a journal of about ${bytes} bytes`);
    if (page.lag.writes !== workload.writes || page.lag.never_shown !== 0)
      refuse("a page renders every write in its window");
  });

export const telemetrySchema = z.object({
  schema_version: z.literal(1),
  recorded_at: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  dirty: z.boolean(),
  workload: z.object({
    runs: z.literal(workload.runs),
    write_spacing_s: z.literal(workload.write_spacing_s),
  }),
  human_items: z.object({
    unfiltered: pageSchema,
    filtered: pageSchema,
  }),
});
export type Telemetry = z.infer<typeof telemetrySchema>;
