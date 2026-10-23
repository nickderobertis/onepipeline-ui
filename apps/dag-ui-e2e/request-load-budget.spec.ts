/**
 * The budget runner, driven the way `dag-ui-e2e:budgets` drives it: through
 * the real `onebudgetspec check`, over a budgets file and telemetry of the
 * shape `load/load.spec.ts` records. It reports the worst figure of each
 * metric, refuses telemetry that is incomplete or malformed rather than
 * reading a missing state as one that cost nothing, and refuses a metric it
 * has none of. No browser is opened.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const REPO = resolve(import.meta.dirname, "../..");
const RUNNER = join(import.meta.dirname, "request-load-budget.mjs");
const CHECK = join(REPO, "node_modules/.bin/onebudgetspec");

const views = ["graph", "overall", "node"] as const;

/** One variant's figures, every one of them `n` scaled. */
function variant(
  kind: string,
  view: string | undefined,
  tabs: number,
  n: number,
) {
  const resent = { frames: 0, bytes: 0 };
  return {
    kind,
    ...(view === undefined ? {} : { view }),
    tabs,
    load_s: Array.from({ length: tabs }, () => 3),
    requests_per_min: n,
    requests_per_min_by_route: { "GET /api/v2/events?after&subscription": n },
    mb_per_min: n / 10,
    bytes_per_min_by_route: {},
    frames_per_min: n * 100,
    frames_by_type: {},
    repeated_snapshot: {
      in_window: resent,
      at_load: resent,
      after_reconnect: resent,
    },
    server_cpu: {
      seconds: n * 12,
      window_s: 120,
      cores: n / 10,
      cores_per_tab: n / 10 / tabs,
    },
    ...(kind === "live" && tabs === 1
      ? {
          lag: {
            measured_as: "test",
            records: 500,
            shown: 500,
            never_shown: 0,
            p50_s: n / 20,
            p95_s: n / 10,
            max_s: n / 5,
            during_burst: {
              records: 400,
              shown: 400,
              never_shown: 0,
              p50_s: n / 20,
              p95_s: n / 10,
              max_s: n / 5,
            },
            frame_arrival: { p50_s: 0.05, p95_s: 0.1, max_s: 0.2 },
          },
        }
      : {}),
  };
}

/** Telemetry of every variant the load journey records, `live-node` costliest. */
function telemetry() {
  const variants: Record<string, unknown> = {
    "nothing-open": variant("nothing-open", undefined, 1, 0.5),
    host: variant("host", undefined, 1, 1),
  };
  views.forEach((view, at) => {
    variants[`settled-${view}`] = variant("settled", view, 1, 0.1 * (at + 1));
    variants[`stopped-${view}`] = variant("stopped", view, 1, 0.2 * (at + 1));
  });
  for (const view of [...views, "channel"]) {
    const n = view === "node" ? 2 : 1;
    variants[`live-${view}`] = variant("live", view, 1, n);
    variants[`live-${view}-2-tabs`] = variant("live", view, 2, n * 3);
  }
  return {
    schema_version: 1,
    recorded_at: "2026-10-23T00:00:00.000Z",
    commit: "0".repeat(40),
    dirty: false,
    window_s: 120,
    workload: {
      runs: 150,
      projects: 30,
      other_live_runs: 10,
      records_per_minute_per_live_run: 50,
      burst_records: 400,
      open_live_run_records_at_start: 116_000,
      fresh_server_and_corpus_per_variant: true,
    },
    variants,
  };
}

const resultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      verdict: z.string(),
      actual: z.number().nullable().optional(),
    }),
  ),
});

/** Check every metric over `document` and answer each budget's reading. */
function check(document: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "dag-ui-e2e-budget-runner-"));
  try {
    const data = join(dir, "request-load.json");
    writeFileSync(data, JSON.stringify(document));
    const budgets = ["settled", "live", "lag", "wire", "cpu"].map(
      (metric) => `  - id: runner-${metric}
    description: The runner's ${metric} metric over a fixture.
    measure: reported
    command: [node, ${JSON.stringify(RUNNER)}, --telemetry, ${JSON.stringify(data)}, --metric, ${metric}]
    unit: figure
    direction: max
    threshold: 100`,
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

test("each metric reports the costliest variant's figure from recorded telemetry", () => {
  const results = check(telemetry());
  const actual = Object.fromEntries(
    results.map(({ id, actual }) => [id, actual]),
  );
  expect(results.every(({ verdict }) => verdict === "within")).toBe(true);
  // The worst finished-run view, the worst live view, the slowest live view's
  // p95, the costliest page state's megabytes and the costliest tab's cores.
  expect(actual).toStrictEqual({
    "runner-settled": 0.6000000000000001,
    "runner-live": 2,
    "runner-lag": 0.2,
    "runner-wire": 0.2,
    "runner-cpu": 0.3,
  });
});

test("telemetry missing a variant, or carrying a figure no measurement makes, is refused", () => {
  const missing = telemetry();
  delete missing.variants["stopped-node"];
  const negative = telemetry();
  negative.variants["live-graph"] = {
    ...variant("live", "graph", 1, 1),
    requests_per_min: -1,
  };
  for (const document of [missing, negative, { schema_version: 2 }])
    for (const { verdict } of check(document)) expect(verdict).toBe("error");
});

test("a metric the runner has no reading of is a usage error", () => {
  const run = spawnSync(
    process.execPath,
    [RUNNER, "--metric", "uptime", "--telemetry", "telemetry/x.json"],
    { encoding: "utf8" },
  );
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("--metric is one of");
});
