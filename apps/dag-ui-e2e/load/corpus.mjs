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
 * polls ~6 %, and the turns and settlements around them. Tool output is real
 * text (`output.mjs`), so it compresses as a real host's does.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { receiptFor } from "./journal.ts";
import { toolOutput } from "./output.mjs";
// The workload every budget is stated over, declared once for this writer,
// the journey that drives it and the schema its recording is held to.
import workload from "./workload.json" with { type: "json" };

export const PROJECTS = workload.projects;
export const RUNS = workload.runs;
export const OPEN_LIVE_RECORDS = workload.open_live_run_records_at_start;

/** The most other live runs any workload declares. */
const MOST_OTHER_LIVE_RUNS = 11;

export const OPEN_LIVE_RUN = "load-live-open";
export const SETTLED_OPEN_RUN = "load-settled-000";
export const STOPPED_OPEN_RUN = "load-stopped-00";
/** A settled run whose own drivers relayed a third of its records at no node. */
export const RELAYED_RUN = "load-relayed-settled";
/** A settled one-node run, the status budget's small run. */
export const SMALL_SETTLED_RUN = "load-small-settled";
export const OTHER_LIVE_RUNS = Array.from(
  { length: Math.max(workload.other_live_runs, MOST_OTHER_LIVE_RUNS) },
  (_, index) => `load-live-${String(index).padStart(2, "0")}`,
);
export const LIVE_NODE = "dashboard";
export const OTHER_LIVE_NODE = "work";
export const projectOf = (index, projects = PROJECTS) =>
  `local-md:load-project-${String(index % projects).padStart(2, "0")}`;

