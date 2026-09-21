import { describe, expect, test } from "vitest";

import {
  AGENT_LABELS,
  AGENT_SCOPES,
  API_V2_PATHS,
  agentRoleSchema,
  agentSessionSchema,
  dagConversationSchema,
  graphPayloadSchema,
  graphResultItemSchema,
  graphStateSchema,
  hostShutdownScopeSchema,
  nodeTelemetrySchema,
  parseRunList,
  parseRunTimeline,
  planTaskSchema,
  projectAgentsSchema,
  projectGroupSchema,
  runAgentsSchema,
  runDetailSchema,
  runListSchema,
  runSummarySchema,
  runTelemetrySchema,
  SHUTDOWN_DEFAULT_GRACE_SECONDS,
  sessionLinkSchema,
  shutdownReportSchema,
  TELEMETRY_SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
  timelineEventSchema,
  timelineReferenceSchema,
  timelineSpanSchema,
  timingSchema,
  unwatchedSchema,
} from "./index.js";

const timing = {
  agent_seconds: 1,
  judge_seconds: 0,
  llmlint_seconds: 0,
  gate_seconds: 0,
  publication_wait_seconds: 0,
  lock_wait_seconds: 0,
  setup_seconds: 0,
  scheduling_seconds: 0,
  wall_seconds: 1,
  agent_model_ms: 1000,
  judge_model_ms: 0,
  llmlint_model_ms: 0,
  tool_ms: 0,
  idle_orchestration_ms: 0,
  unattributed_ms: 0,
  wall_ms: 1000,
  fractions: {
    agent_model: 1,
    judge_model: 0,
    llmlint_model: 0,
    tool: 0,
    idle_orchestration: 0,
    lock_wait: 0,
    setup: 0,
    scheduling: 0,
  },
};

const usageParty = {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: null,
};

const TIMING_PRESENCE = {
  agent_model_ms: false,
  judge_model_ms: false,
  llmlint_model_ms: false,
  tool_ms: false,
};

/** A minimal valid `RunTelemetry`, for the tests that vary one field of it. */
const RUN_TELEMETRY = {
  run_id: "run-3",
  state: "failed",
  phase: "failed",
  last_event: "node-failed",
  timing,
  nodes: [],
  usage: {
    agent: usageParty,
    judge: usageParty,
    llmlint: usageParty,
    total: usageParty,
  },
  timing_quality: "legacy",
  linkage_quality: "inferred",
  timing_presence: TIMING_PRESENCE,
  sources: [],
  node_work_ms: {
    agent_model_ms: 0,
    judge_model_ms: 0,
    llmlint_model_ms: 0,
    tool_ms: 0,
    wall_ms: 0,
  },
  turns: 0,
  lint: 0,
};

test("validates and preserves additive run-list fields", () => {
  const parsed = parseRunList({
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    extension: true,
    runs: [
      {
        run_id: "run-1",
        state: "running",
        phase: "agent",
        last_event: "node-started",
        timing_quality: "complete",
        linkage_quality: "native",
        timing,
        node_counts: { running: 1 },
      },
    ],
  });
  expect(parsed.extension).toBe(true);
});

test("reads where a run belongs and what waits on it off the list row", () => {
  // Schema 18's four fields, exactly as the server serves them: the project and
  // its name where the run recorded them, the engine's own liveness word, and
  // the channel's unread count. Each is read as itself — a `liveness` word a
  // later engine adds reaches a reader rather than failing the list — and a
  // count that is not one is refused, because a row saying "-1 questions" is
  // a row nothing can act on.
  const row = {
    run_id: "run-1",
    state: "active",
    phase: "surfacing",
    last_event: "planner-surface-queued",
    timing_quality: "partial",
    linkage_quality: "labelled",
    timing,
    node_counts: { running: 1 },
    project: "local-md:project-grouping",
    project_name: "Project grouping",
    liveness: "ACTIVE",
    unread_surfaces: 2,
  };
  const parsed = runSummarySchema.parse(row);
  expect(parsed.project).toBe("local-md:project-grouping");
  expect(parsed.project_name).toBe("Project grouping");
  expect(parsed.liveness).toBe("ACTIVE");
  expect(parsed.unread_surfaces).toBe(2);
  // A run that recorded no project carries neither field, and is still a row.
  const unprojected = { ...row, project: undefined, project_name: undefined };
  expect(runSummarySchema.parse(unprojected).project).toBeUndefined();
  expect(runSummarySchema.parse(unprojected).project_name).toBeUndefined();
  expect(
    runSummarySchema.safeParse({ ...row, unread_surfaces: -1 }).success,
  ).toBe(false);
  expect(
    runSummarySchema.safeParse({ ...row, unread_surfaces: 1.5 }).success,
  ).toBe(false);
  expect(runSummarySchema.safeParse({ ...row, liveness: "" }).success).toBe(
    false,
  );
  expect(runSummarySchema.safeParse({ ...row, project: "" }).success).toBe(
    false,
  );
});

