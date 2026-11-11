import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Three projects over one release server. `budgets` holds Action items'
 * read-latency telemetry and the runner that reads it, `dag-ui-read-latency:test`.
 * `large` holds one large run's telemetry and the host measurement of a run,
 * `dag-ui-read-latency:test-large`, and
 * `journeys` the large-corpus journeys, `dag-ui-read-latency:test-journeys`. Those
 * two targets have edges of their own because they took longer than
 * test-linux's affected tier had left inside its cap; the release pull request's
 * sweep reaches them through `check`.
 *
 * No `webServer`: each measured page starts its own `onepipeline-api serve` over
 * the corpus this tier generates. One worker, because nothing may run beside a
 * timing, and no timeout on a window of known length: a page's own waits guard
 * against a hang.
 */
/**
 * The large run's measurements, by title: the one that records its figures, a
 * host's measurement of one of its own runs, and the journey that drives that
 * measurement through `measure-run.mjs`.
 */
const LARGE_RUN =
  /a large run's first screens, the rest, its history and its status|as this host holds them|measure-run-load-on-host measures/u;

export default defineConfig({
  testDir: import.meta.dirname,
  projects: [
    {
      name: "budgets",
      testMatch: ["read-latency.spec.ts", "read-latency-budget.spec.ts"],
      grepInvert: LARGE_RUN,
    },
    {
      name: "large",
      testMatch: ["read-latency.spec.ts", "measure-run.spec.ts"],
      grep: LARGE_RUN,
    },
    {
      name: "journeys",
      testMatch: [
        "first-screen-marks.spec.ts",
        "wire-and-errors.spec.ts",
        "live-run.spec.ts",
        "reach-everything.spec.ts",
      ],
    },
  ],
  outputDir: join(import.meta.dirname, "../test-results/read-latency"),
  workers: 1,
  fullyParallel: false,
  timeout: 0,
  reporter: "list",
  use: { browserName: "chromium" },
});
