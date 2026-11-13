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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, executionsDoc, jobsList, options, refuse } from "./check.mjs";
import { CONTAINERS, classify, group } from "./classify.mjs";
import { outer } from "./executions.mjs";
import { Cache, REPO } from "./gh.mjs";
import { facts, lines, tasks as taskBlocks } from "./logs.mjs";
import { recorded } from "./procs.mjs";

const JOBS = ["test-linux", "test-macos", "test-windows"];

await cli(async () => {
  const o = options(process.argv.slice(2));
  const run = o.string("run");
  if (!run || !/^\d+$/.test(run))
    refuse(
      `--run ${JSON.stringify(run)} is not a run id`,
      "usage: measure.mjs --run <run id> [--attempt N] [--jobs a,b] [--cache DIR] [--offline] [--json FILE]",
    );
  const cache = new Cache(
    o.string("cache", "target/spike-ci-test-speed/cache"),
    o.flag("offline"),
  );
  const wanted = o.list("jobs", JOBS.join(","), JOBS);

  const runInfo = cache.json(`/repos/${REPO}/actions/runs/${run}`);
  if (!Number.isInteger(runInfo?.run_attempt))
    refuse(
      `run ${run} as read names no attempt`,
      "check the run id, or remove its cached response and retry online",
    );
  // While any attempt runs, GitHub lists none of the run's earlier artifacts,
  // so a measurement then would read every recorder as absent.
  if (runInfo.status !== "completed")
    refuse(
      `run ${run} is ${runInfo.status}: GitHub lists no attempt's artifacts until it completes`,
      `wait for it to complete, then remove ${cache.path(`rest_repos_${REPO.replace("/", "_")}_actions_runs_${run}`)}* and retry`,
    );
  const attempt = o.int("attempt", runInfo.run_attempt, { min: 1 });
  const jobs = jobsList(
    cache.pages(
      `/repos/${REPO}/actions/runs/${run}/attempts/${attempt}/jobs`,
      "jobs",
    ),
    `run ${run} attempt ${attempt}'s jobs`,
  );
  for (const name of wanted)
    if (!jobs.some((j) => j.name === name))
      refuse(
        `run ${run} attempt ${attempt} has no job ${name}`,
        `pass --jobs with only ${jobs.map((j) => j.name).join(", ")}`,
      );
  const artifacts = cache.pages(
    `/repos/${REPO}/actions/runs/${run}/artifacts`,
    "artifacts",
    // Attempt 1's listing is the one cached before this change named attempts.
    attempt > 1 ? `@attempt-${attempt}` : "",
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
      cands.sort(
        (x, y) => Math.abs(x.start - start) - Math.abs(y.start - start),
      );
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
    if (p._cov === undefined) {
      p._cov = false;
      for (let q = p.parent, n = 0; q && n < 60; q = q.parent, n += 1)
        if (/^(cargo-llvm-cov|coverage-rustc)$/.test(q.comm ?? ""))
          p._cov = true;
    }
    return p._cov;
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
    const idleOf = new Map();
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
        // Linux's tracer sees each sleep and timed-out wait. Elsewhere only a
        // process's CPU time is recorded: its elapsed time beyond that CPU is
        // waiting of every kind (sleeps, polls, timeouts and I/O alike).
        const traced = rec.platform === "linux";
        const sleep = traced ? Math.min(1, overlap(p.sleeps) / width) : 0;
        const beyondCpu =
          !traced && p.cpu != null && p.end > p.start
            ? Math.max(0, 1 - p.cpu / (p.end - p.start))
            : 0;
        const wait = traced ? Math.min(1 - sleep, overlap(p.waits) / width) : 0;
        const inst =
          (p.task && instrumentedTask(p.task)) ||
          /llvm-cov|instrument-coverage/.test(p.argv ?? "") ||
          underCoverage(p);
        const work = group(classify(p), inst);
        add(cats, work, share * (1 - sleep - wait));
        // Off Linux not a category of its own: an "of which" beside each one.
        if (beyondCpu) add(idleOf, work, share * beyondCpu);
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
    return { cats, perTask, idle, others, waiters, idleOf };
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
        perTask.set(
          t.task,
          (perTask.get(t.task) ?? 0) + (hi - lo) / act.length,
        );
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
      ? executionsDoc(
          JSON.parse(
            readFileSync(join(unpack(execArt), "executions.json"), "utf8"),
          ),
          `artifact ${execArt.id} (${execArt.name})`,
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
    const idleOf = new Map();
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
        for (const [k, v] of sub.idleOf ?? [])
          idleOf.set(prefix + k, (idleOf.get(prefix + k) ?? 0) + v);
        // Each task's exclusive minutes on every platform: each instant of the
        // gate step shared equally between the Nx tasks executing then.
        if (st.cat === "gate")
          for (const [k, v] of taskShares(executions, blocks, s, e).perTask)
            perTask.set(k, (perTask.get(k) ?? 0) + v);
      } else add(st.cat, e - s);
    }
    add(
      "unattributed (runner time between steps)",
      Math.max(0, b - a - covered),
    );
    // Every category the brief names is reported, a measured zero included: on a
    // run with the recorder a category absent here is one no process fell in.
    // Sleeps and polls are seen only by Linux's syscall tracer: elsewhere they
    // are not observed, never zero, and their time sits inside each category's
    // elapsed time beyond CPU.
    const WAITS = [
      "sleeps",
      "polls and timeouts (waits that ended by timing out)",
    ];
    const unobserved = rec && rec.platform !== "linux" ? WAITS : [];
    if (rec)
      for (const name of [
        "compile (plain)",
        "compile (instrumented)",
        "link (plain)",
        "link (instrumented)",
        "coverage overhead (profdata, llvm-cov, merge)",
        "spawns: onepipeline engine CLI",
        "spawns: git",
        "spawns: npm",
        "spawns: bun",
        "spawns: Python (python, pip, uv, llmlint)",
        "spawns: browsers",
        "spawns: network clients (curl, gh)",
        "fixtures (fixture-building scripts)",
        ...WAITS.filter((w) => !unobserved.includes(w)),
        "setup",
        "cache restore",
        "cache save (post steps)",
      ])
        add(name, 0);
    const wall = b - a;
    const tests = blocks.flatMap((blk) =>
      blk.tests.map((t) => ({ ...t, task: blk.task })),
    );
    // node's spec reporter also prints each file (and each describe) with the
    // sum of what it holds: a file-level line is a suite, not a test. Vitest's
    // default reporter prints files only, which stay, named as files.
    const leafTests = tests.filter(
      (t) =>
        !(t.runner === "node" && /\.(test|spec)\.[cm]?[jt]s$/.test(t.name)),
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
                : /^bun-/.test(r.key ?? "")
                  ? /setup-bun/
                  : /setup-uv|uv-/.test(r.key ?? "")
                    ? /setup-uv/
                    : /./;
          const st = job.steps.find(
            (x) =>
              x.started_at &&
              (stepCategory(x.name) === "cache restore" ||
                /setup-bun|setup-uv/.test(x.name)) &&
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
      // Inclusive, beside the exclusive table: per category, how many of the job's
      // processes ran, their summed elapsed minutes and (where recorded) CPU minutes.
      process_totals: rec
        ? Object.entries(
            rec.procs
              .filter((p) => !p.system && p.end > p.start)
              .reduce((m, p) => {
                const inst =
                  /llvm-cov|instrument-coverage/.test(p.argv ?? "") ||
                  underCoverage(p);
                const k = group(classify(p), inst);
                const v = m[k] ?? {
                  processes: 0,
                  elapsed_minutes: 0,
                  cpu_minutes: 0,
                };
                v.processes += 1;
                v.elapsed_minutes += (p.end - p.start) / 60000;
                v.cpu_minutes += (p.cpu ?? 0) / 60000;
                m[k] = v;
                return m;
              }, {}),
          )
            .map(([category, v]) => ({ category, ...v }))
            .sort((x, y) => y.elapsed_minutes - x.elapsed_minutes)
        : null,
      // Every linker invocation, longest first, with the crate it links where
      // the process tree names it (rustc's --crate-name): the cost a new test
      // binary or crate adds is one more of these per build.
      links: rec
        ? rec.procs
            .filter(
              (p) =>
                !p.system &&
                (rec.tree
                  ? /^rustc/.test(p.parent?.comm ?? "") &&
                    /^(cc|gcc|clang|link|lld-link|rust-lld|ld)$/.test(
                      p.comm ?? "",
                    )
                  : p.comm === "ld"),
            )
            .map((p) => ({
              linker: p.comm,
              crate:
                / --crate-name (\S+)/.exec(p.parent?.argv ?? "")?.[1] ?? null,
              seconds: (p.end - p.start) / 1000,
            }))
            .sort((x, y) => y.seconds - x.seconds)
        : null,
      // Off Linux: of each category's minutes, how many its processes spent
      // beyond their CPU time (sleeps, polls, timeouts and I/O, inseparable).
      elapsed_beyond_cpu: Object.fromEntries(
        [...idleOf].map(([k, v]) => [k, v / 60000]),
      ),
      unobserved: unobserved.map((category) => ({
        category,
        reason: `no syscall tracer on ${rec.platform}: counted inside each category's elapsed time beyond CPU`,
      })),
      categories: [...cats]
        .map(([k, v]) => ({ category: k, minutes: v / 60000, share: v / wall }))
        .sort((x, y) => y.minutes - x.minutes),
      tasks: executions
        .map((t) => ({
          task: t.task,
          result: t.result,
          minutes:
            (Date.parse(t.finished_at) - Date.parse(t.started_at)) / 60000,
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

  const fmt = (n) =>
    (n > 0 && n < 0.1 ? n.toFixed(2) : n.toFixed(1)).padStart(6);
  for (const j of result.jobs) {
    console.log(
      `\n== ${j.job} (run ${result.run} attempt ${result.attempt}, job ${j.job_id}, ${j.conclusion}) wall ${j.wall_minutes.toFixed(1)} min`,
    );
    console.log(
      `   head ${result.head_sha}  GITHUB_SHA ${j.github_sha}  selection ${j.selection?.count ?? "?"} task(s)  recorder ${j.recorder ? `${j.recorder.platform}, ${j.recorder.processes} processes, ${j.recorder.tasks_matched ?? "-"} task roots` : "none"}`,
    );
    for (const r of j.restores)
      console.log(
        `   restore ${r.hit ? (r.partial ? "HIT (restore key, partial)" : "HIT ") : "MISS"} ${r.step} ${r.size_mb ? `${r.size_mb} MB ` : ""}${r.step_seconds ?? "?"} s`,
      );
    console.log(
      `   Nx remote cache stored ${j.nx_cache_stored_bytes ?? "?"} bytes`,
    );
    const beyond = Object.keys(j.elapsed_beyond_cpu).length > 0;
    console.log(
      `   minutes  share  ${beyond ? "of which beyond CPU  " : ""}category`,
    );
    for (const c of j.categories)
      if (c.minutes >= 0)
        console.log(
          `   ${fmt(c.minutes)} ${(c.share * 100).toFixed(1).padStart(5)}%  ${beyond ? `${fmt(j.elapsed_beyond_cpu[c.category] ?? 0)}               ` : ""}${c.category}`,
        );
    for (const u of j.unobserved ?? [])
      console.log(`   not observed  ${u.category} (${u.reason})`);
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
  const out = o.string("json");
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
});
