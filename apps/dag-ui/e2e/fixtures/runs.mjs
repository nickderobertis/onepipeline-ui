/**
 * The recorded run directories the browser journeys are driven against.
 *
 * These are the files `onepipeline` itself records — a launch record, a plan, a
 * per-round plan and result, and the merged event store — so the server under test
 * reads them through the SDK exactly as it reads an operator's own runs. Nothing here
 * doubles the read API: it writes what an executor would have written and leaves the
 * projection entirely to the server.
 *
 * `serve-fixture.mjs` is the entry point; this module is only the corpus, so a journey
 * that changes what is being served (`settleDashboard`, `removeRun`, `growTranscript`)
 * appends to the same journals through the same writer the initial build used.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The in-flight run every graph, node and timeline journey opens. */
export const LIVE_RUN = "dag-ui-live";
/** A settled run, so the navigation has a second launching session to group. */
export const HISTORY_RUN = "dag-ui-history";
/** A settled round holding the outcomes only a finished round records. */
export const OUTCOMES_RUN = "dag-ui-outcomes";
/** A run whose result was recorded with no authoritative journal behind it. */
export const LEGACY_RUN = "dag-ui-legacy";
/** A second run of the *same* launching session as {@link LIVE_RUN}. */
export const SIBLING_RUN = "dag-ui-sibling";
/** A run with no launching session recorded at all. */
export const UNATTRIBUTED_RUN = "dag-ui-unattributed";
/** A run whose round is prepared and whose journal is still empty. */
export const EVENTLESS_RUN = "dag-ui-eventless";
/** One node whose recorded work is hundreds of dispatched sessions. */
export const BUSY_RUN = "dag-ui-busy";
/** How many of those sessions the busy node recorded. */
export const BUSY_SESSIONS = 200;
/** One of them ran long enough that its own turns are paged too. */
export const BUSY_LONG_SESSION = "0c9a1e77-1111-4222-8333-000000000007";
/** How many turns that one recorded. */
export const BUSY_LONG_TURNS = 30;
/** More than one API page of cheap records, so paging is the real cursor boundary. */
export const PAGE_RUNS = 44;

/** The change request the live run's first node published. */
export const FOUNDATION_PR = "https://example.invalid/changes/12";

/** The launching sessions behind the runs, never served raw. */
const CODEX_SESSION = "codex-top-session";
const CLAUDE_SESSION = "claude-code-top-session";

/** The agent-graph sessions the live run's dashboard node dispatched. */
export const WORKER_SESSION = "9e4b7d21-6a05-4c38-91df-2b6c4e0a7f18";
/** The session the run's first node's dispatch ran under. */
export const FOUNDATION_SESSION = "3f9a1c2e-0b77-4d21-9a6e-5c8f0a1b2c3d";
export const JUDGE_SESSION = "8a1d3c07-4b2f-4e55-91aa-6d3e2f0b7c14";
export const CHECK_IN_SESSION = "5d2e4f18-9c3a-4b66-82bb-7e4f3a1c8d25";
/** The run's own driving session, recorded at no node. */
export const ORCHESTRATOR_SESSION = "1b7c5a90-2d4e-4f11-93cc-8f5a2b0d9e36";

/** The verification log one node left behind, and one that was swept. */
export const GATE_ARTIFACT = "artifact-foundation-gate";
export const MISSING_ARTIFACT = "artifact-swept-gate";

/** The clock every recorded run but the live one is stamped from. */
const HISTORIC = Date.parse("2026-07-26T09:00:00.000Z");

const stamp = (millis) => new Date(millis).toISOString();

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** One launch record, in the shape the SDK's `LaunchRecord` deserializes. */
function launch(runId, launcher, session, startedAt, pid) {
  return {
    run_id: runId,
    plan: "plan.json",
    graph: "graphs/dag-scope.yaml",
    launcher,
    session,
    pid,
    // A pid recorded on another host means nothing here, which is what keeps the
    // liveness verdict off whichever machine happens to run the browser tier.
    host: "a-recording-host",
    started_at: startedAt,
    round_budget: 14400,
    heartbeat_interval: 1800,
    adoptions: 0,
  };
}

/**
 * A journal being written, one appended line at a time.
 *
 * The sequence is per stream and the merge order is `(ts, stream, seq)`, so a
 * journey that appends later events keeps counting from what the file already holds
 * rather than restarting and colliding with what it is extending.
 */
