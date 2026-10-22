import type { ProjectGroup } from "@onepipeline-ui/dag-model";
import { useMemo } from "react";
import {
  newestRuns,
  projectKeyOf,
  projectLabel,
} from "../../lib/project-model";

/** Discover open-ended kinds and resolve the project rows and their opening run. */
export function useProjectNavigation(
  projects: readonly ProjectGroup[] | undefined,
  hiddenKinds: readonly string[],
  onSelect: (runId: string) => void,
) {
  return useMemo(() => {
    const kinds = [
      ...new Set(
        projects?.flatMap((group) =>
          group.runs.flatMap((run) =>
            run.labels?.kind ? [run.labels.kind] : [],
          ),
        ) ?? [],
      ),
    ].sort();
    const ordered = [
      ...(projects ?? []).filter((group) => group.project !== null),
      ...(projects ?? []).filter((group) => group.project === null),
    ];
    const groups = ordered.map((group) => {
      const runs = newestRuns(group.runs).filter(
        (run) => !run.labels?.kind || !hiddenKinds.includes(run.labels.kind),
      );
      const newest = runs[0];
      return {
        key: projectKeyOf(group),
        label: group.project === null ? "Other runs" : projectLabel(group),
        runs: runs.map((run) => ({
          ...run,
          activityLabel: run.liveness ?? run.state,
        })),
        open: () => {
          if (newest) onSelect(newest.run_id);
        },
      };
    });
    return { kinds, groups };
  }, [projects, hiddenKinds, onSelect]);
}
