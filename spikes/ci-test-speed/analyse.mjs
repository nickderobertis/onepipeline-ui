#!/usr/bin/env node
// What the reuse replay (replay.mjs --json) says, computed rather than read off:
//   node spikes/ci-test-speed/analyse.mjs <replay.json[.gz]> [--population 30] [--cut-pr 711]
// prints, per platform job: the tasks each PR's cited run executed and
// replayed, each re-run's diff-matched inputs or its cause; the median of each
// executed task before and after the caching change (#711); each run's
// timeline critical chain; the fit of wall clock against executed task-minutes;
// and, for each key or modularization option, the PRs and minutes it would have
// replayed over the same population. Options are defined in OPTIONS below.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const argv = process.argv.slice(2);
const file = argv[0];
const opt = (n, d) =>
  argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d;
if (!file) {
  console.error(
    "usage: analyse.mjs <replay.json[.gz]> [--population 30] [--cut-pr 711]",
  );
  process.exit(2);
}
// The committed replay is gzipped: uncompressed it is 1.9 MB of JSON.
const raw = readFileSync(file);
const rows = JSON.parse(
  (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"),
);
const N = Number(opt("population", 30));
const CUT = Number(opt("cut-pr", 711));
const JOBS = ["test-linux", "test-macos", "test-windows"];
const pop = rows.filter((r) => !r.unavailable && r.run).slice(0, N);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : null;
};
const executed = (t) => t.result === "executed" || t.result === "failed";
const glob = (p) =>
  new RegExp(
    `^${p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§/g, ".*")}$`,
  );

// Wall clock against executed task-minutes, per platform, over every run read.
function fitLine(job) {
  const pts = rows
    .map((r) => r.jobs?.[job])
    .filter((e) => e?.tasks?.length >= 5 && e.wall_minutes)
    .map((e) => [
      e.tasks.filter(executed).reduce((s, t) => s + t.minutes, 0),
      e.wall_minutes,
    ]);
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const syy = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  const b = sxy / sxx;
  return {
    intercept: my - b * mx,
    slope: b,
    r: sxy / Math.sqrt(sxx * syy),
    n: pts.length,
  };
}
const FIT = Object.fromEntries(JOBS.map((j) => [j, fitLine(j)]));

// The options replayed: each says whether a task that ran would have replayed.
const SCRIPT_TIERS = new Set([
  "onepipeline-ui-ci-jobs",
  "onepipeline-ui-judged-tier",
  "onepipeline-ui-deps-audit-toolchain",
  "onepipeline-ui-nx-worker-startup",
]);
const NX_KEY = [
  ".github/tests/nx-cache/**",
  "scripts/**",
  "nx.json",
  "**project.json",
  "package.json",
  "bun.lock",
  ".github/ci-tool-versions",
  ".config/nextest.toml",
  "Cargo.toml",
  "Cargo.lock",
  "justfile",
  "llmlint.yml",
  ".github/nx-version-files",
].map(glob);
const OPTIONS = {
  "A: the script-testing e2e tiers in a crate of their own": (_r, t) =>
    SCRIPT_TIERS.has(t.task.split(":")[0]) &&
    t.matched?.length > 0 &&
    t.matched.every((f) => f.startsWith("src/")) &&
    !t.cause,
  "B: github-workflows-nx-cache:test keyed on what it reads, not the whole workspace and the merge base":
    (r, t) =>
      t.task === "github-workflows-nx-cache:test" &&
      !(r.changed ?? []).some((f) => NX_KEY.some((g) => g.test(f))),
  "C: coverage tiers keyed on audited reads, not the whole checkout less a deny-list":
    (r, t) =>
      /^onepipeline-ui(-[a-z-]+)?:test$/.test(t.task) &&
      !t.matched?.length &&
      /entry absent/.test(t.cause ?? "") &&
      (r.changed ?? []).every(
        (f) => !/^(src|tests|apps|packages)\//.test(f) && !/^Cargo\./.test(f),
      ),
};

console.log(
  `population: ${pop.length} merged non-release PRs (#${pop.at(-1)?.pr}–#${pop[0]?.pr}), each with its cited run`,
);
for (const job of JOBS) {
  const f = FIT[job];
  console.log(
    `\n== ${job}: wall = ${f.intercept.toFixed(1)} + ${f.slope.toFixed(3)} × executed task-minutes (r=${f.r.toFixed(2)}, n=${f.n} runs)`,
  );
  for (const r of pop) {
    const e = r.jobs?.[job];
    if (!e?.tasks) {
      console.log(`  #${r.pr} run ${r.run}: ${e?.missing ?? "no job"}`);
      continue;
    }
    const ran = e.tasks.filter((t) => executed(t) && t.cacheable);
    const hit = e.tasks.filter((t) => /hit/.test(t.result));
    const why = new Map();
    for (const t of ran) {
      const k = t.matched?.length
        ? `files: ${[...new Set(t.matched.map((m) => m.split("/").slice(0, 2).join("/")))].slice(0, 4).join(", ")}`
        : (t.cause ?? "?").replace(/:.*/, "");
      why.set(k, (why.get(k) ?? 0) + 1);
    }
    console.log(
      `  #${r.pr} run ${r.run} wall ${e.wall_minutes?.toFixed(1)} | ran ${ran.length} replayed ${hit.length} of ${e.tasks.filter((t) => t.cacheable).length} cacheable${e.selection ? "" : " (no logged selection)"} | ${[...why].map(([k, v]) => `${v}× ${k}`).join("; ")}`,
    );
  }
  const by = new Map();
  for (const r of rows)
    for (const t of r.jobs?.[job]?.tasks ?? [])
      if (executed(t) && t.minutes > 0.3) {
        if (!by.has(t.task)) by.set(t.task, { before: [], after: [] });
        by.get(t.task)[r.pr >= CUT ? "after" : "before"].push(t.minutes);
      }
  console.log(
    `  executed task medians, before #${CUT} → from #${CUT} (minutes, n):`,
  );
  for (const [task, v] of [...by]
    .sort((a, b) => (median(b[1].after) ?? 0) - (median(a[1].after) ?? 0))
    .slice(0, 14))
    console.log(
      `    ${task.padEnd(48)} ${median(v.before)?.toFixed(1) ?? "-"} (n=${v.before.length}) → ${median(v.after)?.toFixed(1) ?? "-"} (n=${v.after.length})`,
    );
  console.log(
    "  options replayed over the population (task-minutes skipped; wall minutes by the fit's slope, an estimate):",
  );
  for (const [name, pred] of Object.entries(OPTIONS)) {
    let prs = 0;
    let minutes = 0;
    for (const r of pop) {
      const m = (r.jobs?.[job]?.tasks ?? [])
        .filter((t) => executed(t) && t.cacheable && pred(r, t))
        .reduce((s, t) => s + t.minutes, 0);
      if (m) prs += 1;
      minutes += m;
    }
    console.log(
      `    ${name}: ${prs}/${pop.length} PRs, ${minutes.toFixed(1)} task-min, ${(minutes / pop.length).toFixed(2)} per PR → ~${((f.slope * minutes) / pop.length).toFixed(2)} wall min per PR`,
    );
  }
}
