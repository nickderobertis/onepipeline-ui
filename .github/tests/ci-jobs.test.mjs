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
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { REQUIRED_CONTEXTS } from "../required-contexts.mjs";
import { evaluate } from "../workflow-graph.mjs";

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
// read off the lockfile (or the commit) by the step that reads it there. A
// cache's paths must be exactly one declared set — the baseline server travels
// with the stamp naming its commit — so nothing rides along undeclared.
const SIBLING = {
  files: ["rust-toolchain.toml", "scripts/ensure-sibling.sh"],
  output: {
    step: "pins",
    name: "onepipeline",
    reads: /just --evaluate onepipeline-version/,
  },
};
const CACHES = [
  { paths: [".tools/bin/onepipeline"], ...SIBLING },
  { paths: [".tools/bin/onepipeline.exe"], ...SIBLING },
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

// Linux arm64 is dropped: ci.yml builds, installs and smoke-tests no
// aarch64-unknown-linux-gnu wheel and names no arm64 Linux runner, and `wheel`
// keeps only its x86_64 leg until the old jobs are removed.
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
  const legs = (ci?.jobs?.wheel?.strategy?.matrix?.include ?? []).map(
    (leg) => leg.target,
  );
  if (JSON.stringify(legs) !== JSON.stringify(["x86_64-unknown-linux-gnu"]))
    problems.push(`wheel's legs are ${JSON.stringify(legs)}, not x86_64 alone`);
  return problems;
}

// A Rust build the four jobs save on failure is saved from a cancelled run only
// when that run reached its cap: each job takes its start time first, and after
// its recipe stops what a cancelled run left building and asks
// scripts/ci-cache-verdict.sh, at the job's own cap, whether to keep the save.
//
// The verdict is executed as each job runs it in cache-verdict.test.mjs. The stop
// step is held here by its shape alone, deliberately: it kills every build tool
// and container on the machine it runs on, which on a job's own runner is the
// job's work and on any machine a test could run it on is somebody else's.
const VERDICT =
  'bash scripts/ci-cache-verdict.sh --started "$JOB_STARTED_AT" --cap-minutes ';
