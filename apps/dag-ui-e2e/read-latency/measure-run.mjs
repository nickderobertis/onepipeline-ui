#!/usr/bin/env node
/**
 * `measure-run-load-on-host`'s entry: the read-latency measurement over one run
 * of a real runs root, read as it stands.
 *
 *   node apps/dag-ui-e2e/read-latency/measure-run.mjs --runs-root <path> --run <run>
 *     [--node <node>] [--output <file>]
 *
 * Exits 2 on a usage error, otherwise as the measurement does.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    },
  }));
  if (values["runs-root"] === undefined || values.run === undefined)
    throw new Error("--runs-root and --run are required");
} catch (error) {
  console.error(`measure-run: ${error.message}`);
  process.exit(2);
}
const run = spawnSync(
  join(HERE, "../../../node_modules/.bin/playwright"),
  [
    "test",
    "--config",
    join(HERE, "read-latency.config.ts"),
    // The host measurement alone: other journeys' titles name first screens too.
    "read-latency.spec.ts",
    "-g",
    "as this host holds them",
    // Its own artifacts, apart from a tier's run of the same config, which
    // Playwright would otherwise clear at this run's start.
    "--output",
    mkdtempSync(join(tmpdir(), "measure-run-")),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      READ_LATENCY_RUNS_ROOT: values["runs-root"],
      READ_LATENCY_RUN: values.run,
      ...(values.node === undefined ? {} : { READ_LATENCY_NODE: values.node }),
      ...(values.output === undefined
        ? {}
        : { READ_LATENCY_OUTPUT: values.output }),
    },
  },
);
process.exit(run.status ?? 1);
