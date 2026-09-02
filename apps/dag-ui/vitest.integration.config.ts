import { defineConfig } from "vitest/config";

/**
 * The tier that starts things: the tests here run a real Vite over the real
 * config, which is what `vite.config.ts`'s own `test` block excludes.
 *
 * A config of its own rather than a filter on the other one, for the reason the
 * crate's baseline comparison has a target of its own: a reader running the
 * components should not start servers, and a tier that starts them should be
 * asked for by name. `check` runs both.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
});
