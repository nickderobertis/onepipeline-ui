import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("the production lint gate includes newly added tooling and test files", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "lint-selection-",
    ),
  );
  try {
    cpSync(".github", join(scratch, ".github"), {
      recursive: true,
      filter: (source) =>
        !source.includes("/.telemetry") && !source.includes("/node_modules"),
    });
    cpSync("biome.json", join(scratch, "biome.json"));
    symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
    const run = () =>
      spawnSync("node", [".github/lint.mjs"], {
        cwd: scratch,
        encoding: "utf8",
      });
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    for (const directory of [".github", ".github/tests"]) {
      const file = join(scratch, directory, "new-invalid.mjs");
      writeFileSync(file, "const = ;\n");
      const refused = run();
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout + refused.stderr, /new-invalid.mjs/);
      rmSync(file);
    }
    assert.equal(run().status, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
