/**
 * The request-load corpus, at this host's scale: the workload every
 * `apps/dag-ui-e2e/budgets.yaml` budget is stated over.
 *
 * 150 run directories across 30 projects, written in the SDK's on-disk shape the
 * way `../fixtures/runs.mjs` writes its runs: a launch record, a plan, a merged
 * journal, and — for a settled run — the result a driver writes as it closes.
 *
 * - 11 live runs: `load-live-open` (the live run a reader opens, its journal
 *   grown to 116,000 records — this host's largest) and ten others the writer
 *   appends to during every window.
 * - 10 stopped runs (`run-stopped` recorded, no result).
 * - 129 settled runs (`result.json` complete).
 *
 * Record mix and sizes follow this host's largest recorded journal (98 MB over
 * 116,888 records): heartbeats ~55 %, tool activity ~30 % at ~1.3 KB, check
 * polls ~6 %, and the turns and settlements around them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { receiptFor } from "./journal.ts";

export const OPEN_LIVE_RUN = "load-live-open";
export const SETTLED_OPEN_RUN = "load-settled-000";
export const STOPPED_OPEN_RUN = "load-stopped-00";
export const OTHER_LIVE_RUNS = Array.from(
  { length: 10 },
  (_, index) => `load-live-${String(index).padStart(2, "0")}`,
);
export const LIVE_NODE = "dashboard";
export const OTHER_LIVE_NODE = "work";
export const PROJECTS = 30;
export const RUNS = 150;
export const OPEN_LIVE_RECORDS = 116_000;
export const projectOf = (index) =>
  `local-md:load-project-${String(index % PROJECTS).padStart(2, "0")}`;

const HOST = "a-recording-host";
const stamp = (millis) => new Date(millis).toISOString();
export const streamOf = (runId) => `${HOST}-${runId}`;
/** Filler with the size of real tool output, so bytes per record are realistic. */
const OUTPUT = "x".repeat(900);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function graphRecordsFor(root) {
  return join(dirname(root), "oneagentgraph");
}

function declareGraph(root, stream, started) {
  const dir = join(graphRecordsFor(root), stream);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "record.json"), {
    schema_version: 3,
    run_id: stream,
    graph: "graphs/a-graph.yaml",
    name: stream,
    started_ms: started,
    members: {},
    declared_members: ["monitor", "worker", "llmlint"],
    refs: [],
    events_path: join(dir, "events.jsonl"),
  });
}

function planOf(nodes) {
  return {
    schema_version: 2,
    goal: { text: "Carry the load" },
    name: "load",
    concurrency: 3,
    tasks: nodes.map((id, index) => ({
      id,
      persona: "worker",
      ...(index === 0 ? {} : { deps: [nodes[index - 1]] }),
      task: `## What\nDo ${id}.\n\n## Acceptance criteria\n${id} is done`,
    })),
  };
}

/** A journal written whole, one record at a time, on one stream. */
class Journal {
  constructor(runId, at) {
    this.runId = runId;
    this.stream = streamOf(runId);
    this.at = at;
    this.lines = [];
    this.turns = new Map();
  }

  emit(source, kind, labels, payload = {}) {
    this.lines.push(
      JSON.stringify({
        v: 1,
        ts: stamp(this.at),
        stream: this.stream,
        seq: this.lines.length,
        source,
        kind,
        labels: { run_id: this.runId, ...labels },
        payload,
        artifacts: [],
      }),
    );
  }

  /** One node's worth of real-looking work: a dispatch, turns, activity, heartbeats. */
  work(node, records, stepMs, settle) {
    const session = `${this.stream}-${node}.worker`;
    const member = { node, member: "worker", persona: "worker" };
    this.emit("pipeline", "node-dispatched", { node, persona: "worker" });
    let turn = 0;
    for (let index = 0; index < records; index += 1) {
      this.at += stepMs;
      const roll = index % 20;
      if (roll === 0) {
        turn += 1;
        this.emit(
          "agentgraph",
          "turn-started",
          { ...member, session },
          {
            turn,
            role: "assistant",
            instruction: "Carry on with the plan.",
            started_at: stamp(this.at),
            model: "a-model",
          },
        );
      } else if (roll === 19) {
        this.emit(
          "agentgraph",
          "turn-completed",
          { ...member, session },
          {
            turn,
            role: "assistant",
            usage: { input_tokens: 20, output_tokens: 700, cost_usd: 0.4 },
            started_at: stamp(this.at - 19 * stepMs),
            finished_at: stamp(this.at),
          },
        );
      } else if (roll === 18) {
        this.emit(
          "agentgraph",
          "turn-message",
          { ...member, session },
          { turn, role: "assistant", text: `Turn ${turn} of ${node} done` },
        );
      } else if (roll % 3 === 0 || roll === 17) {
        this.emit(
          "agentgraph",
          "turn-activity",
          { ...member, session },
          {
            kind: "tool_call",
            name: "Bash",
            detail: `step ${index} of ${node}`,
            truncated: false,
            output: OUTPUT,
            index,
          },
        );
      } else if (roll === 16) {
        this.emit(
          "vcs",
          "change-check",
          { node, persona: "worker", session },
          {
            name: "ci",
            required: true,
            status: "in_progress",
            state: "pending",
          },
        );
      } else {
        this.emit("agentgraph", "member-heartbeat", member, {});
      }
    }
    if (settle) {
      this.at += stepMs;
      this.emit(
        "pipeline",
        "node-settled",
        { node },
        { status: "done", outcome: "merged" },
      );
    }
  }

