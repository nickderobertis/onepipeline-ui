/**
 * The real release server over a corpus of known shape, for the acceptance
 * journeys: only the network boundary is ever doubled, and only where a journey says.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  liveRunDetailSchema,
  runTimelineSchema,
  subscribedSchema,
} from "@onepipeline-ui/dag-model";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
// eslint-disable-next-line @nx/enforce-module-boundaries -- `journal.ts` is the single fixture writer for the journal (its own header says so), shared with sibling project `dag-ui-e2e`; a second writer is the drift it exists to prevent.
import { appendRecords } from "../load/journal";
import {
  SCREEN_OBSERVER,
  type ScreenState,
  screenStateSchema,
  type Visible,
} from "./mark";

export const REPO = resolve(import.meta.dirname, "../../..");
export const ENGINE = join(REPO, ".tools/bin/onepipeline");
export const LARGE_WORKLOAD = join(
  import.meta.dirname,
  "large-run-workload.json",
);
const CORPUS = join(import.meta.dirname, "../load/corpus.mjs");
export const OWNER = "read-latency-session";
export const NEVER = 300_000;

export function releaseBinary(): string {
  const triple = "x86_64-unknown-linux-gnu";
  const binary = join(
    REPO,
    "target",
    `wheel-${triple}`,
    triple,
    "release",
    "onepipeline-api",
  );
  if (!existsSync(binary))
    throw new Error(
      `no ${binary}: run 'npx nx run dag-ui-read-latency:compile-release-server'`,
    );
  return binary;
}

export const factsSchema = z.object({
  openLiveRun: z.string(),
  smallRun: z.string(),
  settledRun: z.string(),
  otherLiveRuns: z.array(z.string()),
  large: z.object({
    busiestNode: z.string(),
    offGraphNode: z.string(),
    gatedNode: z.string(),
    heldNode: z.string(),
    failedNode: z.string(),
    blockedNode: z.string(),
    crossRunConsumer: z.string(),
    historyStore: z.string(),
    sessions: z.number().int(),
    settled: z.boolean(),
  }),
  relayed: z.object({
    run: z.string(),
    nodes: z.array(z.string()),
    longDriver: z.string(),
  }),
});
export type Facts = z.infer<typeof factsSchema>;

export interface World {
  readonly workspace: string;
  readonly runsRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly facts: Facts;
}

/** A corpus of the journeys' size: every driver's shape, in seconds. */
export const JOURNEY_WORKLOAD = {
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
    journal_bytes: 2_000_000,
    streams: 60,
    ordinary_spans: 100,
    session_records: 29,
    harness_spans: 50,
    checkpoint_bytes: 200_000,
    busiest_node_records: 300,
    off_graph_node_records: 200,
  },
  relayed: {
    state: "settled",
    nodes: 9,
    records: 6000,
    journal_bytes: 4_000_000,
    run_level_records: 2200,
    driver_streams: 4,
    records_before_long_driver: 500,
    session_search_records: 700_000,
  },
} as const;

/** What a journey changes of a workload file: the large run's state; the rest as written. */
const workloadSchema = z.looseObject({
  large: z.looseObject({ state: z.enum(["live", "settled"]) }),
});

/** Write a corpus of `workload` (a path, or a shape) into a fresh workspace. */
export function buildWorld(
  workload: string | object = JOURNEY_WORKLOAD,
  state?: "live" | "settled",
): World {
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-read-latency-j-"));
  const runsRoot = join(workspace, "runs");
  const file = join(workspace, "workload.json");
  const declared = workloadSchema.parse(
    typeof workload === "string"
      ? JSON.parse(readFileSync(workload, "utf8"))
      : structuredClone(workload),
  );
  if (state !== undefined) declared.large.state = state;
  writeFileSync(file, JSON.stringify(declared));
  const facts = factsSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, [CORPUS, runsRoot, file], {
        encoding: "utf8",
        maxBuffer: 1 << 24,
      }),
    ),
  );
  for (const dir of ["config", "state", "cache", "onevcs-home", "overrides"])
    mkdirSync(join(workspace, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(workspace, "config"),
    XDG_STATE_HOME: join(workspace, "state"),
    XDG_CACHE_HOME: join(workspace, "cache"),
    ONEVCS_HOME: join(workspace, "onevcs-home"),
    ONEPIPELINE_PROJECT_DIR: join(workspace, "overrides"),
    ONEPIPELINE_RUNS_DIR: runsRoot,
    ONEAGENTGRAPH_STATE_DIR: join(workspace, "oneagentgraph"),
  };
  for (const name of [
    "ONEPIPELINE_LAUNCHER_SESSION",
    "ONEPIPELINE_WAKE_BUDGET",
    "ONEPIPELINE_UI_LIVE_TRACE",
    "ONEPIPELINE_UI_TELEMETRY_REFOLD_MS",
  ])
    delete env[name];
  return { workspace, runsRoot, env, facts };
}

