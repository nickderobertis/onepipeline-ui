import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The read-latency telemetry and the runner that reads it:
 * `dag-ui-read-latency:test`, which builds the release server first.
 *
 * No `webServer`: each measured page starts its own `onepipeline-api serve` over
 * the corpus this tier generates. One worker, because nothing may run beside a
 * timing, and no timeout on a window of known length: a page's own waits guard
 * against a hang.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: [
    "read-latency.spec.ts",
    "read-latency-budget.spec.ts",
    "first-screen-marks.spec.ts",
    "wire-and-errors.spec.ts",
    "live-run.spec.ts",
    "reach-everything.spec.ts",
  ],
  outputDir: join(import.meta.dirname, "../test-results/read-latency"),
  workers: 1,
  fullyParallel: false,
  timeout: 0,
  reporter: "list",
  use: { browserName: "chromium" },
});
