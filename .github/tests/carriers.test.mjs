import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { interpolate, resolveWorkflow, workflows } from "../workflow-graph.mjs";

test("actual carrier wiring rules on real result commands, including prerequisite failure and affected skips", () => {
  const ci = workflows().find((w) => w.file === "ci.yml").document;
  for (const id of ["cross-macos", "install-macos"]) {
    const job = ci.jobs[id];
    const step = job.steps.at(-1);
    for (const changes of ["success", "failure", "cancelled"])
      for (const quality of ["success", "failure", "cancelled"])
        for (const macos of ["success", "failure", "cancelled", "skipped", ""])
          for (const required of ["true", "false"]) {
            const context = {
              needs: {
                changes: {
                  result: changes,
                  outputs: { crate: "true", macos: required },
                },
                quality: { result: quality },
                macos: { result: macos },
              },
            };
            const env = Object.fromEntries(
              Object.entries(step.env).map(([key, expression]) => [
                key,
                String(interpolate(expression, context)),
              ]),
            );
            const result = spawnSync("bash", ["-c", step.run], {
              env: { ...process.env, ...env },
              encoding: "utf8",
            });
            assert.equal(
              result.status === 0,
              changes === "success" &&
                quality === "success" &&
                (macos === "success" ||
                  (macos === "skipped" && required === "false")),
              JSON.stringify({ id, changes, quality, macos, required }),
            );
          }
  }
  const rows = resolveWorkflow(
    "ci.yml",
    ci,
    { event: "pull_request", action: "synchronize", crate: "false" },
    { macosRequired: true },
  );
  assert.ok(rows.filter((row) => row.macos).every((row) => !row.requested));
  assert.ok(rows.find((row) => row.job === "cross-macos").requested);
});