class Journal {
  constructor(dir, stream, startMillis) {
    this.path = join(dir, "events.jsonl");
    this.stream = stream;
    this.at = startMillis;
    this.lines = [];
  }

  /** Move the clock on before the next event, in seconds. */
  advance(seconds) {
    this.at += seconds * 1000;
    return this;
  }

  emit(source, kind, labels, payload = {}, artifacts = []) {
    this.lines.push(
      JSON.stringify({
        v: 1,
        ts: stamp(this.at),
        stream: this.stream,
        seq: this.lines.length,
        source,
        kind,
        labels,
        payload,
        artifacts,
      }),
    );
    return this;
  }

  write() {
    writeFileSync(this.path, `${this.lines.join("\n")}\n`);
  }
}

/** Append one event to a journal an already-running server is serving. */
function appendEvent(dir, source, kind, labels, payload = {}) {
  const path = join(dir, "events.jsonl");
  const existing = readFileSync(path, "utf8");
  const seq = existing.split("\n").filter(Boolean).length;
  const line = JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    stream: `a-recording-host-${labels.run_id}`,
    seq,
    source,
    kind,
    labels,
    payload,
    artifacts: [],
  });
  writeFileSync(path, `${existing}${line}\n`);
}

function runDir(root, runId) {
  const dir = join(root, runId);
  mkdirSync(join(dir, "round-01"), { recursive: true });
  return dir;
}

/**
 * The live run's plan: one node per renderable state and kind.
 *
 * `dashboard` names a prerequisite in another run — a cross-DAG reference the graph
 * accepts and has no node to draw to — and the three gates below the failure are
 * *derived* rather than recorded, which is the half of the read model a plan with only
 * settled nodes never exercises.
 */
const LIVE_TASKS = [
  {
    id: "foundation",
    persona: "worker",
    task: "## What\nPrepare the shared contracts.",
    done_when: "The contract tests pass",
    repo: "example/repo",
    branch: "feature/foundation",
    base_branch: "main",
    title: "Prepare shared contracts",
  },
  {
    id: "local-direct",
    persona: "worker",
    task: "## What\nPublish directly from a local-first workflow.",
    done_when: "The commit reaches main",
  },
  {
    id: "remote-open",
    persona: "worker",
    task: "## What\nPublish an open change request.",
    done_when: "The branch and change request are visible",
  },
  {
    id: "missing-artifact",
    persona: "worker",
    task: "## What\nInspect a no-longer-readable verification artifact.",
    done_when: "The missing artifact is stated honestly",
  },
  {
    id: "dashboard",
    persona: "worker",
    deps: ["foundation", `run:${HISTORY_RUN}#archive`],
    task: "## What\nBuild the live dashboard.",
    context: "the reviewer asked for a changelog entry",
    done_when: "Users can inspect transcripts",
    max_turns: 12,
    steps: [
      { id: "build", persona: "worker", task: "## What\nBuild and verify." },
      { id: "hand-over", kind: "human", task: "Hand the work over." },
    ],
  },
  {
    id: "publish",
    persona: "pr-author",
    deps: ["dashboard"],
    task: "## What\nPublish the dashboard.",
    done_when: "The release is reachable",
  },
  {
    id: "approval",
    kind: "human",
    deps: ["publish"],
    task: "Wait for release approval.",
  },
  {
    id: "queued",
    persona: "worker",
    deps: ["approval"],
    task: "## What\nStart the queued follow-up.",
    done_when: "The follow-up starts",
  },
  {
    id: "abandoned",
    persona: "worker",
    deps: ["publish"],
    task: "## What\nClean up after the publish.",
    done_when: "Cleanup runs",
  },
  {
    id: "followup",
    persona: "worker",
    deps: ["dashboard"],
    task: "## What\nFollow the dashboard up.",
    done_when: "The follow-up lands",
  },
  {
    id: "obsolete",
    persona: "worker",
    task: "## What\nRetire the obsolete work.",
    done_when: "The work is cancelled",
  },
];

const livePlan = () => ({
  schema_version: 1,
  goal: { text: "Observe the live DAG safely" },
  name: "observe-live-run",
  concurrency: 3,
  tasks: LIVE_TASKS,
});