const HOST = "a-recording-host";
const stamp = (millis) => new Date(millis).toISOString();
export const streamOf = (runId) => `${HOST}-${runId}`;

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
  constructor(runId, at, large = null) {
    this.runId = runId;
    this.stream = streamOf(runId);
    this.at = at;
    this.lines = [];
    this.turns = new Map();
    // `null` for every run but the large one, whose drivers `workLarge` follows.
    this.large = large;
    // Each record's own stream when the run is split over many, else one stream.
    this.seqs = new Map();
    this.streamOverride = null;
    // Every session file's lines, written once at the end rather than per call.
    this.sessionFiles = new Map();
    this.calls = 0;
  }

  emit(source, kind, labels, payload = {}, artifacts = []) {
    const stream = this.streamOverride ?? this.stream;
    const seq =
      this.large === null ? this.lines.length : (this.seqs.get(stream) ?? 0);
    this.seqs.set(stream, seq + 1);
    this.lines.push(
      JSON.stringify({
        v: 1,
        ts: stamp(this.at),
        stream,
        seq,
        source,
        kind,
        labels: { run_id: this.runId, ...labels },
        payload,
        artifacts,
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
            output: toolOutput(index),
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

  /** A session file's stem, its UUID v7, and its directory in the session store. */
  sessionRef(stem) {
    const digest = createHash("md5").update(stem).digest("hex");
    // The engine reads a reference's id as a UUID v7, and refuses any other at
    // once without opening the file: the version and variant nibbles say so.
    const historyId = [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `7${digest.slice(13, 16)}`,
      `8${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join("-");
    return { historyId };
  }

  /**
   * One tool call as the engine records it when a harness keeps a history store:
   * a reference into a session file, with the output only in that file, so
   * reading the record's description means resolving that reference.
   */
  recordedCall(node, index) {
    const { store, callsPerSession } = this.large;
    const session = Math.floor(this.calls / callsPerSession);
    const call = this.calls % callsPerSession;
    this.calls += 1;
    const historySession = `${this.runId}-${node}-${session}`;
    const { historyId } = this.sessionRef(historySession);
    const lines = this.sessionFiles.get(historySession) ?? [];
    lines.push(
      `${JSON.stringify({
        type: "event",
        schema_version: "1.1",
        run_id: historyId,
        harness: "claude-code",
        event: {
          kind: "tool_call",
          name: "Bash",
          input: { command: `step ${index} of ${node}` },
          output: toolOutput(index),
          index: call,
        },
      })}\n`,
    );
    this.sessionFiles.set(historySession, lines);
    return {
      kind: "tool_call",
      name: "Bash",
      detail: `step ${index} of ${node}`,
      index: call,
      transcript: {
        history_dir: store,
        history_project: SESSION_STORE_PROJECT,
        history_session: historySession,
        history_id: historyId,
        index: call,
      },
    };
  }

  /**
   * The large run's node: its records divided into sessions (one `dispatch`
   * span each), the sessions into streams two to a stream, and each stream's
   * edges resting on records a selective read drops by kind: an even session
   * opens on a `member-heartbeat`, an odd session closes on a `turn-activity`.
   * A read that kept neither would draw those spans at the wrong place.
   */
  workLarge(node, records, stepMs, settle, settlement) {
    const { sessionRecords } = this.large;
    this.emit("pipeline", "node-dispatched", { node, persona: "worker" });
    let turn = 0;
    let session = "";
    let opensOnHeartbeat = false;
    for (let index = 0; index < records; index += 1) {
      this.at += stepMs;
      const inSession = index % sessionRecords;
      if (inSession === 0) {
        const number = this.large.sessions;
        this.large.sessions += 1;
        session = `${this.stream}-${node}.worker-${number}`;
        opensOnHeartbeat = number % 2 === 0;
        turn = opensOnHeartbeat ? 1 : 0;
        this.streamOverride = `node-scope-${Math.floor(number / 2)}`;
      }
      const member = { node, member: "worker", persona: "worker", session };
      const roll = inSession % 20;
      const closesOnActivity =
        !opensOnHeartbeat && inSession === sessionRecords - 1;
      if (opensOnHeartbeat && inSession === 0) {
        this.emit("agentgraph", "member-heartbeat", member, {});
      } else if (inSession === sessionRecords - 3) {
        // The record a verification span's start rests on: dropped by kind
        // unless a read keeps the record before each piece of evidence.
        this.emit(
          "agentgraph",
          "turn-activity",
          member,
          this.recordedCall(node, index),
        );
      } else if (inSession === sessionRecords - 2) {
        // One `verification` span of the run's timeline per session.
        this.emit(
          "vcs",
          "change-check",
          { node, persona: "worker", session },
          {
            name: "ci",
            required: true,
            status: "success",
            state: "success",
            detail: `verified ${index} of ${node}`,
          },
          [{ id: `verify-${this.large.sessions}`, kind: "log", bytes: 0 }],
        );
      } else if (closesOnActivity) {
        this.emit(
          "agentgraph",
          "turn-activity",
          member,
          this.recordedCall(node, index),
        );
      } else if (roll === 0) {
        turn += 1;
        this.emit("agentgraph", "turn-started", member, {
          turn,
          role: "assistant",
          instruction: "Carry on with the plan.",
          started_at: stamp(this.at),
          model: "a-model",
        });
      } else if (roll === 19) {
        this.emit("agentgraph", "turn-completed", member, {
          turn,
          role: "assistant",
          usage: { input_tokens: 20, output_tokens: 700, cost_usd: 0.4 },
          started_at: stamp(this.at - 19 * stepMs),
          finished_at: stamp(this.at),
        });
      } else if (roll === 18) {
        this.emit("agentgraph", "turn-message", member, {
          turn,
          role: "assistant",
          text: `Turn ${turn} of ${node} done`,
        });
      } else if (roll % 3 === 0 || roll === 17) {
        this.emit(
          "agentgraph",
          "turn-activity",
          member,
          this.recordedCall(node, index),
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
    this.streamOverride = null;
    if (settle) {
      this.at += stepMs;
      this.emit("pipeline", "node-settled", { node }, settlement);
    }
  }

  /** Grow the run's tool activity until its journal holds `target` bytes of real text. */
  pad(target) {
    const activities = [];
    this.lines.forEach((line, at) => {
      if (line.includes('"kind":"turn-activity"')) activities.push(at);
    });
    const size = () =>
      this.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    let deficit = target - size();
    if (activities.length === 0 || deficit <= 0) return;
    let chars = Math.floor(deficit / activities.length);
    const base = activities.map((at) => JSON.parse(this.lines[at]));
    // Escapes make the text larger than its characters: one pass to learn by
    // how much, a second to land on the target.
    for (let pass = 0; pass < 2 && chars > 0; pass += 1) {
      activities.forEach((at, index) => {
        const record = structuredClone(base[index]);
        let text = record.payload.detail;
        for (let draw = 0; text.length < chars; draw += 1)
          text += ` ${toolOutput(index + draw * 7)}`;
        record.payload.detail = text.slice(0, chars);
        this.lines[at] = JSON.stringify(record);
      });
      deficit = target - size();
      chars += Math.floor(deficit / activities.length);
    }
  }

  writeSessionFiles() {
    if (this.sessionFiles.size === 0) return;
    const dir = join(this.large.store, SESSION_STORE_PROJECT);
    mkdirSync(dir, { recursive: true });
    for (const [session, lines] of this.sessionFiles)
      writeFileSync(join(dir, `${session}.jsonl`), lines.join(""));
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

/** The history project a harness's session files sit under. */
const SESSION_STORE_PROJECT = "load-history-project";

/** The session and run files of a run's harness pointers, and the pointer lines. */
function writeHarnessPointers(
  dir,
  store,
  runId,
  project,
  nodes,
  count,
  journal,
) {
  const sessionFile = join(store, SESSION_STORE_PROJECT);
  mkdirSync(sessionFile, { recursive: true });
  const perFile = 50;
  const started = Date.parse(journal.firstTs);
  const pointers = [];
  const records = new Map();
  for (let index = 0; index < count; index += 1) {
    const session = `harness-${runId}-${Math.floor(index / perFile)}`;
    const node = nodes[index % nodes.length];
    const historyId = journal.sessionRef(`${session}-${index}`).historyId;
    const at = started + index * 1_000;
    records.set(session, [
      ...(records.get(session) ?? []),
      `${JSON.stringify({
        type: "run",
        schema_version: "1.1",
        history_id: historyId,
        session,
        name: session,
        project: "/tmp/load",
        timestamp: stamp(at),
        started_at: stamp(at),
        finished_at: stamp(at + 2_000),
        harness: "claude-code",
        harness_id: "claude-code",
        model: "a-model",
        prompt: "work",
        permission_mode: "default",
        status: "ok",
        exit_code: 0,
        duration_ms: 2_000,
        model_ms: 2_000,
        tool_ms: 0,
        text: "done",
        text_source: "json:result",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0,
        },
        session_id: historyId,
        failure_kind: null,
      })}\n`,
    ]);
    pointers.push(
      `${JSON.stringify({
        schema_version: "1.0",
        history_id: historyId,
        history_dir: store,
        history_project: SESSION_STORE_PROJECT,
        history_session: session,
        history_file: join(sessionFile, `${session}.jsonl`),
        name: session,
        project: "/tmp/load",
        harness: "claude-code",
        harness_id: "claude-code",
        started: stamp(at),
        labels: {
          "onepipeline.attempt": "1",
          "onepipeline.node": node,
          "onepipeline.project": project,
          "onepipeline.run_id": runId,
          "onepipeline.scope": "worker",
          role: "engineer",
        },
      })}\n`,
    );
  }
  for (const [session, lines] of records)
    writeFileSync(join(sessionFile, `${session}.jsonl`), lines.join(""));
  appendFileSync(join(dir, "oneharness-sessions.jsonl"), pointers.join(""));
}

/**
 * The large run the read-latency budgets are stated over: this host's largest
 * run's shape in every driver a first read can get wrong, each one named by the
 * workload that asks for it and reported back so a recording can be held to it.
 */
function writeLargeRun(root, runId, project, scale, startMs, stepMs) {
  const { large } = scale;
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const settled = large.state === "settled";
  const store = join(dirname(root), "history");
  // Node names: the graph's steps, its busiest node, and the off-graph one. A
  // step is named at a real node id's length, which every span repeats: the
  // budgets state Overall's first answer over 1 MB, and a short name would
  // understate it.
  const steps = Array.from(
    { length: 14 },
    (_, n) => `implement-first-screen-${n}`,
  );
  const busiest = LIVE_NODE;
  const offGraph = "retired-off-graph";
  const planned = [
    ...steps,
    busiest,
    "gated-on-dashboard",
    "held-for-release",
    "failed-with-reason",
    "blocked-by-failure",
    "cross-run-consumer",
  ];
  const stepRecords = Math.floor(
    (large.records -
      large.busiest_node_records -
      large.off_graph_node_records -
      4 * LARGE_SPECIAL_NODE_RECORDS) /
      steps.length,
  );
  // Each node's records, in the order they are written.
  const shares = new Map([
    ...steps.map((node) => [node, stepRecords]),
    [busiest, large.busiest_node_records],
    ["held-for-release", LARGE_SPECIAL_NODE_RECORDS],
    ["failed-with-reason", LARGE_SPECIAL_NODE_RECORDS],
    ["cross-run-consumer", LARGE_SPECIAL_NODE_RECORDS],
    [offGraph, large.off_graph_node_records],
  ]);
  const taskBytes = Math.floor(large.checkpoint_bytes / 2 / planned.length);
  const padding = (index) =>
    Array.from({ length: Math.ceil(taskBytes / 900) }, (_, draw) =>
      toolOutput(index * 1_000 + draw),
    )
      .join("\n")
      .slice(0, taskBytes);
  const crossRunRef = `run:${SETTLED_OPEN_RUN}#publish`;
  const plan = planOf(planned);
  plan.tasks.forEach((task, index) => {
    task.task = `${task.task}\n\n${padding(index)}`;
    if (task.id === "cross-run-consumer")
      task.deps = [...(task.deps ?? []), crossRunRef];
  });
  // Deps as a real replan left them: the reason and awaits lines read off these.
  for (const task of plan.tasks) {
    if (task.id === "gated-on-dashboard") task.deps = [busiest];
    if (task.id === "blocked-by-failure") task.deps = ["failed-with-reason"];
  }
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "launch.json"), launch(runId, project, stamp(startMs)));
  const journal = new Journal(runId, startMs, {
    store,
    callsPerSession: 1_400,
    sessionRecords: large.session_records,
    sessions: 0,
  });
  journal.firstTs = stamp(startMs);
  declareGraph(root, journal.stream, startMs);
  journal.emit("pipeline", "run-started", {}, { plan });
  for (const [node, records] of shares) {
    const last = node === busiest;
    const settlement =
      node === "held-for-release"
        ? {
            status: "complete-but-held",
            outcome: "held-for-release",
            detail: "complete, and held unlanded: awaiting the crate release",
            awaiting: [{ producer: "example/awaited-crate", target: "crate" }],
          }
        : node === "failed-with-reason"
          ? {
              status: "failed",
              detail: "the check it depends on failed with a real reason",
            }
          : { status: "done", outcome: "merged" };
    journal.workLarge(
      node,
      records,
      stepMs,
      !(last && !settled),
      settled && last ? { status: "done", outcome: "merged" } : settlement,
    );
  }
  journal.pad(large.journal_bytes);
  journal.writeSessionFiles();
  writeHarnessPointers(
    dir,
    store,
    runId,
    project,
    [...steps, busiest],
    large.harness_spans,
    journal,
  );
  journal.write(dir);
  if (settled)
    writeJson(join(dir, "result.json"), {
      run_id: runId,
      state: "complete",
      ok: true,
      nodes: planned.map((id) => ({ id, status: "done", outcome: "merged" })),
    });
  return {
    busiestNode: busiest,
    offGraphNode: offGraph,
    gatedNode: "gated-on-dashboard",
    heldNode: "held-for-release",
    failedNode: "failed-with-reason",
    blockedNode: "blocked-by-failure",
    crossRunConsumer: "cross-run-consumer",
    crossRunRef,
    historyStore: store,
    sessions: journal.large.sessions,
    settled,
  };
}

/** How many records each node beyond the budget's named ones holds. */
const LARGE_SPECIAL_NODE_RECORDS = 32;

/** The members a run's own drivers relay as, both of which every graph here declares. */
const DRIVER_MEMBERS = ["monitor", "llmlint"];

/**
 * Where one run-level record falls in its member's turn on a driver's stream: the
 * heartbeats, which name no session, then a turn whose records each name one.
 */
const DRIVER_TURN = [
  ...Array.from({ length: 19 }, () => "member-heartbeat"),
  "turn-started",
  ...Array.from({ length: 5 }, () => "turn-activity"),
  "turn-message",
  "turn-completed",
];

/**
 * A settled run whose own drivers relayed a third of its records at no node: this
 * host's run that opened Overall slowest, in the shape that made it slow. Its
 * driver streams come one after another, as a run's adoptions leave them, and the
 * last lives longest; on each, a member's heartbeats name no session and its turns
 * name one, so every heartbeat of the last driver is attributed to a session first
 * named after `records_before_long_driver` run-level records of the drivers before
 * it. The rest of its records are its nodes' ordinary work.
 */
function writeRelayedRun(root, runId, project, relayed, startMs, stepMs) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const nodes = Array.from(
    { length: relayed.nodes },
    (_, n) => `relayed-step-${n}`,
  );
  const plan = planOf(nodes);
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "launch.json"), launch(runId, project, stamp(startMs)));
  const journal = new Journal(runId, startMs);
  declareGraph(root, journal.stream, startMs);
  journal.emit("pipeline", "run-started", {}, { plan });
  const drivers = Array.from(
    { length: relayed.driver_streams },
    (_, n) => `${journal.stream}-driver-${String(n).padStart(2, "0")}`,
  );
  for (const driver of drivers) declareGraph(root, driver, startMs);
  // Every run-level record, in order: each early driver's even share of the
  // records before the long one, then the long one's.
  const early = drivers.length - 1;
  const before = relayed.records_before_long_driver;
  const quota = (at) =>
    at < early
      ? Math.floor(before / early) + (at < before % early ? 1 : 0)
      : relayed.run_level_records - before;
  const runLevel = [];
  drivers.forEach((stream, at) => {
    const turns = new Map();
    for (let index = 0; index < quota(at); index += 1) {
      // One record in eight is the second member's.
      const member = DRIVER_MEMBERS[index % 8 === 7 ? 1 : 0];
      const place = turns.get(member) ?? 0;
      turns.set(member, place + 1);
      runLevel.push({
        stream,
        member,
        kind: DRIVER_TURN[place % DRIVER_TURN.length],
        turn: Math.floor(place / DRIVER_TURN.length) + 1,
      });
    }
  });
  let next = 0;
  const relay = (count) => {
    for (const end = Math.min(next + count, runLevel.length); next < end; ) {
      const { stream, member, kind, turn } = runLevel[next];
      next += 1;
      journal.at += stepMs;
      journal.streamOverride = stream;
      const labels = { member, persona: member };
      const session = { ...labels, session: `${stream}.${member}` };
      if (kind === "member-heartbeat")
        journal.emit("agentgraph", kind, labels, {});
      else if (kind === "turn-started")
        journal.emit("agentgraph", kind, session, {
          turn,
          role: "assistant",
          instruction: "Keep the run moving.",
          started_at: stamp(journal.at),
          model: "a-model",
        });
      else if (kind === "turn-activity")
        journal.emit("agentgraph", kind, session, {
          kind: "tool_call",
          name: "Bash",
          detail: `driver step ${next} on ${stream}`,
          truncated: false,
          output: toolOutput(next),
          index: next,
        });
      else if (kind === "turn-message")
        journal.emit("agentgraph", kind, session, {
          turn,
          role: "assistant",
          text: `Driver turn ${turn} done`,
        });
      else
        journal.emit("agentgraph", kind, session, {
          turn,
          role: "assistant",
          usage: { input_tokens: 20, output_tokens: 700, cost_usd: 0.4 },
          started_at: stamp(journal.at - 7 * stepMs),
          finished_at: stamp(journal.at),
        });
    }
    journal.streamOverride = null;
  };
  // The run-level records between the nodes' work, as a driver relays them
  // while its nodes run: a share before each node and the rest after the last.
  const nodeRecords =
    relayed.records - 1 - 2 * nodes.length - relayed.run_level_records;
  const perNode = Math.floor(nodeRecords / nodes.length);
  const share = Math.ceil(runLevel.length / (nodes.length + 1));
  nodes.forEach((node, index) => {
    relay(share);
    const last = index === nodes.length - 1;
    journal.work(
      node,
      perNode + (last ? nodeRecords - perNode * nodes.length : 0),
      stepMs,
      true,
    );
  });
  relay(runLevel.length);
  journal.pad(relayed.journal_bytes);
  journal.write(dir);
  writeJson(join(dir, "result.json"), {
    run_id: runId,
    state: "complete",
    ok: true,
    nodes: nodes.map((id) => ({ id, status: "done", outcome: "merged" })),
  });
  return { nodes, longDriver: drivers[early] };
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

