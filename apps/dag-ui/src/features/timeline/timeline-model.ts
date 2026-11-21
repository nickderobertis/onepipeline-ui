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
  TransportRole,
} from "@onepipeline-ui/dag-model";
import { type EventType, eventType } from "@onepipeline-ui/timeline-categories";
import { createElement } from "react";
import { argvOf, commandLine } from "../../lib/command-line";
import { type EventCategory, eventCategory } from "./event-category";
import { MarkerReading } from "./item-reading";

/**
 * One node's slice of the served run timeline, as rows a rail can render.
 *
 * The served payload is a flat span list carrying the tree in `parent_id`; this
 * rebuilds that tree for one node and merges each span's child spans with its own
 * events into one recorded order. What the event list then reads is
 * {@link eventList}: one row per surface, the types the reader chose, and every
 * back-to-back repeat collapsed into one block.
 */

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
   * What a dispatch was for: the member name the run recorded for the session,
   * under the run's own word. Served on the span itself, so a row says which
   * session it is without the transcript behind it being fetched. Absent on every
   * other kind of row, and on a dispatch the run recorded no declared member for.
   */
  readonly role?: AgentRole;
  /**
   * The party the session ran as — its agent side, its judge or its lint run —
   * which is what tells the sessions of one dispatch apart and which of them
   * opened it. Carried by a dispatch row and by nothing else.
   */
  readonly transport?: TransportRole;
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
  /** The one type the event-type filter reads this row under. */
  readonly type: EventType;
  /** When the row's `status` came about, where that is not when the row began. */
  readonly statusAt?: string;
  /**
   * The ids of the other records this one row stands for — the records of a
   * surface joined into its row — so an address naming any of them opens it.
   */
  readonly aliases?: readonly string[];
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
  | (RowBase & {
      /**
       * A loop the record went round back to back: `pass` is one time round it,
       * `count` how many times it went round, and `children` every row it stands
       * for, in order.
       */
      readonly rowKind: "group";
      readonly count: number;
      readonly pass: readonly TimelineRow[];
    });

export interface NodeTimeline {
  /** The node's own span, when the recorded stream opened one. */
  readonly span?: TimelineSpan;
  readonly rows: readonly TimelineRow[];
  /** Every span and event this node recorded, however deeply nested. */
  readonly total: number;
}

const EMPTY: NodeTimeline = { rows: [], total: 0 };

/**
 * The lanes every run is read in whatever its graphs declared, one per kind of
 * recorded work that is not a member's session.
 *
 * Every one of them is a span kind the server serves, so a reader is never shown a
 * category the journal has no record of. The member lanes are **not** here: a
 * session's lane is the member name the run's own graph declared, served as
 * `agent_role`, and {@link laneVocabulary} draws one per distinct word a payload
 * carries — in the order the payload serves them — because a table of them kept
 * here would be a second host's vocabulary closed over the first's.
 */
const STRUCTURAL_LANE_LABELS = {
  // First, because it is what happened before anything else on the node, and
  // because `compactTimelineItems` reads lane order as priority: where a queued
  // span shares a moment with anything, why nothing was running is the answer the
  // reader opened the node for.
  queued: "Queued",
  // A session the run recorded no declared member for, read by the one thing
  // still known about it: that it was a dispatch.
  dispatch: "Dispatch",
  verification: "Verification",
  publication: "Publication",
  "lock-waits": "Lock waits",
  "human-wait": "Human wait",
} as const;

/** The lane the graph timeline plots a row's own unrecorded stretches in. */
export const IDLE_LANE_ID = "idle";

/**
 * A lane's id, which the plot reads back to the operator — in a segment's hover
 * reading, as `Lane: …` — and hashes into the lane's colour.
 *
 * A member's lane is the served word itself, so what the reading says is the word
 * the run recorded and the colour follows the word across runs. The one exception
 * is a member a host happened to name after a structural lane, or after the graph's
 * own silence: that word is prefixed, because the alternative is plotting the member
 * in a lane that means something else and never saying so.
 */
export type LaneId = string;

const RESERVED_LANE_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(STRUCTURAL_LANE_LABELS),
  IDLE_LANE_ID,
]);

const MEMBER_LANE_PREFIX = "member:";

/** The lane a member's sessions are plotted in. */
export function roleLaneId(role: AgentRole): LaneId {
  return RESERVED_LANE_IDS.has(role) ? `${MEMBER_LANE_PREFIX}${role}` : role;
}

/** The lanes in which the structural kinds are read, in their canonical order. */
const STRUCTURAL_LANES: readonly TimelineLane[] = Object.entries(
  STRUCTURAL_LANE_LABELS,
).map(([id, label]) => ({ id, label }));

/**
 * Every lane one served timeline is read in: the member lanes the payload names,
 * between the queue and the structural kinds.
 *
 * The member lanes are **derived from the payload and drawn in its order**. One
 * lane per distinct `agent_role` the served spans carry, first seen first —
 * neither sorted nor keyed by any table here, because the words are the run's own
 * graph declarations and this app knows none of them: a run whose observer graph
 * declared `ticker` and `sentinel` reads in those two lanes, in that order, and a
 * run of this host's shape reads in `worker`, `llmlint`, `monitor`, `check-in`
 * and `pr-author` as the run recorded them — and in no `judge` lane, because a
 * judge is served under the word of the member it supervised and lands in that
 * member's lane. Queued comes first for the reason {@link STRUCTURAL_LANE_LABELS}
 * gives; the rest of the structural lanes follow the members, so a member's work
 * reads above the publication of it.
 */
