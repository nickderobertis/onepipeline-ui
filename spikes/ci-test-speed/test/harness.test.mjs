// The spike harness's own journeys: each runs the real module or CLI over real
// recorded data (a recorder capture from an ubuntu:24.04 container, run
// 43257411385's executions document), with a `gh` stand-in on PATH only where
// the boundary under test is the quota guard in front of GitHub.
//
// Run: node --test spikes/ci-test-speed/test/*.test.mjs
// Name the files, not the directory: Node 24, the floor engines.node allows,
// treats a directory argument as a module and fails it before any test runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { outer } from "../executions.mjs";
import { Cache } from "../gh.mjs";
import { recorded } from "../procs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const root = join(here, "../../..");

test("the Linux recorder's processes, tree and sleeps read back from a real capture", () => {
  const rec = recorded(join(fixtures, "linux-recorder"));
  assert.equal(rec.platform, "linux");
  const byComm = Object.fromEntries(rec.procs.map((p) => [p.comm, p]));
  assert.deepEqual(Object.keys(byComm).sort(), ["git", "python3", "sleep"]);
  // The shell exec'd its last command: both of its execs are kept.
  assert.match(byComm.python3.execs[0], /^bash -c echo WORKLOAD/);
  assert.equal(byComm.sleep.ppid, byComm.python3.pid);
  const [[s, e]] = byComm.sleep.sleeps;
  assert.ok(Math.abs(e - s - 300) < 2, `sleep 0.3 recorded as ${e - s} ms`);
  assert.ok(byComm.sleep.end - byComm.sleep.start >= 300);
});

test("exec words that the old join() format printed apart are given back in order", () => {
  const rec = recorded(join(fixtures, "linux-recorder-join"));
  const bash = rec.procs.find((p) => p.pid === 23025);
  assert.match(bash.argv, /^bash -c echo WORKLOAD/);
  const child = rec.procs.find((p) => p.pid === 23026);
  assert.equal(child.argv, "sleep 0.3");
  assert.equal(child.ppid, 23025);
});

test("a fixture-free directory reads as no recording rather than an empty one", () => {
  assert.equal(recorded(mkdtempSync(join(tmpdir(), "spike-empty-"))), null);
});

test("nested fixture runs' records are dropped, leaving each task's own run", () => {
  const doc = JSON.parse(
    readFileSync(
      join(fixtures, "executions-43257411385-test-linux.json"),
      "utf8",
    ),
  );
  assert.equal(doc.tasks.length, 420);
  const kept = outer(doc.tasks);
  assert.equal(kept.length, new Set(doc.tasks.map((t) => t.task)).size);
  const unit = kept.find((t) => t.task === "onepipeline-ui:test");
  const longest = Math.max(
    ...doc.tasks
      .filter((t) => t.task === "onepipeline-ui:test")
      .map((t) => Date.parse(t.finished_at) - Date.parse(t.started_at)),
  );
  assert.equal(
    Date.parse(unit.finished_at) - Date.parse(unit.started_at),
    longest,
  );
});

test("offline, a read the cache does not hold is refused and a held one is served", () => {
  const dir = mkdtempSync(join(tmpdir(), "spike-cache-"));
  const cache = new Cache(dir, true);
  assert.throws(
    () => cache.json("/repos/x/actions/runs/1"),
    /offline and rest\/repos\/x\/actions\/runs\/1 is not cached/,
  );
  writeFileSync(cache.path("rest/repos/x/actions/runs/1"), '{"id":1}');
  assert.deepEqual(cache.json("/repos/x/actions/runs/1"), { id: 1 });
  // A local computation still runs offline, once.
  let calls = 0;
  const local = () =>
    cache.read("inputs-x.json", () => `${++calls}`, false, true);
  assert.equal(local(), "1");
  assert.equal(local(), "1");
});

