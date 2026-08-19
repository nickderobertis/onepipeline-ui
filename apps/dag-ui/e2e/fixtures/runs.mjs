/**
 * The recorded run directories the browser journeys are driven against.
 *
 * These are the files `onepipeline` itself records — a launch record, a plan, the
 * run's own recorded result, and the merged event store — so the server under test
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
/** A settled run holding the outcomes only a recorded result carries. */
export const OUTCOMES_RUN = "dag-ui-outcomes";
/** A run whose result was recorded with no authoritative journal behind it. */
export const LEGACY_RUN = "dag-ui-legacy";
/** A second run of the *same* launching session as {@link LIVE_RUN}. */
export const SIBLING_RUN = "dag-ui-sibling";
/** A run with no launching session recorded at all. */
export const UNATTRIBUTED_RUN = "dag-ui-unattributed";
/** A run whose plan is written and whose journal is still empty. */
export const EVENTLESS_RUN = "dag-ui-eventless";
/** One node whose recorded work is hundreds of dispatched sessions. */
export const BUSY_RUN = "dag-ui-busy";
/** How many of those sessions the busy node recorded. */
export const BUSY_SESSIONS = 200;
/** One of them ran long enough that its own turns are paged too. */
export const BUSY_LONG_SESSION = "engineer-sweep-7";
/** How many turns that one recorded. */
export const BUSY_LONG_TURNS = 30;
/** More than one API page of cheap records, so paging is the real cursor boundary. */
export const PAGE_RUNS = 44;

/** The change request the live run's first node published. */
export const FOUNDATION_PR = "https://example.invalid/changes/12";
/** The commit it merged as. No url beside it: the host owns that and records none. */
export const FOUNDATION_COMMIT = "5f3c8a1204e7b96d3fa8c05e17d2b649a08c7e31";
/** The change request the node behind the host's checks left open. */
export const REMOTE_OPEN_PR = "https://example.invalid/changes/13";
/** The identity every publication of this fixture queues on. */
const IDENTITY = "github.com/example/repo";
/** The command `onevcs` records for the gate that is git's own hook. */
const PRE_PUSH_COMMAND = "the repository's pre-push hook";

/** The launching sessions behind the runs, never served raw. */
const CODEX_SESSION = "codex-top-session";
const CLAUDE_SESSION = "claude-code-top-session";

/** The agent-graph sessions the live run's dashboard node dispatched. */
export const WORKER_SESSION = "engineer-dashboard";
/** The session the run's first node's dispatch ran under. */
export const FOUNDATION_SESSION = "3f9a1c2e-0b77-4d21-9a6e-5c8f0a1b2c3d";
export const JUDGE_SESSION = "you-are-a-strict-careful-evaluator";
/** The lint member's session: the worker's own role under another transport. */
export const LINT_SESSION = "llmlint-dashboard";
export const CHECK_IN_SESSION = "5d2e4f18-9c3a-4b66-82bb-7e4f3a1c8d25";
/** The run's own driving session, recorded at no node. */
export const ORCHESTRATOR_SESSION = "1b7c5a90-2d4e-4f11-93cc-8f5a2b0d9e36";
/** The run's own check-in, recorded beside it at no node either. */
export const RUN_CHECK_IN_SESSION = "9f2a6b31-7c48-4d09-a5ee-3b1d8e6f4a52";
/** The session the node with no out-of-band turn control is talking in. */
export const ORPHAN_SESSION = "4d0f6b32-8c15-4a09-b2ee-7f1c3d5a6e28";

/**
 * The two planner notes the live run carries, and what the run made of each.
 *
 * The words are the producing libraries' own: `oneagentgraph` writes the reason a
 * delivery did not land onto the `turn-interrupted` it publishes for every attempt,
 * and `onepipeline` records where the note actually went as the `delivery` on the
 * `context-added` operation its `edit-committed` compiled.
 */
export const LIVE_NOTE = "check the transcript pane at phone width too";
export const DEFERRED_NOTE = "measure the cold start too";
export const NO_CONTROL_REASON =
  "the member's run has no out-of-band turn control to serve the request";

/** The verification log one node left behind, and one that was swept. */
export const GATE_ARTIFACT = "artifact-foundation-gate";
export const MISSING_ARTIFACT = "artifact-swept-gate";
/** The pre-push hook's own log, and the log the host's failing check stored. */
export const HOOK_ARTIFACT = "artifact-remote-open-hook";
export const CHECK_ARTIFACT = "artifact-published-smoke";
/**
 * The report the foundation node's member settled with.
 *
 * `oneagentgraph` records exactly one artifact on a `member-settled`, named for
 * its own stream — and the id is all it names: the file the run keeps is derived
 * from the settlement's stream *and* its sequence, which is why the reader
 * derives it from the envelope rather than from this.
 */
export const REPORT_ARTIFACT = "report-a-recording-host-dag-ui-live";
/**
 * A settlement whose report this run kept no copy of.
 *
 * `retain` refuses a report that is a symlink, is not a plain file, is misnamed,
 * or is past its size bound, and it refuses it as the settlement is ingested — so
 * the record still names an artifact and there is no file behind it. Named for
 * the member rather than for a stream, because this fixture writes one merged
 * stream where a real run has one per producing process.
 */
export const UNRETAINED_REPORT = "report-missing-artifact-worker";

