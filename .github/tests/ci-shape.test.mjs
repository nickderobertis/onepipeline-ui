// What runs, across every workflow, on the events a change meets on its way to
// a release — resolved from the workflow files themselves through the same
// graph the macOS budget reads (../workflow-graph.mjs), triggers, job
// conditions and reusable calls included.
//
//   - a pull request's `opened`, `synchronize` and `reopened`: ci.yml's five jobs
//     and nothing else, including a release-plz branch;
//   - a push to `main`: ci.yml's `budgets` alone of its jobs, release-plz.yml,
//     visual-docs.yml's canonical gallery and ci-cache.yml's warm jobs and
//     informational advisories report;
//   - the release commit (the push merging release-plz's pull request): `budgets`,
//     release-plz.yml, the warmer's Linux and Windows jobs and the advisories report,
//     never visual-docs.yml or a Mac job;
//   - the Release: release.yml alone.
//
// It also holds visual-docs.yml to its remaining triggers, and the set of
// workflows to the ones this repository's CI/CD shape names, with release-plz.yml
// unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  evaluate,
  interpolate,
  resolveWorkflow,
  triggered,
} from "../workflow-graph.mjs";

const load = () =>
  readdirSync(".github/workflows")
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({
      file,
      text: readFileSync(`.github/workflows/${file}`, "utf8"),
      document: parse(readFileSync(`.github/workflows/${file}`, "utf8")),
    }));

const FIVE = ["lint", "test-linux", "test-windows", "test-macos", "budgets"];
const RELEASE_MERGE = {
  message: "chore: release v0.64.0 (#564)",
  changed: ["CHANGELOG.md", "Cargo.toml", "Cargo.lock"],
};
const ORDINARY_MERGE = {
  message: "fix(ci): something (#566)",
  changed: ["src/lib.rs", "CHANGELOG.md"],
};

// The requested jobs of every workflow a scenario starts, as `file job` rows.
export function started(workflows, scenario) {
  return workflows
    .filter(({ document }) => triggered(document, scenario))
    .flatMap(({ file, document }) =>
      resolveWorkflow(file, document, scenario, { macosRequired: true })
        .filter((row) => row.requested)
        .map((row) => `${file} ${row.job}`),
    )
    .sort();
}

const pr = (action, headRef = "feature") => ({
  id: `pr-${action}-${headRef}`,
  event: "pull_request",
  action,
  branch: "main",
  ref: "refs/pull/1/merge",
  headRef,
});
const push = (what) => ({
  id: `push-${what.message}`,
  event: "push",
  branch: "main",
  ref: "refs/heads/main",
  ...what,
});