function fakeGh(remaining) {
  const bin = mkdtempSync(join(tmpdir(), "spike-gh-"));
  const log = join(bin, "calls.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\necho "$*" >> "${log}"\nif [ "$2" = rate_limit ]; then echo '{"resources":{"core":{"remaining":${remaining}}}}'; exit 0; fi\necho '{}'\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

test("below the quota floor the measurement makes no GitHub read and says why", () => {
  const { bin, log } = fakeGh(10);
  const cacheDir = mkdtempSync(join(tmpdir(), "spike-cache-"));
  const r = spawnSync(
    "node",
    [
      join(root, "spikes/ci-test-speed/measure.mjs"),
      "--run",
      "1",
      "--cache",
      cacheDir,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /GitHub core quota is 10, below the 2500 floor: stopping reads/,
  );
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "api rate_limit",
  ]);
});

test("measure.mjs without a run names its usage and exits 2", () => {
  const r = spawnSync(
    "node",
    [join(root, "spikes/ci-test-speed/measure.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: measure\.mjs --run <run id>/);
});

function scratchCi() {
  const dir = mkdtempSync(join(tmpdir(), "spike-ci-"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "src"));
  copyFileSync(
    join(root, ".github/workflows/ci.yml"),
    join(dir, ".github/workflows/ci.yml"),
  );
  writeFileSync(join(dir, "src/lib.rs"), "");
  return dir;
}
const apply = (dir, ...args) =>
  spawnSync(
    "node",
    [join(root, "spikes/ci-test-speed/demo/apply-measurement.mjs"), ...args],
    { cwd: dir, encoding: "utf8" },
  );

test("the measurement patch turns every cache write off and wraps each test job", () => {
  const dir = scratchCi();
  const r = apply(dir, "--touch-src");
  assert.equal(r.status, 0, r.stderr);
  const ci = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  assert.equal((ci.match(/CACHE_READ_ONLY: '1'/g) ?? []).length, 4);
  assert.doesNotMatch(
    ci,
    /no-cache: \$\{\{|enable-cache: \$\{\{|save-if: true/,
  );
  assert.equal((ci.match(/Spike recorder — start/g) ?? []).length, 3);
  assert.equal(
    (ci.match(/name: spike-profile-\$\{\{ github\.job \}\}/g) ?? []).length,
    3,
  );
  assert.match(
    readFileSync(join(dir, "src/lib.rs"), "utf8"),
    /Spike measurement/,
  );
});

test("the measurement patch refuses a workflow whose Rust cache saves", () => {
  const dir = scratchCi();
  const path = join(dir, ".github/workflows/ci.yml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("save-if: false", "save-if: true"),
  );
  const r = apply(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a rust-cache step saves: save-if: true/);
});

test("the A/B patch skips Nx cache reads in every test job and widens only Linux's timeout", () => {
  const dir = scratchCi();
  const r = apply(dir, "--ab");
  assert.equal(r.status, 0, r.stderr);
  const ci = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  assert.equal((ci.match(/NX_SKIP_NX_CACHE: 'true'/g) ?? []).length, 3);
  assert.equal((ci.match(/timeout-minutes: 60/g) ?? []).length, 1);
  assert.doesNotMatch(
    readFileSync(join(dir, "src/lib.rs"), "utf8"),
    /Spike measurement/,
  );
});

test("with the job's selection, records of tasks it never selected are dropped", () => {
  const doc = JSON.parse(
    readFileSync(
      join(fixtures, "executions-43257411385-test-linux.json"),
      "utf8",
    ),
  );
  const kept = outer(doc.tasks, ["onepipeline-ui:test"]);
  const names = new Set(kept.map((t) => t.task));
  assert.ok(names.has("onepipeline-ui:test"));
  assert.ok(
    !names.has("onepipeline-ui-e2e:test"),
    "an unselected tier's nested records survived",
  );
  assert.ok(
    [...names].every(
      (n) => n === "onepipeline-ui:test" || n.endsWith(":bootstrap"),
    ),
  );
});

// fixtures/log-131703598302-excerpt.txt: lines of run 43370095836's test-windows
// log, verbatim (colour codes included); fixtures/run-43370095836-windows: that
// run's cached responses, its executions document, and a 20-second slice of its
// Windows recorder (05:15:00Z–05:15:20Z).
test("a hosted log's run identity, selection, restores and test durations read back", async () => {
  const { facts, lines, tasks } = await import("../logs.mjs");
  const log = lines(
    readFileSync(join(fixtures, "log-131703598302-excerpt.txt"), "utf8"),
  );
  const f = facts(log);
  assert.equal(f.github_sha, "90bc9a098d423b4aeb62e864be5047f7713b0c25");
  assert.equal(f.selection.count, 23);
  assert.ok(f.selection.tasks.includes("onepipeline-ui:test-quick"));
  assert.deepEqual(f.restores[0], {
    ...f.restores[0],
    hit: true,
    size_mb: 527,
  });
  const quick = tasks(log).find((b) => b.task === "onepipeline-ui:test-quick");
  assert.equal(quick.outcome, "passed");
  assert.equal(quick.tests.length, 60);
  assert.ok(
    quick.tests.every(
      (t) => t.runner === "nextest" && t.seconds >= 0 && t.binary,
    ),
  );
});

test("a log with no selection line leaves the selection unknown", async () => {
  const { facts, lines } = await import("../logs.mjs");
  const f = facts(
    lines(
      "2026-11-13T05:09:22.0Z hello\n2026-11-13T05:09:23.0Z No cache found.\n",
    ),
  );
  assert.equal(f.selection, null);
  assert.deepEqual(
    f.restores.map((r) => r.hit),
    [false],
  );
});

function fixtureCache() {
  const dir = mkdtempSync(join(tmpdir(), "spike-run-"));
  spawnSync("cp", [
    "-R",
    `${join(fixtures, "run-43370095836-windows")}/.`,
    dir,
  ]);
  return dir;
}

test("one measurement of a cached run divides the Windows job's wall clock exactly", () => {
  const cache = fixtureCache();
  const json = join(cache, "out.json");
  const r = spawnSync(
    "node",
    [
      join(root, "spikes/ci-test-speed/measure.mjs"),
      "--run",
      "43370095836",
      "--jobs",
      "test-windows",
      "--offline",
      "--cache",
      cache,
      "--json",
      json,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /== test-windows \(run 43370095836 attempt 1, job 131703598302, success\) wall 13\.1 min/,
  );
  assert.match(
    r.stdout,
    /restore HIT {2}Run Swatinem\/rust-cache@v2\.9\.2 527 MB 42 s/,
  );
  const [job] = JSON.parse(readFileSync(json, "utf8")).jobs;
  const total = job.categories.reduce((s, c) => s + c.minutes, 0);
  assert.ok(
    Math.abs(total - job.wall_minutes) < 0.01,
    `categories sum to ${total}, wall ${job.wall_minutes}`,
  );
  assert.equal(job.recorder.platform, "windows");
  assert.ok(
    job.categories.some(
      (c) => c.category === "compile (plain)" && c.minutes > 0,
    ),
  );
  assert.equal(job.nx_cache_stored_bytes, 0);
  assert.ok(job.test_binaries.length > 0);
  assert.ok(
    job.test_binaries.every((b) => /^onepipeline-ui(::|$)/.test(b.binary)),
  );
});

test("offline, a run whose log was never fetched is refused naming the log", () => {
  const cache = fixtureCache();
  spawnSync("rm", [join(cache, "log-131703598302.txt")]);
  const r = spawnSync(
    "node",
    [
      join(root, "spikes/ci-test-speed/measure.mjs"),
      "--run",
      "43370095836",
      "--jobs",
      "test-windows",
      "--offline",
      "--cache",
      cache,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /offline and log-131703598302\.txt is not cached/);
});

function scratchTree() {
  const dir = scratchCi();
  for (const f of [
    ".config/nextest.toml",
    ".github/tests/nx-cache/project.json",
  ]) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    copyFileSync(join(root, f), join(dir, f));
  }
  return dir;
}
const proto = (dir, name) =>
  spawnSync(
    "node",
    [join(root, "spikes/ci-test-speed/demo/prototype.mjs"), name],
    { cwd: dir, encoding: "utf8" },
  );

test("each prototype makes its one change and leaves the other file alone", () => {
  const dir = scratchTree();
  assert.equal(proto(dir, "pyramid-no-bundle").status, 0);
  const nextest = readFileSync(join(dir, ".config/nextest.toml"), "utf8");
  const versions = nextest.split("[profile.versions]")[1].split("\n")[1];
  assert.doesNotMatch(versions, /a_build_without_the_bundle/);
  assert.match(versions, /test\(=cli::version_reports_the_crate_version\)/);
  assert.equal(
    readFileSync(join(dir, ".github/tests/nx-cache/project.json"), "utf8"),
    readFileSync(join(root, ".github/tests/nx-cache/project.json"), "utf8"),
  );
  assert.equal(proto(dir, "nx-cache-concurrency").status, 0);
  assert.match(
    readFileSync(join(dir, ".github/tests/nx-cache/project.json"), "utf8"),
    /--test-concurrency=4/,
  );
});

test("a prototype whose edit site moved is refused, and an unknown one is a usage error", () => {
  const dir = scratchTree();
  assert.equal(proto(dir, "pyramid-no-bundle").status, 0);
  const again = proto(dir, "pyramid-no-bundle");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /\.config\/nextest\.toml no longer holds/);
  assert.equal(proto(dir, "faster").status, 2);
});

const data = join(here, "../data");
const node = (script, args) =>
  spawnSync("node", [join(root, "spikes/ci-test-speed", script), ...args], {
    cwd: root,
    encoding: "utf8",
  });

test("the replay analysis prices each option over the 30 latest PRs of the committed replay", () => {
  const r = node("analyse.mjs", [join(data, "replay-45.json.gz")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^population: 30 merged non-release PRs \(#675–#767\)/,
  );
  assert.match(
    r.stdout,
    /== test-linux: wall = [\d.]+ \+ [\d.]+ × executed task-minutes/,
  );
  assert.match(
    r.stdout,
    /B: github-workflows-nx-cache:test keyed on what it reads.*: \d+\/30 PRs/,
  );
  assert.equal(node("analyse.mjs", []).status, 2);
});

test("a comparison says whether a difference is inside the runs' spread", () => {
  const f = (n) => join(data, `measure-${n}.json`);
  const r = node("compare.mjs", [
    "--a",
    `${f("control1")},${f("control2")}`,
    "--b",
    `${f("pyramid1")},${f("pyramid2")}`,
    "--tasks",
    "onepipeline-ui-versions:test-quick",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const windows = r.stdout.split("== test-windows")[1];
  assert.match(
    windows,
    /onepipeline-ui-versions:test-quick A mean +8\.7 \| B mean +0\.1 \| B−A -8\.6 min \(spread 0\.2; outside the runs' spread\)/,
  );
  assert.match(
    windows,
    /wall {25}A mean +13\.4 \| B mean +12\.3 \| B−A -1\.1 min \(spread 3\.5; inside the runs' spread\)/,
  );
  assert.equal(node("compare.mjs", ["--a", f("control1")]).status, 2);
});

test("the committed replay splits each job's change into the PR mix and like for like", () => {
  const r = node("mix.mjs", [join(data, "replay-45.json.gz")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /== test-linux: mean wall 20\.4 \(n=26, before #711\) → 25\.8 \(n=19\), \+5\.4 min = mix \+6\.5 \+ like for like -1\.2/,
  );
  assert.match(
    r.stdout,
    / {3}engine bump {5}before n=5 mean 29\.9 \| after n=9 mean 27\.5/,
  );
  const missing = node("mix.mjs", []);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: mix\.mjs/);
  const badCut = node("mix.mjs", [
    join(data, "replay-45.json.gz"),
    "--cut-pr",
    "abc",
  ]);
  assert.equal(badCut.status, 2);
  assert.match(badCut.stderr, /--cut-pr takes a pull request number/);
});

test("the job medians recompute from the committed listing", () => {
  const r = node("medians.mjs", []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /test-linux {4}non-release {2}before n= 55 median 18\.3 min \| after n= 34 median 24\.9 min/,
  );
});

test("--only-job leaves one test job running, and the patch refuses to apply twice", () => {
  const dir = scratchCi();
  const r = apply(dir, "--ab", "--only-job", "test-linux");
  assert.equal(r.status, 0, r.stderr);
  const ci = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /\n {2}test-windows:\n {4}if: false\n/);
  assert.match(ci, /\n {2}test-macos:\n {4}if: false\n/);
  assert.match(
    ci,
    /\n {2}test-linux:\n {4}if: github\.event_name == 'pull_request'\n/,
  );
  const again = apply(dir, "--only-job", "test-linux");
  assert.equal(
    again.status,
    1,
    "a second application found the jobs it had already switched off",
  );
});
