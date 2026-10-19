#!/usr/bin/env node
// `onepipeline-ui-gate-time`'s command: the wall clock of the `just gate` run
// that just finished, read from the record scripts/gate-time.sh wrote around it
// and reported through the onebudgetspec SDK. It measures nothing itself: the
// record is the run's own start and end, so the check costs one file read.
//
// The record is `ONEPIPELINE_UI_GATE_TIME_RECORD`, else `.gate-time/record.json`
// under the repository root. A record that is missing, unreadable or not the
// shape gate-time.sh writes is an error (exit 1, the reason on stderr), never a
// zero: a figure nobody took must not read as a fast gate.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "@onebudgetspec/sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path =
  process.env.ONEPIPELINE_UI_GATE_TIME_RECORD ||
  join(root, ".gate-time", "record.json");

function fail(reason) {
  console.error(`gate-time-budget: ${reason}`);
  console.error(
    "ACTION: run 'just gate', which records its own start and end, then check this budget",
  );
  process.exit(1);
}

let record;
try {
  record = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(`no readable gate record at ${path}: ${error.message}`);
}
const { schema_version, invocation, started_at_ms, ended_at_ms, exit_code } =
  record ?? {};
if (
  schema_version !== 1 ||
  typeof invocation !== "string" ||
  !Number.isSafeInteger(started_at_ms) ||
  !Number.isSafeInteger(ended_at_ms) ||
  ended_at_ms < started_at_ms
)
  fail(`${path} is not a gate record scripts/gate-time.sh wrote`);
if (exit_code !== 0)
  fail(`${path} records a gate that failed (exit ${exit_code}), whose time says nothing`);

const seconds = (ended_at_ms - started_at_ms) / 1000;
report(
  seconds,
  `just gate (${invocation}): ${seconds}s from ${new Date(started_at_ms).toISOString()} to ${new Date(ended_at_ms).toISOString()}`,
);
