import {
  TELEMETRY_SCHEMA_VERSION,
  TIMELINE_SCHEMA_VERSION,
} from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";

import { TelemetryClient, TelemetryClientError } from "./index.js";

const emptyList = {
  api_version: 2,
  telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
  observed_at: "2026-07-26T12:00:00Z",
  runs: [],
} as const;

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
const zeroParty = {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cost_usd: null,
};
/** The smallest `RunTelemetry` the published contract accepts. */
const runTelemetry = {
  run_id: "run-1",
  state: "running",
  phase: "dispatch",
  last_event: "node-started",
  timing: zeroTiming,
  nodes: [],
  usage: {
    agent: zeroParty,
    judge: zeroParty,
    llmlint: zeroParty,
    total: zeroParty,
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
};

describe("TelemetryClient fetch boundary", () => {
  test("returns validated list data and sends the settled filter", async () => {
    let requested = "";
    const client = new TelemetryClient("http://127.0.0.1:8000/", {
      fetch: async (input) => {
        requested = String(input);
        return Response.json(emptyList);
      },
    });
    const list = await client.listRuns(true);
    expect(list.api_version).toBe(2);
    expect(list.runs).toEqual([]);
    expect(requested).toBe(
      "http://127.0.0.1:8000/api/v2/runs?include_settled=true&limit=50",
    );
  });

  test("names the runs a selection asks about and sends nothing paging", async () => {
    let requested = "";
    const client = new TelemetryClient("http://127.0.0.1:8000/", {
      fetch: async (input) => {
        requested = String(input);
        return Response.json({ ...emptyList, missing: ["gone"] });
      },
    });
    const answer = await client.selectRuns(["one", "two"]);
    // A selection and a page are two answers to different questions on one route,
    // and the server refuses a paging parameter beside one — so none is sent.
    expect(requested).toBe(
      "http://127.0.0.1:8000/api/v2/runs?select=one%2Ctwo",
    );
    expect(answer.missing).toEqual(["gone"]);
  });

  test("refuses a selection the run-list route could not mean", async () => {
    const client = new TelemetryClient("http://localhost", {
      fetch: async () => Response.json(emptyList),
    });
    // Nothing named at all: `?select=` with no run is a caller asking about no
    // runs, which the server refuses rather than reading as "list everything".
    await expect(client.selectRuns([])).rejects.toBeInstanceOf(
      TelemetryClientError,
    );
    // A comma is what separates two ids on this wire, so an id carrying one is
    // refused here rather than sent as two runs the caller never named.
    await expect(client.selectRuns(["one,two"])).rejects.toBeInstanceOf(
      TelemetryClientError,
    );
    await expect(client.selectRuns(["a/b"])).rejects.toBeInstanceOf(
      TelemetryClientError,
    );
  });

  test("rejects a successful response that violates the model", async () => {
    const client = new TelemetryClient("http://localhost", {
      fetch: async () => Response.json({ ...emptyList, api_version: 3 }),
    });
    await expect(client.listRuns()).rejects.toBeInstanceOf(
      TelemetryClientError,
    );
  });

  test("asks for a run without transcripts and reads the run timeline", async () => {
    const requested: string[] = [];
    const client = new TelemetryClient("http://127.0.0.1:8000/", {
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/timeline?")) {
          return Response.json({
            api_version: 2,
            timeline_schema_version: TIMELINE_SCHEMA_VERSION,
            observed_at: "2026-07-26T12:00:00Z",
            run_id: "run-1",
            spans: [
              {
                id: "node-1-build",
                kind: "node",
                label: "build",
                started_at: "2026-07-26T12:00:00Z",
                ended_at: null,
                events: [],
              },
            ],
          });
        }
        return Response.json({
          api_version: 2,
          telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
          observed_at: "2026-07-26T12:00:00Z",
          run: runTelemetry,
          graph: null,
          conversations: [],
        });
      },
    });

    const lean = await client.getRun("run-1", { includeConversations: false });
    expect(lean.conversations).toEqual([]);
    // The opt-out travels as the documented query parameter, not a header or a path.
    expect(requested[0]).toBe(
      "http://127.0.0.1:8000/api/v2/runs/run-1?include_conversations=false",
    );

    const timeline = await client.getTimeline("run-1", "build");
    // An in-flight node stays representable all the way to the consumer.
    expect(timeline.spans[0]?.ended_at).toBeNull();
    expect(requested[1]).toBe(
      "http://127.0.0.1:8000/api/v2/runs/run-1/timeline?scope=node&node=build",
    );

    // Omitting the option leaves the request exactly as it was before.
    await client.getRun("run-1");
    expect(requested[2]).toBe("http://127.0.0.1:8000/api/v2/runs/run-1");
  });

  test("rejects a timeline response that violates the model", async () => {
    const client = new TelemetryClient("http://localhost", {
      fetch: async () =>
        Response.json({
          api_version: 2,
          timeline_schema_version: TIMELINE_SCHEMA_VERSION,
          observed_at: "2026-07-26T12:00:00Z",
          run_id: "run-1",
          spans: [{ id: "x", kind: "guess", label: "x", events: [] }],
        }),
    });
    await expect(client.getTimeline("run-1")).rejects.toBeInstanceOf(
      TelemetryClientError,
    );
    await expect(client.getTimeline("bad/id")).rejects.toBeInstanceOf(
      TelemetryClientError,
    );
  });

  test("refuses a grace the route could not mean before anything is sent", async () => {
    let sent = 0;
    const client = new TelemetryClient("http://localhost", {
      fetch: async () => {
        sent += 1;
        return Response.json({});
      },
    });
    for (const grace of [-1, 1.5, Number.NaN]) {
      await expect(client.shutdownRun("run-1", { grace })).rejects.toThrow(
        "Invalid grace",
      );
      await expect(client.shutdown("host", { grace })).rejects.toThrow(
        "Invalid grace",
      );
    }
    await expect(client.shutdownRun("bad/id")).rejects.toThrow(
      "Invalid run ID",
    );
    expect(sent).toBe(0);
  });

  test("reads a shutdown report that violates the model as a failed validation, not as a report", async () => {
    const client = new TelemetryClient("http://localhost", {
      fetch: async () =>
        Response.json({
          api_version: 2,
          telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
          observed_at: "2026-07-26T12:00:00Z",
          scope: "host",
          // No `complete`: a report that cannot say whether it all went as asked.
          runs: [],
        }),
    });
    await expect(client.shutdown("host")).rejects.toMatchObject({
      status: 200,
      message: "Telemetry response failed contract validation",
    });
  });

  test("surfaces the typed server error", async () => {
    const client = new TelemetryClient("http://localhost", {
      fetch: async () =>
        Response.json(
          { error: { code: "not_found", message: "Run is missing" } },
          { status: 404 },
        ),
    });
    try {
      await client.getRun("run-1");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toMatchObject({
        status: 404,
        code: "not_found",
        message: "Run is missing",
      });
    }
  });
});

