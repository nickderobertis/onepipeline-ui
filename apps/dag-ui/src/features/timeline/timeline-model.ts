import type {
  TimelineItem,
  TimelineLane,
  TimelineMarker,
} from "@oneharness/ui";
import type {
  AgentRole,
  RunTimeline,
  TimelineEvent,
  TimelineHoldReason,
  TimelineSpan,
  TimelineSpanKind,
} from "@onepipeline-ui/dag-model";
import { createElement } from "react";
import { type EventCategory, eventCategory } from "./event-category";
import { MarkerReading } from "./item-reading";

/**
 * One node's slice of the served run timeline, as rows a rail can render.
 *
 * The served payload is a flat span list carrying the tree in `parent_id`; this
 * rebuilds that tree for one node, merges each span's child spans with its own
 * events into one recorded order, and collapses long runs of same-kind siblings so
 * a node that dispatched two hundred sessions is a row rather than two hundred.
 */

/**
 * Consecutive siblings of one kind collapse into a group once a run reaches this
 * many.
 *
 * **One rule for every kind of row.** A run of dispatch spans and a run of
 * `turn-activity` records are the same problem — near-identical rows burying the
 * one that matters — so they collapse at the same count and are presented the same
 * way, and a reader learns the behaviour once. Four is where a run stops being
 * scannable at the row height this list is drawn at: three of a kind read as three
 * things, and the fourth is where the eye starts skipping.
 */
export const GROUP_THRESHOLD = 4;

/**
 * One onejudge dispatch: the agent session and the judge and lint sessions that
 * supervised it, which the operator reads as a single labelled unit.
 */
export interface DispatchGroup {
  /** The agent session's own span id, which every member of the group shares. */
  readonly id: string;
  /** Operator-facing name of the group, in the order the node dispatched them. */
  readonly label: string;
}

interface RowBase {
  readonly id: string;
  /** What the row is: a span kind, a journal event kind, or the grouped span kind. */
  readonly kind: string;
  /**
   * What a dispatch was for — worker, judge, orchestrator, check-in, pr-author, or
   * the lint run under a worker. Served on the span itself, so a row says which
   * session it is without the transcript behind it being fetched. Absent on every
   * other kind of row, and on a dispatch recorded before the roles were served.
   */
  readonly role?: DispatchRole;
  readonly label: string;
  readonly startedAt: string;
  /** `null` for work the recorded stream never closed, and for an instant. */
  readonly endedAt: string | null;
  readonly status?: string;
  readonly durationMs: number | null;
  readonly children: readonly TimelineRow[];
  /** Operator-facing identity; never the free-text transport/session label. */
  readonly displayLabel: string;
  /** Lane vocabulary; a container and an aggregate are named for what they hold. */
  readonly displayKind: string;
  /** The oneharness session this row is, when it is one; absent otherwise. */
  readonly sessionName?: string;
  /** The onejudge dispatch this session belongs to; absent on every other row. */
  readonly dispatch?: DispatchGroup;
}

export type TimelineRow =
  | (RowBase & { readonly rowKind: "span"; readonly span: TimelineSpan })
  | (RowBase & {
      readonly rowKind: "event";
      readonly event: TimelineEvent;
      /**
       * What this record is, coarsely enough for one glyph to carry it. Carried by a
       * journal record and by nothing else: a span is already told apart by the lane
       * it is plotted in and by the words its eyebrow names it with, and a marker is
       * the one thing this view draws that had no distinction at all.
       */
      readonly category: EventCategory;
    })
  | (RowBase & { readonly rowKind: "group"; readonly count: number });

export interface NodeTimeline {
  /** The node's own span, when the recorded stream opened one. */
  readonly span?: TimelineSpan;
  readonly rows: readonly TimelineRow[];
  /** Every span and event this node recorded, however deeply nested. */
  readonly total: number;
}

const EMPTY: NodeTimeline = { rows: [], total: 0 };

/**
 * The categories a node's recorded work is read in, one lane each.
 *
 * Every one of them is a word the server already serves — the `agent_role` and
 * `transport_role` of a dispatch, and the span kinds around them — so a reader is
 * never shown a category the journal has no record of.
 */
const LANE_LABELS = {
  // First, because it is what happened before anything else on the node, and
  // because `compactTimelineItems` reads this order as priority: where a queued
  // span shares a moment with anything, why nothing was running is the answer the
  // reader opened the node for.
  queued: "Queued",
  worker: "Worker",
  judge: "Judge",
  lint: "Lint",
  orchestrator: "Orchestrator",
  "check-in": "Check-in",
  "pr-author": "PR author",
  verification: "Verification",
  publication: "Publication",
  "lock-waits": "Lock waits",
  "human-wait": "Human wait",
} as const;

