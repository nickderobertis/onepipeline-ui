import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Two projects over one release server. `budgets` holds the read-latency telemetry and
 * the runner that reads it, `dag-ui-read-latency:test`. `journeys` holds the
 * large-corpus journeys, `dag-ui-read-latency:test-journeys`. That target has an edge of
 * its own because they took longer than test-linux's affected tier had left inside its
 * cap; the release pull request's sweep reaches them through `check`.
 *
 * No `webServer`: each measured page starts its own `onepipeline-api serve` over
 * the corpus this tier generates. One worker, because nothing may run beside a
 * timing, and no timeout on a window of known length: a page's own waits guard
 * against a hang.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  projects: [
    {
      name: "budgets",
      testMatch: ["read-latency.spec.ts", "read-latency-budget.spec.ts"],
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
