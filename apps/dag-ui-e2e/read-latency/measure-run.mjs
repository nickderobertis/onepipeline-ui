#!/usr/bin/env node
/**
 * `measure-run-load-on-host`'s entry: the read-latency measurement over one run
 * of a real runs root, read as it stands.
 *
 *   node apps/dag-ui-e2e/read-latency/measure-run.mjs --runs-root <path> --run <run>
 *     [--node <node>] [--output <file>]
 *
 * And the first-view-time spike's: one measurement over the tier's large corpus
 * (`large-run-workload.json`), generated into `--corpus` on its first use and read
 * as it stands on every later one, so every figure is taken over the same bytes.
 *
 *   node apps/dag-ui-e2e/read-latency/measure-run.mjs --corpus <dir>
 *     [--server <binary>] [--spike <switch,...>] [--views graph,overall,node]
 *     [--first-view-only] [--output <file>]
 *
 * `--server` names the binary measured (the release build by default), `--spike`
 * the prototype switches it runs with (`ONEPIPELINE_UI_SPIKE`; none by default), and
 * `--first-view-only` takes each view's primer and three readings and nothing else.
 * Every reading carries its server's trace (`server_split`) where the binary writes one.
 *
 * Exits 2 on a usage error, otherwise as the measurement does.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
let values;
try {
  ({ values } = parseArgs({
    options: {
      "runs-root": { type: "string" },
      run: { type: "string" },
      node: { type: "string" },
      output: { type: "string" },
      corpus: { type: "string" },
      server: { type: "string" },
      spike: { type: "string" },
      views: { type: "string" },
      "first-view-only": { type: "boolean" },
    },
  }));
  if (
    values.corpus === undefined &&
    (values["runs-root"] === undefined || values.run === undefined)
  )
    throw new Error("--corpus, or --runs-root and --run, are required");
  if (values.corpus !== undefined && values["runs-root"] !== undefined)
    throw new Error("--corpus and --runs-root name two different corpora");
} catch (error) {
  console.error(`measure-run: ${error.message}`);
  process.exit(2);
}
const optional = (name, value) =>
  value === undefined ? {} : { [name]: value };
const run = spawnSync(
  join(HERE, "../../../node_modules/.bin/playwright"),
  [
    "test",
    "--config",
    join(HERE, "read-latency.config.ts"),
    // The measurement alone: "first screens" also names first-screen-marks.spec.ts's
    // journeys, each of which builds a corpus of its own.
    "-g",
    "one run's first screens, as this host holds them",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...optional("READ_LATENCY_RUNS_ROOT", values["runs-root"]),
      ...optional("READ_LATENCY_RUN", values.run),
      ...optional("READ_LATENCY_NODE", values.node),
      ...optional(
        "READ_LATENCY_OUTPUT",
        values.output === undefined ? undefined : resolve(values.output),
      ),
      ...optional(
        "READ_LATENCY_CORPUS",
        values.corpus === undefined ? undefined : resolve(values.corpus),
      ),
      ...optional(
        "READ_LATENCY_SERVER",
        values.server === undefined ? undefined : resolve(values.server),
      ),
      ...optional("READ_LATENCY_SPIKE", values.spike),
      ...optional("READ_LATENCY_VIEWS", values.views),
      ...(values["first-view-only"] ? { READ_LATENCY_FIRST_VIEW_ONLY: "1" } : {}),
    },
  },
);
process.exit(run.status ?? 1);
