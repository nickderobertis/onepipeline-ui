// The run-open harness, driven as a user runs it: its one command against a real server
// over a corpus it writes. `HARNESS_BINARY` names another server; the default is what
// `scripts/spike-run-open-costs-build.sh` builds, without which these fail.
//   node --test spikes/run-open-costs/harness.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";

const REPO = resolve(import.meta.dirname, "../..");
const HARNESS = join(REPO, "scripts/spike-run-open-costs.mjs");
const CORPUS = join(REPO, "apps/dag-ui-e2e/load/corpus.mjs");
const BARE = "/usr/bin:/bin";
const RUN = "load-live-open";
let work;
let root;

/** One run of the command; what it printed and every server it left alive. */
function harness(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HARNESS, ...args], {
      cwd: work,
      env: { ...process.env, ONEPIPELINE_NODE_SCRATCH_DIR: work },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) =>
      done({ code, stdout, stderr, leftAlive: serversOf(child.pid) }),
    );
  });
}

/** The servers whose `--session` names this harness process. */
function serversOf(pid) {
  const session = `spike-run-open-costs-${pid}`;
  const alive = readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .filter((entry) => {
      try {
        return readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(session);
      } catch {
        return false;
      }
    })
    .map(Number);
  // A leak the assertion below reports must not outlive this test.
  for (const server of alive) process.kill(server, "SIGKILL");
  return alive;
}

before(() => {
  work = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "harness-"),
  );
  root = join(work, "runs");
  const written = spawnSync(
    process.execPath,
    [CORPUS, root, "journey", "transcript-store", "streams=20"],
    { encoding: "utf8" },
  );
  assert.equal(written.status, 0, written.stderr);
  assert.ok(existsSync(join(dirname(root), "history")));
});

after(() => rmSync(work, { recursive: true, force: true }));

test("a status read reports its wall time and attributes it", async () => {
  const run = await harness([
    "--runs-root",
    root,
    "--run",
    RUN,
    "--measure",
    "status",
    "--server-path",
    BARE,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.run, RUN);
  assert.equal(report.run_facts.records, 1500);
  assert.ok(report.wall_seconds > 0);
  assert.ok(report.response_bytes > 0);
  assert.ok(
    report.attribution.attributed_share >= 0.8,
    `attributed ${report.attribution.attributed_share}`,
  );
  assert.ok(
    report.attribution.rows.some((row) =>
      row.cause.startsWith("RunView::open"),
    ),
    "the fold is a named cause",
  );
  assert.deepEqual(run.leftAlive, []);
});

test("a subscription reads the corpus's recorded sessions", async () => {
  const run = await harness([
    "--runs-root",
    root,
    "--run",
    RUN,
    "--measure",
    "graph",
  ]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const read = report.attribution.rows.find((row) =>
    row.cause.startsWith("activity description"),
  );
  // A reference the engine refuses costs microseconds without opening the file.
  assert.ok(read && read.seconds > 0.05, `activity read: ${read?.seconds}`);
  assert.deepEqual(run.leftAlive, []);
});

test("a run that is not there fails, says so, and leaves no server", async () => {
  const run = await harness([
    "--runs-root",
    root,
    "--run",
    "no-such-run",
    "--measure",
    "status",
    "--server-path",
    BARE,
  ]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /status: 404/u);
  assert.equal(run.stdout, "");
  assert.deepEqual(run.leftAlive, []);
});

test("a measure that does not exist is a usage error naming the choices", async () => {
  const run = await harness(["--runs-root", root, "--measure", "nonsense"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /no measure nonsense: one of .*status/u);
});

test("the content comparison agrees with itself and sees what a prototype omits", async () => {
  const same = await harness([
    "--runs-root",
    root,
    "--run",
    RUN,
    "--measure",
    "content-graph",
    "--prototype",
    "session-index,heap-merge,lazy-activity",
  ]);
  assert.equal(same.code, 0, same.stderr);
  const agreed = JSON.parse(same.stdout);
  assert.deepEqual(agreed.differences, []);
  assert.equal(agreed.equal, true);

  const omitting = await harness([
    "--runs-root",
    root,
    "--run",
    RUN,
    "--measure",
    "content-graph",
    "--prototype",
    "checkpoint-first,lazy-activity",
  ]);
  assert.equal(omitting.code, 0, omitting.stderr);
  const report = JSON.parse(omitting.stdout);
  assert.equal(report.equal, false);
  assert.ok(report.difference_groups > 0);
  assert.deepEqual(omitting.leftAlive, []);
});
