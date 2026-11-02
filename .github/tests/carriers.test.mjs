import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkflow, workflows } from "../workflow-graph.mjs";

// The macOS carriers that reported `test-macos`'s verdict beside it are retired:
// `test-macos` is a required context of its own. What stays is its cost.
test("an unaffected crate still costs one Mac job, never a second", () => {
  const ci = workflows().find((w) => w.file === "ci.yml").document;
  const rows = resolveWorkflow(
    "ci.yml",
    ci,
    { event: "pull_request", action: "synchronize", crate: "false" },
    { macosRequired: true },
  );
  // `test-macos` starts on every pull request but a release-plz branch's, and
  // affected selection — not a job condition — decides what it runs.
  assert.deepEqual(
    rows.filter((row) => row.macos && row.requested).map((row) => row.job),
    ["test-macos"],
  );
});
