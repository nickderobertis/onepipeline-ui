// Moving RUST_CACHE_GENERATION is how every Rust build cache family is rebuilt cold from
// the current lockfile, so nothing is held here unless it reaches the keys rust-cache
// actually computes. Those are re-derived by that action's own rule, which is the one
// from the version every workflow pins (`RULE_VERSION`), and that rule is held to keys a
// real runner printed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  LEG_FAMILIES,
  PULL_REQUEST_JOBS,
  writesCache,
} from "./cache-retention.mjs";

const NAME = "RUST_CACHE_GENERATION";
const FILES = ["ci.yml", "ci-cache.yml"];
const RULE_VERSION = "Swatinem/rust-cache@v2.9.2";
// `envPrefixes` in that version's src/config.ts; its `env-vars` input adds to them.
const HASHED_PREFIXES = ["CARGO", "CC", "CFLAGS", "CXX", "CMAKE", "RUST"];
// The workflow environment both files had before the generation value existed
// (a352543): what every entry already in the cache was keyed under.
const PRE_CHANGE_ENV = { CARGO_TERM_COLOR: "always" };
// The family prefixes `ci-cache.yml`'s cleanup deletes superseded copies by.
const RUST_FAMILIES = Object.values(LEG_FAMILIES)
  .flat()
  .filter((family) => family.startsWith("v0-rust-test-"));

// What a real runner contributes that no workflow file shows: `os.type()`, `os.arch()`,
// every installed toolchain and the runner's own hashed variables, read off the
// runs named in the change that added this. `lockHash` is the digest of the Cargo
// files alone: it stands in for them because nothing in a workflow's environment
// reaches it, so a generation cannot move it.
const RUNNERS = {
  ubuntu: {
    type: "Linux",
    arch: "x64",
    rust: ["RUST_LINUX"],
    ambient: {},
    lockHash: "LOCK_LINUX",
  },
  windows: {
    type: "Windows_NT",
    arch: "x64",
    rust: ["RUST_WINDOWS"],
    ambient: {},
    lockHash: "LOCK_WINDOWS",
  },
  macos: {
    type: "Darwin",
    arch: "arm64",
    rust: ["RUST_MACOS"],
    ambient: {},
    lockHash: "LOCK_MACOS",
  },
};
// The keys the demonstration's `Cache Configuration` block printed for each family.
const PRINTED = {
  ubuntu: { sharedKey: "test-linux", restore: "", primary: "" },
  windows: { sharedKey: "test-windows", restore: "", primary: "" },
  macos: { sharedKey: "test-macos", restore: "", primary: "" },
};
const PRINTED_ENV = { ...PRE_CHANGE_ENV, [NAME]: "1" };

const load = () =>
  Object.fromEntries(
    FILES.map((file) => [
      file,
      parse(
        readFileSync(new URL(`../workflows/${file}`, import.meta.url), "utf8"),
      ),
    ]),
  );
const isRustCache = (step) => step.uses?.startsWith("Swatinem/rust-cache@");
const runnerOf = (job) => RUNNERS[String(job["runs-on"]).split("-")[0]];

// CacheConfig.new() of the pinned version. The variables are what reach this step's
// process: the action exports CARGO_INCREMENTAL itself just before computing the key.
export function deriveKeys(
  step,
  jobId,
  job,
  workflowEnv,
  runner = runnerOf(job),
) {
  const input = (name, fallback) => String(step.with?.[name] ?? fallback);
  let key = input("prefix-key", "v0-rust");
  const shared = input("shared-key", "");
  if (shared) key += `-${shared}`;
  else {
    if (input("key", "")) key += `-${input("key", "")}`;
    if (input("add-job-id-key", "true").toLowerCase() === "true")
      key += `-${jobId}`;
  }
  key += `-${runner.type}-${runner.arch}`;
  const family = key;
  const hasher = createHash("sha1");
  for (const version of [...runner.rust].sort()) hasher.update(version);
  const env = {
    ...runner.ambient,
    ...workflowEnv,
    ...job.env,
    ...step.env,
    CARGO_INCREMENTAL: "0",
  };
  const prefixes = [
    ...HASHED_PREFIXES,
    ...input("env-vars", "").split(/\s+/).filter(Boolean),
  ];
  for (const name of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    const value = env[name];
    if (prefixes.some((prefix) => name.startsWith(prefix)) && value)
      hasher.update(`${name}=${value}`);
  }
  if (input("add-rust-environment-hash-key", "true").toLowerCase() !== "true")
    return { family, restore: key, primary: key };
  const restore = `${key}-${hasher.digest("hex").slice(0, 8)}`;
  return { family, restore, primary: `${restore}-${runner.lockHash}` };
}

