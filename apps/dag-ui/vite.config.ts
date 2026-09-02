import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { readApiTarget } from "./src/lib/api-target";

const apiTarget = readApiTarget();

/**
 * The two paths the app reads the API through, proxied identically by the dev
 * server and by `vite preview`. Declared once and used by both: the journeys drive
 * the built bundle through `preview`, so a path proxied for one and not the other
 * is a read that works while a developer watches it and fails in the tier.
 */
const proxy = {
  "/api": apiTarget,
  "/healthz": apiTarget,
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 4173,
    proxy,
  },
  preview: { proxy },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
  },
});
