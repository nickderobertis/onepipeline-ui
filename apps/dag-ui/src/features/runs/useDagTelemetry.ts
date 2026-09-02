import {
  type LiveActivity,
  liveActivityListSchema,
  parseRunList,
  type RunDetail,
  type RunList,
  type RunTimeline,
} from "@onepipeline-ui/dag-model";
import {
  type TelemetryClient,
  TelemetryClientError,
  type TelemetryEvent,
} from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// llmlint: ignore-file[changed_behavior_has_e2e] The browser suite in e2e/dag-ui.spec.ts
// drives every branch a conforming server can reach: the opening snapshot, a
// `run.changed` raised by appending a real journal event to the served run, a
// `run.removed` raised by taking that run out of the served root, the empty list that
// follows, and a read the browser cannot complete at all. Two branches are left that
// only a broken peer reaches — a snapshot that fails contract validation, and a stream
// that drops after a successful handshake — and this repository's server produces
// neither: it validates what it serves, and an unreachable API fails the handshake
// rather than dropping a live stream. Both are proven in App.test.tsx, which drives
// the real app and the real telemetry client at their browser boundary.

/**
 * What has been read for the one run being looked at.
 *
 * Transcripts are deliberately absent: they dominate the detail payload, so the
 * detail is fetched without them and the ordered record comes from the timeline
 * instead. A single conversation is fetched by whichever view opens it, and re-read
 * only when the timeline says that session recorded something — see
 * `useConversation`, which owns that rule.
 */
interface RunRecord {
  readonly runId: string;
  /**
   * Which filter this record was read under. Part of the record's identity, so a
   * reading taken under one attention is never shown under another's name — the
   * same rule the run id and the timeline scope already keep.
   */
  readonly filter?: string;
  readonly timelineScope?: string;
  readonly detail?: RunDetail;
  readonly timeline?: RunTimeline;
  readonly timelineError?: Error;
}

export interface DagTelemetryState {
  readonly list?: RunList;
  /** The run being read: the requested one when it is served, else the first listed. */
  readonly runId?: string;
  readonly detail?: RunDetail;
  readonly timeline?: RunTimeline;
  /** A timeline read that failed, reported where the timeline would have been. */
  readonly timelineError?: Error;
  readonly loading: boolean;
  readonly lastUpdated?: string;
  readonly activity: readonly LiveActivity[];
  readonly error?: Error;
  readonly refresh: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
  readonly hasMore: boolean;
  /**
   * Whether the next page is on its way, so the list can say it is loading rather
   * than looking like a list that has simply stopped at its end.
   */
  readonly loadingMore: boolean;
}

