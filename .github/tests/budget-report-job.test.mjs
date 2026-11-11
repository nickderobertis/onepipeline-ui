// ci.yml's `budgets` job, reconciled against the released action's own definition
// (.github/reporting/fixtures, which `report-job:test` holds to the release), and
// resolved through the same workflow graph as the rest of CI: what it runs after,
// when it runs, and the budget records it owns.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { resolveWorkflow, triggered } from "../workflow-graph.mjs";

const ACTION = "nickderobertis/onebudgetspec-github-action";
const FOUR = ["lint", "test-linux", "test-windows", "test-macos"];
const read = (path) => parse(readFileSync(path, "utf8"));
const ci = () => read(".github/workflows/ci.yml");
const clone = (value) => JSON.parse(JSON.stringify(value));
const vendored = (tag) =>
  read(
    `.github/reporting/fixtures/onebudgetspec-github-action/${tag}/action.yml`,
  );

/** The steps that provision and run the read-latency timings, on a pull request. */
const READ_LATENCY_STEPS = 6;
/** The report runs whatever the timings did, unless the run was cancelled. */
const CANCELLED_ONLY = ["$", "{{ !cancelled() }}"].join("");

const actionStep = (job) =>
  (job?.steps ?? []).find((step) => step.uses?.startsWith(`${ACTION}@`));

export function reportJobProblems(workflow) {
  const problems = [];
  const job = workflow.jobs?.budgets;
  if (!job) return ["ci.yml has no budgets job"];
  if ("name" in job) problems.push("budgets overrides its name");
  if (
    JSON.stringify([...(job.needs ?? [])].sort()) !==
    JSON.stringify([...FOUR].sort())
  )
    problems.push(`budgets needs ${JSON.stringify(job.needs)}`);
  if (job.if !== "always()") problems.push(`budgets runs if ${job.if}`);
  if (job["timeout-minutes"] !== 30)
    problems.push(`budgets has timeout-minutes ${job["timeout-minutes"]}`);
  const granted = JSON.stringify(job.permissions);
  if (
    granted !==
    JSON.stringify({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
    })
  )
    problems.push(`budgets is granted ${granted}`);
  if (job.concurrency?.["cancel-in-progress"] !== false)
    problems.push("a newer budgets run cancels the comment writer");
  // It builds nothing. A checkout opens it and the action closes it; between them,
  // on a pull request alone, it provisions and runs dag-ui-read-latency's timings,
  // journeys and budgets (`just ci-read-latency`), which run alone on this runner
  // rather than after test-linux's CPU-bound pool: those steps and no others.
  const steps = job.steps ?? [];
  if (steps.length !== READ_LATENCY_STEPS + 2)
    problems.push(`budgets has ${steps.length} steps`);
  const between = steps.slice(1, -1);
  for (const step of between)
    if (step.if !== "github.event_name == 'pull_request'")
      problems.push(
        `the budgets step ${step.name ?? step.uses} runs on a push as well`,
      );
  const timings = between.filter((step) =>
    step.run?.includes("just ci-read-latency"),
  );
  if (timings.length !== 1)
    problems.push(
      `budgets runs the read-latency timings ${timings.length} times`,
    );
  if (
    between.some((step) =>
      /\b(cargo|nx(\.sh)? run-many|ci-test-linux)\b/u.test(step.run ?? ""),
    )
  )
    problems.push("budgets builds or tests beyond the read-latency timings");
  if (steps.at(-1) !== actionStep(job))
    problems.push("the report is not the job's last step");
  if (actionStep(job) && actionStep(job).if !== CANCELLED_ONLY)
    problems.push("a failed timing skips the report");
  const checkout = job.steps?.[0];
  if (!checkout?.uses?.startsWith("actions/checkout@"))
    problems.push("budgets does not start with a checkout");
  if (checkout?.with?.["fetch-depth"] !== 0)
    problems.push("budgets cannot prove a saved commit's ancestry");
  const step = actionStep(job);
  if (!step) return [...problems, "budgets does not use the released action"];
  const tag = step.uses.split("@")[1];
  let declared;
  try {
    declared = vendored(tag).inputs;
  } catch {
    return [...problems, `no released definition is vendored for ${tag}`];
  }
  for (const name of Object.keys(step.with ?? {}))
    if (!(name in declared))
      problems.push(`action input ${name} is not one ${tag} declares`);
  for (const [name, input] of Object.entries(declared))
    if (input.required && !(name in (step.with ?? {})))
      problems.push(`required action input ${name} is not given`);
  const excluded = (step.with?.["enforcement-exclude-labels"] ?? "").split(",");
  for (const label of ["release-tail", "host-variable"])
    if (!excluded.includes(label))
      problems.push(`${label} budgets are enforced in a pull request job`);
  // Every label that excludes a budget from enforcement names a measurement that
  // cannot be taken here; `host` budgets name their input instead.
  if (excluded.includes("host"))
    problems.push("host budgets lost their enforcement");
  if (step.with?.["saved-results-artifacts"] !== "budget-check-results-*")
    problems.push("budgets does not read what test-linux saved");
  if (step.with?.["omit-labels"] !== "not-measured-on-pr")
    problems.push("budgets shows budgets a pull request cannot measure");
  return problems;
}