/**
 * The oneharness invocation the dashboard node's worker made, and the record it
 * left in oneharness's own history store.
 *
 * The one artifact whose bytes are *not* under the run: `oneagentgraph` publishes
 * a pointer at the store and nothing is copied, so serving it is the read API
 * opening a file this fixture wrote somewhere else entirely. The id is the
 * history record's own, which is what the pointer names it by.
 */
export const HARNESS_SESSION_ARTIFACT = "01a00d0f-c094-7660-b26c-8a53baaf9c3b";
/** What that conversation ended on, which is what an operator opens it to read. */
export const HARNESS_SESSION_TEXT =
  "wired the dashboard to the read API and left the rail alone";
/** The project layer of the store, as oneharness slugs a project directory. */
const HARNESS_PROJECT = "tmp-dag-ui-e2e-project";
/** The session file inside it, as oneharness names one: name, instant, pid. */
const HARNESS_SESSION_FILE = "engineer-dashboard-20260817T001158Z-3163805";

/**
 * One oneharness history record, in the line format that library writes.
 *
 * This is the second place in the repository that spells another crate's file
 * format, and for the same reason `retainReport` above spells the first: a
 * `.mjs` fixture cannot link the crate that owns it. What holds the two together
 * is the Rust side — `tests/support/harness_history.rs` writes this store through
 * `oneharness_core`'s own `HistoryWriter` and `tests/e2e/server.rs` reads it back
 * through the served route — plus the journey below, which stops finding this
 * conversation the moment either side moves.
 */
function harnessSessionRecord() {
  return `${JSON.stringify({
    type: "run",
    schema_version: "1.1",
    history_id: HARNESS_SESSION_ARTIFACT,
    session: HARNESS_SESSION_FILE,
    name: "engineer-dashboard",
    project: "/tmp/dag-ui-e2e/project",
    timestamp: "2026-08-17T00:11:58Z",
    harness: "claude-code",
    variant: "alternate",
    harness_id: "claude-code:alternate",
    model: "a-model",
    prompt: "wire the dashboard to the read API",
    permission_mode: "default",
    status: "ok",
    exit_code: 0,
    duration_ms: 4200,
    finished_at: null,
    text: HARNESS_SESSION_TEXT,
    text_source: "json:result",
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_tokens: 800,
      cache_write_tokens: 120,
      cost_usd: 0.42,
    },
    session_id: "54e7ad34-ce6d-4979-8b4d-531b88026e15",
    failure_kind: null,
  })}\n`;
}

/**
 * Write that store beside the runs root rather than inside it.
 *
 * Beside, because that is where it really is: oneharness keeps its history under
 * the operator's own state directory and no run owns it. Returning the directory
 * is what lets the pointer name it — the reader takes the store from the record
 * and has no configuration of its own for it.
 */
function writeHarnessHistory(root) {
  const dir = join(root, "..", "oneharness-history");
  mkdirSync(join(dir, HARNESS_PROJECT), { recursive: true });
  const path = join(dir, HARNESS_PROJECT, `${HARNESS_SESSION_FILE}.jsonl`);
  writeFileSync(path, harnessSessionRecord());
  return { dir, bytes: readFileSync(path).length };
}

/**
 * That report, as onejudge writes one: a ruling per acceptance criterion, the
 * follow-ups the worker surfaced, and why the member stopped.
 *
 * Longer than one screen on purpose — a real one is a transcript's worth of
 * verdicts — so the panel's bounded reading and the control that opens the rest
 * are driven by a document that really needs them.
 */
const FOUNDATION_REPORT = `${JSON.stringify(
  {
    schema_version: 8,
    control: null,
    verdicts: [
      {
        criterion: "the shared contracts are published",
        met: true,
        reason: "the earliest ruling this report recorded",
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        criterion: `the route table answers request ${index}`,
        met: true,
        reason: "the contract tests cover it end to end",
      })),
      {
        criterion: "the follow-ups are surfaced",
        met: true,
        reason: "the last ruling this report recorded",
      },
    ],
    follow_ups: ["the gate logs onevcs stores are retained by nothing"],
    stopped_because: "every acceptance criterion was met",
  },
  null,
  2,
)}\n`;

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

/**
 * The run's own copy of one settlement's report, where the engine keeps it.
 *
 * `onepipeline` copies a member's report into the run as it ingests the
 * settlement and derives the name from that envelope — its stream and its
 * sequence — which is `RunPaths::report_for`, and the same derivation the read
 * API resolves the artifact through. This is the one place in the repository
 * that spells it, because a `.mjs` fixture cannot link the crate that owns it:
 * what holds the two sides together is the Rust round trip in
 * `tests/e2e/server.rs`, which writes through the published `report::retain` and
 * reads back through the served route, and the journey below, which stops
 * finding this report the moment either side moves.
 */
function retainReport(dir, stream, seq, report) {
  mkdirSync(join(dir, "reports"), { recursive: true });
  writeFileSync(join(dir, "reports", `${stream}-${seq}.json`), report);
}