export function shapeProblems(workflows) {
  const problems = [];
  const expect = (scenario, wanted) => {
    const got = started(workflows, scenario);
    if (JSON.stringify(got) !== JSON.stringify([...wanted].sort()))
      problems.push(`${scenario.id} starts ${JSON.stringify(got)}`);
  };
  for (const action of ["opened", "synchronize", "reopened"]) {
    expect(
      pr(action),
      FIVE.map((job) => `ci.yml ${job}`),
    );
    expect(
      pr(action, "release-plz-2026-11-01T03-00-00Z"),
      FIVE.map((job) => `ci.yml ${job}`),
    );
  }
  const pushWorkflows = (scenario) =>
    [
      ...new Set(started(workflows, scenario).map((row) => row.split(" ")[0])),
    ].sort();
  const ordinary = pushWorkflows(push(ORDINARY_MERGE));
  if (
    JSON.stringify(ordinary) !==
    JSON.stringify([
      "ci-cache.yml",
      "ci.yml",
      "release-plz.yml",
      "visual-docs.yml",
    ])
  )
    problems.push(`a push to main starts ${JSON.stringify(ordinary)}`);
  expect(push(RELEASE_MERGE), [
    "ci-cache.yml advisories",
    "ci-cache.yml warm-linux",
    "ci-cache.yml warm-windows",
    "ci.yml budgets",
    "release-plz.yml release-plz",
  ]);
  const onCi = started(workflows, push(ORDINARY_MERGE)).filter((row) =>
    row.startsWith("ci.yml "),
  );
  if (JSON.stringify(onCi) !== JSON.stringify(["ci.yml budgets"]))
    problems.push(`a push to main starts ${JSON.stringify(onCi)} of ci.yml`);
  const releaseRun = started(workflows, {
    id: "release-published",
    event: "release",
    action: "published",
    ref: "refs/tags/v0.64.0",
  });
  // With release-plz's job at the release commit, the six CD jobs.
  const cd = [
    "release.yml build-linux",
    "release.yml build-linux-arm64",
    "release.yml build-macos",
    "release.yml build-windows",
    "release.yml publish",
  ];
  if (JSON.stringify(releaseRun) !== JSON.stringify(cd))
    problems.push(`the Release starts ${JSON.stringify(releaseRun)}`);
  // visual-docs.yml keeps the runs nothing else makes.
  const visual =
    workflows.find((w) => w.file === "visual-docs.yml")?.document?.on ?? {};
  if (JSON.stringify(visual.pull_request?.types) !== '["closed"]')
    problems.push(
      "visual-docs.yml no longer runs on a pull request's closed alone",
    );
  if (!Array.isArray(visual.schedule) || visual.schedule.length === 0)
    problems.push("visual-docs.yml lost its schedule");
  if (!("workflow_dispatch" in visual))
    problems.push("visual-docs.yml lost workflow_dispatch");
  if (JSON.stringify(visual.push?.branches) !== '["main"]')
    problems.push("visual-docs.yml no longer redeploys main's gallery");
  // The workflows are the ones this shape names, and release-plz.yml is unchanged.
  const files = workflows.map((w) => w.file).sort();
  const named = [
    "ci-cache.yml",
    "ci.yml",
    "release-plz.yml",
    "release.yml",
    "visual-docs.yml",
  ];
  if (JSON.stringify(files) !== JSON.stringify(named))
    problems.push(`the workflows are ${JSON.stringify(files)}`);
  const plz = workflows.find((w) => w.file === "release-plz.yml");
  if (
    plz &&
    createHash("sha256").update(plz.text).digest("hex") !== RELEASE_PLZ_SHA256
  )
    problems.push("release-plz.yml changed");
  return problems;
}
// release-plz.yml's digest: the release workflow is an interface other work builds
// against, so any edit to it has to be made here too, on purpose.
const RELEASE_PLZ_SHA256 =
  "b9c57fdf35411e913df499ae0dee958a93a3eeb31ab8d9dbb7a992dafc4856a3";

test("a pull request runs the five jobs, main and the release commit run only what they name", () => {
  assert.deepEqual(shapeProblems(load()), []);
});