test("reads the launching session off the list row it is served on", () => {
  const row = {
    run_id: "run-1",
    state: "running",
    phase: "agent",
    last_event: "node-started",
    timing_quality: "complete",
    linkage_quality: "native",
    timing,
    node_counts: { running: 1 },
  };
  // The join is served on the row itself, so grouping runs by their launching
  // session never has to fetch a run's transcripts to recover the same answer.
  const parsed = parseRunList({
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    runs: [
      { ...row, launch: { launch_id: "c0de".repeat(8), launcher: "codex" } },
    ],
  });
  expect(parsed.runs[0]?.launch?.launcher).toBe("codex");
  // A run that recorded no launch id is served without the join at all.
  expect(runSummarySchema.parse(row).launch).toBeUndefined();
  // The launcher vocabulary is closed: an unrecognized one is a contract failure,
  // not a run silently grouped under a launcher the server never named.
  expect(
    runSummarySchema.safeParse({
      ...row,
      launch: { launch_id: "c0de".repeat(8), launcher: "gemini" },
    }).success,
  ).toBe(false);
});

test("reads the run roots the server refused, and the selection it could not find", () => {
  const row = {
    run_id: "run-1",
    state: "running",
    phase: "agent",
    last_event: "node-started",
    timing_quality: "complete",
    linkage_quality: "native",
    timing,
    node_counts: { running: 1 },
  };
  // A refused run root is reported rather than dropped: a list that silently
  // omitted it is indistinguishable from a host with nothing running.
  const refused = parseRunList({
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    runs: [row],
    unreadable: [{ path: "/runs/run-9", reason: "no launch record" }],
  });
  expect(refused.unreadable?.[0]?.reason).toBe("no launch record");
  // And a run a `?select=` named that is no longer there is named, not omitted.
  const selected = parseRunList({
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    runs: [row],
    missing: ["run-swept"],
  });
  expect(selected.missing).toEqual(["run-swept"]);
  expect(selected.next_cursor).toBeUndefined();
  // Both are absent on the ordinary listing, which is what every client written
  // before schema 15 reads.
  expect(
    parseRunList({
      api_version: 2,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      runs: [row],
    }).unreadable,
  ).toBeUndefined();
  // A refusal that names no reason is not one a reader can act on.
  expect(
    runListSchema.safeParse({
      api_version: 2,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      runs: [row],
      unreadable: [{ path: "/runs/run-9", reason: "" }],
    }).success,
  ).toBe(false);
});

test("accepts a run that has recorded no last event, and still rejects a blank one", () => {
  const eventless = {
    run_id: "run-2",
    state: "running",
    phase: "running",
    last_event: null,
    timing_quality: "legacy",
    linkage_quality: "inferred",
    timing,
    node_counts: {},
  };
  const parsed = parseRunList({
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    runs: [eventless],
  });
  expect(parsed.runs[0]?.last_event).toBeNull();
  // The whole point of the null is that it is the only representation of absence;
  // the degenerate empty string it replaced must stay invalid.
  expect(
    runSummarySchema.safeParse({ ...eventless, last_event: "" }).success,
  ).toBe(false);

  const telemetryResult = runTelemetrySchema.safeParse({
    run_id: "run-2",
    state: "running",
    phase: "running",
    last_event: null,
    timing,
    nodes: [],
    usage: {
      agent: usageParty,
      judge: usageParty,
      llmlint: usageParty,
      total: usageParty,
    },
    timing_quality: "legacy",
    linkage_quality: "inferred",
    timing_presence: {
      agent_model_ms: false,
      judge_model_ms: false,
      llmlint_model_ms: false,
      tool_ms: false,
    },
    sources: [],
    node_work_ms: {
      agent_model_ms: 0,
      judge_model_ms: 0,
      llmlint_model_ms: 0,
      tool_ms: 0,
      wall_ms: 0,
    },
    turns: 0,
    lint: 0,
  });
  expect(telemetryResult.success).toBe(true);
});

