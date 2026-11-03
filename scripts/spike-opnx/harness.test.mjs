// The spike's two commands, driven as a person runs them: real Nx on this
// workspace, the real op-nx/github-cache bundle, and their exit codes.
//
//   node --test scripts/spike-opnx/harness.test.mjs
//
// The sidecar cases need the action checkout at measure.mjs's pinned commit;
// SPIKE_OPNX_ACTION names one, otherwise measure.mjs clones it into .tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "spike-opnx-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const run = (script, args, env = {}) =>
  spawnSync(
    process.execPath,
    [join(ROOT, "scripts/spike-opnx", script), ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 600_000,
    },
  );
const action = process.env.SPIKE_OPNX_ACTION
  ? ["--action", process.env.SPIKE_OPNX_ACTION]
  : [];
const record = (name) => JSON.parse(readFileSync(join(scratch, name), "utf8"));

test("task-hashes captures a task with Nx's hasher, and the same tree diffs as same", () => {
  const a = join(scratch, "a.json");
  const b = join(scratch, "b.json");
  for (const out of [a, b]) {
    const done = run("task-hashes.mjs", [
      "capture",
      ROOT,
      "dag-model:test",
      "--out",
      out,
    ]);
    assert.equal(done.status, 0, done.stderr);
  }
  const captured = JSON.parse(readFileSync(a, "utf8")).tasks["dag-model:test"];
  assert.match(captured.hash, /^\d+$/);
  assert.ok(
    Object.keys(captured.nodes).some((node) =>
      node.startsWith("dag-model:packages/dag-model"),
    ),
    "the record carries Nx's per-input nodes",
  );
  const compared = run("task-hashes.mjs", ["diff", a, b]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(compared.stdout.trim(), `same dag-model:test ${captured.hash}`);
});

test("task-hashes names the input that moved, and refuses records that do not cover the same tasks", () => {
  const base = JSON.parse(readFileSync(join(scratch, "a.json"), "utf8"));
  const task = base.tasks["dag-model:test"];
  const node = Object.keys(task.nodes)[0];
  const moved = {
    ...base,
    tasks: {
      "dag-model:test": {
        hash: `${task.hash}1`,
        nodes: { ...task.nodes, [node]: "changed" },
      },
      "dag-model:lint": { hash: "1", nodes: {} },
    },
  };
  writeFileSync(join(scratch, "moved.json"), JSON.stringify(moved));
  const compared = run("task-hashes.mjs", [
    "diff",
    join(scratch, "a.json"),
    join(scratch, "moved.json"),
  ]);
  assert.equal(compared.status, 1);
  assert.match(
    compared.stdout,
    new RegExp(
      `^moved dag-model:test .*: ${node.replace(/[[\]{}().*+?^$|\\]/g, "\\$&")}$`,
      "m",
    ),
  );
  assert.match(compared.stderr, /dag-model:lint is only in .*moved\.json/);
  assert.match(compared.stderr, /^ACTION: /m);
  writeFileSync(join(scratch, "bad.json"), '{"tasks":{"x":{}}}');
  const bad = run("task-hashes.mjs", [
    "diff",
    join(scratch, "a.json"),
    join(scratch, "bad.json"),
  ]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not a capture record/);
});

test("measure refuses an option it does not know, as a usage error", () => {
  const refused = run("measure.mjs", ["--store", "sometimes"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^ACTION: /m);
});

test("measure records a sidecar that is down failing Nx before the task runs", () => {
  const done = run("measure.mjs", [
    "--sidecar",
    "none",
    "--out",
    join(scratch, "down.json"),
  ]);
  const down = record("down.json");
  assert.equal(done.status, 1);
  assert.equal(down.nx.exit, 1);
  assert.deepEqual(
    down.requests.map((r) => [r.method, r.status, r.error]),
    [["GET", 0, "ECONNREFUSED"]],
  );
  assert.doesNotMatch(done.stdout, /Test Files/, "the test never ran");
});

test("measure stands the real sidecar against a full store: a miss and a refused write, Nx green", () => {
  const done = run("measure.mjs", [
    ...action,
    "--store",
    "full",
    "--out",
    join(scratch, "full.json"),
  ]);
  assert.equal(done.status, 0, done.stderr);
  const full = record("full.json");
  assert.deepEqual(
    full.requests.map((r) => [r.method, r.status]),
    [
      ["GET", 404],
      ["PUT", 409],
    ],
  );
  assert.ok(full.storeCalls.includes("CreateCacheEntry"));
  assert.match(done.stdout, /^measure: dag-model:test: Nx exit 0 .*PUT 409/m);
});