export function laneVocabulary(
  timeline: RunTimeline | undefined,
): readonly TimelineLane[] {
  const spans = timeline?.spans ?? [];
  const roles: AgentRole[] = [];
  for (const span of spans) {
    const role = span.agent_role ?? span.harness_scope;
    if (role !== undefined && !roles.includes(role)) roles.push(role);
  }
  // The unroled lane exists only where the payload has a session for it: every
  // session of a run whose graphs declared their members has a lane of its own,
  // and an always-empty row would push the reading below the fold for nothing.
  const unroled = spans.some((span) => spanLane(span) === "dispatch");
  const [queued, ...rest] = STRUCTURAL_LANES;
  return [
    ...(queued === undefined ? [] : [queued]),
    ...roles.map((role) => ({ id: roleLaneId(role), label: role })),
    ...rest.filter(({ id }) => unroled || id !== "dispatch"),
  ];
}

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
  // Refined by the dispatch's own served role; this is what an unroled one is.
  dispatch: "dispatch",
  verification: "verification",
  publication: "publication",
  // Drafting is a member's work under this host's graphs, and that member's own
  // lane is where the session sits; the step that brackets it is read here.
  "pr-drafting": "dispatch",
  // Resolving a conflict is work on the merge, so it reads beside the publication
  // it is unblocking rather than as a category an operator has to learn.
  "conflict-resolution": "publication",
  "human-wait": "human-wait",
  // Why the loop was not running the node: real recorded time, in a lane of its
  // own rather than as the empty space it used to be drawn as.
  queued: "queued",
  rollup: "lock-waits",
};

/** The party `oneagentgraph` runs a lint member as. */
export const LLMLINT_TRANSPORT = "llmlint";

/**
 * Which sessions open a dispatch of their own, and which run over another's work.
 *
 * Read off the closed transport vocabulary rather than off the member word: an
 * agent-side session is the work, and the judge and the lint run that supervised
 * it are gathered under it — whatever the host called any of the three.
 */
function opensDispatch(transport: TransportRole | undefined): boolean {
  return transport === "agent";
}

/**
 * What one dispatch role is called wherever the operator meets it: the lane
 * legend, the transcript's eyebrow, and the header of the conversation it opens.
 *
 * The word is the run's own — the member name its graph declared, exactly as
 * served — and a session the run recorded no declared member for is named by the
 * party it ran as. A session that ran *over* a member's work under that member's
 * word — its judge, or the lint tier reading it — is the same member on the wire,
 * told from the agent side by its transport and by nothing else, so the transport
 * is read beside the word: `worker · judge` is the worker's judge, in the
 * worker's lane. One function rather than a table beside the conversation panel,
 * so the plot and the transcript it is read against call the same session the
 * same thing.
 */
export function dispatchRoleLabel(
  role: AgentRole | undefined,
  transport: TransportRole | undefined,
): string {
  if (role === undefined)
    return transport === undefined
      ? STRUCTURAL_LANE_LABELS.dispatch
      : transportLabel(transport);
  return supervises(transport) && transport !== role
    ? `${role} · ${transport}`
    : role;
}

/** The party word as an operator reads it, for a session with no member word. */
function transportLabel(transport: TransportRole): string {
  return transport === LLMLINT_TRANSPORT
    ? "Lint"
    : `${transport[0]?.toUpperCase() ?? ""}${transport.slice(1)}`;
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
  lanes: readonly TimelineLane[] = STRUCTURAL_LANES,
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
    } else if (
      compactPriority(item, lanes) < compactPriority(collision, lanes)
    ) {
      if (boundaries.has(collision.id)) result.push(item);
      else result[result.indexOf(collision)] = item;
    } else if (!coincident(item, collision, pointCluster)) {
      result.push(item);
    }
  }
  // Boundary spans must survive compaction to keep one clock, but a later,
  // lower-priority boundary must not cover the worker's clickable bar. Paint
  // the dominant lane last, with its enclosing session above nested judge
  // sessions in that same role lane. The expanded lanes retain every session.
  return result.sort(
    (left, right) =>
      compactPriority(right, lanes) - compactPriority(left, lanes) ||
      (left.end ?? left.start) -
        left.start -
        ((right.end ?? right.start) - right.start),
  );
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

/**
 * Which item wins a moment two share: the one in the earlier lane, in the order the
 * lanes are drawn — the queue first, then the run's members as served, then the
 * structural kinds — so what dominates a collapsed moment is what the expanded
 * plot shows at the top of it.
 */
function compactPriority(
  item: TimelineItem<unknown>,
  lanes: readonly TimelineLane[],
): number {
  const lane = item.laneId ?? "";
  const order = lanes.findIndex(({ id }) => id === lane);
  return order < 0 ? lanes.length : order;
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
  const plottedRows = flattenRows(plotRuns(projected), false);
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
  return {
    items: plotted,
    markers,
    lanes: laneVocabulary(timeline),
    rows,
    tree: projected,
  };
}

/**
 * Consecutive siblings of one kind plot as one segment once a run reaches this
 * many: the plot's own reading of a node that dispatched two hundred sessions,
 * one bar rather than two hundred. The event list collapses loops on its own rule
 * ({@link collapseCycles}); this is what the plot draws.
 */
export const PLOT_GROUP_THRESHOLD = 4;

/** The rows as the plot draws them: each long run of one kind as one segment. */
function plotRuns(rows: readonly TimelineRow[]): TimelineRow[] {
  const grouped: TimelineRow[] = [];
  const siblings = rows.map((row) =>
    row.children.length === 0
      ? row
      : { ...row, children: plotRuns(row.children) },
  );
  for (let index = 0; index < siblings.length; index += 1) {
    const first = siblings[index];
    if (first === undefined) continue;
    let end = index;
    while (end + 1 < siblings.length && sameKind(first, siblings[end + 1]))
      end += 1;
    const run = siblings.slice(index, end + 1);
    const last = run.at(-1);
    if (run.length < PLOT_GROUP_THRESHOLD || last === undefined) {
      grouped.push(...run);
    } else {
      grouped.push({
        rowKind: "group",
        count: run.length,
        pass: run,
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
        type: first.type,
        ...(first.role === undefined ? {} : { role: first.role }),
        ...(first.transport === undefined
          ? {}
          : { transport: first.transport }),
      });
    }
    index = end;
  }
  return grouped;
}

