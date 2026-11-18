import {
  parseRunTimeline,
  type TimelineEvent,
} from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import { busyTimeline, LIVE_RUN, runTimeline } from "../../test/fixtures";
import {
  collapseCycles,
  compactTimelineItems,
  compactTimelineMarkers,
  cycleLabel,
  dispatchRoleLabel,
  eventList,
  findRow,
  laneLabel,
  laneVocabulary,
  nodeTimeline,
  nodeTimelineV2,
  pathTo,
  readingRows,
  roleLaneId,
  runEventRows,
  spanAsRow,
  type TimelineRow,
  transcriptEntries,
  typeCounts,
} from "./timeline-model";

const timeline = parseRunTimeline(runTimeline(LIVE_RUN));

describe("one node's slice of the run timeline", () => {
  test("lists the node's own recorded work, in order, with its durations", () => {
    const dashboard = nodeTimeline(timeline, "dashboard");
    expect(dashboard.span?.id).toBe("node-dashboard");
    // The node's own span is the subject of the view, so what the rail lists is
    // what happened inside it — its dispatches, its rollup, its own events.
    expect(dashboard.rows.map(({ id }) => id)).toEqual([
      "dispatch-worker-session",
      "rollup-lock-wait-11",
      "event-9",
      "event-10",
      "event-11",
      "event-12",
      "event-13",
      "event-14",
      "dispatch-check-in-session",
      "dispatch-pr-author-session",
    ]);
    const worker = dashboard.rows[0];
    expect(worker?.kind).toBe("dispatch");
    expect(worker?.status).toBe("completed");
    // 11:00:12 to 11:01:00 is the interval the stream recorded for it.
    expect(worker?.durationMs).toBe(48_000);
    expect(worker?.displayLabel).toBe("worker (engineer-dashboard)");
    // Every session says which member it ran as — the run's own word for it —
    // and which session it was: three concurrent sessions of one dispatch are
    // told apart by nothing else.
    expect(worker?.children.map(({ displayLabel }) => displayLabel)).toEqual([
      "conversation-turn",
      "llmlint (llmlint-dashboard)",
      "judge (you-are-a-strict-careful-evaluator)",
    ]);
    expect(dashboard.rows.map(({ displayLabel }) => displayLabel)).toContain(
      "check-in (check-in-dashboard)",
    );
    expect(dashboard.rows.map(({ displayLabel }) => displayLabel)).toContain(
      "pr-author (pr-author-dashboard)",
    );
    // An aggregate stands in for thousands of records and carries their total
    // itself; it is named for what was aggregated, never for the word `rollup`.
    expect(dashboard.rows[1]?.durationMs).toBe(4200);
    expect(dashboard.rows[1]).toMatchObject({
      displayKind: "Lock waits",
      displayLabel: "Lock waits: 1240 recorded",
    });
  });

  test("names a redirection for what it changed rather than for the lever", () => {
    const rows = nodeTimeline(timeline, "dashboard").rows;
    const named = (id: string) =>
      rows.find((row) => row.id === id) ??
      (() => {
        throw new Error(`no row ${id}`);
      })();
    // Two records of the same kind, and the reading is which of them happened: a
    // reader of a turn that changed behaviour is asking whether the note reached it.
    expect(named("event-10")).toMatchObject({
      displayKind: "Redirection",
      displayLabel: "Redirected into the running turn",
    });
    expect(named("event-11")).toMatchObject({
      displayKind: "Redirection",
      displayLabel: "Redirection deferred to the next dispatch",
    });
    // Every other journal record is still an ordinary event, named by its kind.
    expect(named("event-9")).toMatchObject({
      displayKind: "Event",
      displayLabel: "checkpoint-recorded",
    });
  });

  test("names a surface by the host's own kind and an edit by its own author", () => {
    const rows = nodeTimeline(timeline, "dashboard").rows;
    const named = (id: string) =>
      rows.find((row) => row.id === id) ??
      (() => {
        throw new Error(`no row ${id}`);
      })();
    // Neither word is one this app declares: the vocabulary is the host's, and
    // the row reads what the record said rather than falling back to its kind.
    expect(named("event-12")).toMatchObject({
      displayKind: "Blocking surface",
      displayLabel: "sentinel-lost: the sentinel stopped answering",
    });
    expect(named("event-13")).toMatchObject({
      displayKind: "Event",
      displayLabel: "edit-committed · by sentinel",
    });
    // A change request's opener is not an edit's author, and is not read as one.
    expect(named("event-14")).toMatchObject({
      displayKind: "Event",
      displayLabel: "change-opened",
    });
  });

  test("calls a session the same word in the plot and wherever it is opened", () => {
    // A served role is the run's own word for the member, and it reaches the
    // operator exactly as served: no table here renames it. The conversation
    // panel heads an opened session with this same call, so the two surfaces
    // cannot drift into naming one session two things.
    for (const role of ["worker", "judge", "monitor", "sentinel", "pr-author"])
      expect(dispatchRoleLabel(role, "agent")).toBe(role);
    // A session the run recorded no declared member for is named by the party it
    // ran as, which is the one thing still known about it.
    expect(dispatchRoleLabel(undefined, "agent")).toBe("Agent");
    expect(dispatchRoleLabel(undefined, "judge")).toBe("Judge");
    expect(dispatchRoleLabel(undefined, "llmlint")).toBe("Lint");
    expect(dispatchRoleLabel(undefined, undefined)).toBe("Dispatch");
    // A session over a member's work is served under that member's own word —
    // the judge of a `worker` dispatch is `worker` on the wire — and the transport
    // is the one thing that tells it from the work, so it is read beside the word.
    // Never doubled where a host named the member after the transport it ran as.
    expect(dispatchRoleLabel("worker", "judge")).toBe("worker · judge");
    expect(dispatchRoleLabel("drafter", "llmlint")).toBe("drafter · llmlint");
    expect(dispatchRoleLabel("llmlint", "llmlint")).toBe("llmlint");
    expect(dispatchRoleLabel("worker", undefined)).toBe("worker");
    // And each served word is one the plot's own legend really shows, in the order
    // the payload served it, rather than a synonym of one that would read as a
    // category the reader never saw named.
    const served: string[] = [];
    for (const span of timeline.spans) {
      if (span.agent_role !== undefined && !served.includes(span.agent_role))
        served.push(span.agent_role);
    }
    expect(served).toEqual([
      "worker",
      "judge",
      "check-in",
      "pr-author",
      "llmlint",
      "monitor",
    ]);
    const legend = laneVocabulary(timeline).map(({ label }) => label);
    expect(legend.filter((label) => served.includes(label))).toEqual(served);
  });

  test("keeps a member named after a structural lane in a lane of its own", () => {
    // The word is the lane, and what the plot reads back as `Lane: …` — except
    // where a host named a member after a lane every run has, which would
    // otherwise plot that member in a lane meaning something else.
    expect(roleLaneId("sentinel")).toBe("sentinel");
    expect(roleLaneId("queued")).toBe("member:queued");
    expect(laneLabel(roleLaneId("queued"))).toBe("queued");
    expect(laneLabel("queued")).toBe("Queued");
    expect(laneLabel("sentinel")).toBe("sentinel");
  });

  test("gathers one dispatch's agent, lint, and judge sessions under it", () => {
    const dashboard = nodeTimeline(timeline, "dashboard");
    const worker = findRow(dashboard.rows, "dispatch-worker-session");
    // The agent session names the dispatch, and every session recorded inside it
    // carries the same name — which is what lets the transcript nest them.
    expect(worker?.dispatch).toEqual({
      id: "dispatch-worker-session",
      label: "Dispatch 1",
    });
    expect(
      worker?.children
        .filter(({ rowKind }) => rowKind === "span")
        .map(({ dispatch }) => dispatch?.label),
    ).toEqual(["Dispatch 1", "Dispatch 1"]);
    // A separately dispatched role is its own dispatch, not a member of the first.
    expect(
      findRow(dashboard.rows, "dispatch-check-in-session")?.dispatch,
    ).toEqual({ id: "dispatch-check-in-session", label: "Dispatch 2" });
    // The aggregate is no session at all, so it belongs to no dispatch.
    expect(
      findRow(dashboard.rows, "rollup-lock-wait-11")?.dispatch,
    ).toBeUndefined();
  });

  test("reports work the stream never closed as still running", () => {
    const approval = nodeTimeline(timeline, "approval");
    expect(
      approval.rows.map(({ kind, endedAt, durationMs }) => [
        kind,
        endedAt,
        durationMs,
      ]),
    ).toEqual([["human-wait", null, null]]);
  });

  test("keeps a node's publication events under the publication they belong to", () => {
    const foundation = nodeTimeline(timeline, "foundation");
    const publication = findRow(foundation.rows, "publication-6");
    expect(publication?.status).toBe("finished");
    expect(publication?.children.map(({ kind }) => kind)).toEqual([
      "pr-created",
      "pr-checks-observed",
    ]);
    expect(pathTo(foundation.rows, "event-7").map(({ id }) => id)).toEqual([
      "publication-6",
      "event-7",
    ]);
  });

  test("says nothing at all about a node the run never recorded", () => {
    expect(nodeTimeline(timeline, "queued")).toEqual({ rows: [], total: 0 });
    expect(nodeTimeline(undefined, "dashboard").rows).toEqual([]);
  });

  test("two hundred different sessions are two hundred rows: none is the same thing again", () => {
    const busy = nodeTimeline(parseRunTimeline(busyTimeline(200)), "dashboard");
    const listed = eventList(busy.rows);
    expect(listed.filter(({ rowKind }) => rowKind === "group")).toHaveLength(0);
    expect(busy.total).toBeGreaterThan(200);
  });

  /** A node whose own span holds exactly `events`, a minute apart, in order. */
  const nodeWith = (
    events: readonly (Partial<TimelineEvent> & { readonly kind: string })[],
  ): readonly TimelineRow[] => {
    const fixture = parseRunTimeline(runTimeline(LIVE_RUN));
    const node = fixture.spans.find(({ id }) => id === "node-dashboard");
    if (node === undefined) throw new Error("fixture lost the dashboard node");
    const at = (index: number) =>
      new Date(Date.parse("2026-07-26T12:00:00.000Z") + index * 60_000)
        .toISOString()
        .replace(".000Z", ".000Z");
    node.events = events.map((event, index) => ({
      id: `${event.kind}-${index}`,
      at: at(index),
      node_id: "dashboard",
      journal_order: index,
      ...event,
    }));
    fixture.spans = fixture.spans.filter(
      (span) => span.node_id !== "dashboard" || span.id === "node-dashboard",
    );
    return nodeTimeline(fixture, "dashboard").rows;
  };

  /** One hold toggling: queued, held behind a node, released. */
  const HOLD_PASS = [
    { kind: "node-requeued" },
    {
      kind: "node-held",
      fields: { reasons: [{ kind: "dependencies", blocking: ["schema"] }] },
    },
    {
      kind: "node-unheld",
      fields: { released: [{ kind: "dependencies", blocking: ["schema"] }] },
    },
  ] as const;

  test("a loop gone round twelve times is one block of one pass, its count and its span", () => {
    const rows = nodeWith(Array.from({ length: 12 }, () => HOLD_PASS).flat());
    const listed = eventList(rows);
    expect(listed).toHaveLength(1);
    const [block] = listed;
    if (block?.rowKind !== "group")
      throw new Error("the loop did not collapse");
    expect(block.count).toBe(12);
    expect(block.pass.map(({ kind }) => kind)).toEqual([
      "node-requeued",
      "node-held",
      "node-unheld",
    ]);
    expect(block.pass[1]?.displayLabel).toBe("Held waiting on schema");
    expect(block.children).toHaveLength(36);
    expect(block.startedAt).toBe("2026-07-26T12:00:00.000Z");
    expect(block.endedAt).toBe(
      new Date(
        Date.parse("2026-07-26T12:00:00.000Z") + 35 * 60_000,
      ).toISOString(),
    );
    expect(cycleLabel(block)).toBe("3 events repeated 12 times");
    // Closed, the block holds one pass; opened, every row in order.
    const closed = transcriptEntries(listed, new Set());
    expect(closed).toHaveLength(1);
    expect(readingRows(closed)).toHaveLength(3);
    const open = transcriptEntries(listed, new Set([block.id]));
    expect(readingRows(open).map(({ id }) => id)).toEqual(
      rows.map(({ id }) => id),
    );
  });

  test("two different repeats back to back are two blocks, and the longer saving wins", () => {
    const pair = [{ kind: "gate-run" }, { kind: "push" }];
    const rows = nodeWith([
      ...pair,
      ...pair,
      ...Array.from({ length: 5 }, () => ({ kind: "member-heartbeat" })),
    ]);
    const listed = eventList(rows);
    expect(listed.map((row) => row.rowKind)).toEqual(["group", "group"]);
    expect(
      listed.map((row) =>
        row.rowKind === "group" ? [row.pass.length, row.count] : [],
      ),
    ).toEqual([
      [2, 2],
      [1, 5],
    ]);
    // Four of one row are one loop of one row, not two loops of two.
    const four = collapseCycles(
      nodeWith(Array.from({ length: 4 }, () => ({ kind: "push" }))),
    );
    expect(four).toHaveLength(1);
    expect(four[0]?.rowKind === "group" && four[0].pass).toHaveLength(1);
  });

  test("a sequence that never repeats back to back is not collapsed", () => {
    const rows = nodeWith([
      { kind: "gate-run" },
      { kind: "push" },
      { kind: "gate-run" },
      { kind: "session-closed" },
      { kind: "push" },
    ]);
    expect(eventList(rows).map(({ rowKind }) => rowKind)).toEqual(
      Array.from({ length: 5 }, () => "event"),
    );
  });

  test("a row reads the same only with the same label: two different holds are no loop", () => {
    const rows = nodeWith([
      HOLD_PASS[1],
      {
        kind: "node-held",
        fields: { reasons: [{ kind: "dependencies", blocking: ["other"] }] },
      },
    ]);
    expect(eventList(rows).map(({ rowKind }) => rowKind)).toEqual([
      "event",
      "event",
    ]);
  });

  test("a row inside a block is found through it, under the block's own id", () => {
    const rows = nodeWith(Array.from({ length: 3 }, () => HOLD_PASS).flat());
    const listed = eventList(rows);
    const last = rows.at(-1);
    if (last === undefined) throw new Error("no rows");
    expect(pathTo(listed, last.id).map(({ rowKind }) => rowKind)).toEqual([
      "group",
      "event",
    ]);
  });

  test("hiding a type hides exactly its rows, and the repeat it broke up then collapses", () => {
    const rows = nodeWith([
      { kind: "push" },
      { kind: "planner-replied" },
      { kind: "push" },
      { kind: "planner-replied" },
      { kind: "push" },
    ]);
    expect(typeCounts(rows)).toEqual(
      new Map([
        ["repository", 3],
        ["reply", 2],
      ]),
    );
    const replies = eventList(rows, new Set(["repository"]));
    expect(replies.map(({ kind }) => kind)).toEqual(["planner-replied"]);
    expect(
      readingRows(transcriptEntries(replies, new Set([replies[0]?.id ?? ""]))),
    ).toHaveLength(2);
    expect(eventList(rows, new Set(["reply"]))).toHaveLength(1);
    expect(eventList(rows, new Set(["reply", "repository"]))).toEqual([]);
  });

  test("a surface's records are one row, read as where the surface stands", () => {
    const state = {
      id: 7,
      correlation: "q-7",
      kind: "planner-question",
      message: "ship it?",
      blocking: true,
      queued_at: "2026-07-26T12:00:00.000Z",
      read_at: "2026-07-26T12:01:00.000Z",
      replied_at: "2026-07-26T12:02:00.000Z",
      reply: { author: "planner", message: "yes" },
    };
    const rows = nodeWith([
      { kind: "planner-surface-queued", surface_id: 7, surface_state: state },
      { kind: "planner-surfaced", surface_id: 7, surface_state: state },
      {
        kind: "quiet-worker",
        surface_id: 8,
        surface_state: { id: 8, read_at: "2026-07-26T12:03:00.000Z" },
      },
      {
        kind: "planner-surface-queued",
        surface_id: 9,
        surface_state: {
          id: 9,
          blocking: true,
          kind: "finding",
          message: "red",
        },
      },
    ]);
    const listed = eventList(rows);
    expect(
      listed.map((row) => [row.displayLabel, row.status, row.type]),
    ).toEqual([
      ["planner-question: ship it?", "answered", "surface"],
      ["quiet-worker", "read", "surface"],
      ["finding: red", "waiting", "surface"],
    ]);
    expect(listed[0]?.statusAt).toBe("2026-07-26T12:02:00.000Z");
    // The second record's id still opens the one row standing for it.
    expect(findRow(listed, "planner-surfaced-1")?.id).toBe(
      "planner-surface-queued-0",
    );
  });

  test("the run's own list holds the records it made at no node, but none about a node's surface", () => {
    const run = parseRunTimeline(runTimeline(LIVE_RUN));
    const runLevel = run.spans.filter((span) => span.node_id === undefined);
    for (const span of runLevel) span.events = [];
    const root = runLevel[0];
    if (root === undefined) throw new Error("the fixture has no run span");
    root.events = [
      {
        id: "late",
        kind: "completion-requested",
        at: "2026-07-26T13:00:00.000Z",
      },
      { id: "early", kind: "edit-committed", at: "2026-07-26T12:00:00.000Z" },
      {
        id: "answer",
        kind: "planner-replied",
        at: "2026-07-26T12:30:00.000Z",
        surface_state: { id: 4, node: "dashboard" },
      },
      {
        id: "stray",
        kind: "node-ready",
        at: "2026-07-26T12:10:00.000Z",
        node_id: "dashboard",
      },
    ];
    expect(runEventRows(run).map(({ id }) => id)).toEqual(["early", "late"]);
    expect(runEventRows(undefined)).toEqual([]);
  });

  test("an edit reads as applied or not, and a command step as its command line", () => {
    const rows = nodeWith([
      { kind: "edit-committed", author: "planner" },
      { kind: "edit-rejected", author: "planner", fields: { reason: "no" } },
      {
        kind: "command-started",
        fields: { command: ["bun", "run", "build", "--name", "a b"] },
      },
    ]);
    expect(rows.map((row) => [row.status, row.displayLabel, row.type])).toEqual(
      [
        ["applied", "edit-committed · by planner", "edit"],
        ["not applied", "edit-rejected · by planner", "edit"],
        [undefined, "bun run build --name 'a b'", "command"],
      ],
    );
  });

  test("names a queued span for everything that was holding the node", () => {
    const behind = spanAsRow({
      id: "queued.dashboard.4",
      kind: "queued",
      label: "dashboard",
      started_at: "2026-07-26T11:00:00.000Z",
      ended_at: "2026-07-26T11:05:00.000Z",
      node_id: "dashboard",
      events: [],
      reasons: [{ kind: "concurrency", ahead: ["foundation", "publish"] }],
    });
    expect(behind.displayKind).toBe("Queued");
    expect(behind.displayLabel).toBe("Queued behind foundation, publish");
    // Two reasons at once read as two things, which is what tells this hold from
    // one the run recorded a single reason for.
    const both = spanAsRow({
      id: "queued.dashboard.9",
      kind: "queued",
      label: "dashboard",
      started_at: "2026-07-26T11:05:00.000Z",
      ended_at: null,
      node_id: "dashboard",
      events: [],
      reasons: [
        { kind: "dependencies", blocking: ["foundation"] },
        { kind: "decision", reference: "surface:7" },
      ],
    });
    expect(both.displayLabel).toBe(
      "Queued waiting on foundation and held by decision surface:7",
    );
    // A reason a later engine writes is still named rather than drawn as nothing.
    const later = spanAsRow({
      id: "queued.dashboard.11",
      kind: "queued",
      label: "dashboard",
      started_at: "2026-07-26T11:06:00.000Z",
      ended_at: null,
      node_id: "dashboard",
      events: [],
      reasons: [{ kind: "budget" }],
    });
    expect(later.displayLabel).toBe("Queued held by budget");
  });

  test("names lifecycle steps and distinguishes a retried worker dispatch", () => {
    const fixture = parseRunTimeline(runTimeline(LIVE_RUN));
    const node = fixture.spans.find(({ id }) => id === "node-dashboard");
    const worker = fixture.spans.find(
      ({ id }) => id === "dispatch-worker-session",
    );
    if (node === undefined || worker === undefined)
      throw new Error("fixture lost dashboard work");
    node.events.push({
      id: "retry-1",
      kind: "retry-requested",
      at: "2026-07-26T11:02:35.000Z",
      node_id: "dashboard",
    });
    fixture.spans.push(
      {
        ...worker,
        id: "dispatch-worker-retry",
        label: "engineer-dashboard-retry",
        started_at: "2026-07-26T11:02:40.000Z",
        ended_at: "2026-07-26T11:03:00.000Z",
      },
      {
        id: "step-build",
        kind: "step",
        label: "Build and verify",
        parent_id: "node-dashboard",
        node_id: "dashboard",
        step_id: "build",
        started_at: "2026-07-26T11:03:01.000Z",
        ended_at: "2026-07-26T11:03:20.000Z",
        status: "done",
        events: [],
      },
    );

    const projected = nodeTimeline(fixture, "dashboard");
    expect(
      findRow(projected.rows, "dispatch-worker-session")?.dispatch,
    ).toMatchObject({ label: "Dispatch 1" });
    expect(findRow(projected.rows, "dispatch-worker-retry")?.displayLabel).toBe(
      "worker (engineer-dashboard-retry) · retry 1",
    );
    // A retry is a second dispatch of the same node, never a second session of the
    // first one, so it opens a group of its own.
    expect(findRow(projected.rows, "dispatch-worker-retry")?.dispatch?.id).toBe(
      "dispatch-worker-retry",
    );
    expect(findRow(projected.rows, "step-build")).toMatchObject({
      displayKind: "Lifecycle",
      displayLabel: "Lifecycle: Build and verify",
    });
    expect(projected.rows.some(({ id }) => id === "node-dashboard")).toBe(
      false,
    );
  });

  test("projects intervals into deterministic lanes and journals into markers", () => {
    const projected = nodeTimelineV2(timeline, "dashboard");
    // The member lanes are the payload's own words in the payload's own order —
    // neither the alphabet's nor any this app keeps — between the queue and the
    // structural kinds; the unroled lane is absent because no session needs it.
    expect(projected.lanes.map(({ label }) => label)).toEqual([
      "Queued",
      "worker",
      "judge",
      "check-in",
      "pr-author",
      "llmlint",
      "monitor",
      "Verification",
      "Publication",
      "Lock waits",
      "Human wait",
    ]);
    expect(
      projected.items.find(({ id }) => id === "dispatch-judge-session"),
    ).toMatchObject({ laneId: "judge" });
    expect(
      projected.items.find(({ id }) => id === "rollup-lock-wait-11"),
    ).toMatchObject({ laneId: "lock-waits", duration: 4200 });
    expect(projected.markers.some(({ id }) => id === "event-9")).toBe(true);
    expect(projected.items.some(({ id }) => id === "event-9")).toBe(false);
  });

  test("draws each journal marker as the category its kind is read under", () => {
    const projected = nodeTimelineV2(timeline, "dashboard");
    const records = projected.rows.filter((row) => row.rowKind === "event");
    // Several different things happened on this node, and the plot says so: a
    // conversation took turns, a checkpoint this build has no rule for was
    // recorded, the planner redirected a turn that was already running, a host's
    // observer raised a surface and applied an edit, and a change was opened.
    expect(
      records.map(({ event, category }) => [event.kind, category]),
    ).toEqual([
      ["conversation-turn", "session"],
      ["conversation-turn", "session"],
      ["conversation-turn", "session"],
      ["checkpoint-recorded", "activity"],
      ["turn-interrupted", "recovery"],
      ["turn-interrupted", "recovery"],
      ["planner-surface-queued", "planning"],
      ["edit-committed", "repository"],
      ["change-opened", "publication"],
      ["conversation-turn", "session"],
      ["conversation-turn", "session"],
    ]);
    // Every marker carries a glyph of its own. Left unset, the rail falls back to
    // one pin for all of them — which is a plot that cannot be scanned, only read.
    expect(projected.markers.length).toBe(records.length);
    expect(projected.markers.every(({ icon }) => icon !== undefined)).toBe(
      true,
    );
  });

  test("plots work the record never closed to the end of what the node recorded", () => {
    // A dispatch the run has not settled is served open-ended. Plotted at its own
    // start it would be an instant — the one thing on the node that is still
    // happening, drawn as the one thing a reader cannot point at.
    const open = parseRunTimeline(runTimeline(LIVE_RUN));
    const inFlight = open.spans.find(
      (span) => span.id === "dispatch-worker-session",
    );
    if (inFlight === undefined) throw new Error("fixture lost the dispatch");
    const projected = nodeTimelineV2(
      {
        ...open,
        spans: open.spans.map((span) =>
          span.id === inFlight.id ? { ...span, ended_at: null } : span,
        ),
      },
      "dashboard",
    );
    const worker = projected.items.find(({ id }) => id === inFlight.id);
    const recorded = Math.max(
      ...projected.items.map((item) => item.end ?? item.start),
      ...projected.markers.map((marker) => marker.at),
    );
    expect(worker?.end).toBe(recorded);
    expect(worker?.duration).toBe(recorded - (worker?.start ?? 0));
    // And a span the record *did* close keeps the interval it recorded.
    const judge = projected.items.find(({ laneId }) => laneId === "judge");
    expect(judge?.end).toBe(
      Date.parse(
        open.spans.find((span) => span.id === judge?.id)?.ended_at ?? "",
      ),
    );
  });

  test("keeps one deterministic hit target for coincident compact items", () => {
    const projected = nodeTimelineV2(timeline, "dashboard");
    const worker = projected.items.find(({ laneId }) => laneId === "worker");
    const judge = projected.items.find(({ laneId }) => laneId === "judge");
    const lint = projected.items.find(({ laneId }) => laneId === "llmlint");
    if (worker === undefined || judge === undefined || lint === undefined)
      throw new Error("fixture lost the dashboard's dispatches");
    // Three moments, two of them coincident and neither an end of the window: the
    // pair collapses to the category that dominates it, and the window's own ends
    // are untouched, so what the compact line spans is what the node spans.
    const first = { ...lint, start: 0, end: 10 };
    const compacted = compactTimelineItems(
      [
        first,
        { ...judge, start: 1_000, end: 1_000 },
        { ...worker, start: 1_000, end: 1_000 },
        { ...lint, id: "last", start: 100_000, end: 100_010 },
      ],
      projected.lanes,
    );
    expect(compacted.map(({ id }) => id)).toEqual([
      first.id,
      "last",
      worker.id,
    ]);
  });

  test("drops a category a window end covers rather than painting it underneath", () => {
    const projected = nodeTimelineV2(timeline, "dashboard");
    const worker = projected.items.find(({ laneId }) => laneId === "worker");
    const judge = projected.items.find(({ laneId }) => laneId === "judge");
    if (worker === undefined || judge === undefined)
      throw new Error("fixture lost the dashboard's dispatches");
    // The shape a node that dispatched a worker and the judge over it serves: both
    // run the whole of it, so the worker is both ends of the window and the judge
    // is inside it at every pixel. Kept, the judge would be painted over the whole
    // worker — a segment nothing can point at, and the one the reader came for.
    const served = [
      { ...worker, start: 0, end: 60_000 },
      { ...judge, start: 0, end: 60_000 },
    ];
    expect(compactTimelineItems(served).map(({ id }) => id)).toEqual([
      worker.id,
    ]);
    // And the dominant one still wins when it is the later arrival, without taking
    // the window's end with it.
    expect(
      compactTimelineItems(
        [
          { ...judge, start: 0, end: 60_000 },
          { ...worker, start: 0, end: 60_000 },
        ],
        projected.lanes,
      ).map(({ id }) => id),
    ).toEqual([judge.id, worker.id]);
  });

  test("spans the same window compact as expanded", () => {
    const projected = nodeTimelineV2(timeline, "dashboard");
    const worker = projected.items.find(({ laneId }) => laneId === "worker");
    const waits = projected.items.find(({ laneId }) => laneId === "lock-waits");
    if (worker === undefined || waits === undefined)
      throw new Error("fixture lost the dashboard's work");
    const bounds = (items: readonly { start: number; end?: number | null }[]) =>
      [
        Math.min(...items.map(({ start }) => start)),
        Math.max(...items.map((item) => item.end ?? item.start)),
      ] as const;
    // The shape the server serves: a short aggregate at the very start of the node,
    // and a session opening inside the same visual cluster that dominates it — over
    // a window wide enough that the two really do compete for one hit target.
    const served = [
      { ...waits, start: 0, end: 10_000 },
      { ...worker, start: 5_000, end: 55_000 },
      { ...worker, id: "last", start: 225_000, end: 255_000 },
    ];
    // The axis and the time cursor are read straight off the plotted items, so a
    // compaction that dropped either end would move the same moment on collapse.
    expect(bounds(compactTimelineItems(served))).toEqual(bounds(served));
    expect(compactTimelineItems(served)).toHaveLength(3);
  });

  test("keeps a selected marker clickable when journal icons coincide", () => {
    const projected = nodeTimelineV2(timeline, "dashboard");
    const markers = projected.markers.slice(0, 2);
    const second = markers[1];
    if (second === undefined) throw new Error("fixture lost journal markers");
    const coincident = markers.map((marker) => ({ ...marker, at: second.at }));
    expect(compactTimelineMarkers(coincident, projected.items)).toHaveLength(1);
    expect(
      compactTimelineMarkers(coincident, projected.items, second.id)[0]?.id,
    ).toBe(second.id);
  });
});
