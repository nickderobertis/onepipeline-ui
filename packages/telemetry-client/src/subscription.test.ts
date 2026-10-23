import { readFileSync } from "node:fs";
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
      }) as typeof fetch, // `typeof fetch` carries overloads and a `preconnect` member no double implements and the client never reaches for; this answers the one call signature it makes.
      eventSource: (url) => {
        const source = new Source(url);
        sources.push(source);
        // `EventSource` is a DOM class Node does not ship; the client uses its
        // listener, `readyState`, `onopen`/`onerror` and `close` surface, which
        // `Source` implements over a real `EventTarget`.
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

/** The `index`th stream the client opened, which the test is waiting on. */
function sourceAt(h: Harness, index: number): Source {
  const source = h.sources[index];
  if (source === undefined) throw new Error(`no stream ${index} was opened`);
  return source;
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
  const source = sourceAt(h, 0);
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
  expect(new URL(sourceAt(h, 1).url).searchParams.get("after")).toBe(id(3));
});

test("applies a reset once as the new base, and stops at a patch it cannot apply", async () => {
  const h = harness();
  const { states, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const source = sourceAt(h, 0);
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
    "A patch could not be applied: a detail.patch for a run this tab does not show",
  ]);
  expect(states.at(-1)?.[0].applied).toBe(id(5));
});

test("refuses a frame the contract does not allow", async () => {
  const h = harness();
  const { states, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  sourceAt(h, 0).frame("run.changed", {
    id: id(2),
    base: id(1),
    row: { ...row("running"), liveness: "ACTIVE" },
  });
  expect(errors[0]?.message).toMatch(/contract validation/);
  expect(states).toHaveLength(1);
});

/** A payload this repository's own server serves, as `tests/contract.rs` pins it. */
const served = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../tests/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );
const SERVED_RUN = "run-20260807-a1b2c3";

test("replaces the subscription for a new view and retires it when closed", async () => {
  const h = harness();
  const { live, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  // Answered as the server answers the Channel view: its detail and queue.
  h.answer = (body) =>
    Response.json(
      {
        subscription: NEXT_SUBSCRIPTION,
        view: body.view,
        initial: {
          type: "snapshot",
          snapshot: {
            ...snapshot(4),
            visible: {
              type: "channel",
              run_id: SERVED_RUN,
              detail: served("run.json"),
              channel: served("run-channel.json"),
            },
          },
        },
      },
      { status: 201 },
    );
  live.change({ type: "channel", run_id: SERVED_RUN });
  expect(sourceAt(h, 0).closed).toBe(true);
  await vi.waitFor(() => expect(h.sources).toHaveLength(2));
  expect(h.bodies.at(-1)).toStrictEqual({
    view: { type: "channel", run_id: SERVED_RUN },
    replaces: SUBSCRIPTION,
  });
  expect(errors).toStrictEqual([]);
  live.close();
  expect(sourceAt(h, 1).closed).toBe(true);
  await vi.waitFor(() => expect(h.deleted).toStrictEqual([NEXT_SUBSCRIPTION]));
});

test("recreates a subscription the server no longer serves from what it applied", async () => {
  const h = harness();
  const { states } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const source = sourceAt(h, 0);
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
  expect(new URL(sourceAt(h, 1).url).searchParams.get("after")).toBe(id(8));
  await settle();
});

test("refuses a reset whose snapshot is not its own, and orders ids past the safe integers", async () => {
  const h = harness();
  const { states, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  const source = sourceAt(h, 0);
  // Two sequences one apart beyond 2^53: read as numbers they are one id.
  const huge = 2n ** 60n;
  source.frame("reset", {
    id: `${EPOCH}:${huge}`,
    base: id(1),
    reason: "stale-cursor",
    snapshot: { ...snapshot(1), id: `${EPOCH}:${huge}` },
  });
  source.frame("run.changed", {
    id: `${EPOCH}:${huge + 1n}`,
    base: `${EPOCH}:${huge}`,
    row: row("settled"),
  });
  expect(states.at(-1)?.[0].applied).toBe(`${EPOCH}:${huge + 1n}`);
  // A reset naming a snapshot other than itself is no base to resume from.
  source.frame("reset", {
    id: `${EPOCH}:${huge + 2n}`,
    base: `${EPOCH}:${huge + 1n}`,
    reason: "stale-cursor",
    snapshot: snapshot(3),
  });
  expect(errors.map(({ message }) => message)).toStrictEqual([
    "A reset frame names a snapshot other than itself",
  ]);
  expect(states.at(-1)?.[0].applied).toBe(`${EPOCH}:${huge + 1n}`);
});

test("refuses an answer for another view, and a frame whose SSE event or id is not its own", async () => {
  const other = harness();
  other.answer = () =>
    Response.json(
      {
        subscription: SUBSCRIPTION,
        view: { type: "channel", run_id: "run-1" },
        initial: { type: "snapshot", snapshot: snapshot(1) },
      },
      { status: 201 },
    );
  const answered = open(other);
  await vi.waitFor(() =>
    expect(answered.errors[0]?.message).toBe(
      "The subscription answered another view",
    ),
  );
  expect(other.sources).toHaveLength(0);

  const h = harness();
  const { states, errors } = open(h);
  await vi.waitFor(() => expect(h.sources).toHaveLength(1));
  // The frame arrives under another SSE event name than its own type.
  sourceAt(h, 0).dispatchEvent(
    new MessageEvent("run.removed", {
      data: JSON.stringify({
        type: "run.changed",
        subscription: SUBSCRIPTION,
        id: id(2),
        base: id(1),
        row: row("settled"),
      }),
      lastEventId: id(2),
    }),
  );
  expect(errors.map(({ message }) => message)).toStrictEqual([
    "A frame's SSE event or id is not the frame's own type and id",
  ]);
  expect(states).toHaveLength(1);
});
