/**
 * `measure-run-load-on-host` measuring a run of a real runs root through its own
 * command line, as an operator runs it: the release server over that root, a real
 * browser on each view, and the figures handed back on stdout or in a file.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { firstViewSchema } from "./telemetry";

const REPO = resolve(import.meta.dirname, "../../..");
const MEASURE_RUN = join(import.meta.dirname, "measure-run.mjs");
const CORPUS = join(import.meta.dirname, "../load/corpus.mjs");
const ENGINE = join(REPO, ".tools/bin/onepipeline");

/** What a host measurement hands back: the run and node it read, and their figures. */
const hostMeasurementSchema = z.object({
  run: z.string(),
  node: z.string(),
  first_view: firstViewSchema,
  rest_arrived: z.object({ overall_s: z.number(), complete: z.literal(true) }),
  history_page: z.object({
    node_before_rest_s: z.number().nullable(),
    node_after_rest_s: z.number(),
  }),
  status: z.object({
    small_s: z.null(),
    large_s: z.number(),
    checkpoint_bytes: z.number().positive(),
  }),
});

interface Root {
  readonly dir: string;
  readonly root: string;
  readonly run: string;
  /** The node `measure-run` chooses when none is named. */
  readonly busiest: string;
  /** Another node of the plan, with the most records after the busiest. */
  readonly named: string;
}

/** A small runs root from the one corpus generator, read once by the engine as any real root is. */
function realRoot(): Root {
  const dir = mkdtempSync(join(tmpdir(), "measure-run-host-"));
  const workload = join(dir, "workload.json");
  writeFileSync(
    workload,
    JSON.stringify({
      runs: 6,
      projects: 3,
      other_live_runs: 1,
      stopped_runs: 1,
      open_live_run_records_at_start: 3000,
      settled_big_records: 60,
      settled_small_records: 20,
      large: {
        state: "live",
        records: 3000,
        journal_bytes: 3_000_000,
        streams: 60,
        ordinary_spans: 100,
        session_records: 29,
        harness_spans: 50,
        checkpoint_bytes: 700_000,
        busiest_node_records: 300,
        off_graph_node_records: 200,
      },
    }),
  );
  const root = join(dir, "runs");
  const facts = z
    .object({
      openLiveRun: z.string(),
      large: z.object({ busiestNode: z.string() }),
    })
    .parse(
      JSON.parse(
        execFileSync(process.execPath, [CORPUS, root, workload], {
          encoding: "utf8",
        }),
      ),
    );
  // A real root has been read by the engine, which writes the run's checkpoint.
  execFileSync(ENGINE, ["status", facts.openLiveRun], {
    env: {
      ...process.env,
      ONEPIPELINE_RUNS_DIR: root,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CACHE_HOME: join(dir, "cache"),
      ONEVCS_HOME: join(dir, "onevcs-home"),
      ONEPIPELINE_PROJECT_DIR: join(dir, "overrides"),
    },
    stdio: "ignore",
  });
  const run = join(root, facts.openLiveRun);
  const planned = new Set(
    z
      .object({ tasks: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(readFileSync(join(run, "plan.json"), "utf8")))
      .tasks.map((task) => task.id),
  );
  const records = new Map<string, number>();
  for (const line of readFileSync(join(run, "events.jsonl"), "utf8").split(
    "\n",
  )) {
    if (line === "") continue;
    const node = z
      .object({ labels: z.object({ node: z.string().optional() }) })
      .parse(JSON.parse(line)).labels.node;
    if (node !== undefined) records.set(node, (records.get(node) ?? 0) + 1);
  }
  const [named] = [...records]
    .filter(([node]) => planned.has(node) && node !== facts.large.busiestNode)
    .sort((a, b) => b[1] - a[1])
    .map(([node]) => node);
  if (named === undefined) throw new Error("the corpus plans one node only");
  return {
    dir,
    root,
    run: facts.openLiveRun,
    busiest: facts.large.busiestNode,
    named,
  };
}

const measureRun = (args: readonly string[]) =>
  spawnSync(process.execPath, [MEASURE_RUN, ...args], {
    encoding: "utf8",
    timeout: 900_000,
  });

let host: Root;
test.beforeAll(() => {
  host = realRoot();
});
test.afterAll(() => rmSync(host.dir, { recursive: true, force: true }));

test("measure-run-load-on-host measures the node it is named into the file it is named", () => {
  const output = join(host.dir, "measured.json");
  const run = measureRun([
    "--runs-root",
    host.root,
    "--run",
    host.run,
    "--node",
    host.named,
    "--output",
    output,
  ]);
  expect(run.status, run.stderr).toBe(0);
  // The figures went to the file, so stdout carries nothing to mistake for them.
  expect(run.stdout).toBe("");
  const measured = hostMeasurementSchema.parse(
    JSON.parse(readFileSync(output, "utf8")),
  );
  expect(measured.run).toBe(host.run);
  expect(measured.node).toBe(host.named);
});

test("measure-run-load-on-host measures the busiest node by default and writes its figures alone on stdout", () => {
  const run = measureRun(["--runs-root", host.root, "--run", host.run]);
  expect(run.status, run.stderr).toBe(0);
  // stdout is the measurement and nothing else: the runner's own report goes to stderr.
  const measured = hostMeasurementSchema.parse(JSON.parse(run.stdout));
  expect(measured.run).toBe(host.run);
  expect(measured.node).toBe(host.busiest);
});