/** Whether two consecutive rows are of one kind, for {@link plotRuns}. */
function sameKind(first: TimelineRow, next: TimelineRow | undefined): boolean {
  return (
    next !== undefined &&
    first.rowKind !== "group" &&
    next.rowKind === first.rowKind &&
    first.kind === next.kind &&
    first.role === next.role &&
    first.transport === next.transport
  );
}

/** One thing the reading draws: a row, or a block standing for a repeated loop. */
export type TranscriptEntry =
  | { readonly entryKind: "row"; readonly row: TimelineRow }
  | {
      readonly entryKind: "cycle";
      /** The loop the block speaks for; its `count` is how many times it repeated. */
      readonly group: Extract<TimelineRow, { rowKind: "group" }>;
      /** What the block holds now: one pass, or every row it stands for. */
      readonly entries: readonly TranscriptEntry[];
      readonly expanded: boolean;
    };

/**
 * The reading, in the order it is read, with each repeated loop standing as one
 * block that holds one pass through it — or, opened, every row it stands for.
 *
 * `expanded` is the reader's own state and is passed in rather than held here: the
 * projection is a pure function of what was served, and which blocks a reader has
 * opened is not something the run recorded.
 */
export function transcriptEntries(
  rows: readonly TimelineRow[],
  expanded: ReadonlySet<string>,
): readonly TranscriptEntry[] {
  const seen = new Set<string>();
  const visit = (nested: readonly TimelineRow[]): TranscriptEntry[] => {
    const entries: TranscriptEntry[] = [];
    for (const row of nested) {
      if (row.rowKind === "group") {
        const open = expanded.has(row.id);
        entries.push({
          entryKind: "cycle",
          group: row,
          entries: visit(open ? row.children : row.pass),
          expanded: open,
        });
        continue;
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        entries.push({ entryKind: "row", row });
      }
      entries.push(...visit(row.children));
    }
    return entries;
  };
  return visit(rows);
}

/** Every row a reading draws, blocks opened into what they hold, in order. */
export function readingRows(
  reading: readonly TranscriptEntry[],
): readonly TimelineRow[] {
  return reading.flatMap((entry) =>
    entry.entryKind === "row" ? [entry.row] : readingRows(entry.entries),
  );
}

/**
 * What one block says: how many rows one pass is and how many times it went round.
 *
 * The same sentence whatever the loop is made of, so a reader meets one collapsing
 * behaviour rather than one per kind of row.
 */
export function cycleLabel(group: Extract<TimelineRow, { rowKind: "group" }>) {
  const rows = group.pass.length;
  return `${rows === 1 ? "1 event" : `${rows} events`} repeated ${group.count} times`;
}

/**
 * The event list a reader reads: one row per surface, only the types they chose,
 * and each back-to-back repeat collapsed into one block.
 *
 * In that order on purpose. A surface's records are joined before anything is
 * hidden, so a surface reads as one row whichever of its records the window holds;
 * and repeats are found after the filter, so hiding the record that broke a loop
 * up shows the loop for what it is.
 */
export function eventList(
  rows: readonly TimelineRow[],
  hidden: ReadonlySet<EventType> = new Set(),
): readonly TimelineRow[] {
  return collapseCycles(onlyTypes(joinRows(rows), hidden));
}

/** How many rows a list holds, however deeply nested. */
export function rowCount(rows: readonly TimelineRow[]): number {
  return count(rows);
}

/**
 * Every type the rows are read under, whatever the filter hides, with how many
 * rows are of each.
 */
export function typeCounts(
  rows: readonly TimelineRow[],
): ReadonlyMap<EventType, number> {
  const counts = new Map<EventType, number>();
  for (const row of flattenRows(joinRows(rows)))
    counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return counts;
}

/**
 * The rows of the types the reader kept. A row of a hidden type goes, and the rows
 * it held of a kept type stand where it stood, so hiding a type hides exactly the
 * rows of that type.
 */
function onlyTypes(
  rows: readonly TimelineRow[],
  hidden: ReadonlySet<EventType>,
): TimelineRow[] {
  if (hidden.size === 0) return [...rows];
  return rows.flatMap((row) => {
    const children = onlyTypes(row.children, hidden);
    return hidden.has(row.type) ? children : [{ ...row, children }];
  });
}

/** The channel id of the surface a record belongs to, where it belongs to one. */
export function surfaceIdOf(event: TimelineEvent): number | undefined {
  return event.surface_state?.id ?? event.surface_id;
}

/**
 * One row per surface: the first record of each surface the list holds stands for
 * every record of it, read under the state the server folded for the surface, and
 * the others are dropped from the list.
 *
 * A surface is written as several records — queued, read, the record its raiser
 * wrote beside it, and the reply naming its correlation — and listing each was the
 * same text twice or more, one of them saying nothing the other had not.
 */
function joinSurfaces(rows: readonly TimelineRow[]): TimelineRow[] {
  const joined = new Map<number, string[]>();
  const first = new Set<string>();
  for (const row of flattenRows(rows)) {
    if (row.rowKind !== "event") continue;
    const id = surfaceIdOf(row.event);
    if (id === undefined) continue;
    const members = joined.get(id);
    if (members === undefined) {
      joined.set(id, [row.id]);
      first.add(row.id);
    } else members.push(row.id);
  }
  if (joined.size === 0) return [...rows];
  const visit = (nested: readonly TimelineRow[]): TimelineRow[] =>
    nested.flatMap((row) => {
      const children = visit(row.children);
      if (row.rowKind !== "event") return [{ ...row, children }];
      const id = surfaceIdOf(row.event);
      if (id === undefined) return [{ ...row, children }];
      if (!first.has(row.id)) return children;
      return [
        {
          ...surfaceRow(row),
          children,
          aliases: (joined.get(id) ?? []).filter((other) => other !== row.id),
        },
      ];
    });
  return visit(rows);
}

