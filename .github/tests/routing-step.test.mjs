import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { interpolate, workflows } from "../workflow-graph.mjs";
import { history, prEvent } from "./histories.mjs";

test("the production Actions step classifies real histories and exposes the output routing consumes", () => {
  const h = history();
  const ci = workflows().find((w) => w.file === "ci.yml").document;
  const step = ci.jobs.changes.steps.find((s) => s.id === "macos");
  assert.ok(step, "CI must run the shared classifier");
  try {
    symlinkSync(resolve(".github"), join(h.root, ".github"), "dir");
    for (const [payload, diff, event, expected] of [
      [prEvent(), "source", "pull_request", true],
      [prEvent("release-plz-123"), "version-only", "pull_request", false],
      [prEvent("release-plz-123"), "dependency", "pull_request", true],
      [prEvent("release-plz-123", true), "version-only", "pull_request", true],
      ["{", "version-only", "pull_request", true],
      [prEvent("release-plz-123"), "version-only", "push", false],
    ]) {
      const input = join(h.root, "workflow-event.json");
      const output = join(h.root, "workflow-output");
      writeFileSync(
        input,
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
      writeFileSync(output, "");
      const github = {
        event_name: event,
        sha: h.heads[diff],
        event: {
          before: h.base,
          pull_request: { base: { sha: h.base }, head: { sha: h.heads[diff] } },
        },
      };
      const env = Object.fromEntries(
        Object.entries(step.env).map(([key, value]) => [
          key,
          String(interpolate(value, { github })),
        ]),
      );
      execFileSync("bash", ["-c", step.run], {
        cwd: h.root,
        env: {
          ...process.env,
          ...env,
          GITHUB_EVENT_NAME: event,
          GITHUB_EVENT_PATH: input,
          GITHUB_OUTPUT: output,
        },
        stdio: "pipe",
      });
      const fields = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      const exposed = interpolate(ci.jobs.changes.outputs.macos, {
        steps: { macos: { outputs: fields } },
      });
      assert.equal(
        exposed,
        String(expected),
        JSON.stringify({ diff, event, payload }),
      );
    }
  } finally {
    h.close();
  }
});

test("manual diagnostic rejects empty registry metadata before invoking the real smoke command", () => {
  const diagnostic = workflows().find((w) => w.file === "published-smoke.yml")
    .document.jobs["macos-diagnostic"];
  for (const step of diagnostic.steps.filter((step) => step.run)) {
    const result = spawnSync(
      "bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        `pip() { return 0; }; npm() { return 0; };
${step.run}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /reported no version/);
    assert.match(result.stdout + result.stderr, /ACTION:/);
  }
});
