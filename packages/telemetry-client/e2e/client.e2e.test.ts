import {
  TELEMETRY_SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
} from "@onepipeline-ui/dag-model";
// eslint-disable-next-line @nx/enforce-module-boundaries -- This verifies the package export over a real HTTP boundary.
import { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { expect, test } from "vitest";
import { serveLoopback } from "./loopback-server.js";

test("a package consumer reads a validated response from a real HTTP server", async () => {
  const server = await serveLoopback((request) => {
    const url = new URL(request.url);
    if (
      url.pathname === "/api/v2/runs" &&
      url.searchParams.get("include_settled") === "false"
    ) {
      return Response.json({
        api_version: 2,
        telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        runs: [],
      });
    }
    return Response.json(
      { error: { code: "not_found", message: "Not found" } },
      { status: 404 },
    );
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    expect((await client.listRuns()).runs).toEqual([]);
  } finally {
    await server.stop();
  }
});

test("a package consumer receives typed HTTP and response-contract failures", async () => {
  const server = await serveLoopback((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/invalid")) {
      return Response.json({
        api_version: 2,
        telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        run: {},
        rounds: [],
        conversations: [],
      });
    }
    return Response.json(
      { error: { code: "not_found", message: "Run is missing" } },
      { status: 404 },
    );
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    await expect(client.getRun("invalid")).rejects.toMatchObject({
      message: "Telemetry response failed contract validation",
    });
    await expect(client.getRun("missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
      message: "Run is missing",
    });
  } finally {
    await server.stop();
  }
});

test("a package consumer reads and validates one complete conversation", async () => {
  const conversation = {
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
      transportRole: "agent",
      agentRole: "worker",
    },
  };
  const server = await serveLoopback((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/conversations/conversation-1")) {
      return Response.json(conversation);
    }
    if (path.endsWith("/conversations/invalid")) {
      return Response.json({ conversation: { id: 7 } });
    }
    return Response.json(
      { error: { code: "not_found", message: "Conversation is missing" } },
      { status: 404 },
    );
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    expect(
      (await client.getConversation("run-1", "conversation-1")).conversation.id,
    ).toBe("conversation-1");
    await expect(
      client.getConversation("run-1", "invalid"),
    ).rejects.toMatchObject({
      message: "Telemetry response failed contract validation",
    });
    await expect(
      client.getConversation("run-1", "missing"),
    ).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  } finally {
    await server.stop();
  }
});

test("a package consumer fetches a run timeline over a real HTTP boundary", async () => {
  let seen = "";
  const server = await serveLoopback((request) => {
    const url = new URL(request.url);
    seen = url.pathname + url.search;
    if (url.pathname === "/api/v2/runs/demo/timeline") {
      return Response.json({
        api_version: 2,
        timeline_schema_version: TIMELINE_SCHEMA_VERSION,
        observed_at: "2026-07-26T12:00:00Z",
        run_id: "demo",
        spans: [
          {
            id: "node-1-api",
            kind: "node",
            label: "api",
            started_at: "2026-07-26T12:00:00Z",
            ended_at: null,
            node_id: "api",
            events: [],
          },
          {
            id: "rollup-lock-wait-9",
            kind: "rollup",
            label: "lock-wait",
            started_at: "2026-07-26T12:00:01Z",
            ended_at: "2026-07-26T12:00:30Z",
            parent_id: "node-1-api",
            count: 1722,
            total_duration_ms: 430500,
            events: [],
          },
        ],
      });
    }
    return Response.json(
      { error: { code: "run_not_found", message: "Run is missing" } },
      { status: 404 },
    );
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    const timeline = await client.getTimeline("demo");
    expect(seen).toBe("/api/v2/runs/demo/timeline?scope=run");
    // The node is still running, and a thousand lock waits arrived as one rollup.
    expect(timeline.spans[0]?.ended_at).toBeNull();
    expect(timeline.spans[1]?.count).toBe(1722);
    await expect(client.getTimeline("absent")).rejects.toMatchObject({
      status: 404,
      code: "run_not_found",
    });
  } finally {
    await server.stop();
  }
});

/** The envelope every wrapped verb answers under. */
const enveloped = {
  api_version: 2,
  telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
  observed_at: "2026-08-07T12:00:00Z",
} as const;

test("a package consumer reads the grouped projects and every rendered verb over a real HTTP boundary", async () => {
  const row = {
    run_id: "run-1",
    state: "settled",
    phase: "settled",
    last_event: "node-settled",
    timing_quality: "complete",
    linkage_quality: "labelled",
    timing: {
      agent_seconds: 1,
      judge_seconds: null,
      llmlint_seconds: null,
      gate_seconds: 0,
      publication_wait_seconds: 0,
      lock_wait_seconds: 0,
      setup_seconds: 0,
      scheduling_seconds: 0,
      wall_seconds: 1,
      agent_model_ms: null,
      judge_model_ms: null,
      llmlint_model_ms: null,
      tool_ms: null,
      idle_orchestration_ms: null,
      unattributed_ms: 0,
      wall_ms: 1000,
      fractions: {
        agent_model: null,
        judge_model: null,
        llmlint_model: null,
        tool: null,
        idle_orchestration: null,
        lock_wait: 0,
        setup: 0,
        scheduling: 0,
      },
    },
    node_counts: { done: 1 },
    project: "local-md:observatory",
    liveness: "PARKED",
    unread_surfaces: 0,
  };
  const group = {
    project: "local-md:observatory",
    name: "observatory",
    last_write_at: 1786104030000,
    runs: [row],
  };
  const requested: string[] = [];
  const server = await serveLoopback((request) => {
    const url = new URL(request.url);
    requested.push(`${request.method} ${url.pathname}${url.search}`);
    switch (url.pathname) {
      case "/api/v2/projects":
        return Response.json({ ...enveloped, projects: [group] });
      // The id reaches the route path-encoded, and is read back through its own
      // parser: the colon never splits the segment.
      case "/api/v2/projects/local-md%3Aobservatory":
        return Response.json({ ...enveloped, ...group });
      case "/api/v2/host":
        return Response.json({ ...enveloped, rendered: "host a-host\n" });
      case "/api/v2/goals":
        return Response.json({ ...enveloped, rendered: "== a project\n" });
      case "/api/v2/unwatched":
        return Response.json({
          ...enveloped,
          reported: [
            { run: "run-1", standing: "ACTIVE", why_not_watched: "no watcher" },
          ],
          unresolved: [],
        });
      case "/api/v2/runs/run-1/status":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          liveness: "DRIVER DEAD",
          unread_surfaces: { count: 2, oldest_seconds: 40 },
          node_status: { a: "done" },
          summary: "1/1 done",
          rendered: "run-1  SETTLED  1/1 done\n",
        });
      case "/api/v2/runs/run-1/results":
      case "/api/v2/runs/run-1/goals":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          rendered: "text\n",
        });
      case "/api/v2/runs/run-1/transcript":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          node: url.searchParams.get("node"),
          rendered: "run-1  a\n",
        });
      case "/api/v2/runs/run-1/telemetry":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          telemetry: { schema_version: 2, run_id: "run-1", wall_ms: 1000 },
        });
      default:
        return Response.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        );
    }
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    expect((await client.listProjects()).projects[0]?.runs[0]?.run_id).toBe(
      "run-1",
    );
    expect((await client.getProject("local-md:observatory")).name).toBe(
      "observatory",
    );
    expect((await client.host()).rendered).toBe("host a-host\n");
    expect((await client.getGoals()).rendered).toBe("== a project\n");
    expect((await client.unwatched()).reported[0]?.run).toBe("run-1");
    const status = await client.getStatus("run-1");
    expect(status.liveness).toBe("DRIVER DEAD");
    expect(status.unread_surfaces.oldest_seconds).toBe(40);
    expect((await client.getResults("run-1")).rendered).toBe("text\n");
    expect((await client.getRunGoals("run-1")).rendered).toBe("text\n");
    expect((await client.getTranscript("run-1", "a")).node).toBe("a");
    expect(
      (await client.getTelemetryDocument("run-1")).telemetry.schema_version,
    ).toBe(2);
    expect(requested).toContain("GET /api/v2/runs/run-1/transcript?node=a");
  } finally {
    await server.stop();
  }
});