/** One row per surface, and one per refused edit with the surface it raised. */
function joinRows(rows: readonly TimelineRow[]): TimelineRow[] {
  // Read before the surfaces are joined: joining keeps one record of each, which
  // need not be the one naming the refusal.
  return joinRefusals(joinSurfaces(rows), surfacesRaisedFor(rows));
}

/**
 * The refused edit a record of the reconciler's `edit-rejected` surface was raised
 * for, as the record itself names it — `rejection`, the refusal's stream and seq —
 * in the `record_id` the refusal's own row carries. Nothing for any other record:
 * a surface naming no rejection is a surface like any other.
 */
export function rejectionOf(event: TimelineEvent): string | undefined {
  const rejection = event.fields?.rejection;
  if (
    typeof rejection !== "object" ||
    rejection === null ||
    Array.isArray(rejection)
  )
    return undefined;
  const { stream, seq } = rejection;
  return typeof stream === "string" &&
    typeof seq === "number" &&
    Number.isInteger(seq)
    ? `${stream}.${seq}`
    : undefined;
}

/**
 * Every surface a record of the list names as raised for a refused edit the list
 * also holds, by surface id, to that refusal's row id.
 */
function surfacesRaisedFor(
  rows: readonly TimelineRow[],
): ReadonlyMap<number, string> {
  const flat = flattenRows(rows);
  const refusals = new Set(
    flat.flatMap((row) =>
      row.rowKind === "event" && row.event.kind === "edit-rejected"
        ? [row.id]
        : [],
    ),
  );
  const raised = new Map<number, string>();
  if (refusals.size === 0) return raised;
  for (const row of flat) {
    if (row.rowKind !== "event") continue;
    const refusal = rejectionOf(row.event);
    const surface = surfaceIdOf(row.event);
    if (refusal !== undefined && surface !== undefined && refusals.has(refusal))
      raised.set(surface, refusal);
  }
  return raised;
}

/**
 * One row per refused edit. The surface the reconciler raises for a refusal says the
 * same thing as the refusal's own row, so where the list holds both the surface is
 * not listed: its records answer to the refusal's row, which shows that it was read
 * where it was. A surface whose refusal the list does not hold stays a row.
 */
function joinRefusals(
  rows: readonly TimelineRow[],
  raisedFor: ReadonlyMap<number, string>,
): TimelineRow[] {
  if (raisedFor.size === 0) return [...rows];
  const flat = flattenRows(rows);
  const surfaceRows = new Map<
    string,
    Extract<TimelineRow, { rowKind: "event" }>
  >();
  for (const row of flat) {
    if (row.rowKind !== "event") continue;
    const surface = surfaceIdOf(row.event);
    const refusal = surface === undefined ? undefined : raisedFor.get(surface);
    if (refusal !== undefined) surfaceRows.set(refusal, row);
  }
  const visit = (nested: readonly TimelineRow[]): TimelineRow[] =>
    nested.flatMap((row) => {
      const children = visit(row.children);
      if (row.rowKind !== "event") return [{ ...row, children }];
      const surface = surfaceIdOf(row.event);
      if (surface !== undefined && raisedFor.has(surface)) return children;
      const raised = surfaceRows.get(row.id);
      if (raised === undefined) return [{ ...row, children }];
      const read = raised.event.surface_state?.read_at;
      const applied = row.status ?? "not applied";
      return [
        {
          ...row,
          children,
          aliases: [
            ...(row.aliases ?? []),
            raised.id,
            ...(raised.aliases ?? []),
          ],
          ...(read === undefined
            ? { status: `${applied} · unread` }
            : { status: `${applied} · read`, statusAt: read }),
        },
      ];
    });
  return visit(rows);
}

/** Where one surface stands, in a word, and since when. */
export function surfaceStatus(
  state: NonNullable<TimelineEvent["surface_state"]>,
): { readonly status: string; readonly at?: string } {
  if (state.replied_at !== undefined || state.reply !== undefined)
    return {
      status: "answered",
      ...(state.replied_at === undefined ? {} : { at: state.replied_at }),
    };
  if (state.read_at !== undefined) return { status: "read", at: state.read_at };
  if (state.blocking === true)
    return {
      status: "waiting",
      ...(state.queued_at === undefined ? {} : { at: state.queued_at }),
    };
  return {
    status: "queued",
    ...(state.queued_at === undefined ? {} : { at: state.queued_at }),
  };
}

/** A surface's first record, read as the whole surface. */
function surfaceRow(row: Extract<TimelineRow, { rowKind: "event" }>) {
  const state = row.event.surface_state;
  if (state === undefined) return row;
  const named = [state.kind, state.message].filter(
    (part) => part !== undefined,
  );
  const { status, at } = surfaceStatus(state);
  return {
    ...row,
    displayLabel: named.length === 0 ? row.displayLabel : named.join(": "),
    displayKind: state.blocking === true ? BLOCKING_SURFACE_KIND : SURFACE_KIND,
    status,
    ...(at === undefined ? {} : { statusAt: at }),
    type: "surface" as const,
  };
}

/**
 * Collapse every back-to-back repeat of one or more sibling rows into one block,
 * longest saving first, in every list of siblings however deeply it is nested.
 *
 * Two rows are the same when they are of the same kind and drawn with the same
 * label — what a reader would call the same thing happening again — whatever
 * dispatch each belongs to, and however long the loop they make. At each place
 * the list is read from, the loop that saves the most rows wins, so `queued →
 * held → unheld` forty times is one block of three rows rather than three
 * blocks of one.
 */
export function collapseCycles(rows: readonly TimelineRow[]): TimelineRow[] {
  const siblings = rows.map((row) =>
    row.children.length === 0
      ? row
      : { ...row, children: collapseCycles(row.children) },
  );
  const keys = sameKeys(siblings);
  const recurs = nextOccurrences(keys);
  const collapsed: TimelineRow[] = [];
  let at = 0;
  while (at < siblings.length) {
    const best = longestSaving(keys, recurs, at);
    if (best === undefined) {
      const row = siblings[at];
      if (row !== undefined) collapsed.push(row);
      at += 1;
      continue;
    }
    const members = siblings.slice(at, at + best.length * best.count);
    collapsed.push(cycleRow(members, best.length, best.count));
    at += best.length * best.count;
  }
  return collapsed;
}