test("another workflow or job on a pull request or the release commit, or a lost trigger, is refused", () => {
  const edit = (file, change) => {
    const workflows = load().map((w) => ({
      ...w,
      document: structuredClone(w.document),
    }));
    change(workflows.find((w) => w.file === file)?.document, workflows);
    return shapeProblems(workflows);
  };
  const cases = [
    [
      edit("ci.yml", (d) => {
        d.jobs.extra = { "runs-on": "ubuntu-latest", steps: [] };
      }),
      /^pr-synchronize-feature starts .*ci\.yml extra/,
    ],
    [
      edit("visual-docs.yml", (d) => {
        d.on.pull_request.types.push("synchronize");
      }),
      /^pr-synchronize-feature starts .*visual-docs\.yml/,
    ],
    [
      edit("ci.yml", (d) => {
        delete d.jobs.lint.if;
      }),
      /^a push to main starts .*ci\.yml lint.* of ci\.yml$/,
    ],
    [
      edit("ci.yml", (d) => {
        delete d.on.push;
      }),
      /^a push to main starts \["ci-cache\.yml","release-plz\.yml","visual-docs\.yml"\]/,
    ],
    [
      edit("visual-docs.yml", (d) => {
        delete d.on.push["paths-ignore"];
      }),
      /^push-chore: release v0\.64\.0 \(#564\) starts .*visual-docs\.yml/,
    ],
    [
      edit("ci-cache.yml", (d) => {
        delete d.jobs["warm-macos"].if;
      }),
      /^push-chore: release v0\.64\.0 \(#564\) starts .*warm-macos/,
    ],
    [
      edit("visual-docs.yml", (d) => {
        delete d.on.schedule;
      }),
      /^visual-docs\.yml lost its schedule$/,
    ],
    [
      edit("visual-docs.yml", (d) => {
        delete d.on.workflow_dispatch;
      }),
      /^visual-docs\.yml lost workflow_dispatch$/,
    ],
    [
      edit("visual-docs.yml", (d) => {
        d.on.pull_request.types = ["opened"];
      }),
      /^visual-docs\.yml no longer runs on a pull request's closed alone$/,
    ],
    [
      edit("release-plz.yml", (_d, workflows) => {
        const plz = workflows.find((w) => w.file === "release-plz.yml");
        plz.text += "# changed\n";
      }),
      /^release-plz\.yml changed$/,
    ],
    [
      edit("ci.yml", (_d, workflows) => {
        workflows.push({
          file: "notignored.yml",
          text: "",
          document: {
            on: { pull_request: {} },
            jobs: { suppressions: { "runs-on": "ubuntu-latest", steps: [] } },
          },
        });
      }),
      /^pr-opened-feature starts .*notignored\.yml suppressions/,
    ],
  ];
  for (const [problems, expected] of cases)
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${expected}: ${problems}`,
    );
});

test("lifting a draft starts nothing: its runs already report on its head commit", () => {
  assert.deepEqual(started(load(), pr("ready_for_review")), []);
});

// The suppressions comment, a step of `lint`, as its own condition decides: on
// a same-repository pull request and never a fork's, whose token cannot comment.
test("the suppressions comment runs on a same-repository pull request and skips a fork's", () => {
  const lint = load().find((w) => w.file === "ci.yml").document.jobs.lint;
  const step = lint.steps.find((s) =>
    (s.uses ?? "").startsWith("nickderobertis/notignored@"),
  );
  assert.ok(step, "lint does not run notignored");
  const runs = (repository) =>
    evaluate(step.if, {
      github: {
        event_name: "pull_request",
        repository: "nickderobertis/onepipeline-ui",
        event: { pull_request: { head: { repo: { full_name: repository } } } },
      },
    }).value;
  assert.equal(runs("nickderobertis/onepipeline-ui"), true);
  assert.equal(runs("fork/onepipeline-ui"), false);
  assert.equal(lint.permissions["pull-requests"], "write");
});

// test-linux's tier step, run as Actions runs it, and the recipe step it feeds,
// resolved with that step's real output.
test("test-linux runs its recipe on the tier its own step asks scripts/ci-tier.sh for", () => {
  const steps = load().find((w) => w.file === "ci.yml").document.jobs[
    "test-linux"
  ].steps;
  const tierStep = steps.findIndex((s) => s.id === "tier");
  const recipe = steps.findIndex((s) =>
    /^just ci-test-linux\b/.test(s.run ?? ""),
  );
  assert.ok(
    tierStep >= 0 && recipe > tierStep,
    "test-linux asks its tier after running its recipe",
  );
  const dir = mkdtempSync(join(tmpdir(), "ci-tier-"));
  try {
    for (const [headRef, tier] of [
      ["release-plz-2026-11-01T03-00-00Z", "broader"],
      ["feature", "affected"],
    ]) {
      const output = join(dir, `output-${tier}`);
      writeFileSync(output, "");
      execFileSync("bash", ["-eo", "pipefail", "-c", steps[tierStep].run], {
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_HEAD_REF: headRef,
          GITHUB_OUTPUT: output,
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      assert.equal(outputs.tier, tier);
      assert.equal(
        interpolate(steps[recipe].run, { steps: { tier: { outputs } } }).trim(),
        `just ci-test-linux --tier "${tier}"`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
