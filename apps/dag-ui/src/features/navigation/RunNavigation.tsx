import {
  Badge,
  Button,
  cn,
  ScrollArea,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@oneharness/ui";
import type { SidebarRow } from "@onepipeline-ui/dag-model";
import { Activity } from "lucide-react";
import { stateDotClass } from "../../lib/StateBadge";
import { rowCountSummary } from "../../lib/sidebar-model";
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
          {kinds.length > 0 && (
            <fieldset className="kind-filter">
              <legend>Run kinds</legend>
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
                  />{" "}
                  {kind}
                </label>
              ))}
            </fieldset>
          )}
          {rows === undefined ? (
            <p role="status">Loading projects…</p>
          ) : (
            groups.map((group) => {
              const visible = group.runs;
              return (
                <details
                  key={group.key}
                  open
                  aria-label={`Project ${group.label}`}
                  className="project-group"
                >
                  <summary>{group.label}</summary>
                  <Button
                    className="project-link"
                    disabled={visible.length === 0}
                    onClick={group.open}
                    variant="ghost"
                  >
                    Open {group.label}
                  </Button>
                  {visible.length === 0 && (
                    <p role="status">No runs of the shown kinds.</p>
                  )}
                  <div className="run-list">
                    {visible.map((run) => (
                      <button
                        aria-current={
                          selectedRunId === run.id ? "page" : undefined
                        }
                        className="run-link"
                        data-active={selectedRunId === run.id}
                        key={run.id}
                        onClick={() => onSelect(run.id)}
                        type="button"
                      >
                        <span className="run-link-main">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                role="img"
                                aria-label={run.state}
                                className={cn(
                                  "run-dot",
                                  stateDotClass(run.state),
                                )}
                              />
                            </TooltipTrigger>
                            <TooltipContent>{run.state}</TooltipContent>
                          </Tooltip>
                          <span>{run.name}</span>
                          {run.kind && (
                            <Badge
                              aria-label={run.kind}
                              role="note"
                              variant="outline"
                            >
                              {run.kind}
                            </Badge>
                          )}
                        </span>
                        <span className="run-link-counts">
                          {[run.state, rowCountSummary(run)]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                </details>
              );
            })
          )}
        </div>
      </ScrollArea>
    </nav>
  );
}
