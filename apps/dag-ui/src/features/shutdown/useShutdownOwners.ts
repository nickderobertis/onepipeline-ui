import { useMemo } from "react";
import type { ScopedRun } from "./shutdown-model";

/** One row per owner, with all of that owner's affected runs counted. */
export function useShutdownOwners(runs: readonly ScopedRun[]) {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs)
      counts.set(run.owner, (counts.get(run.owner) ?? 0) + 1);
    return [...counts].map(([owner, count]) => ({ owner, count }));
  }, [runs]);
}
