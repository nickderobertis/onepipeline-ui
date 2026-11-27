#!/usr/bin/env node
// How much of a platform job's change across a cut-off is which pull requests
// ran, and how much is what a like pull request costs:
//   node spikes/ci-test-speed/mix.mjs <replay.json[.gz]> [--cut-pr 711]
// Over every cited run in the replay (replay.mjs --json), each PR is put in
// one class by its changed paths, and for each platform job it prints the
// mean wall before and after the cut, each class's means, and the after
// window's mean re-weighted at the before window's class means. The gap
// between the before mean and that re-weighting is the mix; the rest is like
// for like. A class that occurs only after the cut keeps its own after mean.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const argv = process.argv.slice(2);
const file = argv[0];
if (!file || file.startsWith("--")) {
  console.error("usage: mix.mjs <replay.json[.gz]> [--cut-pr 711]");
  process.exit(2);
}
const cutAt = argv.indexOf("--cut-pr");
const CUT = cutAt < 0 ? 711 : Number(argv[cutAt + 1]);
if (!Number.isInteger(CUT)) {
  console.error("--cut-pr takes a pull request number, e.g. --cut-pr 711");
  process.exit(2);
}
const raw = readFileSync(file);
const rows = JSON.parse(
  (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"),
).filter((r) => r.run && !r.unavailable);

// First match wins, so a PR touching `src/` and the lock is a `src/` PR.
const classOf = (changed = []) => {
  const any = (p) => changed.some(p);
  if (any((f) => f.startsWith("src/"))) return "src/";
  if (any((f) => f === "Cargo.lock" || f === "Cargo.toml"))
    return "engine bump";
  if (any((f) => f.startsWith("apps/") || f.startsWith("packages/")))
    return "frontend";
  if (any((f) => f.startsWith("tests/"))) return "tests";
  return changed.length ? "CI/docs/config" : "no diff";
};
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const f1 = (x) => (x === null ? "-" : x.toFixed(1));
const signed = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

for (const job of ["test-linux", "test-macos", "test-windows"]) {
  const classes = new Map();
  for (const r of rows) {
    const wall = r.jobs?.[job]?.wall_minutes;
    if (!wall) continue;
    const c = classOf(r.changed ?? []);
    if (!classes.has(c)) classes.set(c, { before: [], after: [] });
    classes.get(c)[r.pr >= CUT ? "after" : "before"].push(wall);
  }
  const all = (side) => [...classes.values()].flatMap((c) => c[side]);
  const before = mean(all("before"));
  const after = mean(all("after"));
  let reweighted = 0;
  for (const c of classes.values())
    reweighted +=
      (c.before.length ? mean(c.before) : mean(c.after)) * c.after.length;
  reweighted /= all("after").length;
  console.log(
    `== ${job}: mean wall ${f1(before)} (n=${all("before").length}, before #${CUT}) → ${f1(after)} (n=${all("after").length}), ${signed(after - before)} min = mix ${signed(reweighted - before)} + like for like ${signed(after - reweighted)}`,
  );
  for (const [name, c] of classes)
    console.log(
      `   ${name.padEnd(15)} before n=${c.before.length} mean ${f1(c.before.length ? mean(c.before) : null)} | after n=${c.after.length} mean ${f1(c.after.length ? mean(c.after) : null)}`,
    );
}
