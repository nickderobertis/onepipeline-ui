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
  CardContent,
  ScrollArea,
  Timeline,
} from "@oneharness/ui";
import type {
  LiveRunDetail,
  RunStatus,
  RunTimeline,
} from "@onepipeline-ui/dag-model";
import type { TelemetryClient } from "@onepipeline-ui/telemetry-client";
import type { EventType } from "@onepipeline-ui/timeline-categories";
import { Activity, Clock3, Cpu, Layers3, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LOADING_TEXT, loaded } from "../../lib/loading";
import { RunStateBadge } from "../../lib/RunStateBadge";
import {
  doneCount,
  launchLabel,
  type NodeView,
  type RunState,
} from "../../lib/run-model";
import { Timestamp } from "../../lib/Timestamp";
import { formatDuration, formatDurationSeconds } from "../../lib/time";
import type { Read } from "../../lib/useRead";
import { boundedZoom, TIMELINE_TIME_MARKS } from "./axis";
import { EventListHeader, FilteredEmpty } from "./EventList";
import {
  type GraphRow,
  type GraphSegment,
  graphTimeline,
} from "./graph-timeline";
import { HistoryFailed } from "./history-controls";
import { TranscriptEntries } from "./NodeTimelineView";
import { TimelineItemDetail } from "./TimelineItemDetail";
import { useTimelineHoverReport } from "./TimelinePopover";
import {
  eventAsRow,
  eventList,
  findRow,
  pathTo,
  runEventRows,
  spanAsRow,
  type TimelineRow,
  transcriptEntries,
  typeCounts,
} from "./timeline-model";
import { type TimelineHistory, useTimelineHistory } from "./useTimelineHistory";

/**
 * The run as a whole, read as one clock rather than as a list of its parts.
 *
 * There are three linked levels here and each is one click from the next. The graph
 * timeline collapses to a single line — what the run has spent its life on, silence
 * included — opens into one row per node beside the run's own driving sessions, and
 * each of those rows opens again into the category lanes the node view draws. Every
 * row is plotted on one controlled range, so zooming any of them zooms all of them and
 * a column always means the same instant however deep the reader is.
 *
 * There is deliberately no time cursor at this level: a cursor locks a plot to a
 * position in a stream being read beside it, and a graph is many streams at once.
 */
