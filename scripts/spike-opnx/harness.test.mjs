// The spike's two commands, driven as a person runs them: real Nx on this
// workspace, the real op-nx/github-cache bundle, and their exit codes.
//
//   node --test scripts/spike-opnx/harness.test.mjs
//
// The sidecar cases need the action checkout at measure.mjs's pinned commit;
// SPIKE_OPNX_ACTION names one, otherwise measure.mjs clones it into .tools.
// A replay (GET 200) and a stored write (PUT 200) need GitHub's own cache
// service, which only a runner reaches: those paths are proven by the CI runs
// the report cites, not here.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

test("task-hashes moves a task's hash, and names the input, when a real file in its project changes", () => {
  const probe = join(ROOT, "packages/dag-model/spike-opnx-harness-probe.txt");
  const changed = join(scratch, "changed.json");
  writeFileSync(probe, "a change the hasher must see\n");
  let done;
  try {
    done = run("task-hashes.mjs", [
      "capture",
      ROOT,
      "dag-model:test",
      "--out",
      changed,
    ]);
  } finally {
    rmSync(probe, { force: true });
  }
  assert.equal(done.status, 0, done.stderr);
  const compared = run("task-hashes.mjs", [
    "diff",
    join(scratch, "a.json"),
    changed,
  ]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.match(
    compared.stdout,
    /^moved dag-model:test \d+ -> \d+: dag-model:packages\/dag-model\/\*\*\/\*$/m,
  );
});

test("task-hashes refuses a workspace it cannot load Nx from, an unwritable record, and a record keyed by an object property", () => {
  const empty = mkdtempSync(join(scratch, "no-nx-"));
  const noNx = run("task-hashes.mjs", ["capture", empty, "dag-model:test"]);
  assert.equal(noNx.status, 1);
  assert.match(noNx.stderr, /cannot load Nx from/);
  assert.match(noNx.stderr, /^ACTION: /m);
  const unwritable = run("task-hashes.mjs", [
    "capture",
    ROOT,
    "dag-model:test",
    "--out",
    join(scratch, "no-such-dir", "x.json"),
  ]);
  assert.equal(unwritable.status, 1);
  assert.match(unwritable.stderr, /cannot write/);
  writeFileSync(
    join(scratch, "proto.json"),
    '{"tasks":{"constructor":{"hash":"1","nodes":{}}}}',
  );
  const proto = run("task-hashes.mjs", [
    "diff",
    join(scratch, "a.json"),
    join(scratch, "proto.json"),
  ]);
  assert.equal(proto.status, 1);
  assert.match(proto.stderr, /is not a capture record/);
});

test("measure refuses a task that is not project:target, and an action checkout whose bundle was changed", () => {
  for (const task of ["--help", "no-colon"]) {
    const refused = run("measure.mjs", ["--task", task]);
    assert.equal(refused.status, 2, task);
  }
  const source = process.env.SPIKE_OPNX_ACTION;
  if (!source) return;
  const dirty = join(scratch, "dirty-action");
  spawnSync("git", ["clone", "--quiet", source, dirty]);
  const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  spawnSync("git", ["-C", dirty, "checkout", "--quiet", head]);
  writeFileSync(
    join(dirty, "start-cache-server/index.js"),
    "process.exit(0)\n",
  );
  const refused = run("measure.mjs", ["--action", dirty]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /has changes to tracked files/);
});

// GitHub's listing, served at GITHUB_API_URL (the runner's own name for the
// REST base) so pagination and failures can be produced on demand.
const runAsync = (args, env) =>
  new Promise((done) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, "scripts/spike-opnx/measure.mjs"), ...args],
      { cwd: ROOT, env: { ...process.env, ...env } },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on("close", (status) => done({ status, stderr }));
  });
const listingServer = async (answer) => {
  const pages = [];
  const server = createServer((req, res) => {
    const page = Number(new URL(req.url, "http://x").searchParams.get("page"));
    pages.push(page);
    answer(page, res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, pages, url: `http://127.0.0.1:${server.address().port}` };
};
const entry = (id, key) => ({
  id,
  key,
  ref: "refs/pull/1/merge",
  size_in_bytes: 100,
  created_at: "2026-11-03T00:00:00Z",
});

test("measure pages through a store listing, counting each request and finding the task's entry", async () => {
  const hash = record("a.json").tasks["dag-model:test"].hash;
  const github = await listingServer((page, res) => {
    const caches =
      page === 1
        ? Array.from({ length: 100 }, (_, i) => entry(i + 1, `rust-${i}`))
        : [entry(101, `nx-cache-${hash}`), entry(102, "nx-cache-1")];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total_count: 102, actions_caches: caches }));
  });
  try {
    const done = await runAsync(
      [...action, "--out", join(scratch, "paged.json")],
      {
        GITHUB_API_URL: github.url,
        GITHUB_REPOSITORY: "owner/name",
        GITHUB_TOKEN: "t",
      },
    );
    assert.equal(done.status, 0, done.stderr);
    const listing = record("paged.json").store_listing;
    assert.deepEqual(github.pages, [1, 2]);
    assert.equal(listing.requests, 2);
    assert.equal(listing.entries, 102);
    assert.equal(listing.nxEntries, 2);
    assert.equal(listing.nxBytes, 200);
    assert.deepEqual(
      listing.thisTask.map((e) => e.id),
      [101],
    );
    assert.deepEqual(listing.storedByThisRun, []);
  } finally {
    github.server.close();
  }
});

test("measure reports a listing that fails or drifts from GitHub's shape as an error, never as a count", async () => {
  const cases = [
    [(_page, res) => res.writeHead(500).end(), /^HTTP 500$/],
    [
      (_page, res) =>
        res.end(
          JSON.stringify({ total_count: 1, actions_caches: [{ id: 1 }] }),
        ),
      /did not have the documented shape/,
    ],
    [(_page, res) => res.end("not json"), /listing request failed/],
  ];
  for (const [answer, error] of cases) {
    const github = await listingServer(answer);
    try {
      const done = await runAsync(
        [...action, "--out", join(scratch, "listing-error.json")],
        {
          GITHUB_API_URL: github.url,
          GITHUB_REPOSITORY: "owner/name",
          GITHUB_TOKEN: "t",
        },
      );
      assert.equal(done.status, 0, done.stderr);
      const listing = record("listing-error.json").store_listing;
      assert.match(listing.error, error);
      assert.equal(listing.requests, 1);
      assert.equal(listing.entries, undefined);
    } finally {
      github.server.close();
    }
  }
});