// `test-linux` alone hands the job its targets' results, whatever those targets did.
export function resultsUploadProblems(workflow) {
  const job = workflow.jobs?.["test-linux"];
  const uploads = (job?.steps ?? []).filter(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with?.name === "budget-check-results-test-linux",
  );
  if (uploads.length !== 1)
    return [`test-linux has ${uploads.length} saved-results uploads`];
  const problems = [];
  if (uploads[0].if !== "always()")
    problems.push(`the saved results upload if ${uploads[0].if}`);
  if (uploads[0].with.path !== "target/budget-results/")
    problems.push(`the upload reads ${uploads[0].with.path}`);
  const gate = job.steps.findIndex((step) =>
    step.run?.includes("just ci-test-linux"),
  );
  if (gate < 0 || job.steps.indexOf(uploads[0]) < gate)
    problems.push("the saved results upload runs before the gate");
  if (job.if !== "github.event_name == 'pull_request'")
    problems.push(`test-linux runs if ${job.if}`);
  return problems;
}

test("the budgets job is the released action's one job, after the four, on what it declares", () => {
  assert.deepEqual(reportJobProblems(ci()), []);
});

test("a job that parts from the shape or the released definition is refused", () => {
  const cases = [
    [(w) => delete w.jobs.budgets, /no budgets job/],
    [(w) => (w.jobs.budgets.if = "success()"), /runs if success/],
    [(w) => w.jobs.budgets.needs.pop(), /budgets needs/],
    [
      (w) => w.jobs.budgets.steps.splice(1, 0, { run: "just build" }),
      new RegExp(`${READ_LATENCY_STEPS + 3} steps`),
    ],
    [
      (w) => w.jobs.budgets.steps.push({ run: "just build" }),
      /not the job's last step/,
    ],
    [
      (w) => {
        const timing = w.jobs.budgets.steps.find((step) =>
          step.run?.includes("just ci-read-latency"),
        );
        delete timing.if;
      },
      /runs on a push as well/,
    ],
    [
      (w) => {
        const timing = w.jobs.budgets.steps.find((step) =>
          step.run?.includes("just ci-read-latency"),
        );
        timing.run = "just ci-test-linux";
      },
      /read-latency timings 0 times/,
    ],
    [
      (w) => delete actionStep(w.jobs.budgets).if,
      /failed timing skips the report/,
    ],
    [(w) => (w.jobs.budgets.steps[0].with["fetch-depth"] = 1), /ancestry/],
    [
      (w) => (actionStep(w.jobs.budgets).uses = `${ACTION}@v9.9.9`),
      /no released definition/,
    ],
    [
      (w) => (actionStep(w.jobs.budgets).with.typo = "x"),
      /input typo is not one/,
    ],
    [
      (w) => delete actionStep(w.jobs.budgets).with.token,
      /required action input token/,
    ],
    [
      (w) =>
        (actionStep(w.jobs.budgets).with["enforcement-exclude-labels"] =
          "host-variable"),
      /release-tail budgets are enforced/,
    ],
    [
      (w) =>
        (actionStep(w.jobs.budgets).with["enforcement-exclude-labels"] =
          "release-tail,host-variable,host"),
      /host budgets lost/,
    ],
    [
      (w) => delete actionStep(w.jobs.budgets).with["saved-results-artifacts"],
      /does not read what test-linux saved/,
    ],
    [
      (w) => delete actionStep(w.jobs.budgets).with["omit-labels"],
      /cannot measure/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const workflow = clone(ci());
    mutate(workflow);
    assert.ok(
      reportJobProblems(workflow).some((p) => expected.test(p)),
      String(expected),
    );
  }
});

const requested = (scenario) =>
  resolveWorkflow("ci.yml", ci(), scenario, { macosRequired: true })
    .filter((row) => row.requested)
    .map((row) => row.job)
    .sort();
const pullRequest = {
  id: "pr",
  event: "pull_request",
  action: "opened",
  branch: "main",
  ref: "refs/pull/1/merge",
  headRef: "feature",
};

test("it runs whatever a pull request touches and whatever the four did", () => {
  const every = [...FOUR, "budgets"].sort();
  // No path, branch or draft filter stands between any change and the job.
  const on = ci().on;
  for (const filter of ["paths", "paths-ignore", "branches", "branches-ignore"])
    assert.equal(on.pull_request[filter], undefined, filter);
  assert.ok(
    triggered(ci(), { ...pullRequest, changed: ["README.md"], draft: true }),
  );
  assert.deepEqual(requested(pullRequest), every);
  for (const result of ["failure", "cancelled", "skipped"])
    assert.deepEqual(
      requested({
        ...pullRequest,
        results: { "test-linux": result, lint: result },
      }),
      every,
      result,
    );
  assert.deepEqual(requested({ ...pullRequest, fork: true }), every);
});

test("a push to main adds only the budgets job, never cancelled by the next push", () => {
  const push = {
    id: "push",
    event: "push",
    branch: "main",
    ref: "refs/heads/main",
    message: "fix: a change (#1)",
    changed: ["src/lib.rs"],
  };
  assert.ok(triggered(ci(), push));
  assert.deepEqual(requested(push), ["budgets"]);
  assert.deepEqual(ci().on.push.branches, ["main"]);
  assert.match(
    ci().concurrency["cancel-in-progress"],
    /github\.event_name == 'pull_request'/,
  );
  assert.equal(triggered(ci(), { ...push, branch: "feature" }), false);
});

test("the budgets the job adds and changes are as recorded, and no other limit moved", () => {
  const own = read(".github/reporting/budgets.yaml").budgets;
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].command, [
    "onebudgetspec-github-action",
    "telemetry",
    "--metric",
    "report-command-seconds",
    "--input",
    ".telemetry/report-job.json",
  ]);
  assert.deepEqual(
    {
      id: own[0].id,
      labels: own[0].labels,
      threshold: own[0].threshold,
      unit: own[0].unit,
    },
    {
      id: "onepipeline-ui-budget-report-command-seconds",
      labels: ["ci-report"],
      threshold: 120,
      unit: "seconds",
    },
  );
  const root = Object.fromEntries(
    read("budgets.yaml").budgets.map((b) => [b.id, b]),
  );
  const figures = ["bash", "scripts/actions-budget-figures.sh"];
  const notDelivery = [
    "--exclude-workflow",
    "CI cache",
    "--exclude-workflow",
    "CI",
  ];
  for (const [id, args] of [
    [
      "onepipeline-ui-cd-job-time",
      ["longest-job", "--stage", "cd", ...notDelivery],
    ],
    [
      "onepipeline-ui-cd-job-count",
      ["job-count", "--stage", "cd", ...notDelivery],
    ],
    [
      "onepipeline-ui-release-read-requests",
      ["release-read-requests", ...notDelivery],
    ],
    ["onepipeline-ui-ci-check-time", ["longest-job", "--stage", "pr"]],
    ["onepipeline-ui-ci-job-count", ["job-count", "--stage", "pr"]],
  ])
    assert.deepEqual(root[id].command, [...figures, ...args], id);
  const thresholds = Object.fromEntries(
    Object.entries(root).map(([id, budget]) => [id, budget.threshold]),
  );
  assert.deepEqual(thresholds, {
    "onepipeline-ui-ci-check-time": 1800,
    "onepipeline-ui-cd-job-time": 1800,
    "onepipeline-ui-release-cycle-time": 5400,
    "onepipeline-ui-ci-job-count": 5,
    "onepipeline-ui-cd-job-count": 6,
    "onepipeline-ui-release-read-requests": 6,
    "onepipeline-ui-pr-read-requests": 2,
    "onepipeline-ui-gate-time": 1800,
    "onepipeline-ui-nx-cache-use": 100,
    "onepipeline-ui-cache-headroom": 5.5,
  });
});

