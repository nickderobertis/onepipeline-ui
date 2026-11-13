#!/usr/bin/env node
// One measurement: how one hosted CI run's test jobs spent their wall clock.
//
//   node spikes/ci-test-speed/measure.mjs --run <run id> [--attempt N]
//        [--jobs test-linux,test-macos,test-windows] [--cache DIR] [--offline]
//        [--json FILE]
//
// It reads the run's jobs and steps, each job's log, its `nx-cache-entries-<job>`
// executions and, when the run carried the spike recorder, `spike-profile-<job>`,
// and prints per job: the wall clock and its exclusive division into the
// brief's categories (minutes and share, summing to the wall clock), each Nx
// task's inclusive and exclusive minutes, the timeline's critical chain, each
// cache restore's hit or miss and time, the 20 slowest tests and every test
// binary's seconds. Where several things run at once, each instant is shared
// equally between what was running then (the leaf processes, with the
// recorder; the executing Nx tasks, without it), so no minute counts twice.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTAINERS, classify, group } from "./classify.mjs";
import { outer } from "./executions.mjs";
import { Cache, REPO } from "./gh.mjs";
import { facts, lines, tasks as taskBlocks } from "./logs.mjs";
import { recorded } from "./procs.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const run = opt("run");
if (!run) {
  console.error(
    "usage: measure.mjs --run <run id> [--attempt N] [--jobs a,b] [--cache DIR] [--offline] [--json FILE]",
  );
  process.exit(2);
}
const cache = new Cache(
  opt("cache", "target/spike-ci-test-speed/cache"),
  argv.includes("--offline"),
);
const wanted = opt("jobs", "test-linux,test-macos,test-windows").split(",");

const runInfo = cache.json(`/repos/${REPO}/actions/runs/${run}`);
const attempt = Number(opt("attempt", runInfo.run_attempt));
const jobs = cache.pages(
  `/repos/${REPO}/actions/runs/${run}/attempts/${attempt}/jobs`,
  "jobs",
);
const artifacts = cache.pages(
  `/repos/${REPO}/actions/runs/${run}/artifacts`,
  "artifacts",
);

function unpack(artifact) {
  const dir = cache.path(`artifact-${artifact.id}`);
  if (!existsSync(dir)) {
    const zip = cache.path(`artifact-${artifact.id}.zip`);
    cache.artifact(artifact.id);
    mkdirSync(dir, { recursive: true });
    execFileSync("unzip", ["-q", "-o", zip, "-d", dir]);
  }
  return dir;
}
function artifactFor(name, job) {
  const start = Date.parse(job.started_at);
  const end = Date.parse(job.completed_at) + 120000;
  return artifacts
    .filter((a) => a.name === name && !a.expired)
    .filter((a) => {
      const t = Date.parse(a.created_at);
      return t >= start && t <= end;
    })
    .at(-1);
}

const STEP_RULES = [
  [/start-cache-server/, "background"],
  [/Spike recorder/, "recorder (measurement-only)"],
  [
    /^Post Run (Swatinem\/rust-cache|oven-sh\/setup-bun|astral-sh\/setup-uv|actions\/cache)/,
    "cache save (post steps)",
  ],
  [
    /Swatinem\/rust-cache|Restore the sibling CLI|Restore the base commit|Wait for the cache recording proxy/,
    "cache restore",
  ],
  [/^Bootstrap$/, "bootstrap"],
  [/^(Gate, install and wheel|Platform tiers)/, "gate"],
  [
    /upload-artifact|Report cache entries|^cancel|nx-cache$/,
    "report and upload",
  ],
  [/^Post /, "teardown (post steps)"],
];
const stepCategory = (name) =>
  STEP_RULES.find(([re]) => re.test(name))?.[1] ?? "setup";