export type LaneId = keyof typeof LANE_LABELS;

export const NODE_LANES: readonly TimelineLane[] = Object.entries(
  LANE_LABELS,
).map(([id, label]) => ({ id, label }));

/**
 * Which lane each served span kind belongs in, or `null` for the kinds that hold
 * work rather than being work.
 *
 * Keyed by the contract's own closed span vocabulary, so a kind added to
 * `timelineSpanKindSchema` fails to compile here until it has been given a lane
 * rather than silently landing in whichever one a string comparison reached first.
 */
const LANE_BY_SPAN_KIND: Readonly<Record<TimelineSpanKind, LaneId | null>> = {
  // The run is the root every other span hangs off, and holds no work of its own.
  run: null,
  node: null,
  // A lifecycle step brackets the sessions inside it; the transcript names it, and
  // giving it a lane of its own would plot the container over its own contents.
  step: null,
  // Refined by the dispatch's own served roles; `worker` is what an unroled one is.
  dispatch: "worker",
  verification: "verification",
  publication: "publication",
  "pr-drafting": "pr-author",
  // Resolving a conflict is work on the merge, so it reads beside the publication
  // it is unblocking rather than as a category an operator has to learn.
  "conflict-resolution": "publication",
  "human-wait": "human-wait",
  // Why the loop was not running the node: real recorded time, in a lane of its
  // own rather than as the empty space it used to be drawn as.
  queued: "queued",
  rollup: "lock-waits",
};

/**
 * What one dispatch is read as: the semantic role the server records on it, or the
 * lint transport, which is the worker's own verification told apart from the worker
 * by nothing else.
 */
export type DispatchRole = AgentRole | typeof LLMLINT_TRANSPORT;

export const LLMLINT_TRANSPORT = "llmlint";

/**
 * The lane each of those roles is plotted in.
 *
 * Keyed by the contract's own closed `agentRoleSchema`, so a role added there fails
 * to compile until it has been given a lane — rather than falling through to the
 * dispatch default and being plotted and named "Worker" without anything saying so.
 */
const LANE_BY_ROLE: Readonly<Record<DispatchRole, LaneId>> = {
  worker: "worker",
  judge: "judge",
  llmlint: "lint",
  orchestrator: "orchestrator",
  "check-in": "check-in",
  "pr-author": "pr-author",
};

/**
 * Which of those roles onejudge dispatches in its own right, and which run over an
 * agent's work. Keyed by the same enum for the same reason: a newly served role that
 * matched neither would be left an ungrouped sibling with nothing reporting it.
 */
const OPENS_DISPATCH: Readonly<Record<DispatchRole, boolean>> = {
  worker: true,
  orchestrator: true,
  "check-in": true,
  "pr-author": true,
  judge: false,
  llmlint: false,
};

/**
 * What one dispatch role is called wherever the operator meets it: the lane legend,
 * the transcript's eyebrow, and the header of the conversation it opens.
 *
 * The lane vocabulary above is the one source of those words. A second table of them
 * beside the conversation panel would agree with this one only for as long as nobody
 * renamed a role in one place — and every test would stay green while the plot and
 * the transcript it is read against called the same session two different things.
 */
export function dispatchRoleLabel(role: DispatchRole): string {
  return LANE_LABELS[LANE_BY_ROLE[role]];
}

/** What each aggregated journal kind is called; `rollup` is never a word here. */
const ROLLUP_LABELS: Readonly<Record<string, string>> = {
  "lock-wait": "Lock waits",
};

export interface NodeTimelineV2 {
  readonly items: readonly TimelineItem<TimelineRow>[];
  readonly markers: readonly TimelineMarker<TimelineRow>[];
  readonly lanes: readonly TimelineLane[];
  /** Every row this node recorded, flattened into the order they are read in. */
  readonly rows: readonly TimelineRow[];
  /**
   * The same rows with their nesting intact, which is what the reading is drawn
   * from: a collapsed run is a group row holding the members it stands for, and
   * flattening it away loses which rows the control speaks for.
   */
  readonly tree: readonly TimelineRow[];
}

/**
 * The compact lane answers which activity dominated a moment. Coincident point
 * records cannot all own the same hit target, so retain one deterministically;
 * expanding restores every category in its own lane.
 *
 * Whichever items it drops, the interval the survivors span is the interval the whole
 * set spans: the plotted range is read straight off the items, so dropping the
 * earliest one would move the axis and the time cursor on collapse, and the same
 * moment would sit at two different places depending on which view was open.
 */
