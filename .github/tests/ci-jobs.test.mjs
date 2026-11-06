// The four pull-request jobs other work builds against — `lint`, `test-linux`,
// `test-windows`, `test-macos` — which are also the contexts branch protection
// requires, and the keys of every cache a workflow restores or saves.
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

// Linux gets 36 minutes from docs/release-sweep-timing.md; the other caps stay 30.
const FOUR = {
  lint: "ubuntu-latest",
  "test-linux": "ubuntu-latest",
  "test-windows": "windows-latest",
  "test-macos": "macos-latest",
};
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
    const cap = id === "test-linux" ? 36 : 30;
    if (job["timeout-minutes"] !== cap)
      problems.push(
        `job ${id} has timeout-minutes ${job["timeout-minutes"]}, not ${cap}`,
      );
    if (job["runs-on"] !== runner)
      problems.push(`job ${id} runs on ${job["runs-on"]}, not ${runner}`);
    // A push to `main` runs only `budgets`, so each of these is held to pull requests.
    const allowed = "github.event_name == 'pull_request'";
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
  // One screencomp release judges both capture paths, and the comment describes
  // the lane classify gated: both read off the steps they repeat.
  const reusable = workflows["visual-docs.yml"]?.jobs?.["visual-docs"];
  const cli = lintSteps.find((step) =>
    (step.uses ?? "").startsWith("nickderobertis/screencomp@"),
  );
  if (
    cli?.with?.version !== reusable?.with?.["screencomp-version"] ||
    !(reusable?.uses ?? "").endsWith(`@${cli?.with?.version}`)
  )
    problems.push(
      `lint's screencomp ${cli?.with?.version} is not visual-docs.yml's ${reusable?.with?.["screencomp-version"]}`,
    );
  const classify = lintSteps.find((step) =>
    (step.uses ?? "").startsWith("nickderobertis/screencomp/visual-docs@"),
  )?.with;
  const aggregate = lintSteps.find((step) =>
    (step.uses ?? "").startsWith(
      "nickderobertis/screencomp/visual-docs-aggregate@",
    ),
  )?.with;
  let lanes = [];
  try {
    lanes = JSON.parse(aggregate?.matrix ?? "[]");
  } catch {
    problems.push("lint's aggregate matrix is not JSON");
  }
  const lane = {
    arch: classify?.arch,
    project: classify?.project,
    current: classify?.current,
    verify: classify?.["verify-second"],
    manifest: classify?.manifest,
    gallery_title: classify?.["gallery-title"],
  };
  if (JSON.stringify(lanes) !== JSON.stringify([lane]))
    problems.push(
      `lint's aggregate matrix ${aggregate?.matrix} is not the lane classify gated`,
    );
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

// Each context branch protection requires (../required-contexts.mjs), and the
// job that reports it: a job id with no name override reports under its id.
const REQUIRED = Object.fromEntries(
  [...Object.keys(FOUR), "budgets"].map((job) => [
    job,
    { file: "ci.yml", job },
  ]),
);

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
  }
  return problems;
}

// What each restored cache was produced from, which its key must name: the
// runner's OS and architecture always, every pinned file listed, and the value
// read off the lockfile (or the commit) by the step that reads it there. A
// cache's paths must be exactly one declared set — the baseline server travels
// with the stamp naming its commit, and the sibling CLI with the stamp naming
// the source it was built from — so nothing rides along undeclared. The sibling's
// value names that source as well as the version, because a fast adoption links
// an engine commit that reports the release version it was cut after.
const SIBLING = {
  files: ["rust-toolchain.toml", "scripts/ensure-sibling.sh"],
  output: {
    step: "pins",
    name: "onepipeline",
    reads:
      /just --evaluate onepipeline-version.*just --evaluate onepipeline-source/,
  },
};
const CACHES = [
  {
    paths: [".tools/bin/onepipeline", ".tools/bin/onepipeline.source"],
    ...SIBLING,
  },
  {
    paths: [".tools/bin/onepipeline.exe", ".tools/bin/onepipeline.exe.source"],
    ...SIBLING,
  },
  {
    paths: [
      ".tools/bin/onepipeline-api-baseline",
      ".tools/bin/onepipeline-api-baseline.commit",
    ],
    files: ["rust-toolchain.toml", "scripts/ensure-baseline-api.sh"],
    output: {
      step: "pins",
      name: "base",
      reads: /git merge-base HEAD origin\/main/,
    },
  },
];