export function OverallView({
  client,
  detail,
  nodes,
  timeline: served,
  timelineError,
  hiddenTypes = [],
  onHiddenTypesChange = () => {},
  onRetry,
  journalSeq,
  onSelectNode,
  selectedItemId,
  onSelectItem,
  state,
  status,
}: {
  readonly client: TelemetryClient;
  readonly detail: LiveRunDetail;
  /** The run's one state, shown once here, in the Whole DAG card. */
  readonly state?: RunState;
  /** The run's status read, which the run details card shows. */
  readonly status: Read<RunStatus>;
  /** The event types the reader hid from the run's event list. */
  readonly hiddenTypes?: readonly EventType[];
  readonly onHiddenTypesChange?: (hidden: readonly EventType[]) => void;
  /** Subscribe again, from a failed read. */
  readonly onRetry?: () => void;
  readonly nodes: readonly NodeView[];
  readonly timeline?: RunTimeline;
  readonly timelineError?: Error;
  /** The journal sequence number of the last record this view has rendered. */
  readonly journalSeq?: number;
  readonly onSelectNode: (nodeId: string) => void;
  readonly selectedItemId?: string;
  readonly onSelectItem: (itemId?: string) => void;
}) {
  const runId = detail.run.run_id;
  const history = useTimelineHistory({
    client,
    runId,
    scope: "run",
    ...(served === undefined ? {} : { timeline: served }),
  });
  const timeline = history.timeline;
  const runLoaded = loaded(detail.progress);
  const graph = useMemo(
    () => graphTimeline(timeline, nodes),
    [timeline, nodes],
  );
  // The one run-level item an operator opened, projected exactly as the node view
  // projects a node's own, so both readings are the same reading.
  //
  // A *record* as well as a session, because some records belong to the run and to
  // nothing under it: `onevcs` observes a release long after the dispatch that
  // produced the work has settled and outside any session of it, so it is stamped
  // with no node and this lane is the only place a reader meets it. The plot has
  // always drawn those markers as focusable buttons; before this they selected an
  // id nothing rendered, and pressing Enter on one did nothing at all.
  const runLevel = (timeline?.spans ?? []).filter(
    (span) => span.node_id === undefined,
  );
  const hidden = useMemo(() => new Set(hiddenTypes), [hiddenTypes]);
  // The run's own records, as its event list reads them.
  const runRows = useMemo(() => runEventRows(timeline), [timeline]);
  const listed = useMemo(() => eventList(runRows, hidden), [runRows, hidden]);
  const openedSpan = runLevel.find((span) => span.id === selectedItemId);
  const openedEvent =
    runLevel
      .flatMap((span) => span.events)
      .find((event) => (event.record_id ?? event.id) === selectedItemId) ??
    runLevel
      .flatMap((span) => span.events)
      .find((event) => event.id === selectedItemId);
  const listedRow =
    selectedItemId === undefined ? undefined : findRow(listed, selectedItemId);
  const opened: TimelineRow | undefined =
    openedSpan === undefined
      ? (listedRow ??
        (openedEvent === undefined ? undefined : eventAsRow(openedEvent)))
      : spanAsRow(openedSpan);
  const { loadSpan, forgetSpan, loadRow: loadRunLevel } = history;
  // An address naming a record this payload does not list is a person asking for it.
  useEffect(() => {
    if (
      selectedItemId !== undefined &&
      opened === undefined &&
      timeline !== undefined
    )
      loadRunLevel(undefined);
  }, [selectedItemId, opened, timeline, loadRunLevel]);
  const openedSpanId = openedSpan?.id;
  useEffect(() => {
    if (openedSpanId === undefined) return;
    loadSpan(openedSpanId);
    // A panel closed, or another opened, takes its span's failed read with it.
    return () => forgetSpan(openedSpanId);
  }, [openedSpanId, loadSpan, forgetSpan]);
  const spanFailure =
    openedSpanId === undefined ? undefined : history.spanFailure(openedSpanId);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedItemId !== undefined)
        onSelectItem();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelectItem, selectedItemId]);

  return (
    <div className="overall-view" data-journal-seq={journalSeq}>
      <ScrollArea className="h-full">
        <div className="p-[34px] max-sm:p-3">
          <section aria-label="Whole DAG" className="overall-hero">
            <p className="eyebrow">Whole DAG</p>
            <h2>{runId}</h2>
            {detail.graph?.plan.goal?.text && (
              <p className="run-goal">{detail.graph.plan.goal.text}</p>
            )}
            <p className="overall-state">
              {state !== undefined && <RunStateBadge large state={state} />}
              <span>
                {detail.run.last_event
                  ? `last event ${detail.run.last_event}`
                  : "no events recorded yet"}
              </span>
            </p>
          </section>
          <section aria-label="Run metrics" className="metric-grid">
            <Metric icon={<Layers3 />} label="Nodes" value={doneCount(nodes)} />
            <Metric
              icon={<Clock3 />}
              label="Wall time"
              /* Schema 11 serves an unmeasured timing as null, and a run whose
                 clock nothing could aggregate is one of them: it reads as
                 unknown rather than as a run that took no time at all.
                 llmlint: ignore[changed_behavior_has_e2e] a browser reaches this
                 only against a server whose sibling telemetry producer is
                 missing, and the tier runs one server for every journey — the
                 same reason the timeline-unavailable branches below carry this.
                 App.test.tsx drives it through the real telemetry client, and
                 `a_run_whose_telemetry_cannot_be_read_is_served_with_no_clock_at_all`
                 drives the server that produces the null. */
              value={
                detail.run.timing.wall_seconds === null
                  ? "not measured"
                  : formatDurationSeconds(detail.run.timing.wall_seconds)
              }
            />
            <Metric
              icon={<Cpu />}
              label="Turns"
              value={
                typeof detail.run.turns === "number"
                  ? String(detail.run.turns)
                  : LOADING_TEXT
              }
            />
            <RunDetails detail={detail} runLoaded={runLoaded} status={status} />
          </section>
          <Card className="gap-0 py-[15px]">
            <CardContent className="px-[15px]">
              <div className="section-heading">
                <Activity size={16} />
                <h3>Graph timeline</h3>
              </div>
              {/* llmlint: ignore[changed_behavior_has_e2e] the run detail and the
                  timeline are read from the same strict journal, so no served run
                  fails one and not the other; a browser reaches this only when the
                  whole API is unreachable, which the offline journey covers at the
                  header banner. App.test.tsx proves this surface through the real
                  client. */}
              {timelineError !== undefined ? (
                <Alert className="live-issue" variant="destructive">
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
                <p
                  aria-live="polite"
                  className="m-0 text-[11px] text-muted-foreground"
                >
                  Loading the run's timeline…
                </p>
              ) : timeline.spans.length === 0 ? (
                <p className="m-0 text-[11px] text-muted-foreground">
                  This run has recorded no timeline yet.
                </p>
              ) : (
                <GraphExecution
                  graph={graph}
                  history={history}
                  // A harness session's rows are its transcript's, never the run's
                  // own: it has none to load.
                  runRecordsToLoad={runLevel.some(
                    (span) =>
                      span.harness_scope === undefined &&
                      (span.events_total === undefined ||
                        span.events_total > span.events.length),
                  )}
                  onOpenNode={onSelectNode}
                  onOpenItem={onSelectItem}
                  selectedItemId={selectedItemId}
                />
              )}
            </CardContent>
          </Card>
          {timeline !== undefined && timeline.spans.length > 0 && (
            <RunEvents
              counts={typeCounts(runRows)}
              hidden={hidden}
              listed={listed}
              onHiddenChange={onHiddenTypesChange}
              onOpen={onSelectItem}
              recorded={runRows.length}
              {...(selectedItemId === undefined ? {} : { selectedItemId })}
            />
          )}
        </div>
      </ScrollArea>
      {opened !== undefined && (
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
          <TimelineItemDetail client={client} row={opened} runId={runId} />
          {/* The opened span's own read, said where the person who opened it is
              looking, and gone with the panel. */}
          {spanFailure !== undefined && <HistoryFailed failure={spanFailure} />}
        </aside>
      )}
    </div>
  );
}

