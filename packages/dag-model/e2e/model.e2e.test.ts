import { readFile } from "node:fs/promises";
// eslint-disable-next-line @nx/enforce-module-boundaries -- This verifies the package export as a consumer uses it.
import {
  adoptedSchema,
  channelNextSchema,
  channelQueueSchema,
  conversationSchema,
  conversationTurnSchema,
  dagConversationSchema,
  graphStateSchema,
  launchProvenanceSchema,
  nodeConversationsSchema,
  nodeTelemetrySchema,
  parseRunDetail,
  parseRunList,
  parseRunTimeline,
  planTaskSchema,
  projectDetailSchema,
  projectListSchema,
  REPLY_ENVELOPE_VERSION,
  REPLY_OPS,
  renderedRootSchema,
  renderedRunSchema,
  replyCommandSchema,
  replyEnvelopeSchema,
  replyReceiptSchema,
  runConversationsSchema,
  runDetailSchema,
  runStatusSchema,
  runSummarySchema,
  runTelemetryDocumentSchema,
  runTranscriptSchema,
  sessionLinkSchema,
  sseEventNameSchema,
  stoppedSchema,
  surfacedSchema,
  TELEMETRY_SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
  unwatchedSchema,
  watchEventNameSchema,
  watchFrameDataSchema,
} from "@onepipeline-ui/dag-model";
import { expect, test } from "vitest";
import { z } from "zod";

/**
 * One document of the client contract corpus beside this file.
 *
 * These are payloads a conforming server serves, kept here rather than derived from
 * any one server's output: this package is the *client* half of `docs/contract.md`,
 * and a parser that only ever sees what this repository's own server happens to emit
 * would narrow to it. `this repository's own served goldens parse` below is the other
 * half — it holds those two in agreement.
 */
// The return type is `JSON.parse`'s own: a corpus document is read as the untyped
// payload a browser receives, which is exactly what the parsers under test narrow.
async function corpus(name: string) {
  return JSON.parse(
    await readFile(new URL(`./corpus/${name}`, import.meta.url), "utf8"),
  );
}

