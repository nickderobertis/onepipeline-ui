import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  probeEdit,
  probeHashes,
  taskHashes,
  workspaceFixture,
} from "./nx-fixture.mjs";

const versionReaders = (id) =>
  /^(onepipeline-ui-release:test$|onepipeline-ui-npm-launcher:|onepipeline-ui-versions:)/.test(
    id,
  );

test("real Nx replays release edits except targets whose tests read the version", () => {
  const cwd = workspaceFixture();
  const base = workspaceFixture(
    execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      encoding: "utf8",
    }).trim(),
  );
  try {
    // Replay the exact version fields and changelog section written by release-plz
    // in this repository's recorded PR #607, independently of today's version.
    const recorded = JSON.parse(
      readFileSync(".github/tests/nx-cache/release-pr-607.json", "utf8"),
    );
    const manifestPath = join(cwd, "Cargo.toml");
    const lockPath = join(cwd, "Cargo.lock");
    const changelogPath = join(cwd, "CHANGELOG.md");
    const manifest = readFileSync(manifestPath, "utf8");
    const version = manifest.match(/^version = "([^"]+)"/m)[1];
    const baselineManifest = manifest.replace(
      `version = "${version}"`,
      `version = "${recorded.previous}"`,
    );
    const baselineLock = readFileSync(lockPath, "utf8").replace(
      `name = "onepipeline-ui"\nversion = "${version}"`,
      `name = "onepipeline-ui"\nversion = "${recorded.previous}"`,
    );
    const baselineChangelog = readFileSync(changelogPath, "utf8").replace(
      recorded.changelog,
      "",
    );
    writeFileSync(manifestPath, baselineManifest);
    writeFileSync(lockPath, baselineLock);
    writeFileSync(changelogPath, baselineChangelog);
    const before = taskHashes(cwd);
    const intentionallyUncached = new Set([
      "onepipeline-ui-release:rehearse",
      ...[
        "onepipeline-ui",
        "onepipeline-ui-e2e",
        "onepipeline-ui-repo-tooling",
        "onepipeline-ui-npm-launcher",
      ].map((project) => `${project}:test`),
      ...[
        "dag-ui",
        "dag-layout",
        "dag-model",
        "telemetry-client",
        "timeline-categories",
      ].map((project) => `${project}:build`),
    ]);
    const expected = new Set([
      ...Object.keys(taskHashes(base)).filter(
        (id) => !intentionallyUncached.has(id),
      ),
      "onepipeline-ui-versions:test-quick",
      "onepipeline-ui-nx-worker-startup:test",
      "onepipeline-ui-nx-worker-startup:test-quick",
      "github-workflows-nx-cache:lint",
      "github-workflows-nx-cache:test",
      "dag-ui-read-latency:format-check",
      "dag-ui-read-latency:lint",
      "dag-ui-read-latency:typecheck",
    ]);
    assert.deepEqual(
      Object.keys(before).sort(),
      [...expected].sort(),
      "cover every base cacheable task, with only deliberate cache removals and additions",
    );
    writeFileSync(
      manifestPath,
      baselineManifest.replace(
        `version = "${recorded.previous}"`,
        `version = "${recorded.version}"`,
      ),
    );
    writeFileSync(
      lockPath,
      baselineLock.replace(
        `name = "onepipeline-ui"\nversion = "${recorded.previous}"`,
        `name = "onepipeline-ui"\nversion = "${recorded.version}"`,
      ),
    );
    assert.ok(baselineChangelog.includes("## [Unreleased]\n\n"));
    writeFileSync(
      changelogPath,
      baselineChangelog.replace(
        "## [Unreleased]\n\n",
        `## [Unreleased]\n\n${recorded.changelog}`,
      ),
    );
    const after = taskHashes(cwd);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const id of Object.keys(before)) {
      if (versionReaders(id))
        assert.notEqual(
          after[id].hash,
          before[id].hash,
          `${id} must read the version`,
        );
      else
        assert.equal(
          after[id].hash,
          before[id].hash,
          `${id} unexpectedly hashes release-only edits`,
        );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Nx's expanded file inputs retain the base tasks' complete input surface", (context) => {
  const baseRef = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const retirementFiles = [
    ".github/check-budgets.mjs",
    ".github/macos-policy.mjs",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.1.1/SHA256SUMS",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.1.1/action.yml",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.1.1/telemetry-help.txt",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.1.2/SHA256SUMS",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.1.2/action.yml",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.1.2/telemetry-help.txt",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.2.0/SHA256SUMS",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.2.0/action.yml",
    ".github/reporting/fixtures/onebudgetspec-github-action/v0.2.0/telemetry-help.txt",
    ".github/tests/policy.test.mjs",
    ".github/tests/routing-step.test.mjs",
  ];
  const retired = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baseRef, "--", ...retirementFiles],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const deleted = execFileSync(
    "git",
    // A renamed file leaves its old path's input surface just as a deleted one does.
    ["diff", "--name-only", "--no-renames", "--diff-filter=D", baseRef],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(deleted, retired);
  for (const file of retired) context.diagnostic(`retired input: ${file}`);
  const base = workspaceFixture(baseRef);
  const cwd = workspaceFixture();
  try {
    const before = taskHashes(base);
    const after = taskHashes(cwd, Object.keys(before));
    const split = taskHashes(cwd, [
      "onepipeline-ui-versions:test",
      "onepipeline-ui-versions:test-quick",
    ]);
    for (const [id, task] of Object.entries(before)) {
      const combined = [
        after[id],
        ...(/onepipeline-ui-(e2e|repo-tooling):/.test(id)
          ? Object.values(split)
          : []),
      ];
      const files = new Set(combined.flatMap((value) => value.inputs.files));
      const runtimes = combined.flatMap((value) => value.inputs.runtime);
      for (const file of task.inputs.files) {
        if (files.has(file) || retired.includes(file)) continue;
        if (/\bCHANGELOG[^/]*$/.test(file) && !versionReaders(id)) continue;
        const ecosystem = {
          "Cargo.toml": "cargo",
          "Cargo.lock": "cargo",
          "package.json": "npm",
          "bun.lock": "npm",
          "pyproject.toml": "python",
        }[file.split("/").at(-1)];
        assert.ok(
          ecosystem &&
            runtimes.some((command) =>
              command.includes(`--ecosystem ${ecosystem}`),
            ),
          `${id} lost ${file} from Nx's own expanded inputs`,
        );
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("every cached task separates platforms and test outputs name only profile/report files", () => {
  const cwd = workspaceFixture();
  try {
    const hashes = taskHashes(cwd);
    const problems = (tasks) =>
      Object.entries(tasks).flatMap(([id, task]) => [
        ...(!task.inputs.runtime.includes("node -p process.platform")
          ? [`${id}: platform missing`]
          : []),
        ...task.outputs
          .filter(
            (output) =>
              !/\.(profraw|json|lcov|xml|txt|html)$/.test(output) ||
              /\*\*|(?:^|\/)deps\//.test(output),
          )
          .map((output) => `${id}: invalid output ${output}`),
      ]);
    assert.deepEqual(problems(hashes), []);
    const id = "onepipeline-ui-e2e:test-quick";
    const broken = structuredClone(hashes);
    broken[id].inputs.runtime = broken[id].inputs.runtime.filter(
      (command) => command !== "node -p process.platform",
    );
    assert.ok(problems(broken).includes(`${id}: platform missing`));
    for (const output of [
      "{workspaceRoot}/target",
      "{workspaceRoot}/target/**/*",
      "{workspaceRoot}/elsewhere/e2e.exe",
    ]) {
      broken[id].outputs = [output];
      assert.ok(problems(broken).includes(`${id}: invalid output ${output}`));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("each declared file input rule moves every task that reads its probe", () => {
  const cwd = workspaceFixture();
  try {
    const before = taskHashes(cwd);
    const { moved, restored } = probeHashes(cwd, before);
    const probes = Object.keys(moved);
    assert.ok(probes.length >= 100, `only ${probes.length} probes were read`);
    for (const file of probes)
      for (const id of Object.keys(moved[file]))
        assert.notEqual(
          moved[file][id],
          before[id].hash,
          `${id}: declared input ${file} did not move its hash`,
        );
    // The one reader sees what the reader each edit once started its own process for sees,
    // so its hashes are Nx's: a graph file and a plain source, and the tree as restored.
    for (const file of ["nx.json", "README.md"]) {
      const original = readFileSync(join(cwd, file));
      writeFileSync(join(cwd, file), probeEdit(file, original));
      try {
        const isolated = taskHashes(cwd, Object.keys(moved[file]));
        for (const id of Object.keys(moved[file]))
          assert.equal(moved[file][id], isolated[id].hash, `${file}: ${id}`);
      } finally {
        writeFileSync(join(cwd, file), original);
      }
    }
    for (const [id, task] of Object.entries(before))
      assert.equal(restored[id], task.hash, `${id}: not restored`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
