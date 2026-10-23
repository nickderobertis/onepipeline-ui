#!/usr/bin/env node
/**
 * The one generic runner every budget in `budgets.yaml` measures with.
 *
 * It reads the telemetry `dag-ui-e2e:test-load` recorded, reports one figure
 * and the breakdown behind it through the onebudgetspec reporter, and compares
 * nothing: the threshold is the budgets file's. It runs no scenario.
 *
 *   node apps/dag-ui-e2e/request-load-budget.mjs \
 *     --telemetry apps/dag-ui-e2e/telemetry/request-load.json \
 *     --metric settled|live|lag|wire|cpu
 *
 * Paths are read from the repository root, wherever it is run from.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { report } from "@onebudgetspec/sdk";
import { telemetrySchema } from "./load/telemetry.ts";

class UsageError extends Error {}

const METRICS = ["settled", "live", "lag", "wire", "cpu"];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function load(path) {
  const parsed = telemetrySchema.safeParse(
    JSON.parse(readFileSync(resolve(ROOT, path), "utf8")),
  );
  if (!parsed.success)
    throw new Error(
      `the telemetry is not what dag-ui-e2e:test-load records (${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(
          "; ",
        )}); ACTION: run dag-ui-e2e:test-load on this tree to record it`,
    );
  return parsed.data;
}

/** The variants of `kinds`, one tab each unless `tabs` says otherwise. */
function variants(telemetry, kinds, tabs = [1]) {
  return Object.entries(telemetry.variants).filter(
    ([, variant]) =>
      kinds.includes(variant.kind) && tabs.includes(variant.tabs),
  );
}

/** The largest of `measure` over `found`, and every one of them by name. */
function worst(found, measure) {
  const each = Object.fromEntries(
    found.map(([name, variant]) => [name, measure(variant)]),
  );
  return { value: Math.max(...Object.values(each)), each };
}

const MEASURES = {
  settled(telemetry) {
    const found = variants(telemetry, ["settled", "stopped"]);
    const { value, each } = worst(found, (variant) => variant.requests_per_min);
    const [, nothing] = variants(telemetry, ["nothing-open"])[0];
    return {
      value,
      detail: {
        requests_per_min_by_view: each,
        nothing_open_requests_per_min: nothing.requests_per_min,
        by_route: Object.fromEntries(
          found.map(([name, variant]) => [
            name,
            variant.requests_per_min_by_route,
          ]),
        ),
      },
    };
  },
  live(telemetry) {
    const found = variants(telemetry, ["live"]);
    const { value, each } = worst(found, (variant) => variant.requests_per_min);
    return {
      value,
      detail: {
        requests_per_min_by_view: each,
        by_route: Object.fromEntries(
          found.map(([name, variant]) => [
            name,
            variant.requests_per_min_by_route,
          ]),
        ),
      },
    };
  },
  lag(telemetry) {
    const found = variants(telemetry, ["live"]);
    const { value } = worst(found, (variant) => variant.lag.p95_s);
    return {
      value,
      detail: Object.fromEntries(
        found.map(([name, { lag }]) => [
          name,
          {
            measured_as: lag.measured_as,
            records: lag.records,
            p50_s: lag.p50_s,
            p95_s: lag.p95_s,
            max_s: lag.max_s,
            during_burst_p95_s: lag.during_burst.p95_s,
            frame_arrival: lag.frame_arrival,
          },
        ]),
      ),
    };
  },
  wire(telemetry) {
    const found = variants(telemetry, [
      "nothing-open",
      "settled",
      "stopped",
      "live",
      "host",
    ]);
    const { value, each } = worst(found, (variant) => variant.mb_per_min);
    return {
      value,
      detail: {
        mb_per_min_by_state: each,
        by_state: Object.fromEntries(
          found.map(([name, variant]) => [
            name,
            {
              bytes_per_min_by_route: variant.bytes_per_min_by_route,
              frames_by_type: variant.frames_by_type,
              repeated_snapshot: variant.repeated_snapshot,
            },
          ]),
        ),
      },
    };
  },
  cpu(telemetry) {
    const found = variants(telemetry, ["live"], [1, 2]);
    const { value } = worst(
      found,
      (variant) => variant.server_cpu.cores_per_tab,
    );
    return {
      value,
      detail: Object.fromEntries(
        found.map(([name, variant]) => [
          name,
          {
            page_state: variant.view,
            tabs: variant.tabs,
            total_cpu_seconds: variant.server_cpu.seconds,
            window_s: variant.server_cpu.window_s,
            total_cores: variant.server_cpu.cores,
            cores_per_tab: variant.server_cpu.cores_per_tab,
          },
        ]),
      ),
    };
  },
};

try {
  const { values } = parseArgs({
    options: { metric: { type: "string" }, telemetry: { type: "string" } },
  });
  if (!METRICS.includes(values.metric))
    throw new UsageError(`--metric is one of ${METRICS.join(", ")}`);
  if (!values.telemetry) throw new UsageError("--telemetry is required");
  const telemetry = load(values.telemetry);
  const { value, detail } = MEASURES[values.metric](telemetry);
  report(
    value,
    JSON.stringify({
      metric: values.metric,
      recorded_at: telemetry.recorded_at,
      commit: telemetry.commit,
      window_s: telemetry.window_s,
      workload: telemetry.workload,
      ...detail,
    }),
  );
  console.log(JSON.stringify({ metric: values.metric, value }));
} catch (error) {
  console.error(`request-load-budget: ${error.message}`);
  process.exitCode =
    error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS_")
      ? 2
      : 1;
}