  write(dir) {
    const journal = join(dir, "events.jsonl");
    writeFileSync(journal, `${this.lines.join("\n")}\n`);
    // Left as the engine's writer leaves a journal it has just appended to, so
    // the first live append continues it rather than forcing a whole re-read.
    receiptFor(journal);
  }
}

function launch(runId, project, startedAt) {
  return {
    run_id: runId,
    project,
    plan: "plan.json",
    graph: "graphs/dag-scope.yaml",
    launcher: "claude-code",
    session: "load-session",
    pid: 4242,
    host: HOST,
    started_at: startedAt,
    heartbeat_interval: 1800,
    adoptions: 0,
  };
}

function writeRun(
  root,
  runId,
  project,
  kind,
  nodes,
  perNode,
  startMs,
  stepMs,
  extra = 0,
) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const plan = planOf(nodes);
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "launch.json"), launch(runId, project, stamp(startMs)));
  const journal = new Journal(runId, startMs);
  declareGraph(root, journal.stream, startMs);
  journal.emit("pipeline", "run-started", {}, { plan });
  // Live runs leave their last node running; the others settle every node.
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    journal.work(
      node,
      perNode + (last ? extra : 0),
      stepMs,
      !(last && kind !== "settled"),
    );
  });
  if (kind === "stopped") {
    journal.at += stepMs;
    journal.emit("pipeline", "run-stopped", {});
  }
  journal.write(dir);
  if (kind === "settled") {
    writeJson(join(dir, "result.json"), {
      run_id: runId,
      state: "complete",
      ok: true,
      nodes: nodes.map((id) => ({ id, status: "done", outcome: "merged" })),
    });
  }
  return journal.at;
}

/**
 * The corpus's two sizes: this host's scale, which every budget is stated over,
 * and the journeys' — the same shapes and names at a size a functional journey
 * can write and wait on in seconds.
 */
const SCALES = {
  host: {
    openLiveRecords: OPEN_LIVE_RECORDS,
    otherLive: 10,
    stopped: 10,
    runs: RUNS,
    settledBig: 1000,
    settledSmall: 40,
  },
  journey: {
    openLiveRecords: 1_500,
    otherLive: 2,
    stopped: 2,
    runs: 10,
    settledBig: 60,
    settledSmall: 20,
  },
};

/** Write the whole corpus under `root`; returns what the harness needs to know. */
export function buildLoadCorpus(root, scaleName = "host") {
  const scale = SCALES[scaleName];
  if (scale === undefined) throw new Error(`no corpus scale ${scaleName}`);
  const otherLiveRuns = OTHER_LIVE_RUNS.slice(0, scale.otherLive);
  mkdirSync(root, { recursive: true });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let index = 0;
  // The open live run: 15 nodes, the last (`dashboard`) still running, and
  // its records over the last day.
  const openNodes = Array.from({ length: 14 }, (_, n) => `step-${n}`).concat(
    LIVE_NODE,
  );
  // run-started, a dispatch per node, a settlement per node but the last.
  const header = 2 * openNodes.length;
  const perNode = Math.floor(
    (scale.openLiveRecords - header) / openNodes.length,
  );
  const extra = scale.openLiveRecords - header - perNode * openNodes.length;
  writeRun(
    root,
    OPEN_LIVE_RUN,
    projectOf(index++),
    "live",
    openNodes,
    perNode,
    now - day,
    Math.floor(day / scale.openLiveRecords),
    extra,
  );
  for (const runId of otherLiveRuns) {
    writeRun(
      root,
      runId,
      projectOf(index++),
      "live",
      ["prepare", "build", OTHER_LIVE_NODE],
      scale === SCALES.host ? 400 : 20,
      now - 2 * 60 * 60 * 1000,
      5_000,
    );
  }
  for (let stopped = 0; stopped < scale.stopped; stopped += 1) {
    writeRun(
      root,
      `load-stopped-${String(stopped).padStart(2, "0")}`,
      projectOf(index++),
      "stopped",
      ["prepare", "build", "publish"],
      // The opened stopped run is mid-sized; the rest are this host's median.
      stopped === 0 ? scale.settledBig : scale.settledSmall,
      now - (2 + stopped) * day,
      2_000,
    );
  }
  for (let settled = 0; index < scale.runs; settled += 1) {
    // Mostly this host's median journal (~124 records), every tenth at its p90
    // (~3,000), the opened one at p90 too.
    const big = settled % 10 === 0;
    writeRun(
      root,
      `load-settled-${String(settled).padStart(3, "0")}`,
      projectOf(index++),
      "settled",
      ["prepare", "build", "publish"],
      big ? scale.settledBig : scale.settledSmall,
      now - (3 + settled / 10) * day,
      2_000,
    );
  }
  return {
    runs: scale.runs,
    projects: Math.min(PROJECTS, scale.runs),
    openLiveRun: OPEN_LIVE_RUN,
    openLiveRecords: scale.openLiveRecords,
    settledRun: SETTLED_OPEN_RUN,
    stoppedRun: STOPPED_OPEN_RUN,
    otherLiveRuns,
    liveNode: LIVE_NODE,
    openProject: projectOf(0),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, scale = "host"] = process.argv.slice(2);
  if (root === undefined || (scale !== "host" && scale !== "journey"))
    throw new Error("usage: corpus.mjs ROOT [host|journey]");
  console.log(JSON.stringify(buildLoadCorpus(root, scale)));
}