export function cacheProblems(workflows) {
  const problems = [];
  for (const [file, document] of Object.entries(workflows))
    for (const [id, job] of Object.entries(document?.jobs ?? {}))
      for (const step of job.steps ?? []) {
        if (!/^actions\/cache(\/restore|\/save)?@/.test(step.uses ?? ""))
          continue;
        const where = `${file} ${id}`;
        const key = String(step.with?.key ?? "");
        const paths = String(step.with?.path ?? "")
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean)
          .sort();
        if (step.with?.["restore-keys"])
          problems.push(
            `${where}: restore-keys would serve a cache from other inputs`,
          );
        for (const part of ["runner.os", "runner.arch"])
          if (!key.includes(part)) problems.push(`${where}: key omits ${part}`);
        const declared = CACHES.find(
          (cache) =>
            JSON.stringify([...cache.paths].sort()) === JSON.stringify(paths),
        );
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

// Linux arm64 stays out of pull-request CI: ci.yml builds, installs and
// smoke-tests no aarch64-unknown-linux-gnu wheel and names no arm64 Linux
// runner; `test-linux` builds the x86_64 wheel alone. The release builds arm64
// Linux in its own `build-linux-arm64` job (.github/tests/release.test.mjs).
const ARM_LINUX_RUNNER = /^ubuntu-[\w.]+-arm$/;
export function linuxArm64Problems(workflows) {
  const problems = [];
  const ci = workflows["ci.yml"];
  if (JSON.stringify(ci).includes("aarch64-unknown-linux-gnu"))
    problems.push("ci.yml names aarch64-unknown-linux-gnu");
  for (const [id, job] of Object.entries(ci?.jobs ?? {})) {
    const runners = [
      job["runs-on"],
      ...(job.strategy?.matrix?.include ?? []).map((leg) => leg.os),
      ...(job.strategy?.matrix?.os ?? []),
    ];
    for (const runner of runners)
      if (typeof runner === "string" && ARM_LINUX_RUNNER.test(runner))
        problems.push(`job ${id} runs on the arm64 Linux runner ${runner}`);
  }
  return problems;
}

// What lint's visual docs do on a pull request: photograph the build twice,
// gate the two captures against each other (the reproducibility gate) and
// against the committed baseline (the drift gate), with either failing the job,
// and publish nothing — publishing is off so the job fits its 30-minute cap.
const PR_STEP = "github.event_name == 'pull_request' && !cancelled()";
// The expression a step reads the switch through, spelled as the workflow does.
const SWITCH = ["${{", "env.VISUAL_DOCS_PUBLISH", "}}"].join(" ");

export function lintVisualDocsProblems(workflows) {
  const problems = [];
  const lint = workflows["ci.yml"]?.jobs?.lint;
  const steps = lint?.steps ?? [];
  const publish = String(lint?.env?.VISUAL_DOCS_PUBLISH);
  if (publish !== "false")
    problems.push(`lint's VISUAL_DOCS_PUBLISH is ${publish}, not false`);
  const permissions = lint?.permissions ?? {};
  if (permissions.contents === "write" || "pages" in permissions)
    problems.push("lint's token can deploy the gallery");
  for (const step of steps) {
    const uses = step.uses ?? "";
    const label = step.name ?? uses;
    if (step.with && "publish" in step.with) {
      const value = String(step.with.publish);
      if ((value === SWITCH ? publish : value) !== "false")
        problems.push(`lint's step ${label} publishes`);
    }
    if (
      uses.startsWith("nickderobertis/screencomp/visual-docs-pages@") &&
      !(
        publish === "false" &&
        /env\.VISUAL_DOCS_PUBLISH == 'true'/.test(step.if ?? "")
      )
    )
      problems.push("lint deploys the gallery on a pull request");
  }
  const classify = steps.find((step) =>
    (step.uses ?? "").startsWith("nickderobertis/screencomp/visual-docs@"),
  );
  const capture = steps.find((step) =>
    /^just dag-ui-screens\b/.test((step.run ?? "").trim()),
  );
  const arch = classify?.with?.arch;
  const current = classify?.with?.current;
  const verify = classify?.with?.["verify-second"];
  if (!capture) problems.push("lint captures no visual docs");
  if (!classify) problems.push("lint does not gate its captures");
  if (capture && classify) {
    if (capture.env?.SHOTS_OUT !== `${current}/${arch}`)
      problems.push(
        `lint's capture writes ${capture.env?.SHOTS_OUT}, not the ${current}/${arch} the gates read`,
      );
    if (!verify)
      problems.push("lint's reproducibility gate has no second capture");
    else if (capture.env?.SHOTS_VERIFY !== `${verify}/${arch}`)
      problems.push(
        `lint's capture writes no second capture into the ${verify}/${arch} the reproducibility gate reads`,
      );
    if (String(classify.with?.["fail-on-drift"]) !== "true")
      problems.push("lint's drift gate does not fail the job");
  }
  for (const [what, step] of [
    ["capture", capture],
    ["gates", classify],
  ]) {
    if (!step) continue;
    if (step["continue-on-error"] !== undefined)
      problems.push(`lint's ${what} cannot fail the job`);
    if (step.if !== PR_STEP)
      problems.push(`lint's ${what} does not run on every pull request`);
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

test("a screencomp release or comment lane that parts from what it repeats is refused", () => {
  const version = clone(load());
  version["ci.yml"].jobs.lint.steps.find((s) =>
    (s.uses ?? "").startsWith("nickderobertis/screencomp@"),
  ).with.version = "v0.4.9";
  assert.ok(
    jobProblems(version).some((p) => p.startsWith("lint's screencomp v0.4.9")),
  );
  const lane = clone(load());
  lane["ci.yml"].jobs.lint.steps.find((s) =>
    (s.uses ?? "").startsWith("nickderobertis/screencomp/visual-docs@"),
  ).with["gallery-title"] = "Docs";
  assert.ok(
    jobProblems(lane).some((p) => p.endsWith("is not the lane classify gated")),
  );
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

test("lint captures twice and gates both ways on a pull request, and publishes nothing", () => {
  assert.deepEqual(lintVisualDocsProblems(load()), []);
});

test("lint publishing, or losing a capture or either gate, is refused", () => {
  const lintOf = (w) => w["ci.yml"].jobs.lint;
  const stepOf = (w, uses) =>
    lintOf(w).steps.find((s) => (s.uses ?? "").startsWith(uses));
  const captureOf = (w) =>
    lintOf(w).steps.find((s) => /^just dag-ui-screens\b/.test(s.run ?? ""));
  const classify = "nickderobertis/screencomp/visual-docs@";
  const cases = [
    [
      (w) => {
        lintOf(w).env.VISUAL_DOCS_PUBLISH = "true";
      },
      "lint's VISUAL_DOCS_PUBLISH is true, not false",
    ],
    [
      (w) => {
        stepOf(w, classify).with.publish = "true";
      },
      "lint's step Classify, gate and build the gallery publishes",
    ],
    [
      (w) => {
        delete stepOf(w, "nickderobertis/screencomp/visual-docs-pages@").if;
      },
      "lint deploys the gallery on a pull request",
    ],
    [
      (w) => {
        lintOf(w).permissions.contents = "write";
      },
      "lint's token can deploy the gallery",
    ],
    [
      (w) => {
        lintOf(w).steps = lintOf(w).steps.filter((s) => s !== captureOf(w));
      },
      "lint captures no visual docs",
    ],
    [
      (w) => {
        delete captureOf(w).env.SHOTS_VERIFY;
      },
      "lint's capture writes no second capture into the shots/verify/x86_64 the reproducibility gate reads",
    ],
    [
      (w) => {
        delete stepOf(w, classify).with["verify-second"];
      },
      "lint's reproducibility gate has no second capture",
    ],
    [
      (w) => {
        stepOf(w, classify).with["fail-on-drift"] = "false";
      },
      "lint's drift gate does not fail the job",
    ],
    [
      (w) => {
        stepOf(w, classify)["continue-on-error"] = true;
      },
      "lint's gates cannot fail the job",
    ],
    [
      (w) => {
        captureOf(w).if = "false";
      },
      "lint's capture does not run on every pull request",
    ],
    [
      (w) => {
        lintOf(w).steps = lintOf(w).steps.filter(
          (s) => s !== stepOf(w, classify),
        );
      },
      "lint does not gate its captures",
    ],
  ];
  for (const [mutate, expected] of cases) {
    const workflows = clone(load());
    mutate(workflows);
    const problems = lintVisualDocsProblems(workflows);
    assert.ok(problems.includes(expected), `${expected}: ${problems}`);
  }
});

test("every job behind the required contexts is still in place", () => {
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
  const renamed = clone(load());
  renamed["ci.yml"].jobs["test-windows"].name = "Windows";
  assert.ok(
    requiredContextProblems(renamed).includes(
      "test-windows: job test-windows overrides its name",
    ),
  );
});

test("every restored cache is keyed on what produced it", () => {
  const workflows = load();
  assert.deepEqual(cacheProblems(workflows), []);
  // Per OS, as each workflow's own pins step reads it: the sibling on all three
  // and the base server on Linux, restored by the pull-request jobs and saved,
  // under exactly those keys and paths, by the main-push warmer alone.
  const runnerOs = { ubuntu: "Linux", windows: "Windows", macos: "macOS" };
  const of = (file, prefix) =>
    Object.values(workflows[file].jobs)
      .flatMap((job) =>
        (job.steps ?? [])
          .filter((s) => (s.uses ?? "").startsWith(prefix))
          .map((s) => [
            runnerOs[job["runs-on"].split("-")[0]],
            s.with.path,
            s.with.key,
          ]),
      )
      .map((row) => JSON.stringify(row))
      .sort();
  const restored = of("ci.yml", "actions/cache/restore@");
  assert.equal(restored.length, 4);
  assert.deepEqual(of("ci.yml", "actions/cache/save@"), []);
  assert.deepEqual(of("ci-cache.yml", "actions/cache/save@"), restored);
  assert.deepEqual(of("ci-cache.yml", "actions/cache/restore@"), restored);
});

test("a cache key that omits the lockfile pin or a pinned tool is refused", () => {
  const firstCache = (w, path) =>
    Object.values(w["ci.yml"].jobs)
      .flatMap((job) => job.steps ?? [])
      .find(
        (s) =>
          (s.uses ?? "").startsWith("actions/cache/restore@") &&
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
  const extra = clone(load());
  const sibling = extra["ci.yml"].jobs["test-linux"].steps.find(
    (s) =>
      s.with?.path ===
      ".tools/bin/onepipeline\n.tools/bin/onepipeline.source\n",
  );
  sibling.with.path = ".tools/bin/onepipeline\n.tools/bin/something-else";
  assert.ok(
    cacheProblems(extra).some((p) =>
      p.endsWith(
        "no declared inputs for cached .tools/bin/onepipeline, .tools/bin/something-else",
      ),
    ),
    cacheProblems(extra),
  );
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
  // The version alone names a release build and a fast adoption's commit alike.
  const versionOnly = clone(load());
  versionOnly["ci.yml"].jobs["test-linux"].steps.find(
    (s) => s.id === "pins",
  ).run =
    'echo "onepipeline=$(just --evaluate onepipeline-version)" >> "$GITHUB_OUTPUT"';
  assert.ok(
    cacheProblems(versionOnly).some((p) =>
      p.endsWith("step pins does not read onepipeline where the recipe does"),
    ),
  );
});

test("ci.yml builds no Linux arm64 wheel and names no arm64 Linux runner", () => {
  assert.deepEqual(linuxArm64Problems(load()), []);
});

test("a Linux arm64 wheel or runner coming back is refused", () => {
  const cases = [
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"].steps.push({
          run: "just wheel-linux aarch64-unknown-linux-gnu",
        });
      },
      ["ci.yml names aarch64-unknown-linux-gnu"],
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"]["runs-on"] = "ubuntu-24.04-arm";
      },
      ["job test-linux runs on the arm64 Linux runner ubuntu-24.04-arm"],
    ],
  ];
  for (const [mutate, expected] of cases) {
    const workflows = clone(load());
    mutate(workflows);
    const problems = linuxArm64Problems(workflows);
    for (const problem of expected)
      assert.ok(problems.includes(problem), `${problem}: ${problems}`);
  }
});

// A hosted runner's upload cannot be driven offline. This assertion holds the
// retrieval wiring to the real capture directory without changing capture gates.
test("the x86_64 capture remains retrievable when publication is disabled", () => {
  const steps = load()["ci.yml"].jobs.lint.steps;
  const upload = steps.find(
    (step) => step.name === "Upload x86_64 capture for baseline review",
  );
  assert.equal(upload?.uses, "actions/upload-artifact@v4");
  assert.equal(upload.if, "always() && github.event_name == 'pull_request'");
  assert.deepEqual(upload.with, {
    name: "screencomp-capture-x86_64",
    path: "shots/current/x86_64",
    "retention-days": 3,
    "if-no-files-found": "ignore",
  });
  const capture = steps.findIndex(
    (step) =>
      step.name ===
      "Capture the visual docs twice, for the reproducibility gate",
  );
  assert.equal(steps[capture].env.SHOTS_OUT, upload.with.path);
  assert.equal(steps[capture + 1], upload);
});