export function cancelledCacheProblems(workflows) {
  const problems = [];
  for (const id of Object.keys(FOUR)) {
    const job = workflows["ci.yml"]?.jobs?.[id];
    if (!job) continue;
    const steps = job.steps ?? [];
    const rust = steps.findIndex((s) =>
      (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
    );
    if (rust < 0 || !steps[rust].with?.["cache-on-failure"]) continue;
    if (!/JOB_STARTED_AT=\$\(date \+%s\)/.test(steps[0]?.run ?? ""))
      problems.push(`job ${id} does not take its start time first`);
    const at = (pattern) =>
      steps.findIndex(
        (s) => s.if === "cancelled()" && pattern.test(s.run ?? ""),
      );
    const stop = at(/pkill -KILL|taskkill \/\/F/);
    const verdict = steps.findIndex(
      (s) => s.if === "cancelled()" && (s.run ?? "").startsWith(VERDICT),
    );
    const recipe = steps.findIndex((s) =>
      (s.run ?? "").startsWith(`just ci-${id}`),
    );
    if (stop < 0)
      problems.push(`job ${id} leaves a cancelled run's builds running`);
    if (verdict < 0) {
      problems.push(`job ${id} saves a superseded run's build`);
      continue;
    }
    if (steps[verdict].run !== `${VERDICT}${job["timeout-minutes"]}`)
      problems.push(`job ${id} reads its cap as other than its timeout`);
    if (!(recipe < stop && stop < verdict))
      problems.push(
        `job ${id} does not stop its builds and then decide, after its recipe`,
      );
  }
  return problems;
}

// The switch the verdict sets is rust-cache's own: its post step runs when
// `success() || env.CACHE_ON_FAILURE == 'true'`. That is held to the release the
// four jobs pin, through a verbatim snapshot of its action.yml whose bytes are
// the Git blob the lock names, so a move to a release that reads anything else
// fails here rather than saving every superseded run again.
const SNAPSHOT_ANNOTATION =
  "# llmlint: ignore-file[comments_earn_their_place] Verbatim upstream action snapshot: every upstream byte is verified against its pinned Git blob; its comments are not repository-authored prose.\n";
export function rustCacheSnapshot() {
  return {
    text: readFileSync(".github/fixtures/rust-cache-v2.9.2-action.yml", "utf8"),
    lock: JSON.parse(
      readFileSync(".github/fixtures/rust-cache-lock.json", "utf8"),
    ),
  };
}
export function rustCacheSwitchProblems(workflows, snapshot) {
  const problems = [];
  for (const id of Object.keys(FOUR)) {
    const step = (workflows["ci.yml"]?.jobs?.[id]?.steps ?? []).find((s) =>
      (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
    );
    if (step && step.uses !== snapshot.lock.uses)
      problems.push(
        `job ${id} uses ${step.uses}, not the snapshotted ${snapshot.lock.uses}`,
      );
  }
  if (!snapshot.text.startsWith(SNAPSHOT_ANNOTATION)) {
    problems.push("the rust-cache snapshot lost its annotation");
    return problems;
  }
  const source = Buffer.from(snapshot.text.slice(SNAPSHOT_ANNOTATION.length));
  const blob = createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
  if (blob !== snapshot.lock.blob)
    problems.push(`the rust-cache snapshot is not blob ${snapshot.lock.blob}`);
  const postIf = parse(source.toString())?.runs?.["post-if"];
  const saves = (value) =>
    typeof postIf === "string" &&
    evaluate(postIf, {
      env: { CACHE_ON_FAILURE: value },
      needs: { job: { result: "cancelled" } },
    }).value;
  if (saves("false") || !saves("true"))
    problems.push(
      "rust-cache's post step does not obey CACHE_ON_FAILURE on a cancelled job",
    );
  return problems;
}

// The four jobs restore main's builds and save only on main, so the cache limit
// is spent on what every pull request restores. A job's Rust build is restored
// under the key a main run of ci.yml saves for the same toolchain — named by the
// job it borrows it from, which has no shared-key of its own and runs on the
// same OS — or under its own id where no main run builds on that OS yet.
// Spelled without a literal `${`, as `expression` below is.
const MAIN_ONLY = `$${"{{"} github.ref == 'refs/heads/main' }}`;
const SHARED = {
  lint: "msrv",
  "test-linux": "quality",
  "test-windows": "cross",
};
export function mainOnlySaveProblems(workflows) {
  const problems = [];
  const jobs = workflows["ci.yml"]?.jobs ?? {};
  const rustCache = (job) =>
    (job?.steps ?? []).find((s) =>
      (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
    );
  for (const id of Object.keys(FOUR)) {
    const job = jobs[id];
    if (!job) continue;
    const rust = rustCache(job);
    if (rust && rust.with?.["save-if"] !== MAIN_ONLY)
      problems.push(`job ${id} saves its Rust build off main`);
    if (rust && rust.with?.["shared-key"] !== SHARED[id])
      problems.push(
        `job ${id} restores ${rust.with?.["shared-key"] ?? "its own key"}, not ${SHARED[id] ?? "its own key"}`,
      );
    const lender = jobs[SHARED[id]];
    if (SHARED[id]) {
      const lent = rustCache(lender);
      const os = (runner) => String(runner).split("-")[0];
      const runners = [
        lender?.["runs-on"],
        ...(lender?.strategy?.matrix?.os ?? []),
      ];
      if (
        !lent ||
        lent.with?.["shared-key"] ||
        !runners.some((r) => os(r) === os(job["runs-on"]))
      )
        problems.push(
          `job ${id} restores ${SHARED[id]}'s key, which no ${os(job["runs-on"])} job of ci.yml saves`,
        );
    }
    for (const step of job.steps ?? [])
      if (
        (step.uses ?? "").startsWith("actions/cache/save@") &&
        !/(^|&& )github\.ref == 'refs\/heads\/main' &&/.test(step.if ?? "")
      )
        problems.push(`job ${id} saves ${step.with?.path} off main`);
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
  const steps = (pick) =>
    Object.entries(workflows["ci.yml"].jobs)
      .filter(([id]) => pick(id))
      .flatMap(([, job]) => job.steps ?? []);
  const of = (prefix, pick) =>
    steps(pick)
      .filter((s) => (s.uses ?? "").startsWith(prefix))
      .map((s) => [s.with.path, s.with.key])
      .sort();
  // The sibling on all three platforms and the baseline server on Linux, each
  // saved under exactly the key and paths it is restored by — by a job a main
  // run reaches. test-macos runs on pull requests only, so it restores what a
  // main-branch warm job saves and saves nothing itself.
  assert.equal(of("actions/cache/restore@", () => true).length, 4);
  assert.deepEqual(
    of("actions/cache/save@", (id) => id === "test-macos"),
    [],
  );
  assert.deepEqual(
    of("actions/cache/save@", () => true),
    of("actions/cache/restore@", (id) => id !== "test-macos"),
  );
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
    (s) => s.with?.path === ".tools/bin/onepipeline",
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
});

test("ci.yml builds no Linux arm64 wheel and names no arm64 Linux runner", () => {
  assert.deepEqual(linuxArm64Problems(load()), []);
});

test("a Linux arm64 wheel leg or runner coming back is refused", () => {
  const cases = [
    [
      (w) => {
        w["ci.yml"].jobs.wheel.strategy.matrix.include.push({
          target: "aarch64-unknown-linux-gnu",
          os: "ubuntu-24.04-arm",
        });
      },
      [
        "ci.yml names aarch64-unknown-linux-gnu",
        "job wheel runs on the arm64 Linux runner ubuntu-24.04-arm",
        'wheel\'s legs are ["x86_64-unknown-linux-gnu","aarch64-unknown-linux-gnu"], not x86_64 alone',
      ],
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"]["runs-on"] = "ubuntu-24.04-arm";
      },
      ["job test-linux runs on the arm64 Linux runner ubuntu-24.04-arm"],
    ],
    [
      (w) => {
        w["ci.yml"].jobs.wheel.strategy.matrix.include = [];
      },
      ["wheel's legs are [], not x86_64 alone"],
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

test("a cancelled run's build is saved only when it reached the cap", () => {
  assert.deepEqual(cancelledCacheProblems(load()), []);
});

test("a job that would save a superseded run's build is refused", () => {
  const steps = (w, id) => w["ci.yml"].jobs[id].steps;
  const without = (w, id, pattern) => {
    w["ci.yml"].jobs[id].steps = steps(w, id).filter(
      (s) => !pattern.test(s.run ?? ""),
    );
  };
  const cases = [
    [
      (w) => without(w, "test-linux", /JOB_STARTED_AT=/),
      "job test-linux does not take its start time first",
    ],
    [
      (w) => without(w, "test-windows", /taskkill/),
      "job test-windows leaves a cancelled run's builds running",
    ],
    [
      (w) => without(w, "lint", /ci-cache-verdict/),
      "job lint saves a superseded run's build",
    ],
    [
      (w) => {
        steps(w, "test-macos").find((s) =>
          (s.run ?? "").includes("ci-cache-verdict"),
        ).run = `${VERDICT}45`;
      },
      "job test-macos reads its cap as other than its timeout",
    ],
    [
      (w) => {
        const list = steps(w, "test-linux");
        const stop = list.findIndex((s) => /pkill/.test(s.run ?? ""));
        const [moved] = list.splice(stop, 1);
        list.push(moved);
      },
      "job test-linux does not stop its builds and then decide, after its recipe",
    ],
  ];
  for (const [mutate, problem] of cases) {
    const workflows = clone(load());
    mutate(workflows);
    assert.ok(
      cancelledCacheProblems(workflows).includes(problem),
      `${problem}: ${cancelledCacheProblems(workflows)}`,
    );
  }
});

test("the save switch the verdict sets is the one the pinned rust-cache reads", () => {
  assert.deepEqual(rustCacheSwitchProblems(load(), rustCacheSnapshot()), []);
});

test("a rust-cache pin or snapshot that parts from the switch is refused", () => {
  const snapshot = rustCacheSnapshot();
  const moved = clone(load());
  moved["ci.yml"].jobs["test-windows"].steps.find((s) =>
    (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
  ).uses = "Swatinem/rust-cache@v2";
  assert.ok(
    rustCacheSwitchProblems(moved, snapshot).includes(
      "job test-windows uses Swatinem/rust-cache@v2, not the snapshotted Swatinem/rust-cache@v2.9.2",
    ),
  );
  const edited = {
    ...snapshot,
    text: snapshot.text.replace("Defaults to false.", "Defaults to true."),
  };
  assert.ok(
    rustCacheSwitchProblems(load(), edited).includes(
      `the rust-cache snapshot is not blob ${snapshot.lock.blob}`,
    ),
  );
  // A release whose post step ignored the switch, with a lock that vouches for
  // it, is refused on what it says rather than on its digest.
  const text = snapshot.text.replace(
    "post-if: \"success() || env.CACHE_ON_FAILURE == 'true'\"",
    'post-if: "always()"',
  );
  const source = Buffer.from(text.slice(SNAPSHOT_ANNOTATION.length));
  const blob = createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
  assert.deepEqual(
    rustCacheSwitchProblems(load(), { text, lock: { ...snapshot.lock, blob } }),
    [
      "rust-cache's post step does not obey CACHE_ON_FAILURE on a cancelled job",
    ],
  );
});

test("the four jobs restore main's builds and save only on main", () => {
  assert.deepEqual(mainOnlySaveProblems(load()), []);
});

test("a pull-request save, or a borrowed key no main job saves, is refused", () => {
  const rust = (w, id) =>
    w["ci.yml"].jobs[id].steps.find((s) =>
      (s.uses ?? "").startsWith("Swatinem/rust-cache@"),
    );
  const cases = [
    [
      (w) => {
        delete rust(w, "test-linux").with["save-if"];
      },
      "job test-linux saves its Rust build off main",
    ],
    [
      (w) => {
        rust(w, "test-windows").with["shared-key"] = "quality";
      },
      "job test-windows restores quality, not cross",
    ],
    [
      (w) => {
        delete w["ci.yml"].jobs.msrv;
      },
      "job lint restores msrv's key, which no ubuntu job of ci.yml saves",
    ],
    [
      (w) => {
        w["ci.yml"].jobs["test-linux"].steps.find(
          (s) => s.name === "Save the sibling CLI",
        ).if = "steps.sibling.outputs.cache-hit != 'true'";
      },
      "job test-linux saves .tools/bin/onepipeline off main",
    ],
  ];
  for (const [mutate, problem] of cases) {
    const workflows = clone(load());
    mutate(workflows);
    assert.ok(
      mainOnlySaveProblems(workflows).includes(problem),
      `${problem}: ${mainOnlySaveProblems(workflows)}`,
    );
  }
});
