import { Button, cn, ScrollArea, Separator } from "@oneharness/ui";
import type { SidebarRow } from "@onepipeline-ui/dag-model";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, type Ref, useRef } from "react";
import { stateDotClass } from "../../lib/StateBadge";
import { rowCountSummary } from "../../lib/sidebar-model";
import { useProjectNavigation } from "./useProjectNavigation";
import { ROW_KEY_ATTRIBUTE, useRowMotion } from "./useRowMotion";

/** One project list, with kinds discovered from the engine's effective labels. */
export function RunNavigation({
  rows,
  selectedRunId,
  onSelect,
  onOpenProject,
  onHost,
  hostCurrent = false,
  onActionItems,
  actionItemsCurrent = false,
  hiddenKinds,
  onKindsChange,
  updates,
  drawerOpen = false,
  drawerRef,
}: {
  /** The navigation's copy of the sidebar's rows, taken as its setting says. */
  readonly rows?: readonly SidebarRow[];
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string) => void;
  /** A project row's choice of its newest shown run, which leaves its runs in reach. */
  readonly onOpenProject?: (runId: string) => void;
  readonly onHost: () => void;
  /** Whether the Host page is the one on screen. */
  readonly hostCurrent?: boolean;
  /** Open the action-items page, a view of its own beside the Host page. */
  readonly onActionItems?: () => void;
  readonly actionItemsCurrent?: boolean;
  readonly hiddenKinds: readonly string[];
  readonly onKindsChange: (kinds: readonly string[]) => void;
  /** The navigation's own update setting, under the kinds. */
  readonly updates?: ReactNode;
  /** Whether this is open over the page, where it is a drawer. */
  readonly drawerOpen?: boolean;
  readonly drawerRef?: Ref<HTMLElement>;
}) {
  const { kinds, groups } = useProjectNavigation(
    rows,
    hiddenKinds,
    selectedRunId,
    onOpenProject ?? onSelect,
  );
  const list = useRef<HTMLDivElement>(null);
  useRowMotion(list, groups);
  return (
    <nav
      aria-label="Projects"
      className="run-nav"
      data-open={drawerOpen}
      id="run-navigation"
      ref={drawerRef}
    >
      <ScrollArea className="h-full">
        <div className="px-[18px] py-6 max-sm:px-2">
          <div className="brand">
            <div aria-hidden="true" className="brand-mark">
              <Activity size={20} />
            </div>
            <div>
              <p className="eyebrow">Local orchestration</p>
              <h1>DAG Observatory</h1>
            </div>
          </div>
          <Separator className="my-[22px]" />
          <div className="nav-pages">
            <Button
              aria-current={hostCurrent ? "page" : undefined}
              onClick={onHost}
              variant="ghost"
            >
              Host
            </Button>
            {onActionItems && (
              <Button
                aria-current={actionItemsCurrent ? "page" : undefined}
                onClick={onActionItems}
                variant="ghost"
              >
                Action items
              </Button>
            )}
          </div>
          {/* In flow rather than a popup: `.run-nav` clips what leaves it. */}
          {kinds.length > 0 && (
            <details className="kind-filter">
              <summary>
                <span>
                  Run kinds:{" "}
                  {kinds.filter((k) => !hiddenKinds.includes(k)).length} of{" "}
                  {kinds.length}
                </span>
                <ChevronDown aria-hidden="true" size={14} />
              </summary>
              <fieldset>
                <legend className="sr-only">Run kinds</legend>
                {kinds.map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={!hiddenKinds.includes(kind)}
                      onChange={(event) =>
                        onKindsChange(
                          event.target.checked
                            ? hiddenKinds.filter((value) => value !== kind)
                            : [...hiddenKinds, kind],
                        )
                      }
                    />
                    {kind}
                  </label>
                ))}
              </fieldset>
            </details>
          )}
          {updates}
          {rows === undefined ? (
            <p role="status">Loading projects…</p>
          ) : (
            <div className="nav-rows" ref={list}>
              {groups.map((group) => (
                <section
                  key={group.key}
                  aria-label={`Project ${group.label}`}
                  className="project-group"
                  role="group"
                >
                  <div
                    className="project-row"
                    {...{ [ROW_KEY_ATTRIBUTE]: `project:${group.key}` }}
                  >
                    <button
                      aria-expanded={group.expanded}
                      aria-label={`${group.expanded ? "Collapse" : "Expand"} ${group.label}`}
                      className="project-toggle"
                      onClick={group.toggle}
                      type="button"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        data-open={group.expanded}
                        size={12}
                      />
                    </button>
                    <button
                      className="project-open"
                      onClick={group.open}
                      type="button"
                    >
                      <span className="project-name">{group.label}</span>
                      <span className="project-count">
                        {group.runs.length}
                        <span className="sr-only"> shown runs</span>
                      </span>
                    </button>
                  </div>
                  {group.expanded && group.runs.length === 0 && (
                    <p className="run-list-status" role="status">
                      No runs of the shown kinds.
                    </p>
                  )}
                  {group.expanded &&
                    group.runs.map((run) => {
                      const selected = selectedRunId === run.id;
                      const reading = [run.state, rowCountSummary(run)]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <button
                          aria-current={selected ? "page" : undefined}
                          className="run-link"
                          data-active={selected}
                          key={run.id}
                          onClick={() => onSelect(run.id)}
                          title={reading}
                          type="button"
                          {...{ [ROW_KEY_ATTRIBUTE]: `run:${run.id}` }}
                        >
                          <span
                            role="img"
                            aria-label={run.state}
                            className={cn("run-dot", stateDotClass(run.state))}
                          />
                          <span className="run-link-name">{run.name}</span>
                          {run.kind && (
                            <span
                              aria-label={run.kind}
                              className="run-link-tag"
                              role="note"
                            >
                              {run.kind}
                            </span>
                          )}
                          {selected && (
                            <span className="run-link-counts">{reading}</span>
                          )}
                        </button>
                      );
                    })}
                </section>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </nav>
  );
}
