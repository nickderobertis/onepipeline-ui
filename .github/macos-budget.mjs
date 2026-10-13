#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { report } from "@onebudgetspec/sdk";
import { digest } from "./workflow-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const { values } = parseArgs({
  options: { metric: { type: "string" }, telemetry: { type: "string" } },
});
if (!["jobs-per-run", "runs-per-change"].includes(values.metric))
  throw new Error("unknown metric");
if (!values.telemetry) throw new Error("--telemetry is required");
const telemetry = JSON.parse(
  readFileSync(resolve(root, values.telemetry), "utf8"),
);
if (telemetry.schemaVersion !== 1 || telemetry.sourceDigest !== digest())
  throw new Error(
    "missing or stale telemetry: run github-workflows:test on this tree",
  );
const value =
  values.metric === "jobs-per-run"
    ? telemetry.jobsPerRun
    : telemetry.runsPerChange;
const detail = JSON.stringify({
  metric: values.metric,
  sourceDigest: telemetry.sourceDigest,
  scenarios: telemetry.scenarios.length,
  macRuns: telemetry.macRuns,
  macJobs: telemetry.runs
    .filter((run) => run.macJobs > 0)
    .map(({ scenario, workflow, macJobs, rows }) => ({
      scenario,
      workflow,
      macJobs,
      jobs: rows.filter((row) => row.macos && row.requested),
    })),
});
report(value, detail);
console.log(JSON.stringify({ value, scenarios: telemetry.scenarios.length }));