/**
 * The nested plot: the line, and the rows it opens into.
 *
 * The range is held here and handed to every instance, which is the whole of what
 * "one scale" means: the upstream plot positions everything against the range it is
 * given, so a wheel or a brush anywhere reframes the lot together.
 */
function GraphExecution({
  graph,
  history,
  runRecordsToLoad,
  onOpenNode,
  onOpenItem,
  selectedItemId,
}: {
  readonly graph: ReturnType<typeof graphTimeline>;
  readonly history: TimelineHistory;
  /** Whether the run's own records are not all held. */
  readonly runRecordsToLoad: boolean;
  readonly onOpenNode: (nodeId: string) => void;
  /**
   * Open one plotted item beside the plot, by the id it is selected under. Not a
   * session: what a run-level lane plots is a session *or* a record the run made
   * at no node, and both are read in the same panel.
   */
  readonly onOpenItem: (itemId?: string) => void;
  readonly selectedItemId?: string;
}) {
  // A different run is a different clock, and none of this framing follows it there:
  // selecting one leaves its timeline unread until the new one lands, so the branch
  // above renders instead and this whole region unmounts with its state. Resetting it
  // by hand as well would be a second answer nothing could tell from the first — it
  // was here, and no test could distinguish having it from not.
  //
  // A *live* run's extent grows on every poll and deliberately does not reset: a
  // reader who zoomed in asked to stay there.
  const [zoom, setZoom] = useState<readonly [number, number]>();
  const [rowsOpen, setRowsOpen] = useState(false);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const range = zoom ?? graph.range;
  const [runRecordsAsked, setRunRecordsAsked] = useState(false);
  // A zoom is a person asking about a stretch: the run-level records in it are read
  // now; the rows of a node arrive when its row is opened.
  const { loadRow, loadStretch } = history;
  useEffect(() => {
    if (zoom === undefined) return;
    const asking = setTimeout(
      () => loadStretch(zoom[0], zoom[1], undefined),
      250,
    );
    return () => clearTimeout(asking);
  }, [zoom, loadStretch]);
  const open = (segment: GraphSegment) => {
    // A record the run made at **no node** opens as itself, because there is
    // nowhere else to read it: `onevcs` observes a release, and a person
    // acknowledges one, long after the dispatch that produced the work has
    // settled and outside any session of it, so no node view holds them and this
    // lane is where a reader meets them. The plot has always drawn those markers
    // as focusable buttons; before this they selected an id nothing rendered.
    if (segment.kind === "record" && segment.nodeId === undefined)
      onOpenItem(segment.id);
    else if (segment.nodeId !== undefined) onOpenNode(segment.nodeId);
    else onOpenItem(segment.id);
  };
  const reportHover = useTimelineHoverReport();
  const lineLanes = graph.line.lanes.filter(({ id }) =>
    graph.line.items.some((item) => item.laneId === id),
  );

  return (
    <div className="graph-timeline" data-rows-open={rowsOpen}>
      <Timeline
        {...TIMELINE_TIME_MARKS}
        axis={{ origin: graph.range[0] }}
        expanded={false}
        items={graph.line.items}
        label="Graph timeline"
        lanes={lineLanes}
        markers={graph.line.markers}
        onExpandedChange={setRowsOpen}
        onHover={reportHover}
        onRangeChange={(next) => setZoom(boundedZoom(next))}
        onSelect={(entry) => open(entry.payload)}
        range={range}
        selectedId={selectedItemId}
      />
      {/* The reads this plot asked for: a row's, a stretch's, the run's own. */}
      {history.failure !== undefined && (
        <HistoryFailed failure={history.failure} />
      )}
      {/* Records the run made at no node, those after execution ended among them,
          are read when asked for: a whole run's records are no part of opening it,
          and the run's event list below reads them as they arrive. */}
      {runRecordsToLoad && !runRecordsAsked && (
        <button
          className="load-earlier"
          onClick={() => {
            setRunRecordsAsked(true);
            loadRow(undefined);
          }}
          type="button"
        >
          Load the run's own records
        </button>
      )}
      {rowsOpen && (
        <ol className="graph-rows">
          {graph.rows.map((row) => (
            <GraphRowView
              key={row.id}
              onOpen={open}
              onOpenNode={onOpenNode}
              onExpandedChange={(next) => {
                if (next) loadRow(row.nodeId);
                setOpenRows((current) => {
                  const updated = new Set(current);
                  if (next) updated.add(row.id);
                  else updated.delete(row.id);
                  return updated;
                });
              }}
              expanded={openRows.has(row.id)}
              origin={graph.range[0]}
              range={range}
              onRangeChange={(next) => setZoom(boundedZoom(next))}
              row={row}
              selectedItemId={selectedItemId}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/** A scroll position the run's event list does not keep: it is read top to bottom. */
const NO_SCROLL_SYNC = () => {};

/**
 * The run's own event list: every record it made at no node — those after its
 * graph ended among them — in the order it made them, read exactly as a node's
 * list is read: one row per surface, the types the reader kept, and each
 * back-to-back repeat as one block.
 */
function RunEvents({
  counts,
  hidden,
  listed,
  onHiddenChange,
  onOpen,
  recorded,
  selectedItemId,
}: {
  readonly counts: ReturnType<typeof typeCounts>;
  readonly hidden: ReadonlySet<EventType>;
  readonly listed: readonly TimelineRow[];
  readonly onHiddenChange: (hidden: readonly EventType[]) => void;
  readonly onOpen: (id: string) => void;
  /** How many of the run's own records the list was drawn from. */
  readonly recorded: number;
  readonly selectedItemId?: string;
}) {
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set());
  // A row the address names opens every block holding it.
  const openNow = useMemo(() => {
    if (selectedItemId === undefined) return openRuns;
    const holding = pathTo(listed, selectedItemId)
      .filter((row) => row.rowKind === "group")
      .map(({ id }) => id);
    return holding.length === 0 ? openRuns : new Set([...openRuns, ...holding]);
  }, [listed, openRuns, selectedItemId]);
  const reading = useMemo(
    () => transcriptEntries(listed, openNow),
    [listed, openNow],
  );
  const toggle = useCallback(
    (id: string) =>
      setOpenRuns((open) => {
        const next = new Set(open);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return (
    <Card className="mt-4 gap-0 py-[15px]">
      <CardContent className="px-[15px]">
        <section aria-label="Run events" className="run-events">
          <EventListHeader
            counts={counts}
            hidden={hidden}
            onHiddenChange={onHiddenChange}
          />
          {recorded === 0 ? (
            <p className="m-0 text-[11px] text-muted-foreground">
              No record of the run's own is held yet.
            </p>
          ) : listed.length === 0 ? (
            <FilteredEmpty onClear={() => onHiddenChange([])} />
          ) : (
            <TranscriptEntries
              entries={reading}
              onOpen={onOpen}
              onToggle={toggle}
              register={NO_SCROLL_SYNC}
              {...(selectedItemId === undefined ? {} : { selectedItemId })}
            />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** One row of the graph: a node, or the sessions that drove the whole run. */
function GraphRowView({
  row,
  range,
  origin,
  expanded,
  onExpandedChange,
  onRangeChange,
  onOpen,
  onOpenNode,
  selectedItemId,
}: {
  readonly row: GraphRow;
  readonly range: readonly [number, number];
  readonly origin: number;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onRangeChange: (range: readonly [number, number]) => void;
  readonly onOpen: (segment: GraphSegment) => void;
  readonly onOpenNode: (nodeId: string) => void;
  readonly selectedItemId?: string;
}) {
  const nodeId = row.nodeId;
  const reportHover = useTimelineHoverReport();
  return (
    <li className="graph-row" data-row-kind={row.kind}>
      <header className="graph-row-head">
        {/* The run-level row names the sessions that drive the graph, and there is no
            node behind it to open — so it is a name rather than a control that would
            promise a reading it cannot give. */}
        {nodeId === undefined ? (
          <span className="graph-row-name">{row.label}</span>
        ) : (
          <button
            className="graph-row-name"
            onClick={() => onOpenNode(nodeId)}
            type="button"
          >
            {row.label}
          </button>
        )}
        <span className="graph-row-facts">
          {formatDuration(row.workedMs)} recorded · {formatDuration(row.idleMs)}{" "}
          idle
        </span>
      </header>
      <Timeline
        {...TIMELINE_TIME_MARKS}
        axis={{ origin }}
        expanded={expanded}
        items={expanded ? row.items : row.line}
        label={`${row.label} timeline`}
        lanes={row.lanes}
        markers={row.markers}
        onExpandedChange={onExpandedChange}
        onHover={reportHover}
        onRangeChange={onRangeChange}
        onSelect={(entry) => onOpen(entry.payload)}
        range={range}
        selectedId={selectedItemId}
      />
    </li>
  );
}

/**
 * Who launched the run, what it has raised that nobody has read, and when it last
 * moved: one card of label and value pairs beside the tiles. The unread count is
 * the status read the run took when it opened, read again on Refresh.
 */
function RunDetails({
  detail,
  status,
  runLoaded,
}: {
  readonly detail: LiveRunDetail;
  readonly status: Read<RunStatus>;
  readonly runLoaded: boolean;
}) {
  const unread = status.value?.unread_surfaces;
  const lastProgress = detail.run.last_progress_at;
  return (
    <Card
      aria-label="Run details"
      className="metric run-details gap-2 p-4"
      role="group"
    >
      <p>Run details</p>
      <dl>
        <div>
          <dt>Launching session</dt>
          <dd>{runLoaded ? launchLabel(detail.launch) : LOADING_TEXT}</dd>
        </div>
        <div>
          <dt>Unread surfaces</dt>
          <dd>
            {unread === undefined
              ? status.error === undefined
                ? LOADING_TEXT
                : "Unavailable"
              : unread.oldest_seconds === null
                ? String(unread.count)
                : `${unread.count} · oldest ${formatDurationSeconds(unread.oldest_seconds)}`}
            {/* A reading already shown stays beside this, so a failed re-read
                says the figure is the last one served. */}
            {status.error !== undefined && (
              <span className="run-details-error" role="alert">
                {" "}
                Status unavailable: {status.error.message}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Last progress</dt>
          <dd>
            {/* How long the run's journal has been quiet, read off its own last
                write; a run that recorded none has no moment to count from. */}
            <output aria-label="Last progress">
              {!runLoaded ? (
                LOADING_TEXT
              ) : lastProgress === undefined || lastProgress <= 0 ? (
                "—"
              ) : (
                <Timestamp
                  at={new Date(lastProgress * 1000).toISOString()}
                  relative
                />
              )}
            </output>
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    // The label and the value are two lines with nothing tying them together, so the
    // tile is grouped and named by its label: "Wall time" reaches this one rather
    // than whichever card happens to be fourth.
    <Card
      aria-label={label}
      className="metric flex-row items-center gap-3 p-4"
      role="group"
    >
      {icon}
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </Card>
  );
}
