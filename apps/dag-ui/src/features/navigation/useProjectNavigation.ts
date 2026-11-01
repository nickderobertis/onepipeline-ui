import type { SidebarRow } from "@onepipeline-ui/dag-model";
import { useMemo } from "react";
import { sidebarGroups } from "../../lib/sidebar-model";

/** Discover open-ended kinds and resolve the project rows and their opening run. */
export function useProjectNavigation(
  rows: readonly SidebarRow[] | undefined,
  hiddenKinds: readonly string[],
  onSelect: (runId: string) => void,
) {
  return useMemo(() => {
    const kinds = [
      ...new Set(rows?.flatMap((row) => (row.kind ? [row.kind] : [])) ?? []),
    ].sort();
    const groups = sidebarGroups(rows ?? []).map((group) => {
      const runs = group.rows.filter(
        (row) => !row.kind || !hiddenKinds.includes(row.kind),
      );
      const newest = runs[0];
      return {
        key: group.key,
        label: group.label,
        runs,
        open: () => {
          if (newest) onSelect(newest.id);
        },
      };
    });
    return { kinds, groups };
  }, [rows, hiddenKinds, onSelect]);
}
