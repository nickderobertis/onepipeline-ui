import type { SidebarRow } from "@onepipeline-ui/dag-model";
import { useCallback, useMemo, useState } from "react";
import { sidebarGroups } from "../../lib/sidebar-model";

/**
 * Discover open-ended kinds, resolve the project rows and their opening run, and
 * hold which projects are open: none but the selected run's, until a reader
 * opens another.
 */
export function useProjectNavigation(
  rows: readonly SidebarRow[] | undefined,
  hiddenKinds: readonly string[],
  selectedRunId: string | undefined,
  onOpenProject: (runId: string) => void,
) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expand = useCallback((key: string) => {
    setExpanded((held) => (held.has(key) ? held : new Set(held).add(key)));
  }, []);
  const toggle = useCallback((key: string) => {
    setExpanded((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const all = useMemo(() => sidebarGroups(rows ?? []), [rows]);
  // Selecting a run opens its project once; a reader may still close it after.
  const selectedKey = all.find((group) =>
    group.rows.some((row) => row.id === selectedRunId),
  )?.key;
  const [opened, setOpened] = useState<string>();
  if (selectedKey !== opened) {
    setOpened(selectedKey);
    if (selectedKey !== undefined) expand(selectedKey);
  }

  return useMemo(() => {
    const kinds = [
      ...new Set(rows?.flatMap((row) => (row.kind ? [row.kind] : [])) ?? []),
    ].sort();
    const groups = all.map((group) => {
      const runs = group.rows.filter(
        (row) => !row.kind || !hiddenKinds.includes(row.kind),
      );
      const newest = runs[0];
      return {
        key: group.key,
        label: group.label,
        runs,
        expanded: expanded.has(group.key),
        toggle: () => toggle(group.key),
        open: () => {
          expand(group.key);
          if (newest) onOpenProject(newest.id);
        },
      };
    });
    return { kinds, groups };
  }, [rows, all, hiddenKinds, expanded, expand, toggle, onOpenProject]);
}
