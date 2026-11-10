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
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
// eslint-disable-next-line @nx/enforce-module-boundaries -- `journal.ts` is the single fixture writer for the journal (its own header says so), shared with sibling project `dag-ui-e2e`; a second writer is the drift it exists to prevent.
import { appendRecords } from "../load/journal";
import { SCREEN_OBSERVER, type ScreenState } from "./mark";

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
  // The first-view-time spike's prototype server, when it names one; its switches
  // reach every server through `ONEPIPELINE_UI_SPIKE`, which `world.env` carries.
  const spike = process.env.READ_LATENCY_SERVER;
  if (spike !== undefined) return spike;
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
} as const;

/** Write a corpus of `workload` (a path, or a shape) into a fresh workspace. */
export function buildWorld(
  workload: string | object = JOURNEY_WORKLOAD,
  state?: "live" | "settled",
): World {
  const workspace = mkdtempSync(join(tmpdir(), "dag-ui-read-latency-j-"));
  const runsRoot = join(workspace, "runs");
  const file = join(workspace, "workload.json");
  const declared = (
    typeof workload === "string"
      ? JSON.parse(execFileSync("cat", [workload], { encoding: "utf8" }))
      : structuredClone(workload)
  ) as { large: { state: string } };
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

export const removeWorld = (world: World) =>
  rmSync(world.workspace, { recursive: true, force: true });

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
  (await page.evaluate("window.__firstScreen ?? []")) as ScreenState[];

/** The complete documents, read off `served`. */
export async function completeDocuments(
  served: Served,
  run: string,
  node?: string,
) {
  const root = `${served.origin}/api/v2/runs/${encodeURIComponent(run)}`;
  const detail = (await (await fetch(root)).json()) as Record<string, unknown>;
  const timeline = (await (
    await fetch(
      `${root}/timeline?scope=${node === undefined ? "run" : `node&node=${encodeURIComponent(node)}`}`,
    )
  ).json()) as { spans: Record<string, unknown>[] };
  return { detail, timeline };
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
