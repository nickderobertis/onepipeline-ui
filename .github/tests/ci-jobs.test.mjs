// The four pull-request jobs other work builds against — `lint`, `test-linux`,
// `test-windows`, `test-macos` — the jobs behind today's required contexts, and
// the keys of every cache a workflow restores.
//
// Reads `.github/workflows` and nothing outside `.github/`, which is what lets
// `github-workflows:test-ci-jobs` key on this directory alone. Each rule is a
// function over parsed workflows, so every rule is shown failing on a copy of
// the real workflows with exactly the defect it names, as well as passing on the
// real ones.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { REQUIRED_CONTEXTS } from "../required-contexts.mjs";

function load() {
  return Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [
        file,
        parse(readFileSync(`.github/workflows/${file}`, "utf8")),
      ]),
  );
}

// The shared interface: each id, the runner its name says, and a 30-minute cap.
const FOUR = {
  lint: "ubuntu-latest",
  "test-linux": "ubuntu-latest",
  "test-windows": "windows-latest",
  "test-macos": "macos-latest",
};
// The one job condition the four may carry: `test-macos` never starts on a
// same-repository release-plz branch, whose version-only diff the Mac policy
// lets skip, which keeps the macOS runs-per-change budget at two.
const MAC_CONDITION =
  "github.event_name == 'pull_request' && !(startsWith(github.head_ref, 'release-plz-') && github.event.pull_request.head.repo.full_name == github.repository)";
const REUSABLE =
  "nickderobertis/screencomp/.github/workflows/visual-docs-reusable.yml";
const COMPOSITES = [
  "nickderobertis/screencomp@",
  "nickderobertis/screencomp/visual-docs@",
  "nickderobertis/screencomp/visual-docs-pages@",
  "nickderobertis/screencomp/visual-docs-aggregate@",
];

export function jobProblems(workflows) {
  const problems = [];
  const ci = workflows["ci.yml"];
  const triggers = ci?.on ?? {};
  if (!("pull_request" in triggers))
    problems.push("ci.yml does not run on pull_request");
  const types = triggers.pull_request?.types;
  if (
    types &&
    !["opened", "synchronize", "reopened"].every((t) => types.includes(t))
  )
    problems.push(
      "ci.yml's pull_request trigger drops one of GitHub's default types",
    );
  for (const [id, runner] of Object.entries(FOUR)) {
    const job = ci?.jobs?.[id];
    if (!job) {
      problems.push(`job ${id} is missing`);
      continue;
    }
    if ("name" in job) problems.push(`job ${id} overrides its name`);
    if ("needs" in job) problems.push(`job ${id} has a needs edge`);
    if (job["timeout-minutes"] !== 30)
      problems.push(
        `job ${id} has timeout-minutes ${job["timeout-minutes"]}, not 30`,
      );
    if (job["runs-on"] !== runner)
      problems.push(`job ${id} runs on ${job["runs-on"]}, not ${runner}`);
    const allowed = id === "test-macos" ? MAC_CONDITION : undefined;
    if (job.if !== allowed)
      problems.push(`job ${id} has the condition ${JSON.stringify(job.if)}`);
    const recipe = `just ci-${id}`;
    if (
      !(job.steps ?? []).some((step) =>
        (step.run ?? "").trim().startsWith(recipe),
      )
    )
      problems.push(`job ${id} does not run its recipe '${recipe}'`);
  }
  // The visual docs: steps of `lint` through screencomp's composite actions,
  // never a call to the reusable workflow from ci.yml.
  for (const [id, job] of Object.entries(ci?.jobs ?? {}))
    if (typeof job.uses === "string" && job.uses.startsWith(REUSABLE))
      problems.push(`ci.yml job ${id} calls the reusable visual-docs workflow`);
  const lintSteps = ci?.jobs?.lint?.steps ?? [];
  for (const action of COMPOSITES)
    if (!lintSteps.some((step) => (step.uses ?? "").startsWith(action)))
      problems.push(`lint does not use ${action}`);
  if (!lintSteps.some((step) => /^just dag-ui-screens\b/.test(step.run ?? "")))
    problems.push("the visual docs capture is not a step of lint");
  for (const [id, job] of Object.entries(ci?.jobs ?? {}))
    if (
      id !== "lint" &&
      (job.steps ?? []).some(
        (step) =>
          /\bdag-ui-screens\b/.test(step.run ?? "") ||
          COMPOSITES.some((action) => (step.uses ?? "").startsWith(action)),
      )
    )
      problems.push(`the visual docs run in ci.yml job ${id}, not lint`);
  return problems;
}

