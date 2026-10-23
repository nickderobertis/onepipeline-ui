#!/usr/bin/env node
/**
 * The host's activity during one measured window of `load.spec.ts`.
 *
 * Appends, as an executor appends, one `turn-activity` record at a time to each
 * live run at `rate` records per minute, staggered so ten runs at one rate do
 * not land in one poll, and one burst of `burst` records to `burstRun` in one
 * write `burstAt` milliseconds into the window. Every record goes through the
 * single fixture writer (`journal.ts`), receipt and all, and every record of
 * the run the page has open is logged with its journal sequence number and the
 * wall-clock instant its write returned — the append the lag is measured from.
 *
 * Usage: writer.mjs '<json options>'
 *   { root, log, durationMs, rate, runs: [{ run, node }], burst, burstRun, burstAt, openRun }
 */

import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { appendRecords } from "./journal.ts";

const runName = z.string().regex(/^[A-Za-z0-9._-]+$/u);
const optionsSchema = z
  .object({
    root: z.string().refine(isAbsolute, "root is an absolute path"),
    log: z.string().refine(isAbsolute, "log is an absolute path"),
    durationMs: z.number().int().positive(),
    rate: z.number().positive().finite(),
    runs: z.array(z.object({ run: runName, node: runName })).min(1),
    burst: z.number().int().nonnegative(),
    burstRun: runName,
    burstAt: z.number().int().nonnegative(),
    openRun: runName,
  })
  .refine(
    (options) => options.runs.some(({ run }) => run === options.burstRun),
    "the burst lands on a run this writer grows",
  )
  .refine(
    (options) => options.burstAt <= options.durationMs,
    "the burst lands inside the window",
  );

/** The options, or a usage error — exit 2 — naming what is wrong with them. */
function optionsOf(text) {
  let parsed;
  try {
    parsed = optionsSchema.safeParse(JSON.parse(text ?? "null"));
  } catch {
    parsed = undefined;
  }
  if (parsed?.success) return parsed.data;
  console.error(
    `writer.mjs: ${parsed?.error.message ?? "the options are not JSON"}\nusage: writer.mjs '<json options>'`,
  );
  process.exit(2);
}

const { root, log, durationMs, rate, runs, burst, burstRun, burstAt, openRun } =
  optionsOf(process.argv[2]);
const HOST = "a-recording-host";

const state = new Map(
  runs.map(({ run, node }) => {
    const path = join(root, run, "events.jsonl");
    const seq = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    return [run, { path, node, seq, n: 0 }];
  }),
);

function record(run, entry, at) {
  const stream = `${HOST}-${run}`;
  const seq = entry.seq;
  entry.seq += 1;
  entry.n += 1;
  return {
    v: 1,
    ts: new Date(at).toISOString(),
    stream,
    seq,
    source: "agentgraph",
    kind: "turn-activity",
    labels: {
      run_id: run,
      node: entry.node,
      member: "worker",
      persona: "worker",
      session: `${stream}-${entry.node}.worker`,
    },
    payload: {
      kind: "tool_call",
      name: "Bash",
      detail: `lm ${run} ${entry.n}`,
      truncated: false,
      output: "y".repeat(900),
      index: seq,
    },
    artifacts: [],
  };
}

function append(run, count = 1, burstOf = false) {
  const entry = state.get(run);
  const at = Date.now();
  const records = Array.from({ length: count }, () => record(run, entry, at));
  appendRecords(entry.path, records);
  const written = Date.now();
  if (run !== openRun) return;
  appendFileSync(
    log,
    records
      .map(
        (appended) =>
          `${JSON.stringify({ seq: appended.seq, at: written, burst: burstOf })}\n`,
      )
      .join(""),
  );
}

const interval = 60_000 / rate;
const timers = [];
runs.forEach(({ run }, index) => {
  const offset = (interval * index) / runs.length;
  timers.push(
    setTimeout(() => {
      append(run);
      timers.push(setInterval(() => append(run), interval));
    }, offset),
  );
});
if (burst > 0)
  timers.push(setTimeout(() => append(burstRun, burst, true), burstAt));
setTimeout(() => {
  for (const timer of timers) clearTimeout(timer);
  process.exit(0);
}, durationMs);
