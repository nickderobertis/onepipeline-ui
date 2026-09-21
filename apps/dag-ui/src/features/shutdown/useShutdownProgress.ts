import type { RunSummary } from "@onepipeline-ui/dag-model";
import { useEffect, useRef, useState } from "react";
import {
  progressOf,
  type RunProgress,
  type SentShutdown,
  SHUTDOWN_RECORDS,
} from "./shutdown-model";

/** How often the in-flight clock is read again, in milliseconds. */
const TICK_MS = 1000;

/**
 * Where a request that is out stands: the clock, read again every second; the
 * grace's deadline and whether anything was asked at all; and what the runs in
 * scope have recorded of this shutdown on the live listing, `done` counting the
 * ones that recorded being put down.
 */
export function useShutdownProgress(
  sent: SentShutdown,
  rows: readonly RunSummary[],
): {
  readonly now: number;
  readonly progress: readonly RunProgress[];
  readonly done: number;
  readonly deadline: number;
  readonly asks: boolean;
} {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // The rows as they stood when the request went, so an earlier shutdown's
  // record on a run is not read as this one's progress.
  const before = useRef(
    new Map(
      rows
        .filter((row) => sent.runs.some(({ runId }) => runId === row.run_id))
        .map((row) => [row.run_id, row]),
    ),
  );
  const progress = progressOf(sent, before.current, rows);
  return {
    now,
    progress,
    done: progress.filter(
      ({ recorded }) => recorded === SHUTDOWN_RECORDS.hostShutdown,
    ).length,
    deadline: sent.sentAt + sent.grace * 1000,
    asks: !sent.force && sent.grace > 0,
  };
}