// Each context branch protection requires today (../required-contexts.mjs),
// and the job that reports it:
// a job id with no name override reports under its id, a matrix leg as
// `id (value)`, and the visual-docs context as the caller job's id, then the
// reusable workflow's `report` leg, named from the defaults it is not passed.
const REQUIRED = {
  gate: { file: "ci.yml", job: "gate" },
  deny: { file: "ci.yml", job: "deny" },
  "pr-title": { file: "ci.yml", job: "pr-title" },
  llmlint: { file: "ci.yml", job: "llmlint" },
  msrv: { file: "ci.yml", job: "msrv" },
  "cross (windows-latest)": {
    file: "ci.yml",
    job: "cross",
    os: "windows-latest",
  },
  "install (ubuntu-latest)": {
    file: "ci.yml",
    job: "install",
    os: "ubuntu-latest",
  },
  "install (windows-latest)": {
    file: "ci.yml",
    job: "install",
    os: "windows-latest",
  },
  "visual-docs / report (x86_64, shots/current, shots/verify, Visual docs)": {
    file: "visual-docs.yml",
    job: "visual-docs",
    reusable: true,
  },
};

export function requiredContextProblems(workflows) {
  const problems = [];
  for (const [context, where] of Object.entries(REQUIRED)) {
    const job = workflows[where.file]?.jobs?.[where.job];
    if (!job) {
      problems.push(
        `${context}: job ${where.job} is missing from ${where.file}`,
      );
      continue;
    }
    if ("name" in job)
      problems.push(`${context}: job ${where.job} overrides its name`);
    if (where.os && !(job.strategy?.matrix?.os ?? []).includes(where.os))
      problems.push(`${context}: job ${where.job} has no ${where.os} leg`);
    if (where.reusable) {
      if (!(job.uses ?? "").startsWith(`${REUSABLE}@`))
        problems.push(
          `${context}: job ${where.job} no longer calls the reusable workflow`,
        );
      for (const input of ["gallery-title", "projects", "arches"])
        if (job.with && input in job.with)
          problems.push(
            `${context}: job ${where.job} passes ${input}, which renames the context`,
          );
      if (!("pull_request" in (workflows[where.file]?.on ?? {})))
        problems.push(
          `${context}: ${where.file} no longer runs on pull_request`,
        );
    }
  }
  return problems;
}

// What each restored cache was produced from, which its key must name: the
// runner's OS and architecture always, every pinned file listed, and the value
// read off the lockfile (or the commit) by the step that reads it there.
const CACHES = {
  ".tools/bin/onepipeline": {
    files: ["rust-toolchain.toml", "scripts/ensure-sibling.sh"],
    output: {
      step: "pins",
      name: "onepipeline",
      reads: /just --evaluate onepipeline-version/,
    },
  },
  ".tools/bin/onepipeline.exe": {
    files: ["rust-toolchain.toml", "scripts/ensure-sibling.sh"],
    output: {
      step: "pins",
      name: "onepipeline",
      reads: /just --evaluate onepipeline-version/,
    },
  },
  ".tools/bin/onepipeline-api-baseline": {
    files: ["rust-toolchain.toml", "scripts/ensure-baseline-api.sh"],
    output: {
      step: "pins",
      name: "base",
      reads: /git merge-base HEAD origin\/main/,
    },
  },
};