export function compactTimelineItems<Payload>(
  items: readonly TimelineItem<Payload>[],
): readonly TimelineItem<Payload>[] {
  const ordered = [...items].sort((left, right) => left.start - right.start);
  const first = ordered.at(0)?.start ?? 0;
  const last = Math.max(
    first + 1,
    ...ordered.map((item) => item.end ?? item.start),
  );
  const boundaries = new Set(
    [
      ordered.at(0),
      ordered.reduce<TimelineItem<Payload> | undefined>(
        (latest, item) =>
          latest === undefined ||
          (item.end ?? item.start) > (latest.end ?? latest.start)
            ? item
            : latest,
        undefined,
      ),
    ]
      .filter((item) => item !== undefined)
      .map(({ id }) => id),
  );
  // A compact point is 20 CSS pixels wide. Treat the nearest 2% of the plotted
  // range as one visual moment so sibling buttons never cover one another at the
  // viewport sizes the application supports.
  const pointCluster = (last - first) * 0.02;
  const result: TimelineItem<Payload>[] = [];
  for (const item of ordered) {
    const itemVisualEnd = Math.max(
      item.end ?? item.start,
      item.start + pointCluster,
    );
    const collision = result.findLast((candidate) => {
      const candidateVisualEnd = Math.max(
        candidate.end ?? candidate.start,
        candidate.start + pointCluster,
      );
      return (
        item.start <= candidateVisualEnd && candidate.start <= itemVisualEnd
      );
    });
    // An item that meets one of the two boundaries neither replaces it nor is
    // dropped by it: both are kept, because losing either end moves the axis and
    // losing the other would silently hide work that really did happen there —
    // a shorter one inside a window end is drawn over it and stays reachable.
    // One that runs the *same* length as it is not: it would be painted over
    // every pixel of a segment nothing else can reach, so the moment goes to
    // whichever category dominates it and the rest are read in the lanes.
    if (collision === undefined || boundaries.has(item.id)) {
      result.push(item);
    } else if (compactPriority(item) < compactPriority(collision)) {
      if (boundaries.has(collision.id)) result.push(item);
      else result[result.indexOf(collision)] = item;
    } else if (!coincident(item, collision, pointCluster)) {
      result.push(item);
    }
  }
  return result;
}

/** Whether two plotted items occupy the same pixels, to within one visual moment. */
function coincident(
  item: TimelineItem<unknown>,
  other: TimelineItem<unknown>,
  cluster: number,
): boolean {
  return (
    Math.abs(item.start - other.start) <= cluster &&
    Math.abs((item.end ?? item.start) - (other.end ?? other.start)) <= cluster
  );
}

function compactPriority(item: TimelineItem<unknown>): number {
  const lane = item.laneId ?? "";
  const order = NODE_LANES.findIndex(({ id }) => id === lane);
  return order < 0 ? NODE_LANES.length : order;
}

/** Keep one clickable journal icon per visual moment, always retaining a deep link. */
export function compactTimelineMarkers<Payload>(
  markers: readonly TimelineMarker<Payload>[],
  items: readonly TimelineItem<Payload>[],
  selectedId?: string,
): readonly TimelineMarker<Payload>[] {
  const times = [
    ...markers.map(({ at }) => at),
    ...items.flatMap((item) => [item.start, item.end ?? item.start]),
  ];
  const first = Math.min(...times);
  const cluster = (Math.max(...times) - first) * 0.02;
  const result: TimelineMarker<Payload>[] = [];
  for (const marker of [...markers].sort((left, right) => left.at - right.at)) {
    const collision = result.findLast(
      (candidate) => marker.at - candidate.at <= cluster,
    );
    if (collision === undefined) result.push(marker);
    else if (marker.id === selectedId)
      result[result.indexOf(collision)] = marker;
  }
  return result;
}

