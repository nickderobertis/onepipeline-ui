import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

test("the hash inspection CLI rejects malformed workspaces, selectors and unknown tasks as usage", () => {
  for (const args of [
    [],
    ["missing-nx-workspace", "docs:test"],
    [".", "--unknown"],
    [".", "--ci", "docs:test"],
    [".", "not-a-task"],
    [".", "missing-project:test"],
    [".", "docs:missing-target"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [".github/tests/nx-cache/nx-task-hashes.mjs", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NX_DAEMON: "false",
          NX_ISOLATE_PLUGINS: "false",
        },
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ACTION: name a readable Nx workspace/);
  }
});

test("Nx fixture readers hash and select on the production cache plugin they load", () => {
  const cwd = workspaceFixture();
  const ids = [
    "onepipeline-ui-judged-tier:test",
    "dag-ui-build-cache:test",
    "github-workflows-judge-install:test",
  ];
  try {
    const plugin = join(cwd, "scripts/nx-remote-cache.mjs");
    // Force Nx's whole-second mtime collision, independent of machine speed.
    const timestamp = new Date("2026-01-01T00:00:00Z");
    utimesSync(plugin, timestamp, timestamp);
    const archivedHashes = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [resolve(".github/tests/nx-cache/nx-task-hashes.mjs"), cwd, ...ids],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NX_DAEMON: "false",
              NX_ISOLATE_PLUGINS: "false",
              NX_WORKSPACE_DATA_DIRECTORY: join(cwd, ".nx/workspace-data"),
            },
          },
        ),
      );
    const archivedBefore = archivedHashes();
    const before = taskHashes(cwd, ids);
    appendFileSync(
      join(cwd, "scripts/nx-remote-cache.mjs"),
      "\n// Cache-plugin input regression probe.\n",
    );
    utimesSync(plugin, timestamp, timestamp);
    const archivedAfter = archivedHashes();
    for (const id of ids)
      assert.equal(
        archivedAfter[id].hash,
        archivedBefore[id].hash,
        `${id} reproduces Nx's stale file-hash archive`,
      );
    const after = taskHashes(cwd, ids);
    for (const id of ids)
      assert.notEqual(
        after[id].hash,
        before[id].hash,
        `${id} loads the changed cache plugin`,
      );
    const affected = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "node_modules/nx/dist/bin/nx.js",
          "show",
          "projects",
          "--affected",
          "--files=scripts/nx-remote-cache.mjs",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            NX_DAEMON: "false",
            NX_ISOLATE_PLUGINS: "false",
          },
        },
      ),
    );
    for (const id of ids)
      assert.ok(
        affected.includes(id.split(":")[0]),
        `${id} is selected for its changed plugin`,
      );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("both test tiers hash the real judge fingerprint and ignore recording-only changes", () => {
  const cwd = workspaceFixture();
  const ids = [
    "onepipeline-ui-judged-tier:test",
    "github-workflows-nx-cache:test",
    "onepipeline-ui-repo-tooling:test-quick",
  ];
  const model = process.env.ONEHARNESS_MODEL;
  const history = process.env.LLMLINT_NO_HISTORY;
  try {
    delete process.env.ONEHARNESS_MODEL;
    delete process.env.LLMLINT_NO_HISTORY;
    const before = taskHashes(cwd, ids);
    // Resolve a different configuration through the real installed judge. This
    // changes its fingerprint without editing any declared workspace file.
    process.env.ONEHARNESS_MODEL = "cache-input-probe-model";
    const changed = taskHashes(cwd, ids);
    for (const id of ids.slice(0, 2))
      assert.notEqual(
        changed[id].hash,
        before[id].hash,
        `${id} reads the judge`,
      );
    assert.equal(changed[ids[2]].hash, before[ids[2]].hash);
    process.env.LLMLINT_NO_HISTORY = "1";
    const recordingOnly = taskHashes(cwd, ids);
    for (const id of ids)
      assert.equal(recordingOnly[id].hash, changed[id].hash);
  } finally {
    if (model === undefined) delete process.env.ONEHARNESS_MODEL;
    else process.env.ONEHARNESS_MODEL = model;
    if (history === undefined) delete process.env.LLMLINT_NO_HISTORY;
    else process.env.LLMLINT_NO_HISTORY = history;
    rmSync(cwd, { recursive: true, force: true });
  }
});
