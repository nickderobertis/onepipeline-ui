import type { ProjectGroup } from "@onepipeline-ui/dag-model";
import { ChevronRight, FolderKanban } from "lucide-react";
import {
  projectDetailLine,
  projectKeyOf,
  projectLabel,
  runCount,
  runStateSummary,
} from "../../lib/project-model";
import { Timestamp } from "../../lib/Timestamp";
import { isoOfMillis } from "../../lib/time";

/**
 * The projects, one row each, in the order the server serves them: newest activity
 * first, the `(no project)` group among them wherever its own recency puts it.
 *
 * Each row is the compact reading of a group — its name and qualified id, how many
 * runs, when it last wrote, and its runs' states counted — and opens the group's
 * page. It is the same shape the run rows take so the navigation reads the same
 * whichever list it is showing.
 */
export function ProjectRows({
  groups,
  selectedKey,
  onSelect,
}: {
  readonly groups: readonly ProjectGroup[];
  readonly selectedKey?: string;
  readonly onSelect: (projectKey: string) => void;
}) {
  return (
    <ul aria-label="Project rows" className="run-list project-rows">
      {groups.map((group) => {
        const key = projectKeyOf(group);
        const active = selectedKey === key;
        return (
          <li key={key}>
            <button
              aria-current={active ? "page" : undefined}
              className="run-link"
              data-active={active}
              onClick={() => onSelect(key)}
              type="button"
            >
              <span className="run-link-main">
                <FolderKanban aria-hidden="true" size={13} />
                <span>{projectLabel(group)}</span>
              </span>
              <ChevronRight aria-hidden="true" size={14} />
              {/* The qualified id under the name, so two plans called the same
                thing in two stores are still two projects here. */}
              {projectDetailLine(group) !== undefined && (
                <span
                  className="run-link-counts"
                  title={projectDetailLine(group)}
                >
                  {projectDetailLine(group)}
                </span>
              )}
              <span className="run-link-counts">
                {[runCount(group.runs), runStateSummary(group.runs)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="run-link-tag">
                {group.last_write_at === null ? (
                  "never written"
                ) : (
                  <Timestamp at={isoOfMillis(group.last_write_at)} relative />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
