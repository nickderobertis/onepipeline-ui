// llmlint: ignore-file[changed_behavior_has_e2e] apps/dag-ui-e2e/read-latency drives this chunk
// against the real release server: the marks read this DOM, and each is held to the answer
// it was drawn from and that answer to the complete document.
/**
 * A run's first useful screen, drawn from the first answer alone and replaced by the
 * real app when that chunk arrives.
 *
 * It holds the real app's landmarks, classes and accessible names, so the swap moves
 * nothing a reader is looking at, and it reads the answer through the app's own view
 * models. Nothing here pulls the design system or the flow canvas in, and it parses no
 * schema: this path counts against a run's first second. `check.ts` holds every field
 * it reads to its type before it is drawn, and the app parses the answer whole when it
 * takes it over.
 */
import { layoutDag } from "@onepipeline-ui/dag-layout";
import type { LiveRunDetail, RunTimeline } from "@onepipeline-ui/dag-model";
import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { graphTimeline } from "../features/timeline/graph-timeline";
import {
  collapseLabel,
  nodeTimelineV2,
  type TimelineRow,
  transcriptEntries,
  transcriptRuns,
} from "../features/timeline/timeline-model";
import {
  HISTORY_LOADING_TEXT,
  LOADING_TEXT,
  STILL_LOADING_TEXT,
} from "../lib/loading";
import {
  awaitedLine,
  isUnhealthy,
  type NodeView,
  nodeKindWord,
  nodeReason,
  nodeViews,
  openedNode,
} from "../lib/run-model";
import { Timestamp } from "../lib/Timestamp";
import { formatDuration, formatDurationSeconds } from "../lib/time";
import type { FirstAddress } from "./address";

/** The part of a subscription's first answer this screen reads. */
export interface FirstAnswer {
  readonly subscription: string;
  readonly initial: {
    readonly snapshot: {
      readonly visible: {
        readonly detail: LiveRunDetail;
        readonly timeline?: RunTimeline;
      };
    };
  };
}

/**
 * Room the app takes on arrival, drawn as a static box of the size and place the app
 * draws it at, so nothing this screen draws moves when the app replaces it. Out of the
 * accessibility tree and out of reach of the pointer and keyboard: it is not a control
 * until the app's own is there.
 */
function Reserved({
  className,
  children,
}: {
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div aria-hidden="true" className={className} inert>
      {children}
    </div>
  );
}

/** Where the app draws an icon beside a label, at that icon's size. */
function IconRoom({ size }: { readonly size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: size,
        height: size,
      }}
    />
  );
}

/** The app's line-variant tab row: labels where the app's tabs are, nothing to press. */
const TAB_ROW =
  "inline-flex h-9 w-fit items-center justify-center gap-1 rounded-none p-[3px] text-sm font-medium text-muted-foreground";
const TAB =
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 whitespace-nowrap";

/** The legend and controls row above a timeline plot, at its height. */
function TimelineHead() {
  return <Reserved className="mb-3 h-8" />;
}

/**
 * Carry a person's click over to the app arriving behind this screen: the address
 * says what they asked for, and the app reads it when it mounts or on this event.
 */