test("validates SSE snapshots before notifying subscribers", () => {
  const listeners = new Map<string, EventListener>();
  let closed = false;
  const source = {
    addEventListener: (
      name: string,
      listener: EventListenerOrEventListenerObject,
      // The DOM signature also admits a `{ handleEvent }` object. The client
      // only ever registers plain functions, and this map is what the test
      // calls back, so narrowing here keeps the double's own surface honest.
    ) => listeners.set(name, listener as EventListener),
    close: () => {
      closed = true;
    },
    onerror: null,
    // `EventSource` is a DOM class with readyState, url and the rest of the
    // spec surface; the client reaches for exactly the three members above, so
    // the double implements those and this names what it stands in for.
  } as unknown as EventSource;
  const events: unknown[] = [];
  const errors: unknown[] = [];
  const client = new TelemetryClient("http://localhost", {
    eventSource: () => source,
  });
  const subscription = client.subscribe({
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });
  listeners.get("snapshot")?.(
    new MessageEvent("snapshot", {
      data: JSON.stringify(emptyList),
      lastEventId: "12",
    }),
  );
  listeners.get("snapshot")?.(
    new MessageEvent("snapshot", {
      data: JSON.stringify({
        ...emptyList,
        telemetry_schema_version: TELEMETRY_SCHEMA_VERSION + 1,
      }),
    }),
  );
  expect(events).toHaveLength(1);
  expect(errors).toHaveLength(1);
  subscription.close();
  expect(closed).toBe(true);
});

test("holds a watch as its three frames, and closes the source on the frame that ends it", () => {
  const listeners = new Map<string, EventListener>();
  const opened: string[] = [];
  let closed = 0;
  const source = {
    addEventListener: (
      name: string,
      listener: EventListenerOrEventListenerObject,
      // The DOM signature also admits a `{ handleEvent }` object. The client
      // only ever registers plain functions, and this map is what the test
      // calls back, so narrowing here keeps the double's own surface honest.
    ) => listeners.set(name, listener as EventListener),
    close: () => {
      closed += 1;
    },
    onerror: null,
    // `EventSource` is a DOM class with readyState, url and the rest of the
    // spec surface; the client reaches for exactly the three members above, so
    // the double implements those and this names what it stands in for.
  } as unknown as EventSource;
  const frames: unknown[] = [];
  const errors: unknown[] = [];
  const client = new TelemetryClient("http://localhost", {
    eventSource: (url) => {
      opened.push(url);
      return source;
    },
  });
  client.watch({
    runId: "run-1",
    until: ["surface", "node=docs"],
    timeout: "none",
    tick: 5,
    filter: "planner",
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });
  // Every condition is repeated on the query rather than joined, as the route
  // takes them.
  expect(opened).toEqual([
    "http://localhost/api/v2/runs/run-1/watch?until=surface&until=node%3Ddocs&timeout=none&tick=5&filter=planner",
  ]);
  listeners.get("event")?.(
    new MessageEvent("event", {
      data: JSON.stringify({ watch: "event", event: { kind: "node-settled" } }),
      lastEventId: "0",
    }),
  );
  listeners.get("tick")?.(
    new MessageEvent("tick", {
      data: JSON.stringify({
        watch: "heartbeat",
        run_id: "run-1",
        unread: { count: 0, oldest_seconds: null, kinds: [] },
      }),
      lastEventId: "1",
    }),
  );
  // A frame that is not the engine's record is an error, never a frame.
  listeners.get("tick")?.(
    new MessageEvent("tick", { data: JSON.stringify({ watch: "nope" }) }),
  );
  expect(closed).toBe(0);
  listeners.get("returned")?.(
    new MessageEvent("returned", {
      data: JSON.stringify({
        watch: "return",
        run_id: "run-1",
        condition: "surface-waiting",
        exit: 0,
        cursor: "1:run-1:40",
        unread: {
          count: 1,
          oldest_seconds: 2,
          kinds: [{ kind: "finding", count: 1 }],
        },
      }),
      lastEventId: "2",
    }),
  );
  expect(frames).toHaveLength(3);
  expect(frames[2]).toMatchObject({
    id: "2",
    event: "returned",
    data: { condition: "surface-waiting" },
  });
  expect(errors).toHaveLength(1);
  // The wait is over, so the browser must not reopen it: closed on the frame
  // itself, before the listener is told.
  expect(closed).toBe(1);
});
