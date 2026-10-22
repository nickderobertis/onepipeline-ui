import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { type LiveCause, type LiveState, TelemetryClient } from "./index.js";

const EPOCH = "0198a5b3-2c4d-4e60-8f01-0000000e9c00";
const SUBSCRIPTION = "0198a5b3-2c4d-4e60-8f01-0000005ab001";
const NEXT_SUBSCRIPTION = "0198a5b3-2c4d-4e60-8f01-0000005ab002";
const id = (seq: number) => `${EPOCH}:${seq}`;

const row = (state: string) => ({
  id: "run-1",
  name: "run-1",
  group: null,
  kind: null,
  state,
  nodes: { total: 1, done: 0, failed: 0, running: 1 },
  updated_at: "2026-07-26T12:00:00.000Z",
});

const snapshot = (seq: number, state = "running") => ({
  id: id(seq),
  sidebar: [row(state)],
  visible: { type: "sidebar" },
});

/**
 * The browser `EventSource`, over a real `EventTarget` so the client's own
 * listeners and `MessageEvent`s run unchanged: the boundary the client takes as
 * an injectable factory, because neither jsdom nor Node ships one.
 */
class Source extends EventTarget {
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  frame(type: string, data: Record<string, unknown>) {
    this.dispatchEvent(
      new MessageEvent(type, {
        data: JSON.stringify({ type, subscription: SUBSCRIPTION, ...data }),
        lastEventId: String(data.id),
      }),
    );
  }
}

interface Harness {
  readonly client: TelemetryClient;
  readonly sources: Source[];
  readonly bodies: unknown[];
  readonly deleted: string[];
  answer: (body: Record<string, unknown>) => Response;
}

function harness(): Harness {
  const sources: Source[] = [];
  const bodies: unknown[] = [];
  const deleted: string[] = [];
  const state: Harness = {
    client: new TelemetryClient("http://localhost", {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === "DELETE") {
          deleted.push(url.pathname.split("/").at(-1) ?? "");
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return state.answer(body);
      }) as typeof fetch,
      eventSource: (url) => {
        const source = new Source(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    }),
    sources,
    bodies,
    deleted,
    answer: (body) =>
      Response.json(
        {
          subscription: SUBSCRIPTION,
          view: body.view,
          initial: { type: "snapshot", snapshot: snapshot(1) },
        },
        { status: 201 },
      ),
  };
  return state;
}

function open(h: Harness) {
  const states: [LiveState, LiveCause][] = [];
  const errors: Error[] = [];
  const live = h.client.live({
    view: { type: "sidebar" },
    onState: (state, cause) => states.push([state, cause]),
    onError: (error) => errors.push(error),
  });
  return { live, states, errors };
}

const settle = () => vi.waitFor(() => undefined);

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

test("applies each frame onto the one before it, once, and resumes from what it applied", async () => {
  const h = harness();
  const { states } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const source = h.sources[0] as Source;
  expect(new URL(source.url).searchParams.get("after")).toBe(id(1));
  expect(new URL(source.url).searchParams.get("subscription")).toBe(
    SUBSCRIPTION,
  );

  source.frame("run.changed", { id: id(3), base: id(1), row: row("settled") });
  // A replayed frame already applied is ignored.
  source.frame("run.changed", { id: id(3), base: id(1), row: row("bogus") });
  expect(states.map(([state]) => state.sidebar[0]?.state)).toStrictEqual([
    "running",
    "settled",
  ]);
  expect(states.at(-1)?.[0].applied).toBe(id(3));

  // A frame that does not follow the applied one is not applied: the stream
  // is opened again from the applied cursor.
  source.frame("run.removed", { id: id(9), base: id(7), run_id: "run-1" });
  expect(states).toHaveLength(2);
  expect(source.closed).toBe(true);
  expect(h.sources).toHaveLength(2);
  expect(new URL((h.sources[1] as Source).url).searchParams.get("after")).toBe(
    id(3),
  );
});

test("applies a reset once as the new base, and stops at a patch it cannot apply", async () => {
  const h = harness();
  const { states, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const source = h.sources[0] as Source;
  source.frame("reset", {
    id: id(5),
    base: id(1),
    reason: "stale-cursor",
    snapshot: snapshot(5, "settled"),
  });
  expect(states.at(-1)?.[1]).toStrictEqual({
    kind: "reset",
    reason: "stale-cursor",
  });
  expect(states.at(-1)?.[0].applied).toBe(id(5));

  // A patch for a view this tab does not hold is a protocol error, and nothing
  // after it is applied.
  source.frame("detail.patch", {
    id: id(6),
    base: id(5),
    run_id: "run-1",
    ops: [{ p: ["run", "state"], v: "x" }],
  });
  source.frame("run.changed", { id: id(7), base: id(6), row: row("running") });
  expect(errors.map((error) => error.message)).toStrictEqual([
    "A patch could not be applied: a detail patch for a run this tab does not show",
  ]);
  expect(states.at(-1)?.[0].applied).toBe(id(5));
});

test("refuses a frame the contract does not allow", async () => {
  const h = harness();
  const { states, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  (h.sources[0] as Source).frame("run.changed", {
    id: id(2),
    base: id(1),
    row: { ...row("running"), liveness: "ACTIVE" },
  });
  expect(errors[0]?.message).toMatch(/contract validation/);
  expect(states).toHaveLength(1);
});

test("replaces the subscription for a new view and retires it when closed", async () => {
  const h = harness();
  const { live } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  h.answer = (body) =>
    Response.json(
      {
        subscription: NEXT_SUBSCRIPTION,
        view: body.view,
        initial: { type: "snapshot", snapshot: snapshot(4) },
      },
      { status: 201 },
    );
  live.change({ type: "channel", run_id: "run-1" });
  expect((h.sources[0] as Source).closed).toBe(true);
  await vi.waitFor(() => expect(h.sources).toHaveLength(2));
  expect(h.bodies.at(-1)).toStrictEqual({
    view: { type: "channel", run_id: "run-1" },
    replaces: SUBSCRIPTION,
  });
  live.close();
  expect((h.sources[1] as Source).closed).toBe(true);
  await vi.waitFor(() => expect(h.deleted).toStrictEqual([NEXT_SUBSCRIPTION]));
});

test("recreates a subscription the server no longer serves from what it applied", async () => {
  const h = harness();
  const { states } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const source = h.sources[0] as Source;
  source.frame("run.changed", { id: id(2), base: id(1), row: row("settled") });
  h.answer = (body) =>
    Response.json(
      {
        subscription: NEXT_SUBSCRIPTION,
        view: body.view,
        initial: {
          type: "reset",
          id: id(8),
          base: id(2),
          subscription: NEXT_SUBSCRIPTION,
          reason: "unknown-cursor",
          snapshot: snapshot(8, "settled"),
        },
      },
      { status: 201 },
    );
  // A `410` closes an `EventSource` for good, which is what this is told.
  source.readyState = 2;
  source.onerror?.(new Event("error"));
  await vi.advanceTimersByTimeAsync(1_500);
  await vi.waitFor(() => expect(h.sources).toHaveLength(2));
  expect(h.bodies.at(-1)).toStrictEqual({
    view: { type: "sidebar" },
    resume: id(2),
  });
  expect(states.at(-1)?.[1]).toStrictEqual({
    kind: "reset",
    reason: "unknown-cursor",
  });
  expect(new URL((h.sources[1] as Source).url).searchParams.get("after")).toBe(
    id(8),
  );
  await settle();
});
