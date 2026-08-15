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
  const [error, setError] = useState<Error>();
  //: Bumped whenever the selected run's reads must be taken again.
  const [revision, setRevision] = useState(0);

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

  const loadList = useCallback(async () => {
    setList(await client.listRuns(true));
  }, [client]);
  const loadMore = useCallback(async () => {
    if (list?.next_cursor === undefined) return;
    try {
      const next = await client.listRuns(true, list.next_cursor);
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
      setError(undefined);
    } catch (caught) {
      setError(asError(caught));
    }
  }, [client, list]);

  const refresh = useCallback(async () => {
    try {
      await loadList();
      setError(undefined);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setLoading(false);
    }
    setRevision((current) => current + 1);
  }, [loadList]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is not read by this effect — it is what asks for the same run to be read again, which is how a refresh and a live invalidation reach the server at all. Dropping it would leave the view showing the read it took first.
  useEffect(() => {
    if (runId === undefined) {
      setRecord(undefined);
      return;
    }
    let active = true;
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
    const amend = (change: (current: RunRecord) => RunRecord) => {
      if (!active) return;
      setRecord((current) =>
        current !== undefined && reading(current) ? change(current) : current,
      );
    };
    void client
      .getRun(runId, { includeConversations: false, filter })
      .then((detail) => {
        amend((current) => ({ ...current, detail }));
        if (active) setError(undefined);
      })
      .catch(ignoreRemovedRun)
      .catch((caught: unknown) => {
        if (active) setError(asError(caught));
      });
    if (timelineScope !== undefined)
      void client
        .getTimeline(runId, timelineScope.nodeId, filter)
        .then((timeline) =>
          amend((current) => ({
            ...current,
            timeline,
            timelineError: undefined,
          })),
        )
        .catch(ignoreRemovedRun)
        .catch((caught: unknown) =>
          amend((current) => ({ ...current, timelineError: asError(caught) })),
        );
    return () => {
      active = false;
    };
  }, [client, runId, revision, timelineScope?.nodeId, timelineScopeKey, filter]);

  useEffect(() => {
    void refresh();
    const subscription = client.subscribe({
      onEvent: (event) => {
        setLastUpdated(new Date().toISOString());
        // Every connection — including one the browser reopened after a drop —
        // opens with a snapshot, so an arriving event means the stream recovered.
        setError(undefined);
        if (event.event === "snapshot") {
          setList(parseRunList(event.data));
          setRevision((current) => current + 1);
          return;
        }
        const invalidated = invalidatedRunId(event);
        if (invalidated === undefined) return;
        void loadList().catch((caught: unknown) => setError(asError(caught)));
        // Only the run being looked at is re-read: another run's progress changes
        // its row in the list and nothing else that is on screen.
        if (invalidated === selected.current)
          setRevision((current) => current + 1);
      },
      onError: (caught) => {
        setError(asError(caught));
      },
    });
    return () => subscription.close();
  }, [client, loadList, refresh]);

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
        setError(undefined);
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
      onError: (caught) => setError(asError(caught)),
    });
    return () => subscription.close();
  }, [client, runId, filter]);

  // A record read for a run that is no longer selected, or under an attention the
  // reader has since changed, is not this reading's record.
  const current =
    record !== undefined && record.runId === runId && record.filter === filter
      ? record
      : undefined;
  return useMemo(
    () => ({
      list,
      runId,
      detail: current?.detail,
      timeline: current?.timeline,
      timelineError: current?.timelineError,
      loading,
      lastUpdated,
      activity,
      error,
      refresh,
      loadMore,
      hasMore: list?.next_cursor !== undefined,
    }),
    [
      list,
      runId,
      current,
      loading,
      lastUpdated,
      activity,
      error,
      refresh,
      loadMore,
    ],
  );
}

/**
 * Swallow the one read failure that is not a failure: a run removed between the
 * read that listed it and the read that fetched it. The next list already drops it,
 * so reporting "no recorded run" would only describe the race, not a problem.
 */
function ignoreRemovedRun(caught: unknown): void {
  if (caught instanceof TelemetryClientError && caught.status === 404) return;
  throw caught;
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