export function copyWorld(world: World): World {
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-read-latency-c-"));
  cpSync(world.workspace, workspace, { recursive: true });
  const runsRoot = join(workspace, "runs");
  const env: NodeJS.ProcessEnv = {
    ...world.env,
    ONEPIPELINE_RUNS_DIR: runsRoot,
  };
  for (const name of [
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ] as const)
    env[name] = (env[name] ?? "").replace(world.workspace, workspace);
  return { workspace, runsRoot, env, facts: world.facts };
}

export const removeWorld = (world: World) => {
  for (const id of settledReads.keys())
    if (id.startsWith(`${world.workspace}\0`)) settledReads.delete(id);
  rmSync(world.workspace, { recursive: true, force: true });
};

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("the kernel named no port")),
      );
    });
  });
}

export interface Served {
  readonly origin: string;
  readonly port: number;
  readonly server: ChildProcess;
}

export async function serve(
  world: World,
  env: Record<string, string> = {},
  port?: number,
): Promise<Served> {
  const chosen = port ?? (await freePort());
  const server = spawn(
    releaseBinary(),
    [
      "serve",
      "--runs-root",
      world.runsRoot,
      "--bind",
      `127.0.0.1:${chosen}`,
      "--session",
      OWNER,
      "--ui",
    ],
    { stdio: "ignore", env: { ...world.env, ...env }, cwd: world.workspace },
  );
  const origin = `http://127.0.0.1:${chosen}`;
  const deadline = Date.now() + NEVER;
  for (;;) {
    const up = await fetch(`${origin}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error("the server never answered");
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return { origin, port: chosen, server };
}

export async function stop(served: Served): Promise<void> {
  served.server.kill("SIGTERM");
  if (served.server.exitCode === null)
    await new Promise((wake) => served.server.once("exit", wake));
}

export const addressOf = (
  run: string,
  view: "graph" | "overall" | "node" | "channel",
  node = "",
) =>
  view === "node"
    ? `/?run=${encodeURIComponent(run)}&view=graph&node=${encodeURIComponent(node)}`
    : `/?run=${encodeURIComponent(run)}&view=${view}`;

export async function observe(page: Page): Promise<void> {
  await page.addInitScript(SCREEN_OBSERVER);
}

export const screenStates = async (page: Page): Promise<ScreenState[]> =>
  z
    .array(screenStateSchema)
    .parse(await page.evaluate("window.__firstScreen ?? []"));

/**
 * What a journey reads of the complete documents: each named member, and every
 * other member as served, for the comparisons that read the documents whole.
 */
const completeDetailSchema = z.looseObject({
  run: z.looseObject({ state: z.string(), turns: z.unknown() }),
  graph: z.looseObject({
    node_status: z.record(z.string(), z.string()),
    plan: z.looseObject({
      goal: z.looseObject({ text: z.string() }).nullable().optional(),
    }),
  }),
});
const completeTimelineSchema = z.looseObject({
  spans: z.array(
    z.looseObject({
      id: z.string(),
      events: z.array(z.looseObject({ id: z.string() })).optional(),
    }),
  ),
});

/** One complete document, refused unless it was served. */
async function served200(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

type CompleteDetail = z.infer<typeof completeDetailSchema>;
type CompleteTimeline = z.infer<typeof completeTimelineSchema>;

const runRoot = (served: Served, run: string) =>
  `${served.origin}/api/v2/runs/${encodeURIComponent(run)}`;

// Validated whole through the contract's own schemas, then handed on as served:
// a parse puts the members it names first, and the journeys compare documents
// member by member in the order served.
async function detailOf(served: Served, run: string): Promise<CompleteDetail> {
  const detail = await served200(runRoot(served, run));
  liveRunDetailSchema.parse(detail);
  completeDetailSchema.parse(detail);
  return detail as CompleteDetail;
}

async function timelineOf(
  served: Served,
  run: string,
  node: string | undefined,
): Promise<CompleteTimeline> {
  const timeline = await served200(
    `${runRoot(served, run)}/timeline?scope=${node === undefined ? "run" : `node&node=${encodeURIComponent(node)}`}`,
  );
  runTimelineSchema.parse(timeline);
  completeTimelineSchema.parse(timeline);
  return timeline as CompleteTimeline;
}

/** The complete documents, read off `served`. */
export async function completeDocuments(
  served: Served,
  run: string,
  node?: string,
) {
  const detail = await detailOf(served, run);
  const timeline = await timelineOf(served, run, node);
  return { detail, timeline };
}

/** Each settled run's complete documents, by world, run and scope. */
const settledReads = new Map<string, Promise<unknown>>();

/**
 * A settled run's complete documents, read off `served` the first time a journey
 * of this worker asks for them in `world` and handed to every later one.
 *
 * On the large corpus each complete read is tens of seconds of the server's work
 * (a 45 MB detail, a 95 MB timeline), and a settled run's documents cannot change
 * while its world stands: a journey asking again would be shown the same bytes.
 * So the journeys over one world compare against one reading of each, and the
 * documents are read-only to them. Refused for a run that is still live, whose
 * documents a later read may extend.
 */
export async function settledDocuments(
  world: World,
  served: Served,
  run: string,
  node?: string,
) {
  const detail = await settledDetail(world, served, run);
  const timeline = await settledTimeline(world, served, run, node);
  return { detail, timeline };
}

/** A settled run's complete detail alone, read as `settledDocuments` reads it. */
export const settledDetail = (world: World, served: Served, run: string) =>
  settledOnce(world, run, "detail", () => detailOf(served, run));

/**
 * A settled run's complete timeline alone, read as `settledDocuments` reads it,
 * for a journey that compares against nothing else: the detail is the larger
 * read on the large corpus, and is not paid for where it is not compared.
 */
export const settledTimeline = (
  world: World,
  served: Served,
  run: string,
  node?: string,
) =>
  settledOnce(world, run, `timeline\0${node ?? ""}`, () =>
    timelineOf(served, run, node),
  );

function settledOnce<T>(
  world: World,
  run: string,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  if (run === world.facts.openLiveRun && !world.facts.large.settled)
    throw new Error(`${run} is live in this world; read its documents fresh`);
  const id = [world.workspace, run, key].join("\0");
  // A key names one read and so one result type: the two callers above key a
  // run's detail as `detail` and its timeline as `timeline\0<node>`, so what
  // is stored under an id is always the `T` its caller's read returns.
  let held = settledReads.get(id) as Promise<T> | undefined;
  if (held === undefined) {
    held = read();
    settledReads.set(id, held);
    // A failed read is not kept: the next journey reads again and says why.
    held.catch(() => settledReads.delete(id));
  }
  return held;
}

/** A run view's first answer, read through the contract's own parser. */
export function visibleOf(body: unknown): Visible {
  const { initial } = subscribedSchema.parse(body);
  if (initial.type !== "snapshot")
    throw new Error("a first answer that is a reset");
  const { visible } = initial.snapshot;
  switch (visible.type) {
    case "detail":
    case "channel":
      return { detail: visible.detail };
    case "timeline":
      return { detail: visible.detail, timeline: visible.timeline };
    default:
      throw new Error(`a ${visible.type} view's answer, not a run view's`);
  }
}

/** An append through the single fixture writer, as an executor's write lands. */
export function appendTo(
  world: World,
  run: string,
  node: string,
  kind: string,
  stream: string,
  seq: number,
  payload: object = {},
  labels: object = {},
  source = "agentgraph",
): void {
  appendRecords(join(world.runsRoot, run, "events.jsonl"), [
    {
      v: 1,
      ts: new Date().toISOString(),
      stream,
      seq,
      source,
      kind,
      labels: { run_id: run, ...(node === "" ? {} : { node }), ...labels },
      payload,
      artifacts: [],
    },
  ]);
}

export const toolPayload = (index: number) => ({
  kind: "tool_call",
  name: "Bash",
  detail: `live step ${index}`,
  truncated: false,
  output: `output of live step ${index}`,
  index,
});

export const metricText = (page: Page, name: string) =>
  page.getByRole("group", { name, exact: true }).getByRole("strong");

export { expect };