function runDir(root, runId) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
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
    task: "## What\nPrepare the shared contracts.\n\n## Acceptance criteria\nThe contract tests pass",
    repo: "example/repo",
    branch: "feature/foundation",
    base_branch: "main",
    title: "Prepare shared contracts",
    steps: [
      { id: "build", persona: "worker", task: "## What\nBuild and verify." },
      { id: "hand-over", kind: "human", task: "Hand the work over." },
    ],
  },
  {
    id: "local-direct",
    persona: "worker",
    task: "## What\nPublish directly from a local-first workflow.\n\n## Acceptance criteria\nThe commit reaches main",
  },
  {
    id: "remote-open",
    persona: "worker",
    task: "## What\nPublish an open change request.\n\n## Acceptance criteria\nThe branch and change request are visible",
  },
  {
    id: "missing-artifact",
    persona: "worker",
    task: "## What\nInspect a no-longer-readable verification artifact.\n\n## Acceptance criteria\nThe missing artifact is stated honestly",
  },
  {
    id: "dashboard",
    persona: "worker",
    deps: ["foundation", `run:${HISTORY_RUN}#archive`],
    task: "## What\nBuild the live dashboard.\n\n## Acceptance criteria\nUsers can inspect transcripts",
    context: "the reviewer asked for a changelog entry",
    max_turns: 12,
  },
  {
    id: "publish",
    persona: "pr-author",
    deps: ["dashboard"],
    task: "## What\nPublish the dashboard.\n\n## Acceptance criteria\nThe release is reachable",
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
    task: "## What\nStart the queued follow-up.\n\n## Acceptance criteria\nThe follow-up starts",
  },
  {
    id: "abandoned",
    persona: "worker",
    deps: ["publish"],
    task: "## What\nClean up after the publish.\n\n## Acceptance criteria\nCleanup runs",
  },
  {
    id: "followup",
    persona: "worker",
    deps: ["dashboard"],
    task: "## What\nFollow the dashboard up.\n\n## Acceptance criteria\nThe follow-up lands",
  },
  {
    id: "obsolete",
    persona: "worker",
    task: "## What\nRetire the obsolete work.\n\n## Acceptance criteria\nThe work is cancelled",
  },
];

const livePlan = () => ({
  schema_version: 2,
  goal: { text: "Observe the live DAG safely" },
  name: "observe-live-run",
  concurrency: 3,
  tasks: LIVE_TASKS,
});