describe("agents", () => {
  const envelope = {
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-08-07T12:00:00Z",
  };
  /** One session as the SDK serves it, under the engine's labels and one of the repository's. */
  const session = {
    history_session: "contract-interface-worker-20260807T120003Z-3163646",
    name: "contract-interface-worker",
    history_dir: "/a-scratch/oneharness-history",
    history_project: "a-recording-host-workspace",
    history_file:
      "/a-scratch/oneharness-history/a-recording-host-workspace/contract-interface-worker-20260807T120003Z-3163646.jsonl",
    project: "/a-recording-host/workspace",
    started: "2026-08-07T12:00:03Z",
    labels: {
      [AGENT_LABELS.attempt]: "1",
      [AGENT_LABELS.node]: "contract-interface",
      [AGENT_LABELS.project]: "authoring:contract-interface",
      [AGENT_LABELS.runId]: "run-20260807-a1b2c3",
      [AGENT_LABELS.scope]: "node",
      role: "engineer",
    },
    runs: [
      {
        history_id: "0198a5b3-2c4d-7e60-8f01-000000000001",
        harness: "claude-code",
        variant: "alternate",
        harness_id: "claude-code:alternate",
        started: "2026-08-07T12:00:03Z",
      },
      {
        history_id: "0198a5b3-2c4d-7e60-8f01-000000000002",
        harness: "codex",
        harness_id: "codex",
        started: "2026-08-07T12:00:10Z",
      },
    ],
    run_id: "run-20260807-a1b2c3",
  };

  test("reads a run's, a node's and a project's sessions as the SDK serves them", () => {
    const run = runAgentsSchema.parse({
      ...envelope,
      run_id: "run-20260807-a1b2c3",
      sessions: [session],
      skipped: 0,
    });
    expect(run.sessions[0]?.runs[1]?.variant).toBeUndefined();
    expect(run.sessions[0]?.labels[AGENT_LABELS.scope]).toBe("node");
    expect(run.sessions[0]?.labels.role).toBe("engineer");
    expect(run.node).toBeUndefined();
    const node = runAgentsSchema.parse({
      ...envelope,
      run_id: "run-20260807-a1b2c3",
      node: "contract-interface",
      sessions: [],
      skipped: 0,
    });
    expect(node.node).toBe("contract-interface");
    expect(node.sessions).toEqual([]);
    // A project's union names the run each entry is under only where the engine
    // stamped it; an entry carrying none is still an entry.
    const unstamped = Object.fromEntries(
      Object.entries(session).filter(([key]) => key !== "run_id"),
    );
    const project = projectAgentsSchema.parse({
      ...envelope,
      project: "authoring:contract-interface",
      sessions: [session, unstamped],
      skipped: 1,
    });
    expect(project.sessions.map((entry) => entry.run_id)).toEqual([
      "run-20260807-a1b2c3",
      undefined,
    ]);
    expect(project.skipped).toBe(1);
    expect(AGENT_SCOPES).toContain(session.labels[AGENT_LABELS.scope]);
  });

  test("refuses a session missing one of the three fields its transcript resolves through", () => {
    for (const field of ["history_dir", "history_project", "history_session"]) {
      const missing = Object.fromEntries(
        Object.entries(session).filter(([key]) => key !== field),
      );
      expect(() => agentSessionSchema.parse(missing)).toThrow();
    }
    expect(() =>
      agentSessionSchema.parse({ ...session, runs: [{ history_id: "x" }] }),
    ).toThrow();
  });

  test("reads the agent count beside a run and a project group, and its absence", () => {
    const run = runTelemetrySchema.parse({ ...RUN_TELEMETRY, agent_count: 0 });
    expect(runTelemetrySchema.parse(RUN_TELEMETRY).agent_count).toBeUndefined();
    expect(run.agent_count).toBe(0);
    const group = { project: null, name: null, last_write_at: null, runs: [] };
    expect(projectGroupSchema.parse(group).agent_count).toBeUndefined();
    expect(
      projectGroupSchema.parse({ ...group, agent_count: 3 }).agent_count,
    ).toBe(3);
    expect(() =>
      projectGroupSchema.parse({ ...group, agent_count: -1 }),
    ).toThrow();
  });
});

describe("schema compatibility", () => {
  /**
   * The version is the whole compatibility statement, so the parsers refuse the
   * one either side of the one they read rather than taking what arrives.
   */
  test("refuses a payload from a server on another telemetry schema", () => {
    const list = {
      api_version: 2,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      runs: [],
    };
    expect(parseRunList(list).telemetry_schema_version).toBe(
      TELEMETRY_SCHEMA_VERSION,
    );
    for (const other of [
      TELEMETRY_SCHEMA_VERSION - 1,
      TELEMETRY_SCHEMA_VERSION + 1,
    ]) {
      expect(() =>
        parseRunList({ ...list, telemetry_schema_version: other }),
      ).toThrow();
    }
  });

  test("refuses a timeline from a server on another timeline schema", () => {
    const timeline = {
      api_version: 2,
      timeline_schema_version: TIMELINE_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      run_id: "run-1",
      spans: [],
    };
    expect(parseRunTimeline(timeline).timeline_schema_version).toBe(
      TIMELINE_SCHEMA_VERSION,
    );
    for (const other of [
      TIMELINE_SCHEMA_VERSION - 1,
      TIMELINE_SCHEMA_VERSION + 1,
    ]) {
      expect(() =>
        parseRunTimeline({ ...timeline, timeline_schema_version: other }),
      ).toThrow();
    }
  });

  /**
   * What schema 11 is *for*: a lane nothing measured arrives null, and a client
   * that reads it can tell that from a lane measured at zero. Both are accepted,
   * and they are different values — which is exactly what schema 10 could not
   * say.
   */
  test("reads an unmeasured timing apart from one measured at zero", () => {
    const unmeasured = timingSchema.parse({
      ...timing,
      judge_seconds: null,
      judge_model_ms: null,
      fractions: { ...timing.fractions, judge_model: null },
    });
    expect(unmeasured.judge_seconds).toBeNull();
    expect(unmeasured.judge_model_ms).toBeNull();
    expect(unmeasured.fractions.judge_model).toBeNull();

    const measured = timingSchema.parse({
      ...timing,
      judge_seconds: 0,
      judge_model_ms: 0,
      fractions: { ...timing.fractions, judge_model: 0 },
    });
    expect(measured.judge_seconds).toBe(0);
    expect(measured.judge_model_ms).toBe(0);
    expect(unmeasured.judge_seconds).not.toBe(measured.judge_seconds);

    // Still a number where a number is served, and still refused where the value
    // could not be either.
    expect(() =>
      timingSchema.parse({ ...timing, judge_seconds: -1 }),
    ).toThrow();
    expect(() =>
      timingSchema.parse({ ...timing, judge_seconds: "unknown" }),
    ).toThrow();
  });
});

