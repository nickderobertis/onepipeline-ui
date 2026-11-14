/**
 * `telemetry/read-latency.json` and `telemetry/read-latency-large.json`, declared
 * once: the documents `read-latency.spec.ts` parses through this before writing
 * them, and which `read-latency-budget.mjs` parses through this before reading a
 * figure off one. The first holds Action items' figures, which
 * `dag-ui-read-latency:test` records; the second a large run's, which
 * `dag-ui-read-latency:test-large` records. The workload is held here too, so
 * telemetry recorded over anything smaller than what the budgets state is
 * refused rather than read as a pass.
 */

import { z } from "zod";
import large from "./large-run-workload.json" with { type: "json" };
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

/** The three first-useful-screen views a large run opens on. */
export const FIRST_VIEWS = ["graph", "overall", "node"] as const;

/**
 * Every first view the budget is the slowest of: the large run's three, and
 * Overall on the settled run whose own drivers relayed a third of its records at
 * no node (`relayed_overall`), which a host measurement of one run does not read.
 */
export const MEASURED_VIEWS = [...FIRST_VIEWS, "relayed_overall"] as const;

/**
 * Where the server spent a first answer's `POST`, off its own trace
 * (`ONEPIPELINE_UI_LIVE_TRACE`'s `subscribe` line): the engine's heads read and
 * the fetches of what the first screen draws, which a run read whole makes none
 * of, holding and indexing the heads, the detail and timeline the answer holds, the
 * whole answer, and its serialization. `null` where the server did no such step.
 */
const serverSplitSchema = z.object({
  heads_s: seconds,
  fetch_s: seconds,
  fetched_records: count.nullable(),
  records: count.nullable(),
  index_s: seconds,
  detail_s: seconds,
  timeline_s: seconds,
  answer_s: figure,
  serialize_s: figure,
  bytes: count,
});
export type ServerSplit = z.infer<typeof serverSplitSchema>;

/** A wall-clock reading with the bytes and host load beside it. */
const readingSchema = z.object({
  /** Navigation start to the view's mark, or `null` where no mark was reached. */
  seconds: seconds,
  navigation_to_post_s: seconds,
  post_s: seconds,
  answer_to_mark_s: seconds,
  /** Inside the `POST`, as the server traced it. */
  server: serverSplitSchema,
  first_answer_bytes: count,
  first_answer_gzipped: count,
  checked: z.object({
    screen_against_answer: z.boolean(),
    answer_against_complete: z.boolean(),
  }),
  host_load: hostLoad,
});
export type Reading = z.infer<typeof readingSchema>;

/**
 * Every driver the budgets name, measured off the corpus that was read. A missing
 * or undersized driver is a workload the budgets were not stated over, and is
 * refused naming it rather than read as a pass.
 */
export const DRIVERS = {
  records: large.large.records,
  journal_bytes: large.large.journal_bytes,
  streams: large.large.streams,
  checkpoint_bytes: large.large.checkpoint_bytes,
  ordinary_spans: large.large.ordinary_spans,
  harness_spans: large.large.harness_spans,
  busiest_node_records: large.large.busiest_node_records,
  off_graph_node_records: large.large.off_graph_node_records,
  run_directories: large.runs,
  other_live_runs: large.other_live_runs,
  overall_first_answer_bytes: 1_000_000,
  session_references: 1,
  spans_resting_on_dropped_records: 1,
  reasons: 1,
  awaits: 1,
  cross_run_settled_consumers: 1,
  stand_in_provider: 1,
  relayed_records: large.relayed.records,
  relayed_journal_bytes: large.relayed.journal_bytes,
  relayed_run_level_records: large.relayed.run_level_records,
  relayed_session_search_records: large.relayed.session_search_records,
} as const;
export type Driver = keyof typeof DRIVERS;
/** The least fraction of a driver's stated figure a corpus must reach to stand for that workload. */
const DRIVER_TOLERANCE = 0.95;

const corpusSchema = z
  .record(z.string(), figure)
  .superRefine((corpus, context) => {
    for (const [name, floor] of Object.entries(DRIVERS)) {
      const held = corpus[name];
      if (held === undefined || held < floor * DRIVER_TOLERANCE)
        context.addIssue({
          code: "custom",
          path: [name],
          message: `the corpus's ${name} driver is ${held ?? "missing"}, and the budgets state ${floor}`,
        });
    }
  });

const viewSchema = z
  .object({
    readings: z.array(readingSchema).length(3),
    median_s: seconds,
    cold_cache: readingSchema,
    fresh_server: readingSchema,
    small_run_s: seconds,
  })
  .superRefine((view, context) => {
    for (const reading of view.readings) {
      if (reading.seconds === null)
        context.addIssue({
          code: "custom",
          path: ["readings"],
          message: "a reading reached no first-useful-screen mark",
        });
      if (
        !reading.checked.screen_against_answer ||
        !reading.checked.answer_against_complete
      )
        context.addIssue({
          code: "custom",
          path: ["readings"],
          message:
            "a reading's screen did not hold the answer it received, or that answer the complete document",
        });
    }
  });

/**
 * A run's first views: each reached its mark, and held to its answer and the
 * complete document. `relayed_overall` is absent from a host measurement of one run.
 */
export const firstViewSchema = z.object({
  graph: viewSchema,
  overall: viewSchema,
  node: viewSchema,
  relayed_overall: viewSchema.optional(),
  slowest_view: z.enum(MEASURED_VIEWS),
  slowest_s: figure,
});

const largeRunSchema = z.object({
  corpus: corpusSchema,
  // The corpus holds the relayed run, so its Overall is read with the rest.
  first_view: firstViewSchema.extend({ relayed_overall: viewSchema }),
  rest_arrived: z.object({
    overall_s: figure,
    graph_s: seconds,
    node_s: seconds,
    patch_frame_bytes: count,
    server_peak_rss_mb: figure,
    complete: z.literal(true),
  }),
  history_page: z.object({
    node_before_rest_s: figure,
    node_after_rest_s: figure,
    overall_span_page_s: seconds,
    slowest_s: figure,
    rows_shown_after: count,
  }),
  status: z.object({
    small_s: figure,
    large_s: figure,
    slowest_s: figure,
    checkpoint_bytes: count,
    stand_in_starts: count,
  }),
  host_load: z.object({ start: hostLoad, end: hostLoad }),
});
export type LargeRun = z.infer<typeof largeRunSchema>;

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

/** `telemetry/read-latency-large.json`: one large run's first screens and the rest. */
export const largeTelemetrySchema = z.object({
  /**
   * 2 since each reading carries the server's split of its `POST`; 3 since the
   * first views hold `relayed_overall` and the corpus its drivers.
   */
  schema_version: z.literal(3),
  recorded_at: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  dirty: z.boolean(),
  large_run: largeRunSchema,
});
export type LargeTelemetry = z.infer<typeof largeTelemetrySchema>;
