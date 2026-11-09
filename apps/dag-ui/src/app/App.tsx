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
  Menu,
  RefreshCw,
  Route,
  Satellite,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChannelView } from "../features/control/ChannelView";
import { RunActions } from "../features/control/RunActions";
import { useRunControl } from "../features/control/useRunControl";
import { DagGraph } from "../features/graph/DagGraph";
import { HostPage } from "../features/host/HostPage";
import { useHostListing } from "../features/host/useHostListing";
import { HumanItemsPage } from "../features/human-items/HumanItemsPage";
import { useHumanItemsSelection } from "../features/human-items/useHumanItems";
import { RunNavigation } from "../features/navigation/RunNavigation";
import { useNavigationDrawer } from "../features/navigation/useNavigationDrawer";
import { useDagTelemetry } from "../features/runs/useDagTelemetry";
import {
  HostShutdownButtons,
  useHostShutdowns,
} from "../features/shutdown/ShutdownControls";
import { ShutdownStatus } from "../features/shutdown/ShutdownStatus";
import { NodeTimelineView } from "../features/timeline/NodeTimelineView";
import { OverallView } from "../features/timeline/OverallView";
import { TimelinePopoverLayer } from "../features/timeline/TimelinePopover";
import { useHumanItemsRoute } from "../lib/humanItemsRoute";
import { HISTORY_LOADING_TEXT, LOADING_TEXT, loaded } from "../lib/loading";
import { RecordDisclosure } from "../lib/RecordDisclosure";
import {
  currentOverrides,
  graphOf,
  graphStateWord,
  launchLabel,
  nodeViews,
} from "../lib/run-model";
import { StructuredFields } from "../lib/StructuredFields";
import { sidebarGroups } from "../lib/sidebar-model";
import { Timestamp } from "../lib/Timestamp";
import { UpdateSetting } from "../lib/UpdateSetting";
import { useUpdateSettings } from "../lib/update-settings";
import {
  DETAIL_LEVELS,
  type DetailLevel,
  isRunView,
  useUrlSelection,
} from "../lib/useUrlSelection";
import type { FirstRead } from "../main";

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

/** How many times `value` has changed identity since this component mounted. */
function useChangeCount(value: unknown): number {
  const held = useRef<{ value: unknown; count: number }>({ value, count: 0 });
  if (held.current.value !== value)
    held.current = { value, count: held.current.count + 1 };
  return held.current.count;
}

/** The Host page's listing is read whole, so there is never another page. */
const noMorePages = () => Promise.resolve();