/** Project the served vocabulary into Timeline v2: intervals use lanes; journals use markers. */
export function nodeTimelineV2(
  timeline: RunTimeline | undefined,
  nodeId: string,
): NodeTimelineV2 {
  const projected = nodeTimeline(timeline, nodeId).rows;
  const rows = flattenRows(projected);
  const plottedRows = flattenRows(projected, false);
  const items = plottedRows.flatMap((row): TimelineItem<TimelineRow>[] => {
    const lane = laneId(row);
    if (lane === null) return [];
    const start = Date.parse(row.startedAt);
    const recordedEnd = row.endedAt === null ? null : Date.parse(row.endedAt);
    // An aggregate stands in for thousands of separate waits and carries their total
    // itself, so it is plotted at the length it actually waited. Its recorded
    // start-to-end interval is the window those waits fell in, and plotting that
    // would draw a bar across the whole node for a wait of a few seconds.
    const end =
      row.rowKind === "span" && row.span.total_duration_ms !== undefined
        ? start + row.span.total_duration_ms
        : recordedEnd;
    return [
      {
        id: row.id,
        label: row.displayLabel,
        laneId: lane,
        payload: row,
        start,
        end,
        duration: end === null ? null : end - start,
        status: row.status,
      },
    ];
  });
  // Markers come off *every* row rather than off the plotted ones: a journal record
  // inside a collapsed run is still a moment the run recorded, and dropping its pin
  // would take the plot's account of that moment away with the reading's. The plot
  // stays bounded by `compactTimelineMarkers`, which is what bounds it anyway.
  const markers = rows.flatMap((row): TimelineMarker<TimelineRow>[] =>
    row.rowKind === "event"
      ? [
          {
            id: row.id,
            label: row.displayLabel,
            at: Date.parse(row.startedAt),
            payload: row,
            status: row.status,
            // The one place the plot could say what a record *is*. Left unset, the
            // rail draws every marker as the same pin, and a reader scanning for the
            // one record that matters has to open each of them to find it — and a
            // glyph alone says only which of eleven kinds of thing it was, so it
            // carries the record's own reading for a hover to answer with.
            icon: createElement(MarkerReading, { row }),
          },
        ]
      : [],
  );
  // Work the record never closed runs to the end of what this node has recorded —
  // the same rule the graph timeline draws by, applied to the plot a reader opens
  // the node in. Left at its start it would be a point, and an in-flight dispatch
  // is not an instant: it is work still going on, and drawing it as a moment puts
  // the one thing happening now out of the reader's reach.
  const recorded = Math.max(
    ...items.map((item) => item.end ?? item.start),
    ...markers.map((marker) => marker.at),
  );
  const plotted = items.map((item) =>
    item.end === null
      ? { ...item, end: recorded, duration: recorded - item.start }
      : item,
  );
  return { items: plotted, markers, lanes: NODE_LANES, rows, tree: projected };
}

/** One thing the reading draws: a row, or the control standing for a collapsed run. */
export type TranscriptEntry =
  | { readonly entryKind: "row"; readonly row: TimelineRow }
  | {
      readonly entryKind: "collapse";
      /** The group the control speaks for; its `count` is the whole run. */
      readonly group: TimelineRow;
      /** How many rows the control is standing in for — the run less its ends. */
      readonly hidden: number;
      readonly expanded: boolean;
    };

/**
 * The reading, in the order it is read, with each collapsed run standing as its
 * first row, one control, and its last row.
 *
 * The first and the last are shown **in full** because they are what says where the
 * run began and where it ended — which is the reading a run of two hundred
 * near-identical rows otherwise buries. The control between them carries the count
 * and the kind as text, and expanding it puts the middle back exactly where it was.
 *
 * `expanded` is the reader's own state and is passed in rather than held here: the
 * projection is a pure function of what was served, and which runs a reader has
 * opened is not something the run recorded.
 */
export function transcriptEntries(
  rows: readonly TimelineRow[],
  expanded: ReadonlySet<string>,
): readonly TranscriptEntry[] {
  const seen = new Set<string>();
  const entries: TranscriptEntry[] = [];
  const visit = (nested: readonly TimelineRow[]) => {
    for (const row of nested) {
      if (row.rowKind === "group") {
        const open = expanded.has(row.id);
        const members = row.children;
        const first = members.at(0);
        const last = members.at(-1);
        if (first !== undefined) visit([first]);
        entries.push({
          entryKind: "collapse",
          group: row,
          hidden: Math.max(members.length - 2, 0),
          expanded: open,
        });
        if (open) visit(members.slice(1, -1));
        if (last !== undefined && last !== first) visit([last]);
        continue;
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        entries.push({ entryKind: "row", row });
      }
      visit(row.children);
    }
  };
  visit(rows);
  return entries;
}

/**
 * What one collapse control says: how many rows it stands for, and what they are.
 *
 * The same sentence whatever the run is made of — a run of journal records and a
 * run of dispatch spans read identically but for the kind each names — because the
 * reader meets one collapsing behaviour here rather than two.
 */
export function collapseLabel(hidden: number, kind: string): string {
  return `${hidden} more ${kind} events`;
}