/** One agent-graph turn, as the merged store relays one. */
function turn(journal, node, session, persona, message, model = "a-model") {
  journal.emit(
    "agentgraph",
    "turn-started",
    {
      run_id: journal.runId,
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
  // The oneharness store this run's worker wrote its conversation into. Outside
  // the run, and named by the record rather than by any setting of this server's.
  const harnessHistory = writeHarnessHistory(root);
  const plan = livePlan();
  writeJson(join(dir, "plan.json"), plan);

  // Stamped from the wall clock: the graph timeline plots the whole run on one
  // range, and a run pinned to a fixed calendar date stretches that range across the
  // days between it and now, collapsing every node to a hairline at one edge. Close
  // enough to now that the plotted range is mostly the run: it ends at the server's
  // `observed_at`, so dead time before the read is dead width every segment in every
  // row is squeezed into.
  const start = Date.now() - 3 * 60 * 1000;
  writeJson(
    join(dir, "launch.json"),
    launch(LIVE_RUN, "codex", CODEX_SESSION, stamp(start), 4242),
  );

  const journal = new Journal(dir, `a-recording-host-${LIVE_RUN}`, start);
  journal.runId = LIVE_RUN;
  const run = { run_id: LIVE_RUN };
  journal.emit("pipeline", "run-started", run, { plan });

  // The run's own driving session, opened well after the run started and before
  // the first node was dispatched: the stretch before it is silence the plot has to
  // draw, and a hairline of it is a segment nobody can read or reach.
  journal.advance(12);
  turn(
    journal,
    undefined,
    ORCHESTRATOR_SESSION,
    "orchestrator",
    "Coordinating the execution frontier",
  );
  journal.advance(4).emit("pipeline", "node-dispatched", {
    ...run,
    node: "foundation",
    persona: "worker",
  });
  // The branch this node worked on, opened and landed by `onevcs` and relayed into
  // the merged store under that library's own vocabulary — the kinds it really
  // emits, which are the recorded ends the server draws the publication between.
  journal.advance(1).emit(
    "vcs",
    "session-opened",
    { ...run, node: "foundation" },
    {
      token: "a-vcs-session-token",
      identity: IDENTITY,
      branch: "feature/foundation",
      base: "main",
      worktree: "/a/recorded/worktree",
    },
  );
  journal.advance(1);
  turn(
    journal,
    "foundation",
    FOUNDATION_SESSION,
    "worker",
    "Landed the route table",
  );
  journal
    .advance(4)
    .emit(
      "vcs",
      "push",
      { ...run, node: "foundation" },
      { branch: "feature/foundation", remote: "origin", accepted: true },
    );
  journal.advance(1).emit(
    "vcs",
    "change-opened",
    { ...run, node: "foundation" },
    {
      url: FOUNDATION_PR,
      host: "github",
      id: "12",
      base: "main",
      author: "a-recording-host",
    },
  );
  journal
    .advance(1)
    .emit(
      "vcs",
      "change-merged",
      { ...run, node: "foundation" },
      { url: FOUNDATION_PR, sha: FOUNDATION_COMMIT },
    );
  journal.emit(
    "vcs",
    "merge-completed",
    { ...run, node: "foundation" },
    { identity: IDENTITY, sha: FOUNDATION_COMMIT, base: "main" },
  );
  // The member behind this node, settling with the report it wrote. Its sequence
  // is taken before the line is written because that is half of what names the
  // run's own copy of the report — see `retainReport`.
  const settled = journal.advance(2).lines.length;
  journal.emit(
    "agentgraph",
    "member-settled",
    { ...run, node: "foundation", member: "worker", persona: "worker" },
    {
      completed: true,
      verdict: [],
      completion_reason: null,
      // The producing library's own scratch. Displayed by nothing and opened by
      // nobody: the engine copied the document into this run as it ingested the
      // settlement, and every reader afterwards opens only that copy.
      report_path: "/a/producing/librarys/scratch/report.json",
    },
    [
      {
        id: REPORT_ARTIFACT,
        kind: "report",
        bytes: FOUNDATION_REPORT.length,
      },
    ],
  );
  journal.advance(14).emit(
    "pipeline",
    "node-settled",
    { ...run, node: "foundation" },
    {
      status: "done",
      outcome: "merged",
      branch: "feature/foundation",
      change_url: FOUNDATION_PR,
      detail: "Gate completed successfully",
    },
    [{ id: GATE_ARTIFACT, kind: "log", bytes: 4096 }],
  );

  // Merged straight from a local workflow: no change was ever opened, so nothing
  // observed a check on it and the panel has to say so.
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "local-direct",
    persona: "worker",
  });
  journal
    .advance(3)
    .emit(
      "pipeline",
      "node-settled",
      { ...run, node: "local-direct" },
      { status: "done", outcome: "merged", branch: "feature/local-direct" },
    );

  // The publication the operator's own bar is read from: the repository's pre-push
  // hook ran, the host is running the checks branch protection requires, and the
  // change is still open behind them. Every record here is one `onevcs` emits.
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "remote-open",
    persona: "worker",
  });
  journal.advance(1).emit(
    "vcs",
    "session-opened",
    { ...run, node: "remote-open" },
    {
      token: "a-second-vcs-session-token",
      identity: IDENTITY,
      branch: "feature/remote-open",
      base: "main",
      worktree: "/a/recorded/worktree",
    },
  );
  journal.advance(1).emit(
    "vcs",
    "gate-started",
    { ...run, node: "remote-open" },
    {
      command: PRE_PUSH_COMMAND,
      comparison_remote: "origin",
      comparison_base: "main",
    },
  );
  journal.advance(2).emit(
    "vcs",
    "gate-verdict",
    { ...run, node: "remote-open" },
    {
      verdict: "pass",
      command: PRE_PUSH_COMMAND,
      output: "the pre-push hook accepted the branch",
      preserved_log: "/a/recorded/clone/pre-push.log",
    },
    [{ id: HOOK_ARTIFACT, kind: "log", bytes: 41 }],
  );
  journal
    .advance(1)
    .emit(
      "vcs",
      "push",
      { ...run, node: "remote-open" },
      { branch: "feature/remote-open", remote: "origin", accepted: true },
    );
  journal.advance(1).emit(
    "vcs",
    "change-opened",
    { ...run, node: "remote-open" },
    {
      url: REMOTE_OPEN_PR,
      host: "github",
      id: "13",
      base: "main",
      author: "a-recording-host",
    },
  );
  // Every transition of every check, which is what waiting on a host looks like:
  // one required check green, one still running, and an advisory one red with the
  // log that says why.
  for (const [name, required, from, status, conclusion, log] of [
    ["gate", true, null, "queued", null, undefined],
    ["gate", true, "queued", "completed", "success", undefined],
    [
      "published-smoke",
      false,
      "in_progress",
      "completed",
      "failure",
      CHECK_ARTIFACT,
    ],
    ["e2e", true, "queued", "in_progress", null, undefined],
  ]) {
    journal
      .advance(1)
      .emit(
        "vcs",
        "change-check",
        { ...run, node: "remote-open" },
        { name, required, status, from_status: from, conclusion },
        log === undefined ? [] : [{ id: log, kind: "log", bytes: 33 }],
      );
  }
  // The contention the merge queue met, timed by `onevcs` itself: thousands of
  // these is the normal shape, which is why the reading is a summary.
  for (const [waited, position] of [
    [1.5, 1],
    [3.25, 2],
    [7.5, 3],
  ]) {
    journal
      .advance(2)
      .emit(
        "vcs",
        "lock-wait",
        { ...run, node: "remote-open" },
        { identity: IDENTITY, elapsed: waited, queue_position: position },
      );
  }
  journal.advance(1).emit(
    "pipeline",
    "node-settled",
    { ...run, node: "remote-open" },
    {
      status: "done",
      outcome: "published",
      branch: "feature/remote-open",
      change_url: REMOTE_OPEN_PR,
    },
  );

  // A verification whose log the run recorded and something later swept: the id is
  // in the journal, and reading it finds nothing.
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "missing-artifact",
    persona: "worker",
  });
  // And a member whose report the engine refused to retain, so the settlement
  // names a report the run holds no copy of. Nothing is written for it here,
  // which is exactly what that state is on disk.
  journal.advance(1).emit(
    "agentgraph",
    "member-settled",
    {
      ...run,
      node: "missing-artifact",
      member: "worker",
      persona: "worker",
    },
    {
      completed: true,
      verdict: [],
      completion_reason: null,
      report_path: "/a/producing/librarys/scratch/report.json",
    },
    [{ id: UNRETAINED_REPORT, kind: "report", bytes: 24 }],
  );
  journal
    .advance(3)
    .emit(
      "pipeline",
      "node-settled",
      { ...run, node: "missing-artifact" },
      { status: "failed", detail: "log was removed before it could be read" },
      [{ id: MISSING_ARTIFACT, kind: "log", bytes: 24 }],
    );

  // The node every transcript journey opens: still running, with one session per
  // attributed role, and a step of its own that finished.
  journal.advance(2).emit("pipeline", "node-dispatched", {
    ...run,
    node: "dashboard",
    persona: "worker",
  });
  journal.advance(5);
  // Several turns each, because this is the node whose transcript the reading
  // journeys scroll: a rail short enough to fit its own region has no reading
  // position to move.
  // One session per party the dispatch ran under. The lint member is the case the
  // pair exists for: the same semantic role as the work it is reading, told apart
  // from it only by the transport `oneagentgraph` ran it as.
  for (const [session, member, persona, message] of [
    [WORKER_SESSION, "worker", "worker", "Implementing the dashboard now"],
    [JUDGE_SESSION, "judge", "judge", "The transcript is accessible"],
    [WORKER_SESSION, "worker", "worker", "Wiring the run list to the read API"],
    [CHECK_IN_SESSION, "check-in", "check-in", "Progress update sent"],
    [LINT_SESSION, "llmlint", "worker", "The diff reads as written"],
    [WORKER_SESSION, "worker", "worker", "Rendering the node view"],
    [JUDGE_SESSION, "judge", "judge", "The graph and the rail agree"],
    [CHECK_IN_SESSION, "check-in", "check-in", "Second progress update sent"],
  ]) {
    journal.emit(
      "agentgraph",
      "turn-started",
      { ...run, node: "dashboard", member, persona, session },
      { message, model: "a-model" },
    );
    // What the turn consumed, which is the only measurement of model time and
    // cost anything in the stack records.
    journal.advance(2).emit(
      "agentgraph",
      "turn-completed",
      { ...run, node: "dashboard", member, persona, session },
      {
        usage: {
          tokens_in: 1200,
          tokens_out: 340,
          cache_read: 800,
          cache_write: 120,
          cost: 0.42,
          duration: 1.5,
        },
      },
    );
    journal.advance(8);
  }

  // The turn the planner redirected. It is open — a `turn-started` with nothing
  // closing it — which is what makes this node's turn one the run can address, and
  // the `turn-activity` after the interrupt is the worker doing what it was
  // redirected to do rather than what it had been doing.
  journal.advance(2).emit(
    "agentgraph",
    "turn-started",
    {
      ...run,
      node: "dashboard",
      member: "worker",
      persona: "worker",
      session: WORKER_SESSION,
    },
    { turn: 4 },
  );
  journal.advance(3).emit(
    "agentgraph",
    "turn-interrupted",
    {
      ...run,
      node: "dashboard",
      member: "worker",
      persona: "worker",
      session: WORKER_SESSION,
    },
    {
      member: "worker",
      delivered: true,
      input_bytes: Buffer.byteLength(LIVE_NOTE),
    },
  );
  journal.emit(
    "pipeline",
    "edit-committed",
    { ...run },
    {
      // `deliver` is absent because it was `auto`, which is what the SDK's own
      // `Command` omits: an edit that says nothing about delivery is exactly the
      // edit the live-edit table always described.
      command: { op: "context", id: "dashboard", note: LIVE_NOTE },
      operations: [
        {
          kind: "context-added",
          node: "dashboard",
          note: LIVE_NOTE,
          delivery: "live",
        },
      ],
    },
  );
  journal.advance(2).emit(
    "agentgraph",
    "turn-activity",
    {
      ...run,
      node: "dashboard",
      member: "worker",
      persona: "worker",
      session: WORKER_SESSION,
    },
    {
      kind: "tool_use",
      name: "Bash",
      detail: "npx playwright test --grep 'at 390x844'",
      truncated: false,
    },
  );

  // Where that worker's conversation was actually written down. Published once
  // per oneharness invocation, carrying the pointer at the record and one
  // artifact naming it — and carrying **no** `session` label, because the
  // producer stamps that on its four turn kinds and on nothing else. The bytes
  // stay in the store `writeHarnessHistory` wrote; nothing is copied here.
  journal.advance(1).emit(
    "agentgraph",
    "oneharness-session",
    { ...run, node: "dashboard", member: "worker", persona: "worker" },
    {
      role: "agent",
      turn: 4,
      identity: "claude-code:alternate",
      session_id: "54e7ad34-ce6d-4979-8b4d-531b88026e15",
      history_id: HARNESS_SESSION_ARTIFACT,
      history_dir: harnessHistory.dir,
      history_project: HARNESS_PROJECT,
      history_session: HARNESS_SESSION_FILE,
    },
    [
      {
        id: HARNESS_SESSION_ARTIFACT,
        kind: "oneharness_session",
        bytes: harnessHistory.bytes,
      },
    ],
  );

  journal.emit("pipeline", "node-dispatched", {
    ...run,
    node: "publish",
    persona: "pr-author",
  });
  journal.advance(4).emit(
    "pipeline",
    "node-settled",
    { ...run, node: "publish" },
    {
      status: "failed",
      // No outcome word: the dispatch itself failed, which is the classification
      // the server derives when a run names no category of its own.
      detail: "Deploy failed",
      error: "publication exited non-zero",
      exit_code: 2,
    },
  );
  // Waiting on a person: real recorded time, which the node timeline draws as its
  // own span rather than as silence.
  journal
    .advance(1)
    .emit(
      "pipeline",
      "node-settled",
      { ...run, node: "approval" },
      { status: "waiting" },
    );
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "obsolete",
    persona: "worker",
  });
  // A second session recorded at no node, late in the run: the run level is
  // not one conversation, so the plot has to tell two of them apart there — and
  // two open sessions that began together are one segment nobody can point at.
  journal.advance(1);
  turn(
    journal,
    undefined,
    RUN_CHECK_IN_SESSION,
    "check-in",
    "Progress reported",
  );
  journal.advance(1).emit(
    "pipeline",
    "node-settled",
    { ...run, node: "obsolete" },
    // The scheduler's own words, in `error` rather than in a lifecycle's `detail`:
    // what the executor records when a live drop or retry cancels a node.
    { status: "cancelled", error: "cancelled cooperatively" },
  );
  journal.write();

  retainReport(dir, journal.stream, settled, FOUNDATION_REPORT);
  writeFileSync(
    join(dir, "artifacts", GATE_ARTIFACT),
    `oldest verification output\n${"full verification output\n".repeat(220)}pre-push verification passed\n`,
  );
  writeFileSync(
    join(dir, "artifacts", HOOK_ARTIFACT),
    "the pre-push hook accepted the branch\n",
  );
  writeFileSync(
    join(dir, "artifacts", CHECK_ARTIFACT),
    "published-smoke could not reach the published wheel\n",
  );
  return dir;
}

