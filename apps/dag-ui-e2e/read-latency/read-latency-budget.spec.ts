import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { DRIVERS, largeTelemetrySchema, telemetrySchema } from "./telemetry";
import workload from "./workload.json" with { type: "json" };

/**
 * The runner as `budgets.yaml` runs it, against telemetry of known figures: it
 * reports what was recorded, and refuses to read a figure off telemetry that is
 * missing or that was not recorded over the stated workload.
 */

const RUNNER = join(import.meta.dirname, "read-latency-budget.mjs");
const CHECK = join(
  import.meta.dirname,
  "../../../node_modules/.bin/onebudgetspec",
);

const resultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      verdict: z.string(),
      actual: z.number().nullable().optional(),
      detail: z.string().nullable().optional(),
    }),
  ),
});

const page = (requests: number, p95: number) => ({
  filter: {},
  window_s: 120,
  writes_by_kind: { raise: 20, answer: 7, complete: 7, dismiss: 6 },
  journal_at_start: {
    events: workload.human_item_events_at_start,
    bytes: workload.human_item_bytes_at_start,
  },
  requests,
  requests_per_min: requests / 2,
  requests_by_route: requests === 0 ? {} : { "GET /api/human-items": requests },
  connections_opened: 0,
  lag: {
    writes: workload.writes,
    shown: workload.writes,
    never_shown: 0,
    p50_s: 0.4,
    p95_s: p95,
    max_s: p95 + 0.1,
    frame_arrival: { p50_s: 0.3, p95_s: 0.6, max_s: 0.7 },
  },
  host_load: {
    start: { load_1m: 1, load_5m: 1, load_15m: 1, cores: 8 },
    end: { load_1m: 1, load_5m: 1, load_15m: 1, cores: 8 },
  },
});

const FILTERED = { priority: "high" };

const load = { load_1m: 1, load_5m: 1, load_15m: 1, cores: 8 };
const reading = (seconds: number | null) => ({
  seconds,
  navigation_to_post_s: 0.05,
  post_s: 0.5,
  answer_to_mark_s: 0.05,
  server: {
    heads_s: 0.2,
    fetch_s: 0.05,
    fetched_records: 30_000,
    records: 116_000,
    index_s: 0.05,
    detail_s: 0.01,
    timeline_s: 0.1,
    answer_s: 0.4,
    serialize_s: 0.02,
    bytes: 1_200_000,
  },
  first_answer_bytes: 1_200_000,
  first_answer_gzipped: 130_000,
  checked: { screen_against_answer: true, answer_against_complete: true },
  host_load: load,
});
const view = (seconds: number) => ({
  readings: [reading(seconds), reading(seconds), reading(seconds)],
  median_s: seconds,
  cold_cache: reading(seconds + 0.1),
  fresh_server: reading(seconds),
  small_run_s: 0.1,
});
const largeRun = (overrides: object = {}) => ({
  corpus: { ...DRIVERS },
  first_view: {
    graph: view(0.4),
    overall: view(0.7),
    node: view(0.6),
    relayed_overall: view(0.5),
    slowest_view: "overall",
    slowest_s: 0.7,
  },
  rest_arrived: {
    overall_s: 40,
    graph_s: 35,
    node_s: 42,
    patch_frame_bytes: 900,
    server_peak_rss_mb: 2_000,
    complete: true,
  },
  history_page: {
    node_before_rest_s: 0.6,
    node_after_rest_s: 0.2,
    overall_span_page_s: 0.3,
    slowest_s: 0.6,
    rows_shown_after: 180,
  },
  status: {
    small_s: 0.05,
    large_s: 0.4,
    slowest_s: 0.4,
    checkpoint_bytes: DRIVERS.checkpoint_bytes,
    stand_in_starts: 0,
  },
  host_load: { start: load, end: load },
  ...overrides,
});
/** A batch phase whose slowest tab took `slowest` seconds. */
const batch = (slowest = 1) => {
  const pressed_at_ms = 1_000_000;
  const tab = (lag_s: number) => ({
    lag_s,
    left_at_ms: pressed_at_ms + lag_s * 1000,
    requests: 0,
    still_listed: 0,
  });
  return {
    questions: workload.batch_questions,
    with_choices: workload.batch_with_choices,
    choices_each: workload.batch_choices_each,
    requests: 1,
    answers_in_request: workload.batch_questions,
    answered: workload.batch_questions,
    pressed_at_ms,
    committed_at_ms: pressed_at_ms + 200,
    response_s: 0.4,
    tabs: { unfiltered: tab(slowest), filtered: tab(0.5) },
    host_load: {
      start: { load_1m: 1, load_5m: 1, load_15m: 1, cores: 8 },
      end: { load_1m: 1, load_5m: 1, load_15m: 1, cores: 8 },
    },
  };
};

