#!/usr/bin/env node
/**
 * `measure-run-load-on-host`'s entry: the read-latency measurement over one run
 * of a real runs root, read as it stands.
 *
 *   node apps/dag-ui-e2e/read-latency/measure-run.mjs --runs-root <path> --run <run>
 *     [--node <node>] [--output <file>]
 *
 * `--node` names the node whose timeline is measured, by default the one with
 * the most records in the run's journal. The figures go to `--output`, or else
 * to stdout alone; the measurement's own report goes to stderr either way.
 *
 * Exits 2 on a usage error, otherwise as the measurement does.
 */

import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The node with the most records in a run's journal, or `undefined` if none is named. */
async function busiestNode(journal) {
  const counts = new Map();
  for await (const line of createInterface({
    input: createReadStream(journal),
  })) {
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const node = record?.labels?.node;
    if (typeof node === "string") counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  let busiest;
  for (const [node, count] of counts)
    if (busiest === undefined || count > counts.get(busiest)) busiest = node;
  return busiest;
}

let values;
let node;
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
  node = values.node;
  if (node === undefined) {
    const journal = join(values["runs-root"], values.run, "events.jsonl");
    if (!existsSync(journal))
      throw new Error(
        `no journal at ${journal} to choose a node from; name one with --node`,
      );
    node = await busiestNode(journal);
    if (node === undefined)
      throw new Error(`${journal} names no node; name one with --node`);
  }
} catch (error) {
  console.error(`measure-run: ${error.message}`);
  process.exit(2);
}
const output =
  values.output ??
  join(mkdtempSync(join(tmpdir(), "measure-run-figures-")), "measured.json");
const run = spawnSync(
  join(HERE, "../../../node_modules/.bin/playwright"),
  [
    "test",
    "--config",
    join(HERE, "read-latency.config.ts"),
    // One argument: `--project` alone takes every name after it as a project.
    "--project=large",
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
    // The runner's report on stderr, so stdout holds the figures and nothing else.
    stdio: ["ignore", 2, 2],
    env: {
      ...process.env,
      READ_LATENCY_RUNS_ROOT: values["runs-root"],
      READ_LATENCY_RUN: values.run,
      READ_LATENCY_NODE: node,
      READ_LATENCY_OUTPUT: output,
    },
  },
);
if (run.status === 0 && values.output === undefined)
  process.stdout.write(readFileSync(output, "utf8"));
process.exit(run.status ?? 1);
