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
  Card,
  cn,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Timeline,
  useTimelineScrollSync,
} from "@oneharness/ui";
import type { PlanTask, RunTimeline } from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import type { EventType } from "@onepipeline-ui/timeline-categories";
import { TaskMarkdown } from "@onetaskgraph/ui";
import {
  ArrowLeft,
  ExternalLink,
  OctagonPause,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { commandLine } from "../../lib/command-line";
import { LOADING_TEXT } from "../../lib/loading";
import {
  awaitedReleases,
  isUnhealthy,
  type NodeView,
  nodeKindWord,
  recordedReason,
} from "../../lib/run-model";

const OFF_GRAPH_TASK =
  "This node is not on the run's graph, so the plan holds no task for it.";

import { changeRequestId } from "../../lib/change-request";
import { StateBadge } from "../../lib/StateBadge";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration } from "../../lib/time";
import {
  isNodeTab,
  NODE_TAB_LABELS,
  type NodeTab,
} from "../../lib/useUrlSelection";
import { boundedZoom, TIMELINE_TIME_MARKS } from "./axis";
import { CheckRuntime } from "./CheckRuntime";
import { CheckStatus } from "./CheckStatus";
import { ControlBadge } from "./ControlBadge";
import { CycleBlock, EventListHeader, FilteredEmpty } from "./EventList";
import { EventCategoryIcon } from "./event-category";
import { HistoryFailed, PartialMark, PlotHatches } from "./history-controls";
import { NodeRelease } from "./release";
import { TimelineItemDetail } from "./TimelineItemDetail";
import {
  compactTimelineItems,
  compactTimelineMarkers,
  eventList,
  findRow,
  nodeTimeline,
  nodeTimelineV2,
  pathTo,
  readingRows,
  type TimelineRow,
  type TranscriptEntry,
  transcriptEntries,
  transcriptRuns,
  typeCounts,
} from "./timeline-model";
import { useTimelineHistory } from "./useTimelineHistory";

/**
 * One node, read as what it did rather than as a column of stacked blocks.
 *
 * The graph is reduced to a breadcrumb, and the working area becomes a timeline over
 * a transcript, locked to one clock: the plot stays pinned across the full width
 * while the node's recorded work is read below it in order. Whatever the reader opens
 * arrives in a panel over the right two thirds, so the reading it came from is still
 * behind it. The node's own task, criteria, dependencies, PR and gate result are tabs
 * beside the timeline rather than blocks pushing that record down the page.
 */
