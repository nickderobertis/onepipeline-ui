import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { partitionBase } from "./partition-base.mjs";

test("a synthetic PR merge retains the branch fork point and its own tier edits", () => {
  const cwd = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "partition-base-",
    ),
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (path, content, message) => {
    writeFileSync(join(cwd, path), content);
    git("add", path);
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Partition journey");
    git("config", "user.email", "partition@example.test");
    const fork = commit("tiers", "original tiers\n", "original");
    git("checkout", "-b", "feature");
    const head = commit(
      "feature-tiers",
      "branch tier changes\n",
      "split tiers",
    );
    git("checkout", "main");
    const laterBase = commit("tiers", "later main tiers\n", "move a tier");
    git("update-ref", "refs/remotes/origin/main", laterBase);
    git("merge", "--no-ff", "feature", "-m", "synthetic PR merge");
    const event = join(cwd, "event.json");
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { head: { sha: head } } }),
    );
    const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event };
    const base = partitionBase(cwd, env);
    assert.equal(
      base,
      fork,
      "later base tiers must not enter the reference set",
    );
    assert.equal(git("show", `${base}:tiers`), "original tiers");
    assert.equal(git("show", "HEAD:feature-tiers"), "branch tier changes");
    assert.equal(partitionBase(cwd, {}), laterBase, "local runs use HEAD");
    for (const sha of ["--help", "HEAD", null]) {
      writeFileSync(event, JSON.stringify({ pull_request: { head: { sha } } }));
      assert.throws(
        () => partitionBase(cwd, env),
        /Invalid pull request head SHA/,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
