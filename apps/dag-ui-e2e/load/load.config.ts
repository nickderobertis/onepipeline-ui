import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The request-load telemetry, apart from the journeys: `dag-ui-e2e:test-load`.
 *
 * No `webServer`: every variant starts its own `onepipeline-api serve` over its
 * own freshly generated corpus, so neither the journeys' servers nor one
 * variant's grown journals are paid for by another. One worker, no timeout —
 * a whole run is twenty variants of two minutes each, and its recorded figures
 * are what `../budgets.yaml` reads.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "load.spec.ts",
  outputDir: join(import.meta.dirname, "../test-results/load"),
  workers: 1,
  fullyParallel: false,
  timeout: 0,
  reporter: "list",
  use: { browserName: "chromium" },
});
