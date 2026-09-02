import { parseRunTimeline, type TimelineSpan } from "@onepipeline-ui/dag-model";
import { describe, expect, test } from "vitest";
import { busyTimeline, LIVE_RUN, runTimeline } from "../../test/fixtures";
import {
  collapseLabel,
  compactTimelineItems,
  compactTimelineMarkers,
  type DispatchRole,
  dispatchRoleLabel,
  findRow,
  GROUP_THRESHOLD,
  NODE_LANES,
  nodeTimeline,
  nodeTimelineV2,
  pathTo,
  spanAsRow,
  type TimelineRow,
  transcriptEntries,
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
      "dispatch-check-in-session",
      "dispatch-pr-author-session",
    ]);
    const worker = dashboard.rows[0];
    expect(worker?.kind).toBe("dispatch");
    expect(worker?.status).toBe("completed");
    // 11:00:12 to 11:01:00 is the interval the stream recorded for it.
    expect(worker?.durationMs).toBe(48_000);
    expect(worker?.displayLabel).toBe("Worker (engineer-dashboard)");
    // Every session says which role it played and which session it was — three
    // concurrent sessions of one dispatch are told apart by nothing else.
    expect(worker?.children.map(({ displayLabel }) => displayLabel)).toEqual([
      "conversation-turn",
      "Lint (llmlint-dashboard)",
      "Judge (you-are-a-strict-careful-evaluator)",
    ]);
    expect(dashboard.rows.map(({ displayLabel }) => displayLabel)).toContain(
      "Check-in (check-in-dashboard)",
    );
    expect(dashboard.rows.map(({ displayLabel }) => displayLabel)).toContain(
      "PR author (pr-author-dashboard)",
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

  test("calls a session the same word in the plot and wherever it is opened", () => {
    // Every served role, and the word the operator reads for it. The conversation
    // panel heads an opened session with this same call, so the two surfaces cannot
    // drift into naming one session two things: there is one vocabulary, not a copy
    // of it beside each surface that reads it.
    const roles: readonly DispatchRole[] = [
      "worker",
      "judge",
      "llmlint",
      "orchestrator",
      "check-in",
      "pr-author",
    ];
    expect(roles.map(dispatchRoleLabel)).toEqual([
      "Worker",
      "Judge",
      "Lint",
      "Orchestrator",
      "Check-in",
      "PR author",
    ]);
    // And each is a word the plot's own legend really shows, rather than a synonym
    // of one that would read as a category the reader never saw named.
    const legend = NODE_LANES.map(({ label }) => label);
    for (const role of roles) expect(legend).toContain(dispatchRoleLabel(role));
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

  test("collapses hundreds of sessions into rows a reader can scan", () => {
    const busy = nodeTimeline(parseRunTimeline(busyTimeline(200)), "dashboard");
    // Two hundred conversations arrive as one row, not two hundred; the run they
    // stand for — every consecutive dispatch, including the four the fixture's own
    // node recorded — is still reachable inside it, in the order it happened.
    const group = busy.rows.find(({ rowKind }) => rowKind === "group");
    expect(group?.label).toBe("203 × dispatch");
    expect(group?.children).toHaveLength(203);
    // What the reader is handed where those two hundred and three stood is three
    // things: the first, one control naming the rest, and the last.
    const reading = transcriptEntries(busy.rows, new Set());
    expect(
      reading.find(({ entryKind }) => entryKind === "collapse"),
    ).toMatchObject({ hidden: 201, expanded: false });
    expect(reading.length).toBeLessThan(20);
    expect(busy.total).toBeGreaterThan(200);
  });

  /** The two kinds of row this list can hold a consecutive run of. */
  const SHAPES: readonly ["event", "span"] = ["event", "span"];

  /** A run of `count` identical rows of `kind`, as a node's own span carries them. */
  const runOf = (
    kind: string,
    count: number,
    shape: (typeof SHAPES)[number],
  ): readonly TimelineRow[] => {
    const fixture = parseRunTimeline(runTimeline(LIVE_RUN));
    const node = fixture.spans.find(({ id }) => id === "node-dashboard");
    if (node === undefined) throw new Error("fixture lost the dashboard node");
    node.events = Array.from({ length: count }, (_, index) => ({
      id: `${kind}-${index}`,
      kind,
      at: `2026-07-26T12:${String(index).padStart(2, "0")}:00.000Z`,
      node_id: "dashboard",
    }));
    fixture.spans = fixture.spans.filter(
      (span) => span.node_id !== "dashboard" || span.id === "node-dashboard",
    );
    const siblings: TimelineSpan[] = Array.from(
      { length: count },
      (_, index) => ({
        id: `verification-${index}`,
        kind: "verification",
        label: `check-${index}`,
        parent_id: "node-dashboard",
        node_id: "dashboard",
        started_at: `2026-07-26T13:${String(index).padStart(2, "0")}:00.000Z`,
        ended_at: `2026-07-26T13:${String(index).padStart(2, "0")}:30.000Z`,
        events: [],
      }),
    );
    if (shape === "span") fixture.spans.push(...siblings);
    return nodeTimeline(fixture, "dashboard").rows;
  };

  test("collapses a run of journal records on the rule it collapses spans by", () => {
    // The boundary, from both sides, for the two kinds of row this list holds. One
    // rule, one count: a reader learns this behaviour once.
    for (const shape of SHAPES) {
      const kind = shape === "event" ? "turn-activity" : "verification";
      const short = runOf(kind, GROUP_THRESHOLD - 1, shape);
      expect(short.filter(({ rowKind }) => rowKind === "group")).toHaveLength(
        0,
      );
      const long = runOf(kind, GROUP_THRESHOLD, shape);
      const group = long.find(({ rowKind }) => rowKind === "group");
      expect(group, `a run of ${GROUP_THRESHOLD} ${kind} did not collapse`);
      expect(group?.children).toHaveLength(GROUP_THRESHOLD);
      // And what is then shown is the same shape either way: the first in full,
      // one control naming how many are behind it and what they are, the last in
      // full.
      const reading = transcriptEntries(long, new Set());
      const shown = reading.filter(
        (entry) => entry.entryKind === "row" && entry.row.kind === kind,
      );
      expect(shown).toHaveLength(2);
      const control = reading.find(
        (entry) => entry.entryKind === "collapse" && entry.group.kind === kind,
      );
      expect(control).toMatchObject({
        hidden: GROUP_THRESHOLD - 2,
        expanded: false,
      });
      expect(collapseLabel(GROUP_THRESHOLD - 2, kind)).toBe(
        `${GROUP_THRESHOLD - 2} more ${kind} events`,
      );
    }
  });

  test("puts the middle of a collapsed run back when the reader opens it", () => {
    const rows = runOf("turn-activity", 6, "event");
    const group = rows.find(({ rowKind }) => rowKind === "group");
    if (group === undefined) throw new Error("the run did not collapse");
    const closed = transcriptEntries(rows, new Set());
    expect(
      closed.filter(
        (entry) =>
          entry.entryKind === "row" && entry.row.kind === "turn-activity",
      ),
    ).toHaveLength(2);
    const open = transcriptEntries(rows, new Set([group.id]));
    expect(
      open.filter(
        (entry) =>
          entry.entryKind === "row" && entry.row.kind === "turn-activity",
      ),
    ).toHaveLength(6);
    expect(open.find((entry) => entry.entryKind === "collapse")).toMatchObject({
      expanded: true,
      hidden: 4,
    });
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
      "Worker (engineer-dashboard-retry) · retry 1",
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
    expect(projected.lanes.map(({ label }) => label)).toEqual([
      "Queued",
      "Worker",
      "Judge",
      "Lint",
      "Orchestrator",
      "Check-in",
      "PR author",
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
    // Three different things happened on this node, and the plot says so: a
    // conversation took turns, a checkpoint this build has no rule for was
    // recorded, and the planner redirected a turn that was already running.
    expect(
      records.map(({ event, category }) => [event.kind, category]),
    ).toEqual([
      ["conversation-turn", "session"],
      ["conversation-turn", "session"],
      ["conversation-turn", "session"],
      ["checkpoint-recorded", "activity"],
      ["turn-interrupted", "recovery"],
      ["turn-interrupted", "recovery"],
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
    const lint = projected.items.find(({ laneId }) => laneId === "lint");
    if (worker === undefined || judge === undefined || lint === undefined)
      throw new Error("fixture lost the dashboard's dispatches");
    // Three moments, two of them coincident and neither an end of the window: the
    // pair collapses to the category that dominates it, and the window's own ends
    // are untouched, so what the compact line spans is what the node spans.
    const first = { ...lint, start: 0, end: 10 };
    const compacted = compactTimelineItems([
      first,
      { ...judge, start: 1_000, end: 1_000 },
      { ...worker, start: 1_000, end: 1_000 },
      { ...lint, id: "last", start: 100_000, end: 100_010 },
    ]);
    expect(compacted.map(({ id }) => id)).toEqual([
      first.id,
      worker.id,
      "last",
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
      compactTimelineItems([
        { ...judge, start: 0, end: 60_000 },
        { ...worker, start: 0, end: 60_000 },
      ]).map(({ id }) => id),
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
