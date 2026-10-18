// The step each of ci.yml's four jobs runs when it is cancelled, which decides
// whether rust-cache's post step saves that run's build: run as the job runs it,
// out of the real workflow, against a scratch $GITHUB_ENV.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workflows } from "../workflow-graph.mjs";

const JOBS = ["lint", "test-linux", "test-windows", "test-macos"];

function verdictStep(id) {
  const ci = workflows().find((w) => w.file === "ci.yml").document;
  const job = ci.jobs[id];
  const step = job.steps.find((s) =>
    (s.run ?? "").includes("scripts/ci-cache-verdict.sh"),
  );
  assert.ok(step, `${id} has no cache verdict step`);
  return { step, cap: job["timeout-minutes"] };
}

// Run `script` the way a step's `run:` runs, `secondsAgo` after the job started,
// and answer its exit, its output and what it wrote to $GITHUB_ENV.
function cancelledAfter(script, secondsAgo, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cache-verdict-"));
  try {
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");
    const result = spawnSync("bash", ["-e", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ENV: githubEnv,
        JOB_STARTED_AT: String(Math.floor(Date.now() / 1000) - secondsAgo),
        ...env,
      },
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      written: readFileSync(githubEnv, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a run superseded well before its cap withdraws the save of its build", () => {
  for (const id of JOBS) {
    const { step, cap } = verdictStep(id);
    const run = cancelledAfter(step.run, 5 * 60);
    assert.equal(run.status, 0, `${id}: ${run.output}`);
    assert.equal(run.written, "CACHE_ON_FAILURE=false\n", `${id}`);
    assert.match(run.output, /superseded: saving nothing/, id);
    assert.match(run.output, new RegExp(`${cap}-minute cap`), id);
  }
});

test("a run stopped at its cap keeps the save of what it built", () => {
  for (const id of JOBS) {
    const { step, cap } = verdictStep(id);
    for (const secondsAgo of [cap * 60 - 30, cap * 60 + 240]) {
      const run = cancelledAfter(step.run, secondsAgo);
      assert.equal(run.status, 0, `${id}: ${run.output}`);
      assert.equal(run.written, "", `${id} at ${secondsAgo}s: ${run.written}`);
      assert.match(run.output, /at the cap: saving what this run built/, id);
    }
  }
});

test("a verdict with no start time or no $GITHUB_ENV is refused as usage, deciding nothing", () => {
  const { step } = verdictStep("test-linux");
  for (const [env, says] of [
    [{ JOB_STARTED_AT: "" }, /--started takes epoch seconds, not ''/],
    [
      { JOB_STARTED_AT: "yesterday" },
      /--started takes epoch seconds, not 'yesterday'/,
    ],
    // Bash arithmetic would read these as octal, or overflow on them.
    [{ JOB_STARTED_AT: "08" }, /--started takes epoch seconds, not '08'/],
    [
      { JOB_STARTED_AT: "99999999999999999999" },
      /--started takes epoch seconds, not '99999999999999999999'/,
    ],
    [{ GITHUB_ENV: "" }, /\$GITHUB_ENV is not set/],
  ]) {
    const run = cancelledAfter(step.run, 5 * 60, env);
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, says);
    assert.match(run.output, /ACTION: run 'ci-cache-verdict.sh/);
    assert.equal(run.written, "");
  }
  const missing = spawnSync(
    "bash",
    ["scripts/ci-cache-verdict.sh", "--cap-minutes", "30"],
    { encoding: "utf8", env: { ...process.env, GITHUB_ENV: "/dev/null" } },
  );
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /--started is required/);
  const cap = spawnSync(
    "bash",
    ["scripts/ci-cache-verdict.sh", "--started", "1", "--cap-minutes", "030"],
    { encoding: "utf8", env: { ...process.env, GITHUB_ENV: "/dev/null" } },
  );
  assert.equal(cap.status, 2, cap.stderr);
  assert.match(
    cap.stderr,
    /--cap-minutes takes whole minutes from 1 to 9999, not '030'/,
  );
});

test("a superseded run whose $GITHUB_ENV cannot be written fails, saying so", () => {
  const { step } = verdictStep("test-linux");
  const dir = mkdtempSync(join(tmpdir(), "cache-verdict-"));
  try {
    // A directory where the file should be: nothing can append to it.
    const run = spawnSync("bash", ["-e", "-c", step.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ENV: dir,
        JOB_STARTED_AT: String(Math.floor(Date.now() / 1000) - 300),
      },
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /cannot append to \$GITHUB_ENV/);
    assert.match(run.stderr, /ACTION: run this from a workflow step/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