function ask(change: (params: URLSearchParams) => void): void {
  const params = new URLSearchParams(window.location.search);
  change(params);
  window.history.pushState(null, "", `${window.location.pathname}?${params}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function openNode(id: string): void {
  ask((params) => {
    params.set("node", id);
    params.set("view", "graph");
    params.delete("event");
  });
}

/**
 * The first screen's graph: its layout through the real `layoutDag`, each card's
 * reason and awaits line, and the transform the canvas's own `fitView` arrives at, so
 * the real canvas replaces these cards where they stand.
 */
function useFirstGraph(nodes: readonly NodeView[]) {
  const reasons = new Map(
    nodes.map((node) => [
      node.id,
      isUnhealthy(node.status) ? nodeReason(node) : undefined,
    ]),
  );
  const awaits = new Map(nodes.map((node) => [node.id, awaitedLine(node)]));
  const drawn = new Set(nodes.map((node) => node.id));
  const layout = layoutDag({
    nodes: nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      state: node.status,
      ...(awaits.get(node.id) === undefined ? {} : { lines: 1 }),
    })),
    edges: nodes.flatMap((node) =>
      (node.task?.deps ?? [])
        .filter((dep) => drawn.has(dep))
        .map((dep) => ({
          id: `${dep}->${node.id}`,
          source: dep,
          target: node.id,
        })),
    ),
  });
  const width = Math.max(...layout.nodes.map((node) => node.x + node.width), 0);
  const height = Math.max(
    ...layout.nodes.map((node) => node.y + node.height),
    0,
  );
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ zoom: 1, x: 0, y: 0 });
  useLayoutEffect(() => {
    const box = wrap.current;
    if (box === null || width === 0 || height === 0) return;
    const padding = 1.2;
    const zoom = Math.min(
      Math.max(
        Math.min(
          box.clientWidth / (width * padding),
          box.clientHeight / (height * padding),
        ),
        0.05,
      ),
      2,
    );
    setFit({
      zoom,
      x: box.clientWidth / 2 - (width / 2) * zoom,
      y: box.clientHeight / 2 - (height / 2) * zoom,
    });
  }, [width, height]);
  return { layout, reasons, awaits, width, height, wrap, fit };
}

function Graph({ nodes }: { readonly nodes: readonly NodeView[] }) {
  const { layout, reasons, awaits, width, height, wrap, fit } =
    useFirstGraph(nodes);
  return (
    <div
      className="graph-wrap first-graph"
      data-testid="first-screen-graph"
      ref={wrap}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a canvas of positioned cards, named as the real canvas is; `fieldset` is for controls. */}
      <div
        aria-label="DAG execution graph"
        role="group"
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "0 0",
          transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.zoom})`,
        }}
      >
        <svg
          aria-hidden="true"
          height={height}
          style={{ position: "absolute", left: 0, top: 0 }}
          width={width}
        >
          {layout.edges.map((edge) => (
            <polyline
              fill="none"
              key={edge.id}
              points={edge.points.map((at) => `${at.x},${at.y}`).join(" ")}
              stroke="currentColor"
              strokeOpacity={0.35}
            />
          ))}
        </svg>
        {layout.nodes.map((node) => {
          const reason = reasons.get(node.id);
          const awaited = awaits.get(node.id);
          return (
            // The canvas's node wrapper: the layout's place and size, which the card fills.
            <div
              key={node.id}
              style={{
                position: "absolute",
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
              }}
            >
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the card mirrors the canvas's, which takes the pointer alone; the list beside it is the keyboard path, as on the real one. */}
              <article
                aria-label={`${node.label}: ${node.state}`}
                className={`dag-node state-${node.state} token-${node.style}`}
                onClick={() => openNode(node.id)}
              >
                <div className="node-heading">
                  <span className="inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-border px-1.5 py-0 text-[9px] font-medium tracking-[.1em] whitespace-nowrap text-foreground uppercase">
                    {node.kind}
                  </span>
                  <IconRoom size={17} />
                </div>
                <strong>{node.label}</strong>
                <span className="node-status">{node.state}</span>
                {reason !== undefined && (
                  <span className="node-reason" title={reason}>
                    {reason}
                  </span>
                )}
                {awaited !== undefined && (
                  <span className="node-awaits" title={awaited}>
                    {awaited}
                  </span>
                )}
              </article>
            </div>
          );
        })}
      </div>
      <ol aria-label="DAG nodes" className="accessible-node-list">
        {nodes.map((node) => (
          <li key={node.id}>
            <button onClick={() => openNode(node.id)} type="button">
              {node.label}: {node.status}
              {reasons.get(node.id) === undefined
                ? ""
                : ` — ${reasons.get(node.id)}`}
              {awaits.get(node.id) === undefined
                ? ""
                : ` — ${awaits.get(node.id)}`}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A plotted line over its whole axis, every span at its true place. */
function Plot({
  items,
  range,
  label,
  unheld = [],
}: {
  readonly items: readonly {
    readonly id: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly range: readonly [number, number];
  readonly label: string;
  readonly unheld?: readonly (readonly [number, number])[];
}) {
  const span = Math.max(range[1] - range[0], 1);
  const percent = (time: number) => ((time - range[0]) / span) * 100;
  // The app's plot, collapsed: its frame, one lane the bars sit in, and the axis row.
  return (
    <div
      aria-label={`Timeline plot ${label}`}
      className="first-plot relative overflow-hidden rounded-lg border bg-muted/40 pb-3 pt-7"
      role="img"
    >
      <div className="relative grid gap-2">
        <div
          className="relative h-6 border-b border-border/60"
          data-first-plot-range={`${range[0]},${range[1]}`}
        >
          {items.map((item) => (
            <span
              className="first-plot-bar"
              data-end={item.end}
              data-span-id={item.id}
              data-start={item.start}
              key={item.id}
              style={{
                left: `${percent(item.start)}%`,
                width: `max(${percent(item.end) - percent(item.start)}%, 0.05%)`,
              }}
            />
          ))}
          {unheld.map(([from, to]) => (
            <span
              className="history-hatch"
              data-from={from}
              data-to={to}
              key={`${from}-${to}`}
              style={{
                left: `${percent(from)}%`,
                width: `${percent(to) - percent(from)}%`,
              }}
            >
              <span className="history-hatch-label">{STILL_LOADING_TEXT}</span>
            </span>
          ))}
        </div>
      </div>
      <Reserved className="relative mt-2 h-4" />
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the real tile's grouping, named by its label.
    <div
      aria-label={label}
      className="metric flex flex-row items-center gap-3 rounded-xl border bg-card p-4 text-card-foreground"
      role="group"
    >
      <IconRoom size={24} />
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function Overall({
  detail,
  timeline,
  nodes,
}: {
  readonly detail: LiveRunDetail;
  readonly timeline?: RunTimeline;
  readonly nodes: readonly NodeView[];
}) {
  const graph = graphTimeline(timeline, nodes);
  const turns = detail.run.turns;
  return (
    <div className="overall-view">
      <div className="p-[34px] max-sm:p-3">
        <section className="overall-hero">
          <p className="eyebrow">Whole DAG</p>
          <h2>{detail.run.run_id}</h2>
          {detail.graph?.plan.goal?.text && (
            <p className="run-goal">{detail.graph.plan.goal.text}</p>
          )}
          <p>
            {detail.run.phase} ·{" "}
            {detail.run.last_event
              ? `last event ${detail.run.last_event}`
              : "no events recorded yet"}
          </p>
        </section>
        {/* The run's records, each a closed disclosure in the app. */}
        <Reserved>
          {[
            "Timing and usage",
            "Goal and repository identities",
            "Recorded results",
            "Provider health",
          ].map((record) => (
            <details key={record}>
              <summary>{record}</summary>
            </details>
          ))}
        </Reserved>
        <section aria-label="Run metrics" className="metric-grid">
          <Metric label="Status" value={detail.run.state} />
          <Metric label="Nodes" value={String(detail.run.nodes.length)} />
          <Metric
            label="Wall time"
            value={
              detail.run.timing.wall_seconds === null
                ? "not measured"
                : formatDurationSeconds(detail.run.timing.wall_seconds)
            }
          />
          <Metric
            label="Turns"
            value={typeof turns === "number" ? String(turns) : LOADING_TEXT}
          />
        </section>
        <div className="flex flex-col gap-0 rounded-xl border bg-card py-[15px] text-card-foreground shadow-sm">
          <div className="px-[15px]">
            <div className="section-heading">
              <IconRoom size={16} />
              <h3>Graph timeline</h3>
            </div>
            <div className="graph-timeline">
              <section className="timeline rounded-xl border bg-card p-4">
                <TimelineHead />
                <Plot
                  items={graph.line.items.map((item) => ({
                    id: item.id,
                    start: item.start,
                    end: item.end ?? graph.range[1],
                  }))}
                  label="Graph timeline"
                  range={graph.range}
                />
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A node timeline's first screen: its projection, the transcript's rows, the plot's
 * axis, and the stretch before each span's held rows, which is not yet loaded.
 */
function useFirstNodeTimeline(
  timeline: RunTimeline | undefined,
  nodeId: string,
) {
  const projection = nodeTimelineV2(timeline, nodeId);
  const reading = transcriptEntries(projection.tree, new Set());
  const rows = reading.flatMap((entry) =>
    entry.entryKind === "row" ? [entry.row] : [],
  );
  const entries = reading;
  const starts = projection.items.map((item) => item.start);
  const ends = projection.items.map((item) => item.end ?? item.start);
  const range: readonly [number, number] =
    starts.length === 0
      ? [0, 1]
      : [Math.min(...starts), Math.max(...ends, ...starts) + 1];
  // Where the window starts in each span with rows before it: that stretch is not held.
  const unheld = (timeline?.spans ?? []).flatMap(
    (span): (readonly [number, number])[] => {
      const earliest = span.events[0];
      if (
        span.events_total === undefined ||
        span.events_total <= span.events.length ||
        earliest === undefined
      )
        return [];
      return [[Date.parse(span.started_at), Date.parse(earliest.at)]];
    },
  );
  return { projection, rows, entries, range, unheld };
}

function NodeTimeline({
  timeline,
  node,
}: {
  readonly timeline?: RunTimeline;
  readonly node: NodeView;
}) {
  const { projection, entries, range, unheld } = useFirstNodeTimeline(
    timeline,
    node.id,
  );
  const toLoad = (timeline?.spans ?? []).some(
    (span) =>
      span.events_total !== undefined && span.events_total > span.events.length,
  );
  return (
    <section aria-label={`Timeline for ${node.label}`} className="node-view">
      <header className="node-view-head">
        <nav>
          <ol className="breadcrumb">
            <li>
              <Reserved className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap">
                <IconRoom size={16} />
                Graph
              </Reserved>
            </li>
            <li>
              <span className="breadcrumb-node">{node.label}</span>
            </li>
          </ol>
        </nav>
        <div className="node-view-facts">
          <span className="node-view-state inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium tracking-[.03em] whitespace-nowrap uppercase">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-current"
            />
            {node.status}
          </span>
          <span className="node-view-meta">
            {nodeKindWord(node)} node · turns {LOADING_TEXT}
          </span>
        </div>
      </header>
      <div className="node-tabs">
        <Reserved className="mx-5 inline-flex h-9 w-fit flex-none items-center justify-start gap-1 p-[3px] text-sm font-medium text-muted-foreground">
          {[
            "Timeline",
            "Task",
            "Acceptance criteria",
            "Dependencies",
            "Remote",
          ].map((tab) => (
            <span className={TAB} key={tab}>
              {tab}
            </span>
          ))}
        </Reserved>
        <div className="node-timeline-panel flex-1">
          <div className="node-execution" data-expanded="false">
            <section
              aria-label="Node timeline"
              className="node-timeline-sticky"
              data-testid="node-timeline"
            >
              <section className="timeline rounded-xl border bg-card p-4">
                <TimelineHead />
                <Plot
                  items={projection.items.map((item) => ({
                    id: item.id,
                    start: item.start,
                    end: item.end ?? item.start,
                  }))}
                  label="Node timeline plot"
                  range={range}
                  unheld={unheld}
                />
              </section>
            </section>
            <section aria-label="Node transcript" className="node-transcript">
              {toLoad && (
                <button className="load-earlier" disabled type="button">
                  Load earlier rows
                </button>
              )}
              {transcriptRuns(entries).map((run) => {
                const items = run.entries.map((entry) =>
                  entry.entryKind === "row" ? (
                    <FirstRow key={entry.row.id} row={entry.row} />
                  ) : (
                    <Reserved
                      className="transcript-collapsed"
                      key={`collapse-${entry.group.id}`}
                    >
                      <span>
                        <span aria-hidden="true">…</span>
                        {`Show ${collapseLabel(entry.hidden, entry.group.kind)}`}
                      </span>
                    </Reserved>
                  ),
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
          </div>
        </div>
      </div>
    </section>
  );
}

/** One transcript row as the app draws it, opening the record when pressed. */
function FirstRow({ row }: { readonly row: TimelineRow }) {
  return (
    <article
      aria-label={row.displayLabel}
      className="transcript-item"
      data-row-id={row.id}
    >
      <button
        aria-label={`Open ${row.displayLabel}`}
        onClick={() =>
          ask((params) => {
            params.set("event", row.id);
          })
        }
        type="button"
      >
        <span className="eyebrow">
          {row.rowKind === "event" && <IconRoom size={12} />}
          {row.displayKind}
        </span>
        <strong>{row.displayLabel}</strong>
        <span className="transcript-facts">
          <Timestamp at={row.startedAt} />
          {row.durationMs !== null && ` · ${formatDuration(row.durationMs)}`}
          {` · ${row.status ?? "recorded"}`}
          {row.sessionName !== undefined && ` · ${row.sessionName}`}
        </span>
      </button>
    </article>
  );
}

function Shell({
  address,
  loading,
  children,
}: {
  readonly address: FirstAddress;
  readonly loading: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="app-shell" data-first-screen>
      <nav aria-label="Projects" className="run-nav">
        <div className="px-[18px] py-6 max-sm:px-2">
          <div className="brand">
            <div>
              <p className="eyebrow">Local orchestration</p>
              <h1>DAG Observatory</h1>
            </div>
          </div>
          <p role="status">Loading projects…</p>
        </div>
      </nav>
      <main className="workspace">
        <section aria-label="Run header" className="topbar run-topbar">
          <div className="topbar-title">
            <div>
              <p className="eyebrow">Execution telemetry</p>
              <h2>{address.runId}</h2>
            </div>
          </div>
        </section>
        <Reserved className="run-header-details">
          <details>
            <summary>Run details</summary>
          </details>
        </Reserved>
        <div className="flex min-h-0 flex-1 flex-col gap-0">
          <Reserved className="view-tabs">
            <div className={TAB_ROW}>
              {["Graph", "Overall", "Channel"].map((view) => (
                <span className={TAB} key={view}>
                  <IconRoom size={15} />
                  {view}
                </span>
              ))}
            </div>
            <div className="detail-switch">
              {["Decisions", "Detailed activity"].map((level) => (
                <span
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium whitespace-nowrap"
                  key={level}
                >
                  {level}
                </span>
              ))}
            </div>
          </Reserved>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </main>
      {loading && (
        <p className="history-loading" role="status">
          {HISTORY_LOADING_TEXT}
        </p>
      )}
    </div>
  );
}

/** What stands while the first answer is out. */
export function FirstScreenLoading({
  address,
}: {
  readonly address: FirstAddress;
}) {
  return (
    <Shell address={address} loading={false}>
      <div aria-live="polite" className="loading-state">
        Loading execution history…
      </div>
    </Shell>
  );
}

/** The page the first answer draws, in the real page's frame. */
export function FirstScreen({
  answer,
  address,
}: {
  readonly answer: FirstAnswer;
  readonly address: FirstAddress;
}) {
  const { detail, timeline } = answer.initial.snapshot.visible;
  const nodes = nodeViews(detail);
  const opened = openedNode(detail, nodes, address.nodeId);
  return (
    <Shell address={address} loading={detail.progress?.complete === false}>
      {address.kind === "overall" ? (
        <Overall detail={detail} nodes={nodes} timeline={timeline} />
      ) : opened !== undefined ? (
        <NodeTimeline node={opened} timeline={timeline} />
      ) : (
        <Graph nodes={nodes} />
      )}
    </Shell>
  );
}
