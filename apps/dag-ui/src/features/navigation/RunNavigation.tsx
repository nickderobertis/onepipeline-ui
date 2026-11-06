import { Button, cn, ScrollArea, Separator } from "@oneharness/ui";
import type { SidebarRow } from "@onepipeline-ui/dag-model";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { stateDotClass } from "../../lib/StateBadge";
import { rowCountSummary } from "../../lib/sidebar-model";
import { UpdateSetting } from "../../spike/UpdateSetting";
import { useProjectNavigation } from "./useProjectNavigation";

/** One project list, with kinds discovered from the engine's effective labels. */
export function RunNavigation({
  rows,
  selectedRunId,
  onSelect,
  onHost,
  hostCurrent = false,
  onActionItems,
  actionItemsCurrent = false,
  hiddenKinds,
  onKindsChange,
}: {
  /** The sidebar's trimmed rows, as the subscription holds them. */
  readonly rows?: readonly SidebarRow[];
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string) => void;
  readonly onHost: () => void;
  /** Whether the Host page is the one on screen. */
  readonly hostCurrent?: boolean;
  /** Open the action-items page, a view of its own beside the Host page. */
  readonly onActionItems?: () => void;
  readonly actionItemsCurrent?: boolean;
  readonly hiddenKinds: readonly string[];
  readonly onKindsChange: (kinds: readonly string[]) => void;
}) {
  const { kinds, groups } = useProjectNavigation(rows, hiddenKinds, onSelect);
  return (
    <nav aria-label="Projects" className="run-nav">
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
          <div className="spike-nav-links">
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
          {kinds.length > 0 && (
            <details className="spike-kinds">
              <summary>
                <span>
                  Run kinds: {kinds.length - hiddenKinds.length} of{" "}
                  {kinds.length}
                </span>
                <ChevronDown aria-hidden="true" size={14} />
              </summary>
              <div>
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
              </div>
            </details>
          )}
          <div className="spike-nav-update">
            <UpdateSetting
              initial="interval"
              intervalWaiting={3}
              label="Navigation updates"
              offWaiting={3}
            />
          </div>
          <Separator className="my-[10px]" />
          {rows === undefined ? (
            <p role="status">Loading projects…</p>
          ) : (
            groups.map((group) => {
              const visible = group.runs;
              const holdsSelected = visible.some(
                (run) => run.id === selectedRunId,
              );
              return (
                <details
                  key={group.key}
                  open={holdsSelected}
                  aria-label={`Project ${group.label}`}
                  className="spike-project"
                >
                  <summary>
                    <ChevronRight aria-hidden="true" size={12} />
                    <span>{group.label}</span>
                    <span className="spike-project-count">
                      {visible.length}
                    </span>
                  </summary>
                  {visible.map((run) => (
                    <button
                      aria-current={
                        selectedRunId === run.id ? "page" : undefined
                      }
                      className="spike-row"
                      data-active={selectedRunId === run.id}
                      key={run.id}
                      onClick={() => onSelect(run.id)}
                      title={[run.state, rowCountSummary(run)]
                        .filter(Boolean)
                        .join(" · ")}
                      type="button"
                    >
                      <span
                        role="img"
                        aria-label={run.state}
                        className={cn("run-dot", stateDotClass(run.state))}
                      />
                      <span className="spike-row-name">{run.name}</span>
                      {run.kind && (
                        <span className="spike-row-tag">{run.kind}</span>
                      )}
                    </button>
                  ))}
                </details>
              );
            })
          )}
        </div>
      </ScrollArea>
    </nav>
  );
}