test("a package consumer reads the agents a run, a node and a project launched over a real HTTP boundary", async () => {
  const session = {
    history_session: "worker-20260807T120003Z-3163646",
    name: "worker",
    history_dir: "/a-store",
    history_project: "a-project",
    history_file: "/a-store/a-project/worker-20260807T120003Z-3163646.jsonl",
    project: "/a-workspace",
    started: "2026-08-07T12:00:03Z",
    labels: {
      "onepipeline.node": "a",
      "onepipeline.run_id": "run-1",
      "onepipeline.scope": "node",
    },
    runs: [
      {
        history_id: "0198a5b3-2c4d-7e60-8f01-000000000001",
        harness: "claude-code",
        harness_id: "claude-code",
        started: "2026-08-07T12:00:03Z",
      },
    ],
    run_id: "run-1",
  };
  const requested: string[] = [];
  const server = await serveLoopback((request) => {
    const url = new URL(request.url);
    requested.push(`${request.method} ${url.pathname}`);
    switch (url.pathname) {
      case "/api/v2/runs/run-1/agents":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          sessions: [session],
          skipped: 0,
        });
      // A node that dispatched nothing is an empty list rather than an error.
      case "/api/v2/runs/run-1/nodes/b/agents":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          node: "b",
          sessions: [],
          skipped: 0,
        });
      // The project id reaches the route path-encoded, as `getProject` sends it.
      case "/api/v2/projects/local-md%3Aobservatory/agents":
        return Response.json({
          ...enveloped,
          project: "local-md:observatory",
          sessions: [session],
          skipped: 1,
        });
      case "/api/v2/runs/run-1/artifacts/0198a5b3-2c4d-7e60-8f01-000000000001":
        return Response.json({
          ...enveloped,
          id: "0198a5b3-2c4d-7e60-8f01-000000000001",
          kind: "oneharness_session",
          content: '{"text": "what the agent said"}',
          truncated: false,
        });
      default:
        return Response.json(
          {
            error: { code: "project_not_found", message: "no such project" },
          },
          { status: 404 },
        );
    }
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    const agents = await client.getAgents("run-1");
    expect(agents.sessions[0]?.labels["onepipeline.node"]).toBe("a");
    expect(agents.sessions[0]?.runs[0]?.variant).toBeUndefined();
    expect((await client.getNodeAgents("run-1", "b")).sessions).toEqual([]);
    const project = await client.getProjectAgents("local-md:observatory");
    expect(project.skipped).toBe(1);
    // The link the entry carries: its run and its harness run's history id, on
    // the artifact route, is the transcript.
    const [entry] = project.sessions;
    const transcript = await client.getArtifact(
      entry?.run_id ?? "",
      entry?.runs[0]?.history_id ?? "",
    );
    expect(transcript.kind).toBe("oneharness_session");
    expect(transcript.content).toContain("what the agent said");
    await expect(client.getProjectAgents("local-md:nobody")).rejects.toThrow(
      "no such project",
    );
    expect(requested).toContain(
      "GET /api/v2/projects/local-md%3Aobservatory/agents",
    );
  } finally {
    await server.stop();
  }
});

