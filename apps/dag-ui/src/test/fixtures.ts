/**
 * Read-API payloads shaped exactly as `@onepipeline-ui/dag-model` validates them.
 *
 * These stand in for the network, never for the telemetry client: the unit tests
 * hand them to a real `TelemetryClient` over a doubled `fetch`, so every field here
 * is parsed by the shipped schemas. `fixtures.test.ts` asserts that, and the browser
 * journeys prove the same views against the real server.
 */

export const LIVE_RUN = "dag-ui-live";
export const HISTORY_RUN = "dag-ui-history";

const timing = {
  agent_seconds: 1,
  judge_seconds: 1,
  llmlint_seconds: 0,
  gate_seconds: 2,
  publication_wait_seconds: 0,
  lock_wait_seconds: 0,
  setup_seconds: 1,
  scheduling_seconds: 0,
  wall_seconds: 5,
  agent_model_ms: 1000,
  judge_model_ms: 1000,
  llmlint_model_ms: 0,
  tool_ms: 1000,
  idle_orchestration_ms: 1000,
  unattributed_ms: 0,
  wall_ms: 5000,
  fractions: {
    agent_model: 0.2,
    judge_model: 0.2,
    llmlint_model: 0,
    tool: 0.2,
    idle_orchestration: 0.2,
    lock_wait: 0,
    setup: 0.2,
    scheduling: 0,
  },
};

const party = {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: null,
};

const timingPresence = {
  agent_model_ms: true,
  judge_model_ms: true,
  llmlint_model_ms: false,
  tool_ms: true,
};

const CODEX_LAUNCH = "c0de".repeat(8);
const CLAUDE_LAUNCH = "c1a0".repeat(8);
// The opaque, stable name of the session each launch came from. Two runs of one
// session share theirs, which is what makes them one group in the navigation.
const CODEX_SESSION = "5e551040".repeat(4);
const CLAUDE_SESSION = "5e5510c1".repeat(4);

export const runList = {
  api_version: 2,
  telemetry_schema_version: 14,
  observed_at: "2026-07-26T12:00:00Z",
  runs: [
    // Counted over the same authoritative vocabulary the run detail serves, which is
    // what stops a list row and the graph it opens describing different graphs.
    summary(LIVE_RUN, "running", {
      done: 1,
      running: 1,
      failed: 1,
      waiting: 1,
      blocked: 1,
      skipped: 1,
      pending: 1,
      cancelled: 1,
    }),
    summary(HISTORY_RUN, "complete", { done: 1, pending: 1 }),
  ],
};

