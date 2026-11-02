// The advisories report against the committed check contract
// (../required-contexts.mjs): it reports on every pull request and on `main`,
// and nothing that blocks a change or a release runs it, needs it, or waits on
// its result.
//
//   - on a pull request it is one step of ci.yml's `lint`, posting the
//     `advisories` commit status on the head: `continue-on-error`, so its result
//     can never fail `lint`, and `!cancelled()`, so it posts whatever the steps
//     before it did — and no other step reads its outcome;
//   - on `main` it is ci-cache.yml's `advisories` job, which no job needs;
//   - the blocking audit `lint` runs (`just deps-check`'s recipe) is `check`, not
//     the report, and no informational context is required.
//
// Reads `.github/`, the justfile's recipes and nothing else. Every rule is shown
// failing on a copy of the real files with exactly the defect it names.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  INFORMATIONAL_CONTEXTS,
  REQUIRED_CONTEXTS,
} from "../required-contexts.mjs";

const CONTEXT = "advisories";
const REPORT =
  /\bjust advisories-(report|status)\b|deps-audit\.mjs"? (report|status)\b/;
const PR_HEAD = "github.event.pull_request.head.sha";
const PR_HEAD_REPO = "github.event.pull_request.head.repo.full_name";
// The step's one command: the head, and the repository it lives in, which is how
// the recipe tells a fork's pull request (summary and log, no status) apart.
const STATUS_RUN = 'just advisories-status "$HEAD_SHA" "$HEAD_REPO"';
// A workflow expression, spelled without a literal `${` in this file.
const expression = (inner) => `$${"{{"} ${inner} }}`;

function load() {
  const workflows = Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [
        file,
        parse(readFileSync(`.github/workflows/${file}`, "utf8")),
      ]),
  );
  return {
    workflows,
    justfile: readFileSync("justfile", "utf8"),
    contract: {
      required: [...REQUIRED_CONTEXTS],
      informational: [...INFORMATIONAL_CONTEXTS],
      text: readFileSync(".github/required-contexts.mjs", "utf8"),
    },
  };
}