/**
 * The repeat starting at `at` that saves the most rows, if any repeats there.
 *
 * Loops shorter than {@link LOOP_WINDOW} rows are tried directly. A longer loop
 * starts again only where its first {@link LOOP_WINDOW} rows recur, so only
 * those offsets are tried, nearest first. Two bounds keep a long list cheap without limiting how long a loop may
 * be: no loop saves more rows than lie beyond its first pass, so the search ends
 * once the best found saves that many; and a loop whose pass is a multiple of a
 * period already found, and which starts within that period's repeating stretch,
 * repeats no further than that stretch does and so saves fewer rows than the
 * period itself.
 */
function longestSaving(
  keys: readonly number[],
  recurs: readonly number[],
  at: number,
): { readonly length: number; readonly count: number } | undefined {
  let best: { length: number; count: number } | undefined;
  let saved = 0;
  const periods: { readonly length: number; readonly reach: number }[] = [];
  const room = Math.floor((keys.length - at) / 2);
  const tryLength = (length: number) => {
    if (
      periods.some(
        (period) => length % period.length === 0 && length <= period.reach,
      )
    )
      return;
    const matched = commonRun(keys, at, at + length);
    const count = Math.floor(matched / length) + 1;
    if (count < 2) return;
    periods.push({ length, reach: length + matched });
    if ((count - 1) * length > saved) {
      best = { length, count };
      saved = (count - 1) * length;
    }
  };
  for (let length = 1; length < LOOP_WINDOW && length <= room; length += 1)
    if (keys[at + length] === keys[at]) tryLength(length);
  for (
    let next = recurs[at] ?? -1;
    next !== -1 && next - at <= room;
    next = recurs[next] ?? -1
  ) {
    if (saved >= keys.length - next) break;
    if (next - at >= LOOP_WINDOW) tryLength(next - at);
  }
  return best;
}

/** How many rows from `at` and from `other` on read the same, pairwise. */
function commonRun(keys: readonly number[], at: number, other: number): number {
  let matched = 0;
  while (
    other + matched < keys.length &&
    keys[at + matched] === keys[other + matched]
  )
    matched += 1;
  return matched;
}

/** Each sibling's sameness as a small number: equal rows share one. */
function sameKeys(rows: readonly TimelineRow[]): number[] {
  const ids = new Map<string, number>();
  return rows.map((row) => {
    const key = sameness(row);
    const known = ids.get(key);
    if (known !== undefined) return known;
    ids.set(key, ids.size);
    return ids.size - 1;
  });
}

/**
 * How many leading rows a loop's offset is looked up by. Wide enough that rows
 * of a handful of kinds which never loop rarely look as if they might, which is
 * what keeps a long list of them from being compared against itself.
 */
const LOOP_WINDOW = 16;

/**
 * Where the {@link LOOP_WINDOW} rows starting at each row next recur, as far as a
 * hash of them can tell, or `-1` where they never do. A shared hash is only a
 * place worth comparing: every offset tried is compared row by row.
 */
function nextOccurrences(keys: readonly number[]): number[] {
  const next = keys.map(() => -1);
  const seen = new Map<number, number>();
  for (let index = keys.length - LOOP_WINDOW; index >= 0; index -= 1) {
    let hash = 0;
    for (let offset = 0; offset < LOOP_WINDOW; offset += 1)
      hash = (Math.imul(hash, 0x01000193) ^ (keys[index + offset] ?? 0)) | 0;
    next[index] = seen.get(hash) ?? -1;
    seen.set(hash, index);
  }
  return next;
}

/** What makes two sibling rows the same thing happening again. */
function sameness(row: TimelineRow): string {
  return JSON.stringify([row.rowKind, row.kind, row.displayLabel]);
}