describe("agent roles", () => {
  /**
   * The vocabulary is open — a role is the member name a run's own graph declared,
   * under the run's word — and the one thing held is `oneagentgraph`'s grammar for
   * a member's name. Both halves are asserted: a word that grammar admits is a role
   * this client reads, and a word it does not is refused, so replacing the schema
   * with an unrestricted string fails here.
   */
  test("admits exactly the member names oneagentgraph's grammar admits", () => {
    for (const name of [
      "sentinel",
      "check-in",
      "a_name",
      "monitor",
      "ticker2",
      "PR-Author",
    ]) {
      expect(agentRoleSchema.parse(name)).toBe(name);
    }
    for (const name of ["", "a/b", "a b", "..", "sentinel\n", "role:x"]) {
      expect(() => agentRoleSchema.parse(name), name).toThrow();
    }
  });

  test("carries a run's own member names on a session link, a span and an attribution", () => {
    expect(
      sessionLinkSchema.parse({
        session_id: "dag-scope-1.sentinel",
        role: "agent",
        agent_role: "sentinel",
      }).agent_role,
    ).toBe("sentinel");
    expect(
      timelineSpanSchema.parse({
        id: "dispatch.node-scope-1.drafter",
        kind: "dispatch",
        label: "node-scope-1.drafter",
        started_at: "2026-07-26T12:00:00Z",
        ended_at: null,
        events: [],
        agent_role: "drafter",
        transport_role: "agent",
      }).agent_role,
    ).toBe("drafter");
    const attributed = {
      conversation: {
        canContinue: false,
        harnesses: ["oneagentgraph"],
        id: "node-scope-1.drafter",
        name: "draft",
        project: "run-1",
        startedAt: "2026-07-26T12:00:00Z",
        state: "turn-started",
        turns: [],
      },
      attribution: { transportRole: "agent", agentRole: "drafter" },
    };
    expect(dagConversationSchema.parse(attributed).attribution.agentRole).toBe(
      "drafter",
    );
    // A session the run recorded no declared member for is attributed none, and
    // that is a conversation this client reads rather than refuses.
    expect(
      dagConversationSchema.parse({
        ...attributed,
        attribution: { transportRole: "agent" },
      }).attribution.agentRole,
    ).toBeUndefined();
    expect(() =>
      dagConversationSchema.parse({
        ...attributed,
        attribution: { transportRole: "agent", agentRole: "not a member" },
      }),
    ).toThrow();
  });
});