/** One settled run, so the navigation has a second launching session to group. */
function writeHistoryRun(root) {
  const run = { run_id: HISTORY_RUN };
  const dir = runDir(root, HISTORY_RUN);
  const plan = {
    schema_version: 2,
    goal: { text: "Archive the release" },
    name: "archive",
    concurrency: 1,
    tasks: [
      {
        id: "archive",
        persona: "worker",
        task: "## What\nArchive the release.\n\n## Acceptance criteria\nThe archive exists",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(HISTORY_RUN, "claude-code", CLAUDE_SESSION, stamp(HISTORIC), 4243),
  );
  writeJson(join(dir, "result.json"), {
    run_id: HISTORY_RUN,
    state: "complete",
    ok: true,
    nodes: [{ id: "archive", status: "done", outcome: "merged" }],
  });
  const journal = new Journal(dir, `a-recording-host-${HISTORY_RUN}`, HISTORIC);
  journal.emit("pipeline", "run-started", { run_id: HISTORY_RUN }, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "archive",
    persona: "worker",
  });
  journal.advance(2);
  journal.emit(
    "agentgraph",
    "turn-started",
    { ...run, node: "archive", persona: "worker", session: JUDGE_SESSION },
    { message: "Archived the release", model: "a-model" },
  );
  journal
    .advance(4)
    .emit(
      "pipeline",
      "node-settled",
      { ...run, node: "archive" },
      { status: "done", outcome: "merged" },
    );
  journal.write();
}

/**
 * One settled run holding the outcomes its journal alone cannot carry.
 *
 * The result a driver writes as it closes out holds words no settlement carried,
 * so a status recorded there — and never journalled as a settlement — is
 * how a client meets `not-completed`, a word outside the served vocabulary, and a
 * failure with nothing recorded about why.
 */
function writeOutcomesRun(root) {
  const run = { run_id: OUTCOMES_RUN };
  const dir = runDir(root, OUTCOMES_RUN);
  // The order is the layout's: the fan below ranks children in plan order, and a
  // journey clicks `backfill`, so it sits in the middle of the fan rather than at
  // the top of the canvas under the view switcher.
  const ids = [
    "migrate",
    "verify",
    "rollback",
    "backfill",
    "stalled",
    "retry",
    "orphaned",
  ];
  const plan = {
    schema_version: 2,
    goal: { text: "Migrate the store" },
    name: "migrate",
    concurrency: 3,
    // A fan out of the first node rather than seven independent ones: the layout
    // ranks by dependency, so a graph with no edges is one rank as wide as the
    // canvas and every card in it lands under the view switcher. `orphaned` stays
    // outside the fan — it is the node recorded blocked with nothing recorded
    // about what blocks it, and a dependency would answer that for it.
    tasks: ids.map((id) => ({
      id,
      persona: "worker",
      task: `## What\n${id[0].toUpperCase()}${id.slice(1)} the store.\n\n## Acceptance criteria\nThe store is migrated`,
      ...(id === "migrate" || id === "orphaned" ? {} : { deps: ["migrate"] }),
    })),
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(OUTCOMES_RUN, "claude-code", CLAUDE_SESSION, stamp(HISTORIC), 4244),
  );
  writeJson(join(dir, "result.json"), {
    run_id: OUTCOMES_RUN,
    state: "failed",
    ok: false,
    nodes: [
      { id: "migrate", status: "failed" },
      {
        id: "backfill",
        status: "not-completed",
        detail: "step 'load' timed out",
      },
      // A status the served vocabulary does not hold, which must be reported as
      // unknown rather than mapped onto a neighbouring meaning.
      { id: "verify", status: "improvised" },
      { id: "rollback", status: "failed", outcome: "gate-failed" },
      // What the executor really records for a blocked node: the *human action*
      // refs holding it, which are `node/step` locators rather than plan nodes.
      { id: "stalled", status: "blocked", blocked_by: ["migrate/sign-off"] },
      // And one recorded blocked with nothing recorded about what blocks it — a
      // legacy result, or one whose gating dependency has since settled.
      { id: "orphaned", status: "blocked" },
      // A node whose two recorded texts are the same sentence: showing it twice
      // under two headings reads as two findings rather than one.
      {
        id: "retry",
        status: "failed",
        detail: "gate rejected the push",
        error: "gate rejected the push",
      },
    ],
  });
  const journal = new Journal(
    dir,
    `a-recording-host-${OUTCOMES_RUN}`,
    HISTORIC,
  );
  journal.emit("pipeline", "run-started", { run_id: OUTCOMES_RUN }, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "migrate",
    persona: "worker",
  });
  journal
    .advance(2)
    .emit(
      "pipeline",
      "node-settled",
      { ...run, node: "migrate" },
      { status: "failed" },
    );
  journal.write();
}