const rustCacheSteps = (workflows) =>
  FILES.flatMap((file) =>
    Object.entries(workflows[file]?.jobs ?? {}).flatMap(([jobId, job]) =>
      (job.steps ?? [])
        .filter(isRustCache)
        .map((step) => ({ file, jobId, job, step })),
    ),
  );
// A step that restores a Cargo `target` directory by a key the workflow spells itself.
const literalTargetRestores = (workflows) =>
  FILES.flatMap((file) =>
    Object.values(workflows[file]?.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).filter(
        (step) =>
          /^actions\/cache(\/restore)?@/.test(step.uses ?? "") &&
          /(^|\s)(\.\/)?target(\/|\s|$)/.test(String(step.with?.path ?? "")),
      ),
    ),
  );
const label = ({ file, jobId }) => `${file}:${jobId}`;

export function generationProblems(workflows) {
  const problems = [];
  const values = FILES.map((file) => workflows[file]?.env?.[NAME]);
  for (const [index, file] of FILES.entries())
    if (values[index] === undefined || values[index] === "")
      problems.push(`${file} carries no ${NAME}`);
  if (values[0] !== values[1])
    problems.push(`the two workflows carry different ${NAME} values`);

  const preChange = [];
  for (const site of rustCacheSteps(workflows)) {
    const { step, jobId, job } = site;
    const pre = deriveKeys(step, jobId, job, PRE_CHANGE_ENV);
    preChange.push(pre.primary, pre.restore);
    if (step.uses !== RULE_VERSION)
      problems.push(
        `${label(site)} uses ${step.uses}, not the ${RULE_VERSION} whose rule this derives`,
      );
    if (!RUST_FAMILIES.includes(`${pre.family}-`))
      problems.push(
        `${label(site)} is family ${pre.family}, which no cleanup names`,
      );
  }
  for (const site of rustCacheSteps(workflows)) {
    const { file, step, jobId, job } = site;
    const env = workflows[file].env;
    const keys = deriveKeys(step, jobId, job, env);
    const pre = deriveKeys(step, jobId, job, PRE_CHANGE_ENV);
    if (keys.primary === pre.primary || keys.restore === pre.restore)
      problems.push(
        `${label(site)}: the generation does not enter its key (${keys.restore})`,
      );
    if (String(step.with?.["cache-targets"] ?? "true") !== "false")
      for (const key of [keys.primary, keys.restore])
        if (preChange.some((old) => old.startsWith(key)))
          problems.push(
            `${label(site)}: ${key} can restore an entry saved before the change`,
          );
  }
  for (const step of literalTargetRestores(workflows))
    for (const key of [
      step.with.key,
      ...String(step.with["restore-keys"] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ])
      if (preChange.some((old) => old.startsWith(key)))
        problems.push(
          `${step.uses}: ${key} can restore an entry saved before the change`,
        );
  return problems;
}

export function pullRequestProblems(workflows) {
  const problems = [];
  const saved = new Map();
  for (const site of rustCacheSteps(workflows))
    if (site.file === "ci-cache.yml" && writesCache(site.step, {}))
      saved.set(
        deriveKeys(
          site.step,
          site.jobId,
          site.job,
          workflows["ci-cache.yml"].env,
        ).restore,
        site.jobId,
      );
  for (const jobId of PULL_REQUEST_JOBS)
    if (!(workflows["ci.yml"].jobs[jobId]?.steps ?? []).some(isRustCache))
      problems.push(`${jobId} restores no Rust build`);
  for (const site of rustCacheSteps(workflows)) {
    if (site.file !== "ci.yml") continue;
    if (writesCache(site.step, {}))
      problems.push(`${site.jobId} saves a Rust cache`);
    const { restore } = deriveKeys(
      site.step,
      site.jobId,
      site.job,
      workflows["ci.yml"].env,
    );
    if (!saved.has(restore))
      problems.push(`${site.jobId} restores ${restore}, which no warm leg saves`);
  }
  return problems;
}

const withEnv = (workflows, change) => {
  const copy = structuredClone(workflows);
  for (const file of FILES) change(copy[file].env, file);
  return copy;
};
const stepIn = (workflows, file, jobId) =>
  workflows[file].jobs[jobId].steps.find(isRustCache);
const refusedWith = (problems, pattern) =>
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`,
  );

test("the rule reproduces the keys a real runner printed for each family", () => {
  for (const [os, printed] of Object.entries(PRINTED)) {
    const keys = deriveKeys(
      { with: { "shared-key": printed.sharedKey } },
      "any-job",
      { "runs-on": `${os}-latest` },
      PRINTED_ENV,
    );
    assert.equal(keys.restore, printed.restore, os);
    assert.equal(keys.primary, printed.primary, os);
  }
});

test("the finished workflows move every Rust cache key, once and alike", () => {
  assert.deepEqual(generationProblems(load()), []);
  assert.equal(rustCacheSteps(load()).length, 7);
});

test("changing the generation moves every key and no family's name prefix", () => {
  const workflows = load();
  const next = withEnv(workflows, (env) => (env[NAME] = "2"));
  assert.deepEqual(generationProblems(next), []);
  for (const site of rustCacheSteps(workflows)) {
    const { step, jobId, job, file } = site;
    const now = deriveKeys(step, jobId, job, workflows[file].env);
    const moved = deriveKeys(step, jobId, job, next[file].env);
    assert.notEqual(moved.primary, now.primary, label(site));
    assert.notEqual(moved.restore, now.restore, label(site));
    assert.equal(moved.family, now.family, label(site));
  }
});

test("the two files' values are one value", () => {
  refusedWith(
    generationProblems(
      withEnv(load(), (env, file) => {
        if (file === "ci.yml") env[NAME] = "99";
      }),
    ),
    /different RUST_CACHE_GENERATION/,
  );
});

test("an absent value is refused", () => {
  refusedWith(
    generationProblems(withEnv(load(), (env) => delete env[NAME])),
    /carries no RUST_CACHE_GENERATION/,
  );
});

test("a value under a name rust-cache does not hash does not count", () => {
  refusedWith(
    generationProblems(
      withEnv(load(), (env) => {
        env.BUILD_GENERATION = env[NAME];
        delete env[NAME];
      }),
    ),
    /does not enter its key/,
  );
  // Present under the hashed name in both files, and that name still does not reach a step
  // because the step's own `env` blanks it.
  const blanked = load();
  stepIn(blanked, "ci.yml", "test-linux").env = { [NAME]: "" };
  refusedWith(generationProblems(blanked), /ci\.yml:test-linux.*does not enter/);
});

test("a value in a scope the step does not see does not count", () => {
  const workflows = withEnv(load(), (env) => delete env[NAME]);
  for (const file of FILES) workflows[file].env.UNRELATED = "1";
  workflows["ci.yml"].jobs.budgets.env = { [NAME]: "1" };
  workflows["ci-cache.yml"].jobs.advisories.env = { [NAME]: "1" };
  refusedWith(generationProblems(workflows), /does not enter its key/);
});

test("a family whose name prefix changes is refused", () => {
  const workflows = load();
  stepIn(workflows, "ci-cache.yml", "warm-linux").with["shared-key"] = "renamed";
  refusedWith(generationProblems(workflows), /no cleanup names/);
});

test("a restore key that still prefixes a pre-change key is refused", () => {
  const unhashed = load();
  stepIn(unhashed, "ci.yml", "lint").with["add-rust-environment-hash-key"] =
    "false";
  refusedWith(generationProblems(unhashed), /can restore an entry saved before/);

  const literal = load();
  literal["ci-cache.yml"].jobs["warm-macos"].steps.push({
    uses: "actions/cache/restore@v4",
    with: {
      path: "target",
      key: "unrelated-key",
      "restore-keys": "v0-rust-test-macos-Darwin-arm64-",
    },
  });
  refusedWith(generationProblems(literal), /can restore an entry saved before/);
});

test("a pull-request job only restores the family a warm leg saves", () => {
  assert.deepEqual(pullRequestProblems(load()), []);
});

test("a pull-request job that saves its Rust build is refused", () => {
  const workflows = load();
  stepIn(workflows, "ci.yml", "test-windows").with["save-if"] = true;
  refusedWith(pullRequestProblems(workflows), /test-windows saves a Rust cache/);
});

test("a pull-request job with no restore step is refused", () => {
  const workflows = load();
  const job = workflows["ci.yml"].jobs["test-macos"];
  job.steps = job.steps.filter((step) => !isRustCache(step));
  refusedWith(pullRequestProblems(workflows), /test-macos restores no Rust build/);
});

test("a pull-request job restoring a family no warm leg saves is refused", () => {
  const workflows = load();
  stepIn(workflows, "ci.yml", "test-linux").with["shared-key"] = "elsewhere";
  refusedWith(pullRequestProblems(workflows), /test-linux restores .*no warm leg/);
  // And a warm leg whose generation differs saves a key the job cannot restore.
  const drifted = withEnv(load(), (env, file) => {
    if (file === "ci-cache.yml") env[NAME] = "99";
  });
  refusedWith(pullRequestProblems(drifted), /no warm leg saves/);
});