export function runDetail(runId: string = LIVE_RUN) {
  const historical = runId === HISTORY_RUN;
  const tasks = historical
    ? [
        {
          id: "archive",
          task: "## What\nArchive the release\n\n## Acceptance criteria\nArchive exists",
        },
        // A lifecycle node that delegates to `steps`: it has no `task` prose and no
        // `persona` of its own, which is a shape the read API has always served and
        // the contract once refused. Its description lives once per step.
        {
          id: "corpus",
          repo: "local/example",
          deps: ["archive"],
          steps: [
            {
              id: "sweep",
              persona: "engineer",
              task: "Sweep the recorded corpus",
            },
            {
              id: "sign-off",
              kind: "human",
              task: "Confirm the sweep",
              deps: ["sweep"],
            },
          ],
        },
      ]
    : [
        {
          id: "foundation",
          task: "## What\nPrepare shared contracts\n\n## Acceptance criteria\nContract tests pass",
          repo: "local/example",
        },
        {
          id: "dashboard",
          deps: ["foundation"],
          task: "## What\nBuild the live dashboard\n\n## Acceptance criteria\nUsers can inspect transcripts",
        },
        {
          id: "publish",
          deps: ["dashboard"],
          task: "## What\nPublish the dashboard\n\n## Acceptance criteria\nThe release is reachable",
        },
        {
          id: "approval",
          kind: "human",
          deps: ["publish"],
          task: "Wait for release approval",
        },
        {
          id: "queued",
          deps: ["approval"],
          task: "## What\nStart queued follow-up\n\n## Acceptance criteria\nFollow-up starts",
        },
        // Held behind the failed publish rather than behind a human action: the
        // scheduler's other derived gate, and the other word a card has to say.
        {
          id: "abandoned",
          deps: ["publish"],
          task: "## What\nClean up after the publish\n\n## Acceptance criteria\nCleanup runs",
        },
        // Eligible work whose dependency is still running: the one node here that
        // really has nothing to report.
        {
          id: "followup",
          deps: ["dashboard"],
          task: "## What\nFollow the dashboard up\n\n## Acceptance criteria\nThe follow-up lands",
        },
        {
          id: "obsolete",
          task: "## What\nRetire obsolete work\n\n## Acceptance criteria\nWork is cancelled",
        },
      ];
  // What the journal recorded: the strict fold, and only for nodes it saw.
  const states: Record<string, string> = historical
    ? { archive: "done" }
    : {
        foundation: "done",
        dashboard: "running",
        publish: "failed",
        approval: "waiting",
        obsolete: "cancelled",
      };
  // What the server derives on top of it and serves as the one authoritative status:
  // every plan task, including the three the journal says nothing about.
  const status: Record<string, string> = historical
    ? { archive: "done", corpus: "pending" }
    : {
        ...states,
        queued: "blocked",
        abandoned: "skipped",
        followup: "pending",
      };
  const gatedBy: Record<string, string[]> = historical
    ? {}
    : { queued: ["approval"], abandoned: ["publish"] };
  // One entry for every node in flight, and for no other: `dashboard` is the only
  // node running here, and it is talking in a turn the run can address.
  const control = historical
    ? {}
    : { dashboard: { addressable: true, member: "worker" } };
  const launchId = historical ? CLAUDE_LAUNCH : CODEX_LAUNCH;
  const launcher = historical ? "claude-code" : "codex";
  const node = historical ? "archive" : "dashboard";
  return {
    api_version: 2,
    telemetry_schema_version: 14,
    observed_at: "2026-07-26T12:00:00Z",
    // The launching session is served on the run itself, and on every list row.
    launch: {
      launch_id: launchId,
      launcher,
      session_key: historical ? CLAUDE_SESSION : CODEX_SESSION,
    },
    run: {
      run_id: runId,
      state: historical ? "complete" : "running",
      phase: historical ? "settled" : "dispatching",
      last_event: historical ? "node-settled" : "node-ready",
      timing,
      nodes: tasks
        .filter(({ id }) => states[id] !== undefined)
        .map(({ id }) => ({
          node: id,
          status: states[id] ?? "cancelled",
          sessions: [],
          turns: id === "dashboard" ? 2 : 1,
          lint: 0,
          timing_quality: "complete",
          linkage_quality: "labelled",
          timing_presence: timingPresence,
          ...(id === "foundation"
            ? {
                gate_attestation: {
                  command: ["just", "gate"],
                  comparison_base: "origin/main",
                },
              }
            : {}),
          // Classified by the server exactly as the run-level failure is, so the
          // node view states a kind rather than parsing one out of prose.
          ...(id === "publish"
            ? { failure: { class: "agent", detail: "Deploy failed" } }
            : {}),
        })),
      usage: { agent: party, judge: party, llmlint: party, total: party },
      timing_quality: "complete",
      linkage_quality: "labelled",
      timing_presence: timingPresence,
      sources: ["oneharness"],
      node_work_ms: {
        agent_model_ms: 1000,
        judge_model_ms: 1000,
        llmlint_model_ms: 0,
        tool_ms: 1000,
        wall_ms: 5000,
      },
      turns: 4,
      lint: 0,
    },
    graph: {
      run_id: runId,
      plan: { tasks },
      node_states: states,
      node_status: status,
      node_gated_by: gatedBy,
      node_control: control,
      node_results: historical
        ? { archive: { status: "done", ok: true } }
        : {
            foundation: {
              status: "done",
              ok: true,
              pr: PR_URL,
              detail: "Gate completed successfully",
              telemetry: { checks: { unit: "passed", lint: "passed" } },
            },
            publish: {
              status: "failed",
              ok: false,
              detail: "Deploy failed",
              error: "publication exited non-zero",
              exit_code: 2,
            },
          },
      // The live run is held behind one decision point: a human has to approve
      // before `queued` can start, which is why that node reads `blocked`.
      decisions: historical
        ? []
        : [{ id: "approval", kind: "human-action", unblocks: ["queued"] }],
      attestations: [],
      result: null,
      last_seq: 7,
    },
    node_details: historical
      ? {}
      : {
          foundation: {
            verification: {
              pre_push_hook: true,
              required_checks: ["unit", "lint"],
              required_checks_status: "configured",
              expected_gate: ["pre-push", "unit", "lint"],
              checks: [
                { name: "unit", state: "SUCCESS", required: true },
                { name: "lint", state: "SUCCESS", required: true },
              ],
              records: [],
            },
            publication: {
              pr_url: PR_URL,
              branch: "feature/foundation",
              branch_url:
                "https://github.com/example/repo/tree/feature/foundation",
              merged: false,
              base_branch: "main",
            },
          },
        },
    conversations: [
      conversation(
        "worker-session",
        "worker",
        "agent",
        node,
        launchId,
        launcher,
        "Implementing the dashboard now",
      ),
      conversation(
        "judge-session",
        "judge",
        "judge",
        node,
        launchId,
        launcher,
        "The transcript is accessible",
      ),
      conversation(
        "check-in-session",
        "check-in",
        "agent",
        node,
        launchId,
        launcher,
        "Progress update sent",
      ),
      conversation(
        "pr-author-session",
        "pr-author",
        "agent",
        node,
        launchId,
        launcher,
        "Drafted the pull request",
      ),
      conversation(
        "llmlint-session",
        "worker",
        "llmlint",
        node,
        launchId,
        launcher,
        "Reviewed the changed behavior",
      ),
      conversation(
        "orchestrator-session",
        "orchestrator",
        "agent",
        undefined,
        launchId,
        launcher,
        "Coordinating the execution frontier",
      ),
      conversation(
        RUN_CHECK_IN_SESSION,
        "check-in",
        "agent",
        undefined,
        launchId,
        launcher,
        "Progress reported",
      ),
    ],
  };
}

