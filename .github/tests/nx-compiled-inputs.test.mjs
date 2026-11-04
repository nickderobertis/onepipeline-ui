import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(".");
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
const hashes = (cwd) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [join(root, ".github/nx-task-hashes.mjs"), cwd, ...ids],
      {
        encoding: "utf8",
        env: { ...process.env, NX_DAEMON: "false" },
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
  );
const requireMoved = (before, after) => {
  for (const id of ids)
    assert.notEqual(
      after[id].hash,
      before[id].hash,
      `${id} omitted an input its Rust compile reads`,
    );
};

test("compiled test targets hash library sources and Cargo dependencies", () => {
  const cwd = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(), "nx-compiled-"),
  );
  try {
    const archive = execFileSync("git", ["archive", "HEAD"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", cwd], { input: archive });
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    for (const [file] of Object.values(projects))
      copyFileSync(join(root, file), join(cwd, file));
    copyFileSync(join(root, "nx.json"), join(cwd, "nx.json"));
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
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