/**
 * A scale another tier's `workload.json` declares, read from its `path`: this
 * generator's shapes and names at the size that tier's budgets are stated over.
 */
function scaleOfWorkload(path) {
  const count = z.number().int().nonnegative();
  const declared = z
    .looseObject({
      runs: count.positive(),
      projects: count.positive(),
      other_live_runs: count.max(OTHER_LIVE_RUNS.length),
      stopped_runs: count,
      // Enough for the open run's fifteen nodes and their records.
      open_live_run_records_at_start: count.min(30),
      settled_big_records: count,
      settled_small_records: count,
      large: z
        .object({
          state: z.enum(["live", "settled"]),
          records: count.positive(),
          journal_bytes: count.positive(),
          streams: count.positive(),
          ordinary_spans: count.positive(),
          session_records: count.positive(),
          harness_spans: count.positive(),
          checkpoint_bytes: count.positive(),
          busiest_node_records: count.positive(),
          off_graph_node_records: count.positive(),
        })
        .optional(),
      relayed: z
        .object({
          state: z.literal("settled"),
          nodes: count.positive(),
          records: count.positive(),
          journal_bytes: count.positive(),
          run_level_records: count.positive(),
          driver_streams: count.min(2),
          records_before_long_driver: count.positive(),
          session_search_records: count.positive(),
        })
        .refine(
          (run) =>
            run.records > 1 + 2 * run.nodes + run.run_level_records &&
            run.run_level_records > run.records_before_long_driver,
          "a relayed run's records hold its run-level records and its nodes' work, and its run-level records its earlier drivers'",
        )
        .optional(),
    })
    .refine(
      (held) =>
        held.runs >
        1 +
          held.other_live_runs +
          held.stopped_runs +
          (held.relayed === undefined ? 0 : 1),
      "a workload's runs hold its open, live, stopped and relayed runs and a settled one",
    )
    .parse(JSON.parse(readFileSync(path, "utf8")));
  return {
    openLiveRecords: declared.open_live_run_records_at_start,
    otherLive: declared.other_live_runs,
    stopped: declared.stopped_runs,
    runs: declared.runs,
    projects: declared.projects,
    settledBig: declared.settled_big_records,
    settledSmall: declared.settled_small_records,
    large: declared.large,
    relayed: declared.relayed,
  };
}