function summary(
  runId: string,
  state: string,
  nodeCounts: Record<string, number>,
) {
  const historical = runId === HISTORY_RUN;
  return {
    run_id: runId,
    state,
    phase: state === "complete" ? "settled" : "dispatching",
    last_event: state === "complete" ? "node-settled" : "node-ready",
    timing_quality: "complete",
    linkage_quality: "labelled",
    timing,
    node_counts: nodeCounts,
    launch: {
      launch_id: historical ? CLAUDE_LAUNCH : CODEX_LAUNCH,
      launcher: historical ? "claude-code" : "codex",
      session_key: historical ? CLAUDE_SESSION : CODEX_SESSION,
    },
  };
}

/** `2026-07-26T11:00:00Z` plus `seconds`, so every fixture stamp is ordered. */
function stamp(seconds: number): string {
  return new Date(
    Date.UTC(2026, 6, 26, 11, 0, 0) + seconds * 1000,
  ).toISOString();
}

/**
 * The served timeline of a run, shaped exactly as `src/payload.rs::timeline` folds
 * one: the run span holding node spans, each holding the dispatches, verification,
 * publication and rollups recorded inside it, with references instead of bodies.
 */
export function runTimeline(runId: string = LIVE_RUN) {
  return {
    api_version: 2,
    timeline_schema_version: 6,
    // Read shortly after the last record it carries, which is what a poll of a live
    // run actually returns. The graph-level view plots an unfinished run out to this
    // instant, so a stamp an hour past the record would say the run had spent an
    // hour idle that it never lived.
    observed_at: stamp(240),
    run_id: runId,
    spans: runId === HISTORY_RUN ? historySpans() : liveSpans(),
  };
}

export const WORKER_SESSION = "worker-session";