/** One agent-graph turn, as the merged store relays one. */
function turn(journal, node, session, persona, message, model = "a-model") {
  journal.emit(
    "agentgraph",
    "agent-turn",
    {
      run_id: journal.runId,
      round: 1,
      node,
      persona,
      session,
    },
    { message, model },
  );
}

function writeLiveRun(root) {
  const dir = runDir(root, LIVE_RUN);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  const plan = livePlan();
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);

  // Stamped from the wall clock: the graph timeline plots the whole run on one
  // range, and a run pinned to a fixed calendar date stretches that range across the
  // days between it and now, collapsing every node to a hairline at one edge.
  const start = Date.now() - 8 * 60 * 1000;
  writeJson(
    join(dir, "launch.json"),
    launch(LIVE_RUN, "codex", CODEX_SESSION, stamp(start), 4242),
  );

  const journal = new Journal(dir, `a-recording-host-${LIVE_RUN}`, start);
  journal.runId = LIVE_RUN;
  const run = { run_id: LIVE_RUN };
  const round = { run_id: LIVE_RUN, round: 1 };
  journal.emit("pipeline", "run-started", run, { plan });
  journal.advance(1).emit("pipeline", "round-started", round, { plan });

  // The run's own driving session, opened before the first node was dispatched: it
  // is what starts the run, so it is the launch the whole plot is measured from.
  journal.advance(1);
  turn(
    journal,
    undefined,
    ORCHESTRATOR_SESSION,
    "orchestrator",
    "Coordinating the execution frontier",
  );

  journal.advance(4).emit("pipeline", "node-dispatched", {
    ...round,
    node: "foundation",
    persona: "worker",
  });
  journal.advance(2);
  turn(journal, "foundation", FOUNDATION_SESSION, "worker", "Landed the route table");
  journal.advance(20).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "foundation" },
    {
      status: "done",
      outcome: "merged",
      branch: "feature/foundation",
      change_url: FOUNDATION_PR,
      detail: "Gate completed successfully",
    },
    [{ id: GATE_ARTIFACT, kind: "log", bytes: 4096 }],
  );

  for (const [node, outcome, url] of [
    ["local-direct", "merged", undefined],
    ["remote-open", "published", "https://example.invalid/changes/13"],
  ]) {
    journal.advance(1).emit("pipeline", "node-dispatched", {
      ...round,
      node,
      persona: "worker",
    });
    journal.advance(3).emit(
      "pipeline",
      "node-settled",
      { ...round, node },
      {
        status: "done",
        outcome,
        branch: `feature/${node}`,
        ...(url === undefined ? {} : { change_url: url }),
      },
    );
  }

  // A verification whose log the run recorded and something later swept: the id is
  // in the journal, and reading it finds nothing.
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "missing-artifact",
    persona: "worker",
  });
  journal.advance(3).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "missing-artifact" },
    { status: "failed", detail: "the verification log was removed" },
    [{ id: MISSING_ARTIFACT, kind: "log", bytes: 24 }],
  );

  // The node every transcript journey opens: still running, with one session per
  // attributed role, and a step of its own that finished.
  journal.advance(2).emit("pipeline", "node-dispatched", {
    ...round,
    node: "dashboard",
    persona: "worker",
  });
  journal.advance(5);
  for (const [session, persona, message] of [
    [WORKER_SESSION, "worker", "Implementing the dashboard now"],
    [JUDGE_SESSION, "judge", "The transcript is accessible"],
    [CHECK_IN_SESSION, "check-in", "Progress update sent"],
  ]) {
    journal.emit(
      "agentgraph",
      "agent-turn",
      { ...round, node: "dashboard", persona, session },
      { message, model: "a-model" },
    );
    journal.advance(25);
  }

  journal.emit("pipeline", "node-dispatched", {
    ...round,
    node: "publish",
    persona: "pr-author",
  });
  journal.advance(4).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "publish" },
    { status: "failed", outcome: "gate-failed", detail: "The deploy failed" },
  );
  // Waiting on a person: real recorded time, which the node timeline draws as its
  // own span rather than as silence.
  journal.advance(1).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "approval" },
    { status: "waiting" },
  );
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "obsolete",
    persona: "worker",
  });
  journal.advance(1).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "obsolete" },
    { status: "cancelled", detail: "Cancelled cooperatively" },
  );
  journal.write();

  writeFileSync(
    join(dir, "artifacts", GATE_ARTIFACT),
    `oldest verification output\n${"full verification output\n".repeat(220)}pre-push verification passed\n`,
  );
  return dir;
}

