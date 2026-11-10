#!/usr/bin/env node
/**
 * One measurement's figures, as the report states them: per view, the median of its
 * three readings (first view, navigation, POST, answer to mark, first-answer bytes) and
 * the median of each server-side span its readings' traces carry, for the view's
 * run-scoped subscription (the POST that opened the run's reading).
 *
 *   node spikes/first-view-time/summarize.mjs <measure-run output.json>...
 */
import { readFileSync } from "node:fs";

const median = (values) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};
const round = (value) =>
  value === null ? null : Math.round(value * 1000) / 1000;

for (const file of process.argv.slice(2)) {
  const measured = JSON.parse(readFileSync(file, "utf8"));
  const load = measured.host_load;
  console.log(
    `# ${file}\nspike=${JSON.stringify(measured.spike ?? "")} server=${measured.server}\n` +
      `load start ${load.start.load_1m.toFixed(1)}/${load.start.load_5m.toFixed(1)} end ${load.end.load_1m.toFixed(1)}/${load.end.load_5m.toFixed(1)} (1m/5m, ${load.start.cores} cores)`,
  );
  for (const [view, taken] of Object.entries(measured.first_view)) {
    if (typeof taken !== "object" || taken === null || !("readings" in taken))
      continue;
    const readings = taken.readings;
    const pick = (key) => round(median(readings.map((r) => r[key])));
    const row = {
      first_view_s: round(taken.median_s),
      readings_s: readings.map((r) => round(r.seconds)),
      nav_s: pick("navigation_to_post_s"),
      post_s: pick("post_s"),
      answer_to_mark_s: pick("answer_to_mark_s"),
      bytes: pick("first_answer_bytes"),
      gzipped: pick("first_answer_gzipped"),
      checked: readings.map(
        (r) =>
          `${r.checked.screen_against_answer ? "S" : "s"}${r.checked.answer_against_complete ? "A" : "a"}`,
      ),
      loads: readings.map((r) => round(r.host_load.load_1m)),
    };
    // The subscription that opened the run's reading: the one whose spans hold its read.
    const opened = readings.map((r) =>
      (r.server_split ?? []).find((line) => line.spans?.live_run_s !== undefined),
    );
    const keys = new Set(
      opened.flatMap((line) =>
        line === undefined
          ? []
          : [
              ...Object.keys(line.spans),
              "handler_s",
              "serialize_s",
              "answer_bytes",
            ],
      ),
    );
    const split = {};
    for (const key of [...keys].sort())
      split[key] = round(
        median(
          opened.map((line) =>
            line === undefined
              ? undefined
              : (line.spans[key] ?? line[key]),
          ),
        ),
      );
    const others = readings.map((r) =>
      (r.server_split ?? [])
        .filter((line) => line.spans?.live_run_s === undefined)
        .map((line) => round(line.handler_s)),
    );
    console.log(`\n## ${view}`);
    console.log(JSON.stringify(row));
    console.log(`server split (median of ${opened.filter(Boolean).length}):`);
    console.log(JSON.stringify(split, null, 1));
    console.log(`other subscriptions' handler_s: ${JSON.stringify(others)}`);
  }
  console.log();
}
