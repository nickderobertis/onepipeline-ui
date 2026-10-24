import { useEffect, useState } from "react";
import { formatDuration, parseTimestamp } from "../../lib/time";

/** The runtime is shown to the second, so it need not be re-read faster. */
const TICK_MS = 1_000;

/**
 * How long one remote check took, read off the producer's own two stamps and
 * nothing else — the `started_at` and `completed_at` the `change-check` record
 * carried, never when the journal observed it.
 *
 * Finished: the difference between the two. Running — started and not completed:
 * the time since it started, counting while it is on screen, labelled `running`
 * so it is never read as a finished run's length. Queued — no start: nothing,
 * because no runtime exists yet and a zero would claim one did.
 */
export function CheckRuntime({
  completedAt,
  startedAt,
}: {
  readonly completedAt?: string;
  readonly startedAt?: string;
}) {
  const started =
    startedAt === undefined ? undefined : parseTimestamp(startedAt);
  const completed =
    completedAt === undefined ? undefined : parseTimestamp(completedAt);
  const running = started !== undefined && completed === undefined;
  const now = useNow(running);
  if (started === undefined) return null;
  if (completed !== undefined)
    return <>{formatDuration(completed.getTime() - started.getTime())}</>;
  return <>{formatDuration(now - started.getTime())} · running</>;
}

/**
 * The current time, kept moving only while something on screen counts from it,
 * so a table of finished checks holds no timer at all.
 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