/**
 * A recorded result with no authoritative journal behind it at all.
 *
 * This is what a run predating the journal looks like on an operator's machine,
 * permanently: there is nothing to fold, so the run list has only the run's own
 * result to count, and its statuses are words the served vocabulary never closed.
 */
function writeLegacyRun(root) {
  const dir = runDir(root, LEGACY_RUN);
  const plan = {
    schema_version: 2,
    goal: { text: "Convert the legacy store" },
    name: "convert",
    concurrency: 1,
    tasks: [
      {
        id: "convert",
        persona: "worker",
        task: "## What\nConvert the legacy store.\n\n## Acceptance criteria\nThe store is converted",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(LEGACY_RUN, "claude-code", CLAUDE_SESSION, stamp(HISTORIC), 4245),
  );
  writeJson(join(dir, "result.json"), {
    run_id: LEGACY_RUN,
    state: "complete",
    ok: true,
    nodes: [{ id: "convert", status: "improvised" }],
  });
  writeFileSync(join(dir, "events.jsonl"), "");
}

/** A second run under the live run's launching session, whose driver then stopped. */
function writeSiblingRun(root) {
  const run = { run_id: SIBLING_RUN };
  const dir = runDir(root, SIBLING_RUN);
  const plan = {
    schema_version: 2,
    goal: { text: "Run beside the dashboard work" },
    name: "sibling",
    concurrency: 1,
    tasks: [
      {
        id: "sibling",
        persona: "worker",
        task: "## What\nRun beside the dashboard work.\n\n## Acceptance criteria\nThe sibling settles",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(SIBLING_RUN, "codex", CODEX_SESSION, stamp(HISTORIC), 4246),
  );
  // Later than every other recorded run but the live one, so the three runs of one
  // launching session are the three the list leads with — which is the order an
  // operator reads it in, and what the grouping journey opens on.
  const journal = new Journal(
    dir,
    `a-recording-host-${SIBLING_RUN}`,
    HISTORIC + 10 * 60 * 1000,
  );
  journal.emit("pipeline", "run-started", { run_id: SIBLING_RUN }, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
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
  const run = { run_id: UNATTRIBUTED_RUN };
  const dir = runDir(root, UNATTRIBUTED_RUN);
  const plan = {
    schema_version: 2,
    goal: { text: "Continue unattributed work" },
    name: "orphan",
    concurrency: 1,
    tasks: [
      {
        id: "orphan",
        persona: "worker",
        task: "## What\nContinue the unattributed work.\n\n## Acceptance criteria\nThe work continues",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
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
  journal.emit(
    "pipeline",
    "run-started",
    { run_id: UNATTRIBUTED_RUN },
    { plan },
  );
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "orphan",
    persona: "worker",
  });
  // The node running on a harness with no out-of-band turn control. The planner
  // pulled the lever here too, and `oneagentgraph` answered with the fact rather
  // than a failure — publishing the `turn-interrupted` it publishes for every
  // attempt, delivered or not — so the note could only ride this node's next
  // dispatch. It is this fixture's node that reads as *not* interruptible, which
  // is the reading a planner would otherwise have to assume for every node.
  journal.advance(1).emit(
    "agentgraph",
    "turn-started",
    {
      ...run,
      node: "orphan",
      member: "worker",
      persona: "worker",
      session: ORPHAN_SESSION,
    },
    { turn: 1 },
  );
  journal.advance(1).emit(
    "agentgraph",
    "turn-interrupted",
    {
      ...run,
      node: "orphan",
      member: "worker",
      persona: "worker",
      session: ORPHAN_SESSION,
    },
    {
      member: "worker",
      delivered: false,
      input_bytes: Buffer.byteLength(DEFERRED_NOTE),
      reason: NO_CONTROL_REASON,
    },
  );
  journal.emit(
    "pipeline",
    "edit-committed",
    { ...run },
    {
      command: { op: "context", id: "orphan", note: DEFERRED_NOTE },
      operations: [
        {
          kind: "context-added",
          node: "orphan",
          note: DEFERRED_NOTE,
          delivery: "deferred",
        },
      ],
    },
  );
  journal.write();
}

/**
 * One run whose launch is recorded and whose journal is still empty.
 *
 * The read API serves it with a null `last_event` and no graph at all. It has to
 * stay in the navigation beside the runs that do have events: the client validates
 * the run list in one parse, so a run this shape either renders with the rest or
 * takes every one of them down with it.
 */
function writeEventlessRun(
  root,
  runId = EVENTLESS_RUN,
  launcher = "a-plain-shell",
  session = "",
) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  // The paging runs are launched by the *other* session: the codex group is the one
  // a journey counts, and forty-odd paging runs under it would make that count a
  // page size. The named eventless run records a launch whose launcher is outside
  // the closed vocabulary a client switches on and no session at all — every run
  // launched before the launcher was detected reads that way — so it is grouped by
  // the launch it does know rather than pooled with the runs that recorded none.
  writeJson(
    join(dir, "launch.json"),
    launch(runId, launcher, session, stamp(HISTORIC), 4248),
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
  const run = { run_id: BUSY_RUN };
  const dir = runDir(root, BUSY_RUN);
  const plan = {
    schema_version: 2,
    goal: { text: "Work a node that dispatches many sessions" },
    name: "sweep",
    concurrency: 1,
    tasks: [
      {
        id: "sweep",
        persona: "worker",
        task: "## What\nWork a node that dispatches many sessions.\n\n## Acceptance criteria\nEvery session settles",
      },
    ],
  };
  writeJson(join(dir, "plan.json"), plan);
  writeJson(
    join(dir, "launch.json"),
    launch(BUSY_RUN, "codex", CODEX_SESSION, stamp(HISTORIC), 4249),
  );
  const journal = new Journal(dir, `a-recording-host-${BUSY_RUN}`, HISTORIC);
  journal.emit("pipeline", "run-started", { run_id: BUSY_RUN }, { plan });
  journal.advance(1).emit("pipeline", "node-dispatched", {
    ...run,
    node: "sweep",
    persona: "worker",
  });
  for (let index = 0; index < BUSY_SESSIONS; index += 1) {
    // Session ids are the conversation identifiers the read API validates, so they
    // are minted as bare path segments rather than as anything a route would refuse.
    const session = `engineer-sweep-${index}`;
    const turns = session === BUSY_LONG_SESSION ? BUSY_LONG_TURNS : 1;
    for (let step = 0; step < turns; step += 1) {
      journal
        .advance(1)
        .emit(
          "agentgraph",
          "turn-started",
          { ...run, node: "sweep", persona: "worker", session },
          { message: `Swept batch ${index} (${step})`, model: "a-model" },
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
    writeEventlessRun(
      root,
      `dag-ui-page-${String(index).padStart(2, "0")}`,
      "claude-code",
      CLAUDE_SESSION,
    );
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
      lint: LINT_SESSION,
      foundation: FOUNDATION_SESSION,
      judge: JUDGE_SESSION,
      check_in: CHECK_IN_SESSION,
      run_check_in: RUN_CHECK_IN_SESSION,
      orchestrator: ORCHESTRATOR_SESSION,
      orphan: ORPHAN_SESSION,
    },
    redirection: {
      live_note: LIVE_NOTE,
      deferred_note: DEFERRED_NOTE,
      no_control_reason: NO_CONTROL_REASON,
    },
    remote_open_pr: REMOTE_OPEN_PR,
    foundation_commit: FOUNDATION_COMMIT,
    artifacts: {
      gate: GATE_ARTIFACT,
      missing: MISSING_ARTIFACT,
      hook: HOOK_ARTIFACT,
      check: CHECK_ARTIFACT,
      report: REPORT_ARTIFACT,
      unretained_report: UNRETAINED_REPORT,
      harness_session: HARNESS_SESSION_ARTIFACT,
    },
    harness_session_text: HARNESS_SESSION_TEXT,
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
    { run_id: LIVE_RUN, node: "dashboard" },
    { status: "done", outcome: "merged", detail: "Dashboard shipped" },
  );
}

/**
 * The bound `oneagentgraph` writes a tool summary under, in characters.
 *
 * A fixture that wrote a longer one would be recording something that library
 * cannot produce, which is the one thing these runs must never do.
 */
const ACTIVITY_DETAIL_CHARS = 160;

/**
 * Record one tool summary from inside the turn the dashboard is taking.
 *
 * `oneagentgraph` publishes these while the member works rather than when it is
 * done, which is what makes a watcher's live-activity reading possible at all.
 *
 * Both halves reach a journal a server is reading, so both are checked against
 * what that library would have written: a tool has a name, a summary has text,
 * and the text is within the bound the producer bounds it to.
 */
export function recordActivity(root, name, detail) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`'${name}' is not a tool name`);
  }
  if (detail.length === 0 || detail.length > ACTIVITY_DETAIL_CHARS) {
    throw new Error(
      `a tool summary is 1 to ${ACTIVITY_DETAIL_CHARS} characters, not ${detail.length}`,
    );
  }
  appendEvent(
    join(root, LIVE_RUN),
    "agentgraph",
    "turn-activity",
    {
      run_id: LIVE_RUN,
      node: "dashboard",
      member: "worker",
      persona: "worker",
      session: WORKER_SESSION,
    },
    { kind: "tool_use", name, detail, truncated: false },
  );
}

/** Record turns onto the live dashboard's worker session until it has `turns`. */
export function growTranscript(root, turns) {
  const dir = join(root, LIVE_RUN);
  const recorded = readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event.labels?.session === WORKER_SESSION && event.kind === "turn-started",
    ).length;
  for (let index = recorded; index < turns; index += 1) {
    appendEvent(
      dir,
      "agentgraph",
      "turn-started",
      {
        run_id: LIVE_RUN,
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
    throw new Error(`'${runId}' is not a usable run id`);
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