const telemetry = (overrides: object = {}) => ({
  schema_version: 2,
  recorded_at: "2026-11-07T00:00:00.000Z",
  commit: "a".repeat(40),
  dirty: false,
  workload: { runs: workload.runs, write_spacing_s: workload.write_spacing_s },
  human_items: {
    unfiltered: page(0, 0.8),
    filtered: { ...page(4, 1.5), filter: FILTERED },
  },
  batch: batch(),
  ...overrides,
});

const largeTelemetry = (overrides: object = {}) => ({
  schema_version: 3,
  recorded_at: "2026-11-07T00:00:00.000Z",
  commit: "a".repeat(40),
  dirty: false,
  large_run: largeRun(),
  ...overrides,
});

/** The two budgets over `path`, through the real `onebudgetspec check`. */
function check(
  path: string,
  metrics: readonly (readonly [string, number])[] = [
    ["human-items-requests", 1],
    ["human-items-lag", 3],
  ],
) {
  const dir = mkdtempSync(join(tmpdir(), "read-latency-budget-"));
  try {
    const budgets = metrics.map(
      ([metric, threshold]) => `  - id: runner-${metric}
    description: The runner's ${metric} metric over a fixture.
    measure: reported
    command: [node, ${JSON.stringify(RUNNER)}, --telemetry, ${JSON.stringify(path)}, --metric, ${metric}]
    unit: figure
    direction: max
    threshold: ${threshold}`,
    );
    const file = join(dir, "budgets.yaml");
    writeFileSync(file, `schema_version: 1\nbudgets:\n${budgets.join("\n")}\n`);
    const run = spawnSync(CHECK, ["check", file, "--output", "json"], {
      encoding: "utf8",
    });
    return resultSchema.parse(JSON.parse(run.stdout)).results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function measure(metric: string, path: string) {
  return spawnSync(
    process.execPath,
    [RUNNER, "--metric", metric, "--telemetry", path],
    { encoding: "utf8" },
  );
}

function recorded(document: object) {
  const dir = mkdtempSync(join(tmpdir(), "read-latency-telemetry-"));
  const path = join(dir, "read-latency.json");
  writeFileSync(path, JSON.stringify(document));
  return path;
}

test("reports the slowest page's figure as recorded, and a figure over its line fails", () => {
  telemetrySchema.parse(telemetry());
  const results = check(recorded(telemetry()));
  expect(
    Object.fromEntries(
      results.map(({ id, actual, verdict }) => [id, [actual, verdict]]),
    ),
  ).toStrictEqual({
    "runner-human-items-requests": [2, "over"],
    "runner-human-items-lag": [1.5, "within"],
  });
  // The breakdown each budget states: each page, by route and by percentile.
  const detail = z
    .object({
      filtered: z.object({
        by_route: z.record(z.string(), z.number()),
        connections_opened: z.number(),
      }),
    })
    .parse(JSON.parse(results[0]?.detail ?? "{}"));
  expect(detail.filtered.by_route).toStrictEqual({ "GET /api/human-items": 4 });
  expect(detail.filtered.connections_opened).toBe(0);
  const lag = z
    .object({
      unfiltered: z.object({
        p50_s: z.number(),
        p95_s: z.number(),
        max_s: z.number(),
        frame_arrival: z.object({ p95_s: z.number() }),
      }),
    })
    .parse(JSON.parse(results[1]?.detail ?? "{}"));
  expect(lag.unfiltered.p95_s).toBe(0.8);
  expect(lag.unfiltered.frame_arrival.p95_s).toBe(0.6);
});

test("the large-run budgets report their figures and detail through the real check", () => {
  largeTelemetrySchema.parse(largeTelemetry());
  const results = check(recorded(largeTelemetry()), [
    ["first-view", 1],
    ["rest-arrived", 60],
    ["history-page", 1],
    ["status", 1],
  ]);
  expect(
    Object.fromEntries(
      results.map(({ id, actual, verdict }) => [id, [actual, verdict]]),
    ),
  ).toStrictEqual({
    "runner-first-view": [0.7, "within"],
    "runner-rest-arrived": [40, "within"],
    "runner-history-page": [0.6, "within"],
    "runner-status": [0.4, "within"],
  });
  expect(results[0]?.detail).toContain("corpus");
  expect(results[3]?.detail).toContain("stand_in_starts");
});

// Every driver a budget names, as a corpus that did not hold it: the check fails
// naming it rather than reading a smaller corpus as a pass.
for (const driver of Object.keys(DRIVERS) as (keyof typeof DRIVERS)[]) {
  test(`a corpus missing the ${driver} driver fails the check, naming it`, () => {
    const corpus: Record<string, number> = { ...DRIVERS };
    delete corpus[driver];
    const path = recorded(largeTelemetry({ large_run: largeRun({ corpus }) }));
    const run = measure("first-view", path);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(driver);
    const results = check(path, [["first-view", 1]]);
    expect(results[0]?.verdict).not.toBe("within");
    expect(results[0]?.detail ?? run.stderr).toContain(driver);
  });
}

test("Overall on the relayed run over the line fails the first-view budget, and one never read is refused", () => {
  const slow = recorded(
    largeTelemetry({
      large_run: largeRun({
        first_view: {
          ...largeRun().first_view,
          relayed_overall: view(2.1),
          slowest_view: "relayed_overall",
          slowest_s: 2.1,
        },
      }),
    }),
  );
  const [result] = check(slow, [["first-view", 1]]);
  expect([result?.actual, result?.verdict]).toStrictEqual([2.1, "over"]);
  expect(
    z
      .object({ slowest_view: z.string(), relayed_overall: z.unknown() })
      .parse(JSON.parse(result?.detail ?? "{}")).slowest_view,
  ).toBe("relayed_overall");
  // A large-run recording that never opened the relayed run measured a smaller
  // workload than the budget states, and is not read as a pass.
  const unread: Record<string, unknown> = { ...largeRun().first_view };
  delete unread.relayed_overall;
  const run = measure(
    "first-view",
    recorded(largeTelemetry({ large_run: largeRun({ first_view: unread }) })),
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("relayed_overall");
});

test("a run with no mark fails the check, naming the reading", () => {
  const graph = {
    ...view(0.4),
    readings: [reading(null), reading(0.4), reading(0.4)],
  };
  const path = recorded(
    largeTelemetry({
      large_run: largeRun({
        first_view: { ...largeRun().first_view, graph },
      }),
    }),
  );
  const run = measure("first-view", path);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("no first-useful-screen mark");
  expect(check(path, [["first-view", 1]])[0]?.verdict).not.toBe("within");
});

test("each metric reads only the document its own target records, and names that target", () => {
  const large = measure("first-view", recorded(telemetry()));
  expect(large.status).toBe(1);
  expect(large.stderr).toContain("dag-ui-read-latency:test-large");
  const human = measure("human-items-lag", recorded(largeTelemetry()));
  expect(human.status).toBe(1);
  expect(human.stderr).toContain("dag-ui-read-latency:test ");
});

test("a batch tab slower than the spaced writes becomes the figure, with each part in its detail", () => {
  const results = check(recorded(telemetry({ batch: batch(2.4) })));
  const lag = results.find(({ id }) => id === "runner-human-items-lag");
  expect(lag?.actual).toBe(2.4);
  expect(lag?.verdict).toBe("within");
  const detail = z
    .object({
      spaced_p95_s: z.number(),
      batch: z.object({
        response_s: z.number(),
        lag_s: z.object({ unfiltered: z.number(), filtered: z.number() }),
      }),
    })
    .parse(JSON.parse(lag?.detail ?? "{}"));
  expect(detail.spaced_p95_s).toBe(1.5);
  expect(detail.batch.lag_s).toStrictEqual({ unfiltered: 2.4, filtered: 0.5 });
  expect(detail.batch.response_s).toBe(0.4);
});

test("telemetry with no batch phase is refused rather than reported", () => {
  const none = Object.fromEntries(
    Object.entries(telemetry()).filter(([key]) => key !== "batch"),
  );
  const run = measure("human-items-lag", recorded(none));
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("dag-ui-read-latency:test");
});

const MEASURE_RUN = join(import.meta.dirname, "measure-run.mjs");
const measureRun = (args: readonly string[]) =>
  spawnSync(process.execPath, [MEASURE_RUN, ...args], { encoding: "utf8" });

for (const [what, args] of [
  ["no arguments", []],
  ["no run", ["--runs-root", "/nowhere"]],
  ["no runs root", ["--run", "r"]],
  ["an unknown flag", ["--runs-root", "/nowhere", "--run", "r", "--fast"]],
  [
    "a run with no journal to choose a node from",
    ["--runs-root", "/nowhere", "--run", "r"],
  ],
] as const)
  test(`measure-run-load-on-host refuses ${what} as a usage error`, () => {
    const run = measureRun(args);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^measure-run: /mu);
  });

// The run is joined to the root to find its journal, so one that names anything
// but a directory directly under it is refused before it names a path.
for (const run of ["../r", "a/b", "."])
  test(`measure-run-load-on-host refuses --run ${run} as a usage error`, () => {
    const measured = measureRun(["--runs-root", "/nowhere", "--run", run]);
    expect(measured.status).toBe(2);
    expect(measured.stderr).toContain(
      `measure-run: --run ${JSON.stringify(run)} names no directory directly under --runs-root`,
    );
  });

test("measure-run-load-on-host hands the root to the measurement and exits as it does", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-run-spec-"));
  try {
    // A root that is a file: the measurement's server refuses it, which only the
    // host measurement reaches, and only with the root it was handed.
    const root = join(dir, "not-a-runs-root");
    writeFileSync(root, "");
    const output = join(dir, "measured.json");
    const run = measureRun([
      "--runs-root",
      root,
      "--run",
      "r",
      "--node",
      "n",
      "--output",
      output,
    ]);
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain(
      "the large run's server never answered",
    );
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("names the target to run when the telemetry is absent", () => {
  const run = measure("human-items-lag", join(tmpdir(), "no-such-telemetry"));
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("nx run dag-ui-read-latency:test");
});

test("refuses telemetry that was not recorded over the stated workload", () => {
  const filteredAs = (changed: object) =>
    telemetry({
      human_items: {
        unfiltered: page(0, 0.8),
        filtered: { ...page(0, 0.8), filter: FILTERED, ...changed },
      },
    });
  const clean = page(0, 0.8).lag;
  for (const unrealistic of [
    telemetry({ workload: { runs: 10, write_spacing_s: 3 } }),
    filteredAs({ journal_at_start: { events: 1, bytes: 100 } }),
    filteredAs({
      writes_by_kind: { raise: 40, answer: 0, complete: 0, dismiss: 0 },
    }),
    filteredAs({ lag: { ...clean, shown: 39, never_shown: 1 } }),
    // Counts that contradict each other, each of which reads as a pass.
    filteredAs({ lag: { ...clean, shown: 0 } }),
    filteredAs({ lag: { ...clean, p95_s: null } }),
    filteredAs({ requests: 4, requests_per_min: 0 }),
    filteredAs({ requests: 4, requests_per_min: 2, requests_by_route: {} }),
    // An unfiltered reading passed off as the filtered page's, and the reverse.
    filteredAs({ filter: {} }),
    telemetry({
      human_items: {
        unfiltered: { ...page(0, 0.8), filter: FILTERED },
        filtered: { ...page(0, 0.8), filter: FILTERED },
      },
    }),
    // A batch smaller than stated, one still listed, and one the reader sent.
    telemetry({ batch: { ...batch(), answers_in_request: 3 } }),
    telemetry({
      batch: {
        ...batch(),
        tabs: {
          ...batch().tabs,
          filtered: { ...batch().tabs.filtered, still_listed: 1 },
        },
      },
    }),
    telemetry({
      batch: {
        ...batch(),
        tabs: {
          ...batch().tabs,
          unfiltered: { ...batch().tabs.unfiltered, requests: 2 },
        },
      },
    }),
  ]) {
    const run = measure("human-items-lag", recorded(unrealistic));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dag-ui-read-latency:test");
  }
});

test("refuses a metric it does not measure, as a usage error", () => {
  const run = measure("human-items-speed", recorded(telemetry()));
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("human-items-requests");
});

test("each budgets file names this runner's metrics and its own telemetry, with no host label", () => {
  // Each names the telemetry it reads, so a job without that file, such as
  // ci.yml's budgets job, reports the file missing rather than running the
  // runner where its imports do not resolve.
  for (const [file, runner, telemetry, metrics] of [
    [
      "budgets.yaml",
      "read-latency-budget.mjs",
      "read-latency.json",
      ["human-items-requests", "human-items-lag"],
    ],
    [
      "large-run/budgets.yaml",
      "../read-latency-budget.mjs",
      "read-latency-large.json",
      ["first-view", "rest-arrived", "history-page", "status"],
    ],
  ] as const) {
    const text = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const metric of metrics)
      expect(text).toContain(
        `command: [node, ${runner}, --telemetry, apps/dag-ui-e2e/read-latency/telemetry/${telemetry}, --metric, ${metric}]`,
      );
    expect(text.match(/command:/gu)).toHaveLength(metrics.length);
    expect(text).not.toMatch(/labels:/u);
  }
});

test("the budgets file states the workload workload.json records", () => {
  const text = readFileSync(
    join(import.meta.dirname, "budgets.yaml"),
    "utf8",
  ).replace(/\s+/gu, " ");
  const kilobytes = Math.round(workload.human_item_bytes_at_start / 1000);
  for (const stated of [
    `a server over ${workload.runs} run directories`,
    `a human-item journal starting at ${workload.human_item_events_at_start} events and ${kilobytes} KB`,
    `and ${workload.writes} raises, answers, completions and dismissals`,
    `spaced ${workload.write_spacing_s} s apart`,
  ])
    expect(text.split(stated)).toHaveLength(3);
  const questions = workload.batch_questions;
  const chosen = workload.batch_with_choices;
  const typed = questions - chosen;
  // Only the page-update budget times the batch, so each figure is stated once.
  for (const stated of [
    `for one ${questions}-answer batch sent at once from the page`,
    `${questions} open high-priority questions raised through the real CLI`,
    `(${chosen} offering ${workload.batch_choices_each} choices, ${typed} offering none)`,
    `drafts all ${questions} (${chosen} by a choice press, ${typed} by typed text)`,
    `carrying ${questions} answers`,
  ])
    expect(text.split(stated)).toHaveLength(2);
});

/** The members of a generated journal record this test reads. */
const journalRecordSchema = z.looseObject({
  stream: z.string(),
  kind: z.string(),
  labels: z.looseObject({ node: z.string().optional() }),
  payload: z.looseObject({
    transcript: z.looseObject({ history_id: z.string() }).optional(),
  }),
});
type JournalRecord = z.infer<typeof journalRecordSchema>;

/** The members of a generated plan this test reads. */
const planSchema = z.looseObject({
  tasks: z.array(
    z.looseObject({ id: z.string(), deps: z.array(z.string()).optional() }),
  ),
});

test("the large-run corpus writes the shapes its drivers are read from, at a small size", () => {
  const dir = mkdtempSync(join(tmpdir(), "read-latency-corpus-"));
  try {
    const workload = join(dir, "workload.json");
    writeFileSync(
      workload,
      JSON.stringify({
        runs: 6,
        projects: 3,
        other_live_runs: 1,
        stopped_runs: 1,
        open_live_run_records_at_start: 3000,
        settled_big_records: 60,
        settled_small_records: 20,
        large: {
          state: "live",
          records: 3000,
          journal_bytes: 3_000_000,
          streams: 60,
          ordinary_spans: 100,
          session_records: 29,
          harness_spans: 50,
          checkpoint_bytes: 700_000,
          busiest_node_records: 300,
          off_graph_node_records: 200,
        },
      }),
    );
    const root = join(dir, "runs");
    const facts = z
      .object({
        openLiveRun: z.string(),
        smallRun: z.string(),
        large: z.object({
          busiestNode: z.string(),
          offGraphNode: z.string(),
          gatedNode: z.string(),
          crossRunRef: z.string(),
        }),
      })
      .parse(
        JSON.parse(
          execFileSync(
            process.execPath,
            [join(import.meta.dirname, "../load/corpus.mjs"), root, workload],
            { encoding: "utf8" },
          ),
        ),
      );
    const run = join(root, facts.openLiveRun);
    const records = z.array(journalRecordSchema).parse(
      readFileSync(join(run, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const nodeOf = (record: JournalRecord) => record.labels.node;
    // Sized to the workload, a node off the plan, and more than one stream.
    const journalBytes = readFileSync(join(run, "events.jsonl")).length;
    expect(Math.abs(journalBytes - 3_000_000)).toBeLessThan(3_000_000 * 0.03);
    expect(
      new Set(records.map((record) => record.stream)).size,
    ).toBeGreaterThan(40);
    expect(
      records.filter((record) => nodeOf(record) === facts.large.busiestNode)
        .length,
    ).toBeGreaterThanOrEqual(300);
    const plan = planSchema.parse(
      JSON.parse(readFileSync(join(run, "plan.json"), "utf8")),
    );
    expect(plan.tasks.map((task) => task.id)).not.toContain(
      facts.large.offGraphNode,
    );
    expect(plan.tasks.flatMap((task) => task.deps ?? [])).toContain(
      facts.large.crossRunRef,
    );
    // Each stream's edge rests on a record a read by kind would drop.
    const firstOfStream = new Map<string, { kind: string }>();
    const lastOfStream = new Map<string, { kind: string }>();
    for (const record of records) {
      if (!record.stream.startsWith("node-scope-")) continue;
      if (!firstOfStream.has(record.stream))
        firstOfStream.set(record.stream, record);
      lastOfStream.set(record.stream, record);
    }
    expect(
      [...firstOfStream.values()].every(
        (record) => record.kind === "member-heartbeat",
      ),
    ).toBe(true);
    // A reference into a session store, with its id a UUID v7.
    const references = records.filter(
      (record) => record.payload.transcript !== undefined,
    );
    expect(references.length).toBeGreaterThan(0);
    expect(references[0]?.payload.transcript?.history_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    // The harness-scope spans' pointer file, one line per span.
    expect(
      readFileSync(join(run, "oneharness-sessions.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(50);
    expect(existsSync(join(root, facts.smallRun, "result.json"))).toBe(true);
    expect(readdirSync(root)).toHaveLength(6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the relayed run is written settled, at its size, its long driver's heartbeats naming no session past its earlier drivers' records", () => {
  const dir = mkdtempSync(join(tmpdir(), "read-latency-relayed-"));
  try {
    const relayed = {
      state: "settled",
      nodes: 9,
      records: 6000,
      journal_bytes: 4_000_000,
      run_level_records: 2200,
      driver_streams: 4,
      records_before_long_driver: 500,
      session_search_records: 700_000,
    };
    const workload = join(dir, "workload.json");
    writeFileSync(
      workload,
      JSON.stringify({
        runs: 6,
        projects: 3,
        other_live_runs: 1,
        stopped_runs: 1,
        open_live_run_records_at_start: 300,
        settled_big_records: 60,
        settled_small_records: 20,
        relayed,
      }),
    );
    const root = join(dir, "runs");
    const facts = z
      .object({
        relayed: z.object({
          run: z.string(),
          nodes: z.array(z.string()),
          longDriver: z.string(),
        }),
      })
      .parse(
        JSON.parse(
          execFileSync(
            process.execPath,
            [join(import.meta.dirname, "../load/corpus.mjs"), root, workload],
            { encoding: "utf8" },
          ),
        ),
      );
    const run = join(root, facts.relayed.run);
    const records = z
      .array(
        journalRecordSchema.extend({
          source: z.string(),
          labels: z.looseObject({
            node: z.string().optional(),
            member: z.string().optional(),
            session: z.string().optional(),
          }),
        }),
      )
      .parse(
        readFileSync(join(run, "events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    // Its size, and its nine planned nodes each settled done.
    expect(records).toHaveLength(relayed.records);
    const journalBytes = readFileSync(join(run, "events.jsonl")).length;
    expect(Math.abs(journalBytes - relayed.journal_bytes)).toBeLessThan(
      relayed.journal_bytes * 0.03,
    );
    const plan = planSchema.parse(
      JSON.parse(readFileSync(join(run, "plan.json"), "utf8")),
    );
    expect(plan.tasks.map((task) => task.id)).toStrictEqual(
      facts.relayed.nodes,
    );
    expect(
      records
        .filter((record) => record.kind === "node-settled")
        .map((record) => record.labels.node),
    ).toStrictEqual(facts.relayed.nodes);
    expect(
      z
        .object({ state: z.literal("complete"), nodes: z.array(z.unknown()) })
        .parse(JSON.parse(readFileSync(join(run, "result.json"), "utf8")))
        .nodes,
    ).toHaveLength(relayed.nodes);
    // A third of its records relayed at no node, on its driver streams.
    const runLevel = records.filter(
      (record) => record.labels.node === undefined,
    );
    expect(runLevel.length).toBe(relayed.run_level_records + 1);
    const drivers = new Set(
      runLevel
        .filter((record) => record.source === "agentgraph")
        .map((record) => record.stream),
    );
    expect(drivers.size).toBe(relayed.driver_streams);
    // The long driver's heartbeats name no session, and the first of its records
    // that does lies past every earlier driver's.
    const long = runLevel.filter(
      (record) => record.stream === facts.relayed.longDriver,
    );
    const unnamed = long.filter(
      (record) => record.labels.session === undefined,
    );
    expect(unnamed.length).toBeGreaterThan(long.length / 2);
    expect(
      unnamed.every(
        (record) =>
          record.kind === "member-heartbeat" &&
          record.labels.member !== undefined,
      ),
    ).toBe(true);
    const firstNamed = runLevel.findIndex(
      (record) =>
        record.stream === facts.relayed.longDriver &&
        record.labels.session !== undefined,
    );
    expect(firstNamed).toBeGreaterThan(relayed.records_before_long_driver);
    expect(readdirSync(root)).toHaveLength(6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