function flattenRows(
  rows: readonly TimelineRow[],
  includeGroupChildren = true,
): TimelineRow[] {
  const seen = new Set<string>();
  const result: TimelineRow[] = [];
  const visit = (nested: readonly TimelineRow[]) => {
    for (const row of nested) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        result.push(row);
      }
      if (includeGroupChildren || row.rowKind !== "group") visit(row.children);
    }
  };
  visit(rows);
  return result;
}

/** The lane a row is plotted in, or `null` for a journal record and a container. */
function laneId(row: TimelineRow): LaneId | null {
  // A journal record is a moment, not an interval: it is a marker over every lane.
  if (row.rowKind === "event") return null;
  const role = roleLane(row.role);
  if (role !== null) return role;
  // Widened for the lookup, not narrowed for it: a group row carries the kind of the
  // spans it stands for as a plain string, and a kind the table has no entry for is
  // an answer here rather than an assertion that it must have one.
  const table: Readonly<Record<string, LaneId | null>> = LANE_BY_SPAN_KIND;
  return table[row.rowKind === "span" ? row.span.kind : row.kind] ?? null;
}

/** A dispatch's own lane, from the roles the server records on it. */
function roleLane(role: DispatchRole | undefined): LaneId | null {
  return role === undefined ? null : (LANE_BY_ROLE[role] ?? null);
}

