import type { SidebarRow } from "@onepipeline-ui/dag-model";
import { nodeCountSummary } from "./run-model";
import { NO_PROJECT_KEY } from "./useUrlSelection";

/** One project of the sidebar, derived from the trimmed rows a subscription pushes. */
export interface SidebarGroup {
  /** How the address names it: the qualified project id, or the no-project key. */
  readonly key: string;
  readonly project: string | null;
  /** The plan name recorded for it, falling back to its id; `Other runs` for none. */
  readonly label: string;
  /** Its runs, newest launch first. */
  readonly rows: readonly SidebarRow[];
  /** The latest activity any of its runs recorded. */
  readonly updatedAt: string;
}

/**
 * A project's runs by launch time, newest first; undated launches follow dated
 * ones, ordered by last activity — so a late write to an older run does not
 * select it over a newer launch (`docs/contract.md`).
 */
export function newestRows(rows: readonly SidebarRow[]): SidebarRow[] {
  return [...rows].sort((left, right) => {
    const a = left.started_at;
    const b = right.started_at;
    if (a !== undefined && b === undefined) return -1;
    if (a === undefined && b !== undefined) return 1;
    return (
      (b === undefined ? 0 : Date.parse(b)) -
        (a === undefined ? 0 : Date.parse(a)) ||
      Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
      left.id.localeCompare(right.id)
    );
  });
}

/**
 * The rows grouped by project: projects with an id by latest activity, newest
 * first, and the runs with none after them as one group.
 */
export function sidebarGroups(rows: readonly SidebarRow[]): SidebarGroup[] {
  const groups = new Map<string, SidebarRow[]>();
  for (const row of rows) {
    const key = row.group?.project ?? NO_PROJECT_KEY;
    const held = groups.get(key);
    if (held === undefined) groups.set(key, [row]);
    else held.push(row);
  }
  const all = [...groups].map(([key, members]): SidebarGroup => {
    const ordered = newestRows(members);
    const project = members[0]?.group?.project ?? null;
    const updatedAt = members
      .map((row) => row.updated_at)
      .reduce((latest, at) =>
        Date.parse(at) > Date.parse(latest) ? at : latest,
      );
    return {
      key,
      project,
      label:
        project === null
          ? "Other runs"
          : (ordered.find((row) => row.group?.name)?.group?.name ?? project),
      rows: ordered,
      updatedAt,
    };
  });
  return all.sort(
    (left, right) =>
      Number(left.project === null) - Number(right.project === null) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.key.localeCompare(right.key),
  );
}

/** A row's node counts in words, as the sidebar shows them: `2 done · 1 running`. */
export function rowCountSummary(row: SidebarRow): string {
  const { done, failed, running } = row.nodes;
  return nodeCountSummary({ done, failed, running });
}
