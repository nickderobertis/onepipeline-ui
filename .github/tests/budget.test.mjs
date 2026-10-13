import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest, resolveScenario } from "../workflow-graph.mjs";

test("real telemetry reporter refuses missing and stale source evidence", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "budget-evidence-",
    ),
  );
  try {
    const missing = spawnSync(
      "node",
      [
        ".github/macos-budget.mjs",
        "--metric",
        "jobs-per-run",
        "--telemetry",
        join(scratch, "missing.json"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT/);
    const stale = join(scratch, "stale.json");
    writeFileSync(
      stale,
      JSON.stringify({ schemaVersion: 1, sourceDigest: "stale" }),
    );
    const refused = spawnSync(
      "node",
      [
        ".github/macos-budget.mjs",
        "--metric",
        "runs-per-change",
        "--telemetry",
        stale,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /missing or stale telemetry/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("telemetry boundary rejects malformed measurements and nested rows from a current-source document", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "malformed-budget-",
    ),
  );
  try {
    const scenario = {
      id: "validation",
      class: "pr-synchronize",
      event: "pull_request",
      action: "synchronize",
      diff: "source",
      fork: false,
      releaseBranch: false,
      cratePublish: "true",
      vars: { PYPI_PUBLISH: "true", NPM_PUBLISH: "true" },
      policy: {
        isReleaseOnly: false,
        macosRequired: true,
        reason: "ordinary PR",
      },
    };
    const rows = resolveScenario(scenario, scenario.policy);
    const runs = [...new Set(rows.map((row) => row.workflow))].map(
      (workflow) => ({
        scenario: scenario.id,
        workflow,
        rows: rows.filter((row) => row.workflow === workflow),
        macJobs: rows.filter(
          (row) => row.workflow === workflow && row.macos && row.requested,
        ).length,
      }),
    );
    const macRuns = runs
      .filter((run) => run.macJobs > 0)
      .map((run) => ({
        event: scenario.class,
        workflow: run.workflow,
        jobs: run.rows.filter((row) => row.macos && row.requested),
      }));
    const base = {
      schemaVersion: 1,
      sourceDigest: digest(),
      scenarios: [{ ...scenario, rows }],
      runs,
      macRuns,
      lifecycles: [
        {
          diff: "source",
          fork: false,
          pypi: "true",
          npm: "true",
          cratePublish: "true",
          phases: [scenario.id],
          macRuns,
        },
      ],
      jobsPerRun: Math.max(...runs.map((run) => run.macJobs)),
      runsPerChange: macRuns.length,
    };
    for (const change of [
      (value) => {
        value.jobsPerRun = "not a measurement";
      },
      (value) => {
        value.runs[0].rows = null;
      },
      (value) => {
        value.lifecycles[0].macRuns = {};
      },
      (value) => {
        value.scenarios[0].rows[0].requested = "true";
      },
    ]) {
      const value = structuredClone(base);
      change(value);
      const path = join(scratch, "invalid.json");
      writeFileSync(path, JSON.stringify(value));
      const rejected = spawnSync(
        "node",
        [
          ".github/macos-budget.mjs",
          "--metric",
          "jobs-per-run",
          "--telemetry",
          path,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /invalid telemetry/);
      assert.match(rejected.stderr, /ACTION:/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
