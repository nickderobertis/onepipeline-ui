import type {
  Adopted,
  RunStatus,
  Stopped,
  Unwatched,
  WatchFrameData,
} from "@onepipeline-ui/dag-model";
import type {
  TelemetryClient,
  TelemetrySubscription,
  WatchFrame,
} from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { asError, type Read, useRead } from "./useRead";

/** How many frames a held watch keeps on screen; older ones scroll off. */
const WATCH_FRAMES_KEPT = 200;

/**
 * The heartbeat a held watch asks for, in seconds.
 *
 * Not for the reader: a tick is how the server *notices* the browser has gone.
 * The wait runs on a blocking worker and learns the connection closed only when
 * a write to it fails, so a watch with no heartbeat keeps the watcher record —
 * and the run reading as watched — for as long as the run stays quiet. Two
 * seconds bounds that to the moment the toggle goes off.
 */
const WATCH_TICK_SECONDS = 2;

/**
 * How often the run's status is read again on its own, in milliseconds.
 *
 * Liveness is a reading of the host's process table, not of the journal: a
 * driver that dies writes nothing, so the stream every other surface refreshes
 * on announces nothing. The status read is the one that carries the word an
 * adoption is offered on, so it is taken again on a clock as well.
 */
const STATUS_POLL_MS = 10_000;

export interface WatchState {
  /** Whether this browser holds the stream now. */
  readonly held: boolean;
  readonly frames: readonly WatchFrame[];
  /** The frame that ended the last wait, until the next one is opened. */
  readonly ended?: Extract<WatchFrameData, { watch: "return" }>;
  readonly error?: Error;
}

export interface RunControl {
  readonly status: Read<RunStatus>;
  readonly unwatched: Read<Unwatched>;
  readonly watch: WatchState;
  readonly toggleWatch: () => void;
  readonly stop: (force: boolean) => Promise<Stopped>;
  readonly adopt: () => Promise<Adopted>;
}

/**
 * What a supervisor can do to one run, and what the run says about itself.
 *
 * The status read is the run's own account — its driver liveness, its unread
 * surfaces — and it is what decides whether an adoption is offered. The watch
 * is `GET .../watch` held as a stream for as long as the toggle is on: while
 * it is held the server is the run's registered watcher, which is what the
 * unwatched report reads, so that report is taken again on the first frame and
 * on the close rather than only on the stream every other surface refreshes on.
 */
export function useRunControl(
  client: TelemetryClient,
  runId: string | undefined,
  filter: string,
  invalidations: number,
): RunControl {
  //: The clock the status re-reads on, beside the stream.
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (runId === undefined) return;
    const timer = setInterval(
      () => setTicks((current) => current + 1),
      STATUS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [runId]);
  const status = useRead(
    runId,
    () => client.getStatus(runId ?? ""),
    invalidations + ticks,
  );
  //: Bumped when the watch's own state changes what the unwatched report says.
  const [watchMoves, setWatchMoves] = useState(0);
  const unwatched = useRead(
    runId === undefined ? undefined : "unwatched",
    () => client.unwatched(),
    invalidations + watchMoves,
  );
  const [watch, setWatch] = useState<WatchState>({ held: false, frames: [] });
  const subscription = useRef<TelemetrySubscription | undefined>(undefined);
  /**
   * The unwatched report, read again once the server has had a heartbeat in
   * which to notice the stream closed: the read taken at the close itself is
   * before the release, and would show the run still watched.
   */
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reread = useCallback(() => {
    setWatchMoves((current) => current + 1);
    clearTimeout(settling.current);
    settling.current = setTimeout(
      () => setWatchMoves((current) => current + 1),
      (WATCH_TICK_SECONDS + 1) * 1000,
    );
  }, []);
  const release = useCallback(() => {
    subscription.current?.close();
    subscription.current = undefined;
  }, []);
  useEffect(() => () => clearTimeout(settling.current), []);
  // A watch belongs to the run it was opened on: moving to another run, or
  // leaving, lets it go — and with it the watcher record the server kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `runId` is what says the watch no longer belongs to what is on screen; the effect reads nothing else.
  useEffect(() => {
    setWatch({ held: false, frames: [] });
    return () => {
      release();
      reread();
    };
  }, [runId, release, reread]);

  const toggleWatch = useCallback(() => {
    if (runId === undefined) return;
    if (subscription.current !== undefined) {
      release();
      setWatch((previous) => ({ ...previous, held: false }));
      reread();
      return;
    }
    let first = true;
    subscription.current = client.watch({
      runId,
      // Held open until the toggle is turned off or the run gives a reason to
      // stop waiting: the default condition, a surface, and no clock on it.
      timeout: "none",
      tick: WATCH_TICK_SECONDS,
      filter,
      onFrame: (frame) => {
        if (first) {
          first = false;
          setWatchMoves((current) => current + 1);
        }
        setWatch((previous) => ({
          held: frame.event !== "returned",
          frames: [...previous.frames, frame].slice(-WATCH_FRAMES_KEPT),
          ended: frame.data.watch === "return" ? frame.data : previous.ended,
          error: undefined,
        }));
        if (frame.event === "returned") {
          subscription.current = undefined;
          reread();
        }
      },
      onError: (caught) => {
        setWatch((previous) => ({ ...previous, error: asError(caught) }));
      },
    });
    setWatch({ held: true, frames: [], ended: undefined });
  }, [client, runId, filter, release, reread]);

  const stop = useCallback(
    (force: boolean) => client.stop(runId ?? "", force),
    [client, runId],
  );
  const adopt = useCallback(() => client.adopt(runId ?? ""), [client, runId]);

  return { status, unwatched, watch, toggleWatch, stop, adopt };
}
