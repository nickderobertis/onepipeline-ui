#!/usr/bin/env node
/**
 * The one generic runner every budget in `budgets.yaml` measures with.
 *
 * It reads the telemetry `dag-ui-read-latency:test` recorded, reports one figure
 * and the breakdown behind it through the onebudgetspec reporter, and compares
 * nothing: the threshold is the budgets file's. It runs no scenario.
 *
 *   node apps/dag-ui-e2e/read-latency/read-latency-budget.mjs \
 *     --telemetry apps/dag-ui-e2e/read-latency/telemetry/read-latency.json \
 *     --metric human-items-requests|human-items-lag|first-view|rest-arrived|history-page|status
 *
 * Exits 0 having reported the figure, 1 when the telemetry is absent or does not
 * state the workload, and 2 on a usage error.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { report } from "@onebudgetspec/sdk";
import { FIRST_VIEWS, PAGES, telemetrySchema } from "./telemetry.ts";

class UsageError extends Error {}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const RECORDED = "apps/dag-ui-e2e/read-latency/telemetry/read-latency.json";
const TARGET = "dag-ui-read-latency:test";

function load(named) {
  const path = resolve(ROOT, named);
  if (!existsSync(path))
    throw new Error(
      `no telemetry at ${path}; ACTION: run 'nx run ${TARGET}', which records it`,
    );
  const parsed = telemetrySchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success)
    throw new Error(
      `the telemetry is not what ${TARGET} records (${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(
          "; ",
        )}); ACTION: run 'nx run ${TARGET}' on this tree to record it`,
    );
  return parsed.data;
}

/** The largest of `measure` over each page, and every page's own figure. */
function slowest(telemetry, measure) {
  const each = Object.fromEntries(
    PAGES.map((page) => [page, measure(telemetry.human_items[page])]),
  );
  return { value: Math.max(...Object.values(each)), each };
}

const pages = (telemetry, read) =>
  Object.fromEntries(
    PAGES.map((page) => [page, read(telemetry.human_items[page])]),
  );

const large = (telemetry) => telemetry.large_run;
const provenance = (telemetry) => ({
  corpus: large(telemetry).corpus,
  host_load: large(telemetry).host_load,
});

const MEASURES = {
  "first-view"(telemetry) {
    const { first_view: view } = large(telemetry);
    return {
      value: view.slowest_s,
      detail: {
        slowest_view: view.slowest_view,
        ...Object.fromEntries(FIRST_VIEWS.map((name) => [name, view[name]])),
        ...provenance(telemetry),
      },
    };
  },
  "rest-arrived"(telemetry) {
    const rest = large(telemetry).rest_arrived;
    return {
      value: rest.overall_s,
      detail: { ...rest, ...provenance(telemetry) },
    };
  },
  "history-page"(telemetry) {
    const page = large(telemetry).history_page;
    return {
      value: page.slowest_s,
      detail: { ...page, ...provenance(telemetry) },
    };
  },
  status(telemetry) {
    const status = large(telemetry).status;
    return {
      value: status.slowest_s,
      detail: { ...status, ...provenance(telemetry) },
    };
  },
  "human-items-requests"(telemetry) {
    const { value } = slowest(telemetry, (page) => page.requests_per_min);
    return {
      value,
      detail: pages(telemetry, (page) => ({
        requests_per_min: page.requests_per_min,
        by_route: page.requests_by_route,
        connections_opened: page.connections_opened,
        window_s: page.window_s,
        host_load: page.host_load,
      })),
    };
  },
  "human-items-lag"(telemetry) {
    const { value: spaced } = slowest(
      telemetry,
      (page) => page.lag.p95_s ?? Infinity,
    );
    const { batch } = telemetry;
    const lag = (name) => batch.tabs[name].lag_s;
    return {
      value: Math.max(spaced, ...PAGES.map(lag)),
      detail: {
        ...pages(telemetry, (page) => ({
          ...page.lag,
          window_s: page.window_s,
          host_load: page.host_load,
        })),
        spaced_p95_s: spaced,
        batch: {
          questions: batch.questions,
          response_s: batch.response_s,
          commit_after_press_s:
            (batch.committed_at_ms - batch.pressed_at_ms) / 1000,
          lag_s: Object.fromEntries(PAGES.map((name) => [name, lag(name)])),
          host_load: batch.host_load,
        },
      },
    };
  },
};

try {
  const { values } = parseArgs({
    options: { metric: { type: "string" }, telemetry: { type: "string" } },
  });
  if (!Object.hasOwn(MEASURES, values.metric ?? ""))
    throw new UsageError(
      `--metric is one of ${Object.keys(MEASURES).join(", ")}`,
    );
  const telemetry = load(values.telemetry ?? RECORDED);
  const { value, detail } = MEASURES[values.metric](telemetry);
  report(
    value,
    JSON.stringify({
      metric: values.metric,
      recorded_at: telemetry.recorded_at,
      commit: telemetry.commit,
      dirty: telemetry.dirty,
      workload: telemetry.workload,
      ...detail,
    }),
  );
  console.log(JSON.stringify({ metric: values.metric, value }));
} catch (error) {
  console.error(`read-latency-budget: ${error.message}`);
  process.exitCode =
    error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS_")
      ? 2
      : 1;
}
