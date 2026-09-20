// llmlint: ignore-file[stateful_logic_extracted_to_hooks] this app was copied whole from
// the repository it was written in, and its implementation is the spec — see
// apps/dag-ui/AGENTS.md. Its effects and subscriptions sit beside render because that is
// where they were written; lifting them into hooks would be rewriting behaviour this
// repository imported precisely so as not to reimplement it, with nothing but the copied
// journeys to catch what moved. The two hooks it does have — useConversation and
// useStickyBottom — are the ones that were extracted upstream.
import {
  Button,
  cn,
  ScrollArea,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@oneharness/ui";
import type { ProjectGroup, RunSummary } from "@onepipeline-ui/dag-model";
import { Activity, Bot, ChevronRight } from "lucide-react";
import { launchLabel, nodeCountSummary } from "../../lib/run-model";
import { stateDotClass } from "../../lib/StateBadge";
import { LIST_MODES, type ListMode } from "../../lib/useUrlSelection";
import { ProjectRows } from "./ProjectRows";

/** The two lists, in the order they are offered: the landing first. */
const LIST_LABELS: Readonly<Record<ListMode, string>> = {
  projects: "Projects",
  runs: "Runs",
};

/**
 * The navigation: the projects the runs belong to, or the runs themselves, one
 * toggle apart, each in the order the server serves it — most recent activity
 * first.
 *
 * The projects are what the app opens on, because a manager reads a host by the
 * plan each run was launched against; the flat list stays one toggle away for
 * the reader who wants every run in one order. The run rows are one flat list,
 * and deliberately so: they used to be gathered into a section per launching
 * session, which broke the one ordering that matters into sections — so the run
 * an operator came to look at was not at the top, and on a host with thirty-node
 * graphs it was often not on the first page at all. The session is a tag on the
 * row instead: the same fact, without a grouping that outranks time. A project
 * *is* a grouping that outranks time, which is why it is a list of its own rather
 * than sections of this one.
 *
 * The ordering is the server's and is not recomputed here.
 */
export function RunNavigation({
  list,
  onSelectList,
  projects,
  selectedProjectKey,
  onSelectProject,
  runs,
  selectedRunId,
  liveRunIds,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  readonly list: ListMode;
  readonly onSelectList: (list: ListMode) => void;
  readonly projects?: readonly ProjectGroup[];
  readonly selectedProjectKey?: string;
  readonly onSelectProject: (projectKey: string) => void;
  readonly runs: readonly RunSummary[];
  readonly selectedRunId?: string;
  readonly liveRunIds: ReadonlySet<string>;
  readonly onSelect: (runId: string) => void;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => Promise<void>;
}) {
  return (
    <nav
      aria-label={list === "runs" ? "DAG runs" : "Projects"}
      className="run-nav"
      onScrollCapture={(event) => {
        // React exposes EventTarget here although this handler can only receive a
        // scroll event from an HTMLElement inside the navigation subtree.
        const target = event.target as HTMLElement;
        if (
          hasMore &&
          target.scrollHeight - target.scrollTop <= target.clientHeight + 80
        )
          void onLoadMore();
      }}
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
          {/* Which list, as one control rather than two loose buttons, on the
              terms the reading switch keeps: a fieldset says the pair is a
              choice and the pressed state says which is taken. */}
          <fieldset className="detail-switch list-switch">
            <legend className="sr-only">Which list</legend>
            {Object.values(LIST_MODES).map((mode) => (
              <Button
                aria-pressed={list === mode}
                key={mode}
                onClick={() => onSelectList(mode)}
                size="sm"
                type="button"
                variant={list === mode ? "default" : "outline"}
              >
                {LIST_LABELS[mode]}
              </Button>
            ))}
          </fieldset>
          {list === "projects" ? (
            projects === undefined ? (
              <p aria-live="polite" className="run-list-status">
                Loading projects…
              </p>
            ) : (
              <ProjectRows
                groups={projects}
                onSelect={onSelectProject}
                selectedKey={selectedProjectKey}
              />
            )
          ) : (
            <div className="run-list">
              {runs.map((run) => {
                const active = selectedRunId === run.run_id;
                const live = liveRunIds.has(run.run_id);
                const counts = nodeCountSummary(run.node_counts);
                return (
                  <button
                    aria-current={active ? "page" : undefined}
                    className="run-link"
                    data-active={active}
                    key={run.run_id}
                    onClick={() => onSelect(run.run_id)}
                    type="button"
                  >
                    <span className="run-link-main">
                      {/* The row's one mark, and it carries two readings: the colour
                        is the run's own state, and the name is whether the run is
                        still moving. Neither is left to colour alone — the state is
                        spelled out on the line below, and the mark keeps a name of
                        its own rather than relying on the hover-only tooltip. */}
                      {/* Not animated, deliberately: a page of fifty rows is a page
                        of fifty still-moving runs on this host, and fifty looping
                        animations cost the browser enough to starve the graph
                        beside them. The halo is what a live mark carries. */}
                      {live ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              aria-label="Live"
                              className={cn(
                                "run-dot",
                                stateDotClass(run.state),
                              )}
                              data-live="true"
                              role="img"
                            />
                          </TooltipTrigger>
                          <TooltipContent>Live</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span
                          aria-label="Historical"
                          className={cn("run-dot", stateDotClass(run.state))}
                          role="img"
                        />
                      )}
                      <span>{run.run_id}</span>
                    </span>
                    <ChevronRight aria-hidden="true" size={14} />
                    {/* The run's own state, then its nodes in the words the graph
                      paints them with. A run row that stated only "running" said
                      nothing about the node inside it that was already blocked. */}
                    <span className="run-link-counts" title={counts}>
                      {[run.state, counts].filter(Boolean).join(" · ")}
                    </span>
                    {/* The session that launched this run, as a tag rather than a
                      heading the list is broken into. */}
                    <span className="run-link-tag">
                      <Bot aria-hidden="true" size={11} />
                      {launchLabel(run.launch)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {list === "runs" && hasMore && (
            <>
              <button
                className="sr-only"
                onClick={() => void onLoadMore()}
                type="button"
              >
                Load more runs
              </button>
              {/* Reaching the end of the list is what asks for the next page, so
                  the end of the list is where that has to be said: without it a
                  reader who scrolled to the bottom saw a list that had simply
                  stopped. */}
              <p aria-live="polite" className="run-list-status">
                {loadingMore ? "Loading more runs…" : ""}
              </p>
            </>
          )}
        </div>
      </ScrollArea>
    </nav>
  );
}