export function nodeTimeline(
  timeline: RunTimeline | undefined,
  nodeId: string,
): NodeTimeline {
  if (timeline === undefined) return EMPTY;
  const scoped = timeline.spans.filter((span) => span.node_id === nodeId);
  if (scoped.length === 0) {
    const orphans = orphanEvents(timeline.spans, new Set(), nodeId);
    return orphans.length === 0
      ? EMPTY
      : { rows: group(orphans), total: orphans.length };
  }
  const ids = new Set(scoped.map(({ id }) => id));
  const children = new Map<string, TimelineSpan[]>();
  const roots: TimelineSpan[] = [];
  for (const span of scoped) {
    const parent =
      span.parent_id !== undefined && ids.has(span.parent_id)
        ? span.parent_id
        : undefined;
    if (parent === undefined) roots.push(span);
    else children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  // The node's own span is the view's subject, not a row inside it: its children and
  // its own events are what the rail lists, so every row is one recorded activity.
  const own = roots.find(({ kind }) => kind === "node");
  const top = [
    ...(own === undefined ? [] : spanRows(own, children)),
    ...roots
      .filter((span) => span !== own)
      .map((span) => spanRow(span, children)),
    ...orphanEvents(timeline.spans, ids, nodeId),
  ].sort(byStart);
  // Collapsed *after* the sessions of one dispatch have been gathered under the
  // agent session that opened them, and not before. A node that dispatched once
  // records its worker, the judge over it and its lint run as five consecutive
  // siblings, which is a run of one kind by every rule here — collapsing first hid
  // an ordinary single dispatch behind a control, and left `groupDispatches` a
  // group row it could nest nothing inside.
  const rows = group(groupDispatches(labelWorkerRetries(top)));
  return { span: own, rows, total: count(rows) };
}

/**
 * One span on its own as a row, for a reader that reached it outside a node.
 *
 * The graph-level view opens run-level sessions — the orchestrator's own, and the
 * the run's own check-ins — and they are read in the same panel a node's sessions are.
 * Projecting them through the same function is what keeps the two readings identical
 * rather than merely similar.
 */
export function spanAsRow(span: TimelineSpan): TimelineRow {
  return spanRow(span, new Map());
}

/**
 * One journal record on its own, for the surfaces that open a record rather than
 * the span holding it.
 *
 * The run-level lane is the one that needs it. A record the run made at **no
 * node** — `onevcs` observing a release long after the dispatch that produced the
 * work has settled, or a person acknowledging one — belongs to the run and to
 * nothing under it, so the only span it is ever inside is the run's own and the
 * only way to open it is as itself.
 */
export function eventAsRow(event: TimelineEvent): TimelineRow {
  return eventRow(event);
}

/** Depth-first lookup of one row by the id the query string carries. */
export function findRow(
  rows: readonly TimelineRow[],
  id: string,
): TimelineRow | undefined {
  return pathTo(rows, id).at(-1);
}

/** The rows enclosing `id`, outermost first and ending with the row itself. */
export function pathTo(
  rows: readonly TimelineRow[],
  id: string,
): readonly TimelineRow[] {
  for (const row of rows) {
    if (row.id === id) return [row];
    const nested = pathTo(row.children, id);
    if (nested.length > 0) return [row, ...nested];
  }
  return [];
}

function spanRows(
  span: TimelineSpan,
  children: Map<string, TimelineSpan[]>,
): TimelineRow[] {
  return [
    ...(children.get(span.id) ?? []).map((child) => spanRow(child, children)),
    ...span.events.map(eventRow),
  ].sort(byStart);
}

function spanRow(
  span: TimelineSpan,
  children: Map<string, TimelineSpan[]>,
): TimelineRow {
  const role = dispatchRole(span);
  return {
    rowKind: "span",
    span,
    id: span.id,
    kind: span.kind,
    role,
    label: span.label,
    startedAt: span.started_at,
    endedAt: span.ended_at,
    status: span.status,
    // A rollup stands in for thousands of records and carries their total itself;
    // its own start-to-end interval would describe the contention window instead.
    durationMs:
      span.total_duration_ms ?? elapsed(span.started_at, span.ended_at),
    children: group(spanRows(span, children)),
    displayLabel: spanLabel(span, role),
    displayKind: displayKind(span, role),
    ...(span.kind === "dispatch" && span.label
      ? { sessionName: span.label }
      : {}),
  };
}

/**
 * A dispatch's role as one word. Lint is the case that needs both halves: it is the
 * worker's own verification, told apart from the worker only by its transport role.
 */
function dispatchRole(span: TimelineSpan): DispatchRole | undefined {
  return span.kind === "dispatch" ? servedRole(span) : undefined;
}

/**
 * The dispatch role a span was *served* with, whatever kind of span it is.
 *
 * A `scope=run` rollup of dispatches carries the same pair the dispatches it stands
 * for carry, because that pair is the category it summarizes — so the graph-level
 * view reads a lane out of one exactly as the node view reads it out of the other.
 */
function servedRole(span: TimelineSpan): DispatchRole | undefined {
  if (span.agent_role === undefined) return undefined;
  return span.transport_role === LLMLINT_TRANSPORT
    ? LLMLINT_TRANSPORT
    : span.agent_role;
}

/**
 * The lane one served span is plotted in, from its roles and the kind vocabulary.
 *
 * A rollup is named for what it summarized rather than for being a rollup, so its
 * `label` is read as that kind — which is what keeps a summarized verification in the
 * verification lane instead of in the aggregate one every rollup would otherwise share.
 */
export function spanLane(span: TimelineSpan): LaneId | null {
  const role = servedRole(span);
  if (role !== undefined) return LANE_BY_ROLE[role] ?? null;
  // Widened for the lookup, not narrowed for it: a rollup's label is a plain string,
  // and a word the table has no entry for is an answer rather than an assertion.
  const table: Readonly<Record<string, LaneId | null>> = LANE_BY_SPAN_KIND;
  return table[span.kind === "rollup" ? span.label : span.kind] ?? null;
}

/** What one lane is called wherever an operator meets it. */
export function laneLabel(lane: LaneId): string {
  return LANE_LABELS[lane];
}

/**
 * What one redirection is called where it sits in the record it interrupted.
 *
 * A turn that ran for two hours and changed what it was doing halfway is unreadable
 * afterwards unless this moment is named: the transcript otherwise shows a worker
 * inexplicably switching tasks. So the row says which of the two things happened —
 * the running turn took the note, or it did not and the note is owed to the node's
 * next dispatch — rather than the served kind, which says only that a lever was
 * pulled.
 */
export function redirectionLabel(event: TimelineEvent): string | undefined {
  if (event.redirection === undefined) return undefined;
  return event.redirection.delivered
    ? "Redirected into the running turn"
    : "Redirection deferred to the next dispatch";
}

/** The category a redirection is read under, in the words the lane legend uses. */
export const REDIRECTION_KIND = "Redirection";

function eventRow(event: TimelineEvent): TimelineRow {
  const redirected = redirectionLabel(event);
  return {
    rowKind: "event",
    event,
    id: event.id,
    kind: event.kind,
    label: event.step_id ?? "",
    startedAt: event.at,
    endedAt: null,
    status: event.status,
    durationMs: null,
    children: [],
    displayLabel:
      redirected ??
      (event.kind === "retry-requested"
        ? "Retry requested"
        : (event.step_id ?? event.kind)),
    displayKind: redirected === undefined ? "Event" : REDIRECTION_KIND,
    category: eventCategory(event.kind),
  };
}

/**
 * Collapse each run of consecutive same-kind siblings into one row once it is long
 * enough to stop being scannable. Order is preserved: a group stands exactly where
 * the rows it holds stood.
 *
 * A run of journal records collapses on the same rule a run of spans does, because
 * a reader meets one collapsing behaviour in this timeline rather than two — see
 * {@link GROUP_THRESHOLD}. What the reader is then shown is
 * {@link transcriptEntries}: the first and the last in full, and the middle behind
 * one control that says how many there are and what they are.
 */
function group(rows: readonly TimelineRow[]): TimelineRow[] {
  const grouped: TimelineRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const first = rows[index];
    if (first === undefined) continue;
    let end = index;
    while (end + 1 < rows.length && sameKind(first, rows[end + 1])) end += 1;
    const run = rows.slice(index, end + 1);
    const last = run.at(-1);
    if (run.length < GROUP_THRESHOLD || last === undefined) {
      grouped.push(...run);
    } else {
      grouped.push({
        rowKind: "group",
        count: run.length,
        id: `group-${first.id}`,
        kind: first.kind,
        label: `${run.length} × ${first.kind}`,
        startedAt: first.startedAt,
        endedAt: last.endedAt,
        status: undefined,
        durationMs: elapsed(first.startedAt, last.endedAt),
        children: run,
        displayLabel: `${run.length} grouped ${first.displayKind.toLowerCase()} activities`,
        displayKind: first.displayKind,
      });
    }
    index = end;
  }
  return grouped;
}

