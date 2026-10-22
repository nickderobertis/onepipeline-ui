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
import type { ProjectGroup } from "@onepipeline-ui/dag-model";
import { Activity } from "lucide-react";
import { nodeCountSummary } from "../../lib/run-model";
import { stateDotClass } from "../../lib/StateBadge";
import { useProjectNavigation } from "./useProjectNavigation";

/** One project list, with kinds discovered from the engine's effective labels. */
export function RunNavigation({
  projects,
  selectedRunId,
  onSelect,
  onHost,
  hiddenKinds,
  onKindsChange,
}: {
  readonly projects?: readonly ProjectGroup[];
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string) => void;
  readonly onHost: () => void;
  readonly hiddenKinds: readonly string[];
  readonly onKindsChange: (kinds: readonly string[]) => void;
}) {
  const { kinds, groups } = useProjectNavigation(
    projects,
    hiddenKinds,
    onSelect,
  );
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
          <Button onClick={onHost} variant="ghost">
            Host
          </Button>
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
          {projects === undefined ? (
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
                          selectedRunId === run.run_id ? "page" : undefined
                        }
                        className="run-link"
                        data-active={selectedRunId === run.run_id}
                        key={run.run_id}
                        onClick={() => onSelect(run.run_id)}
                        type="button"
                      >
                        <span className="run-link-main">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                role="img"
                                aria-label={run.activityLabel}
                                className={cn(
                                  "run-dot",
                                  stateDotClass(run.state),
                                )}
                              />
                            </TooltipTrigger>
                            <TooltipContent>{run.activityLabel}</TooltipContent>
                          </Tooltip>
                          <span>{run.run_id}</span>
                          {run.labels?.kind && (
                            <Badge
                              aria-label={run.labels.kind}
                              role="note"
                              variant="outline"
                            >
                              {run.labels.kind}
                            </Badge>
                          )}
                        </span>
                        <span className="run-link-counts">
                          {[run.state, nodeCountSummary(run.node_counts)]
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