/**
 * The live run's worker transcript once it has recorded `turns` turns.
 *
 * A dispatched session is written a turn at a time, so this and `workerTurnsTimeline`
 * are one fixture in two payloads: the timeline gains a `conversation-turn` event as
 * the transcript gains the turn itself, exactly as `src/payload.rs::timeline` folds
 * them. A test that grew one without the other would be describing a server that
 * cannot exist.
 */
export function workerConversation(turns: number) {
  const recorded = conversation(
    WORKER_SESSION,
    "worker",
    "agent",
    "dashboard",
    CODEX_LAUNCH,
    "codex",
    "Implementing the dashboard now",
  );
  return {
    ...recorded,
    conversation: {
      ...recorded.conversation,
      turns: Array.from({ length: turns }, (_, index) => ({
        ...recorded.conversation.turns[0],
        id: `${WORKER_SESSION}-${index}`,
        ...(index === 0
          ? {}
          : { assistant: `Dashboard turn ${index} arrived` }),
      })),
    },
  };
}

export function workerTurnsTimeline(turns: number) {
  const served = runTimeline(LIVE_RUN);
  const grown = dispatch(
    WORKER_SESSION,
    "engineer-dashboard",
    "dashboard",
    12,
    60,
    Array.from({ length: turns }, (_, index) => `${WORKER_SESSION}-${index}`),
  );
  return {
    ...served,
    spans: served.spans.map((span) => (span.id === grown.id ? grown : span)),
  };
}

/** The settled run's one recorded session, long enough to be read a page at a time. */
export const LONG_SESSION = "archive-session";

/**
 * One session whose transcript is longer than a reader is handed at once.
 *
 * A real worker session runs to dozens of turns, which is what makes the detail
 * region page them rather than render the whole conversation on selection.
 */
export function longConversation(turns = 30) {
  const recorded = conversation(
    LONG_SESSION,
    "worker",
    "agent",
    "archive",
    CLAUDE_LAUNCH,
    "claude-code",
    "Archived the release",
  );
  return {
    ...recorded,
    conversation: {
      ...recorded.conversation,
      turns: Array.from({ length: turns }, (_, index) => ({
        ...recorded.conversation.turns[0],
        id: `${LONG_SESSION}-${index}`,
        assistant: `Archive step ${index}`,
      })),
    },
  };
}

function historySpans() {
  return [
    {
      id: "run-1",
      kind: "run",
      label: "the run",
      started_at: stamp(0),
      ended_at: stamp(120),
      status: "finished",
      events: [],
    },
    {
      id: "node-archive",
      kind: "node",
      label: "archive",
      parent_id: "run-1",
      node_id: "archive",
      started_at: stamp(10),
      ended_at: stamp(90),
      status: "done",
      events: [],
    },
    // Every recorded session of this run belongs to a node, so it has no run-level
    // planner conversation at all.
    dispatch(LONG_SESSION, "engineer-archive", "archive", 20, 80, [
      `${LONG_SESSION}-0`,
      `${LONG_SESSION}-1`,
    ]),
  ];
}