/**
 * What one span is called in the lane legend and the transcript's eyebrow.
 *
 * Every answer is a category an operator reads about; the served identifiers
 * `rollup` and `pr-drafting` never reach the screen as themselves.
 */
function displayKind(
  span: TimelineSpan,
  role: DispatchRole | undefined,
): string {
  if (span.kind === "step") return "Lifecycle";
  if (span.kind === "rollup") return ROLLUP_LABELS[span.label] ?? span.label;
  const lane = roleLane(role) ?? LANE_BY_SPAN_KIND[span.kind];
  return lane === null || lane === undefined ? span.kind : LANE_LABELS[lane];
}

/**
 * What one thing holding a node reads as, in the words the engine recorded it with.
 *
 * Composed from the served entry rather than from a sentence the server wrote, so
 * the reader meets the same shrinking set the engine did — "behind migrate,
 * backfill" and then "behind backfill" — and so a hold with two entries reads as
 * two things rather than as one longer phrase. A `kind` this build has no wording
 * for is still named: the vocabulary is the engine's, and a reason it added is a
 * reason a reader has to be told about rather than one to draw as nothing.
 */
export function holdReasonLabel(reason: TimelineHoldReason): string {
  const named = (ids: readonly string[] | undefined) => (ids ?? []).join(", ");
  switch (reason.kind) {
    case "concurrency":
      return reason.ahead === undefined
        ? "behind the work already running"
        : `behind ${named(reason.ahead)}`;
    case "dependencies":
      return `waiting on ${named(reason.blocking)}`;
    case "decision":
      return `held by decision ${reason.reference ?? "nobody named"}`;
    case "release":
      return `awaiting the release of ${named(reason.awaiting)}`;
    default:
      return `held by ${reason.kind}`;
  }
}

/**
 * Everything holding a node at one recorded moment, as one phrase.
 *
 * Joined with "and" rather than listed, because that is what tells a node held by
 * two things from a node held by one at a glance — which is the reading the
 * `reasons` array exists to make possible.
 */
export function holdLabel(reasons: readonly TimelineHoldReason[]): string {
  return reasons.map(holdReasonLabel).join(" and ");
}

/**
 * How the operator names one recorded activity: its category, then the session or
 * artifact it was. A judge session says Judge and says which session it was, which is
 * the pair a reader needs to tell three concurrent sessions apart.
 */
function spanLabel(span: TimelineSpan, role: DispatchRole | undefined): string {
  if (span.kind === "step")
    return span.label ? `Lifecycle: ${span.label}` : "Lifecycle step";
  // A queue is named for what it was waiting for and never for the node it held:
  // "Queued" alone is the empty space this span replaced, said in a word.
  if (span.kind === "queued")
    return `Queued ${holdLabel(span.reasons ?? [])}`.trim();
  const kind = displayKind(span, role);
  if (span.kind === "rollup") return `${kind}: ${span.count ?? 0} recorded`;
  if (!span.label || span.label === kind) return kind;
  // A session is named for the session it is; everything else is named for the
  // artifact or branch it acted on, which reads as a subtitle rather than an alias.
  return span.kind === "dispatch"
    ? `${kind} (${span.label})`
    : `${kind}: ${span.label}`;
}