test("test-linux uploads its targets' results whatever they did, and on a pull request alone", () => {
  assert.deepEqual(resultsUploadProblems(ci()), []);
  const uploadOf = (workflow) =>
    workflow.jobs["test-linux"].steps.find(
      (step) => step.with?.name === "budget-check-results-test-linux",
    );
  for (const [mutate, expected] of [
    [(w) => (uploadOf(w).if = "success()"), /upload if success/],
    [(w) => (uploadOf(w).with.path = "target/"), /reads target/],
    [(w) => (uploadOf(w).with.name = "other"), /0 saved-results uploads/],
    [(w) => delete w.jobs["test-linux"].if, /test-linux runs if undefined/],
    [
      (w) => {
        const steps = w.jobs["test-linux"].steps;
        steps.unshift(steps.splice(steps.indexOf(uploadOf(w)), 1)[0]);
      },
      /before the gate/,
    ],
  ]) {
    const workflow = clone(ci());
    mutate(workflow);
    assert.ok(
      resultsUploadProblems(workflow).some((p) => expected.test(p)),
      String(expected),
    );
  }
});

test("each target that test-linux runs saves its results under the directory it uploads", () => {
  for (const [project, target, saved] of [
    [".github/project.json", "budgets", "github-workflows"],
    [".github/reporting/project.json", "budgets", "report-job"],
    ["pool-maintenance/project.json", "budgets-host", "pool-maintenance"],
  ]) {
    const declared = JSON.parse(readFileSync(project, "utf8")).targets[target];
    const file = `target/budget-results/${saved}.json`;
    assert.match(declared.command, new RegExp(` --save-results ${file}$`));
    assert.deepEqual(declared.outputs, [`{workspaceRoot}/${file}`], project);
  }
});

