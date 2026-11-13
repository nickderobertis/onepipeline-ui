// The spike harness's own journeys: each runs the real module or CLI over real
// recorded data (a recorder capture from an ubuntu:24.04 container, run
// 43257411385's executions document), with a `gh` stand-in on PATH only where
// the boundary under test is the quota guard in front of GitHub.
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
