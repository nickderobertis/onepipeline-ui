import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  OP_NX_COMMIT,
  PROMOTION_BRANCH_PATTERN,
} from "../../scripts/nx-remote-cache.mjs";

const expression = (body) => `$${"{{"} ${body} }}`;
const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
// Remote cache, version 10: dero-skills 27a6b4950bd7582363eebdfbb8b93a0daf85fc21.
// Cache prune: dero-skills 270bea5d287f6fe6a844fd6b882922eacadf6ecf.
// Version-free inputs: dero-skills 63e071b72420bd6737226a50cb8a7a7760cc73a4.
// Figures, version 13: dero-skills afc6829981.
const upstream = {
  "scripts/coverage-unit.sh":
    "0b22963921bc9e2c4d314ddb545ea847b1e59d74b5dec2af1b763db12e4d771d",
  "scripts/coverage-merge.mjs":
    "1fbe006859079d27738cefceddef22e1132c7932f1a6ee5cabc2f6eb265091ef",
  "scripts/nx-remote-cache.mjs":
    "21a6ba436f59d7bd21d1659bf928b0123a6ac0003d5993747e9f216b020d3526",
  "scripts/nx-version-free-inputs.mjs":
    "fdd4f59fc98a0073dbefdbaa0f08f4b58432bbf8e55d315865f951e0151b19b2",
  "scripts/actions-budget-figures.sh":
    "f4dbf47e81ce3baf9acf92d4e92f284614bf9c6a3774a76f18ed89893ce7d3b0",
  "scripts/actions-cache-prune.mjs":
    "4c7bfd986ddb7e59b395a00eb3bb74892b44b76234d0c2a61d63ddf7a49b37a7",
};
test("shared cache and figures copies match the upstream landing commit byte for byte", () => {
  for (const [path, digest] of Object.entries(upstream))
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      digest,
      `${path} is upstream-owned; change its source`,
    );
});

function cacheSteps(job) {
  const steps = job.steps;
  const trust = steps.findIndex((step) => step.id === "nx-cache-trust");
  const sidecar = steps.findIndex((step) => step.id === "nx-cache");
  const ready = steps.findIndex((step) =>
    step.run?.includes("nx-remote-cache.mjs ready"),
  );
  assert.ok(trust >= 0 && trust < sidecar && sidecar < ready);
  assert.match(steps[trust].run, /node scripts\/nx-remote-cache.mjs trust/);
  assert.equal(
    steps[sidecar].uses,
    `op-nx/github-cache/start-cache-server@${OP_NX_COMMIT}`,
  );
  assert.equal(steps[sidecar].background, true);
  assert.equal(steps[sidecar]["working-directory"], undefined);
  assert.equal(
    steps[sidecar].env.CACHE_READ_ONLY,
    expression("steps.nx-cache-trust.outputs.read_only == 'true' && '1' || ''"),
  );
  const teardown = steps.find((step) => step.cancel === "nx-cache");
  // GitHub rejects conditions and continue-on-error on cancel steps.
  assert.deepEqual(teardown, { cancel: "nx-cache" });
  return { steps, ready };
}
test("the four existing CI jobs record and upload trusted cache receipts around their Nx runs", () => {
  const ci = workflow("ci");
  // `budgets` runs no Nx task, so it records no receipt.
  const { budgets: _noNx, ...nxJobs } = ci.jobs;
  assert.deepEqual(Object.keys(nxJobs).sort(), [
    "lint",
    "test-linux",
    "test-macos",
    "test-windows",
  ]);
  for (const [name, job] of Object.entries(nxJobs)) {
    const { steps, ready } = cacheSteps(job);
    const nx = steps.findIndex((step) =>
      step.run?.includes(`just ci-${name === "lint" ? "lint" : name}`),
    );
    const report = steps.findIndex((step) =>
      step.run?.includes("nx-remote-cache.mjs report"),
    );
    assert.ok(ready < nx && nx < report, name);
    assert.equal(steps[report].if, "always()");
    const upload = steps.find(
      (step) =>
        step.with?.name === `nx-cache-entries-${expression("github.job")}`,
    );
    assert.equal(
      upload.if,
      "always() && steps.nx-cache-trust.outputs.promotable == 'true'",
    );
    assert.equal(
      upload.with.path,
      `${expression("runner.temp")}/nx-cache-report`,
    );
    assert.equal(upload.with["retention-days"], 7);
  }
});
test("promotion is a real push before release-plz, and never a dispatch or test run", () => {
  const release = workflow("release-plz");
  assert.deepEqual(release.on.push.branches, [
    "main",
    PROMOTION_BRANCH_PATTERN,
  ]);
  assert.equal(release.on.workflow_dispatch, undefined);
  assert.deepEqual(Object.keys(release.jobs), ["release-plz"]);
  const job = release.jobs["release-plz"];
  assert.equal(job.permissions.actions, "read");
  const { steps, ready } = cacheSteps(job);
  const promote = steps.findIndex((step) =>
    step.run?.includes("nx-remote-cache.mjs promote"),
  );
  assert.ok(promote > ready);
  assert.match(
    steps[promote].run,
    /promote --sha "\$GITHUB_SHA" --workflow ci.yml/,
  );
  assert.match(steps[promote].run, /promote --pr "\$pr" --workflow ci.yml/);
  for (const [i, step] of steps.entries()) {
    assert.doesNotMatch(step.run || "", /(?:export\s+)?GITHUB_EVENT_NAME=/);
    assert.doesNotMatch(step.run || "", /just (?:ci-test|test)|nx .*run/);
    if (
      /release-plz (?:release|update)|just semver-check|gh pr merge/.test(
        step.run || "",
      )
    ) {
      assert.ok(i > promote);
      assert.match(step.if, /github.event_name == 'push'/);
      assert.match(step.if, /github.ref == 'refs\/heads\/main'/);
    }
  }
});

