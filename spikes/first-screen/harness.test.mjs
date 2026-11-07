// The first-screen harness, driven as a user runs it: its one command, a real server and a
// real browser, over a corpus it writes. Needs what `scripts/spike-run-open-costs-build.sh`
// builds, without which these fail.
//   node --test spikes/first-screen/harness.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const REPO = resolve(import.meta.dirname, "../..");
const HARNESS = join(REPO, "scripts/spike-run-open-costs.mjs");
const CORPUS = join(REPO, "apps/dag-ui-e2e/load/corpus.mjs");
const RUN = "load-live-open";
let work;
let root;

/** One run of the command; what it printed and every server it left alive. */
function harness(args) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [HARNESS, "--runs-root", root, ...args],
      {
        cwd: work,
        env: { ...process.env, ONEPIPELINE_NODE_SCRATCH_DIR: work },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "first-screen-"),
  );
  root = join(work, "runs");
  const written = spawnSync(
    process.execPath,
    [CORPUS, root, "journey", "transcript-store", "streams=20"],
    { encoding: "utf8" },
  );
  assert.equal(written.status, 0, written.stderr);
});

after(() => rmSync(work, { recursive: true, force: true }));

function splitsAddUp(report) {
  const summed =
    report.navigation_to_post_start_seconds +
    report.post_seconds +
    report.answer_to_mark_seconds;
  assert.ok(
    Math.abs(summed - report.wall_seconds) < 0.01,
    `${summed} is not ${report.wall_seconds}`,
  );
}

test("the trimmed client reaches Graph's mark with every card, and splits its time", async () => {
  const run = await harness(["--run", RUN, "--measure", "first-graph"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  splitsAddUp(report);
  assert.ok(report.graph_cards > 0);
  assert.equal(report.cards_at_mark, report.graph_cards);
  assert.equal(report.client, "trimmed");
  assert.equal(report.cache, "warm");
  assert.equal(report.server_state, "warm");
  // The bundle came from the HTTP cache, which is what `--cache warm` promises.
  assert.ok(report.assets.length > 0);
  assert.ok(report.assets.every((asset) => asset.transfer === 0));
  assert.deepEqual(run.leftAlive, []);
});

test("a cold cache transfers the bundle, and only the first screen's part of it", async () => {
  const run = await harness([
    "--run",
    RUN,
    "--measure",
    "first-graph",
    "--cache",
    "cold",
  ]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.ok(report.assets.every((asset) => asset.transfer > 0));
  assert.ok(!report.assets.some((asset) => asset.name.startsWith("App-")));
  assert.deepEqual(run.leftAlive, []);
});

test("Overall's mark shows Turns as loading and the line over the axis", async () => {
  const run = await harness(["--run", RUN, "--measure", "first-overall"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  splitsAddUp(report);
  assert.match(report.shown.metrics, /Turnsloading/u);
  assert.ok(report.shown.plot_elements > 0);
  assert.deepEqual(run.leftAlive, []);
});

test("a node timeline's mark shows its state, plot and latest rows", async () => {
  const run = await harness(["--run", RUN, "--measure", "first-node"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  splitsAddUp(report);
  assert.ok(report.shown.state);
  assert.ok(report.shown.transcript_rows > 0);
  assert.ok(report.shown.plot_elements > 0);
  assert.deepEqual(run.leftAlive, []);
});

test("today's client reaches the same marks through the complete read", async () => {
  for (const measure of ["first-graph", "first-overall", "first-node"]) {
    const run = await harness([
      "--run",
      RUN,
      "--measure",
      measure,
      "--client",
      "today",
    ]);
    assert.equal(run.code, 0, `${measure}: ${run.stderr}`);
    const report = JSON.parse(run.stdout);
    splitsAddUp(report);
    assert.equal(report.client, "today");
    if (measure === "first-graph")
      assert.equal(report.cards_at_mark, report.graph_cards);
    assert.deepEqual(run.leftAlive, []);
  }
});

test("each first answer's values agree with the complete read, in the three groups", async () => {
  for (const view of ["graph", "overall", "node"]) {
    const run = await harness([
      "--run",
      RUN,
      "--measure",
      `first-content-${view}`,
    ]);
    assert.equal(run.code, 0, `${view}: ${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.different, [], view);
    assert.ok(report.equal > 0);
    assert.deepEqual(
      report.loading.map((group) => group.path),
      [".detail.run.turns"],
    );
    assert.ok(report.first_answer_gzip_bytes < report.first_answer_bytes);
    assert.deepEqual(run.leftAlive, []);
  }
});

test("the comparison sees what a selective read gets wrong when it is served", async () => {
  // The whole document over the selective read: the fields a first answer leaves out
  // because the skipped records decide them.
  const run = await harness([
    "--run",
    RUN,
    "--measure",
    "first-content-graph",
    "--first-query",
    "whole=1",
  ]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.ok(report.different_groups > 0);
  assert.ok(
    report.different.some((group) => group.path.includes("live_activity")),
    JSON.stringify(report.different.map((group) => group.path)),
  );
  assert.deepEqual(run.leftAlive, []);
});

test("the rest of the run arrives, and a page reads the same rows either side of it", async () => {
  const run = await harness(["--run", RUN, "--measure", "first-rest"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.ok(report.complete_read_seconds_after_first_answer > 0);
  assert.equal(report.before.node_rows.source, "selective read of the node's records");
  assert.equal(report.after.node_rows.source, "complete read");
  assert.ok(report.before.node_rows.rows > 0);
  assert.deepEqual(report.node_rows_same_rows.differences, []);
  assert.deepEqual(report.span_page_same_rows.differences, []);
  assert.deepEqual(run.leftAlive, []);
});

test("open_current's steps are attributed", async () => {
  const run = await harness(["--run", RUN, "--measure", "first-open-current"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.ok("cross-run resolution" in report.steps);
  assert.ok(report.steps["checkpoint bytes"] > 0);
  assert.deepEqual(run.leftAlive, []);
});

test("a run that is not there fails, says so, and leaves no server", async () => {
  const run = await harness(["--run", "no-such-run", "--measure", "first-answer-graph"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /first answer: 404/u);
  assert.equal(run.stdout, "");
  assert.deepEqual(run.leftAlive, []);
});

test("a browser that never reaches the mark fails and leaves no server", async () => {
  const run = await harness([
    "--run",
    "no-such-run",
    "--measure",
    "first-graph",
    "--timeout",
    "5",
  ]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /no graph mark/u);
  assert.deepEqual(run.leftAlive, []);
});

test("an unknown client is a usage error", async () => {
  const run = await harness([
    "--run",
    RUN,
    "--measure",
    "first-graph",
    "--client",
    "nonsense",
  ]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--client is today or trimmed/u);
});
