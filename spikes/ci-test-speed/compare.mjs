#!/usr/bin/env node
// Two sides of a hosted comparison, each two or more `measure.mjs --json`
// outputs: node spikes/ci-test-speed/compare.mjs --a a1.json,a2.json --b b1.json,b2.json
//      [--tasks task1,task2] [--label-a control --label-b treatment]
// prints, per job: each run's wall clock and the named tasks' minutes, each
// side's mean, the difference of means, and whether that difference is inside
// the two sides' spread (the larger of the two sides' max−min). It also prints
// each run's executed task-minutes (the job's work, which concurrency hides).
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (n, d = null) =>
  argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d;
const sideA = opt("a")?.split(",");
const sideB = opt("b")?.split(",");
if (!sideA || !sideB) {
  console.error(
    "usage: compare.mjs --a a1.json[,a2.json] --b b1.json[,b2.json] [--tasks t1,t2] [--label-a A --label-b B]",
  );
  process.exit(2);
}
const tasks = opt("tasks")?.split(",") ?? [];
const la = opt("label-a", "A");
const lb = opt("label-b", "B");
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
const runs = (files) => files.map(load);
const A = runs(sideA);
const B = runs(sideB);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const spread = (xs) => Math.max(...xs) - Math.min(...xs);
const fmt = (x) => (x == null ? "  -  " : x.toFixed(1).padStart(5));
for (const job of ["test-linux", "test-macos", "test-windows"]) {
  const pick = (side) =>
    side
      .map((r) => {
        const j = r.jobs.find((x) => x.job === job);
        if (!j) return null;
        const t = (name) =>
          j.tasks.find((x) => x.task === name)?.minutes ?? null;
        // A job whose executions document was not read (a re-run replaces
        // an earlier attempt's artifacts) has no task figures at all, which
        // is unmeasured rather than zero.
        const recorded = j.tasks.length > 0;
        const busy = recorded
          ? j.tasks
              .filter((x) => x.result === "executed" || x.result === "failed")
              .reduce((s, x) => s + x.minutes, 0)
          : null;
        return {
          run: `${r.run}#${r.attempt}`,
          wall: j.wall_minutes,
          busy,
          failed: recorded
            ? j.tasks.filter((x) => x.result === "failed").length
            : "-",
          tasks: tasks.map(t),
        };
      })
      .filter(Boolean);
  const a = pick(A);
  const b = pick(B);
  if (!a.length || !b.length) continue;
  console.log(`\n== ${job}`);
  for (const [label, side] of [
    [la, a],
    [lb, b],
  ])
    for (const r of side)
      console.log(
        `  ${label.padEnd(10)} run ${r.run.padEnd(14)} wall ${fmt(r.wall)} min  executed task-min ${fmt(r.busy)}  failed tasks ${r.failed}  ${tasks.map((t, i) => `${t} ${fmt(r.tasks[i])}`).join("  ")}`,
      );
  const row = (name, get) => {
    const xa = a.map(get).filter((x) => x != null);
    const xb = b.map(get).filter((x) => x != null);
    if (!xa.length || !xb.length) return;
    const d = mean(xb) - mean(xa);
    const s = Math.max(
      xa.length > 1 ? spread(xa) : 0,
      xb.length > 1 ? spread(xb) : 0,
    );
    const within =
      xa.length > 1 && xb.length > 1
        ? Math.abs(d) <= s
          ? "inside the runs' spread"
          : "outside the runs' spread"
        : "one run on a side: no spread";
    console.log(
      `  ${name.padEnd(28)} ${la} mean ${fmt(mean(xa))} | ${lb} mean ${fmt(mean(xb))} | ${lb}−${la} ${d >= 0 ? "+" : ""}${d.toFixed(1)} min (spread ${s.toFixed(1)}; ${within})`,
    );
  };
  row("wall", (r) => r.wall);
  row("executed task-minutes", (r) => r.busy);
  for (const [i, t] of tasks.entries()) row(t, (r) => r.tasks[i]);
}