// The task that owns each process: the one whose command its nearest
// matching ancestor runs (Nx runs each through `sh -c <command>`).
function owners(procs, executions, commands) {
  const byKey = new Map();
  const children = new Map();
  for (const p of procs) {
    p.key = `${p.pid}@${p.start}`;
    byKey.set(p.key, p);
  }
  const lastByPid = new Map();
  for (const p of [...procs].sort((x, y) => x.start - y.start)) {
    const parent = lastByPid.get(p.ppid);
    if (
      parent &&
      parent.start <= p.start + 5 &&
      (parent.end ?? Infinity) >= p.start - 5
    )
      p.parent = parent;
    if (!lastByPid.has(p.pid) || lastByPid.get(p.pid).start <= p.start)
      lastByPid.set(p.pid, p);
  }
  for (const p of procs) {
    if (!p.parent) continue;
    if (!children.has(p.parent.key)) children.set(p.parent.key, []);
    children.get(p.parent.key).push(p);
  }
  const roots = new Map();
  for (const t of executions) {
    const cmd = commands[t.task];
    if (!cmd) continue;
    const head = cmd.slice(0, 50);
    const start = Date.parse(t.started_at);
    const cands = procs.filter(
      (p) =>
        (p.execs ?? [p.argv]).some((a) => a?.includes(head)) &&
        Math.abs(p.start - start) < 60000,
    );
    cands.sort((x, y) => Math.abs(x.start - start) - Math.abs(y.start - start));
    if (cands[0]) roots.set(cands[0].key, t.task);
  }
  const owner = (p) => {
    for (let q = p, n = 0; q && n < 200; q = q.parent, n += 1)
      if (roots.has(q.key)) return roots.get(q.key);
    return null;
  };
  for (const p of procs) p.task = owner(p);
  return { children, matched: roots.size };
}

const BIN = 250;
// Built or run under `cargo llvm-cov` (or this repository's coverage-rustc
// forwarder): an exit record keeps its name even where its arguments were lost.
function underCoverage(p) {
  if (p._cov !== undefined) return p._cov;
  let q = p.parent;
  for (let n = 0; q && n < 60; q = q.parent, n += 1)
    if (/^(cargo-llvm-cov|coverage-rustc)$/.test(q.comm ?? ""))
      return (p._cov = true);
  return (p._cov = false);
}
function leafShares(rec, a, b, instrumentedTask) {
  const nbins = Math.ceil((b - a) / BIN);
  const bins = Array.from({ length: nbins }, () => []);
  for (const p of rec.procs) {
    if (p.system) continue;
    const s = Math.max(p.start, a);
    const e = Math.min(p.end ?? b, b);
    if (e <= s) continue;
    for (
      let i = Math.floor((s - a) / BIN);
      i < nbins && a + i * BIN < e;
      i += 1
    ) {
      const lo = a + i * BIN;
      const f = (Math.min(e, lo + BIN) - Math.max(s, lo)) / BIN;
      if (f > 0) bins[i].push([p, f]);
    }
  }
  const cats = new Map();
  const perTask = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const others = new Map();
  const waiters = new Map();
  let idle = 0;
  for (let i = 0; i < nbins; i += 1) {
    const lo = a + i * BIN;
    const len = Math.min(BIN, b - lo);
    let leaves;
    if (rec.tree) {
      const parents = new Set();
      for (const [p] of bins[i]) if (p.parent) parents.add(p.parent.key);
      leaves = bins[i].filter(([p]) => !parents.has(p.key));
    } else {
      leaves = bins[i].filter(([p]) => !CONTAINERS.has(p.comm));
      if (!leaves.length) leaves = bins[i];
    }
    const total = leaves.reduce((s, [, f]) => s + f, 0);
    if (!total) {
      idle += len;
      continue;
    }
    const scale = len / Math.max(1, total);
    for (const [p, f] of leaves) {
      const share = f * scale;
      const span = [Math.max(lo, p.start), Math.min(lo + BIN, p.end ?? b)];
      const overlap = (list) =>
        list.reduce(
          (s, [x, y]) =>
            s + Math.max(0, Math.min(y, span[1]) - Math.max(x, span[0])),
          0,
        );
      const width = Math.max(1, span[1] - span[0]);
      const sleep = Math.min(1, overlap(p.sleeps) / width);
      const wait = Math.min(1 - sleep, overlap(p.waits) / width);
      const inst =
        (p.task && instrumentedTask(p.task)) ||
        /llvm-cov|instrument-coverage/.test(p.argv ?? "") ||
        underCoverage(p);
      const work = group(classify(p), inst);
      add(cats, work, share * (1 - sleep - wait));
      if (work === group("other")) add(others, p.comm ?? "?", share);
      if (sleep) add(cats, group("sleep"), share * sleep);
      if (wait) add(cats, group("wait"), share * wait);
      if (sleep || wait)
        add(
          waiters,
          `${p.comm ?? "?"} (${classify(p)})`,
          share * (sleep + wait),
        );
      add(perTask, p.task ?? "(no Nx task)", share);
    }
    if (total < 1) idle += len * (1 - total);
  }
  return { cats, perTask, idle, others, waiters };
}