export function useDagTelemetry(
  client: TelemetryClient,
  requestedRunId?: string,
  timelineScope?: { readonly nodeId?: string },
  /**
   * Which events every read this hook takes carries — a filter profile name.
   *
   * It shapes what is served and never the run: the node statuses and counts a
   * detail carries are folded from the whole journal whatever this says, so
   * switching it changes what a reader is shown and not what they are shown
   * *about*.
   */
  filter?: string,
): DagTelemetryState {
  const [list, setList] = useState<RunList>();
  const [record, setRecord] = useState<RunRecord>();
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [activity, setActivity] = useState<readonly LiveActivity[]>([]);
  /**
   * A reading this view asked for and did not get, and a live stream that is not
   * delivering — held apart because they are answered by different things.
   *
   * They used to be one slot that every arriving frame cleared, on the reasoning
   * that a frame means the stream recovered. It does; it says nothing about
   * whether the reading the viewer asked for can be served. A run-scoped stream
   * opens with a frame of its own within a few tens of milliseconds of the detail
   * read beside it, so a refused reading — a filter naming a profile the run does
   * not have, say — raised its banner and had it wiped before anybody could read
   * it. So a frame clears the stream's error alone.
   *
   * A **served read** clears both, and that direction is deliberate: a server that
   * answered a read is reachable, which is what the stream's error was about.
   */
  const [readError, setReadError] = useState<Error>();
  const [streamError, setStreamError] = useState<Error>();
  //: Bumped whenever the selected run's reads must be taken again.
  const [revision, setRevision] = useState(0);
  //: Whether the next page of the run list is on its way, so the list can say so.
  const [loadingMore, setLoadingMore] = useState(false);

  const runId =
    list === undefined
      ? undefined
      : list.runs.some(({ run_id }) => run_id === requestedRunId)
        ? requestedRunId
        : list.runs.at(0)?.run_id;
  const timelineScopeKey =
    timelineScope === undefined ? undefined : (timelineScope.nodeId ?? "run");
  // Read by the event stream, which must not be torn down and reopened every time
  // the operator selects a different run.
  const selected = useRef(runId);
  useEffect(() => {
    selected.current = runId;
  }, [runId]);
  /**
   * Which reading is on screen — the run, the timeline scope and the attention it
   * is being read under, together — so a failed read can tell whether the reader
   * is still looking at what it was reading.
   */
  const viewing = useRef<string | undefined>(undefined);
  /**
   * The reading currently being read, and whether something moved while it was
   * being read. One reading is read at a time: a stream can invalidate faster than
   * the server can answer, and a run whose detail has never arrived must not be
   * starved by re-asking for it before the last ask has landed.
   */
  const reads = useRef<{ key: string; again: boolean } | undefined>(undefined);
  //: Whether the global stream has already handed this view a snapshot.
  const opened = useRef(false);

  /** What a read that the server answered says: this reading is served, and it is
   *  reachable. */
  const served = useCallback(() => {
    setReadError(undefined);
    setStreamError(undefined);
  }, []);

  const loadList = useCallback(async () => {
    setList(await client.listRuns(true));
  }, [client]);
  /**
   * The cursor a page read is out for, so the scroll that asked for it can fire as
   * often as a scroll fires without asking for the same page twice.
   *
   * Cleared however the read ends, so the reader who scrolls again after a failed
   * page gets the retry that failure invites.
   */
  const paging = useRef<string | undefined>(undefined);
  const loadMore = useCallback(async () => {
    const cursor = list?.next_cursor;
    if (cursor === undefined || paging.current === cursor) return;
    paging.current = cursor;
    setLoadingMore(true);
    try {
      const next = await client.listRuns(true, cursor);
      setList((current) =>
        current === undefined
          ? next
          : {
              ...next,
              runs: [
                ...current.runs,
                ...next.runs.filter(
                  ({ run_id }) =>
                    !current.runs.some((run) => run.run_id === run_id),
                ),
              ],
            },
      );
      served();
    } catch (caught) {
      setReadError(asError(caught));
    } finally {
      paging.current = undefined;
      setLoadingMore(false);
    }
  }, [client, list, served]);

  /**
   * Refresh the one row an invalidation named, and nothing else.
   *
   * This is what the run-list route's named selection is for: refetching the first
   * page instead discards every page the reader had scrolled to, and on a host
   * where anything is moving that happened twice a second — which is why the list
   * snapped back to the top and could not be scrolled past its first page at all.
   *
   * The three answers are the server's rather than this reader's guesses. A row it
   * serves replaces the one held for that run, or joins the list at the top when
   * none is held — the list is ordered by last activity and a run that just moved
   * has the most recent. A run named in `missing` no longer exists, so its row
   * goes. A run the answer says nothing about is left exactly as it is: a selection
   * never surveys the runs root, so silence about a run is not a statement that it
   * went away.
   */
  const refreshRow = useCallback(
    async (runId: string) => {
      const answer = await client.selectRuns([runId]);
      setList((current) => {
        if (current === undefined) return current;
        if (answer.missing?.includes(runId) === true) {
          return {
            ...current,
            runs: current.runs.filter((run) => run.run_id !== runId),
          };
        }
        const row = answer.runs.find((run) => run.run_id === runId);
        if (row === undefined) return current;
        return {
          ...current,
          runs: current.runs.some((run) => run.run_id === runId)
            ? current.runs.map((run) => (run.run_id === runId ? row : run))
            : [row, ...current.runs],
        };
      });
    },
    [client],
  );

  /** The first list this view takes, which asks for nothing to be read again. */
  const open = useCallback(async () => {
    try {
      await loadList();
      served();
    } catch (caught) {
      setReadError(asError(caught));
    } finally {
      setLoading(false);
    }
  }, [loadList, served]);

  /**
   * The reader asking for the whole reading to be taken again.
   *
   * It bumps the revision, which `open` deliberately does not: asking for a re-read
   * before the first read has happened takes the run's detail twice within a frame
   * of itself, for a payload that cannot have changed.
   */
  const refresh = useCallback(async () => {
    await open();
    setRevision((current) => current + 1);
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is not read by this effect — it is what asks for the same run to be read again, which is how a refresh and a live invalidation reach the server at all. Dropping it would leave the view showing the read it took first.
  useEffect(() => {
    if (runId === undefined) {
      setRecord(undefined);
      reads.current = undefined;
      return;
    }
    // Keep what is already on screen while the same run is re-read; drop it the
    // moment a different run is selected, so no view renders one run's detail
    // under another's name.
    // What makes a record *this* reading's: all three of the run, the scope, and
    // the attention it was read under. Taking a `RunRecord` rather than an optional
    // one keeps the `undefined` case at each call site, where it means something
    // different — nothing read yet, as against something read for another reading.
    const reading = (candidate: RunRecord) =>
      candidate.runId === runId &&
      candidate.timelineScope === timelineScopeKey &&
      candidate.filter === filter;
    const key = readingKeyOf(runId, timelineScopeKey, filter);
    viewing.current = key;
    setRecord((current) => {
      if (current !== undefined && reading(current)) return current;
      // The detail already on screen is carried over only when it describes the
      // *same* reading of the same run — a detail read under a different filter
      // describes a different slice, and showing it under the new one would be
      // the reader's own toggle appearing not to have done anything.
      const reusable =
        current?.runId === runId &&
        current.filter === filter &&
        current.detail !== undefined
          ? current.detail
          : undefined;
      return {
        runId,
        filter,
        timelineScope: timelineScopeKey,
        ...(reusable === undefined ? {} : { detail: reusable }),
      };
    });
    // A read is discarded on what it *is* — the run, the scope and the attention it
    // was taken under — and never on when it was started. A read still current for
    // this reading lands even though an invalidation arrived while it was in
    // flight, which is the half of the livelock this side owns: on a run recording
    // continuously, every read used to be marked stale by the next poll tick before
    // the server could answer it, so the detail was never set and the view sat on
    // "Loading execution history…" for as long as the run kept moving.
    const amend = (change: (previous: RunRecord) => RunRecord) => {
      setRecord((previous) =>
        previous !== undefined && reading(previous)
          ? change(previous)
          : previous,
      );
    };
    // And an error is reported only while this reading is the one on screen, so a
    // read the reader has already moved away from cannot raise a banner about a run
    // they are no longer looking at.
    const report = (set: () => void) => {
      if (viewing.current === key) set();
    };
    // Starting a second read of a reading already being read is the other half of
    // the livelock: with the poll at half a second and the read taking twenty, that
    // is forty reads in flight for one run, each of them making the next slower. So
    // an invalidation that arrives mid-read is remembered rather than obeyed, and
    // obeyed once the read it arrived during has landed.
    const outstanding = reads.current;
    if (outstanding?.key === key) {
      outstanding.again = true;
      return;
    }
    const take = () => {
      reads.current = { key, again: false };
      const settled = () => {
        const state = reads.current;
        if (state?.key !== key) return;
        if (state.again) {
          take();
          return;
        }
        reads.current = undefined;
      };
      const detail = client
        .getRun(runId, { includeConversations: false, filter })
        .then((read) => {
          amend((previous) => ({ ...previous, detail: read }));
          report(served);
        })
        .catch(ignoreRemovedRun)
        .catch((caught: unknown) => {
          report(() => setReadError(asError(caught)));
        });
      const timeline =
        timelineScope === undefined
          ? Promise.resolve()
          : client
              .getTimeline(runId, timelineScope.nodeId, filter)
              .then((read) =>
                amend((previous) => ({
                  ...previous,
                  timeline: read,
                  timelineError: undefined,
                })),
              )
              .catch(ignoreRemovedRun)
              .catch((caught: unknown) =>
                amend((previous) => ({
                  ...previous,
                  timelineError: asError(caught),
                })),
              );
      void Promise.all([detail, timeline]).then(settled, settled);
    };
    take();
  }, [
    client,
    runId,
    revision,
    timelineScope?.nodeId,
    timelineScopeKey,
    filter,
  ]);

  useEffect(() => {
    void open();
    const subscription = client.subscribe({
      onEvent: (event) => {
        setLastUpdated(new Date().toISOString());
        // Every connection — including one the browser reopened after a drop —
        // opens with a snapshot, so an arriving event means the stream recovered.
        // It means nothing about a reading this view asked for and did not get.
        setStreamError(undefined);
        if (event.event === "snapshot") {
          setList(parseRunList(event.data));
          // The **opening** snapshot is the state the first list read has just
          // taken, so nothing about the open run is read again for it. A later one
          // means the stream dropped and came back, and a run that moved during
          // that outage was never announced — so that run is read again.
          if (opened.current) setRevision((current) => current + 1);
          opened.current = true;
          return;
        }
        const invalidated = invalidatedRunId(event);
        if (invalidated === undefined) return;
        // One row for one invalidation. The first page is not refetched: doing so
        // threw away every page the reader had scrolled to, so a list on a host
        // with anything moving snapped back to the top before it could be read.
        void refreshRow(invalidated).catch((caught: unknown) =>
          setReadError(asError(caught)),
        );
        // Only the run being looked at is re-read: another run's progress changes
        // its row in the list and nothing else that is on screen.
        if (invalidated === selected.current)
          setRevision((current) => current + 1);
      },
      onError: (caught) => {
        setStreamError(asError(caught));
      },
    });
    return () => subscription.close();
  }, [client, refreshRow, open]);

  useEffect(() => {
    if (runId === undefined) {
      setActivity([]);
      return;
    }
    const subscription = client.subscribe({
      runId,
      filter,
      onEvent: (event) => {
        setLastUpdated(new Date().toISOString());
        setStreamError(undefined);
        // The global stream owns the complete run list. A run-scoped snapshot is
        // intentionally partial and must never replace it.
        if (event.event === "snapshot") return;
        if (event.event === "activity.changed") {
          const candidate = event.data.activity;
          setActivity(liveActivityListSchema.parse(candidate));
        }
        if (
          event.event === "conversation.changed" ||
          event.event === "activity.changed" ||
          event.event === "run.changed"
        )
          setRevision((current) => current + 1);
      },
      onError: (caught) => setStreamError(asError(caught)),
    });
    return () => subscription.close();
  }, [client, runId, filter]);

  // A record read for a run that is no longer selected, or under an attention the
  // reader has since changed, is not this reading's record.
  const shown =
    record !== undefined && record.runId === runId && record.filter === filter
      ? record
      : undefined;
  return useMemo(
    () => ({
      list,
      runId,
      detail: shown?.detail,
      timeline: shown?.timeline,
      timelineError: shown?.timelineError,
      loading,
      lastUpdated,
      activity,
      // The refused reading first: it is the one the viewer asked for, and it is
      // the one they can do something about.
      error: readError ?? streamError,
      refresh,
      loadMore,
      hasMore: list?.next_cursor !== undefined,
      loadingMore,
    }),
    [
      list,
      runId,
      shown,
      loading,
      lastUpdated,
      activity,
      readError,
      streamError,
      refresh,
      loadMore,
      loadingMore,
    ],
  );
}

/**
 * Swallow the one read failure that is not a failure: a run removed between the
 * read that listed it and the read that fetched it. The next list already drops it,
 * so reporting "no recorded run" would only describe the race, not a problem.
 *
 * Matched on the code and not on the status, because that race is no longer the
 * only 404 these routes serve: a `filter` naming a profile the run does not have
 * is one too, and it is a reading the viewer asked for and did not get. Swallowed
 * on the status alone, it would leave them looking at the previous reading with
 * nothing saying the switch did nothing.
 *
 * The run-list route naming a requested id in `missing` rather than failing does
 * **not** retire this. That is a different route: `missing` is how the *list* learns
 * a row has gone, and it says nothing about the run-**detail** read this catches,
 * which still answers `404 run_not_found` for a run swept between the read that
 * listed it and the read that fetched it. The two reads race by construction — the
 * detail read is already out when the selection answers — so without this the
 * operator is shown a telemetry banner for a race the next list already resolved.
 */
function ignoreRemovedRun(caught: unknown): void {
  if (caught instanceof TelemetryClientError && caught.code === "run_not_found")
    return;
  throw caught;
}

/**
 * What makes two reads of one run the same reading: the run, the timeline scope and
 * the attention. `\u0000` separates them because no run id, scope or filter name can
 * hold one, so no two different readings can spell one key.
 */
function readingKeyOf(
  runId: string,
  timelineScope?: string,
  filter?: string,
): string {
  return [runId, timelineScope ?? "", filter ?? ""].join("\u0000");
}

/** The run an invalidation event names, or `undefined` when it names none. */
function invalidatedRunId(event: TelemetryEvent): string | undefined {
  const runId = "run_id" in event.data ? event.data.run_id : undefined;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  // An `EventSource` failure arrives as a bare DOM Event with nothing to read.
  if (typeof Event !== "undefined" && value instanceof Event) {
    return new Error("Live telemetry stream disconnected");
  }
  return new Error(String(value));
}
