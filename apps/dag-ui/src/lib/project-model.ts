import type { ProjectGroup, RunSummary } from "@onepipeline-ui/dag-model";
import { NO_PROJECT_KEY } from "./useUrlSelection";

/** The words the server groups runs by, read for a heading. */
export const NO_PROJECT_LABEL = "(no project)";

/**
 * What a group is called: the plan's name where one was recorded, else its id —
 * and the `(no project)` group by that word, whatever plan name its newest run
 * recorded, because a name there is the name of one run's plan and not of a
 * project. The CLI heads that group the same way.
 */
export function projectLabel(group: ProjectGroup): string {
  if (group.project === null) return NO_PROJECT_LABEL;
  return group.name ?? group.project;
}

/**
 * The line under a group's name: its qualified id for a project, and the plan
 * name of its newest run for the group that has no id.
 */
export function projectDetailLine(group: ProjectGroup): string | undefined {
  if (group.project === null) return group.name ?? undefined;
  return group.name === null ? undefined : group.project;
}

/**
 * How the address spells a group: its id, or the word the address keeps for the
 * group that has none.
 */
export function projectKeyOf(group: ProjectGroup): string {
  return group.project ?? NO_PROJECT_KEY;
}

/** The group an address key names, in a served list. */
export function groupForKey(
  groups: readonly ProjectGroup[],
  key: string,
): ProjectGroup | undefined {
  return groups.find((group) => projectKeyOf(group) === key);
}

/**
 * A compact reading of a group's runs, by the state word each row serves:
 * `2 active · 1 settled`.
 *
 * Counted over the rows the server served and in the server's own words — a run's
 * `state` is the engine's settlement — so this line and the page it opens cannot
 * describe different runs. Ordered by first appearance, which is the group's own
 * order: the newest activity's state leads.
 */
export function runStateSummary(runs: readonly RunSummary[]): string {
  const counts = new Map<string, number>();
  for (const run of runs)
    counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`).join(" · ");
}

/** A count of runs, in words: `1 run`, `12 runs`. */
export function runCount(runs: readonly RunSummary[]): string {
  return `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
}