const OMITTED = [
  "onepipeline-ui-cd-job-time",
  "onepipeline-ui-release-cycle-time",
  "onepipeline-ui-cd-job-count",
  "onepipeline-ui-release-read-requests",
  "onepipeline-ui-pr-read-requests",
  "onepipeline-ui-nx-cache-use",
  "onepipeline-ui-gate-time",
  "dag-ui-settled-requests-per-minute",
  "dag-ui-live-requests-per-minute",
  "dag-ui-live-update-lag-seconds",
  "dag-ui-wire-megabytes-per-minute",
  "dag-ui-server-cpu-cores-per-live-tab",
];

test("exactly the budgets a pull request cannot move carry the label, beside their own", () => {
  const every = [
    "budgets.yaml",
    ".github/budgets.yaml",
    ".github/reporting/budgets.yaml",
    "pool-maintenance/budgets.yaml",
    "apps/dag-ui-e2e/budgets.yaml",
  ].flatMap((file) => read(file).budgets);
  assert.deepEqual(
    every
      .filter((budget) => budget.labels?.includes("not-measured-on-pr"))
      .map((budget) => budget.id)
      .sort(),
    [...OMITTED].sort(),
  );
  const labels = Object.fromEntries(
    every.map((budget) => [budget.id, budget.labels]),
  );
  for (const id of OMITTED.filter((id) => id.startsWith("onepipeline-ui-")))
    assert.deepEqual(
      labels[id],
      [
        id === "onepipeline-ui-gate-time" ? "host-variable" : "release-tail",
        "not-measured-on-pr",
      ],
      id,
    );
  assert.deepEqual(labels["dag-ui-server-cpu-cores-per-live-tab"], [
    "host",
    "not-measured-on-pr",
  ]);
});

// The one target that enforced the dag-ui figures, its own command, over a copy of
// its committed record with one figure raised.
const DAG_UI = [
  [
    "dag-ui-settled-requests-per-minute",
    (v) => (v.settled.requests_per_min = 1000),
  ],
  [
    "dag-ui-live-requests-per-minute",
    (v) => (v.live.requests_per_min = 100000),
  ],
  ["dag-ui-live-update-lag-seconds", (v) => (v.live.lag.p95_s = 100000)],
  ["dag-ui-wire-megabytes-per-minute", (v) => (v.live.mb_per_min = 100000)],
  [
    "dag-ui-server-cpu-cores-per-live-tab",
    (v) => {
      for (const variant of Object.values(v.all))
        if (variant.server_cpu) variant.server_cpu.cores_per_tab = 1000;
    },
  ],
];