test("a package consumer sends an envelope as the bytes it typed and reads the engine's receipt or refusal verbatim", async () => {
  const received: { method: string; path: string; body: string }[] = [];
  const server = await serveLoopback(async (request) => {
    const url = new URL(request.url);
    const body = await request.text();
    received.push({
      method: request.method,
      path: url.pathname + url.search,
      body,
    });
    switch (url.pathname) {
      case "/api/v2/runs/run-1/channel":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          surfaces: [],
          waiting: [],
          held: null,
          replies: [],
          commands: [],
          outcomes: [],
        });
      case "/api/v2/runs/run-1/channel/next":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          status: "running",
          surface: null,
          events: [],
        });
      case "/api/v2/runs/run-1/channel/reply":
        // A malformed envelope is the engine's refusal, in the engine's words.
        if (!body.startsWith("{"))
          return Response.json(
            {
              error: {
                code: "refused",
                message:
                  "refused: the reply is malformed: expected value at line 1 column 1",
              },
            },
            { status: 422 },
          );
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          receipt: { reply: 3, state: "delivered", verdict: "delivered" },
          advice: [
            "nothing is driving run-1; adopt it for the reply to be read",
          ],
        });
      case "/api/v2/runs/run-1/channel/surface":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          surface: 4,
          state: "queued",
        });
      case "/api/v2/runs/run-1/attest":
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          receipt: { reply: 0, state: "applied", commands: "applied" },
          advice: [],
        });
      case "/api/v2/runs/run-1/stop":
        if (body === '{"force":false}')
          return Response.json(
            {
              error: {
                code: "not_owner",
                message:
                  "run run-1 belongs to [codex:160c290a], not to this session",
              },
            },
            { status: 409 },
          );
        return Response.json({
          ...enveloped,
          run_id: "run-1",
          stopped: true,
          owner: "[codex:160c290a]",
          forced: true,
          teardown: "nothing-to-stop",
        });
      case "/api/v2/runs/run-1/adopt":
        return Response.json({ ...enveloped, run_id: "run-1", pid: 4242 });
      default:
        return Response.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        );
    }
  });
  try {
    const client = new TelemetryClient(`http://127.0.0.1:${server.port}`);
    expect((await client.getChannel("run-1")).held).toBeNull();
    expect((await client.claimNext("run-1", "planner")).status).toBe("running");
    // The bytes on the wire are the bytes given — whitespace, key order and all.
    const typed = '{ "completion": false,\n  "message": "keep going" }';
    const receipt = await client.reply("run-1", typed, "corr-1");
    expect(receipt.receipt).toEqual({
      reply: 3,
      state: "delivered",
      verdict: "delivered",
    });
    expect(receipt.advice).toHaveLength(1);
    await expect(client.reply("run-1", "not json")).rejects.toMatchObject({
      status: 422,
      code: "refused",
      message:
        "refused: the reply is malformed: expected value at line 1 column 1",
    });
    expect(
      (await client.surface("run-1", { kind: "finding", message: "red" }))
        .surface,
    ).toBe(4);
    expect((await client.attest("run-1", "signoff")).receipt.state).toBe(
      "applied",
    );
    await expect(client.stop("run-1")).rejects.toMatchObject({
      status: 409,
      code: "not_owner",
      message: "run run-1 belongs to [codex:160c290a], not to this session",
    });
    expect((await client.stop("run-1", true)).forced).toBe(true);
    expect((await client.adopt("run-1")).pid).toBe(4242);

    expect(received.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/v2/runs/run-1/channel",
      "POST /api/v2/runs/run-1/channel/next?filter=planner",
      "POST /api/v2/runs/run-1/channel/reply?correlation=corr-1",
      "POST /api/v2/runs/run-1/channel/reply",
      "POST /api/v2/runs/run-1/channel/surface",
      "POST /api/v2/runs/run-1/attest",
      "POST /api/v2/runs/run-1/stop",
      "POST /api/v2/runs/run-1/stop",
      "POST /api/v2/runs/run-1/adopt",
    ]);
    expect(received[2]?.body).toBe(typed);
    expect(received[4]?.body).toBe('{"kind":"finding","message":"red"}');
    expect(received[5]?.body).toBe('{"reference":"signoff"}');
    expect(received[7]?.body).toBe('{"force":true}');
  } finally {
    await server.stop();
  }
});