/** The block standing for `members`, a loop of `length` rows gone round `count` times. */
function cycleRow(
  members: readonly TimelineRow[],
  length: number,
  count: number,
): TimelineRow {
  const first = members[0];
  if (first === undefined) throw new Error("a repeat of no rows");
  const pass = members.slice(0, length);
  const endedAt = members.reduce<string>((latest, row) => {
    const end = row.endedAt ?? row.startedAt;
    return Date.parse(end) > Date.parse(latest) ? end : latest;
  }, first.startedAt);
  // A block standing for rows of several dispatches belongs to none of them.
  const dispatch = members.every(
    (row) => row.dispatch?.id === first.dispatch?.id,
  )
    ? first.dispatch
    : undefined;
  return {
    rowKind: "group",
    count,
    pass,
    id: `cycle-${first.id}`,
    kind: first.kind,
    label: `${count} × ${pass.map((row) => row.kind).join(" → ")}`,
    startedAt: first.startedAt,
    endedAt,
    status: undefined,
    durationMs: elapsed(first.startedAt, endedAt),
    children: [...members],
    displayLabel: pass.map((row) => row.displayLabel).join(" → "),
    displayKind: first.displayKind,
    type: first.type,
    ...(dispatch === undefined ? {} : { dispatch }),
  };
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
  if (row.role !== undefined) return roleLaneId(row.role);
  // Widened for the lookup, not narrowed for it: a group row carries the kind of the
  // spans it stands for as a plain string, and a kind the table has no entry for is
  // an answer here rather than an assertion that it must have one.
  const table: Readonly<Record<string, LaneId | null>> = LANE_BY_SPAN_KIND;
  return table[row.rowKind === "span" ? row.span.kind : row.kind] ?? null;
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
      : { rows: orphans, total: orphans.length };
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
  const servedGroups = scoped.some(
    (span) =>
      span.dispatch_group !== undefined ||
      span.events.some((event) => event.dispatch_group !== undefined),
  );
  const rows = servedGroups
    ? servedDispatchGroups(top)
    : groupDispatches(labelWorkerRetries(top));
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

/**
 * The records the run made at no node, as the run's own event list reads them, in
 * the order they were recorded.
 *
 * Every record naming a node is read on that node's list and nowhere else — but a
 * refused edit, which is read on both — and so is a record of a surface raised about
 * a node — the reply answering a node's
 * question is journalled at no node, and it is that question's row which says it
 * was answered.
 */
export function runEventRows(
  timeline: RunTimeline | undefined,
): readonly TimelineRow[] {
  const seen = new Set<string>();
  return (timeline?.spans ?? [])
    .filter((span) => span.node_id === undefined)
    .flatMap((span) => span.events)
    .filter((event) => {
      // A refused edit is the run's as well as its node's, so the run's span lists
      // it whatever node it names, and so does this list.
      if (event.node_id !== undefined && event.kind !== "edit-rejected")
        return false;
      if (event.surface_state?.node !== undefined) return false;
      const id = event.record_id ?? event.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(eventRow)
    .sort(byStart);
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
  const search = (
    held: readonly TimelineRow[],
    legacy: boolean,
  ): readonly TimelineRow[] => {
    for (const row of held) {
      if (
        legacy
          ? row.rowKind === "event" && row.event.id === id
          : row.id === id || row.aliases?.includes(id) === true
      )
        return [row];
      const nested = search(row.children, legacy);
      if (nested.length > 0) return [row, ...nested];
    }
    return [];
  };
  const exact = search(rows, false);
  return exact.length > 0 ? exact : search(rows, true);
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
  const transport = span.kind === "dispatch" ? span.transport_role : undefined;
  return {
    rowKind: "span",
    span,
    id: span.id,
    kind: span.kind,
    ...(role === undefined ? {} : { role }),
    ...(transport === undefined ? {} : { transport }),
    label: span.label,
    startedAt: span.started_at,
    endedAt: span.ended_at,
    status: span.status,
    // A rollup stands in for thousands of records and carries their total itself;
    // its own start-to-end interval would describe the contention window instead.
    durationMs:
      span.total_duration_ms ?? elapsed(span.started_at, span.ended_at),
    children: spanRows(span, children),
    type: eventType({ kind: span.kind, span: true }),
    displayLabel: spanLabel(span, role, transport),
    displayKind: displayKind(span, role, transport),
    ...(span.kind === "dispatch" && span.label
      ? { sessionName: span.label }
      : {}),
  };
}

/** A dispatch's served member word, and nothing for any other kind of span. */
function dispatchRole(span: TimelineSpan): AgentRole | undefined {
  return span.kind === "dispatch"
    ? (span.agent_role ?? span.harness_scope)
    : undefined;
}

/**
 * The lane one served span is plotted in, from its role and the kind vocabulary.
 *
 * A span served with an `agent_role` — a dispatch, or a `scope=run` rollup of
 * dispatches, which carries the pair the dispatches it stands for carry — is
 * plotted in that member's lane, whatever kind of span it is, so the graph-level
 * view reads a lane out of one exactly as the node view reads it out of the other.
 * A rollup of anything else is named for what it summarized rather than for being
 * a rollup, so its `label` is read as that kind — which is what keeps a summarized
 * verification in the verification lane instead of in the aggregate one every
 * rollup would otherwise share.
 */
export function spanLane(span: TimelineSpan): LaneId | null {
  if (span.agent_role !== undefined) return roleLaneId(span.agent_role);
  if (span.harness_scope !== undefined) return roleLaneId(span.harness_scope);
  // Widened for the lookup, not narrowed for it: a rollup's label is a plain string,
  // and a word the table has no entry for is an answer rather than an assertion.
  const table: Readonly<Record<string, LaneId | null>> = LANE_BY_SPAN_KIND;
  return table[span.kind === "rollup" ? span.label : span.kind] ?? null;
}

/**
 * What one lane is called wherever an operator meets it: a member's lane is the
 * member's own word, and a structural lane its label above.
 *
 * Read off the vocabulary the payload was drawn with where the caller holds it,
 * which is what names a member lane; the structural table and the id itself are
 * the answers for a lane that vocabulary does not list.
 */
export function laneLabel(
  lane: LaneId,
  lanes: readonly TimelineLane[] = [],
): string {
  const listed = lanes.find(({ id }) => id === lane);
  if (listed !== undefined) return listed.label;
  const table: Readonly<Record<string, string>> = STRUCTURAL_LANE_LABELS;
  return (
    table[lane] ??
    (lane.startsWith(MEMBER_LANE_PREFIX)
      ? lane.slice(MEMBER_LANE_PREFIX.length)
      : lane)
  );
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

/**
 * What one surface is called where it sits in the timeline: the kind the host
 * raised it as, and what it said.
 *
 * The kind is the host's own word and is shown as spelled — `check-in`, `finding`,
 * `edit-applied`, or anything a host's observer binding raises — because a
 * vocabulary this app translated would be a vocabulary it had to know, and the
 * whole point of an open kind is that it does not. The message is the surface
 * itself; a record that carried neither is the served kind alone.
 */
export function surfaceLabel(event: TimelineEvent): string | undefined {
  if (event.surface === undefined) return undefined;
  const named = [event.surface.kind, event.surface.message].filter(
    (part) => part !== undefined,
  );
  return named.length === 0 ? undefined : named.join(": ");
}

/** The two categories a surface is read under, by whether it holds work back. */
export const SURFACE_KIND = "Surface";
export const BLOCKING_SURFACE_KIND = "Blocking surface";

/**
 * Who submitted a live edit, when the record is one and says.
 *
 * Who submitted an edit is a fact about the edit — the planner's own decision and
 * an observer's self-applied fix are two different things to a reader scanning
 * the plan's changes — and the word is whatever author the run's bus configuration
 * declared, shown as recorded. Only an edit's: a change request's record names
 * the person who opened it under the same key, and that is a different fact
 * about a different thing.
 */
export function editAuthor(event: TimelineEvent): string | undefined {
  return event.kind.startsWith("edit-") ? event.author : undefined;
}

/**
 * What a refused edit is called in a list: the one line the engine summarised the
 * refusal in, where the record carries one. A record written before the engine wrote
 * one is called what it always was.
 */
export function refusalSummary(event: TimelineEvent): string | undefined {
  if (event.kind !== "edit-rejected") return undefined;
  const summary = event.fields?.summary;
  return typeof summary === "string" && summary.length > 0
    ? summary
    : undefined;
}

/** The author an edit names, appended to whatever the row is called. */
function byAuthor(label: string, event: TimelineEvent): string {
  const author = editAuthor(event);
  return author === undefined ? label : `${label} · by ${author}`;
}

function eventRow(event: TimelineEvent): TimelineRow {
  const redirected = redirectionLabel(event);
  const surfaced = surfaceLabel(event);
  const displayKind =
    redirected !== undefined
      ? REDIRECTION_KIND
      : event.surface === undefined
        ? "Event"
        : event.surface.blocking === true
          ? BLOCKING_SURFACE_KIND
          : SURFACE_KIND;
  const status = eventStatus(event);
  return {
    rowKind: "event",
    event,
    id: event.record_id ?? event.id,
    kind: event.kind,
    label: event.step_id ?? "",
    startedAt: event.at,
    endedAt: null,
    ...(status === undefined ? {} : { status }),
    durationMs: null,
    children: [],
    displayLabel: byAuthor(
      redirected ??
        surfaced ??
        // A tool call's one line, exactly as the server described it: a shell
        // call's command, a file tool's verb and path, a search's pattern. Never
        // derived here, so this list and `onepipeline transcript` say the same.
        (event.kind === "turn-activity" &&
        event.description !== undefined &&
        event.description !== ""
          ? event.description
          : undefined) ??
        commandStarted(event) ??
        refusalSummary(event) ??
        heldLabel(event) ??
        (event.kind === "retry-requested"
          ? "Retry requested"
          : (event.step_id ?? event.kind)),
      event,
    ),
    displayKind,
    category: eventCategory(event.kind),
    type: eventType({
      kind: event.kind,
      surface: surfaceIdOf(event) !== undefined,
      note: event.redirection !== undefined,
    }),
  };
}

/** The command a `command-started` ran, as one command line, where it names one. */
export function commandStarted(event: TimelineEvent): string | undefined {
  if (event.kind !== "command-started") return undefined;
  const argv = argvOf(event.fields?.command);
  return argv === undefined ? undefined : commandLine(argv);
}

/**
 * The reasons a `node-held` was held for, or a `node-unheld` released, as the
 * entries the engine recorded. An entry this build cannot read as a hold reason is
 * left out of the phrase rather than guessed at; the detail lists every field.
 */
export function holdReasonsOf(
  event: TimelineEvent,
): readonly TimelineHoldReason[] {
  const listed =
    event.kind === "node-held"
      ? event.fields?.reasons
      : event.kind === "node-unheld"
        ? event.fields?.released
        : undefined;
  if (!Array.isArray(listed)) return [];
  // Widened to `unknown` so the type guard can narrow: a hold reason's open
  // index signature is not a JSON value, so `filter` over the JSON list rejects it.
  const entries: readonly unknown[] = listed;
  return entries.filter(isHoldReason);
}

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isNames = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every(isName);

/**
 * Whether an entry reads as the contract's hold reason — the reading a queued
 * span's `reasons` are parsed by, so a record and the span it opened name the
 * same reasons. It is written out rather than parsed with the contract's zod
 * schema because this module draws the first screen, whose script carries no
 * zod (`tests/e2e/ui.rs`); `timeline-model.test.ts` holds it to that schema.
 */
export function isHoldReason(entry: unknown): entry is TimelineHoldReason {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return false;
  const { kind, blocking, ahead, limit, reference, awaiting } = entry as Record<
    string,
    unknown
  >;
  return (
    isName(kind) &&
    (blocking === undefined || isNames(blocking)) &&
    (ahead === undefined || isNames(ahead)) &&
    (awaiting === undefined || isNames(awaiting)) &&
    (reference === undefined || isName(reference)) &&
    (limit === undefined ||
      (typeof limit === "number" && Number.isInteger(limit) && limit >= 0))
  );
}

/** What a hold or its release reads as in a row, where the record says why. */
function heldLabel(event: TimelineEvent): string | undefined {
  if (event.kind !== "node-held" && event.kind !== "node-unheld")
    return undefined;
  const reasons = holdReasonsOf(event);
  const word = event.kind === "node-held" ? "Held" : "Released from";
  if (reasons.length === 0)
    return event.kind === "node-held" ? "Held" : "Released";
  return event.kind === "node-held"
    ? `${word} ${holdLabel(reasons)}`
    : `${word} ${reasons.map((reason) => reason.kind).join(" and ")}`;
}

/**
 * Where a message the run was sent stands, in the record's own terms: an edit
 * the engine committed is applied, a refused one is not, an accepted command that
 * changed nothing is accepted, and a note it carried to a later dispatch is held
 * for it. Every other record keeps the status it was served with.
 */
function eventStatus(event: TimelineEvent): string | undefined {
  if (event.kind === "edit-rejected") return "not applied";
  if (event.kind === "edit-committed")
    return event.redirection?.delivered === false ? "held" : "applied";
  if (event.kind === "command-accepted") return "accepted";
  if (event.kind === "note-shown") return "shown";
  if (event.kind === "human-attested") return "attested";
  return event.status;
}

/**
 * What one span is called in the lane legend and the transcript's eyebrow.
 *
 * Every answer is a category an operator reads about; the served identifiers
 * `rollup` and `pr-drafting` never reach the screen as themselves.
 */
function displayKind(
  span: TimelineSpan,
  role: AgentRole | undefined,
  transport: TransportRole | undefined,
): string {
  if (span.kind === "step") return "Lifecycle";
  if (span.kind === "rollup") return ROLLUP_LABELS[span.label] ?? span.label;
  if (span.kind === "dispatch") return dispatchRoleLabel(role, transport);
  const lane = LANE_BY_SPAN_KIND[span.kind];
  return lane === null ? span.kind : laneLabel(lane);
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
 * artifact it was. A judge session says `worker · judge` — the member it
 * supervised and the transport that tells it from that member's own session — and
 * says which session it was, which is the pair a reader needs to tell three
 * concurrent sessions apart.
 */
function spanLabel(
  span: TimelineSpan,
  role: AgentRole | undefined,
  transport: TransportRole | undefined,
): string {
  if (span.kind === "step")
    return span.label ? `Lifecycle: ${span.label}` : "Lifecycle step";
  // A queue is named for what it was waiting for and never for the node it held:
  // "Queued" alone is the empty space this span replaced, said in a word.
  if (span.kind === "queued")
    return `Queued ${holdLabel(span.reasons ?? [])}`.trim();
  const kind = displayKind(span, role, transport);
  if (span.kind === "rollup") return `${kind}: ${span.count ?? 0} recorded`;
  if (!span.label || span.label === kind) return kind;
  // A session is named for the session it is; everything else is named for the
  // artifact or branch it acted on, which reads as a subtitle rather than an alias.
  return span.kind === "dispatch"
    ? `${kind} (${span.label})`
    : `${kind}: ${span.label}`;
}

/**
 * Label each attempt's working session from retry-requested records without
 * renaming sessions: the session that opened the dispatch — its agent side,
 * whatever member word it ran under — is the one a retry re-asked.
 */
function labelWorkerRetries(rows: readonly TimelineRow[]): TimelineRow[] {
  let retry = 0;
  return rows.map((row) => {
    if (row.rowKind === "event" && row.event.kind === "retry-requested")
      retry += 1;
    const children = labelWorkerRetries(row.children);
    if (!opensDispatch(row.transport) || retry === 0)
      return { ...row, children };
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
    if (opensDispatch(row.transport)) {
      ordinal += 1;
      agentIndex = grouped.length;
      grouped.push(joined(row, { id: row.id, label: `Dispatch ${ordinal}` }));
      continue;
    }
    const agent = agentIndex < 0 ? undefined : grouped[agentIndex];
    if (supervises(row.transport) && agent?.dispatch !== undefined) {
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

/** The server owns grouping even when a filter hides all boundary records. */
function servedDispatchGroups(rows: readonly TimelineRow[]): TimelineRow[] {
  const buckets = new Map<
    string,
    {
      metadata: NonNullable<TimelineEvent["dispatch_group"]>;
      members: TimelineRow[];
    }
  >();
  const outside: TimelineRow[] = [];
  for (const row of flattenRows(rows).filter(
    (row) => row.rowKind !== "group",
  )) {
    const metadata =
      row.rowKind === "event"
        ? row.event.dispatch_group
        : row.span.dispatch_group;
    const member = { ...row, children: [] };
    if (metadata === undefined) {
      outside.push(member);
      continue;
    }
    const bucket = buckets.get(metadata.id) ?? { metadata, members: [] };
    bucket.members.push({
      ...member,
      dispatch: { id: metadata.id, label: metadata.label },
    });
    buckets.set(metadata.id, bucket);
  }
  const groupedMembers = (members: readonly TimelineRow[]) => [
    ...members
      .filter((row) => row.rowKind === "span" && row.kind === "dispatch")
      .sort(byStart),
    ...members
      .filter((row) => row.rowKind !== "span" || row.kind !== "dispatch")
      .sort(byStart),
  ];
  return [
    ...outside.map((row) => ({
      at: row.startedAt,
      order: row.rowKind === "event" ? (row.event.journal_order ?? 0) * 3 : 0,
      rows: [row],
    })),
    ...[...buckets.values()].map(({ metadata, members }) => ({
      at: metadata.started_at,
      order: metadata.order,
      rows: groupedMembers(members),
    })),
  ]
    .sort(
      (left, right) =>
        Date.parse(left.at) - Date.parse(right.at) || left.order - right.order,
    )
    .flatMap(({ rows }) => rows);
}

/** The parties that run over an agent's work rather than being dispatched alone. */
function supervises(transport: TransportRole | undefined): boolean {
  return transport === "judge" || transport === LLMLINT_TRANSPORT;
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
  const delta = Date.parse(first.startedAt) - Date.parse(next.startedAt);
  if (delta !== 0) return delta;
  return first.rowKind === "event" && next.rowKind === "event"
    ? (first.event.journal_order ?? 0) - (next.event.journal_order ?? 0)
    : 0;
}

function elapsed(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}

/**
 * The transcript in the order it is read: one entry per item, except that the
 * sessions of one dispatch travel together so they can be nested under its name.
 *
 * The rows of a dispatch arrive consecutively — the projection lists an agent session
 * and then the sessions recorded inside it — so a run of them is a group, and every
 * other row is a group of one. A collapse control travels with the run it stands
 * for, so opening one inside a dispatch does not tear the dispatch in two.
 */
export function transcriptRuns(reading: readonly TranscriptEntry[]): readonly {
  readonly id: string;
  readonly dispatch?: DispatchGroup;
  readonly entries: readonly TranscriptEntry[];
}[] {
  const runs: {
    id: string;
    dispatch?: DispatchGroup;
    entries: TranscriptEntry[];
  }[] = [];
  for (const entry of reading) {
    const subject = entry.entryKind === "row" ? entry.row : entry.group;
    const open = runs.at(-1);
    if (
      subject.dispatch !== undefined &&
      open?.dispatch !== undefined &&
      open.dispatch.id === subject.dispatch.id
    )
      open.entries.push(entry);
    else
      runs.push({
        id: subject.id,
        dispatch: subject.dispatch,
        entries: [entry],
      });
  }
  return runs;
}