/** One payload this repository's own server serves, as `tests/contract.rs` pins it. */
async function served(name: string) {
  return JSON.parse(
    await readFile(
      new URL(`../../../tests/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

/**
 * The document both halves of the contract are quoted from, so the versions this
 * package pins are held to the ones it names — `tests/contract.rs` holds the
 * server's copy to the same text, which is what puts the server, this client and
 * the document in one place or fails all three.
 */
async function contractText() {
  return readFile(
    new URL("../../../docs/contract.md", import.meta.url),
    "utf8",
  );
}

test("the schema versions this client pins are the ones the contract names", async () => {
  const text = await contractText();
  expect(text).toContain(`schema ${TELEMETRY_SCHEMA_VERSION}`);
  expect(text).toContain(`Timeline schema ${TIMELINE_SCHEMA_VERSION}`);
});

const zeroTiming = {
  agent_seconds: 0,
  judge_seconds: 0,
  llmlint_seconds: 0,
  gate_seconds: 0,
  publication_wait_seconds: 0,
  lock_wait_seconds: 0,
  setup_seconds: 0,
  scheduling_seconds: 0,
  wall_seconds: 0,
  agent_model_ms: 0,
  judge_model_ms: 0,
  llmlint_model_ms: 0,
  tool_ms: 0,
  idle_orchestration_ms: 0,
  unattributed_ms: 0,
  wall_ms: 0,
  fractions: {
    agent_model: 0,
    judge_model: 0,
    llmlint_model: 0,
    tool: 0,
    idle_orchestration: 0,
    lock_wait: 0,
    setup: 0,
    scheduling: 0,
  },
};

test("a package consumer validates an API response through the public export", () => {
  expect(
    parseRunList({
      api_version: 2,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      runs: [],
    }).runs,
  ).toEqual([]);
});

test("the checked-in v2 run-detail contract parses and v1 is rejected", async () => {
  const golden = await corpus("run-detail-v2.json");
  const parsed = parseRunDetail(golden);
  expect(parsed.graph?.node_status.release).toBe("blocked");
  expect(parsed.graph?.node_gated_by.release).toEqual(["approve"]);
  // The one thing a continuous engine pauses for, and it pauses only what depends
  // on it: `release` is held behind a human action nobody has attested.
  expect(parsed.graph?.decisions).toEqual([
    { id: "approve", kind: "human-action", unblocks: ["release"] },
  ]);
  expect(() => parseRunDetail({ ...golden, api_version: 1 })).toThrow();
});

test("the checked-in v2 run-timeline contract parses, and v1's meaning is refused", async () => {
  // The client half of the contract, parsed with the schema a browser parses with:
  // a conforming server may serve exactly this, whatever this repository's own
  // server happens to record.
  const golden = await corpus("run-timeline-v2.json");
  const parsed = parseRunTimeline(golden);
  expect(parsed.timeline_schema_version).toBe(TIMELINE_SCHEMA_VERSION);

  // The pair a rollup of dispatches carries is what names the category it summarized,
  // and it survives the round trip: a worker and the lint run that carries the
  // worker's own semantic role are two categories, told apart by the transport alone.
  const summaries = parsed.spans.filter((span) => span.kind === "rollup");
  expect(
    summaries
      .filter((span) => span.agent_role !== undefined)
      .map((span) => [span.agent_role, span.transport_role]),
  ).toEqual([
    ["worker", "agent"],
    ["worker", "llmlint"],
  ]);
  // And a rollup of anything else carries neither key at all rather than a null one,
  // so "not a dispatch" cannot be read as "a dispatch whose role went missing".
  const others = summaries.filter((span) => span.agent_role === undefined);
  expect(others.map((span) => span.label)).toEqual([
    "rollup",
    "verification",
    "human-wait",
  ]);
  expect(others.every((span) => !("transport_role" in span))).toBe(true);

  // The releases a conforming server relays. The wait that needs a person told is
  // told apart from the one beside it by the action it carries and nothing else,
  // and the observation carries the commit a node item's own release is joined to
  // it by.
  const events = parsed.spans.flatMap((span) => span.events);
  const held = events.find((event) => event.kind === "release-wait");
  expect(
    held?.release?.awaiting?.map((entry) => [entry.style, entry.action]),
  ).toEqual([
    ["automated", undefined],
    ["human-step", "publish the npm wrapper from the tagged release"],
  ]);
  expect(
    events.find((event) => event.kind === "release-observed")?.release,
  ).toEqual({
    identity: "github.com/example/sdk",
    target: "crate",
    style: "automated",
    version: "1.4.0",
    landing_commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334",
  });

  // A payload on the other meaning of that pair is refused rather than rendered as
  // though it agreed with this one.
  expect(() =>
    parseRunTimeline({ ...golden, timeline_schema_version: 1 }),
  ).toThrow();
  expect(() => parseRunTimeline({ ...golden, api_version: 1 })).toThrow();
});

test("the goal id the read boundary derives is what makes a legacy run parse", async () => {
  // A conforming server derives this fixture's `plan.goal.id`; the run behind it
  // recorded text alone. Without that id the contract rejects the whole detail.
  const golden = await corpus("run-detail-v2.json");
  expect(parseRunDetail(golden).graph?.plan.goal).toEqual({
    id: "Ship-the-gated-release",
    text: "Ship the gated release",
  });

  const legacy = {
    ...golden,
    graph: {
      ...golden.graph,
      plan: {
        ...golden.graph.plan,
        goal: { text: golden.graph.plan.goal.text },
      },
    },
  };
  expect(() => parseRunDetail(legacy)).toThrow();
});

/** The legacy plan shapes a server serves verbatim, from the same committed corpus. */
// Tuple literals keep each fixture name visible to test.each instead of widening to string[].
const LEGACY_RUNS = ["legacy-resume-object", "legacy-steps-node"] as const;

async function legacyGraph(run: string) {
  const plan = await corpus(`legacy-runs/${run}.plan.json`);
  const ids: string[] = plan.tasks.map((task: { id: string }) => task.id);
  return {
    run_id: run,
    plan,
    node_states: Object.fromEntries(ids.map((id) => [id, "running"])),
    node_status: Object.fromEntries(ids.map((id) => [id, "running"])),
    node_gated_by: {},
    // Every node of a legacy plan reads as running above, so every one of them has
    // a turn this run can address — which is the shape a run with work in flight
    // really has.
    node_control: Object.fromEntries(
      ids.map((id) => [id, { addressable: true, member: "worker" }]),
    ),
    node_results: {},
    decisions: [],
    attestations: [],
    result: null,
    last_seq: 3,
  };
}

test.each(LEGACY_RUNS)(
  "the %s corpus fixture parses as the contract's own plan shape",
  async (run) => {
    // The browser side of `tests/contract.rs`'s golden check, over the same
    // committed bytes: a read API serves these plans unchanged, so a schema that
    // rejects them here is a run the operator cannot open.
    const golden = await corpus("run-detail-v2.json");
    const parsed = parseRunDetail({
      ...golden,
      graph: await legacyGraph(run),
    });
    expect(parsed.graph?.plan.tasks).toHaveLength(1);
  },
);

test("a replanned task's resume is metadata, and a boolean is refused", () => {
  const resume = {
    branch: "ai-orchestrator/engineer/57c0ec21-839e730418",
    base_branch: "main",
    pr_base: "main",
    checkpoint: "e9fff0a79319e8d840357f1e7055c64f11eaee62",
    mode: "retry",
  };
  expect(
    planTaskSchema.parse({ id: "node-timeline", task: "Continue", resume })
      .resume,
  ).toEqual(resume);
  // What the contract used to say, and what nothing has ever recorded.
  expect(
    planTaskSchema.safeParse({ id: "n", task: "Continue", resume: true })
      .success,
  ).toBe(false);
  // A branch alone does not locate preserved work; the four locators are required.
  expect(
    planTaskSchema.safeParse({
      id: "n",
      task: "Continue",
      resume: { branch: "engineer/preserved" },
    }).success,
  ).toBe(false);
  // Anchors are mappings, never bare branch names.
  expect(
    planTaskSchema.safeParse({
      id: "n",
      task: "Continue",
      stack_bases: ["engineer/preserved"],
    }).success,
  ).toBe(false);
});

test("only a steps-shaped task may omit its own prose", () => {
  expect(
    planTaskSchema.parse({
      id: "ivr-real-api",
      repo: "petsinc/org-apps",
      steps: [{ id: "build", persona: "engineer", task: "Build it" }],
    }).task,
  ).toBeUndefined();
  // Everything else still owes the contract prose, so a blank agent or human node
  // stays a violation rather than an empty node view.
  expect(planTaskSchema.safeParse({ id: "build" }).success).toBe(false);
  expect(
    planTaskSchema.safeParse({ id: "approve", kind: "human" }).success,
  ).toBe(false);
  // A *step* has nowhere else to put its prose, so it still requires it.
  expect(
    planTaskSchema.safeParse({ id: "n", steps: [{ id: "build" }] }).success,
  ).toBe(false);
});

test("a package consumer rejects incompatible list and detail payloads", () => {
  expect(() =>
    parseRunList({
      api_version: 3,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      runs: [],
    }),
  ).toThrow();
  expect(
    runDetailSchema.safeParse({
      api_version: 2,
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      run: {},
      graph: { node_states: { build: "paused" } },
      conversations: [],
    }).success,
  ).toBe(false);
});

const TRANSCRIPT = {
  conversation: {
    canContinue: false,
    harnesses: ["codex"],
    id: "worker-session",
    name: "engineer-build",
    project: "repo",
    startedAt: "2026-07-26T12:00:00Z",
    state: "completed",
    turns: [],
  },
  attribution: {
    runId: "run-1",
    nodeId: "build",
    transportRole: "agent",
    agentRole: "worker",
  },
};

/** A complete `RunDetail` whose transcripts are supplied in the shape under test. */
function completeDetail(conversations: unknown[]) {
  const usageParty = {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
  };
  const timing = {
    agent_seconds: 0,
    judge_seconds: 0,
    llmlint_seconds: 0,
    gate_seconds: 0,
    publication_wait_seconds: 0,
    lock_wait_seconds: 0,
    setup_seconds: 0,
    scheduling_seconds: 0,
    wall_seconds: 0,
    agent_model_ms: 0,
    judge_model_ms: 0,
    llmlint_model_ms: 0,
    tool_ms: 0,
    idle_orchestration_ms: 0,
    unattributed_ms: 0,
    wall_ms: 0,
    fractions: {
      agent_model: 0,
      judge_model: 0,
      llmlint_model: 0,
      tool: 0,
      idle_orchestration: 0,
      lock_wait: 0,
      setup: 0,
      scheduling: 0,
    },
  };
  return {
    api_version: 2,
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    run: {
      run_id: "run-1",
      state: "running",
      phase: "agent",
      last_event: "node-started",
      timing,
      nodes: [],
      usage: {
        agent: usageParty,
        judge: usageParty,
        llmlint: usageParty,
        total: usageParty,
      },
      timing_quality: "complete",
      linkage_quality: "native",
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
    },
    graph: null,
    conversations,
  };
}

test("a package consumer accepts a complete run detail", () => {
  // The read API serves one flat list of transcripts, each carrying its own node
  // locator, exactly as `docs/contract.md` fixes `RunDetail.conversations`.
  const parsed = parseRunDetail(completeDetail([TRANSCRIPT]));
  expect(parsed.run.run_id).toBe("run-1");
  expect(parsed.conversations[0]?.attribution.nodeId).toBe("build");
});

test("a package consumer accepts a run detail grouped by node", () => {
  // A payload written against the grouped shape stays valid and reads as the same
  // list, so one consumer handles both without knowing which it was handed.
  const parsed = parseRunDetail(
    completeDetail([{ node: "build", conversations: [TRANSCRIPT] }]),
  );
  expect(parsed.conversations).toEqual([TRANSCRIPT]);
});

test("a package consumer reads both recorded conversation shapes as one list", () => {
  // What the read API serves: one flat list, each entry carrying its own locator.
  expect(runConversationsSchema.parse([TRANSCRIPT])).toEqual([TRANSCRIPT]);
  // What a payload grouped under `nodeConversationsSchema` carries: still valid, and
  // flattened to the same list so one consumer handles both.
  expect(
    runConversationsSchema.parse([
      { node: "build", conversations: [TRANSCRIPT] },
      { conversations: [] },
    ]),
  ).toEqual([TRANSCRIPT]);
  // The grouped entry keeps validating on its own, for a consumer holding just one.
  expect(
    nodeConversationsSchema.parse({
      node: "build",
      conversations: [TRANSCRIPT],
    }).node,
  ).toBe("build");
  expect(() => runConversationsSchema.parse([{ node: "build" }])).toThrow();
  expect(() => nodeConversationsSchema.parse({ node: "build" })).toThrow();
});

test("a package consumer validates provenance, SSE names, and counters", () => {
  expect(
    launchProvenanceSchema.parse({
      schema_version: 1,
      launch_id: "launch",
      launcher: "codex",
      launcher_session_id: "session",
      started_at: "2026-07-26T12:00:00Z",
      repository_identity: "local/repo",
    }).launcher,
  ).toBe("codex");
  expect(sseEventNameSchema.parse("run.changed")).toBe("run.changed");
  expect(sseEventNameSchema.parse("activity.changed")).toBe("activity.changed");
  expect(() => sseEventNameSchema.parse("run.created")).toThrow();
  expect(() =>
    sessionLinkSchema.parse({
      session_id: "session",
      role: "agent",
      turn_index: -1,
    }),
  ).toThrow();
});

test("a package consumer validates the graph and conversations", () => {
  const graph = graphStateSchema.parse({
    run_id: "run-1",
    plan: {
      tasks: [
        { id: "build", task: "Build it" },
        { id: "ship", task: "Ship it", deps: ["build"] },
        { id: "announce", task: "Announce it", deps: ["ship"] },
      ],
      schema_version: 5,
    },
    node_states: { build: "done", ship: "waiting" },
    // Served for every plan task, including the one the journal never recorded.
    node_status: { build: "done", ship: "waiting", announce: "blocked" },
    node_gated_by: { announce: ["ship"] },
    node_control: {},
    node_results: { build: { status: "done" } },
    decisions: [],
    attestations: [],
    result: null,
    last_seq: 3,
  });
  expect(graph.node_states.build).toBe("done");
  expect(graph.node_status.announce).toBe("blocked");
  expect(graph.node_gated_by.announce).toEqual(["ship"]);
  const conversation = {
    canContinue: false,
    harnesses: ["codex"],
    id: "conversation-1",
    name: "Worker",
    project: "repo",
    startedAt: "2026-07-26T12:00:00Z",
    state: "completed",
    turns: [],
  };
  expect(conversationSchema.parse(conversation).id).toBe("conversation-1");
  expect(() =>
    conversationSchema.parse({ ...conversation, startedAt: "yesterday" }),
  ).toThrow();
});

test("a package consumer validates populated telemetry and attribution", () => {
  expect(
    runSummarySchema.parse({
      run_id: "run-1",
      state: "running",
      phase: "agent",
      last_event: "node-started",
      timing_quality: "complete",
      linkage_quality: "native",
      timing: zeroTiming,
      node_counts: { running: 1 },
    }).node_counts.running,
  ).toBe(1);
  expect(
    nodeTelemetrySchema.parse({
      node: "build",
      status: "running",
      sessions: [{ session_id: "worker", role: "agent" }],
      turns: 1,
      lint: 0,
      timing_quality: "complete",
      linkage_quality: "native",
      timing_presence: {
        agent_model_ms: true,
        judge_model_ms: false,
        llmlint_model_ms: false,
        tool_ms: true,
      },
    }).sessions[0]?.session_id,
  ).toBe("worker");
  expect(
    dagConversationSchema.parse({
      conversation: {
        canContinue: false,
        harnesses: ["codex"],
        id: "conversation-1",
        name: "Worker",
        project: "repo",
        startedAt: "2026-07-26T12:00:00Z",
        state: "completed",
        turns: [],
      },
      attribution: {
        runId: "run-1",
        nodeId: "build",
        launcher: "codex",
        transportRole: "agent",
        agentRole: "worker",
      },
    }).attribution.nodeId,
  ).toBe("build");
});

test("a package consumer parses a served run timeline through the export", () => {
  const timeline = parseRunTimeline({
    api_version: 2,
    timeline_schema_version: TIMELINE_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    run_id: "run-1",
    spans: [
      {
        id: "run-run-1",
        kind: "run",
        label: "run-1",
        started_at: "2026-07-26T12:00:00Z",
        ended_at: null,
        events: [],
      },
      {
        id: "dispatch-worker-1",
        kind: "dispatch",
        label: "engineer-build",
        started_at: "2026-07-26T12:00:01Z",
        ended_at: "2026-07-26T12:04:00Z",
        parent_id: "run-run-1",
        node_id: "build",
        status: "completed",
        reference: { kind: "conversation", value: "worker-1" },
        events: [
          {
            id: "worker-1-0",
            kind: "conversation-turn",
            at: "2026-07-26T12:00:01Z",
            status: "completed",
            reference: { kind: "conversation", value: "worker-1" },
          },
        ],
      },
    ],
  });
  expect(timeline.spans[0]?.ended_at).toBeNull();
  expect(timeline.spans[1]?.events[0]?.reference?.kind).toBe("conversation");
});

test("a package consumer reads one dispatch's two sessions, its turn timing, and its waits", () => {
  const rollup = {
    id: "rollup-lock-wait-1",
    kind: "rollup",
    label: "lock-wait",
    started_at: "2026-07-26T12:00:00Z",
    ended_at: "2026-07-26T12:04:00Z",
    node_id: "build",
    count: 1240,
    total_duration_ms: 4200,
    intervals: [
      {
        started_at: "2026-07-26T12:00:00Z",
        ended_at: "2026-07-26T12:00:02Z",
      },
    ],
    events: [],
  };
  const timeline = parseRunTimeline({
    api_version: 2,
    timeline_schema_version: TIMELINE_SCHEMA_VERSION,
    observed_at: "2026-07-26T12:00:00Z",
    run_id: "run-1",
    spans: [
      {
        id: "dispatch-judge-1",
        kind: "dispatch",
        label: "you-are-a-careful-evaluator",
        started_at: "2026-07-26T12:02:00Z",
        ended_at: "2026-07-26T12:04:00Z",
        node_id: "build",
        agent_role: "judge",
        transport_role: "judge",
        // The two oneharness sessions of one onejudge dispatch share this key; the
        // supervisor's own span carries the agent session's id, not its own.
        dispatch_id: "worker-1",
        reference: { kind: "conversation", value: "judge-1" },
        events: [],
      },
      rollup,
    ],
  });
  expect(timeline.spans[0]?.dispatch_id).toBe("worker-1");
  expect(timeline.spans[1]?.intervals?.[0]?.ended_at).toBe(
    "2026-07-26T12:00:02Z",
  );
  // A wait the server could not place is refused rather than drawn somewhere.
  expect(() =>
    parseRunTimeline({
      api_version: 2,
      timeline_schema_version: TIMELINE_SCHEMA_VERSION,
      observed_at: "2026-07-26T12:00:00Z",
      run_id: "run-1",
      spans: [
        {
          ...rollup,
          intervals: [{ started_at: "whenever", ended_at: "then" }],
        },
      ],
    }),
  ).toThrow();

  const supervised = dagConversationSchema.parse({
    conversation: {
      canContinue: false,
      harnesses: ["claude-code"],
      id: "judge-1",
      name: "you-are-a-careful-evaluator",
      project: "repo",
      startedAt: "2026-07-26T12:02:00Z",
      state: "completed",
      turns: [
        {
          assistant: "looks good",
          failureKind: null,
          harness: "claude-code",
          id: "judge-1-0",
          model: "claude",
          reasoning: null,
          status: "completed",
          timestamp: "2026-07-26T12:04:00Z",
          tools: [],
          unknown: {},
          usage: {},
          user: "review",
          // The claude-code shape: no measured wall interval, only a duration.
          startedAt: null,
          finishedAt: null,
          durationMs: 120_000,
          modelMs: 90_000,
          toolMs: 0,
        },
      ],
    },
    attribution: {
      runId: "run-1",
      nodeId: "build",
      launcher: "codex",
      transportRole: "judge",
      agentRole: "judge",
      parentConversationId: "worker-1",
    },
  });
  const turn = supervised.conversation.turns[0];
  expect([turn?.startedAt, turn?.durationMs, turn?.modelMs]).toEqual([
    null,
    120_000,
    90_000,
  ]);
  expect(supervised.attribution.parentConversationId).toBe("worker-1");
  // A negative duration is not a measurement, whatever wrote it.
  expect(() =>
    conversationTurnSchema.parse({ ...turn, durationMs: -1 }),
  ).toThrow();
});

test("this repository's own served goldens parse through the public parsers", async () => {
  // The corpus above is what a conforming server may serve; these are what the axum
  // server in this repository actually does serve, pinned byte for byte by
  // `tests/contract.rs`. Reading both with the same parsers is what keeps the client
  // contract and `docs/contract.md` from drifting apart in either direction.
  const listed = parseRunList(await served("runs.json"));
  expect(listed.runs).toHaveLength(2);
  // Schema 18 on every served row: the group the run belongs to, its name, the
  // engine's liveness word, and the channel's unread count.
  for (const row of listed.runs) {
    expect(row.project).toBe("authoring:contract-interface");
    expect(row.project_name).toBe("contract");
    expect(row.liveness).toBe("PARKED");
    expect(row.unread_surfaces).toBe(0);
  }

  const detail = parseRunDetail(await served("run.json"));
  expect(detail.run.run_id).toBe(detail.graph?.run_id);
  expect(Object.keys(detail.graph?.node_status ?? {})).not.toHaveLength(0);

  // The node-scoped timeline names the dispatch that did the work, which is what
  // lets a client join a span to its transcript.
  const timeline = parseRunTimeline(await served("run-timeline.json"));
  expect(timeline.spans.map((span) => span.kind)).toEqual([
    "node",
    "dispatch",
    // One per piece of evidence the node's own records kept — its settled
    // member's report, its gate's log, and each settled check's — then the change
    // it published and the contention that publication met, summarized rather
    // than listed.
    "verification",
    "verification",
    "verification",
    "verification",
    "publication",
    "rollup",
  ]);
  // The aggregate lane carries what it stands for rather than the window the
  // waits fell in, which is what a client plots it at.
  const waits = timeline.spans.find((span) => span.kind === "rollup");
  expect(waits?.label).toBe("lock-wait");
  expect(waits?.count).toBe(2);
  expect(waits?.total_duration_ms).toBeGreaterThan(0);
  const dispatches = timeline.spans.filter((span) => span.kind === "dispatch");
  expect(dispatches.every((span) => span.dispatch_id !== undefined)).toBe(true);
  // The evidence that node kept, served as the record a client renders: the same
  // artifact id the detail's own verification record names.
  const verification = timeline.spans.find(
    (span) => span.kind === "verification",
  );
  expect(verification?.detail?.artifact_id).toBe(
    detail.node_details[verification?.node_id ?? ""]?.verification.records[0]
      ?.artifact_id,
  );
});

test("the projects and every wrapped verb this repository serves parse through the public parsers", async () => {
  // The grouped listing: newest activity first, each row the same row the flat
  // list serves, and one group addressable by id.
  const projects = projectListSchema.parse(await served("projects.json"));
  expect(projects.projects.map((group) => group.project)).toEqual([
    "authoring:contract-interface",
  ]);
  const [group] = projects.projects;
  expect(group?.name).toBe("contract");
  expect(group?.runs.map((run) => run.liveness)).toEqual(["PARKED", "PARKED"]);
  const project = projectDetailSchema.parse(await served("project.json"));
  expect(project.project).toBe(group?.project);
  expect(project.runs).toEqual(group?.runs);
  // And the no-project group is an ordinary group whose id is null — never a
  // group the parser turns away.
  expect(
    projectListSchema.parse({
      ...projects,
      projects: [{ ...group, project: null, name: null, last_write_at: null }],
    }).projects[0]?.project,
  ).toBeNull();

  // The channel, read and consumed, and what a reply and an attest come back as.
  const queue = channelQueueSchema.parse(await served("run-channel.json"));
  expect(queue.held).toBeNull();
  expect(queue.surfaces).toEqual([]);
  const next = channelNextSchema.parse(await served("run-channel-next.json"));
  expect(next.status).toBe("surface");
  expect(next.surface?.kind).toBe("finding");
  expect(next.surface?.blocking).toBe(false);
  const receipt = replyReceiptSchema.parse(
    await served("run-channel-reply.json"),
  );
  expect(receipt.receipt.state).toBe("applied");
  expect(receipt.receipt.commands).toBe("applied");
  expect(receipt.receipt.verdict).toBeUndefined();
  expect(receipt.advice).toEqual([]);
  expect(
    replyReceiptSchema.parse(await served("run-attest.json")).receipt,
  ).toEqual(receipt.receipt);
  const surfaced = surfacedSchema.parse(
    await served("run-channel-surface.json"),
  );
  expect(surfaced.state).toBe("queued");

  // Stopping and adopting.
  const stopped = stoppedSchema.parse(await served("run-stop.json"));
  expect(stopped).toMatchObject({
    stopped: true,
    owner: "[mine]",
    forced: false,
    teardown: "elsewhere",
  });
  expect(adoptedSchema.parse(await served("run-adopt.json")).pid).toBe(4242);

  // The watch stream's three frames, each named by its SSE event and carrying
  // the record the engine prints for it.
  const frames = z
    .array(
      z.object({
        id: z.number(),
        event: watchEventNameSchema,
        data: watchFrameDataSchema,
      }),
    )
    .parse(await served("run-watch.json"));
  expect(frames.map((frame) => frame.event)).toEqual([
    "event",
    "event",
    "returned",
  ]);
  const ending = frames.at(-1)?.data;
  expect(ending?.watch).toBe("return");
  if (ending?.watch === "return") {
    expect(ending.condition).toBe("settled");
    expect(ending.cursor).toMatch(/^1:/);
    expect(ending.unread.oldest_seconds).toBeNull();
  }
  expect(
    watchFrameDataSchema.parse({
      watch: "heartbeat",
      run_id: "run-20260807-a1b2c3",
      unread: {
        count: 1,
        oldest_seconds: 4,
        kinds: [{ kind: "finding", count: 1 }],
      },
    }).watch,
  ).toBe("heartbeat");
  expect(unwatchedSchema.parse(await served("unwatched.json"))).toMatchObject({
    reported: [],
    unresolved: [],
  });

  // The rendered reads: the SDK's own text, byte for byte what the binary prints.
  expect(renderedRootSchema.parse(await served("host.json")).rendered).toMatch(
    /^host /,
  );
  const status = runStatusSchema.parse(await served("run-status.json"));
  expect(status.liveness).toBe("PARKED");
  expect(status.unread_surfaces.oldest_seconds).toBeNull();
  expect(status.node_status).toEqual({
    "contract-interface": "done",
    review: "done",
  });
  expect(
    renderedRunSchema.parse(await served("run-results.json")).rendered,
  ).toContain("contract-interface");
  expect(renderedRootSchema.parse(await served("goals.json")).rendered).toMatch(
    /^== /,
  );
  expect(renderedRunSchema.parse(await served("run-goals.json")).run_id).toBe(
    status.run_id,
  );
  const transcript = runTranscriptSchema.parse(
    await served("run-transcript.json"),
  );
  expect(transcript.node).toBe("contract-interface");
  const telemetry = runTelemetryDocumentSchema.parse(
    await served("run-telemetry.json"),
  );
  expect(telemetry.telemetry.schema_version).toBe(2);
});

test("a reply envelope composed against the engine's grammar carries what the engine reads, and nothing else", () => {
  // A verdict alone needs no version; an edit envelope names the one the engine
  // reads, and every op the engine declares is one the grammar spells.
  expect(
    replyEnvelopeSchema.parse({ completion: false, message: "go on" }),
  ).toEqual({ completion: false, message: "go on" });
  expect(REPLY_OPS).toEqual([
    "add",
    "drop",
    "reparent",
    "retry",
    "cancel",
    "requeue",
    "set-node-sets",
    "set-run-node-sets",
    "attest",
    "complete",
    "amend",
    "note",
    "finding",
    "settle",
  ]);
  const edit = replyEnvelopeSchema.parse({
    version: REPLY_ENVELOPE_VERSION,
    commands: [
      { op: "note", id: "docs", addressee: "worker", text: "measure it too" },
      { op: "drop", id: "obsolete", dependents: "detach" },
      { op: "settle", id: "ship", outcome: "done", evidence: "landed as #12" },
    ],
  });
  expect(edit.version).toBe(3);
  expect(edit.commands).toHaveLength(3);
  // The field the engine retired is refused by name, as the engine refuses it,
  // and an op the engine does not declare never reaches the wire.
  expect(
    replyEnvelopeSchema.safeParse({
      version: REPLY_ENVELOPE_VERSION,
      commands: [{ op: "context", id: "docs", note: "hi" }],
    }).success,
  ).toBe(false);
  expect(replyEnvelopeSchema.safeParse({ bogus: true }).success).toBe(false);
  expect(
    replyEnvelopeSchema.safeParse({
      version: REPLY_ENVELOPE_VERSION,
      commands: [{ op: "drop", id: "obsolete" }],
    }).success,
  ).toBe(false);
  // Commands under no version, or another, are what the engine refuses as "an
  // edit envelope requires version 3"; an envelope carrying neither half is one
  // the engine answers, naming no verdict, so it parses.
  const unversioned = replyEnvelopeSchema.safeParse({
    commands: [{ op: "drop", id: "obsolete", dependents: "detach" }],
  });
  expect(unversioned.success).toBe(false);
  expect(unversioned.error?.issues[0]?.message).toBe(
    "an edit envelope requires version 3",
  );
  expect(
    replyEnvelopeSchema.safeParse({
      version: 2,
      commands: [{ op: "complete", reason: "done" }],
    }).success,
  ).toBe(false);
  expect(replyEnvelopeSchema.safeParse({}).success).toBe(true);
});

test("the model's reply commands are the engine's, op for op and field for field", async () => {
  // `tests/contract.rs` pins this golden to the fields the engine's own
  // `channel::Command` declares; this half holds the browser's copy to it, so an
  // op or a field on one side alone fails one of the two.
  const engine = z
    .object({
      reply_envelope_version: z.number(),
      commands: z.record(
        z.string(),
        z.object({
          required: z.array(z.string()),
          optional: z.array(z.string()),
        }),
      ),
      node_list_fields: z.array(z.string()),
    })
    .parse(await served("reply-commands.json"));
  expect(REPLY_ENVELOPE_VERSION).toBe(engine.reply_envelope_version);
  expect([...REPLY_OPS].sort()).toEqual(Object.keys(engine.commands).sort());
  for (const option of replyCommandSchema.options) {
    const op = option.shape.op.value;
    const fields = Object.entries(option.shape).filter(([key]) => key !== "op");
    const required = fields
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key)
      .sort();
    const optional = fields
      .filter(([, field]) => field.safeParse(undefined).success)
      .map(([key]) => key)
      .sort();
    expect({ op, required, optional }).toEqual({ op, ...engine.commands[op] });
  }
  // A node's list fields are ones the plan task declares, a list and optional.
  for (const field of engine.node_list_fields) {
    const shape: Record<string, z.ZodType> = planTaskSchema.shape;
    expect(shape[field]?.safeParse(undefined).success).toBe(true);
    expect(shape[field]?.safeParse(["a=1"]).success).toBe(true);
    expect(shape[field]?.safeParse("a=1").success).toBe(false);
  }
});

test("a node's graph overrides are kept as written, in order, through every command that carries a node", () => {
  const sets = [
    "members.worker.agent.model=large",
    "members.worker.agent.model=small",
  ];
  const node = {
    id: "build",
    persona: "engineer",
    task: "## What\nbuild",
    sets,
  };
  // `add` and `retry` carry a whole node, `sets` and an explicit `[]` alike.
  const parsed = replyEnvelopeSchema.parse({
    version: REPLY_ENVELOPE_VERSION,
    commands: [
      { op: "add", node },
      { op: "retry", id: "build", node: { ...node, id: "build-2", sets: [] } },
      { op: "requeue", id: "parked", amend: { sets: [] } },
      { op: "requeue", id: "parked", amend: { sets, max_turns: 3 } },
      { op: "set-node-sets", id: "build", sets },
      { op: "set-node-sets", id: "build", sets: [] },
      { op: "set-run-node-sets", sets: ["members.worker.agent.model=run"] },
      { op: "set-run-node-sets", sets: [] },
    ],
  });
  expect(parsed.commands).toEqual([
    { op: "add", node },
    { op: "retry", id: "build", node: { ...node, id: "build-2", sets: [] } },
    { op: "requeue", id: "parked", amend: { sets: [] } },
    { op: "requeue", id: "parked", amend: { sets, max_turns: 3 } },
    { op: "set-node-sets", id: "build", sets },
    { op: "set-node-sets", id: "build", sets: [] },
    { op: "set-run-node-sets", sets: ["members.worker.agent.model=run"] },
    { op: "set-run-node-sets", sets: [] },
  ]);
  // Each replacement names its whole list: an absent one is not a clear, and
  // a node edit names its node.
  for (const command of [
    { op: "set-node-sets", id: "build" },
    { op: "set-node-sets", sets: [] },
    { op: "set-node-sets", id: "", sets: [] },
    { op: "set-run-node-sets" },
    { op: "set-run-node-sets", sets: "members.worker.agent.model=run" },
    { op: "set-run-node-sets", sets: [], id: "build" },
    { op: "requeue", id: "parked", amend: { sets: "a=1" } },
    { op: "add", node: { ...node, sets: [1] } },
  ]) {
    expect(
      replyEnvelopeSchema.safeParse({
        version: REPLY_ENVELOPE_VERSION,
        commands: [command],
      }).success,
      JSON.stringify(command),
    ).toBe(false);
  }
});

test("the graph serves a node's overrides and the run-wide list, and absent reads as none", async () => {
  const golden = await served("run.json");
  const graph = graphStateSchema.parse(golden.graph);
  const node = graph.plan.tasks.find(
    (task) => task.id === "contract-interface",
  );
  expect(node?.sets).toEqual([
    "members.worker.agent.model=large",
    "members.worker.agent.oneharness_config=./worker.toml",
  ]);
  expect(
    graph.plan.tasks.find((task) => task.id === "review")?.sets,
  ).toBeUndefined();
  expect(graph.run_node_sets).toBeUndefined();
  const edited = graphStateSchema.parse({
    ...golden.graph,
    run_node_sets: ["members.worker.agent.model=run"],
  });
  expect(edited.run_node_sets).toEqual(["members.worker.agent.model=run"]);
  expect(
    graphStateSchema.safeParse({ ...golden.graph, run_node_sets: "a=1" })
      .success,
  ).toBe(false);
});
