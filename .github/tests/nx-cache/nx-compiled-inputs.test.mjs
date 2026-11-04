import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

const projects = {
  "dag-ui-build-cache": [
    "apps/dag-ui-build-cache/project.json",
    ["test", "lint"],
  ],
  "onepipeline-ui-baseline-reuse": [
    "tests/tiers/baseline-reuse/project.json",
    ["test", "test-quick"],
  ],
  "onepipeline-ui-ci-jobs": ["tests/tiers/ci-jobs/project.json", ["test"]],
  "onepipeline-ui-judged-tier": [
    "tests/tiers/judged-tier/project.json",
    ["test"],
  ],
  "onepipeline-ui-deps-audit-toolchain": [
    "tests/tiers/deps-audit-toolchain/project.json",
    ["test"],
  ],
};
const ids = Object.entries(projects).flatMap(([name, [, targets]]) =>
  targets.map((target) => `${name}:${target}`),
);
const hashes = (cwd) => taskHashes(cwd, ids);
const requireMoved = (before, after) => {
  for (const id of ids)
    assert.notEqual(
      after[id].hash,
      before[id].hash,
      `${id} omitted an input its Rust compile reads`,
    );
};

test("compiled test targets hash library sources and Cargo dependencies", () => {
  const cwd = workspaceFixture();
  try {
    const before = hashes(cwd);
    const source = readFileSync(join(cwd, "src/lib.rs"), "utf8");
    writeFileSync(
      join(cwd, "src/lib.rs"),
      `${source}\n// hash regression probe\n`,
    );
    requireMoved(before, hashes(cwd));
    writeFileSync(join(cwd, "src/lib.rs"), source);
    const manifest = readFileSync(join(cwd, "Cargo.toml"), "utf8");
    const changed = manifest.replace(
      /(onepipeline = .*?=)(\d+\.\d+\.\d+)/,
      "$1999.0.0",
    );
    assert.notEqual(
      changed,
      manifest,
      "the dependency probe must edit a real dependency",
    );
    writeFileSync(join(cwd, "Cargo.toml"), changed);
    requireMoved(before, hashes(cwd));
    writeFileSync(join(cwd, "Cargo.toml"), manifest);
    for (const [file, mutate] of [
      [
        "Cargo.toml",
        (text) => text.replace("bundled-ui = []", 'bundled-ui = ["probe"]'),
      ],
      [
        "Cargo.lock",
        (text) =>
          text.replace(
            /version = "(\d+)\.(\d+)\.(\d+)"/,
            'version = "999.0.0"',
          ),
      ],
      ["rust-toolchain.toml", (text) => `${text}\n# toolchain hash probe\n`],
    ]) {
      const original = readFileSync(join(cwd, file), "utf8");
      const changed = mutate(original);
      assert.notEqual(changed, original, file);
      writeFileSync(join(cwd, file), changed);
      requireMoved(before, hashes(cwd));
      writeFileSync(join(cwd, file), original);
    }
    // Negative control: removing the compile surface reproduces the original hole.
    const file = join(cwd, "apps/dag-ui-build-cache/project.json");
    const definition = JSON.parse(readFileSync(file, "utf8"));
    for (const target of ["test", "lint"])
      definition.targets[target].inputs = definition.targets[
        target
      ].inputs.filter((input) => input !== "apiServerSurface");
    writeFileSync(file, JSON.stringify(definition));
    const broken = hashes(cwd);
    writeFileSync(join(cwd, "src/lib.rs"), `${source}\n// negative control\n`);
    assert.throws(() => requireMoved(broken, hashes(cwd)), /omitted an input/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