// A recipe's body: the indented lines under its header.
function recipe(justfile, name) {
  const lines = justfile.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^@?${name}\\b[^:]*:`).test(line),
  );
  if (start < 0) return undefined;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    body.push(line.trim());
  }
  return body.join("\n");
}

const needsOf = (job) =>
  job?.needs === undefined ? [] : [job.needs].flat().map(String);

export function advisoriesProblems({ workflows, justfile, contract }) {
  const problems = [];

  // The contract: the report's context is informational and never required.
  if (!contract.informational.includes(CONTEXT))
    problems.push(
      `the check contract does not list ${CONTEXT} as informational`,
    );
  for (const context of contract.informational)
    if (contract.required.includes(context))
      problems.push(`the check contract lists ${context} as blocking`);

  // On a pull request: one step of `lint`, whose result can never fail it.
  const lint = workflows["ci.yml"]?.jobs?.lint;
  const steps = lint?.steps ?? [];
  const reporting = steps.filter((step) => REPORT.test(step.run ?? ""));
  if (reporting.length !== 1)
    problems.push(
      `lint runs the advisories report in ${reporting.length} steps, not one`,
    );
  for (const step of reporting) {
    const label = step.name ?? step.run;
    if (step["continue-on-error"] !== true)
      problems.push(`lint's step ${label} can fail the lint job`);
    if (step.if !== expression("!cancelled()") && step.if !== "always()")
      problems.push(
        `lint's step ${label} is not posted whatever the steps before it did`,
      );
    if (!/\bjust advisories-status\b/.test(step.run))
      problems.push(`lint's step ${label} posts no ${CONTEXT} status`);
    if (step.env?.HEAD_SHA !== expression(PR_HEAD))
      problems.push(
        `lint's step ${label} does not post on the pull request's head`,
      );
    // A fork's pull request runs this step too and reads the report in its
    // summary and log: the step names the head's repository rather than being
    // skipped there.
    if (step.env?.HEAD_REPO !== expression(PR_HEAD_REPO))
      problems.push(
        `lint's step ${label} does not name the repository the head lives in`,
      );
    if (step.run.trim() !== STATUS_RUN)
      problems.push(`lint's step ${label} does not run '${STATUS_RUN}'`);
    if (step.id) {
      const reads = new RegExp(`steps\\.${step.id}\\.`);
      for (const other of steps)
        if (other !== step && reads.test(JSON.stringify(other)))
          problems.push(
            `lint's step ${other.name ?? other.run} waits on the advisories report`,
          );
    }
  }
  if (lint?.permissions?.statuses !== "write")
    problems.push(`lint's token cannot post the ${CONTEXT} status`);

  // The recipe hands the head's repository to the script, which skips posting
  // for a fork; the contract says where a fork's pull request reads the report.
  const posting = recipe(justfile, "advisories-status");
  if (!posting || !/status --sha "\$1" --head-repo "\$2"/.test(posting))
    problems.push("advisories-status does not pass the head's repository on");
  if (!/fork[\s\S]*no status[\s\S]*step summary and log/.test(contract.text))
    problems.push(
      "the check contract does not say a fork's pull request gets the report in lint's step summary and log, not a status",
    );

  // The blocking audit `lint` runs is the split check, never the report.
  const blocking = recipe(justfile, "_crate-deps-check");
  if (!blocking) problems.push("the justfile has no _crate-deps-check recipe");
  else {
    if (!/deps-audit\.mjs"? check\b/.test(blocking))
      problems.push("_crate-deps-check does not run the blocking audit");
    if (REPORT.test(blocking))
      problems.push("_crate-deps-check runs the advisories report");
  }

  // On `main`: ci-cache.yml's job, on every push to it.
  const cache = workflows["ci-cache.yml"];
  const job = cache?.jobs?.[CONTEXT];
  if (!job) problems.push(`ci-cache.yml has no ${CONTEXT} job`);
  else {
    if (!(cache.on?.push?.branches ?? []).includes("main"))
      problems.push(`ci-cache.yml's ${CONTEXT} job does not run on main`);
    if ("if" in job)
      problems.push(`ci-cache.yml's ${CONTEXT} job skips some pushes to main`);
    if (
      !(job.steps ?? []).some((s) =>
        /^just advisories-report\b/.test(s.run ?? ""),
      )
    )
      problems.push(`ci-cache.yml's ${CONTEXT} job does not run the report`);
  }

  // Nothing anywhere runs the report as anything else, needs it, or waits on it.
  for (const [file, document] of Object.entries(workflows)) {
    const runs = document?.on?.workflow_run?.workflows;
    if (runs && [runs].flat().includes(cache?.name))
      problems.push(`${file} waits on ${cache?.name}, which runs the report`);
    for (const [id, other] of Object.entries(document?.jobs ?? {})) {
      if (file === "ci-cache.yml" && needsOf(other).includes(CONTEXT))
        problems.push(`${file} job ${id} needs the ${CONTEXT} job`);
      if (file === "ci.yml" && id === "lint") continue;
      if (file === "ci-cache.yml" && id === CONTEXT) continue;
      if ((other.steps ?? []).some((step) => REPORT.test(step.run ?? "")))
        problems.push(`${file} job ${id} runs the advisories report`);
    }
  }
  return problems;
}

const copy = (files) => structuredClone(files);
const reportStep = (files) =>
  files.workflows["ci.yml"].jobs.lint.steps.find((step) =>
    REPORT.test(step.run ?? ""),
  );

test("the advisories report runs on every pull request and on main, and blocks nothing", () => {
  assert.deepEqual(advisoriesProblems(load()), []);
});