describe("boundary failures", () => {
  test("rejects incompatible API versions and negative counters", () => {
    expect(() =>
      parseRunList({
        api_version: 3,
        telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        runs: [],
      }),
    ).toThrow();
    expect(() =>
      sessionLinkSchema.parse({
        session_id: "session",
        role: "agent",
        turn_index: -1,
      }),
    ).toThrow();
  });

  test("rejects a detail with an unsupported projected state", () => {
    const result = runDetailSchema.safeParse({
      api_version: 2,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      run: {},
      graph: { node_states: { build: "paused" } },
      conversations: [],
    });
    expect(result.success).toBe(false);
  });

  test("accepts the served node status and rejects one outside the vocabulary", () => {
    const graph = {
      run_id: "run-1",
      plan: {
        tasks: [{ id: "build", task: "Build it" }],
        goal: { id: "ship-it", text: "Ship it safely" },
      },
      node_states: {},
      node_status: { build: "skipped" },
      node_gated_by: {},
      node_control: {},
      node_results: {},
      decisions: [],
      attestations: [],
      result: null,
      last_seq: 2,
    };
    expect(graphStateSchema.parse(graph).node_status.build).toBe("skipped");
    expect(graphStateSchema.parse(graph).plan.goal?.text).toBe(
      "Ship it safely",
    );
    expect(
      graphStateSchema.safeParse({
        ...graph,
        plan: { ...graph.plan, goal: { id: "ship-it" } },
      }).success,
    ).toBe(false);
    // A status the vocabulary does not hold is refused at the parse rather than
    // reaching a renderer that has no meaning for it.
    expect(
      graphStateSchema.safeParse({ ...graph, node_status: { build: "paused" } })
        .success,
    ).toBe(false);
    // And the field itself is required: a payload without it would leave a client
    // inventing the status for every node, which is the defect this replaced.
    expect(
      graphStateSchema.safeParse({ ...graph, node_status: undefined }).success,
    ).toBe(false);
    expect(
      graphStateSchema.safeParse({ ...graph, node_status: {} }).success,
    ).toBe(false);
    expect(
      graphStateSchema.safeParse({
        ...graph,
        node_status: { build: "skipped", extra: "pending" },
      }).success,
    ).toBe(false);
    expect(
      graphStateSchema.safeParse({
        ...graph,
        plan: {
          tasks: [
            { id: "build", task: "Build it" },
            { id: "build", task: "Build it again" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      graphStateSchema.safeParse({
        ...graph,
        node_gated_by: { build: ["missing"] },
      }).success,
    ).toBe(false);
  });

  test("carries whether the run has a turn it can reach for each in-flight node", () => {
    const graph = {
      run_id: "run-1",
      plan: { tasks: [{ id: "build", task: "Build it" }] },
      node_states: { build: "running" },
      node_status: { build: "running" },
      node_gated_by: {},
      node_control: { build: { addressable: true, member: "worker" } },
      node_results: {},
      decisions: [],
      attestations: [],
      result: null,
      last_seq: 2,
    };
    expect(graphStateSchema.parse(graph).node_control.build?.member).toBe(
      "worker",
    );
    // Not interruptible carries the reason, and a node that is carries none: the
    // two are exactly exclusive, so neither can be read as the other.
    expect(
      graphStateSchema.parse({
        ...graph,
        node_control: {
          build: {
            addressable: false,
            reason: "no out-of-band turn control",
          },
        },
      }).node_control.build?.reason,
    ).toBe("no out-of-band turn control");
    expect(
      graphStateSchema.safeParse({
        ...graph,
        node_control: { build: { addressable: false } },
      }).success,
    ).toBe(false);
    expect(
      graphStateSchema.safeParse({
        ...graph,
        node_control: {
          build: { addressable: true, reason: "between turns" },
        },
      }).success,
    ).toBe(false);
    // The field is required, and it may name only nodes the graph has in flight:
    // a node with no turn has nothing to redirect, and an entry for one would read
    // as an answer about work that is not happening.
    expect(
      graphStateSchema.safeParse({ ...graph, node_control: undefined }).success,
    ).toBe(false);
    expect(
      graphStateSchema.safeParse({
        ...graph,
        node_status: { build: "done" },
        node_states: { build: "done" },
      }).success,
    ).toBe(false);
  });

  test("types the failure classification served on a run and on a node", () => {
    expect(
      runTelemetrySchema.parse({
        ...RUN_TELEMETRY,
        failure: { class: "gate", detail: "just gate failed" },
      }).failure?.class,
    ).toBe("gate");
    expect(
      nodeTelemetrySchema.parse({
        node: "build",
        status: "failed",
        sessions: [],
        turns: 1,
        lint: 0,
        timing_quality: "complete",
        linkage_quality: "native",
        timing_presence: TIMING_PRESENCE,
        failure: { class: "timeout" },
      }).failure,
    ).toEqual({ class: "timeout" });
    // `kind` is not this field's key, and a class outside the vocabulary is not one
    // of its values; both would otherwise reach the banner as an empty heading.
    expect(
      nodeTelemetrySchema.safeParse({
        node: "build",
        status: "failed",
        sessions: [],
        turns: 1,
        lint: 0,
        timing_quality: "complete",
        linkage_quality: "native",
        timing_presence: TIMING_PRESENCE,
        failure: { class: "flaky" },
      }).success,
    ).toBe(false);
  });

  test("carries the release that carried a node's work, or carries none", () => {
    // Absent is a node the run recorded no release for, which is most of them and
    // every node of every payload served before this key existed.
    expect(
      graphResultItemSchema.parse({ status: "done", pr: "https://x/pull/7" })
        .release,
    ).toBeUndefined();
    // Present, beside the change request rather than in place of it.
    expect(
      graphResultItemSchema.parse({
        status: "done",
        pr: "https://x/pull/7",
        release: {
          identity: "github.com/nickderobertis/onevcs",
          target: "crate",
          style: "automated",
          version: "0.13.0",
        },
      }).release,
    ).toEqual({
      identity: "github.com/nickderobertis/onevcs",
      target: "crate",
      style: "automated",
      version: "0.13.0",
    });
    // An envelope written before `style` existed carries none, and the node whose
    // release it is is still a node a reader opens.
    expect(
      graphResultItemSchema.parse({
        status: "done",
        release: {
          identity: "github.com/nickderobertis/onevcs",
          target: "crate",
          version: "0.13.0",
        },
      }).release?.style,
    ).toBeUndefined();
    // Null is what a server that has the key and nothing to put in it serves, and
    // it parses on the same terms `pr` does.
    expect(
      graphResultItemSchema.parse({ status: "done", release: null }).release,
    ).toBeNull();
    // The three fields a release *is*. A payload missing any of them is not a
    // release a reader could go and install, and is refused rather than rendered
    // half-blank.
    for (const missing of ["identity", "target", "version"]) {
      const release: Record<string, string> = {
        identity: "github.com/nickderobertis/onevcs",
        target: "crate",
        version: "0.13.0",
      };
      delete release[missing];
      expect(
        graphResultItemSchema.safeParse({ status: "done", release }).success,
      ).toBe(false);
    }
  });

  test("rejects malformed nested plan and result payloads", () => {
    expect(() =>
      planTaskSchema.parse({
        id: "release",
        task: "Release",
        steps: [{ id: "approve", kind: "human", task: 42 }],
      }),
    ).toThrow();
    expect(() =>
      graphResultItemSchema.parse({
        status: "done",
        steps: [{ id: "build", kind: "agent", persona: null }],
      }),
    ).toThrow();
    expect(() =>
      graphPayloadSchema.parse({
        ok: true,
        results: { build: { deferred_cleanup: "not-a-list" } },
      }),
    ).toThrow();
  });
});

describe("run timeline", () => {
  const span = {
    id: "node-1-api",
    kind: "node",
    label: "api",
    started_at: "2026-07-26T12:00:00Z",
    ended_at: null,
    events: [
      {
        id: "event-4",
        kind: "pr-created",
        at: "2026-07-26T12:00:01Z",
        node_id: "api",
        graph: 1,
        status: "OPEN",
        reference: { kind: "pr", value: "https://x/pull/7" },
      },
    ],
  };

  test("accepts an open span, a rollup, and reference-only heavy content", () => {
    const timeline = parseRunTimeline({
      api_version: 2,
      timeline_schema_version: TIMELINE_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      run_id: "demo",
      spans: [
        span,
        {
          id: "rollup-lock-wait-9",
          kind: "rollup",
          label: "lock-wait",
          started_at: "2026-07-26T12:00:02Z",
          ended_at: "2026-07-26T12:00:09Z",
          parent_id: "node-1-api",
          node_id: "api",
          count: 1722,
          total_duration_ms: 430500,
          events: [],
        },
        {
          id: "dispatch-lint-1",
          kind: "dispatch",
          label: "llmlint-diff",
          started_at: "2026-07-26T12:00:03Z",
          ended_at: null,
          parent_id: "dispatch-worker-1",
          events: [],
          reference: { kind: "conversation", value: "lint-1" },
        },
      ],
    });
    // A live run is representable: the node has started and has not finished.
    expect(timeline.spans[0]?.ended_at).toBeNull();
    expect(timeline.spans[0]?.events[0]?.reference?.value).toBe(
      "https://x/pull/7",
    );
    expect(timeline.spans[1]?.count).toBe(1722);
    // Nesting travels as a parent link, so a lint run is not a sibling dispatch.
    expect(timeline.spans[2]?.parent_id).toBe("dispatch-worker-1");
  });

  test("reads a queued span's reasons, and refuses them anywhere else", () => {
    const queued = {
      id: "queued.api.4",
      kind: "queued",
      label: "api",
      started_at: "2026-07-26T12:00:01Z",
      ended_at: "2026-07-26T12:00:09Z",
      parent_id: "node-1-api",
      node_id: "api",
      events: [],
      reasons: [
        { kind: "concurrency", ahead: ["build", "migrate"], limit: 2 },
        { kind: "decision", reference: "surface:7" },
      ],
    };
    const timeline = parseRunTimeline({
      api_version: 2,
      timeline_schema_version: TIMELINE_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      run_id: "demo",
      spans: [span, queued],
    });
    // Two reasons at once, each with its own kind's own fields: what tells a node
    // held by two things from a node held by one.
    expect(timeline.spans[1]?.reasons).toHaveLength(2);
    expect(timeline.spans[1]?.reasons?.[0]?.ahead).toEqual([
      "build",
      "migrate",
    ]);
    expect(timeline.spans[1]?.reasons?.[1]?.reference).toBe("surface:7");
    // A reason a later engine writes is read rather than refused: the vocabulary
    // is that engine's, and dropping an entry would turn held-by-two into
    // held-by-one.
    expect(
      parseRunTimeline({
        api_version: 2,
        timeline_schema_version: TIMELINE_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        run_id: "demo",
        spans: [{ ...queued, reasons: [{ kind: "budget" }] }],
      }).spans[0]?.reasons?.[0]?.kind,
    ).toBe("budget");
    // But a hold on something that is not a hold span is not a payload this client
    // renders: the span vocabulary is this contract's own and closed, so the
    // pairing is an invariant it owns rather than a producer's to redefine.
    expect(() =>
      parseRunTimeline({
        api_version: 2,
        timeline_schema_version: TIMELINE_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        run_id: "demo",
        spans: [{ ...queued, id: "node-1-api", kind: "node" }],
      }),
    ).toThrow(/queued span/);
  });

  test("carries the redirection a turn-interrupted or a context edit was", () => {
    const redirected = timelineEventSchema.parse({
      id: "e9",
      kind: "turn-interrupted",
      at: "2026-07-26T12:00:05Z",
      node_id: "api",
      redirection: { delivered: true, member: "worker", input_bytes: 41 },
    });
    expect(redirected.redirection?.delivered).toBe(true);
    expect(
      timelineEventSchema.parse({
        id: "e10",
        kind: "edit-committed",
        at: "2026-07-26T12:00:06Z",
        redirection: { delivered: false, delivery: "deferred", node_id: "api" },
      }).redirection?.delivery,
    ).toBe("deferred");
    // A delivery that landed has no reason it did not, and a mode outside the two
    // the SDK records is refused rather than rendered as though it were one.
    expect(
      timelineEventSchema.safeParse({
        ...redirected,
        redirection: { delivered: true, reason: "between turns" },
      }).success,
    ).toBe(false);
    expect(
      timelineEventSchema.safeParse({
        ...redirected,
        redirection: { delivered: false, delivery: "soon" },
      }).success,
    ).toBe(false);
    // The engine's own word for which party took a note rides beside the pair,
    // and its one word for nobody reads as not delivered. A word outside its
    // closed set is refused on the same terms as a third delivery mode.
    expect(
      timelineEventSchema.parse({
        id: "e10",
        kind: "edit-committed",
        at: "2026-07-26T12:00:06Z",
        redirection: {
          reached: "carried",
          delivered: false,
          delivery: "deferred",
          node_id: "api",
        },
      }).redirection?.reached,
    ).toBe("carried");
    expect(
      timelineEventSchema.safeParse({
        ...redirected,
        redirection: {
          reached: "nobody",
          delivered: false,
          delivery: "deferred",
        },
      }).success,
    ).toBe(false);
    // An ordinary record carries none, and is still a valid event.
    expect(
      timelineEventSchema.parse({
        id: "e11",
        kind: "node-settled",
        at: "2026-07-26T12:00:07Z",
      }).redirection,
    ).toBeUndefined();
  });

  test("carries what a release record said, and tells the two waits apart", () => {
    // The wait a person has to be told about carries the action; the wait beside
    // it, on the same record, does not — which is the whole of how a reader picks
    // one out from the other.
    const held = timelineEventSchema.parse({
      id: "e12",
      kind: "release-wait",
      at: "2026-07-26T12:00:08Z",
      node_id: "api",
      release: {
        awaiting: [
          {
            dep: "sdk",
            identity: "github.com/example/sdk",
            target: "crate",
            style: "automated",
            since: "2026-07-26T11:55:00Z",
            waited_seconds: 300,
            last_answer: "not-released",
          },
          {
            dep: "sdk",
            identity: "github.com/example/sdk",
            target: "npm",
            style: "human-step",
            action: "publish the npm wrapper",
            since: "2026-07-26T11:55:00Z",
            waited_seconds: 300,
            last_answer: "awaiting-human-step",
          },
        ],
      },
    });
    expect(
      held.release?.awaiting?.map((entry) => [entry.style, entry.action]),
    ).toEqual([
      ["automated", undefined],
      ["human-step", "publish the npm wrapper"],
    ]);
    // The observation the node item's own release is derived from, carrying the
    // commit that join is made on.
    expect(
      timelineEventSchema.parse({
        id: "e13",
        kind: "release-observed",
        at: "2026-07-26T12:00:09Z",
        release: {
          identity: "github.com/example/sdk",
          target: "crate",
          style: "automated",
          version: "1.4.0",
          landing_commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334",
        },
      }).release?.landing_commit,
    ).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f001122334");
    // A release that says nothing is not a release record: the server serves none
    // rather than an empty object, which would reach a reader as a heading over a
    // blank panel.
    expect(
      timelineEventSchema.safeParse({ ...held, release: {} }).success,
    ).toBe(false);
    // An entry naming nothing it waits on says nothing at all, and an empty list
    // would read as a node held on nothing rather than as a node not held.
    expect(
      timelineEventSchema.safeParse({
        ...held,
        release: { awaiting: [{ identity: "github.com/example/sdk" }] },
      }).success,
    ).toBe(false);
    expect(
      timelineEventSchema.safeParse({ ...held, release: { awaiting: [] } })
        .success,
    ).toBe(false);
    // And every other record carries none, which is what keeps this key a fact
    // about the six kinds rather than a shape every event grew.
    expect(
      timelineEventSchema.parse({
        id: "e14",
        kind: "node-settled",
        at: "2026-07-26T12:00:10Z",
      }).release,
    ).toBeUndefined();
  });

  test("rejects an unsupported span kind, reference kind, or negative rollup", () => {
    expect(() =>
      timelineSpanSchema.parse({ ...span, kind: "guess" }),
    ).toThrow();
    expect(() =>
      timelineReferenceSchema.parse({ kind: "transcript", value: "x" }),
    ).toThrow();
    expect(() =>
      timelineSpanSchema.parse({ ...span, kind: "rollup", count: -1 }),
    ).toThrow();
    // ended_at is nullable, never absent, and never a non-timestamp string.
    expect(() =>
      timelineSpanSchema.parse({ ...span, ended_at: "recently" }),
    ).toThrow();
    expect(() =>
      parseRunTimeline({
        api_version: 3,
        timeline_schema_version: TIMELINE_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        run_id: "demo",
        spans: [],
      }),
    ).toThrow();
  });
});

describe("shutdown", () => {
  const envelope = {
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-09-21T12:00:00Z",
  };
  const report = {
    ...envelope,
    scope: "host",
    root: "/runs",
    grace_seconds: 600,
    forced: false,
    complete: false,
    runs: [
      {
        run_id: "run-1",
        owner: "[codex:160c290a]",
        forced_over_owner: true,
        dispatches: [
          {
            node: "build",
            pid: 4242,
            interrupt: "no-turn",
            detail: "nothing of this dispatch has named a turn to interrupt",
            ended: "killed",
            waited_ms: 600_000,
          },
        ],
        teardown: "signalled",
        branches: [
          {
            identity: "work",
            branch: "feature/build",
            result: "refused",
            remote: null,
            commit: null,
            detail: "no such identity",
          },
        ],
      },
    ],
    not_pushed: [{ identity: "work", branch: "feature/other" }],
    not_pushed_unread: null,
    rendered: "shutdown  scope host  grace 600s\n",
  };

  test("reads the engine's report of a shutdown, incomplete as well as complete", () => {
    const parsed = shutdownReportSchema.parse(report);
    expect(parsed.complete).toBe(false);
    expect(parsed.runs[0]?.dispatches[0]?.ended).toBe("killed");
    expect(parsed.runs[0]?.branches[0]?.remote).toBeNull();
    expect(parsed.not_pushed).toEqual([
      { identity: "work", branch: "feature/other" },
    ]);
    // A list that could not be read travels as the reason, never as none.
    expect(
      shutdownReportSchema.parse({
        ...report,
        not_pushed: [],
        not_pushed_unread: "ONEVCS_HOME is not readable",
      }).not_pushed_unread,
    ).toBe("ONEVCS_HOME is not readable");
  });

  test("refuses a report whose closed words are outside the engine's", () => {
    const withDispatch = (patch: Record<string, unknown>) => ({
      ...report,
      runs: [
        {
          ...report.runs[0],
          dispatches: [{ ...report.runs[0]?.dispatches[0], ...patch }],
        },
      ],
    });
    expect(() =>
      shutdownReportSchema.parse(withDispatch({ ended: "vanished" })),
    ).toThrow();
    expect(() =>
      shutdownReportSchema.parse(withDispatch({ interrupt: "ignored" })),
    ).toThrow();
    expect(() =>
      shutdownReportSchema.parse({ ...report, scope: "everything" }),
    ).toThrow();
    expect(() =>
      shutdownReportSchema.parse({ ...report, complete: "yes" }),
    ).toThrow();
  });

  test("names the routes, the two scopes a body takes, and the engine's default grace", () => {
    expect(API_V2_PATHS.runShutdown("run/1")).toBe(
      "/api/v2/runs/run%2F1/shutdown",
    );
    expect(API_V2_PATHS.shutdown).toBe("/api/v2/shutdown");
    expect(hostShutdownScopeSchema.options).toEqual(["mine", "host"]);
    expect(SHUTDOWN_DEFAULT_GRACE_SECONDS).toBe(600);
  });

  test("reads the acting session's key off the unwatched report, and its absence", () => {
    const base = { ...envelope, reported: [], unresolved: [] };
    expect(
      unwatchedSchema.parse({ ...base, session_key: "5e551040abcd" })
        .session_key,
    ).toBe("5e551040abcd");
    expect(unwatchedSchema.parse(base).session_key).toBeUndefined();
    expect(() => unwatchedSchema.parse({ ...base, session_key: "" })).toThrow();
  });
});