export function App({
  client = defaultClient,
  first,
  onDrawn,
}: {
  readonly client?: TelemetryClient;
  /** The read the page's entry already made, taken over rather than repeated. */
  readonly first?: FirstRead;
  /** Called once the app has drawn what the first screen stood in for. */
  readonly onDrawn?: () => void;
}) {
  const selection = useUrlSelection();
  // The action-items page is a view of the host's attention rather than of a
  // run, so while it is open nothing picks a run: its subscription carries the
  // sidebar and the items, and nothing of any run.
  const humanItems = useHumanItemsRoute();
  const runless = selection.host || humanItems.active;
  const humanItemsSelection = useHumanItemsSelection(humanItems.active);
  // The reading the viewer asked for, as the filter profile the server names it
  // by. Every payload this app shows is read under it, so the graph, the
  // timeline and the pushed changes can never be three different slices of one
  // run.
  const filter = DETAIL_LEVELS[selection.detail].profile;
  const updates = useUpdateSettings();
  const drawer = useNavigationDrawer();
  const telemetry = useDagTelemetry(client, {
    runId: selection.runId,
    view:
      selection.view === "overall"
        ? "overall"
        : selection.view === "channel"
          ? "channel"
          : selection.nodeId === undefined
            ? "graph"
            : "node",
    nodeId: selection.nodeId,
    filter,
    // An address naming no run opens the newest one served, except on the Host
    // page, which picks none itself; a run the address already names stays read.
    selectFirst: !runless,
    host: runless,
    humanItems: humanItemsSelection.view,
    navigationUpdates: updates.navigation,
    mainUpdates: updates.main,
    ...(first === undefined ? {} : { first }),
  });
  const rows = telemetry.rows;
  const selectedRunId = telemetry.runId;
  const lastActivity = telemetry.activity.at(-1);
  const detail = telemetry.detail;
  const nodes = useMemo(() => (detail ? nodeViews(detail) : []), [detail]);
  const control = useRunControl(client, selectedRunId);
  // Held here rather than under the run's view: a shutdown is minutes long, and
  // what it is doing stays on screen whichever run or list the reader moves to.
  const hostShutdowns = useHostShutdowns(client);
  // The full listing is the Host page's own read, taken when it opens and on its
  // refresh control: nothing else on the page needs more than the sidebar rows.
  // While a host shutdown is out, it is also what the shutdown's progress is
  // read off, so it is read again whenever a pushed row says a run moved.
  const [hostRefresh, setHostRefresh] = useState(0);
  const shuttingDown = hostShutdowns.host.state.phase === "sending";
  const rowChanges = useChangeCount(rows);
  // The rows as of the last frame, not the navigation's copy: a hold on what the
  // navigation shows does not hold a shutdown's progress.
  const { list: hostList, error: hostListError } = useHostListing(
    client,
    selection.host || shuttingDown,
    hostRefresh + (shuttingDown ? rowChanges : 0),
  );
  const graph = detail === undefined ? undefined : graphOf(detail);
  const runLoaded = loaded(detail?.progress);
  const historyFailed =
    detail?.progress?.failed ?? telemetry.timeline?.progress?.failed;
  const historyLoading =
    !runless &&
    (detail?.progress?.complete === false ||
      telemetry.timeline?.progress?.complete === false);
  const readFailed =
    !runless && detail === undefined && telemetry.error !== undefined;
  const drawnOnce = useRef(false);
  useLayoutEffect(() => {
    if (drawnOnce.current) return;
    if (detail !== undefined || telemetry.error !== undefined) {
      drawnOnce.current = true;
      onDrawn?.();
    }
  }, [detail, telemetry.error, onDrawn]);
  const selectedNode = nodes.find(({ id }) => id === selection.nodeId);
  useEffect(() => {
    if (runless || !rows) return;
    const groups = sidebarGroups(rows);
    const currentGroup = groups.find((group) =>
      group.rows.some((row) => row.id === selection.runId),
    );
    const current = currentGroup?.rows.find(
      (row) => row.id === selection.runId,
    );
    const candidates =
      currentGroup?.rows ?? groups.flatMap((group) => group.rows);
    const visible = candidates.filter(
      (row) => !row.kind || !selection.hiddenKinds.includes(row.kind),
    );
    if (
      (!selection.runId ||
        (current?.kind && selection.hiddenKinds.includes(current.kind))) &&
      visible[0]
    )
      selection.selectRun(visible[0].id);
  }, [rows, selection, runless]);

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
          rows={telemetry.navigationRows}
          failed={telemetry.rows === undefined && telemetry.error !== undefined}
          selectedRunId={selectedRunId}
          onSelect={(run) => {
            selection.selectRun(run);
            drawer.close();
          }}
          onOpenProject={selection.selectRun}
          onHost={() => {
            selection.selectHost();
            drawer.close();
          }}
          hostCurrent={selection.host && !humanItems.active}
          onActionItems={() => {
            humanItems.open();
            drawer.close();
          }}
          actionItemsCurrent={humanItems.active}
          hiddenKinds={selection.hiddenKinds}
          onKindsChange={selection.selectKinds}
          drawerOpen={drawer.open}
          drawerRef={drawer.drawer}
          updates={
            <UpdateSetting
              caption="Navigation"
              name="Navigation updates"
              onChange={updates.setNavigation}
              setting={updates.navigation}
              waiting={telemetry.navigationWaiting}
            />
          }
        />
        {drawer.open && (
          <button
            aria-label="Close navigation"
            className="nav-scrim"
            onClick={drawer.close}
            type="button"
          />
        )}
        <main className="workspace" inert={drawer.open}>
          <section
            aria-label={
              selectedRunId && !runless ? "Run header" : "Workspace header"
            }
            className={`topbar${selectedRunId && !runless ? " run-topbar" : ""}`}
          >
            <button
              aria-controls="run-navigation"
              aria-expanded={drawer.open}
              aria-label="Open navigation"
              className="nav-menu"
              onClick={drawer.toggle}
              ref={drawer.menuButton}
              type="button"
            >
              <Menu aria-hidden="true" size={18} />
            </button>
            <div className="topbar-title">
              <div>
                <p className="eyebrow">Execution telemetry</p>
                <h2>
                  {humanItems.active
                    ? "Action items"
                    : selection.host
                      ? "Host"
                      : (selectedRunId ?? "No DAG selected")}
                </h2>
              </div>
            </div>
            <div className="topbar-actions">
              {!runless && selectedRunId !== undefined && (
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
              {!runless && lastActivity !== undefined && (
                <button
                  className="last-activity connection"
                  type="button"
                  title={`${lastActivity.node}: ${activityLine(lastActivity)}`}
                  onClick={() => {
                    selection.selectNode(lastActivity.node);
                    selection.selectItem(lastActivity.event_id);
                  }}
                >
                  {lastActivity.node}: {activityLine(lastActivity)}
                </button>
              )}
            </div>
            <div className="main-updates">
              <UpdateSetting
                caption="Updates"
                name="Main area updates"
                onChange={updates.setMain}
                setting={updates.main}
                waiting={telemetry.mainWaiting}
              />
              <Button
                onClick={() => {
                  setHostRefresh((value) => value + 1);
                  telemetry.refresh();
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw size={14} /> Refresh
              </Button>
            </div>
          </section>
          {!runless && detail && (
            <RecordDisclosure
              label="Run details"
              className="run-header-details"
              onOpen={control.reread}
            >
              <p>
                Launching session:{" "}
                {runLoaded ? launchLabel(detail.launch) : LOADING_TEXT}
              </p>
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
                    <output aria-label="Last progress">
                      {!runLoaded ? (
                        LOADING_TEXT
                      ) : detail.run.last_progress_at === undefined ? (
                        "Not recorded"
                      ) : (
                        <Timestamp
                          at={new Date(
                            detail.run.last_progress_at * 1000,
                          ).toISOString()}
                          relative
                        />
                      )}
                    </output>
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
          {telemetry.error && !readFailed && (
            // `Alert` carries `role="alert"` itself, so the banner keeps announcing
            // itself the moment a read fails.
            <Alert
              className="live-issue rounded-none border-x-0 border-t-0"
              variant="destructive"
            >
              <TriangleAlert />
              <AlertTitle>Live telemetry issue</AlertTitle>
              <AlertDescription>
                {telemetry.error.message}{" "}
                <Button
                  onClick={telemetry.refresh}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {historyFailed !== undefined && (
            <Alert
              className="live-issue rounded-none border-x-0 border-t-0"
              variant="destructive"
            >
              <TriangleAlert />
              <AlertTitle>
                The rest of this run's history did not load
              </AlertTitle>
              <AlertDescription>
                {historyFailed}{" "}
                <Button
                  onClick={telemetry.refresh}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {telemetry.notice && (
            <p className="live-notice" role="status">
              {telemetry.notice}
            </p>
          )}
          <ShutdownStatus
            label="Shutdown of the entire host"
            onDismiss={hostShutdowns.host.dismiss}
            rows={hostList?.runs ?? []}
            state={hostShutdowns.host.state}
          />
          {humanItems.active ? (
            <HumanItemsPage
              client={client}
              live={telemetry.humanItems}
              choice={humanItemsSelection.choice}
              setChoice={humanItemsSelection.setChoice}
              selectedId={humanItemsSelection.selectedId}
              setSelectedId={humanItemsSelection.setSelectedId}
            />
          ) : selection.host ? (
            <HostPage
              client={client}
              listError={hostListError}
              onRefresh={() => setHostRefresh((value) => value + 1)}
              list={hostList}
              rows={telemetry.hostRows}
            >
              <HostShutdownButtons
                list={hostList}
                loadMore={noMorePages}
                loadingMore={false}
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
                {readFailed && telemetry.error ? (
                  <div className="loading-state">
                    <div className="read-failed" role="alert">
                      <strong>This run's history did not load</strong>
                      <p>{telemetry.error.message}</p>
                      <button onClick={telemetry.refresh} type="button">
                        Try again
                      </button>
                    </div>
                  </div>
                ) : !detail &&
                  (telemetry.loading || selectedRunId !== undefined) ? (
                  <div aria-live="polite" className="loading-state">
                    <Skeleton className="h-2 w-48" />
                    <Skeleton className="h-2 w-32" />
                    Loading execution history…
                  </div>
                ) : detail && selectedRunId ? (
                  selection.view === "channel" ? (
                    <ChannelView
                      channel={telemetry.channel}
                      client={client}
                      decisions={graph?.decisions}
                      filter={filter}
                      journalSeq={graph?.last_seq}
                      observedAt={detail.observed_at}
                      overrides={
                        graph && runLoaded ? currentOverrides(graph) : undefined
                      }
                      runId={selectedRunId}
                    />
                  ) : selection.view === "overall" ? (
                    <OverallView
                      client={client}
                      detail={detail}
                      filter={filter}
                      key={`${selectedRunId}:${filter ?? ""}`}
                      journalSeq={graph?.last_seq}
                      nodes={nodes}
                      onRetry={telemetry.refresh}
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
                      filter={filter}
                      key={`${selectedRunId}:${selectedNode.id}:${filter ?? ""}`}
                      runLoaded={runLoaded}
                      onRetry={telemetry.refresh}
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
                      journalSeq={graph?.last_seq}
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
        {historyLoading && historyFailed === undefined && (
          <p className="history-loading" role="status">
            {HISTORY_LOADING_TEXT}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * What a node was last seen doing, in the one line the server's transcript
 * resolver described the call in — never derived here, so the header and
 * `onepipeline monitor` say the same thing about the same call.
 */
function activityLine(activity: {
  readonly description: string;
  readonly kind: string;
}): string {
  return activity.description || activity.kind;
}
