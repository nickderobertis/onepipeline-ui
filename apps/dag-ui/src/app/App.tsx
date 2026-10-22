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
  Inbox,
  RefreshCw,
  Route,
  Satellite,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ChannelView } from "../features/control/ChannelView";
import { RunActions } from "../features/control/RunActions";
import { useRunControl } from "../features/control/useRunControl";
import { DagGraph } from "../features/graph/DagGraph";
import { HostPage } from "../features/host/HostPage";
import { RunNavigation } from "../features/navigation/RunNavigation";
import { useProjects } from "../features/projects/useProjects";
import { useDagTelemetry } from "../features/runs/useDagTelemetry";
import {
  HostShutdownButtons,
  useHostShutdowns,
} from "../features/shutdown/ShutdownControls";
import { ShutdownStatus } from "../features/shutdown/ShutdownStatus";
import { NodeTimelineView } from "../features/timeline/NodeTimelineView";
import { OverallView } from "../features/timeline/OverallView";
import { TimelinePopoverLayer } from "../features/timeline/TimelinePopover";
import { newestRuns } from "../lib/project-model";
import { RecordDisclosure } from "../lib/RecordDisclosure";
import {
  currentOverrides,
  graphOf,
  graphStateWord,
  launchLabel,
  nodeViews,
} from "../lib/run-model";
import { StructuredFields } from "../lib/StructuredFields";
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
    // An address naming no run opens the first one served; the Host page names
    // no run and opens none.
    !selection.host,
  );
  // The order is the server's — most recent activity first — and is never
  // recomputed here.
  const runs = telemetry.list?.runs ?? [];
  const selectedRunId = telemetry.runId;
  const lastActivity = telemetry.activity.at(-1);
  const detail = telemetry.detail;
  const nodes = useMemo(() => (detail ? nodeViews(detail) : []), [detail]);
  const [projectRefresh, setProjectRefresh] = useState(0);
  const projects = useProjects(
    client,
    telemetry.invalidations + projectRefresh,
    true,
  );
  useEffect(() => {
    if (projects.list)
      telemetry.reconcileRuns(
        projects.list.projects.flatMap((group) => group.runs),
      );
  }, [projects.list, telemetry.reconcileRuns]);
  const hostList =
    telemetry.list && projects.list
      ? {
          ...telemetry.list,
          runs: projects.list.projects.flatMap((group) => group.runs),
          next_cursor: undefined,
        }
      : telemetry.list;
  const control = useRunControl(client, selectedRunId, telemetry.invalidations);
  // Held here rather than under the run's view: a shutdown is minutes long, and
  // what it is doing stays on screen whichever run or list the reader moves to.
  const hostShutdowns = useHostShutdowns(client);
  const graph = detail === undefined ? undefined : graphOf(detail);
  const selectedNode = nodes.find(({ id }) => id === selection.nodeId);
  useEffect(() => {
    if (selection.host || !projects.list) return;
    const groups = projects.list.projects;
    const currentGroup = groups.find((group) =>
      group.runs.some((run) => run.run_id === selection.runId),
    );
    const current = currentGroup?.runs.find(
      (run) => run.run_id === selection.runId,
    );
    const candidates =
      (currentGroup ? newestRuns(currentGroup.runs) : undefined) ??
      [
        ...groups.filter((group) => group.project !== null),
        ...groups.filter((group) => group.project === null),
      ].flatMap((group) => newestRuns(group.runs));
    const visible = candidates.filter(
      (run) =>
        !run.labels?.kind || !selection.hiddenKinds.includes(run.labels.kind),
    );
    if (
      (!selection.runId ||
        (current?.labels?.kind &&
          selection.hiddenKinds.includes(current.labels.kind))) &&
      visible[0]
    )
      selection.selectRun(visible[0].run_id);
  }, [projects.list, selection]);

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
          projects={projects.list?.projects}
          selectedRunId={selectedRunId}
          onSelect={selection.selectRun}
          onHost={selection.selectHost}
          hiddenKinds={selection.hiddenKinds}
          onKindsChange={selection.selectKinds}
        />
        <main className="workspace">
          <section
            aria-label={selectedRunId ? "Run header" : "Workspace header"}
            className={`topbar${selectedRunId ? " run-topbar" : ""}`}
          >
            <div className="topbar-title">
              <div>
                <p className="eyebrow">Execution telemetry</p>
                <h2>
                  {selection.host
                    ? "Host"
                    : (selectedRunId ?? "No DAG selected")}
                </h2>
              </div>
            </div>
            <div className="topbar-actions">
              {!selection.host && selectedRunId !== undefined && (
                <RunActions
                  control={control}
                  runId={selectedRunId}
                  ended={
                    detail !== undefined &&
                    (detail.run.state === "settled" ||
                      detail.run.state.startsWith("ended-"))
                  }
                />
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
              {lastActivity !== undefined && (
                <button
                  className="last-activity connection"
                  type="button"
                  title={`${lastActivity.node}: ${[lastActivity.name, lastActivity.detail].filter(Boolean).join(" ") || lastActivity.kind}`}
                  onClick={() => {
                    selection.selectNode(lastActivity.node);
                    selection.selectItem(lastActivity.event_id);
                  }}
                >
                  {lastActivity.node}:{" "}
                  {[lastActivity.name, lastActivity.detail]
                    .filter(Boolean)
                    .join(" ") || lastActivity.kind}
                </button>
              )}
              <Button
                onClick={() => {
                  setProjectRefresh((value) => value + 1);
                  void telemetry.refresh();
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw size={14} /> Refresh
              </Button>
            </div>
          </section>
          {!selection.host && detail && (
            <RecordDisclosure
              label="Run details"
              className="run-header-details"
            >
              <p>Launching session: {launchLabel(detail.launch)}</p>
              {/* A reading already shown stays beside this, so a failed re-read
                  says the figures below are the last ones served. */}
              {control.status.error && (
                <p role="alert">
                  Status unavailable: {control.status.error.message}
                </p>
              )}
              {control.status.value && (
                <dl>
                  <dt>Summary</dt>
                  <dd>{control.status.value.summary}</dd>
                  <dt>Graph state</dt>
                  <dd>{graphStateWord(control.status.value.node_status)}</dd>
                  <dt>Unread surfaces</dt>
                  <dd>{control.status.value.unread_surfaces.count}</dd>
                  <dt>Oldest unread (seconds)</dt>
                  <dd>
                    {control.status.value.unread_surfaces.oldest_seconds ??
                      "None"}
                  </dd>
                  {/* How long the run's journal has been quiet: the age Status
                      gave a parked driver, read off the run's own last write. */}
                  <dt>Last progress</dt>
                  <dd>
                    {detail.run.last_progress_at === undefined ? (
                      "Not recorded"
                    ) : (
                      <Timestamp
                        at={new Date(
                          detail.run.last_progress_at * 1000,
                        ).toISOString()}
                        relative
                      />
                    )}
                  </dd>
                </dl>
              )}
              {control.status.value && (
                <section aria-label="Node statuses">
                  <StructuredFields value={control.status.value.node_status} />
                </section>
              )}
            </RecordDisclosure>
          )}
          {telemetry.error && (
            // `Alert` carries `role="alert"` itself, so the banner keeps announcing
            // itself the moment a read fails.
            <Alert
              className="rounded-none border-x-0 border-t-0"
              variant="destructive"
            >
              <TriangleAlert />
              <AlertTitle>
                Live telemetry issue
                {projects.error && " · Projects unavailable"}
              </AlertTitle>
              <AlertDescription>{telemetry.error.message}</AlertDescription>
            </Alert>
          )}
          {projects.error && !telemetry.error && (
            <Alert variant="destructive">
              <AlertTitle>Projects unavailable</AlertTitle>
              <AlertDescription>{projects.error.message}</AlertDescription>
            </Alert>
          )}
          <ShutdownStatus
            label="Shutdown of the entire host"
            onDismiss={hostShutdowns.host.dismiss}
            rows={runs}
            state={hostShutdowns.host.state}
          />
          {selection.host ? (
            <HostPage
              client={client}
              onRefresh={() => setProjectRefresh((value) => value + 1)}
              list={hostList}
            >
              <HostShutdownButtons
                list={hostList}
                loadMore={telemetry.loadMore}
                loadingMore={telemetry.loadingMore}
                shutdowns={hostShutdowns}
              />
            </HostPage>
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
                      overrides={graph && currentOverrides(graph)}
                      runId={selectedRunId}
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
                      nodes={nodes}
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
