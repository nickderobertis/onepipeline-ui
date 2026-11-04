import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

test("the contract suite's real Git baseline input invalidates a cached verdict, and unchanged inputs replay", () => {
  const cwd = workspaceFixture();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Baseline journey",
    GIT_AUTHOR_EMAIL: "baseline@example.invalid",
    GIT_COMMITTER_NAME: "Baseline journey",
    GIT_COMMITTER_EMAIL: "baseline@example.invalid",
    GITHUB_ACTIONS: "",
    NX_DAEMON: "false",
    NX_SKIP_NX_CACHE: "false",
    NX_SKIP_REMOTE_CACHE: "true",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("commit", "--allow-empty", "-qm", "baseline fixture");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    const contract = JSON.parse(
      readFileSync(join(cwd, ".github/tests/nx-cache/project.json"), "utf8"),
    );
    const path = join(cwd, "packages/timeline-categories/project.json");
    const project = JSON.parse(readFileSync(path, "utf8"));
    // Use the production suite's complete input definition with the smallest real
    // test task, avoiding a recursive execution of this suite inside itself.
    project.namedInputs = {
      ...project.namedInputs,
      cacheContract: contract.namedInputs.cacheContract,
    };
    project.targets.test.inputs = contract.targets.test.inputs;
    writeFileSync(path, JSON.stringify(project));
    const id = "timeline-categories:test";
    const hash = () => taskHashes(cwd, [id])[id].hash;
    const nx = () =>
      spawnSync(
        process.execPath,
        ["node_modules/nx/dist/bin/nx.js", "run", id, "--output-style=static"],
        { cwd, env, encoding: "utf8" },
      );
    const before = hash();
    const first = nx();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const replay = nx();
    assert.equal(replay.status, 0, replay.stdout + replay.stderr);
    assert.match(
      replay.stdout,
      /Nx read the output from the cache instead of running the command for 1 out of 1 tasks/,
    );
    git("commit", "--allow-empty", "-qm", "changed baseline only");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    assert.notEqual(hash(), before, "the baseline is an input of the verdict");
    const changed = nx();
    assert.equal(changed.status, 0, changed.stdout + changed.stderr);
    assert.doesNotMatch(changed.stdout, /Nx read the output from the cache/);
    project.targets.test.inputs = project.targets.test.inputs.filter(
      (input) => input.runtime !== "git merge-base HEAD origin/main",
    );
    writeFileSync(path, JSON.stringify(project));
    const missing = hash();
    git("commit", "--allow-empty", "-qm", "another baseline only");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    assert.equal(
      hash(),
      missing,
      "negative control: omitting the baseline loses invalidation",
    );
    assert.throws(
      () => assert.notEqual(hash(), missing, "baseline invalidation regressed"),
      /baseline invalidation regressed/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