test("a report that can block, waits, hides or goes missing is refused", () => {
  const cases = [
    [
      (f) => {
        f.contract.required.push(CONTEXT);
      },
      "the check contract lists advisories as blocking",
    ],
    [
      (f) => {
        f.contract.informational = [];
      },
      "the check contract does not list advisories as informational",
    ],
    [
      (f) => {
        delete reportStep(f)["continue-on-error"];
      },
      /^lint's step .* can fail the lint job$/,
    ],
    [
      (f) => {
        reportStep(f).if = "success()";
      },
      /^lint's step .* is not posted whatever the steps before it did$/,
    ],
    [
      (f) => {
        const steps = f.workflows["ci.yml"].jobs.lint.steps;
        steps.splice(steps.indexOf(reportStep(f)), 1);
      },
      "lint runs the advisories report in 0 steps, not one",
    ],
    [
      (f) => {
        reportStep(f).run = "just advisories-report";
      },
      /^lint's step .* posts no advisories status$/,
    ],
    [
      (f) => {
        reportStep(f).env.HEAD_SHA = expression("github.sha");
      },
      /^lint's step .* does not post on the pull request's head$/,
    ],
    [
      (f) => {
        delete reportStep(f).env.HEAD_REPO;
      },
      /^lint's step .* does not name the repository the head lives in$/,
    ],
    [
      (f) => {
        reportStep(f).run =
          'just advisories-status "$HEAD_SHA" "$GITHUB_REPOSITORY"';
      },
      /^lint's step .* does not run 'just advisories-status "\$HEAD_SHA" "\$HEAD_REPO"'$/,
    ],
    [
      (f) => {
        reportStep(f).if = expression(
          "!cancelled() && github.event.pull_request.head.repo.full_name == github.repository",
        );
      },
      /^lint's step .* is not posted whatever the steps before it did$/,
    ],
    [
      (f) => {
        f.justfile = f.justfile.replace(' --head-repo "$2"', "");
      },
      "advisories-status does not pass the head's repository on",
    ],
    [
      (f) => {
        f.contract.text = f.contract.text.replace(/fork/g, "branch");
      },
      /^the check contract does not say a fork's pull request/,
    ],
    [
      (f) => {
        reportStep(f).id = "advisories";
        f.workflows["ci.yml"].jobs.lint.steps.push({
          name: "Gate on the report",
          if: "steps.advisories.outcome == 'failure'",
          run: "exit 1",
        });
      },
      "lint's step Gate on the report waits on the advisories report",
    ],
    [
      (f) => {
        delete f.workflows["ci.yml"].jobs.lint.permissions.statuses;
      },
      "lint's token cannot post the advisories status",
    ],
    [
      (f) => {
        f.justfile = f.justfile.replace(
          /(\n_crate-deps-check:[^\n]*\n)/,
          "$1    @just advisories-report\n",
        );
      },
      "_crate-deps-check runs the advisories report",
    ],
    [
      (f) => {
        delete f.workflows["ci-cache.yml"].jobs[CONTEXT];
      },
      "ci-cache.yml has no advisories job",
    ],
    [
      (f) => {
        f.workflows["ci-cache.yml"].jobs[CONTEXT].if =
          "!startsWith(github.event.head_commit.message, 'chore: release v')";
      },
      "ci-cache.yml's advisories job skips some pushes to main",
    ],
    [
      (f) => {
        f.workflows["ci-cache.yml"].jobs["warm-linux"].needs = [CONTEXT];
      },
      "ci-cache.yml job warm-linux needs the advisories job",
    ],
    [
      (f) => {
        f.workflows["release.yml"].jobs.publish.steps.push({
          run: "just advisories-report",
        });
      },
      "release.yml job publish runs the advisories report",
    ],
    [
      (f) => {
        f.workflows["ci.yml"].jobs["test-linux"].steps.push({
          run: 'just advisories-status "$HEAD_SHA"',
        });
      },
      "ci.yml job test-linux runs the advisories report",
    ],
    [
      (f) => {
        f.workflows["release.yml"].on = {
          workflow_run: { workflows: ["CI cache"], types: ["completed"] },
        };
      },
      "release.yml waits on CI cache, which runs the report",
    ],
  ];
  for (const [change, expected] of cases) {
    const files = copy(load());
    change(files);
    const problems = advisoriesProblems(files);
    assert.ok(
      problems.some((p) =>
        typeof expected === "string" ? p === expected : expected.test(p),
      ),
      `${expected}: ${JSON.stringify(problems)}`,
    );
  }
});
