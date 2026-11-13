import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The read API this dev server and `vite preview` proxy to. It defaults to the
 * loopback address and port `onepipeline-api serve` binds, and the browser
 * journeys override it to point at the throwaway fixture server they start
 * instead of at the operator's own runs.
 *
 * Parsed rather than taken as given: this is where every `/api` read a browser
 * makes is sent, and a value that is not a URL is accepted by the proxy and then
 * fails per request, which reads as the API being down rather than as this
 * variable being wrong. `origin` because a path here would be prepended to every
 * read and answered by nothing.
 */
const apiTarget = new URL(process.env.DAG_UI_API_URL ?? "http://127.0.0.1:8787")
  .origin;

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
