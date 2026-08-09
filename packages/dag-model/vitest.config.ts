import { defineConfig } from "vitest/config";

/** The package's own unit tests and the consumer journeys beside them. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts"],
  },
});
