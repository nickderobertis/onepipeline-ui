import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiTarget = readApiTarget();

/**
 * The read API this dev server and `vite preview` proxy to, validated where it
 * arrives rather than trusted.
 *
 * It defaults to the loopback address and port `onepipeline-api serve` binds, and
 * the browser journeys override it to point at the throwaway fixture server they
 * start instead of at the operator's own runs.
 *
 * A proxy target is where every `/api` read a browser makes is sent, so a value
 * this refuses is one that would otherwise send an operator's run data somewhere
 * nobody named — and an unparseable one fails inside Vite's proxy as a request
 * error per read, which reads as the API being down rather than as this variable
 * being wrong. Refused here, once, naming the value.
 */
function readApiTarget(): string {
  const named = process.env.DAG_UI_API_URL;
  if (named === undefined || named === "") return "http://127.0.0.1:8787";
  let parsed: URL;
  try {
    parsed = new URL(named);
  } catch {
    throw new Error(`DAG_UI_API_URL is not a URL: ${named}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `DAG_UI_API_URL names ${parsed.protocol} and the read API is served over http or https: ${named}`,
    );
  }
  return parsed.origin;
}

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