/** Label each worker attempt from retry-requested records without renaming sessions. */
function labelWorkerRetries(rows: readonly TimelineRow[]): TimelineRow[] {
  let retry = 0;
  return rows.map((row) => {
    if (row.rowKind === "event" && row.event.kind === "retry-requested")
      retry += 1;
    const children = labelWorkerRetries(row.children);
    if (row.role !== "worker" || retry === 0) return { ...row, children };
    return {
      ...row,
      children,
      displayLabel: `${row.displayLabel} · retry ${retry}`,
    };
  });
}

/**
 * Gather each onejudge dispatch's sessions under the agent session that opened it.
 *
 * One dispatch is an agent conversation plus the judge that supervised it and the
 * lint run it made of its own work — three oneharness sessions an operator has to be
 * able to read as one unit, and which three sibling rows of equal weight hid.
 *
 * The identity comes from what the server records about each session. A lint session
 * is already served nested inside the dispatch it ran under, so it arrives as a child.
 * A judge session is served as a sibling, and the dispatch it belongs to is the agent
 * session it is supervising — the most recent one opened in the same scope, which is
 * exactly the pairing onejudge produces. Schema 10 serves that identity outright as
 * `dispatch_id`; this recovers the same grouping from what schema 9 records.
 */
function groupDispatches(rows: readonly TimelineRow[]): TimelineRow[] {
  const grouped: TimelineRow[] = [];
  let agentIndex = -1;
  let ordinal = 0;
  const joined = (row: TimelineRow, dispatch: DispatchGroup): TimelineRow => ({
    ...row,
    dispatch,
    children: row.children.map((child) => joined(child, dispatch)),
  });
  for (const row of rows) {
    if (opensDispatch(row.role)) {
      ordinal += 1;
      agentIndex = grouped.length;
      grouped.push(joined(row, { id: row.id, label: `Dispatch ${ordinal}` }));
      continue;
    }
    const agent = agentIndex < 0 ? undefined : grouped[agentIndex];
    if (supervises(row.role) && agent?.dispatch !== undefined) {
      grouped[agentIndex] = {
        ...agent,
        children: [...agent.children, joined(row, agent.dispatch)],
      };
      continue;
    }
    grouped.push(row);
  }
  return grouped;
}

/** The roles onejudge dispatches in their own right, each opening a group. */
function opensDispatch(role: DispatchRole | undefined): boolean {
  return role !== undefined && OPENS_DISPATCH[role] === true;
}

/** The roles that run over an agent's work rather than being dispatched alone. */
function supervises(role: DispatchRole | undefined): boolean {
  return role !== undefined && OPENS_DISPATCH[role] === false;
}

/**
 * Whether two consecutive rows belong to the same run.
 *
 * The **kind** is the whole of it, and both halves of the pair have to be the same
 * sort of row: two `dispatch` spans are a run, two `turn-activity` records are a
 * run, and a span beside a record is not. A group is never a member of another
 * one — the collapse has already happened there.
 */
function sameKind(first: TimelineRow, next: TimelineRow | undefined): boolean {
  return (
    next !== undefined &&
    first.rowKind !== "group" &&
    next.rowKind === first.rowKind &&
    first.kind === next.kind
  );
}

/**
 * Events this node recorded that landed on a span belonging to another scope — a
 * record made before the node's own span opened hangs off the run instead, and
 * would otherwise be invisible from the node it names.
 */
function orphanEvents(
  spans: readonly TimelineSpan[],
  scoped: ReadonlySet<string>,
  nodeId: string,
): TimelineRow[] {
  return spans
    .filter(({ id }) => !scoped.has(id))
    .flatMap(({ events }) => events.filter((event) => event.node_id === nodeId))
    .map(eventRow);
}

function count(rows: readonly TimelineRow[]): number {
  return rows.reduce(
    (total, row) =>
      total + (row.rowKind === "group" ? 0 : 1) + count(row.children),
    0,
  );
}

/**
 * Recorded order: by the instant, and by the order the server served them where
 * two records share one.
 *
 * The sort is stable, so equal instants keep the order they arrived in — which is
 * the order the run recorded them. Breaking that tie on the id instead sorted the
 * sessions of one dispatch alphabetically by session name, so which of them read
 * as the dispatch that opened the group depended on what its session happened to
 * be called.
 */
function byStart(first: TimelineRow, next: TimelineRow): number {
  return first.startedAt.localeCompare(next.startedAt);
}

function elapsed(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}