/** One settled run, so the navigation has a second launching session to group. */
function writeHistoryRun(root) {
  const dir = runDir(root, HISTORY_RUN);
  const plan = {
    schema_version: 1,
    goal: { text: "Archive the release" },
    name: "archive",
    concurrency: 1,
    tasks: [
      {
        id: "archive",
        persona: "worker",
        task: "## What\nArchive the release.",
        done_when: "The archive exists",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(
      HISTORY_RUN,
      "claude-code",
      CLAUDE_SESSION,
      stamp(HISTORIC),
      4243,
    ),
  );
  writeJson(join(dir, "round-01", "result.json"), {
    run_id: HISTORY_RUN,
    round: 1,
    state: "complete",
    ok: true,
    nodes: [{ id: "archive", status: "done", outcome: "merged" }],
  });
  const journal = new Journal(dir, `a-recording-host-${HISTORY_RUN}`, HISTORIC);
  const round = { run_id: HISTORY_RUN, round: 1 };
  journal.emit("pipeline", "run-started", { run_id: HISTORY_RUN }, { plan });
  journal.advance(1).emit("pipeline", "round-started", round, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "archive",
    persona: "worker",
  });
  journal.advance(2);
  journal.emit(
    "agentgraph",
    "agent-turn",
    { ...round, node: "archive", persona: "worker", session: JUDGE_SESSION },
    { message: "Archived the release", model: "a-model" },
  );
  journal.advance(4).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "archive" },
    { status: "done", outcome: "merged" },
  );
  journal.advance(1).emit("pipeline", "round-finished", round, {
    state: "complete",
    ok: true,
  });
  journal.write();
}

/**
 * One settled round holding the outcomes a live round cannot journal.
 *
 * A round's own result is the only account of it that survives the next round
 * starting, so a status recorded there — and never journalled as a settlement — is
 * how a client meets `not-completed`, a word outside the served vocabulary, and a
 * failure with nothing recorded about why.
 */
function writeOutcomesRun(root) {
  const dir = runDir(root, OUTCOMES_RUN);
  const ids = ["migrate", "backfill", "verify", "rollback", "retry"];
  const plan = {
    schema_version: 1,
    goal: { text: "Migrate the store" },
    name: "migrate",
    concurrency: 3,
    tasks: ids.map((id) => ({
      id,
      persona: "worker",
      task: `## What\n${id[0].toUpperCase()}${id.slice(1)} the store.`,
      done_when: "The store is migrated",
    })),
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(OUTCOMES_RUN, "claude-code", CLAUDE_SESSION, stamp(HISTORIC), 4244),
  );
  writeJson(join(dir, "round-01", "result.json"), {
    run_id: OUTCOMES_RUN,
    round: 1,
    state: "failed",
    ok: false,
    nodes: [
      { id: "migrate", status: "failed" },
      { id: "backfill", status: "not-completed", detail: "step 'load' timed out" },
      { id: "verify", status: "improvised" },
      { id: "rollback", status: "failed", outcome: "gate-failed" },
      { id: "retry", status: "failed", detail: "the gate rejected the push" },
    ],
  });
  const journal = new Journal(dir, `a-recording-host-${OUTCOMES_RUN}`, HISTORIC);
  const round = { run_id: OUTCOMES_RUN, round: 1 };
  journal.emit("pipeline", "run-started", { run_id: OUTCOMES_RUN }, { plan });
  journal.advance(1).emit("pipeline", "round-started", round, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "migrate",
    persona: "worker",
  });
  journal.advance(2).emit(
    "pipeline",
    "node-settled",
    { ...round, node: "migrate" },
    { status: "failed" },
  );
  journal.advance(1).emit("pipeline", "round-finished", round, {
    state: "failed",
    ok: false,
  });
  journal.write();
}

/**
 * A recorded result with no authoritative journal behind it at all.
 *
 * This is what a run predating the journal looks like on an operator's machine,
 * permanently: there is nothing to fold, so the run list has only the round's own
 * result to count, and its statuses are words the served vocabulary never closed.
 */