export function NodeTimelineView({
  client,
  runId,
  node,
  nodes,
  timeline,
  timelineError,
  hiddenTypes = [],
  onHiddenTypesChange = () => {},
  runLoaded = true,
  onRetry,
  selectedItemId,
  onSelectItem,
  onBack,
  selectedTab,
  onSelectTab,
}: {
  readonly client: TelemetryClient;
  readonly runId: string;
  readonly node: NodeView;
  /** Every node of the run, so a blocker can be named with the status it holds. */
  readonly nodes: readonly NodeView[];
  readonly timeline?: RunTimeline;
  readonly timelineError?: Error;
  /** The event types the reader hid from the node's event list. */
  readonly hiddenTypes?: readonly EventType[];
  readonly onHiddenTypesChange?: (hidden: readonly EventType[]) => void;
  /** Whether the members a first answer leaves out have arrived. */
  readonly runLoaded?: boolean;
  /** Subscribe again, from a failed read. */
  readonly onRetry?: () => void;
  readonly selectedItemId?: string;
  readonly onSelectItem: (id?: string) => void;
  readonly onBack: () => void;
  readonly selectedTab: NodeTab;
  readonly onSelectTab: (tab: NodeTab) => void;
}) {
  const projected = useMemo(
    () => nodeTimeline(timeline, node.id),
    [timeline, node.id],
  );
  // Escape is the way out of a full-screen view everywhere else, so it is the way
  // out of this one; the breadcrumb button is the visible half of the same exit.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selectedItemId !== undefined) onSelectItem();
        else onBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack, onSelectItem, selectedItemId]);
  const prUrl =
    node.detail?.publication === undefined
      ? (node.result?.pr ?? undefined)
      : node.detail.publication.pr_url;

  return (
    <section aria-label={`Timeline for ${node.label}`} className="node-view">
      {/* The tab set holds the node bar, because the node's tabs are selected in
          it: one band above the node's content rather than two. */}
      <Tabs
        className="node-tabs"
        onValueChange={(value) => {
          if (isNodeTab(value)) onSelectTab(value);
        }}
        value={selectedTab}
      >
        <section aria-label="Node header" className="node-view-head">
          <nav aria-label="Breadcrumb">
            <ol className="breadcrumb">
              <li>
                <Button
                  onClick={onBack}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ArrowLeft size={14} /> Graph
                </Button>
              </li>
              <li aria-current="page">
                <span className="breadcrumb-node">{node.label}</span>
              </li>
            </ol>
          </nav>
          <div className="node-view-facts">
            {/* Named so a reader of this header — and the journeys that hold its
                tones — can say *which* badge they mean: the reading beside it is
                also one, and the two answer different questions. */}
            <StateBadge className="node-view-state" state={node.status} />
            <ControlBadge control={node.control} />
            <span className="node-view-meta">
              {nodeKindWord(node)} node ·{" "}
              {runLoaded
                ? `${node.telemetry?.turns ?? 0} turns · ${node.telemetry?.lint ?? 0} lint turns`
                : `turns ${LOADING_TEXT}`}
            </span>
            {prUrl !== undefined && (
              <a
                className="node-view-pr"
                href={prUrl}
                rel="noreferrer"
                target="_blank"
              >
                {changeRequestId(prUrl)} <ExternalLink size={12} />
              </a>
            )}
          </div>
          <TabsList aria-label="Node details" variant="line">
            {Object.entries(NODE_TAB_LABELS).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </section>

        <NodeProblemBanner node={node} nodes={nodes} />
        <NodeAwaitingPanel node={node} />
        <NodeCommandPanel node={node} />

        <TabsContent className="node-tab-panel" value="task">
          {/* The task is untrusted markdown: the shared package renders it
              safely, as every other place this app shows a task. */}
          {node.task === undefined ? (
            <p>{OFF_GRAPH_TASK}</p>
          ) : runLoaded ? (
            <TaskMarkdown source={taskProse(node.task)} />
          ) : (
            <p className="loading-value">{LOADING_TEXT}</p>
          )}
          <dl className="facts">
            {/* The settlement's own word — `merged`, `published`, `shipped` —
                which the status badge does not carry: `done` is the same for a
                change that merged and one still open. */}
            <div>
              <dt>Settled as</dt>
              <dd>{formatValue(node.result?.outcome)}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd>{formatValue(node.result?.detail)}</dd>
            </div>
            {/* The node's own overrides, in the order its next dispatch applies
                them after the run-wide list; an edit replaces the whole list. */}
            <div>
              <dt>Graph overrides</dt>
              <dd>
                {!runLoaded ? (
                  LOADING_TEXT
                ) : (node.task?.sets ?? []).length === 0 ? (
                  "None"
                ) : (
                  <ol aria-label="Graph overrides" className="sets-served">
                    {node.task?.sets?.map((entry, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: an override's identity is its position in the ordered list.
                      <li key={index}>
                        <code>{entry}</code>
                      </li>
                    ))}
                  </ol>
                )}
              </dd>
            </div>
          </dl>
        </TabsContent>
        <TabsContent className="node-tab-panel" value="criteria">
          {node.task === undefined ? (
            <p>{OFF_GRAPH_TASK}</p>
          ) : runLoaded ? (
            <TaskMarkdown source={acceptanceCriteria(node.task)} />
          ) : (
            <p className="loading-value">{LOADING_TEXT}</p>
          )}
        </TabsContent>
        <TabsContent className="node-tab-panel" value="dependencies">
          <dl className="facts">
            <div>
              <dt>Dependencies</dt>
              <dd>
                {(node.task?.deps ?? [])
                  .map((dep) => {
                    const status = nodes.find(
                      (other) => other.id === dep,
                    )?.status;
                    return status === undefined ? dep : `${dep} (${status})`;
                  })
                  .join(", ") || "None"}
              </dd>
            </div>
            <div>
              <dt>Unblocks</dt>
              <dd>{node.dependents.join(", ") || "None"}</dd>
            </div>
          </dl>
        </TabsContent>
        <TabsContent className="node-tab-panel" value="remote">
          {!runLoaded && <p className="loading-value">{LOADING_TEXT}</p>}
          <dl className="facts" hidden={!runLoaded}>
            <div>
              <dt>Publication</dt>
              <dd>
                <Publication node={node} />
              </dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{node.detail?.publication?.branch ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Merge</dt>
              <dd>
                {node.detail?.publication
                  ? node.detail.publication.merged
                    ? "Merged"
                    : "Not merged"
                  : "Not recorded"}
              </dd>
            </div>
            {/* Beside the change request rather than under a tab of its own: the
                release is what the change request eventually went out in, and a
                reader sequencing another node behind it is reading both. A node
                the run recorded no release for says so, exactly as an unpublished
                node's publication does. */}
            <div>
              <dt>Release</dt>
              <dd>
                <NodeRelease node={node} />
              </dd>
            </div>
            <div className="remote-check-facts">
              <dt>Verification coverage</dt>
              <dd>
                Hook:{" "}
                {node.detail?.verification.pre_push_hook
                  ? "present"
                  : "not recorded"}
                {" · "}Required checks:{" "}
                {node.detail?.verification.required_checks?.join(", ") ||
                  "none configured"}
              </dd>
            </div>
            <div className="remote-check-facts">
              <dt>Observed checks</dt>
              <dd>
                {(node.detail?.verification.checks ?? []).length === 0 ? (
                  "No checks observed"
                ) : (
                  <table aria-label="Remote checks" className="remote-checks">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Status</th>
                        <th>Runtime</th>
                        <th>Required</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* The shared check-visibility corpus is reconciled with
                          onevcs::Check::state in tests/contract.rs; the browser
                          journey drives these rows for all five producer states,
                          including a completed check with no conclusion. */}
                      {node.detail?.verification.checks?.map((check) => (
                        <tr
                          key={check.name}
                          className={
                            check.status === "completed" &&
                            !["success", "neutral", "skipped"].includes(
                              check.conclusion ?? "",
                            )
                              ? "check-failing"
                              : undefined
                          }
                        >
                          <th scope="row">
                            {check.url ? (
                              <a
                                href={check.url}
                                rel="noreferrer"
                                target="_blank"
                              >
                                {check.name}
                              </a>
                            ) : (
                              check.name
                            )}
                          </th>
                          <td>
                            <CheckStatus check={check} />
                          </td>
                          <td>
                            <CheckRuntime
                              {...(check.started_at === undefined
                                ? {}
                                : { startedAt: check.started_at })}
                              {...(check.completed_at === undefined
                                ? {}
                                : { completedAt: check.completed_at })}
                            />
                          </td>
                          <td
                            title={check.requirement}
                            className={
                              check.required
                                ? "check-required"
                                : "check-optional"
                            }
                          >
                            <svg
                              role="img"
                              aria-label={
                                check.required ? "required" : "not required"
                              }
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                            >
                              {check.required ? (
                                <path
                                  d="M6 0.5 L11 2.5 V6 C11 9 8.5 11 6 11.5 C3.5 11 1 9 1 6 V2.5 Z"
                                  fill="currentColor"
                                />
                              ) : (
                                <circle
                                  cx="6"
                                  cy="6"
                                  r="4.5"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeDasharray="2 1.5"
                                />
                              )}
                            </svg>
                            {check.required ? "Required" : "Optional"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </dd>
            </div>
          </dl>
        </TabsContent>

        <TabsContent className="node-timeline-panel" value="timeline">
          {/* llmlint: ignore[changed_behavior_has_e2e] the detail and the timeline are
          read from the same strict journal, so no served run fails one and not the
          other; a browser reaches this only when the whole API is unreachable, and
          then there is no node view to report it in. App.test.tsx drives it through
          the real telemetry client. */}
          {timelineError !== undefined ? (
            <Alert className="m-5 w-auto" variant="destructive">
              <TriangleAlert />
              <AlertTitle>Timeline unavailable</AlertTitle>
              <AlertDescription>
                {timelineError.message}{" "}
                {onRetry !== undefined && (
                  <Button onClick={onRetry} size="sm" variant="outline">
                    Try again
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          ) : timeline === undefined ? (
            <div aria-live="polite" className="loading-state">
              Loading the recorded timeline…
            </div>
          ) : projected.rows.length === 0 ? (
            <Card className="m-5 items-center gap-2 p-8 text-muted-foreground">
              <p className="m-0">This node has no recorded timeline yet.</p>
              <p className="m-0 text-[11px]">
                Spans and events appear here as the run records them.
              </p>
            </Card>
          ) : (
            <NodeExecution
              client={client}
              hiddenTypes={hiddenTypes}
              node={node}
              onHiddenTypesChange={onHiddenTypesChange}
              onSelectItem={onSelectItem}
              runId={runId}
              selectedItemId={selectedItemId}
              timeline={timeline}
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function NodeExecution({
  client,
  hiddenTypes,
  node,
  onHiddenTypesChange,
  onSelectItem,
  runId,
  selectedItemId,
  timeline: served,
}: {
  readonly client: TelemetryClient;
  readonly hiddenTypes: readonly EventType[];
  readonly onHiddenTypesChange: (hidden: readonly EventType[]) => void;
  readonly node: NodeView;
  readonly onSelectItem: (id?: string) => void;
  readonly runId: string;
  readonly selectedItemId?: string;
  readonly timeline: RunTimeline;
}) {
  const history = useTimelineHistory({
    client,
    runId,
    scope: "node",
    nodeId: node.id,
    timeline: served,
  });
  const timeline = history.timeline ?? served;
  const projection = useMemo(
    () => nodeTimelineV2(timeline, node.id),
    [timeline, node.id],
  );
  const hidden = useMemo(() => new Set(hiddenTypes), [hiddenTypes]);
  // What the event list reads: one row per surface, the types the reader kept,
  // and every back-to-back repeat as one block. The plot above reads every row.
  const listed = useMemo(
    () => eventList(projection.tree, hidden),
    [projection.tree, hidden],
  );
  const counts = useMemo(() => typeCounts(projection.tree), [projection.tree]);
  // Which collapsed runs the reader has opened. Held here rather than in the
  // projection because it is the reader's own state: what the run recorded is the
  // same either way.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // A row the address names is a row the reader asked for, so the run holding it
  // opens whether or not they opened it themselves — otherwise a bookmarked
  // moment inside a collapsed run lands on a reading that does not contain it.
  const selectedRuns = useMemo(() => {
    if (selectedItemId === undefined) return [];
    return pathTo(listed, selectedItemId)
      .filter((row) => row.rowKind === "group")
      .map(({ id }) => id);
  }, [listed, selectedItemId]);
  const openNow = useMemo(
    () =>
      selectedRuns.length === 0
        ? openRuns
        : new Set<string>([...openRuns, ...selectedRuns]),
    [openRuns, selectedRuns],
  );
  const reading = useMemo(
    () => transcriptEntries(listed, openNow),
    [listed, openNow],
  );
  const entries = useMemo(
    () =>
      readingRows(reading).map((row) => ({
        id: row.id,
        time: Date.parse(row.startedAt),
      })),
    [reading],
  );
  useNodeLoadProbe(projection, reading);
  // The reading cursor measures every row it is given each time the rows change and
  // each time the list scrolls, which a node's read does once per batch it draws:
  // over a busy node's thousands of rows that measuring was most of the load. So
  // while the read is in flight the cursor follows the rows the node opened with,
  // and it takes the whole list once, when the read lands.
  const nodeLoading = history.nodeLoad?.state === "loading";
  const openedWith = useRef(entries);
  if (!nodeLoading) openedWith.current = entries;
  const sync = useTimelineScrollSync(
    nodeLoading ? openedWith.current : entries,
  );
  const [expanded, setExpanded] = useState(false);
  // Held here rather than inside the plot so every zoom is bounded: the plot's
  // own zoom would narrow past the last labelled second.
  const [zoom, setZoom] = useState<readonly [number, number]>();
  const compactItems = useMemo(
    () => compactTimelineItems(projection.items, projection.lanes),
    [projection.items, projection.lanes],
  );
  const compactMarkers = useMemo(
    () =>
      compactTimelineMarkers(
        projection.markers,
        projection.items,
        selectedItemId,
      ),
    [projection.items, projection.markers, selectedItemId],
  );
  // The plotted window, read the way the plot itself reads it. The transcript lists
  // rows the plot has no lane for — a lifecycle step brackets its sessions rather
  // than being one — so scrolling onto one can put the reading position outside the
  // window; pinning it to the nearest edge keeps the cursor on screen instead of
  // dropping it and leaving the reader with no mark at all.
  const plotted = useMemo(
    () =>
      timeRange([
        ...projection.items,
        ...projection.markers.map(({ at }) => ({ start: at })),
      ]),
    [projection.items, projection.markers],
  );
  // The window of exactly what the plot is drawing, which is what it shows when
  // nobody has zoomed it. Always handed to the plot, so every zoom passes through
  // `boundedZoom` and none is held inside the plot where it could not be.
  const shown = useMemo(
    () =>
      timeRange([
        ...(expanded ? projection.items : compactItems),
        ...compactMarkers.map(({ at }) => ({ start: at })),
      ]),
    [expanded, projection.items, compactItems, compactMarkers],
  );
  const cursor =
    sync.cursor === undefined
      ? undefined
      : Math.min(Math.max(sync.cursor, plotted[0]), plotted[1]);
  const selected =
    selectedItemId === undefined
      ? undefined
      : (findRow(listed, selectedItemId) ??
        findRow(projection.rows, selectedItemId));
  // A scroll the page made itself, to a selected row, asks for no page.
  const ownScrollUntil = useRef(0);
  const select = (id: string) => {
    ownScrollUntil.current = Date.now() + 500;
    onSelectItem(id);
    sync.scrollTo(id);
  };
  // The transcript's rows take one opener across renders, so a page of earlier
  // rows renders the rows it brought rather than every row already shown.
  const selectNow = useRef(select);
  selectNow.current = select;
  const openRow = useCallback((id: string) => selectNow.current(id), []);
  const transcript = useRef<HTMLElement | null>(null);
  // One ref across renders, as the hook's own is: a new one would have the sync
  // attach and detach its scroll listener on every render.
  const { containerRef } = sync;
  const transcriptRef = useCallback(
    (element: HTMLElement | null) => {
      transcript.current = element;
      containerRef(element);
    },
    [containerRef],
  );
  const plotArea = useRef<HTMLElement | null>(null);
  const { loadSpan, forgetSpan } = history;
  const openedSpan =
    selected?.rowKind === "span" ? selected.span.id : undefined;
  useEffect(() => {
    if (openedSpan === undefined) return;
    loadSpan(openedSpan);
    // A panel closed, or another opened, takes its span's failed read with it.
    return () => forgetSpan(openedSpan);
  }, [openedSpan, loadSpan, forgetSpan]);
  const spanFailure =
    openedSpan === undefined ? undefined : history.spanFailure(openedSpan);
  // The hook returns a new object on each render, including a cursor update
  // from scrolling. Only a changed selection should scroll again; depending on
  // that object makes the selected stamp race the scroll-derived reading cursor.
  const { scrollTo } = sync;
  useEffect(() => {
    if (selectedItemId !== undefined) {
      ownScrollUntil.current = Date.now() + 500;
      scrollTo(selectedItemId);
    }
  }, [selectedItemId, scrollTo]);
  return (
    <div className="node-execution" data-expanded={expanded}>
      <section
        aria-busy={nodeLoading}
        aria-label="Node timeline"
        className="node-timeline-sticky"
        data-testid="node-timeline"
        ref={plotArea}
      >
        <PlotHatches
          container={plotArea}
          partial={history.nodeLoad?.partial === true}
          range={zoom ?? shown}
          stretches={history.unheld}
        />
        {history.nodeLoad?.partial === true && (
          <PartialMark load={history.nodeLoad} />
        )}
        <Timeline
          {...TIMELINE_TIME_MARKS}
          axis={{ origin: plotted[0] }}
          cursor={cursor}
          expanded={expanded}
          getFailureExcerpt={(item) =>
            item.payload.rowKind === "span"
              ? item.payload.span.detail?.output_tail
              : undefined
          }
          items={expanded ? projection.items : compactItems}
          lanes={projection.lanes}
          markers={compactMarkers}
          onExpandedChange={setExpanded}
          onRangeChange={(next) =>
            // A reset asks for the whole window back; a live run's window keeps
            // growing, so it is followed rather than pinned.
            setZoom(
              next[0] <= shown[0] && next[1] >= shown[1]
                ? undefined
                : boundedZoom(next),
            )
          }
          onSelect={(entry) => select(entry.id)}
          range={zoom ?? shown}
          selectedId={selectedItemId}
        />
      </section>
      <section
        aria-busy={nodeLoading}
        aria-label="Node transcript"
        className="node-transcript"
        ref={transcriptRef}
      >
        {history.failure !== undefined && (
          <HistoryFailed
            failure={history.failure}
            what="This node's timeline"
          />
        )}
        <EventListHeader
          counts={counts}
          hidden={hidden}
          onHiddenChange={onHiddenTypesChange}
        />
        {listed.length === 0 && projection.tree.length > 0 && (
          <FilteredEmpty onClear={() => onHiddenTypesChange([])} />
        )}
        {transcriptRuns(reading).map((run) => {
          const items = (
            <TranscriptEntries
              entries={run.entries}
              key={run.id}
              onOpen={openRow}
              onToggle={(id) =>
                setOpenRuns((open) => {
                  const next = new Set(open);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              register={sync.register}
              selectedItemId={selectedItemId}
            />
          );
          return run.dispatch === undefined ? (
            <Fragment key={run.id}>{items}</Fragment>
          ) : (
            <section
              aria-label={run.dispatch.label}
              className="transcript-dispatch"
              key={run.id}
            >
              <h3>{run.dispatch.label}</h3>
              {items}
            </section>
          );
        })}
      </section>
      {selected !== undefined && (
        <aside aria-label="Item detail panel" className="detail-drawer">
          <Button
            aria-label="Close detail"
            className="drawer-close"
            onClick={() => onSelectItem()}
            size="icon"
            variant="ghost"
          >
            <X />
          </Button>
          <TimelineItemDetail
            client={client}
            node={node}
            row={selected}
            runId={runId}
          />
          {spanFailure !== undefined && <HistoryFailed failure={spanFailure} />}
        </aside>
      )}
    </div>
  );
}

/**
 * The window the timeline plots, derived exactly as the plot derives it: the earliest
 * start to the latest end of the items it is given.
 */
function timeRange(
  items: readonly { start: number; end?: number | null }[],
): readonly [number, number] {
  const starts = items.map(({ start }) => start);
  const ends = items.map((item) => item.end ?? item.start);
  if (starts.length === 0) return [0, 1];
  const first = Math.min(...starts);
  const last = Math.max(...ends);
  return [first, last > first ? last : first + 1];
}

/** What the node panel's chart data and event list hold, by record. */
export interface NodeLoadHeld {
  readonly chart: readonly string[];
  readonly list: readonly string[];
}

declare global {
  interface Window {
    /**
     * Installed by a measurement (`read-latency.spec.ts`'s complete-load reading)
     * before the view loads; absent otherwise, when the probe costs nothing.
     */
    __nodeLoadProbe?: (held: NodeLoadHeld) => void;
  }
}

/**
 * Tells a measurement's probe, after each commit, which records the chart's data
 * and the event list hold — every row the list reads, and every row a collapsed
 * run's control stands for. A layout effect, so what it says is of the same commit
 * as the DOM a mutation observer sees: a complete load is judged by the records
 * held, never by a CSS state alone.
 */
function useNodeLoadProbe(
  projection: ReturnType<typeof nodeTimelineV2>,
  reading: ReturnType<typeof transcriptEntries>,
): void {
  useLayoutEffect(() => {
    const probe = window.__nodeLoadProbe;
    if (probe === undefined) return;
    const list: string[] = [];
    const under = (row: TimelineRow) => {
      list.push(row.id);
      for (const child of row.children) under(child);
    };
    for (const entry of reading)
      if (entry.entryKind === "row") list.push(entry.row.id);
      else for (const member of entry.group.children) under(member);
    probe({
      chart: [
        ...projection.items.map((item) => item.id),
        ...projection.markers.map((marker) => marker.id),
      ],
      list,
    });
  }, [projection, reading]);
}

/**
 * The rows of a reading, each repeated loop drawn as the block that holds it.
 *
 * Exported because the run's own event list on Overall is drawn by the same rows,
 * so a record reads the same in either list.
 */
export function TranscriptEntries({
  entries,
  onOpen,
  onToggle,
  register,
  selectedItemId,
}: {
  readonly entries: readonly TranscriptEntry[];
  readonly onOpen: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly register: (id: string, element: HTMLElement | null) => void;
  readonly selectedItemId?: string;
}) {
  return entries.map((entry) =>
    entry.entryKind === "row" ? (
      <TranscriptItem
        key={entry.row.id}
        onOpen={onOpen}
        register={register}
        row={entry.row}
        selected={
          entry.row.id === selectedItemId ||
          (selectedItemId !== undefined &&
            entry.row.aliases?.includes(selectedItemId) === true)
        }
      />
    ) : (
      <CycleBlock
        entry={entry}
        key={entry.group.id}
        onToggle={() => onToggle(entry.group.id)}
      >
        <TranscriptEntries
          entries={entry.entries}
          onOpen={onOpen}
          onToggle={onToggle}
          register={register}
          {...(selectedItemId === undefined ? {} : { selectedItemId })}
        />
      </CycleBlock>
    ),
  );
}

interface TranscriptItemProps {
  readonly row: TimelineRow;
  readonly selected: boolean;
  readonly register: (id: string, element: HTMLElement | null) => void;
  readonly onOpen: (id: string) => void;
}

/**
 * Whether two renderings of a transcript row draw the same thing: every field the
 * row shows, compared by value, because each page of earlier rows projects the
 * node's timeline again and hands every row back as a new object. Reading back a
 * long transcript otherwise re-rendered every row already shown on every page,
 * which grew each page's cost with the history behind it.
 */
function drawsTheSame(was: TranscriptItemProps, now: TranscriptItemProps) {
  const [a, b] = [was.row, now.row];
  return (
    was.selected === now.selected &&
    was.register === now.register &&
    was.onOpen === now.onOpen &&
    a.id === b.id &&
    a.rowKind === b.rowKind &&
    a.displayLabel === b.displayLabel &&
    a.displayKind === b.displayKind &&
    a.startedAt === b.startedAt &&
    a.durationMs === b.durationMs &&
    a.status === b.status &&
    a.statusAt === b.statusAt &&
    a.sessionName === b.sessionName &&
    a.dispatch?.label === b.dispatch?.label &&
    (a.rowKind === "event" && b.rowKind === "event"
      ? a.category === b.category && a.event.seq === b.event.seq
      : a.rowKind !== "event" && b.rowKind !== "event")
  );
}

export const TranscriptItem = memo(function TranscriptItem({
  row,
  selected,
  register,
  onOpen,
}: TranscriptItemProps) {
  const { id } = row;
  const registered = useCallback(
    (element: HTMLElement | null) => register(id, element),
    [register, id],
  );
  return (
    <article
      aria-current={selected ? "true" : undefined}
      aria-label={row.displayLabel}
      className="transcript-item"
      data-dispatch-group={row.dispatch?.label}
      data-journal-seq={row.rowKind === "event" ? row.event.seq : undefined}
      data-row-id={row.id}
      data-selected={selected}
      ref={registered}
    >
      <button
        aria-label={`Open ${row.displayLabel}`}
        onClick={() => onOpen(row.id)}
        type="button"
      >
        <span className="eyebrow">
          {/* The same glyph the plot draws this record's marker as, so a record
              scanned on one surface is recognised on the other rather than having
              to be read again. */}
          {row.rowKind === "event" && (
            <EventCategoryIcon category={row.category} />
          )}
          {row.displayKind}
        </span>
        <strong className="transcript-label" title={row.displayLabel}>
          {row.displayLabel}
        </strong>
        <span className="transcript-facts">
          <Timestamp at={row.startedAt} />
          {row.durationMs !== null && ` · ${formatDuration(row.durationMs)}`}
          {` · ${row.status ?? "recorded"}`}
          {row.statusAt !== undefined && (
            <>
              {" "}
              <Timestamp at={row.statusAt} />
            </>
          )}
          {row.sessionName !== undefined && ` · ${row.sessionName}`}
        </span>
      </button>
    </article>
  );
}, drawsTheSame);

/**
 * The prose for a node's Task tab, wherever the plan put it.
 *
 * A lifecycle node that delegates to `steps` carries no `task` of its own — the work
 * is described once per step — so reading `task.task` alone left the tab blank for
 * exactly the nodes whose description is longest.
 */
function taskProse(task: PlanTask): string {
  if (task.task !== undefined) return task.task;
  const steps = task.steps ?? [];
  if (steps.length === 0) return "No task prose recorded.";
  return steps.map((step) => `## ${step.id}\n\n${step.task}`).join("\n\n");
}

/**
 * The bar this node is judged against: the `## Acceptance criteria` section of
 * its own task prose.
 *
 * Read out of the prose rather than off a field, because plan schema 2 retired
 * `done_when` and there is no such field to read. The criterion is written once,
 * in the task, and the judge reads it as the first message of the transcript it is
 * given — so this shows the reader exactly the text the judge was handed, and says
 * so when the task names no bar at all.
 */
function acceptanceCriteria(task: PlanTask): string {
  const prose = taskProse(task);
  // Any `##` heading whose words are "acceptance criteria", however it was cased
  // or spaced, up to the next heading of the same level or the end of the prose.
  // Written without the `m` flag on purpose: `$` has to mean end-of-prose for the
  // last section, and the line anchors are spelled out as newlines instead.
  const section =
    /(?:^|\n)##[ \t]*acceptance[ \t]+criteria[ \t]*\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)/i.exec(
      prose,
    );
  const body = section?.[1]?.trim();
  return body === undefined || body.length === 0
    ? "No acceptance criteria recorded in this node's task."
    : body;
}

function Publication({ node }: { readonly node: NodeView }) {
  const publication = node.detail?.publication;
  if (publication === undefined) {
    return typeof node.result?.pr === "string" && node.result.pr ? (
      <a
        className="node-view-pr"
        href={node.result.pr}
        rel="noreferrer"
        target="_blank"
      >
        {changeRequestId(node.result.pr)} <ExternalLink size={12} />
      </a>
    ) : (
      <>Not recorded</>
    );
  }
  const links = publication.merged
    ? [
        [publication.pr_url, changeRequestId(publication.pr_url)],
        [
          publication.commit_url,
          `Commit ${publication.commit?.slice(0, 8) ?? ""}`,
        ],
      ]
    : [
        [publication.pr_url, changeRequestId(publication.pr_url)],
        [publication.branch_url, publication.branch ?? "Branch"],
      ];
  const renderedLinks = links.filter(([url]) => url);
  if (renderedLinks.length === 0) return <>Not recorded</>;
  return (
    <>
      {renderedLinks.map(([url, label], index) => (
        <span key={url}>
          {index > 0 && " · "}
          <a
            className="node-view-pr"
            href={url}
            rel="noreferrer"
            target="_blank"
          >
            {label} <ExternalLink size={12} />
          </a>
        </span>
      ))}
    </>
  );
}

/**
 * Leads the view of a node holding finished work for a release with every release
 * it awaits, in full, above the settlement's own detail.
 *
 * Not an alert and not the problem banner: nothing has gone wrong, so opening the
 * node announces nothing. The warning tone is the one its badge and card carry —
 * what it waits on is another repository's release, as a blocked node's is another
 * node. Each entry is read off the served `awaiting`, never out of the detail.
 */
function NodeAwaitingPanel({ node }: { readonly node: NodeView }) {
  const awaited = awaitedReleases(node);
  if (awaited.length === 0) return null;
  // llmlint: ignore-block[changed_behavior_has_e2e] the engine composes a detail sentence for every `complete-but-held` and `complete-but-draft` settlement (`release::held_detail`, `release::drafted_detail`), so a held node with none is a malformed record no browser fixture in the engine's shape can carry; App.test.tsx drives this omission through the real model and telemetry client, and the browser journey drives the detail row the engine always writes.
  const detail = node.result?.detail?.trim() || undefined;
  return (
    <section
      aria-label="Awaited releases"
      className="node-awaiting m-5 rounded-lg border border-warning bg-warning-surface px-4 py-3 text-warning"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <OctagonPause size={16} />
        {node.status === "complete-but-held"
          ? "Complete, and held unlanded until its releases arrive"
          : "Complete, and held as a draft until its releases arrive"}
      </h2>
      <dl className="facts facts-stacked">
        <div>
          <dt>
            {awaited.length === 1 ? "Awaits" : `Awaits ${awaited.length}`}
          </dt>
          <dd>
            <ul className="awaited-releases">
              {awaited.map((entry) => (
                <li key={`${entry.producer} ${entry.target}`}>
                  the <strong>{entry.target}</strong> release of{" "}
                  <code>{entry.producer}</code>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        {detail !== undefined && (
          <div>
            <dt>Detail</dt>
            <dd>{detail}</dd>
          </div>
        )}
        {/* llmlint: ignore-end[changed_behavior_has_e2e] */}
      </dl>
    </section>
  );
}

/**
 * A command node's own account: what the engine ran, how it ended, and the end of
 * the log its command wrote — the whole of what such a node did, since it
 * dispatched no agent and so has no transcript to open. Absent for every other kind.
 */
function NodeCommandPanel({ node }: { readonly node: NodeView }) {
  if (node.kind !== "command") return null;
  const argv = node.task?.command;
  const timeout = node.task?.timeout_seconds;
  const outcome = node.result?.outcome;
  const log = node.result?.log;
  return (
    <section aria-label="Command" className="node-command m-5">
      <dl className="facts">
        {argv !== undefined && (
          <div>
            <dt>Command</dt>
            <dd>
              <code className="command-line">{commandLine(argv)}</code>
            </dd>
          </div>
        )}
        {timeout !== undefined && (
          <div>
            <dt>Timeout</dt>
            <dd>{timeout} seconds</dd>
          </div>
        )}
        <div>
          <dt>Outcome</dt>
          <dd>{outcome ?? node.status}</dd>
        </div>
        <div>
          <dt>Log</dt>
          <dd>
            {log === undefined ? "The command has not started." : log.path}
          </dd>
        </div>
      </dl>
      {log?.content !== undefined ? (
        <figure className="node-command-log-figure">
          <figcaption>Command log</figcaption>
          <pre className="node-command-log">
            {log.truncated === true ? `…${log.content}` : log.content}
          </pre>
        </figure>
      ) : (
        log !== undefined && (
          <p className="node-command-log-missing">
            The log is not readable from this run.
          </p>
        )
      )}
    </section>
  );
}

/** Leads an unhealthy node's detail view with its server-recorded reason. */
function NodeProblemBanner({
  node,
  nodes,
}: {
  readonly node: NodeView;
  readonly nodes: readonly NodeView[];
}) {
  if (!isUnhealthy(node.status)) return null;
  // Not one condition: `blocked` moves when a person acts and `skipped` never will.
  // They share a banner because neither is this node's own failure — the heading
  // below states which of the two it is, and the term list names the difference.
  const dependencyDecided =
    node.status === "blocked" || node.status === "skipped";
  // The same chain the graph card's line reads, so the card and the view it opens
  // cannot explain one failure two ways.
  const detail = recordedReason(node);
  // `|| undefined`, not `?? undefined`: a recorded empty string is a field the run
  // wrote nothing into, and treating it as a reason would head a term with no value.
  const error = node.result?.error || undefined;
  const exitCode = node.result?.exit_code;
  return (
    // `Alert` carries `role="alert"` itself, so opening a node that is in trouble
    // announces what is wrong rather than leaving it to be noticed.
    // Held work takes the warning tone its badge and card already carry, not the
    // failure's red: it has not gone wrong, it is waiting on something that has.
    <Alert
      className={cn(
        "m-5 w-auto",
        dependencyDecided && "border-warning bg-warning-surface text-warning",
      )}
      variant={dependencyDecided ? "default" : "destructive"}
    >
      {dependencyDecided ? <OctagonPause /> : <TriangleAlert />}
      <AlertTitle>
        {dependencyDecided
          ? `This node is ${node.status}`
          : `This node ${node.status === "cancelled" ? "was cancelled" : node.status === "not-completed" ? "did not complete" : "failed"}${
              node.failure ? `: ${node.failure.class}` : ""
            }`}
      </AlertTitle>
      <AlertDescription>
        <dl className="facts">
          {dependencyDecided && (
            <div>
              <dt>{node.status === "skipped" ? "Unmet" : "Blocked by"}</dt>
              <dd>
                {node.blockers.length > 0
                  ? node.blockers
                      .map((blocker) => {
                        const status = nodes.find(
                          (other) => other.id === blocker,
                        )?.status;
                        return status === undefined
                          ? blocker
                          : `${blocker} (${status})`;
                      })
                      .join(", ")
                  : "Nothing recorded; the run has not written what holds it."}
              </dd>
            </div>
          )}
          {node.status === "skipped" && (
            <div>
              <dt>Attempts</dt>
              <dd>Never attempted</dd>
            </div>
          )}
          {!dependencyDecided && (
            <div>
              <dt>Detail</dt>
              <dd>{detail ?? "No reason was recorded for this outcome."}</dd>
            </div>
          )}
          {/* The recorded error is shown beside the detail rather than instead of
              it: a lifecycle records prose in `detail` and the scheduler records the
              exception text in `error`, and they are usually not the same sentence.
              When they are, the chain above already led with it. */}
          {error !== undefined && error !== detail && (
            <div>
              <dt>Error</dt>
              <dd>{error}</dd>
            </div>
          )}
          {typeof exitCode === "number" && (
            <div>
              <dt>Exit code</dt>
              <dd>{exitCode}</dd>
            </div>
          )}
        </dl>
      </AlertDescription>
    </Alert>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "")
    return "Not recorded";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