// Without a recorder: each instant shared equally between the Nx tasks that
// were executing, each task's share split by what its own log block printed.
function taskShares(executions, blocks, a, b) {
  const ex = executions
    .filter((t) => t.result === "executed" || t.result === "failed")
    .map((t) => ({
      ...t,
      s: Math.max(a, Date.parse(t.started_at)),
      e: Math.min(b, Date.parse(t.finished_at)),
    }))
    .filter((t) => t.e > t.s);
  const perTask = new Map();
  let idle = 0;
  for (let lo = a; lo < b; lo += BIN) {
    const hi = Math.min(b, lo + BIN);
    const act = ex.filter((t) => t.s < hi && t.e > lo);
    if (!act.length) {
      idle += hi - lo;
      continue;
    }
    for (const t of act)
      perTask.set(t.task, (perTask.get(t.task) ?? 0) + (hi - lo) / act.length);
  }
  const cats = new Map();
  const add = (k, v) => cats.set(k, (cats.get(k) ?? 0) + v);
  for (const [task, ms] of perTask) {
    const t = ex.find((x) => x.task === task);
    const dur = Math.max(
      1,
      Date.parse(t.finished_at) - Date.parse(t.started_at),
    );
    const blk = blocks.find((x) => x.task === task);
    const build = Math.min(
      dur,
      1000 * (blk?.cargo.reduce((s, c) => s + c.seconds, 0) ?? 0),
    );
    const tests = Math.min(
      dur - build,
      1000 * (blk?.nextest.reduce((s, c) => s + c.seconds, 0) ?? 0),
    );
    const covered =
      /coverage|:test$/.test(task) &&
      blk?.cargo.some((c) => /test/.test(c.profile));
    add(
      covered
        ? "compile and link (instrumented, from cargo's Finished line)"
        : "compile and link (from cargo's Finished line)",
      (ms * build) / dur,
    );
    add("Rust tests running (nextest Summary)", (ms * tests) / dur);
    add(
      `rest of ${task.replace(/:.*/, "")}:${task.replace(/.*:/, "")}`,
      (ms * (dur - build - tests)) / dur,
    );
  }
  return { cats, perTask, idle };
}

function criticalChain(executions, a, b) {
  const ts = executions
    .map((t) => ({
      task: t.task,
      result: t.result,
      s: Date.parse(t.started_at),
      e: Date.parse(t.finished_at),
    }))
    .filter((t) => t.s >= a - 1000 && t.e <= b + 1000);
  const chain = [];
  let cur = ts.reduce((m, t) => (!m || t.e > m.e ? t : m), null);
  while (cur) {
    chain.unshift(cur);
    const c = cur;
    cur = ts
      .filter((t) => t.e <= c.s + 2000 && t !== c && !chain.includes(t))
      .reduce((m, t) => (!m || t.e > m.e ? t : m), null);
  }
  return chain.map((t) => ({
    task: t.task,
    result: t.result,
    minutes: (t.e - t.s) / 60000,
    start_min: (t.s - a) / 60000,
  }));
}

function taskCommands() {
  const file = cache.path("nx-graph.json");
  if (!existsSync(file)) {
    execFileSync("node_modules/.bin/nx", ["graph", `--file=${file}`], {
      env: { ...process.env, NX_DAEMON: "false" },
      stdio: "ignore",
    });
  }
  const graph = JSON.parse(
    execFileSync("cat", [file], { encoding: "utf8", maxBuffer: 1 << 28 }),
  );
  const out = {};
  for (const [name, node] of Object.entries(graph.graph.nodes))
    for (const [target, t] of Object.entries(node.data.targets ?? {})) {
      const c = t.options?.command ?? t.options?.commands?.[0];
      if (typeof c === "string") out[`${name}:${target}`] = c;
    }
  return out;
}

