// ci.yml's `budgets` job, reconciled against the released action's own definition
// (.github/reporting/fixtures, which `report-job:test` holds to the release), and
// resolved through the same workflow graph as the rest of CI: what it runs after,
// when it runs, and the budget records it owns.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  // It builds and tests nothing: a checkout and the action are all of it.
  if (job.steps?.length !== 2)
    problems.push(`budgets has ${job.steps?.length} steps`);
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
  return problems;
}

test.skip("THROWAWAY spike-saved-results: the budgets job is the released action's one job, after the four, on what it declares", () => {
  assert.deepEqual(reportJobProblems(ci()), []);
});

test.skip("THROWAWAY spike-saved-results: a job that parts from the shape or the released definition is refused", () => {
  const cases = [
    [(w) => delete w.jobs.budgets, /no budgets job/],
    [(w) => (w.jobs.budgets.if = "success()"), /runs if success/],
    [(w) => w.jobs.budgets.needs.pop(), /budgets needs/],
    [(w) => w.jobs.budgets.steps.push({ run: "just build" }), /3 steps/],
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
  });
});