export function cacheProblems(workflows) {
  const problems = [];
  for (const [file, document] of Object.entries(workflows))
    for (const [id, job] of Object.entries(document?.jobs ?? {}))
      for (const step of job.steps ?? []) {
        if (!/^actions\/cache(\/restore)?@/.test(step.uses ?? "")) continue;
        const where = `${file} ${id}`;
        const key = String(step.with?.key ?? "");
        const paths = String(step.with?.path ?? "")
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean);
        if (step.with?.["restore-keys"])
          problems.push(
            `${where}: restore-keys would serve a cache from other inputs`,
          );
        for (const part of ["runner.os", "runner.arch"])
          if (!key.includes(part)) problems.push(`${where}: key omits ${part}`);
        const declared = paths.map((path) => CACHES[path]).find(Boolean);
        if (!declared) {
          problems.push(
            `${where}: no declared inputs for cached ${paths.join(", ")}`,
          );
          continue;
        }
        const hashed = [...key.matchAll(/hashFiles\(([^)]*)\)/g)]
          .flatMap((match) => match[1].split(","))
          .map((name) => name.trim().replace(/^'|'$/g, ""));
        for (const pinned of declared.files)
          if (!hashed.includes(pinned))
            problems.push(`${where}: key omits ${pinned}`);
        const { step: producer, name, reads } = declared.output;
        if (!key.includes(`steps.${producer}.outputs.${name}`))
          problems.push(
            `${where}: key omits steps.${producer}.outputs.${name}`,
          );
        const source = (job.steps ?? []).find((s) => s.id === producer);
        if (!source || !reads.test(source.run ?? ""))
          problems.push(
            `${where}: step ${producer} does not read ${name} where the recipe does`,
          );
      }
  return problems;
}

const clone = (workflows) => structuredClone(workflows);
// A workflow expression, spelled without a literal `${` in this file.
const expression = (inner) => `$${"{{"} ${inner} }}`;

test("the four jobs are in place with their ids, runners, caps and recipes", () => {
  assert.deepEqual(jobProblems(load()), []);
});

test("a missing, renamed, waiting or uncapped job is refused", () => {
  const cases = [
    [
      (w) => delete w["ci.yml"].jobs["test-windows"],
      "job test-windows is missing",
    ],
    [
      (w) => {
        w["ci.yml"].jobs.lint.name = "Lint";
      },
      "job lint overrides its name",
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"].needs = ["changes"];
      },
      "job test-linux has a needs edge",
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-macos"]["timeout-minutes"] = 45;
      },
      "job test-macos has timeout-minutes 45, not 30",
    ],
    [
      (w) => {
        delete w["ci.yml"].jobs.lint["timeout-minutes"];
      },
      "job lint has timeout-minutes undefined, not 30",
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-windows"]["runs-on"] = "ubuntu-latest";
      },
      "job test-windows runs on ubuntu-latest, not windows-latest",
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"].if = "github.event_name == 'push'";
      },
      `job test-linux has the condition "github.event_name == 'push'"`,
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"].steps = w["ci.yml"].jobs[
          "test-linux"
        ].steps.filter((s) => !(s.run ?? "").startsWith("just ci-test-linux"));
      },
      "job test-linux does not run its recipe 'just ci-test-linux'",
    ],
  ];
  for (const [mutate, problem] of cases) {
    const workflows = clone(load());
    mutate(workflows);
    assert.ok(
      jobProblems(workflows).includes(problem),
      `${problem}: ${jobProblems(workflows)}`,
    );
  }
});

test("the visual docs capture leaving lint, or running through the reusable workflow, is refused", () => {
  const moved = clone(load());
  const lint = moved["ci.yml"].jobs.lint;
  const capture = lint.steps.filter((s) => /dag-ui-screens/.test(s.run ?? ""));
  lint.steps = lint.steps.filter((s) => !/dag-ui-screens/.test(s.run ?? ""));
  moved["ci.yml"].jobs["test-linux"].steps.push(...capture);
  const problems = jobProblems(moved);
  assert.ok(
    problems.includes("the visual docs capture is not a step of lint"),
    problems,
  );
  assert.ok(
    problems.includes("the visual docs run in ci.yml job test-linux, not lint"),
    problems,
  );

  const reusable = clone(load());
  reusable["ci.yml"].jobs["visual-docs"] = {
    uses: `${REUSABLE}@v0.4.8`,
    with: { "capture-command": "just dag-ui-screens" },
  };
  reusable["ci.yml"].jobs.lint.steps = reusable[
    "ci.yml"
  ].jobs.lint.steps.filter(
    (s) => !(s.uses ?? "").startsWith("nickderobertis/screencomp/visual-docs@"),
  );
  const called = jobProblems(reusable);
  assert.ok(
    called.includes(
      "ci.yml job visual-docs calls the reusable visual-docs workflow",
    ),
    called,
  );
  assert.ok(
    called.includes("lint does not use nickderobertis/screencomp/visual-docs@"),
    called,
  );
});