function liveSpans() {
  return [
    {
      id: "run-1",
      kind: "run",
      label: "the run",
      started_at: stamp(0),
      ended_at: null,
      events: [
        {
          id: "event-0",
          kind: "node-added",
          at: stamp(0),
        },
      ],
    },
    {
      id: "node-foundation",
      kind: "node",
      label: "foundation",
      parent_id: "run-1",
      node_id: "foundation",
      started_at: stamp(5),
      ended_at: stamp(180),
      status: "done",
      reference: {
        kind: "worker_report",
        value: "foundation/report.md",
      },
      events: [],
    },
    {
      id: "verification-4",
      kind: "verification",
      label: "just gate",
      parent_id: "node-foundation",
      node_id: "foundation",
      started_at: stamp(30),
      ended_at: stamp(95),
      status: "ok",
      reference: { kind: "gate_log", value: "foundation/gate.log" },
      events: [],
    },
    {
      id: "publication-6",
      kind: "publication",
      label: "local/example",
      parent_id: "node-foundation",
      node_id: "foundation",
      started_at: stamp(100),
      ended_at: stamp(180),
      status: "finished",
      reference: { kind: "pr", value: PR_URL },
      events: [
        {
          id: "event-6",
          kind: "pr-created",
          at: stamp(100),
          node_id: "foundation",
          reference: { kind: "pr", value: PR_URL },
        },
        {
          id: "event-7",
          kind: "pr-checks-observed",
          at: stamp(140),
          node_id: "foundation",
          status: "passing",
          reference: { kind: "pr", value: PR_URL },
        },
      ],
    },
    {
      id: "node-dashboard",
      kind: "node",
      label: "dashboard",
      parent_id: "run-1",
      node_id: "dashboard",
      started_at: stamp(10),
      ended_at: null,
      events: [
        {
          id: "event-9",
          kind: "checkpoint-recorded",
          at: stamp(45),
          node_id: "dashboard",
          status: "verified",
        },
        // The moment the planner changed what the running turn was doing, and the
        // one it could not: a node's timeline carries both as its own records.
        {
          id: "event-10",
          kind: "turn-interrupted",
          at: stamp(50),
          node_id: "dashboard",
          redirection: { delivered: true, member: "worker", input_bytes: 41 },
        },
        {
          id: "event-11",
          kind: "turn-interrupted",
          at: stamp(52),
          node_id: "dashboard",
          redirection: {
            delivered: false,
            member: "judge",
            input_bytes: 26,
            reason: "the member is between turns",
          },
        },
      ],
    },
    dispatch("worker-session", "engineer-dashboard", "dashboard", 12, 60, [
      "worker-session-0",
    ]),
    dispatch(
      "judge-session",
      "you-are-a-strict-careful-evaluator",
      "dashboard",
      62,
      90,
      ["judge-session-0"],
      { agent_role: "judge", transport_role: "judge" },
    ),
    dispatch(
      "check-in-session",
      "check-in-dashboard",
      "dashboard",
      92,
      110,
      ["check-in-session-0"],
      { agent_role: "check-in", transport_role: "agent" },
    ),
    dispatch(
      "pr-author-session",
      "pr-author-dashboard",
      "dashboard",
      112,
      130,
      ["pr-author-session-0"],
      { agent_role: "pr-author", transport_role: "agent" },
    ),
    dispatch(
      "llmlint-session",
      "llmlint-dashboard",
      "dashboard",
      20,
      50,
      ["llmlint-session-0"],
      // Lint is verification inside the worker dispatch, so it keeps the worker's
      // semantic role and is told apart by its transport role alone.
      { agent_role: "worker", transport_role: "llmlint" },
      "dispatch-worker-session",
    ),
    {
      id: "rollup-lock-wait-11",
      kind: "rollup",
      label: "lock-wait",
      parent_id: "node-dashboard",
      node_id: "dashboard",
      started_at: stamp(15),
      ended_at: stamp(155),
      count: 1240,
      total_duration_ms: 4200,
      events: [],
    },
    {
      id: "node-publish",
      kind: "node",
      label: "publish",
      parent_id: "run-1",
      node_id: "publish",
      started_at: stamp(20),
      ended_at: stamp(70),
      status: "failed",
      events: [],
    },
    // The failed node's own attempts: a gate that never reached an attestation, and
    // a publication that recorded no PR and observed no checks.
    {
      id: "verification-12",
      kind: "verification",
      label: "branch push ai-orchestrator/engineer/publish",
      parent_id: "node-publish",
      node_id: "publish",
      started_at: stamp(30),
      ended_at: stamp(50),
      status: "failed",
      events: [],
    },
    {
      id: "publication-13",
      kind: "publication",
      label: "publication",
      parent_id: "node-publish",
      node_id: "publish",
      started_at: stamp(55),
      ended_at: stamp(70),
      status: "failed",
      events: [],
    },
    {
      id: "human-wait-14",
      kind: "human-wait",
      label: "approval",
      parent_id: "run-1",
      node_id: "approval",
      started_at: stamp(75),
      ended_at: null,
      status: "waiting",
      events: [],
    },
    // Run-level work, recorded at no node: the planner driving the whole graph, and
    // the run's own check-in dispatched beside it once work was under way.
    runLevelDispatch(
      "orchestrator-session",
      "orchestrator-dag-ui-live",
      1,
      200,
      {
        agent_role: "orchestrator",
        transport_role: "agent",
      },
    ),
    runLevelDispatch(RUN_CHECK_IN_SESSION, "check-in", 160, 170, {
      agent_role: "check-in",
      transport_role: "agent",
    }),
  ];
}

