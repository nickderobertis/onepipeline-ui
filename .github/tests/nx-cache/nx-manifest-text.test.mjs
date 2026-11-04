import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { taskHashes, workspaceFixture } from "./nx-fixture.mjs";

const projects = {
  "dag-ui-e2e": "apps/dag-ui-e2e",
  "dag-ui": "apps/dag-ui",
  "dag-layout": "packages/dag-layout",
  "dag-model": "packages/dag-model",
  "telemetry-client": "packages/telemetry-client",
  "timeline-categories": "packages/timeline-categories",
};
test("manifest text checks invalidate on whitespace and package-version bytes while semantic consumers replay", () => {
  const cwd = workspaceFixture();
  try {
    const ids = Object.keys(projects).flatMap((project) =>
      ["format-check", "lint", "test", "typecheck"].map(
        (target) => `${project}:${target}`,
      ),
    );
    const before = taskHashes(cwd, ids);
    for (const [project, root] of Object.entries(projects)) {
      const path = join(cwd, root, "package.json");
      const original = readFileSync(path, "utf8");
      const manifest = JSON.parse(original);
      const version = manifest.version;
      const lockPath = join(cwd, "bun.lock");
      const lock = readFileSync(lockPath, "utf8");
      const member = `"name": "${manifest.name}",\n      "version": "${version}"`;
      assert.ok(lock.includes(member), `${project} has a workspace lock entry`);
      assert.equal(typeof version, "string");
      try {
        for (const [change, changed, changedLock] of [
          ["whitespace", `${original} \n`, lock],
          [
            "version and its lock entry",
            original.replace(`"${version}"`, '"9.8.7-text-check"'),
            lock.replace(member, member.replace(version, "9.8.7-text-check")),
          ],
        ]) {
          writeFileSync(path, changed);
          writeFileSync(lockPath, changedLock);
          const after = taskHashes(
            cwd,
            ids.filter((id) => id.startsWith(`${project}:`)),
          );
          for (const [id, task] of Object.entries(after)) {
            if (/:(format-check|lint)$/.test(id))
              assert.notEqual(
                task.hash,
                before[id].hash,
                `${id} must hash raw manifest bytes (${change})`,
              );
            else
              assert.equal(
                task.hash,
                before[id].hash,
                `${id} reads manifest meaning, not ${change}`,
              );
          }
        }
      } finally {
        writeFileSync(path, original);
        writeFileSync(lockPath, lock);
      }
    }
    const nx = () =>
      spawnSync(
        process.execPath,
        [
          "node_modules/nx/dist/bin/nx.js",
          "run",
          "timeline-categories:format-check",
          "--output-style=static",
        ],
        {
          cwd,
          env: {
            ...process.env,
            GITHUB_ACTIONS: "",
            NX_DAEMON: "false",
            NX_SKIP_NX_CACHE: "false",
            NX_SKIP_REMOTE_CACHE: "true",
          },
          encoding: "utf8",
        },
      );
    const valid = nx();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const replay = nx();
    assert.equal(replay.status, 0, replay.stdout + replay.stderr);
    assert.match(
      replay.stdout,
      /Nx read the output from the cache instead of running the command for 1 out of 1 tasks/,
    );
    const manifest = join(cwd, projects["timeline-categories"], "package.json");
    writeFileSync(manifest, `${readFileSync(manifest, "utf8")} \n`);
    const invalid = nx();
    assert.notEqual(
      invalid.status,
      0,
      "a cached pass must not hide bad formatting",
    );
    assert.match(invalid.stdout + invalid.stderr, /package\.json[\s\S]*format/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
