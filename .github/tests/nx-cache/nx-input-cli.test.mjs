import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
    const before = taskHashes(cwd, ids);
    appendFileSync(
      join(cwd, "scripts/nx-remote-cache.mjs"),
      "\n// Cache-plugin input regression probe.\n",
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