function writeLegacyRun(root) {
  const dir = runDir(root, LEGACY_RUN);
  const plan = {
    schema_version: 1,
    goal: { text: "Convert the legacy store" },
    name: "convert",
    concurrency: 1,
    tasks: [
      {
        id: "convert",
        persona: "worker",
        task: "## What\nConvert the legacy store.",
        done_when: "The store is converted",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(LEGACY_RUN, "claude-code", CLAUDE_SESSION, stamp(HISTORIC), 4245),
  );
  writeJson(join(dir, "round-01", "result.json"), {
    run_id: LEGACY_RUN,
    round: 1,
    state: "complete",
    ok: true,
    nodes: [{ id: "convert", status: "improvised" }],
  });
  writeFileSync(join(dir, "events.jsonl"), "");
}

/** A second run under the live run's launching session, whose driver then stopped. */
function writeSiblingRun(root) {
  const dir = runDir(root, SIBLING_RUN);
  const plan = {
    schema_version: 1,
    goal: { text: "Run beside the dashboard work" },
    name: "sibling",
    concurrency: 1,
    tasks: [
      {
        id: "sibling",
        persona: "worker",
        task: "## What\nRun beside the dashboard work.",
        done_when: "The sibling settles",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(SIBLING_RUN, "codex", CODEX_SESSION, stamp(HISTORIC), 4246),
  );
  const journal = new Journal(dir, `a-recording-host-${SIBLING_RUN}`, HISTORIC);
  const round = { run_id: SIBLING_RUN, round: 1 };
  journal.emit("pipeline", "run-started", { run_id: SIBLING_RUN }, { plan });
  journal.advance(1).emit("pipeline", "round-started", round, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "sibling",
    persona: "worker",
  });
  // Ended any way but by finishing: the run reads back stopped, which is the one
  // state here outside the vocabulary the UI gives a meaning to.
  journal.advance(2).emit("pipeline", "run-stopped", { run_id: SIBLING_RUN });
  journal.write();
}

/** One run with no launching session recorded, as every swept launch reads. */
function writeUnattributedRun(root) {
  const dir = runDir(root, UNATTRIBUTED_RUN);
  const plan = {
    schema_version: 1,
    goal: { text: "Continue unattributed work" },
    name: "orphan",
    concurrency: 1,
    tasks: [
      {
        id: "orphan",
        persona: "worker",
        task: "## What\nContinue the unattributed work.",
        done_when: "The work continues",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    // The empty session is what the SDK records when nothing named the launcher, and
    // a launcher outside the closed vocabulary a client switches on.
    launch(UNATTRIBUTED_RUN, "a-plain-shell", "", stamp(HISTORIC), 4247),
  );
  const journal = new Journal(
    dir,
    `a-recording-host-${UNATTRIBUTED_RUN}`,
    HISTORIC,
  );
  const round = { run_id: UNATTRIBUTED_RUN, round: 1 };
  journal.emit("pipeline", "run-started", { run_id: UNATTRIBUTED_RUN }, { plan });
  journal.advance(1).emit("pipeline", "round-started", round, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "orphan",
    persona: "worker",
  });
  journal.write();
}

/**
 * One run whose launch is recorded and whose journal is still empty.
 *
 * The read API serves it with a null `last_event` and no round at all. It has to
 * stay in the navigation beside the runs that do have events: the client validates
 * the run list in one parse, so a run this shape either renders with the rest or
 * takes every one of them down with it.
 */
function writeEventlessRun(root, runId = EVENTLESS_RUN) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeJson(
    join(dir, "launch.json"),
    launch(runId, "codex", CODEX_SESSION, stamp(HISTORIC), 4248),
  );
  writeFileSync(join(dir, "events.jsonl"), "");
}

/**
 * One in-flight node whose recorded work is hundreds of dispatched sessions.
 *
 * This is the shape the node view exists for: a real node records far more sessions
 * than a reader can scan, so the rail has to group them rather than list one row per
 * conversation.
 */
function writeBusyRun(root) {
  const dir = runDir(root, BUSY_RUN);
  const plan = {
    schema_version: 1,
    goal: { text: "Work a node that dispatches many sessions" },
    name: "sweep",
    concurrency: 1,
    tasks: [
      {
        id: "sweep",
        persona: "worker",
        task: "## What\nWork a node that dispatches many sessions.",
        done_when: "Every session settles",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(join(dir, "round-01", "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(BUSY_RUN, "codex", CODEX_SESSION, stamp(HISTORIC), 4249),
  );
  const journal = new Journal(dir, `a-recording-host-${BUSY_RUN}`, HISTORIC);
  const round = { run_id: BUSY_RUN, round: 1 };
  journal.emit("pipeline", "run-started", { run_id: BUSY_RUN }, { plan });
  journal.advance(1).emit("pipeline", "round-started", round, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...round,
    node: "sweep",
    persona: "worker",
  });
  for (let index = 0; index < BUSY_SESSIONS; index += 1) {
    // Session ids are the conversation identifiers the read API validates, so they
    // are minted in that shape rather than as arbitrary names.
    const session = `0c9a1e77-1111-4222-8333-${String(index).padStart(12, "0")}`;
    const turns = session === BUSY_LONG_SESSION ? BUSY_LONG_TURNS : 1;
    for (let step = 0; step < turns; step += 1) {
      journal.advance(1).emit(
        "agentgraph",
        "agent-turn",
        { ...round, node: "sweep", persona: "worker", session },
        { message: `Swept batch ${index}`, model: "a-model" },
      );
    }
  }
  journal.write();
}

/** Write every run this fixture serves, oldest first. */
export function buildRuns(root) {
  mkdirSync(root, { recursive: true });
  writeEventlessRun(root);
  for (let index = 0; index < PAGE_RUNS; index += 1) {
    writeEventlessRun(root, `dag-ui-page-${String(index).padStart(2, "0")}`);
  }
  writeBusyRun(root);
  writeUnattributedRun(root);
  writeHistoryRun(root);
  writeOutcomesRun(root);
  writeLegacyRun(root);
  writeSiblingRun(root);
  writeLiveRun(root);
}

/** Everything the fixture wrote, published beside the runs it serves. */
export function facts() {
  return {
    runs: {
      live: LIVE_RUN,
      history: HISTORY_RUN,
      outcomes: OUTCOMES_RUN,
      legacy: LEGACY_RUN,
      sibling: SIBLING_RUN,
      unattributed: UNATTRIBUTED_RUN,
      eventless: EVENTLESS_RUN,
      busy: BUSY_RUN,
    },
    foundation_pr: FOUNDATION_PR,
    sessions: {
      worker: WORKER_SESSION,
      foundation: FOUNDATION_SESSION,
      judge: JUDGE_SESSION,
      check_in: CHECK_IN_SESSION,
      orchestrator: ORCHESTRATOR_SESSION,
    },
    artifacts: { gate: GATE_ARTIFACT, missing: MISSING_ARTIFACT },
  };
}

/**
 * Record real progress on the served live run, so the stream invalidates it.
 *
 * A journey calls this to change the state the server projects, exactly as a running
 * executor would: one appended authoritative event, no reaching into the server or
 * the client.
 */
export function settleDashboard(root) {
  appendEvent(
    join(root, LIVE_RUN),
    "pipeline",
    "node-settled",
    { run_id: LIVE_RUN, round: 1, node: "dashboard" },
    { status: "done", outcome: "merged", detail: "Dashboard shipped" },
  );
}

/** Record turns onto the live dashboard's worker session until it has `turns`. */
export function growTranscript(root, turns) {
  const dir = join(root, LIVE_RUN);
  const recorded = readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((line) => JSON.parse(line).labels?.session === WORKER_SESSION).length;
  for (let index = recorded; index < turns; index += 1) {
    appendEvent(
      dir,
      "agentgraph",
      "agent-turn",
      {
        run_id: LIVE_RUN,
        round: 1,
        node: "dashboard",
        persona: "worker",
        session: WORKER_SESSION,
      },
      { message: `Dashboard turn ${index} arrived`, model: "a-model" },
    );
  }
}

/**
 * Take one recorded run out of the served root, as a sweep or an operator does.
 *
 * The identifier reaches a recursive delete, so it is validated the way the read API
 * validates one and the resolved target must still sit directly beneath the root — a
 * command line is an untrusted boundary even in a fixture.
 */
export function removeRun(root, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`serve-fixture: '${runId}' is not a usable run id`);
  }
  rmSync(join(root, runId), { recursive: true, force: true });
}

/** Remove the synthetic pagination rows, leaving the named journeys intact. */
export function removePageRuns(root) {
  for (let index = 0; index < PAGE_RUNS; index += 1) {
    rmSync(join(root, `dag-ui-page-${String(index).padStart(2, "0")}`), {
      recursive: true,
      force: true,
    });
  }
}
