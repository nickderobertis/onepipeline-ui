import { defineConfig } from "vitest/config";

/** The vocabulary's own tests; it has no rendering and needs no DOM. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