test("release-tail selects both registered budgets and fetches every published path's history", () => {
  const publish = workflow("release").jobs.publish;
  assert.equal(
    publish.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
      .with["fetch-depth"],
    0,
  );
  assert.equal(
    publish.steps.at(-1).run,
    "onebudgetspec check budgets.yaml --label release-tail",
  );
  const budgets = parse(readFileSync("budgets.yaml", "utf8")).budgets;
  for (const [id, args, threshold] of [
    ["onepipeline-ui-nx-cache-use", ["cache-use"], 100],
    [
      "onepipeline-ui-release-cycle-time",
      [
        "release-cycle-time",
        "--published-paths",
        ".github/release-published-paths",
      ],
      5400,
    ],
  ]) {
    const budget = budgets.find((entry) => entry.id === id);
    assert.deepEqual(budget.command, [
      "bash",
      "scripts/actions-budget-figures.sh",
      ...args,
    ]);
    assert.ok(budget.labels.includes("release-tail"));
    assert.equal(budget.threshold, threshold);
  }
  const ci = workflow("ci");
  const { budgets: _reportJob, ...nxJobs } = ci.jobs;
  for (const job of Object.values(nxJobs)) {
    assert.equal(
      job.env.NX_BASE,
      expression("github.event.pull_request.base.sha"),
    );
    assert.equal(
      job.env.NX_HEAD,
      expression("github.event.pull_request.head.sha"),
    );
  }
});

test("published pathspecs cover every crate input and the wrappers and frontend built from them", () => {
  const specs = readFileSync(".github/release-published-paths", "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  const matched = new Set(
    execFileSync("git", ["ls-files", "--", ...specs], { encoding: "utf8" })
      .trim()
      .split("\n"),
  );
  const packaged = execFileSync(
    "cargo",
    ["package", "--list", "--allow-dirty", "--offline"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const file of packaged) {
    if (file === ".cargo_vcs_info.json" || file === "Cargo.toml.orig") continue;
    assert.ok(
      matched.has(file),
      `published crate input ${file} has no pathspec`,
    );
  }
  // These are also the assembly roots for the wheel and both npm deliverables;
  // tests/packaging.rs holds their full published set to the crate's include list.
  for (const file of [
    "pyproject.toml",
    "scripts/build-linux-wheel.sh",
    "scripts/release.mjs",
    "scripts/release-package.py",
    "scripts/npm-build.mjs",
    "npm/onepipeline-api-cli/bin/onepipeline-api.js",
    "apps/dag-ui/vite.config.ts",
    "Cargo.lock",
    "rust-toolchain.toml",
  ]) {
    assert.ok(matched.has(file), `${file} has no published pathspec`);
  }
});

test("lint exclusions added for shared copies name only upstream-owned exact paths", () => {
  const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const previous = parse(
    execFileSync("git", ["show", `${base}:llmlint.yml`], { encoding: "utf8" }),
  ).files.exclude;
  const current = parse(readFileSync("llmlint.yml", "utf8")).files.exclude;
  for (const path of current.filter((path) => !previous.includes(path)))
    assert.ok(
      Object.hasOwn(upstream, path),
      `unexpected lint exclusion ${path}`,
    );
});

test("each coverage tier caches its one LCOV report and the aggregate re-merges every run", () => {
  const nx = JSON.parse(readFileSync("nx.json", "utf8"));
  const tiers = {
    "project.json": "unit",
    "tests/tiers/e2e/project.json": "e2e",
    "tests/tiers/repo-tooling/project.json": "repo-tooling",
    "tests/tiers/npm-launcher/project.json": "npm-launcher",
    "tests/tiers/versions/project.json": "versions",
  };
  for (const [path, tier] of Object.entries(tiers)) {
    const target = JSON.parse(readFileSync(path, "utf8")).targets.test;
    assert.equal(target.command, `just _tier-test-covered ${tier}`, path);
    assert.equal(target.cache, true, `${path} must cache its report`);
    assert.deepEqual(
      target.outputs,
      [`{workspaceRoot}/target/coverage-units/${tier}.lcov`],
      path,
    );
    assert.ok(
      target.inputs.some((input) => String(input).startsWith("coverageTier")),
      `${path} must key on the coverage-tier inputs`,
    );
  }
  assert.equal(nx.targetDefaults.coverage.cache, false);
  assert.match(
    readFileSync("justfile", "utf8"),
    /--fail-under-lines 95\.29 --dir target\/coverage-units/,
  );
});