const commands = taskCommands();
const result = {
  run: Number(run),
  attempt,
  head_sha: runInfo.head_sha,
  head_branch: runInfo.head_branch,
  jobs: [],
};
for (const name of wanted) {
  const job = jobs.find((j) => j.name === name);
  if (!job?.started_at || !job.completed_at) continue;
  const a = Date.parse(job.started_at);
  const b = Date.parse(job.completed_at);
  const log = lines(cache.log(job.id));
  const f = facts(log);
  const blocks = taskBlocks(log);
  const execArt = artifactFor(`nx-cache-entries-${name}`, job);
  const execDoc = execArt
    ? JSON.parse(
        execFileSync("cat", [join(unpack(execArt), "executions.json")], {
          encoding: "utf8",
        }),
      )
    : null;
  const manifestDoc =
    execArt && existsSync(join(unpack(execArt), "manifest.json"))
      ? JSON.parse(
          execFileSync("cat", [join(unpack(execArt), "manifest.json")], {
            encoding: "utf8",
          }),
        )
      : null;
  const executions = outer(execDoc?.tasks ?? [], f.selection?.tasks ?? null);
  const nestedRecords = (execDoc?.tasks.length ?? 0) - executions.length;
  const recArt = artifactFor(`spike-profile-${name}`, job);
  const rec = recArt ? recorded(unpack(recArt)) : null;

  const cats = new Map();
  const add = (k, v) => cats.set(k, (cats.get(k) ?? 0) + v);
  const steps = job.steps
    .filter((s) => s.started_at && s.completed_at)
    .map((s) => ({
      name: s.name,
      cat: stepCategory(s.name),
      s: Date.parse(s.started_at),
      e: Date.parse(s.completed_at),
    }))
    .filter((s) => s.cat !== "background");
  let covered = 0;
  const perTask = new Map();
  const others = new Map();
  const waiters = new Map();
  const instrumentedTask = (task) =>
    /_tier-test-covered|coverage/.test(commands[task] ?? "");
  let matched = null;
  if (rec?.tree) matched = owners(rec.procs, executions, commands).matched;
  for (const st of steps) {
    const s = Math.max(a, st.s);
    const e = Math.min(b, st.e);
    if (e <= s) continue;
    covered += e - s;
    if (st.cat === "gate" || st.cat === "bootstrap") {
      const sub = rec
        ? leafShares(rec, s, e, instrumentedTask)
        : taskShares(executions, blocks, s, e);
      const prefix = st.cat === "bootstrap" ? "bootstrap: " : "";
      for (const [k, v] of sub.cats) add(prefix + k, v);
      add(`${prefix}unattributed (no recorded work running)`, sub.idle);
      for (const [k, v] of sub.others ?? [])
        others.set(k, (others.get(k) ?? 0) + v);
      for (const [k, v] of sub.waiters ?? [])
        waiters.set(k, (waiters.get(k) ?? 0) + v);
      // Each task's exclusive minutes on every platform: each instant of the
      // gate step shared equally between the Nx tasks executing then.
      if (st.cat === "gate")
        for (const [k, v] of taskShares(executions, blocks, s, e).perTask)
          perTask.set(k, (perTask.get(k) ?? 0) + v);
    } else add(st.cat, e - s);
  }
  add("unattributed (runner time between steps)", Math.max(0, b - a - covered));
  const wall = b - a;
  const tests = blocks.flatMap((blk) =>
    blk.tests.map((t) => ({ ...t, task: blk.task })),
  );
  // node's spec reporter also prints each file (and each describe) with the
  // sum of what it holds: a file-level line is a suite, not a test. Vitest's
  // default reporter prints files only, which stay, named as files.
  const leafTests = tests.filter(
    (t) => !(t.runner === "node" && /\.(test|spec)\.[cm]?[jt]s$/.test(t.name)),
  );
  const binaries = new Map();
  for (const t of tests.filter((t) => t.runner === "nextest"))
    binaries.set(t.binary, (binaries.get(t.binary) ?? 0) + t.seconds);
  const gate = steps.find((s) => s.cat === "gate");
  result.jobs.push({
    job: name,
    job_id: job.id,
    conclusion: job.conclusion,
    runner: job.runner_name,
    started_at: job.started_at,
    completed_at: job.completed_at,
    wall_minutes: wall / 60000,
    github_sha: f.github_sha,
    selection: f.selection,
    // Each restore line belongs to the step whose time window holds it.
    // Each restore line belongs to the cache-restore step whose window holds
    // it; a hit or miss printed by a test inside the gate step is not one.
    restores: f.restores
      .map((r) => {
        const t = Date.parse(r.at);
        // A key names its family's step; step times are whole seconds, so two
        // restores a second apart are told apart by key, then by time.
        const family = /^onepipeline-cli-/.test(r.key ?? "")
          ? /sibling/
          : /^onepipeline-api-baseline-/.test(r.key ?? "")
            ? /base commit/
            : /^v\d+-rust-/.test(r.key ?? "")
              ? /rust-cache/
              : /./;
        const st = job.steps.find(
          (x) =>
            x.started_at &&
            stepCategory(x.name) === "cache restore" &&
            family.test(x.name) &&
            Date.parse(x.started_at) <= t + 1000 &&
            Date.parse(x.completed_at) >= t - 1000,
        );
        return st
          ? {
              ...r,
              step: st.name,
              step_seconds:
                (Date.parse(st.completed_at) - Date.parse(st.started_at)) /
                1000,
            }
          : null;
      })
      .filter(Boolean),
    nested_fixture_records: nestedRecords,
    sleeping_and_polling: [...waiters]
      .map(([process, ms]) => ({ process, minutes: ms / 60000 }))
      .sort((x, y) => y.minutes - x.minutes)
      .slice(0, 15),
    other_processes: [...others]
      .map(([comm, ms]) => ({ comm, minutes: ms / 60000 }))
      .sort((x, y) => y.minutes - x.minutes)
      .slice(0, 25),
    nx_cache_stored_bytes: manifestDoc?.stored_bytes ?? null,
    nx_store_attempts: execDoc?.store_attempts?.map((s) => s.status) ?? null,
    recorder: rec
      ? {
          platform: rec.platform,
          processes: rec.procs.length,
          tasks_matched: matched,
        }
      : null,
    categories: [...cats]
      .map(([k, v]) => ({ category: k, minutes: v / 60000, share: v / wall }))
      .sort((x, y) => y.minutes - x.minutes),
    tasks: executions
      .map((t) => ({
        task: t.task,
        result: t.result,
        minutes: (Date.parse(t.finished_at) - Date.parse(t.started_at)) / 60000,
        exclusive_minutes: (perTask.get(t.task) ?? 0) / 60000,
        start_min: (Date.parse(t.started_at) - a) / 60000,
        cargo_seconds:
          blocks
            .find((x) => x.task === t.task)
            ?.cargo.reduce((s, c) => s + c.seconds, 0) ?? null,
        nextest_seconds:
          blocks
            .find((x) => x.task === t.task)
            ?.nextest.reduce((s, c) => s + c.seconds, 0) ?? null,
      }))
      .sort((x, y) => y.minutes - x.minutes),
    critical_chain: gate ? criticalChain(executions, gate.s, gate.e) : [],
    slowest_tests: [...leafTests]
      .sort((x, y) => y.seconds - x.seconds)
      .slice(0, 20),
    test_binaries: [...binaries]
      .map(([binary, seconds]) => ({ binary, seconds }))
      .sort((x, y) => y.seconds - x.seconds),
    test_count: tests.length,
  });
}

