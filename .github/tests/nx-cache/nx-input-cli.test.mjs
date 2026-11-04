import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