/** The second run-level session: the run's own check-in, recorded at no node. */
export const RUN_CHECK_IN_SESSION = "run-check-in-session";

/**
 * Both roles a dispatch span carries: the party oneharness recorded, and what the
 * dispatch was for. Defaulted to an ordinary worker, which is what most are.
 */
interface DispatchRoles {
  readonly agent_role: string;
  readonly transport_role: string;
}
const WORKER: DispatchRoles = { agent_role: "worker", transport_role: "agent" };

/** One dispatched session the graph placed at the run rather than at any node. */
function runLevelDispatch(
  conversationId: string,
  label: string,
  from: number,
  to: number,
  roles: DispatchRoles = WORKER,
) {
  const reference = { kind: "conversation", value: conversationId };
  return {
    id: `dispatch-${conversationId}`,
    kind: "dispatch",
    label,
    parent_id: "run-1",
    started_at: stamp(from),
    ended_at: stamp(to),
    status: "completed",
    ...roles,
    reference,
    events: [
      {
        id: `${conversationId}-0`,
        kind: "conversation-turn",
        at: stamp(from),
        status: "completed",
        reference,
      },
    ],
  };
}

/**
 * The same run at `scope=run`: the run's own spans, each node's root, and one bounded
 * summary per category of the work recorded inside it.
 *
 * This is what the graph-level reading of a run is served, and it is deliberately not
 * the node payload with pieces removed — a summary carries a count and the time its
 * category *cost*, the roles that identify it, and no events, references or bodies.
 * `src/payload.rs::run_spans` owns the rule; `tests/e2e/server.rs` holds it to the
 * shape written out here.
 */
export function runScopeTimeline(runId: string = LIVE_RUN) {
  const served = runTimeline(runId);
  return {
    ...served,
    spans:
      runId === HISTORY_RUN
        ? [
            ...served.spans.filter(({ kind }) => kind === "run"),
            { ...historySpans()[0], events: [] },
            categorySummary("node-archive", "archive", "dispatch", 20, 80, {
              agent_role: "worker",
              transport_role: "agent",
            }),
          ]
        : [
            ...served.spans.filter((span) => !("node_id" in span)),
            ...liveSpans()
              .filter((span) => span.kind === "node")
              .map((span) => ({ ...span, events: [] })),
            categorySummary(
              "node-foundation",
              "foundation",
              "verification",
              30,
              95,
            ),
            categorySummary(
              "node-foundation",
              "foundation",
              "publication",
              100,
              180,
            ),
            categorySummary("node-dashboard", "dashboard", "dispatch", 12, 60, {
              agent_role: "worker",
              transport_role: "agent",
            }),
            categorySummary("node-dashboard", "dashboard", "dispatch", 20, 50, {
              agent_role: "worker",
              transport_role: "llmlint",
            }),
            categorySummary("node-dashboard", "dashboard", "dispatch", 62, 90, {
              agent_role: "judge",
              transport_role: "judge",
            }),
            categorySummary(
              "node-dashboard",
              "dashboard",
              "dispatch",
              92,
              110,
              {
                agent_role: "check-in",
                transport_role: "agent",
              },
            ),
            categorySummary(
              "node-dashboard",
              "dashboard",
              "dispatch",
              112,
              130,
              {
                agent_role: "pr-author",
                transport_role: "agent",
              },
            ),
            // The aggregate keeps the 4.2s it measured, not the 140s window it fell in.
            {
              ...categorySummary(
                "node-dashboard",
                "dashboard",
                "rollup",
                15,
                155,
              ),
              count: 1240,
              total_duration_ms: 4200,
            },
            categorySummary("node-publish", "publish", "verification", 30, 50),
            categorySummary("node-publish", "publish", "publication", 55, 70),
            // `approval` never started, so the run journalled no span to parent this
            // to — and the wait is still the only thing that node has recorded.
            {
              ...categorySummary(
                "node-approval",
                "approval",
                "human-wait",
                75,
                75,
              ),
              ended_at: null,
              parent_id: undefined,
            },
          ],
  };
}

