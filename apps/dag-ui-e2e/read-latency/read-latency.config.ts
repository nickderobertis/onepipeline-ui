import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Three projects over one release server. `budgets` holds Action items'
 * read-latency telemetry and the runner that reads it, `dag-ui-read-latency:test`.
 * `large` holds one large run's telemetry and the host measurement of a run,
 * `dag-ui-read-latency:test-large`, and
 * `journeys` the large-corpus journeys, `dag-ui-read-latency:test-journeys`.
 * ci.yml's `budgets` job runs all three, one at a time, wherever a change reaches
 * this project (`scripts/ci-job.sh read-latency`).
 *
 * No `webServer`: each measured page starts its own `onepipeline-api serve` over
 * the corpus this tier generates. The two timing projects take one worker,
 * because nothing may run beside a timing, and no timeout on a window of known
 * length: a page's own waits guard against a hang. The journeys time nothing,
 * and their target runs alone, so they take JOURNEY_WORKERS — one file each,
 * every file over a world of its own — and finish in the time of their longest
 * file rather than of all of them.
 */
const JOURNEY_WORKERS = 4;

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
      workers: 1,
    },
    {
      name: "large",
      testMatch: ["read-latency.spec.ts", "measure-run.spec.ts"],
      grep: LARGE_RUN,
      workers: 1,
    },
    {
      name: "journeys",
      testMatch: [
        "first-screen-marks.spec.ts",
        "first-answer-fields.spec.ts",
        "wire-and-errors.spec.ts",
        "live-run.spec.ts",
        "reach-everything.spec.ts",
        "reach-pages.spec.ts",
        "reach-transcript.spec.ts",
      ],
      workers: JOURNEY_WORKERS,
    },
  ],
  outputDir: join(import.meta.dirname, "../test-results/read-latency"),
  workers: JOURNEY_WORKERS,
  fullyParallel: false,
  timeout: 0,
  reporter: "list",
  use: { browserName: "chromium" },
});
