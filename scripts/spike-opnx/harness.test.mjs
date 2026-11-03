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

test("task-hashes refuses what it cannot run: usage errors exit 2, a task outside the graph or an unreadable record exits 1", () => {
  for (const args of [
    ["sometimes"],
    ["capture", ROOT],
    ["diff", "only-one.json"],
    ["capture", ROOT, "no-colon"],
  ]) {
    const refused = run("task-hashes.mjs", args);
    assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stderr}`);
    assert.match(refused.stderr, /^ACTION: /m);
  }
  const absent = run("task-hashes.mjs", ["capture", ROOT, "dag-model:nope"]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /no task dag-model:nope in the task graph/);
  writeFileSync(join(scratch, "array.json"), '{"tasks":[]}');
  writeFileSync(join(scratch, "torn.json"), '{"tasks":');
  for (const name of ["missing.json", "torn.json", "array.json"]) {
    const bad = run("task-hashes.mjs", [
      "diff",
      join(scratch, "a.json"),
      join(scratch, name),
    ]);
    assert.equal(bad.status, 1, name);
    assert.match(bad.stderr, /^ACTION: /m);
  }
});

test("measure refuses an inherited flag name and an unusable external sidecar before forwarding a token", () => {
  const cases = [
    [["--constructor", "x"], {}],
    [["--sidecar", "external"], { NX_SELF_HOSTED_REMOTE_CACHE_SERVER: "" }],
    [
      ["--sidecar", "external"],
      {
        NX_SELF_HOSTED_REMOTE_CACHE_SERVER: "http://example.com:3000",
        NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: "t",
      },
    ],
    [
      ["--sidecar", "external"],
      {
        NX_SELF_HOSTED_REMOTE_CACHE_SERVER: "http://127.0.0.1:70000",
        NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: "t",
      },
    ],
  ];
  for (const [args, env] of cases) {
    const refused = run("measure.mjs", args, env);
    assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stderr}`);
    assert.match(refused.stderr, /^ACTION: /m);
  }
});

test("measure refuses an action checkout at any commit but the pinned one", () => {
  const other = join(scratch, "other-action");
  const git = (...args) =>
    spawnSync("git", ["-C", other, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "--quiet", other]);
  spawnSync("mkdir", ["-p", join(other, "start-cache-server")]);
  writeFileSync(join(other, "start-cache-server/index.js"), "");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
  const refused = run("measure.mjs", ["--action", other]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not op-nx\/github-cache [0-9a-f]{40}/);
  assert.match(refused.stderr, /^ACTION: /m);
});

test("measure records a token mismatch failing Nx with a 401", () => {
  const done = run("measure.mjs", [
    ...action,
    "--nx-token",
    "0".repeat(64),
    "--out",
    join(scratch, "401.json"),
  ]);
  assert.equal(done.status, 1);
  assert.deepEqual(
    record("401.json").requests.map((r) => [r.method, r.status]),
    [["GET", 401]],
  );
});

test("measure stands the real sidecar against a closed and a faulting store: each a miss and a refused write, Nx green", () => {
  for (const store of ["down", "fault"]) {
    const done = run("measure.mjs", [
      ...action,
      "--store",
      store,
      "--out",
      join(scratch, `${store}.json`),
    ]);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(
      record(`${store}.json`).requests.map((r) => [r.method, r.status]),
      [
        ["GET", 404],
        ["PUT", 409],
      ],
      store,
    );
  }
});

test("measure without --out prints one JSON record on stdout, a step summary, and lists the store when it can", () => {
  const summary = join(scratch, "summary.md");
  writeFileSync(summary, "");
  const done = run("measure.mjs", action, { GITHUB_STEP_SUMMARY: summary });
  assert.equal(done.status, 0, done.stderr);
  const result = JSON.parse(done.stdout);
  assert.deepEqual(
    result.requests.map((r) => [r.method, r.status]),
    [
      ["GET", 404],
      ["PUT", 403],
    ],
    "outside Actions the sidecar is the read-only Releases reader",
  );
  assert.match(done.stderr, /^measure: dag-model:test: Nx exit 0/m);
  assert.match(readFileSync(summary, "utf8"), /^\| PUT \| \d+ \| 403 \|/m);
  if (result.store_listing && !result.store_listing.error) {
    assert.ok(result.store_listing.requests >= 1);
    assert.deepEqual(result.store_listing.storedByThisRun, []);
  }
});

test("measure drives a sidecar it did not start, at the URL and token the workflow pre-set", async () => {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ],
    { encoding: "utf8" },
  );
  const port = probe.stdout.trim();
  const token = "a".repeat(64);
  const dir =
    process.env.SPIKE_OPNX_ACTION ?? join(ROOT, ".tools/op-nx-github-cache");
  const { spawn } = await import("node:child_process");
  const sidecar = spawn(
    process.execPath,
    [join(dir, "start-cache-server/index.js")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        INPUT_PORT: port,
        NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: token,
      },
      stdio: "ignore",
    },
  );
  try {
    const done = run(
      "measure.mjs",
      ["--sidecar", "external", "--out", join(scratch, "external.json")],
      {
        NX_SELF_HOSTED_REMOTE_CACHE_SERVER: `http://127.0.0.1:${port}`,
        NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: token,
      },
    );
    assert.equal(done.status, 0, done.stderr);
    const external = record("external.json");
    assert.equal(external.readiness.live, 401);
    assert.equal(external.readiness.authed, 404);
    assert.deepEqual(
      external.requests.map((r) => [r.method, r.status]),
      [
        ["GET", 404],
        ["PUT", 403],
      ],
    );
  } finally {
    sidecar.kill("SIGTERM");
  }
});
