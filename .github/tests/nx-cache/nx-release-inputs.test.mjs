import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

const versionReaders = (id) =>
  /^(onepipeline-ui-release:test$|onepipeline-ui-npm-launcher:|onepipeline-ui-versions:)/.test(
    id,
  );

test("real Nx replays release edits except targets whose tests read the version", () => {
  const cwd = workspaceFixture();
  try {
    const before = taskHashes(cwd);
    assert.ok(
      Object.keys(before).length >= 58,
      "cover the four jobs' full cacheable selection",
    );
    const manifest = readFileSync(join(cwd, "Cargo.toml"), "utf8");
    const version = manifest.match(/^version = "([^"]+)"/m)[1];
    const next = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
    // The exact three-file edit shape recorded from release-plz in the spike:
    // its package version, its own lock entry, and a six-line changelog section.
    writeFileSync(
      join(cwd, "Cargo.toml"),
      manifest.replace(`version = "${version}"`, `version = "${next}"`),
    );
    const lock = readFileSync(join(cwd, "Cargo.lock"), "utf8");
    writeFileSync(
      join(cwd, "Cargo.lock"),
      lock.replace(
        `name = "onepipeline-ui"\nversion = "${version}"`,
        `name = "onepipeline-ui"\nversion = "${next}"`,
      ),
    );
    const changelog = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      `## [${next}](https://github.com/nickderobertis/onepipeline-ui/compare/v${version}...v${next})\n\n### Fixed\n\n- Release input regression journey\n\n${changelog}`,
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
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Nx's expanded file inputs retain the base tasks' complete input surface", (context) => {
  const baseRef = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const retirementFiles = [
    ".github/macos-policy.mjs",
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
    ["diff", "--name-only", "--diff-filter=D", baseRef],
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
        ...(/:(test(?:-.+)?|lint|format-check|typecheck|doc|budgets)$/.test(id)
          ? task.outputs
              .filter(
                (output) =>
                  !/\.(profraw|json|lcov|xml|txt|html)$/.test(output) ||
                  /\*\*|(?:^|\/)deps\//.test(output),
              )
              .map((output) => `${id}: invalid output ${output}`)
          : []),
      ]);
    assert.deepEqual(problems(hashes), []);
    const id = "onepipeline-ui-e2e:test";
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

test("each declared file input rule moves every task that reads its probe", (context) => {
  const cwd = workspaceFixture();
  try {
    const before = taskHashes(cwd);
    const probes = [
      ...new Set(
        Object.values(before).flatMap((task) =>
          task.probes.map((probe) => probe.file),
        ),
      ),
    ];
    for (const file of probes) {
      const original = readFileSync(join(cwd, file));
      writeFileSync(
        join(cwd, file),
        file === "tsconfig.base.json"
          ? Buffer.from(
              original
                .toString()
                .replace('"target": "ES2024"', '"target": "ES2023"'),
            )
          : Buffer.concat([original, Buffer.from("\n")]),
      );
      try {
        const readers = Object.entries(before)
          .filter(([, task]) =>
            task.probes.some((probe) => probe.file === file),
          )
          .map(([id]) => id);
        const after = taskHashes(cwd, readers);
        for (const id of readers)
          assert.notEqual(
            after[id].hash,
            before[id].hash,
            `${id}: declared input ${file} did not move its hash`,
          );
      } finally {
        writeFileSync(join(cwd, file), original);
      }
      context.diagnostic(`hashed file-rule probe ${file}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
