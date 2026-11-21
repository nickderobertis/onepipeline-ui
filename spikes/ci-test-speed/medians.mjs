#!/usr/bin/env node
// Median successful pull-request job durations before and after a cut-off,
// from a committed listing of every CI run's check runs:
//   node spikes/ci-test-speed/medians.mjs [--cut 2026-11-09T00:00:00Z]
//        [--data spikes/ci-test-speed/data/pr-jobs-2026-11-02-to-13.json]
// The listing was read once through GitHub's GraphQL API (each PR's last 15
// commits' check suites) on 2026-11-13 and is the population behind the
// report's medians: run, job id, start and minutes per row.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) =>
  argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d;
const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(
  readFileSync(
    opt("data", join(here, "data/pr-jobs-2026-11-02-to-13.json")),
    "utf8",
  ),
);
const cut = Date.parse(opt("cut", "2026-11-09T00:00:00Z"));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : null;
};
const out = [];
for (const job of ["test-linux", "test-macos", "test-windows"])
  for (const release of [false, true]) {
    const pick = (after) =>
      rows
        .filter(
          (r) =>
            r.job === job &&
            r.concl === "SUCCESS" &&
            r.release === release &&
            Date.parse(r.start) >= cut === after,
        )
        .map((r) => r.min);
    const before = pick(false);
    const after = pick(true);
    out.push({
      job,
      prs: release ? "release" : "non-release",
      before_n: before.length,
      before_median: median(before),
      after_n: after.length,
      after_median: median(after),
    });
  }
for (const r of out)
  console.log(
    `${r.job.padEnd(13)} ${r.prs.padEnd(12)} before n=${String(r.before_n).padStart(3)} median ${r.before_median?.toFixed(1) ?? "-"} min | after n=${String(r.after_n).padStart(3)} median ${r.after_median?.toFixed(1) ?? "-"} min`,
  );
