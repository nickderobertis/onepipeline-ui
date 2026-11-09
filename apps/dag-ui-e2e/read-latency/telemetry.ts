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
    const { lag } = page;
    if (
      lag.writes !== workload.writes ||
      lag.never_shown !== 0 ||
      lag.shown !== lag.writes ||
      [lag.p50_s, lag.p95_s, lag.max_s].includes(null)
    )
      refuse("a page renders every write in its window, and times each");
    const routed = Object.values(page.requests_by_route);
    if (routed.reduce((sum, held) => sum + held, 0) !== page.requests)
      refuse("a page's requests are the ones it counts by route");
    const perMinute = (page.requests / page.window_s) * 60;
    if (Math.abs(page.requests_per_min - perMinute) > 1e-6)
      refuse("a page's request rate is its requests over its window");
  });

/** A tab open on Action items while the page batch-answered: when its list emptied. */
const batchTab = z.object({
  /** Seconds from the send bar's press to the last of the batch leaving this list. */
  lag_s: figure,
  left_at_ms: figure,
  /** Requests this tab sent during the phase. */
  requests: count,
  /** How many of the batch's titles this tab still lists when the phase ends. */
  still_listed: count,
});

/**
 * One batch of answers sent with one press of the send bar, watched from the tab
 * that sent it (filtered) and one that only reads (unfiltered).
 */
const batchSchema = z
  .object({
    questions: z.literal(workload.batch_questions),
    with_choices: z.literal(workload.batch_with_choices),
    choices_each: z.literal(workload.batch_choices_each),
    requests: z.literal(1),
    answers_in_request: z.literal(workload.batch_questions),
    answered: z.literal(workload.batch_questions),
    pressed_at_ms: figure,
    committed_at_ms: figure,
    response_s: figure,
    tabs: z.object({ unfiltered: batchTab, filtered: batchTab }),
    host_load: z.object({ start: hostLoad, end: hostLoad }),
  })
  .superRefine((batch, context) => {
    const refuse = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (batch.committed_at_ms < batch.pressed_at_ms)
      refuse("a batch commits after its press");
    for (const name of PAGES) {
      const tab = batch.tabs[name];
      if (tab.still_listed !== 0)
        refuse(`every question of the batch leaves the ${name} tab's list`);
      if (Math.abs(tab.left_at_ms - batch.pressed_at_ms - tab.lag_s * 1000) > 5)
        refuse(`the ${name} tab's lag is from the press to its list emptying`);
    }
    if (batch.tabs.unfiltered.requests !== 0)
      refuse("the tab that sends nothing sends nothing");
  });

/** What each page's filter selects: the page's whole point. */
const selecting = (selected: (filter: Record<string, unknown>) => boolean) =>
  pageSchema.refine(({ filter }) => selected(filter), {
    message: "a page measures the filter it is named for",
  });

export const telemetrySchema = z.object({
  schema_version: z.literal(2),
  recorded_at: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  dirty: z.boolean(),
  workload: z.object({
    runs: z.literal(workload.runs),
    write_spacing_s: z.literal(workload.write_spacing_s),
  }),
  human_items: z.object({
    unfiltered: selecting((filter) => Object.keys(filter).length === 0),
    filtered: selecting((filter) => Object.keys(filter).length > 0),
  }),
  batch: batchSchema,
});
export type Telemetry = z.infer<typeof telemetrySchema>;
