// llmlint: ignore-file[stateful_logic_extracted_to_hooks] this app was copied whole from
// the repository it was written in, and its implementation is the spec — see
// apps/dag-ui/AGENTS.md. Its effects and subscriptions sit beside render because that is
// where they were written; lifting them into hooks would be rewriting behaviour this
// repository imported precisely so as not to reimplement it, with nothing but the copied
// journeys to catch what moved. The two hooks it does have — useConversation and
// useStickyBottom — are the ones that were extracted upstream.
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TooltipProvider,
} from "@oneharness/ui";
import { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import {
  ArrowLeft,
  BookOpenText,
  Eye,
  Inbox,
  RefreshCw,
  Route,
  Satellite,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { ChannelView } from "../features/control/ChannelView";
import { ReadsView } from "../features/control/ReadsView";
import { RunActions } from "../features/control/RunActions";
import { useRunControl } from "../features/control/useRunControl";
import { WatchView } from "../features/control/WatchView";
import { DagGraph } from "../features/graph/DagGraph";
import { RunNavigation } from "../features/navigation/RunNavigation";
import { ProjectPage, ProjectsLanding } from "../features/projects/ProjectPage";
import { groupForKey, projectLabel } from "../features/projects/project-model";
import { useProject, useProjects } from "../features/projects/useProjects";
import { useDagTelemetry } from "../features/runs/useDagTelemetry";
import { NodeTimelineView } from "../features/timeline/NodeTimelineView";
import { OverallView } from "../features/timeline/OverallView";
import { TimelinePopoverLayer } from "../features/timeline/TimelinePopover";
import { graphOf, nodeViews } from "../lib/run-model";
import { Timestamp } from "../lib/Timestamp";
import {
  DETAIL_LEVELS,
  type DetailLevel,
  isRunView,
  useUrlSelection,
} from "../lib/useUrlSelection";

const defaultClient = new TelemetryClient(window.location.origin, {
  fetch: window.fetch.bind(window),
});

/**
 * The two readings, in the order they are offered: the narrow one first, because
 * it is the one a reader reaches for when there is too much to read.
 *
 * `Object.entries` widens the key to `string`, which would make the click handler
 * take a level this app has no profile for — so the pairs are typed back to the
 * union they came from, once, here.
 */
const detailLevels = Object.entries(DETAIL_LEVELS) as [
  DetailLevel,
  (typeof DETAIL_LEVELS)[DetailLevel],
][];

export function App({
  client = defaultClient,
}: {
  readonly client?: TelemetryClient;
}) {
  const selection = useUrlSelection();
  const timelineScope = useMemo(
    () =>
      selection.view === "overall"
        ? {}
        : selection.nodeId === undefined
          ? undefined
          : { nodeId: selection.nodeId },
    [selection.view, selection.nodeId],
  );
  // The reading the viewer asked for, as the filter profile the server names it
  // by. Every read this app takes goes through it, so the graph, the timeline and
  // the live stream can never be showing three different slices of one run.
  const filter = DETAIL_LEVELS[selection.detail].profile;
  const telemetry = useDagTelemetry(
    client,
    selection.runId,
    timelineScope,
    filter,
    // Under the flat list an address naming no run opens the first served; on
    // the projects it opens the project list.
    selection.list === "runs",
  );
  // The order is the server's — most recent activity first — and is never
  // recomputed here.
  const runs = telemetry.list?.runs ?? [];
  const selectedRunId = telemetry.runId;
  const detail = telemetry.detail;
  const nodes = useMemo(() => (detail ? nodeViews(detail) : []), [detail]);
  const projects = useProjects(
    client,
    telemetry.invalidations,
    selection.list === "projects",
  );
  // The page is read only while it is the thing on screen: a run opened from
  // it is the run's own reads, with the page one step back.
  const project = useProject(
    client,
    selectedRunId === undefined ? selection.projectKey : undefined,
    telemetry.invalidations,
  );
  const openedProject =
    selection.projectKey === undefined
      ? undefined
      : (project.group ??
        groupForKey(projects.list?.projects ?? [], selection.projectKey));
  const control = useRunControl(
    client,
    selectedRunId,
    filter,
    telemetry.invalidations,
  );
  const graph = detail === undefined ? undefined : graphOf(detail);
  const selectedNode = nodes.find(({ id }) => id === selection.nodeId);
  const liveRunIds = useMemo(
    () =>
      new Set(
        (telemetry.list?.runs ?? [])
          .filter(
            ({ state }) => !["complete", "failed", "cancelled"].includes(state),
          )
          .map(({ run_id }) => run_id),
      ),
    [telemetry.list],
  );

  useEffect(() => {
    if (selectedRunId && selection.runId && selection.runId !== selectedRunId) {
      const params = new URLSearchParams(window.location.search);
      params.set("run", selectedRunId);
      params.delete("node");
      params.delete("event");
      // The bookmarked node belonged to a run nobody is serving, but the reading it
      // was written for survives the fallback: an address that named one is rewritten
      // to that run's graph, not to the view an address naming nothing lands on.
      params.set("view", selection.view);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [selection.runId, selectedRunId, selection.view]);

  return (
    <TooltipProvider>
      <TimelinePopoverLayer />
      <div className="app-shell">
        <RunNavigation
          list={selection.list}
          onSelectList={selection.selectList}
          projects={projects.list?.projects}
          selectedProjectKey={selection.projectKey}
          onSelectProject={selection.selectProject}
          runs={runs}
          selectedRunId={selectedRunId}
          liveRunIds={liveRunIds}
          hasMore={telemetry.hasMore}
          loadingMore={telemetry.loadingMore}
          onLoadMore={telemetry.loadMore}
          onSelect={selection.selectRun}
        />
        <main className="workspace">
          <header className="topbar">
            <div className="topbar-title">
              {/* The way back to the project a run was opened from, where it was. */}
              {selection.projectKey !== undefined && selectedRunId && (
                <Button
                  aria-label={`Back to ${openedProject ? projectLabel(openedProject) : "the project"}`}
                  className="topbar-back"
                  onClick={() => selection.selectProject(selection.projectKey)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ArrowLeft size={14} />
                  {openedProject ? projectLabel(openedProject) : "Project"}
                </Button>
              )}
              <div>
                <p className="eyebrow">Execution telemetry</p>
                <h2>
                  {selectedRunId ??
                    (selection.projectKey !== undefined
                      ? ((openedProject && projectLabel(openedProject)) ??
                        selection.projectKey)
                      : selection.list === "projects"
                        ? "Projects"
                        : "No DAG selected")}
                </h2>
              </div>
            </div>
            <div className="topbar-actions">
              {selectedRunId !== undefined && (
                <RunActions control={control} runId={selectedRunId} />
              )}
              <span className="connection">
                <Satellite size={15} />
                {telemetry.lastUpdated === undefined ? (
                  "Waiting for first update"
                ) : (
                  <>
                    Last updated{" "}
                    <Timestamp at={telemetry.lastUpdated} relative />
                  </>
                )}
              </span>
              {telemetry.activity.at(-1) !== undefined && (
                <span className="connection" aria-live="polite">
                  {telemetry.activity.at(-1)?.node}:{" "}
                  {[
                    telemetry.activity.at(-1)?.name,
                    telemetry.activity.at(-1)?.detail,
                  ]
                    .filter(Boolean)
                    .join(" ") || telemetry.activity.at(-1)?.kind}
                </span>
              )}
              <Button
                onClick={() => void telemetry.refresh()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw size={14} /> Refresh
              </Button>
            </div>
          </header>
          {telemetry.error && (
            // `Alert` carries `role="alert"` itself, so the banner keeps announcing
            // itself the moment a read fails.
            <Alert
              className="rounded-none border-x-0 border-t-0"
              variant="destructive"
            >
              <TriangleAlert />
              <AlertTitle>Live telemetry issue</AlertTitle>
              <AlertDescription>{telemetry.error.message}</AlertDescription>
            </Alert>
          )}
          {selectedRunId === undefined && selection.projectKey !== undefined ? (
            <ProjectPage
              error={project.error}
              group={openedProject}
              loading={project.loading && openedProject === undefined}
              onSelectRun={selection.selectRun}
              projectKey={selection.projectKey}
            />
          ) : selectedRunId === undefined &&
            selection.list === "projects" &&
            !telemetry.loading ? (
            <ProjectsLanding
              error={projects.error}
              groups={projects.list?.projects}
              onSelect={selection.selectProject}
            />
          ) : (
            <Tabs
              className="min-h-0 flex-1 gap-0"
              onValueChange={(value) =>
                value === "overall"
                  ? selection.showOverall()
                  : value === "graph"
                    ? selection.selectNode(undefined)
                    : isRunView(value)
                      ? selection.selectView(value)
                      : undefined
              }
              value={selection.view}
            >
              <div className="view-tabs">
                <TabsList aria-label="DAG views" variant="line">
                  <TabsTrigger value="graph">
                    <Workflow size={15} /> Graph
                  </TabsTrigger>
                  <TabsTrigger value="overall">
                    <Route size={15} /> Overall
                  </TabsTrigger>
                  <TabsTrigger value="channel">
                    <Inbox size={15} /> Channel
                  </TabsTrigger>
                  <TabsTrigger value="watch">
                    <Eye size={15} /> Watch
                  </TabsTrigger>
                  <TabsTrigger value="reads">
                    <BookOpenText size={15} /> Reads
                  </TabsTrigger>
                </TabsList>
                {/* How much of what the run recorded this reading carries. Beside
                  the views rather than in the toolbar: it selects a reading, like
                  they do, and the toolbar is a fixed-height row the timeline
                  region's own share of the window is measured against. */}
                <fieldset className="detail-switch">
                  <legend className="sr-only">Level of detail</legend>
                  {detailLevels.map(([level, { label, description }]) => (
                    <Button
                      aria-pressed={selection.detail === level}
                      key={level}
                      onClick={() => selection.selectDetail(level)}
                      size="sm"
                      title={description}
                      type="button"
                      variant={
                        selection.detail === level ? "default" : "outline"
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </fieldset>
              </div>
              {/* One content region for whichever view is selected: the other tab's
                panel is unmounted by the primitive, exactly as it is for any tab set. */}
              <TabsContent className="min-h-0" value={selection.view}>
                {/* A run is selected but its detail has not arrived yet — still loading. The
                  empty state means the server serves no run at all, so it is reached only
                  once the list is known and holds none. */}
                {!detail &&
                (telemetry.loading || selectedRunId !== undefined) ? (
                  <div aria-live="polite" className="loading-state">
                    <Skeleton className="h-2 w-48" />
                    <Skeleton className="h-2 w-32" />
                    Loading execution history…
                  </div>
                ) : detail && selectedRunId ? (
                  selection.view === "channel" ? (
                    <ChannelView
                      client={client}
                      decisions={graph?.decisions ?? []}
                      filter={filter}
                      invalidations={telemetry.invalidations}
                      observedAt={detail.observed_at}
                      runId={selectedRunId}
                    />
                  ) : selection.view === "watch" ? (
                    <WatchView
                      onToggle={control.toggleWatch}
                      runId={selectedRunId}
                      watch={control.watch}
                    />
                  ) : selection.view === "reads" ? (
                    <ReadsView
                      client={client}
                      invalidations={telemetry.invalidations}
                      nodes={nodes}
                      runId={selectedRunId}
                      status={control.status}
                    />
                  ) : selection.view === "overall" ? (
                    <OverallView
                      client={client}
                      detail={detail}
                      nodes={nodes}
                      timeline={telemetry.timeline}
                      timelineError={telemetry.timelineError}
                      onSelectNode={selection.selectNode}
                      onSelectItem={selection.selectItem}
                      selectedItemId={selection.itemId}
                    />
                  ) : selectedNode ? (
                    // Opening a node hands it the whole working area: the graph stays
                    // one breadcrumb away rather than one narrow column beside it.
                    <NodeTimelineView
                      client={client}
                      node={selectedNode}
                      onBack={() => selection.selectNode(undefined)}
                      onSelectItem={selection.selectItem}
                      runId={selectedRunId}
                      selectedItemId={selection.itemId}
                      selectedTab={selection.nodeTab}
                      onSelectTab={selection.selectNodeTab}
                      timeline={telemetry.timeline}
                      timelineError={telemetry.timelineError}
                    />
                  ) : (
                    <DagGraph
                      nodes={nodes}
                      selectedNodeId={selection.nodeId}
                      onSelectNode={selection.selectNode}
                    />
                  )
                ) : (
                  <div className="empty-state">
                    <Workflow size={34} />
                    <h2>No DAG runs found</h2>
                    <p>Start an orchestrated run to see it appear here.</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
