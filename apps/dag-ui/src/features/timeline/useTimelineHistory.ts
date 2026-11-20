// llmlint: ignore-file[stateful_logic_extracted_to_hooks] this is the hook: everything a run's
// history pages hold lives here so the two timeline views only ask for the next piece.
import {
  type RunTimeline,
  type TimelineEventRow,
  type TimelineSpan,
  timelineSpanSchema,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { NODE_TIMELINE_PARTIAL_DELAY_MS } from "@onepipeline-ui/timeline-categories";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What a span's read is held under, before the span's id. */
const SPAN_KEY = "span:";

/** Rows a zoom, a span's or a whole row's expansion asks for per request. */
const WIDE_PAGE = 500;

/** How long a node's timeline loads before the chart is drawn as partial. */
export const PARTIAL_RENDER_DELAY_MS = NODE_TIMELINE_PARTIAL_DELAY_MS;

/** Reads of a node's stream before a failure is shown, the first included. */
export const NODE_READ_ATTEMPTS = 3;

/** The wait before retry `attempt` (1-based) of a node's stream. */
export const nodeReadBackoffMs = (attempt: number): number =>
  500 * 2 ** (attempt - 1);

/**
 * The key a held row is merged under: the record it reads. Two records can share
 * a row `id` — a turn's opening and its close — and merging by that would drop one.
 */
export const rowKey = (row: {
  readonly id: string;
  readonly record_id?: string | null;
}): string => row.record_id ?? row.id;

type Interval = readonly [number, number];

/** A page's `span`: the span's whole fields, its events left out. */
const spanFieldsSchema = timelineSpanSchema.omit({ events: true });
type SpanFields = Omit<TimelineSpan, "events">;

export interface HistoryFailure {
  readonly message: string;
  readonly retry: () => void;
}

/** Where a node's streamed read of its whole timeline stands. */
export interface NodeLoad {
  /**
   * `loading` while a read is in flight or a retry is queued; `held` once every
   * row of the node has arrived; `failed` once every attempt failed.
   */
  readonly state: "loading" | "held" | "failed";
  /** Records the stream has delivered. */
  readonly loaded: number;
  /** Records the node holds, once the stream's start line said. */
  readonly total?: number;
  /** Still loading past {@link PARTIAL_RENDER_DELAY_MS}: what is drawn is partial. */
  readonly partial: boolean;
}

export interface TimelineHistory {
  /** The timeline with every row and span fields the pages have brought. */
  readonly timeline?: RunTimeline;
  /** Stretches of the plot no held row covers. */
  readonly unheld: readonly Interval[];
  /** Read one span whole: its fields and its rows, once. */
  readonly loadSpan: (spanId: string) => void;
  /** Read every row of a node's share of Overall; once. */
  readonly loadRow: (node: string | undefined) => void;
  /** Read the stretch from `from` to `to`, epoch ms; once. */
  readonly loadStretch: (
    from: number,
    to: number,
    node: string | undefined,
  ) => void;
  /**
   * The failure of a read the timeline itself asked for — a row's, a stretch's, or a
   * node's whole timeline — and never a span's, whose failure is its panel's.
   */
  readonly failure?: HistoryFailure;
  /** Why the last read of one span failed, while it has not been read since. */
  readonly spanFailure: (spanId: string) => HistoryFailure | undefined;
  /** The span's panel closed: its read's failure goes with it. */
  readonly forgetSpan: (spanId: string) => void;
  /** A node's whole-timeline read; absent for the run scope. */
  readonly nodeLoad?: NodeLoad;
}

function rowsOfSpan(
  span: TimelineSpan,
  extra: readonly TimelineEventRow[] | undefined,
): TimelineSpan {
  if (extra === undefined) return span;
  const seen = new Set(span.events.map(rowKey));
  const fresh = extra.filter((row) => !seen.has(rowKey(row)));
  if (fresh.length === 0) return span;
  // Each instant read once rather than in every comparison: a busy node sorts
  // thousands of rows on every batch its read draws.
  const keyed = [...span.events, ...fresh].map(
    (event) => [Date.parse(event.at), event.journal_order ?? 0, event] as const,
  );
  keyed.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return { ...span, events: keyed.map(([, , event]) => event) };
}

/** The stretches `spans` hold no rows of, merged, in time order. */
export function unheldStretches(
  spans: readonly TimelineSpan[],
): readonly Interval[] {
  const stretches = spans
    .flatMap((span): Interval[] => {
      const total = span.events_total;
      if (total === undefined || total <= span.events.length) return [];
      const earliest = span.events[0];
      const start = Date.parse(span.started_at);
      const end =
        earliest === undefined
          ? Date.parse(span.ended_at ?? span.started_at)
          : Date.parse(earliest.at);
      return end > start ? [[start, end]] : [];
    })
    .sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of stretches) {
    const open = merged.at(-1);
    if (open !== undefined && from <= open[1]) open[1] = Math.max(open[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/**
 * The rows a run's timeline payloads hold beyond what the server sent, merged by
 * record with what the stream keeps sending. A node's whole timeline is read as soon
 * as its view opens, through the node stream, retried with backoff and then shown as
 * failed; the run's pages are taken only when the person expands or zooms. A window
 * the stream moves past stays, because a row once held is held.
 */
export function useTimelineHistory({
  client,
  runId,
  scope,
  nodeId,
  timeline,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly scope: "run" | "node";
  readonly nodeId?: string;
  readonly timeline?: RunTimeline;
}): TimelineHistory {
  const rows = useRef(new Map<string, TimelineEventRow>());
  const spanFields = useRef(new Map<string, SpanFields>());
  const asked = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  // Each failure is held under the read that failed, so it is cleared by that read
  // succeeding and shown only by the view that asked for it.
  const [failures, setFailures] = useState<ReadonlyMap<string, HistoryFailure>>(
    () => new Map(),
  );

  const bump = useCallback(() => setVersion((value) => value + 1), []);
  const take = useCallback(
    (page: { readonly rows: readonly TimelineEventRow[] }) => {
      for (const row of page.rows) rows.current.set(rowKey(row), row);
    },
    [],
  );
  const cleared = useCallback((key: string) => {
    setFailures((held) => {
      if (!held.has(key)) return held;
      const rest = new Map(held);
      rest.delete(key);
      return rest;
    });
  }, []);
  const failed = useCallback(
    (key: string, caught: unknown, retry: () => void) => {
      // Not asked any more: whatever asks for it next reads it again.
      asked.current.delete(key);
      setFailures((held) =>
        new Map(held).set(key, {
          message: caught instanceof Error ? caught.message : String(caught),
          // Read again, never answered from what was asked before.
          retry,
        }),
      );
      bump();
    },
    [bump],
  );

  const merged = useMemo(() => {
    void version;
    if (timeline === undefined) return timeline;
    // A window the stream moves forward must not lose what it held: keep every
    // event a node's window has ever shown.
    if (scope === "node") {
      for (const span of timeline.spans)
        for (const event of span.events)
          if (!rows.current.has(rowKey(event)))
            rows.current.set(rowKey(event), { ...event, span_id: span.id });
    }
    const bySpan = new Map<string, TimelineEventRow[]>();
    for (const row of rows.current.values()) {
      const group = bySpan.get(row.span_id);
      if (group === undefined) bySpan.set(row.span_id, [row]);
      else group.push(row);
    }
    if (bySpan.size === 0 && spanFields.current.size === 0) return timeline;
    return {
      ...timeline,
      spans: timeline.spans.map((span) => {
        const withRows = rowsOfSpan(span, bySpan.get(span.id));
        const fields = spanFields.current.get(span.id);
        // The served document is refreshed as records arrive and a page is read
        // once, so the document wins: a span's page only fills in what the
        // document does not carry yet, its `detail` before the rest arrives.
        return fields === undefined
          ? withRows
          : { ...fields, ...withRows, events: withRows.events };
      }),
    };
  }, [timeline, version, scope]);

  const nodeLoad = useNodeStream({
    client,
    runId,
    nodeId: scope === "node" ? nodeId : undefined,
    opened: timeline !== undefined,
    take,
    bump,
  });
  // The plot's loading mark is the loader's own state: drawn over what is not held
  // only while the node's read is in flight or queued, never once it is held or
  // has failed.
  const nodeLoading = nodeLoad?.state === "loading";
  const unheld = useMemo(() => {
    if (scope !== "node" || !nodeLoading) return [];
    return unheldStretches(merged?.spans ?? []);
  }, [merged, scope, nodeLoading]);
  const shownFailure =
    nodeLoad?.failure ??
    [...failures].find(([key]) => !key.startsWith(SPAN_KEY))?.[1];
  const spanFailure = useCallback(
    (spanId: string) => failures.get(`${SPAN_KEY}${spanId}`),
    [failures],
  );
  const forgetSpan = useCallback(
    (spanId: string) => cleared(`${SPAN_KEY}${spanId}`),
    [cleared],
  );

  const readAll = useCallback(
    async (
      key: string,
      query: {
        readonly node?: string;
        readonly span?: string;
        readonly from?: string;
        readonly to?: string;
      },
      retry: () => void,
    ) => {
      // A read under way is the answer now, rather than one that failed before it.
      cleared(key);
      try {
        let next: string | undefined;
        for (;;) {
          const answered = await client.getTimelineEvents(runId, {
            scope,
            limit: WIDE_PAGE,
            ...query,
            ...(next === undefined ? {} : { cursor: next }),
          });
          take(answered);
          const { span } = answered;
          if (query.span !== undefined && span !== undefined)
            spanFields.current.set(query.span, spanFieldsSchema.parse(span));
          bump();
          if (answered.next_cursor === null) return;
          next = answered.next_cursor;
        }
      } catch (caught) {
        failed(key, caught, retry);
      }
    },
    [bump, cleared, client, failed, runId, scope, take],
  );

  const loadSpan = useCallback(
    (spanId: string) => {
      const key = `${SPAN_KEY}${spanId}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void readAll(
        key,
        { span: spanId, ...(nodeId === undefined ? {} : { node: nodeId }) },
        () => loadSpan(spanId),
      );
    },
    [nodeId, readAll],
  );

  const loadRow = useCallback(
    (node: string | undefined) => {
      const key = `row:${node ?? ""}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void readAll(key, node === undefined ? {} : { node }, () =>
        loadRow(node),
      );
    },
    [readAll],
  );

  const loadStretch = useCallback(
    (from: number, to: number, node: string | undefined) => {
      const key = `stretch:${node ?? ""}:${from}:${to}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void readAll(
        key,
        {
          ...(node === undefined ? {} : { node }),
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        },
        () => loadStretch(from, to, node),
      );
    },
    [readAll],
  );

  return {
    ...(merged === undefined ? {} : { timeline: merged }),
    unheld,
    loadSpan,
    loadRow,
    loadStretch,
    spanFailure,
    forgetSpan,
    ...(shownFailure === undefined ? {} : { failure: shownFailure }),
    ...(nodeLoad === undefined ? {} : { nodeLoad: withoutFailure(nodeLoad) }),
  };
}

/**
 * A node's whole timeline, read through its stream once the view has opened and
 * taken a line at a time, each line drawn as it arrives. A failed read is tried again
 * after a growing wait, {@link NODE_READ_ATTEMPTS} times in all, and is then `failed`
 * until `retry` starts it over.
 */
function useNodeStream({
  client,
  runId,
  nodeId,
  opened,
  take,
  bump,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly nodeId: string | undefined;
  readonly opened: boolean;
  readonly take: (page: { readonly rows: readonly TimelineEventRow[] }) => void;
  readonly bump: () => void;
}): (NodeLoad & { readonly failure?: HistoryFailure }) | undefined {
  const [load, setLoad] = useState<
    NodeLoad & { readonly node: string; readonly failure?: HistoryFailure }
  >();
  const [restarts, setRestarts] = useState(0);
  useEffect(() => {
    // Try again starts the read over by moving this.
    void restarts;
    if (nodeId === undefined || !opened) return;
    const controller = new AbortController();
    const delivered = new Set<string>();
    let total: number | undefined;
    const whole = () => total !== undefined && delivered.size >= total;
    let partial = false;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const show = (state: NodeLoad["state"], failure?: HistoryFailure) =>
      setLoad({
        node: nodeId,
        state,
        loaded: delivered.size,
        ...(total === undefined ? {} : { total }),
        partial: state === "loading" && partial,
        ...(failure === undefined ? {} : { failure }),
      });
    const partialAfter = setTimeout(() => {
      partial = true;
      setLoad((was) =>
        was?.node === nodeId && was.state === "loading"
          ? { ...was, partial: true }
          : was,
      );
    }, PARTIAL_RENDER_DELAY_MS);
    const read = async (attempt: number): Promise<void> => {
      try {
        for await (const line of client.streamNodeTimeline(
          runId,
          nodeId,
          controller.signal,
        )) {
          if (line.kind === "start") total = line.total;
          else {
            take(line);
            for (const row of line.rows) delivered.add(rowKey(row));
            bump();
          }
          // Every record the start line counted has arrived: the node is held in
          // the same update that draws its last rows, rather than in a second
          // whole redraw once the end line is read.
          if (whole()) clearTimeout(partialAfter);
          show(whole() ? "held" : "loading");
        }
        clearTimeout(partialAfter);
        show("held");
        bump();
      } catch (caught) {
        // Nothing is missing once every counted record has arrived.
        if (controller.signal.aborted || whole()) return;
        if (attempt < NODE_READ_ATTEMPTS) {
          waiting = setTimeout(
            () => void read(attempt + 1),
            nodeReadBackoffMs(attempt),
          );
          return;
        }
        clearTimeout(partialAfter);
        show("failed", {
          message: caught instanceof Error ? caught.message : String(caught),
          retry: () => setRestarts((count) => count + 1),
        });
      }
    };
    show("loading");
    void read(1);
    return () => {
      controller.abort();
      clearTimeout(partialAfter);
      if (waiting !== undefined) clearTimeout(waiting);
    };
  }, [client, runId, nodeId, opened, take, bump, restarts]);
  if (nodeId === undefined || load?.node !== nodeId) return undefined;
  return load;
}

/** A node's load as the view reads it, its failure shown as the history's own. */
function withoutFailure(load: NodeLoad): NodeLoad {
  return {
    state: load.state,
    loaded: load.loaded,
    ...(load.total === undefined ? {} : { total: load.total }),
    partial: load.partial,
  };
}
