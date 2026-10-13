import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { digest, resolveScenario } from "../workflow-graph.mjs";

test("budget reporter distinguishes usage errors from telemetry failures", () => {
  for (const args of [
    [],
    ["--metric", "unknown", "--telemetry", "missing.json"],
    ["--metric", "jobs-per-run"],
    ["--metric"],
    ["--unknown"],
    ["unexpected"],
  ]) {
    const result = spawnSync("node", [".github/macos-budget.mjs", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ACTION:/);
  }
});

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
    assert.equal(missing.status, 1);
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
    assert.equal(refused.status, 1);
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

test("the production budget gate accepts recorded workflow rows and rejects a duplicate Mac job and missing telemetry", () => {
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "budget-gate-"),
  );
  try {
    cpSync(".github", join(scratch, ".github"), {
      recursive: true,
      filter: (source) =>
        !source.includes("/.telemetry") && !source.includes("/node_modules"),
    });
    cpSync("screencomp.toml", join(scratch, "screencomp.toml"));
    symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
    writeFileSync(join(scratch, ".gitignore"), "node_modules\n");
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    execFileSync("git", ["add", "."], { cwd: scratch });
    const generator = `
      import {mkdirSync,writeFileSync} from "node:fs";
      import {digest,resolveScenario} from "./.github/workflow-graph.mjs";
      const scenario={id:"ordinary",class:"pr-synchronize",event:"pull_request",action:"synchronize",diff:"source",fork:false,releaseBranch:false,cratePublish:"true",vars:{PYPI_PUBLISH:"true",NPM_PUBLISH:"true"},policy:{isReleaseOnly:false,macosRequired:true,reason:"ordinary PR"}};
      const rows=resolveScenario(scenario,scenario.policy);
      const runs=[...new Set(rows.map(r=>r.workflow))].map(workflow=>({scenario:scenario.id,workflow,rows:rows.filter(r=>r.workflow===workflow),macJobs:rows.filter(r=>r.workflow===workflow&&r.macos&&r.requested).length}));
      const macRuns=runs.filter(r=>r.macJobs>0).map(r=>({event:scenario.class,workflow:r.workflow,jobs:r.rows.filter(r=>r.macos&&r.requested)}));
      mkdirSync(".github/.telemetry",{recursive:true});
      writeFileSync(".github/.telemetry/macos-policy.json",JSON.stringify({schemaVersion:1,sourceDigest:digest(),scenarios:[{...scenario,rows}],runs,macRuns,lifecycles:[{diff:"source",fork:false,pypi:"true",npm:"true",cratePublish:"true",phases:[scenario.id],macRuns}],jobsPerRun:Math.max(...runs.map(r=>r.macJobs)),runsPerChange:macRuns.length}));
    `;
    const generate = () =>
      execFileSync("node", ["--input-type=module", "-e", generator], {
        cwd: scratch,
      });
    const check = () =>
      spawnSync("node", [".github/check-budgets.mjs"], {
        cwd: scratch,
        encoding: "utf8",
      });
    generate();
    const accepted = check();
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, /onepipeline-ui-macos-jobs-per-run: within/);
    assert.match(
      accepted.stdout,
      /onepipeline-ui-macos-runs-per-change: within/,
    );
    const mutate = `import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const file=".github/workflows/ci.yml";const workflow=parse(readFileSync(file,"utf8"));workflow.jobs["duplicate-macos"]=structuredClone(workflow.jobs.macos);writeFileSync(file,stringify(workflow));`;
    execFileSync("node", ["--input-type=module", "-e", mutate], {
      cwd: scratch,
    });
    generate();
    const over = check();
    assert.equal(over.status, 1, over.stdout + over.stderr);
    assert.match(over.stdout, /onepipeline-ui-macos-jobs-per-run: over/);
    rmSync(join(scratch, ".github/.telemetry/macos-policy.json"));
    const missing = check();
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stdout + missing.stderr, /ENOENT|telemetry/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
