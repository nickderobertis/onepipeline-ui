// llmlint: ignore-file[stateful_logic_extracted_to_hooks] this is the hook: everything a run's
// history pages hold lives here so the two timeline views only ask for the next piece.
import type {
  RunTimeline,
  TimelineEventRow,
  TimelineSpan,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import { useCallback, useMemo, useRef, useState } from "react";

/** Rows a zoom or a whole row's expansion asks for per request. */
const WIDE_PAGE = 500;
/** How many pages one asked-for stretch reads before it stops and waits to be asked. */
const MOST_PAGES = 40;

type Interval = readonly [number, number];

export interface HistoryFailure {
  readonly message: string;
  readonly retry: () => void;
}

export interface TimelineHistory {
  /** The timeline with every row and span fields the pages have brought. */
  readonly timeline?: RunTimeline;
  /** Stretches of the plot no held row covers. */
  readonly unheld: readonly Interval[];
  /** Whether a page earlier than those held exists for `node`. */
  readonly canLoadEarlier: boolean;
  readonly loadingEarlier: boolean;
  /** Read the next page back, by the page's own control or by scrolling. */
  readonly loadEarlier: () => void;
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
  readonly failure?: HistoryFailure;
}

function rowsOfSpan(
  span: TimelineSpan,
  extra: readonly TimelineEventRow[] | undefined,
): TimelineSpan {
  if (extra === undefined) return span;
  const seen = new Set(span.events.map((event) => event.id));
  const fresh = extra.filter((row) => !seen.has(row.id));
  if (fresh.length === 0) return span;
  return {
    ...span,
    events: [...span.events, ...fresh].sort(
      (left, right) =>
        Date.parse(left.at) - Date.parse(right.at) ||
        (left.journal_order ?? 0) - (right.journal_order ?? 0),
    ),
  };
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
 * The rows a run's timeline payloads hold beyond what the server sent: pages taken only
 * when the person scrolls, expands or zooms, merged by event id with what the stream
 * keeps sending. A window the stream moves past stays, because a row once held is held.
 */
export function useTimelineHistory({
  client,
  runId,
  scope,
  nodeId,
  filter,
  timeline,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly scope: "run" | "node";
  readonly nodeId?: string;
  readonly filter?: string;
  readonly timeline?: RunTimeline;
}): TimelineHistory {
  const rows = useRef(new Map<string, TimelineEventRow>());
  const spanFields = useRef(new Map<string, Record<string, unknown>>());
  const cursors = useRef(new Map<string, string | null>());
  const asked = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [failure, setFailure] = useState<HistoryFailure>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierFlight = useRef(false);

  const bump = useCallback(() => setVersion((value) => value + 1), []);
  const take = useCallback(
    (page: { readonly rows: readonly TimelineEventRow[] }) => {
      for (const row of page.rows) rows.current.set(row.id, row);
    },
    [],
  );
  const failed = useCallback(
    (caught: unknown, retry: () => void) => {
      setFailure({
        message: caught instanceof Error ? caught.message : String(caught),
        retry: () => {
          setFailure(undefined);
          retry();
        },
      });
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
          if (!rows.current.has(event.id))
            rows.current.set(event.id, { ...event, span_id: span.id });
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
        return fields === undefined
          ? withRows
          : ({
              ...withRows,
              ...fields,
              events: withRows.events,
            } as TimelineSpan);
      }),
    };
  }, [timeline, version, scope]);

  const unheld = useMemo(
    () => (scope === "node" ? unheldStretches(merged?.spans ?? []) : []),
    [merged, scope],
  );

  const cursor = nodeId ?? "";
  const canLoadEarlier =
    scope === "node" && cursors.current.has(cursor)
      ? cursors.current.get(cursor) !== null
      : (timeline?.spans ?? []).some(
          (span) =>
            span.events_total !== undefined &&
            span.events_total > span.events.length,
        );

  const loadEarlier = useCallback(() => {
    if (earlierFlight.current || scope !== "node" || nodeId === undefined)
      return;
    if (cursors.current.get(cursor) === null) return;
    earlierFlight.current = true;
    setLoadingEarlier(true);
    const next = cursors.current.get(cursor) ?? undefined;
    client
      .getTimelineEvents(runId, {
        scope,
        node: nodeId,
        ...(next === undefined ? {} : { cursor: next }),
        ...(filter === undefined ? {} : { filter }),
      })
      .then((page) => {
        take(page);
        cursors.current.set(cursor, page.next_cursor);
        bump();
      })
      .catch((caught: unknown) => failed(caught, loadEarlier))
      .finally(() => {
        earlierFlight.current = false;
        setLoadingEarlier(false);
      });
  }, [bump, client, cursor, failed, filter, nodeId, runId, scope, take]);

  const loadSpan = useCallback(
    (spanId: string) => {
      if (asked.current.has(`span:${spanId}`)) return;
      asked.current.add(`span:${spanId}`);
      client
        .getTimelineEvents(runId, {
          scope,
          span: spanId,
          ...(nodeId === undefined ? {} : { node: nodeId }),
          ...(filter === undefined ? {} : { filter }),
        })
        .then((page) => {
          take(page);
          const { span } = page;
          if (span !== undefined) spanFields.current.set(spanId, span);
          bump();
        })
        .catch((caught: unknown) => {
          asked.current.delete(`span:${spanId}`);
          failed(caught, () => loadSpan(spanId));
        });
    },
    [bump, client, failed, filter, nodeId, runId, scope, take],
  );

  const readAll = useCallback(
    async (
      query: {
        readonly node?: string;
        readonly from?: string;
        readonly to?: string;
      },
      retry: () => void,
    ) => {
      try {
        let next: string | undefined;
        for (let page = 0; page < MOST_PAGES; page += 1) {
          const answered = await client.getTimelineEvents(runId, {
            scope,
            limit: WIDE_PAGE,
            ...query,
            ...(next === undefined ? {} : { cursor: next }),
            ...(filter === undefined ? {} : { filter }),
          });
          take(answered);
          bump();
          if (answered.next_cursor === null) return;
          next = answered.next_cursor;
        }
      } catch (caught) {
        failed(caught, retry);
      }
    },
    [bump, client, failed, filter, runId, scope, take],
  );

  const loadRow = useCallback(
    (node: string | undefined) => {
      const key = `row:${node ?? ""}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void readAll(node === undefined ? {} : { node }, () => {
        asked.current.delete(key);
        loadRow(node);
      });
    },
    [readAll],
  );

  const loadStretch = useCallback(
    (from: number, to: number, node: string | undefined) => {
      const key = `stretch:${node ?? ""}:${from}:${to}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      void readAll(
        {
          ...(node === undefined ? {} : { node }),
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        },
        () => {
          asked.current.delete(key);
          loadStretch(from, to, node);
        },
      );
    },
    [readAll],
  );

  return {
    ...(merged === undefined ? {} : { timeline: merged }),
    unheld,
    canLoadEarlier,
    loadingEarlier,
    loadEarlier,
    loadSpan,
    loadRow,
    loadStretch,
    ...(failure === undefined ? {} : { failure }),
  };
}
