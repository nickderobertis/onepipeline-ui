/**
 * The load workload's writer, run as `load/load.spec.ts` runs it, over the
 * load corpus at the journeys' size: it grows every run it is given through
 * the one fixture writer, receipt and all, logs every record it appends to the
 * open run with its sequence number, and lands the burst in one write — and a
 * workload it cannot run is a usage error that appends nothing, which the
 * harness reads as no measurement rather than as a quiet window. The tool
 * output those records carry compresses as real text does, so an encoded
 * figure measured over them is not flattered by filler.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const LOAD = join(import.meta.dirname, "load");

const corpusSchema = z.object({
  openLiveRun: z.string().min(1),
  otherLiveRuns: z.array(z.string().min(1)).min(1),
  liveNode: z.string().min(1),
});
const receiptSchema = z.object({ epoch: z.string().min(1) });

test("the writer grows every run it is given and logs each open-run record", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-e2e-load-writer-"));
  try {
    const root = join(workspace, "runs");
    const corpus = corpusSchema.parse(
      JSON.parse(
        execFileSync(
          process.execPath,
          [join(LOAD, "corpus.mjs"), root, "journey"],
          {
            encoding: "utf8",
          },
        ),
      ),
    );
    const journal = (run: string) => join(root, run, "events.jsonl");
    const lines = (run: string) =>
      readFileSync(journal(run), "utf8").split("\n").filter(Boolean);
    const epoch = (run: string) =>
      receiptSchema.parse(
        JSON.parse(
          readFileSync(
            journal(run).replace(/\.jsonl$/u, ".append.json"),
            "utf8",
          ),
        ),
      ).epoch;
    const other = corpus.otherLiveRuns[0] ?? "";
    const before = {
      open: lines(corpus.openLiveRun).length,
      other: lines(other).length,
      epoch: epoch(corpus.openLiveRun),
    };
    const log = join(workspace, "appended.jsonl");
    const run = spawnSync(
      process.execPath,
      [
        join(LOAD, "writer.mjs"),
        JSON.stringify({
          root,
          log,
          durationMs: 1_500,
          rate: 120,
          runs: [
            { run: other, node: "work" },
            { run: corpus.openLiveRun, node: corpus.liveNode },
          ],
          burst: 5,
          burstRun: corpus.openLiveRun,
          burstAt: 600,
          openRun: corpus.openLiveRun,
        }),
      ],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    const appended = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        z
          .object({ seq: z.number().int(), at: z.number(), burst: z.boolean() })
          .parse(JSON.parse(line)),
      );
    const grown = lines(corpus.openLiveRun).length - before.open;
    // Every record appended to the open run is logged, numbered after the
    // ones the corpus held, in order, the burst's among them.
    expect(appended).toHaveLength(grown);
    expect(appended.map(({ seq }) => seq)).toStrictEqual(
      Array.from({ length: grown }, (_, at) => before.open + at),
    );
    expect(appended.filter(({ burst }) => burst)).toHaveLength(5);
    // The other run grew too, and is not logged as the open one.
    expect(lines(other).length).toBeGreaterThan(before.other);
    // Through the fixture writer: the receipt's epoch continued.
    expect(epoch(corpus.openLiveRun)).toBe(before.epoch);
    // Each record's tool output is text of a real tool call's size, and the
    // stream of them gzips like text: to about a third, never to the sliver
    // one repeated character gzips to.
    const outputs = lines(corpus.openLiveRun)
      .slice(before.open)
      .map(
        (line) =>
          z
            .object({ payload: z.object({ output: z.string() }) })
            .parse(JSON.parse(line)).payload.output,
      );
    for (const output of outputs) expect(output).toHaveLength(900);
    expect(new Set(outputs).size).toBe(outputs.length);
    const text = outputs.join("");
    const ratio = gzipSync(text).length / Buffer.byteLength(text);
    expect(ratio, `the outputs gzip to ${ratio} of their size`).toBeGreaterThan(
      0.2,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a workload the writer cannot run is a usage error that appends nothing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-e2e-load-writer-"));
  try {
    const log = join(workspace, "appended.jsonl");
    for (const options of [
      "not json",
      JSON.stringify({ root: "relative", log, durationMs: 0, rate: 50 }),
      JSON.stringify({
        root: workspace,
        log,
        durationMs: 1_000,
        rate: 50,
        runs: [{ run: "a-run", node: "work" }],
        burst: 1,
        burstRun: "another-run",
        burstAt: 0,
        openRun: "a-run",
      }),
    ]) {
      const run = spawnSync(
        process.execPath,
        [join(LOAD, "writer.mjs"), options],
        { encoding: "utf8" },
      );
      expect(run.status, options).toBe(2);
      expect(run.stderr).toContain("usage: writer.mjs");
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
