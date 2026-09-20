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
  const status = useRead(
    runId,
    () => client.getStatus(runId ?? ""),
    invalidations,
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
  const release = useCallback(() => {
    subscription.current?.close();
    subscription.current = undefined;
  }, []);
  // A watch belongs to the run it was opened on: moving to another run, or
  // leaving, lets it go — and with it the watcher record the server kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `runId` is what says the watch no longer belongs to what is on screen; the effect reads nothing else.
  useEffect(() => {
    setWatch({ held: false, frames: [] });
    return () => {
      release();
      setWatchMoves((current) => current + 1);
    };
  }, [runId, release]);

  const toggleWatch = useCallback(() => {
    if (runId === undefined) return;
    if (subscription.current !== undefined) {
      release();
      setWatch((previous) => ({ ...previous, held: false }));
      setWatchMoves((current) => current + 1);
      return;
    }
    let first = true;
    subscription.current = client.watch({
      runId,
      // Held open until the toggle is turned off or the run gives a reason to
      // stop waiting: the default condition, a surface, and no clock on it.
      timeout: "none",
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
          setWatchMoves((current) => current + 1);
        }
      },
      onError: (caught) => {
        setWatch((previous) => ({ ...previous, error: asError(caught) }));
      },
    });
    setWatch({ held: true, frames: [], ended: undefined });
  }, [client, runId, filter, release]);

  const stop = useCallback(
    (force: boolean) => client.stop(runId ?? "", force),
    [client, runId],
  );
  const adopt = useCallback(() => client.adopt(runId ?? ""), [client, runId]);

  return { status, unwatched, watch, toggleWatch, stop, adopt };
}