const fmt = (n) => n.toFixed(1).padStart(6);
for (const j of result.jobs) {
  console.log(
    `\n== ${j.job} (run ${result.run} attempt ${result.attempt}, job ${j.job_id}, ${j.conclusion}) wall ${j.wall_minutes.toFixed(1)} min`,
  );
  console.log(
    `   head ${result.head_sha}  GITHUB_SHA ${j.github_sha}  selection ${j.selection?.count ?? "?"} task(s)  recorder ${j.recorder ? `${j.recorder.platform}, ${j.recorder.processes} processes, ${j.recorder.tasks_matched ?? "-"} task roots` : "none"}`,
  );
  for (const r of j.restores)
    console.log(
      `   restore ${r.hit ? "HIT " : "MISS"} ${r.step} ${r.size_mb ? `${r.size_mb} MB ` : ""}${r.step_seconds ?? "?"} s`,
    );
  console.log(
    `   Nx remote cache stored ${j.nx_cache_stored_bytes ?? "?"} bytes`,
  );
  console.log("   minutes  share  category");
  for (const c of j.categories)
    if (c.minutes >= 0.05)
      console.log(
        `   ${fmt(c.minutes)} ${(c.share * 100).toFixed(1).padStart(5)}%  ${c.category}`,
      );
  console.log(
    `   ${fmt(j.categories.reduce((s, c) => s + c.minutes, 0))} total (wall ${j.wall_minutes.toFixed(1)})`,
  );
  console.log("   Nx tasks: inclusive / exclusive minutes");
  for (const t of j.tasks.slice(0, 25))
    console.log(
      `   ${fmt(t.minutes)} ${fmt(t.exclusive_minutes)}  ${t.result.padEnd(10)} ${t.task}`,
    );
  console.log(
    `   critical chain: ${j.critical_chain.map((c) => `${c.task} ${c.minutes.toFixed(1)}`).join(" -> ")}`,
  );
  console.log("   slowest tests:");
  for (const t of j.slowest_tests)
    console.log(
      `   ${fmt(t.seconds)} s  ${t.runner} ${t.binary ?? ""} ${t.name}`,
    );
}
const out = opt("json");
if (out) writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
