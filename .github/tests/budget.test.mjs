import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("real telemetry reporter refuses missing and stale source evidence", () => {
  const scratch = mkdtempSync(
    join(
      process.env.ONEPIPELINE_NODE_SCRATCH_DIR || tmpdir(),
      "budget-evidence-",
    ),
  );
  try {
    const missing = spawnSync(
      "node",
      [
        ".github/macos-budget.mjs",
        "--metric",
        "jobs-per-run",
        "--telemetry",
        join(scratch, "missing.json"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT/);
    const stale = join(scratch, "stale.json");
    writeFileSync(
      stale,
      JSON.stringify({ schemaVersion: 1, sourceDigest: "stale" }),
    );
    const refused = spawnSync(
      "node",
      [
        ".github/macos-budget.mjs",
        "--metric",
        "runs-per-change",
        "--telemetry",
        stale,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /missing or stale telemetry/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