test("every job behind today's required contexts is still in place", () => {
  assert.deepEqual(Object.keys(REQUIRED).sort(), [...REQUIRED_CONTEXTS].sort());
  assert.deepEqual(requiredContextProblems(load()), []);
  for (const [context, where] of Object.entries(REQUIRED)) {
    const workflows = clone(load());
    delete workflows[where.file].jobs[where.job];
    assert.ok(
      requiredContextProblems(workflows).includes(
        `${context}: job ${where.job} is missing from ${where.file}`,
      ),
      context,
    );
  }
  const workflows = clone(load());
  workflows["ci.yml"].jobs.install.strategy.matrix.os = ["ubuntu-latest"];
  workflows["visual-docs.yml"].jobs["visual-docs"].with["gallery-title"] =
    "Docs";
  const problems = requiredContextProblems(workflows);
  assert.ok(
    problems.includes(
      "install (windows-latest): job install has no windows-latest leg",
    ),
    problems,
  );
  assert.ok(
    problems.some((p) =>
      p.endsWith("passes gallery-title, which renames the context"),
    ),
    problems,
  );
});

test("every restored cache is keyed on what produced it", () => {
  const workflows = load();
  assert.deepEqual(cacheProblems(workflows), []);
  const caches = Object.values(workflows["ci.yml"].jobs).flatMap((job) =>
    (job.steps ?? []).filter((s) =>
      (s.uses ?? "").startsWith("actions/cache@"),
    ),
  );
  // The sibling on all three platforms and the baseline server on Linux.
  assert.equal(caches.length, 4);
});

test("a cache key that omits the lockfile pin or a pinned tool is refused", () => {
  const firstCache = (w, path) =>
    Object.values(w["ci.yml"].jobs)
      .flatMap((job) => job.steps ?? [])
      .find(
        (s) =>
          (s.uses ?? "").startsWith("actions/cache@") &&
          s.with.path.includes(path),
      );
  const cases = [
    [
      ".tools/bin/onepipeline\n",
      `-${expression("steps.pins.outputs.onepipeline")}`,
      "key omits steps.pins.outputs.onepipeline",
    ],
    [
      "onepipeline-api-baseline",
      `-${expression("steps.pins.outputs.base")}`,
      "key omits steps.pins.outputs.base",
    ],
    [
      ".tools/bin/onepipeline.exe",
      "'rust-toolchain.toml', ",
      "key omits rust-toolchain.toml",
    ],
    [
      "onepipeline-api-baseline",
      ", 'scripts/ensure-baseline-api.sh'",
      "key omits scripts/ensure-baseline-api.sh",
    ],
    [
      ".tools/bin/onepipeline\n",
      `-${expression("runner.os")}`,
      "key omits runner.os",
    ],
  ];
  for (const [path, removed, problem] of cases) {
    const workflows = clone(load());
    const step = firstCache(workflows, path.trim());
    assert.ok(step, path);
    assert.ok(step.with.key.includes(removed), `${path}: ${step.with.key}`);
    step.with.key = step.with.key.replace(removed, "");
    assert.ok(
      cacheProblems(workflows).some((p) => p.endsWith(problem)),
      `${problem}: ${cacheProblems(workflows)}`,
    );
  }
  const undeclared = clone(load());
  undeclared["ci.yml"].jobs.lint.steps.push({
    uses: "actions/cache@v4",
    with: {
      path: "node_modules",
      key: `nm-${expression("runner.os")}-${expression("runner.arch")}`,
    },
  });
  assert.ok(
    cacheProblems(undeclared).some((p) =>
      p.endsWith("no declared inputs for cached node_modules"),
    ),
  );
  const pinsElsewhere = clone(load());
  pinsElsewhere["ci.yml"].jobs["test-linux"].steps.find(
    (s) => s.id === "pins",
  ).run = "echo onepipeline=0.0.0 >> $GITHUB_OUTPUT";
  assert.ok(
    cacheProblems(pinsElsewhere).some((p) =>
      p.endsWith("step pins does not read onepipeline where the recipe does"),
    ),
  );
});