/**
 * Write the whole corpus under `root`; returns what the harness needs to know.
 * `scaleName` is one of {@link SCALES}, or the path of a `workload.json`.
 */
export function buildLoadCorpus(root, scaleName = "host") {
  const scale = scaleName.endsWith(".json")
    ? scaleOfWorkload(scaleName)
    : SCALES[scaleName];
  if (scale === undefined) throw new Error(`no corpus scale ${scaleName}`);
  const projects = scale.projects ?? PROJECTS;
  const projectOfRun = (at) => projectOf(at, projects);
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
  const large =
    scale.large === undefined
      ? undefined
      : writeLargeRun(
          root,
          OPEN_LIVE_RUN,
          projectOfRun(index++),
          scale,
          now - day,
          Math.floor(day / scale.large.records),
        );
  if (large === undefined)
    writeRun(
      root,
      OPEN_LIVE_RUN,
      projectOfRun(index++),
      "live",
      openNodes,
      perNode,
      now - day,
      Math.floor(day / scale.openLiveRecords),
      extra,
    );
  if (scale.large !== undefined)
    writeRun(
      root,
      SMALL_SETTLED_RUN,
      projectOfRun(index++),
      "settled",
      ["only"],
      8,
      now - 3 * day,
      2_000,
    );
  const relayed =
    scale.relayed === undefined
      ? undefined
      : writeRelayedRun(
          root,
          RELAYED_RUN,
          projectOfRun(index++),
          scale.relayed,
          now - 2 * day,
          Math.floor(day / scale.relayed.records),
        );
  for (const runId of otherLiveRuns) {
    writeRun(
      root,
      runId,
      projectOfRun(index++),
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
      projectOfRun(index++),
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
      projectOfRun(index++),
      "settled",
      ["prepare", "build", "publish"],
      big ? scale.settledBig : scale.settledSmall,
      now - (3 + settled / 10) * day,
      2_000,
    );
  }
  return {
    runs: scale.runs,
    projects: Math.min(projects, scale.runs),
    openLiveRun: OPEN_LIVE_RUN,
    openLiveRecords: scale.openLiveRecords,
    settledRun: SETTLED_OPEN_RUN,
    stoppedRun: STOPPED_OPEN_RUN,
    otherLiveRuns,
    liveNode: LIVE_NODE,
    openProject: projectOf(0),
    ...(large === undefined ? {} : { large, smallRun: SMALL_SETTLED_RUN }),
    ...(relayed === undefined
      ? {}
      : { relayed: { run: RELAYED_RUN, ...relayed } }),
  };
}

// Recognised as run by comparing URLs, as `journal.ts` is: a path prefixed
// with `file://` is not how `import.meta.url` spells a Windows path or one
// with a character a URL escapes, and a corpus that was never written exits 0.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [root, scale = "host"] = process.argv.slice(2);
  if (
    root === undefined ||
    (scale !== "host" && scale !== "journey" && !scale.endsWith(".json"))
  ) {
    console.error("usage: corpus.mjs ROOT [host|journey|WORKLOAD.json]");
    process.exit(2);
  }
  console.log(JSON.stringify(buildLoadCorpus(root, scale)));
}
