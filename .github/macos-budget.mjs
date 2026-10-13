#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { report } from "@onebudgetspec/sdk";
import { digest } from "./workflow-graph.mjs";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" && value.length > 0;
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function requireShape(condition, name) {
  if (!condition)
    throw new Error(
      `invalid telemetry ${name}; ACTION: run github-workflows:test to regenerate evidence`,
    );
}
function rows(value) {
  requireShape(Array.isArray(value), "job rows");
  for (const row of value)
    requireShape(
      object(row) &&
        [row.workflow, row.event, row.job, row.name, row.runner].every(text) &&
        /^(ubuntu|windows|macos)-[\w.-]+$/.test(row.runner) &&
        typeof row.requested === "boolean" &&
        typeof row.macos === "boolean" &&
        row.macos === row.runner.startsWith("macos-") &&
        (row.target === null || text(row.target)) &&
        Array.isArray(row.targets) &&
        row.targets.every(text),
      "job row fields",
    );
}
function spending(value) {
  requireShape(Array.isArray(value), "Mac-spending runs");
  for (const run of value) {
    requireShape(
      object(run) && text(run.event) && text(run.workflow),
      "Mac-spending run fields",
    );
    rows(run.jobs);
    requireShape(
      run.jobs.length > 0 &&
        run.jobs.every((row) => row.macos && row.requested),
      "Mac-spending run jobs",
    );
  }
}
function validate(telemetry) {
  requireShape(object(telemetry), "document");
  if (telemetry.schemaVersion !== 1 || telemetry.sourceDigest !== digest())
    throw new Error(
      "missing or stale telemetry; ACTION: run github-workflows:test on this tree",
    );
  requireShape(
    count(telemetry.jobsPerRun) && count(telemetry.runsPerChange),
    "numeric measurements",
  );
  requireShape(
    Array.isArray(telemetry.scenarios) && telemetry.scenarios.length > 0,
    "scenarios",
  );
  for (const scenario of telemetry.scenarios) {
    requireShape(
      object(scenario) &&
        [scenario.id, scenario.class, scenario.event, scenario.diff].every(
          text,
        ) &&
        typeof scenario.fork === "boolean" &&
        typeof scenario.releaseBranch === "boolean" &&
        ["true", "false"].includes(scenario.cratePublish) &&
        object(scenario.vars) &&
        ["true", "false"].includes(scenario.vars.PYPI_PUBLISH) &&
        ["true", "false"].includes(scenario.vars.NPM_PUBLISH) &&
        object(scenario.policy) &&
        typeof scenario.policy.isReleaseOnly === "boolean" &&
        typeof scenario.policy.macosRequired === "boolean" &&
        text(scenario.policy.reason),
      "scenario fields",
    );
    rows(scenario.rows);
  }
  requireShape(
    Array.isArray(telemetry.runs) && telemetry.runs.length > 0,
    "workflow runs",
  );
  for (const run of telemetry.runs) {
    requireShape(
      object(run) &&
        text(run.scenario) &&
        text(run.workflow) &&
        count(run.macJobs),
      "workflow run fields",
    );
    rows(run.rows);
    requireShape(
      run.macJobs ===
        run.rows.filter((row) => row.macos && row.requested).length,
      "workflow run measurement",
    );
  }
  requireShape(
    Array.isArray(telemetry.lifecycles) && telemetry.lifecycles.length > 0,
    "lifecycles",
  );
  for (const lifecycle of telemetry.lifecycles) {
    requireShape(
      object(lifecycle) &&
        text(lifecycle.diff) &&
        typeof lifecycle.fork === "boolean" &&
        ["true", "false"].includes(lifecycle.pypi) &&
        ["true", "false"].includes(lifecycle.npm) &&
        ["true", "false"].includes(lifecycle.cratePublish) &&
        Array.isArray(lifecycle.phases) &&
        lifecycle.phases.every(text),
      "lifecycle fields",
    );
    spending(lifecycle.macRuns);
  }
  spending(telemetry.macRuns);
  requireShape(
    telemetry.jobsPerRun ===
      Math.max(...telemetry.runs.map((run) => run.macJobs)) &&
      telemetry.runsPerChange ===
        Math.max(
          ...telemetry.lifecycles.map((lifecycle) => lifecycle.macRuns.length),
        ) &&
      telemetry.macRuns.length === telemetry.runsPerChange,
    "aggregate measurements",
  );
}
class UsageError extends Error {}

try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);
  const { values } = parseArgs({
    options: { metric: { type: "string" }, telemetry: { type: "string" } },
  });
  if (!["jobs-per-run", "runs-per-change"].includes(values.metric))
    throw new UsageError("unknown metric");
  if (!values.telemetry) throw new UsageError("--telemetry is required");
  const telemetry = JSON.parse(
    readFileSync(resolve(root, values.telemetry), "utf8"),
  );
  validate(telemetry);
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
} catch (error) {
  console.error(`macos-budget: ${error.message}`);
  console.error(
    "ACTION: supply a supported metric and freshly recorded telemetry from github-workflows:test",
  );
  process.exitCode =
    error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS_")
      ? 2
      : 1;
}