/** One `scope=run` category summary, as `_run_scope` writes one. */
function categorySummary(
  parentId: string,
  nodeId: string,
  kind: string,
  from: number,
  to: number,
  roles?: DispatchRoles,
) {
  const named =
    roles === undefined
      ? "activity"
      : `${roles.agent_role}-${roles.transport_role}`;
  return {
    id: `summary-${parentId}-${kind}-${named}`,
    kind: "rollup",
    label: roles?.agent_role ?? kind,
    parent_id: parentId,
    node_id: nodeId,
    started_at: stamp(from),
    ended_at: stamp(to),
    count: 1,
    total_duration_ms: (to - from) * 1000,
    ...(roles ?? {}),
    events: [],
  };
}

export const PR_URL = "https://github.com/example/repo/pull/12";

function dispatch(
  conversationId: string,
  label: string,
  nodeId: string,
  from: number,
  to: number,
  turnIds: readonly string[],
  roles: DispatchRoles = WORKER,
  // A lint run happens inside the dispatch it is verifying, and the server serves it
  // nested there rather than beside it; every other session hangs off its node.
  parentId: string = `node-${nodeId}`,
) {
  const reference = { kind: "conversation", value: conversationId };
  return {
    id: `dispatch-${conversationId}`,
    kind: "dispatch",
    label,
    parent_id: parentId,
    node_id: nodeId,
    started_at: stamp(from),
    ended_at: stamp(to),
    status: "completed",
    ...roles,
    reference,
    events: turnIds.map((id, index) => ({
      id,
      kind: "conversation-turn",
      at: stamp(from + index),
      node_id: nodeId,
      status: "completed",
      reference,
    })),
  };
}

/**
 * A timeline of the shape that made the old panel unreadable: one node whose
 * recorded work is `sessions` separate conversations, each with its own turns.
 */
export function busyTimeline(sessions: number) {
  const spans = liveSpans().filter(
    (span) => !span.id.startsWith("dispatch-worker"),
  );
  return {
    api_version: 2,
    timeline_schema_version: 6,
    observed_at: "2026-07-26T12:00:00Z",
    run_id: LIVE_RUN,
    spans: [
      ...spans,
      ...Array.from({ length: sessions }, (_, index) =>
        dispatch(
          `busy-${index}`,
          `engineer-dashboard-${index}`,
          "dashboard",
          200 + index * 2,
          201 + index * 2,
          [`busy-${index}-0`],
        ),
      ),
    ],
  };
}

function conversation(
  id: string,
  agentRole: string,
  transportRole: string,
  nodeId: string | undefined,
  launchId: string,
  launcher: string,
  text: string,
) {
  const tools =
    agentRole === "worker" && transportRole === "agent"
      ? [
          {
            durationMs: 240,
            index: 0,
            input: { command: "rg timeline" },
            kind: "tool_call",
            name: "Bash",
            status: "completed",
            toolCallId: "call-1",
          },
          {
            index: 1,
            kind: "tool_result",
            output: '{"matches":1}',
            toolCallId: "call-1",
          },
        ]
      : [];
  return {
    conversation: {
      canContinue: false,
      harnesses: ["codex"],
      id,
      name: `${agentRole} conversation`,
      project: "ai-orchestrator",
      startedAt: "2026-07-26T11:00:00Z",
      state: "completed",
      turns: [
        {
          assistant: text,
          failureKind: null,
          harness: "codex",
          id: `${id}-0`,
          model: "gpt-5",
          reasoning: null,
          status: "completed",
          timestamp: "2026-07-26T11:00:00Z",
          tools,
          unknown: {},
          usage: {},
          user: `Act as ${agentRole}`,
        },
      ],
    },
    attribution: {
      transportRole,
      agentRole,
      launcher,
      launchId,
      persona: agentRole === "pr-author" ? "pr-author" : "engineer",
      ...(nodeId === undefined ? {} : { nodeId }),
    },
  };
}