test("dag-ui-e2e:budgets still fails on each figure over its line", () => {
  const scratch = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "dag-ui-over-"),
  );
  const tree = join(scratch, "apps/dag-ui-e2e");
  try {
    cpSync("apps/dag-ui-e2e/load", join(tree, "load"), { recursive: true });
    for (const file of ["budgets.yaml", "request-load-budget.mjs"])
      cpSync(`apps/dag-ui-e2e/${file}`, join(tree, file));
    mkdirSync(join(tree, "telemetry"));
    symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
    const { command } = JSON.parse(
      readFileSync("apps/dag-ui-e2e/project.json", "utf8"),
    ).targets.budgets;
    const committed = readFileSync(
      "apps/dag-ui-e2e/telemetry/request-load.json",
      "utf8",
    );
    const check = (record) => {
      writeFileSync(join(tree, "telemetry/request-load.json"), record);
      return spawnSync("bash", ["-c", `${command} --json`], {
        cwd: scratch,
        encoding: "utf8",
      });
    };
    const held = check(committed);
    const before = Object.fromEntries(
      JSON.parse(held.stdout).results.map((result) => [result.id, result]),
    );
    assert.deepEqual(
      Object.keys(before).sort(),
      DAG_UI.map(([id]) => id).sort(),
      held.stderr,
    );
    for (const [id, raise] of DAG_UI) {
      const record = JSON.parse(committed);
      const of = (kind) =>
        Object.values(record.variants).find((v) => v.kind === kind);
      raise({
        settled: of("settled"),
        live: of("live"),
        all: record.variants,
      });
      const over = check(JSON.stringify(record));
      const results = JSON.parse(over.stdout).results;
      assert.equal(over.status, 1, `${id}: ${over.stderr}`);
      assert.equal(
        results.find((result) => result.id === id).verdict,
        "over",
        id,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// This pull request's own run, replayed at the figures script's `gh` boundary, under the
// environment a runner gives the step.
function ownRun(
  id,
  { jobs = JOBS(), status = 0, event = "pull_request" } = {},
) {
  const bin = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "own-run-"),
  );
  try {
    writeFileSync(join(bin, "answer.json"), JSON.stringify(jobs));
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> "${bin}/asked"\n[ ${status} -eq 0 ] || { echo refused >&2; exit ${status}; }\ncat "${bin}/answer.json"\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const ran = spawnSync(
      "node_modules/.bin/onebudgetspec",
      ["check", "budgets.yaml", "--id", id, "--json"],
      {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: process.env.HOME,
          GITHUB_EVENT_NAME: event,
          GITHUB_RUN_ID: "42255859378",
          GITHUB_REPOSITORY: "nickderobertis/onepipeline-ui",
        },
      },
    );
    const asked = existsSync(join(bin, "asked"))
      ? readFileSync(join(bin, "asked"), "utf8").trim().split("\n")
      : [];
    return {
      ...ran,
      asked,
      result: JSON.parse(ran.stdout).results[0],
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}
const JOBS = () =>
  JSON.parse(
    readFileSync(".github/reporting/fixtures/own-run/jobs.json", "utf8"),
  );
const CHECK_TIME = "onepipeline-ui-ci-check-time";
const JOB_COUNT = "onepipeline-ui-ci-job-count";

test("a pull request's CI-time figures are its own run's jobs, from one read", () => {
  const longest = ownRun(CHECK_TIME);
  const count = ownRun(JOB_COUNT);
  for (const [id, { result, asked, status }, figure] of [
    [CHECK_TIME, longest, 981],
    [JOB_COUNT, count, 5],
  ]) {
    console.error(
      `replayed jobs: ${id} ${result.actual} of ${result.threshold}, verdict ${result.verdict}`,
    );
    assert.equal(result.actual, figure, id);
    assert.equal(result.verdict, "within", id);
    assert.equal(status, 0, id);
    assert.deepEqual(
      asked,
      [
        "api repos/nickderobertis/onepipeline-ui/actions/runs/42255859378/jobs?per_page=100&filter=latest",
      ],
      id,
    );
  }
  assert.match(longest.result.detail, /test-windows/);
  assert.match(count.result.detail, /CI: 5/);
});

test("each CI-time figure over its line is the ordinary verdict, and a refused read has none", () => {
  const six = JOBS();
  six.jobs.push({ ...six.jobs[0], name: "another" });
  six.total_count = 6;
  const many = ownRun(JOB_COUNT, { jobs: six });
  assert.equal(many.result.actual, 6);
  assert.equal(many.result.verdict, "over");
  assert.equal(many.status, 1);

  const slow = JOBS();
  slow.jobs[0].started_at = "2026-11-06T16:00:00Z";
  const long = ownRun(CHECK_TIME, { jobs: slow });
  assert.equal(long.result.verdict, "over");
  assert.equal(long.status, 1);

  const refused = ownRun(CHECK_TIME, { status: 1 });
  assert.equal(refused.result.verdict, "error");
  assert.equal(refused.status, 3);
  assert.match(refused.result.error, /check that GH_TOKEN can read/);
});

test("off a pull request's own run the same commands ask nothing of this run", () => {
  const release = ownRun(CHECK_TIME, { event: "release" });
  assert.deepEqual(release.asked, []);
  assert.equal(release.result.verdict, "error");
});
