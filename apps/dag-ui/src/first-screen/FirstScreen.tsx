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
 * schema: this path counts against a run's first second. The answer is parsed when the
 * app takes it over.
 */
import { layoutDag } from "@onepipeline-ui/dag-layout";
import type { LiveRunDetail, RunTimeline } from "@onepipeline-ui/dag-model";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { graphTimeline } from "../features/timeline/graph-timeline";
import {
  nodeTimelineV2,
  transcriptEntries,
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
  nodeReason,
  nodeViews,
} from "../lib/run-model";
import { formatDurationSeconds } from "../lib/time";
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

function Graph({ nodes }: { readonly nodes: readonly NodeView[] }) {
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
      (node.task.deps ?? [])
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
  // The transform the canvas's own `fitView` arrives at, so the real canvas replaces
  // these cards where they stand.
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
            // biome-ignore lint/a11y/useKeyWithClickEvents: the card mirrors the canvas's, which takes the pointer alone; the list beside it is the keyboard path, as on the real one.
            <article
              aria-label={`${node.label}: ${node.state}`}
              className={`dag-node state-${node.state} token-${node.style}`}
              key={node.id}
              // The list beside this canvas is the keyboard path, as on the real one.
              onClick={() => openNode(node.id)}
              style={{
                position: "absolute",
                left: node.x,
                top: node.y,
                width: node.width,
                minHeight: node.height,
              }}
            >
              <div className="node-heading">
                <span className="eyebrow">{node.kind}</span>
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
  return (
    <div
      aria-label={`Timeline plot ${label}`}
      className="first-plot"
      data-first-plot-range={`${range[0]},${range[1]}`}
      role="img"
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
        <div className="section-heading">
          <h3>Graph timeline</h3>
        </div>
        <div className="graph-timeline">
          <Plot
            items={graph.line.items.map((item) => ({
              id: item.id,
              start: item.start,
              end: item.end ?? graph.range[1],
            }))}
            label="Graph timeline"
            range={graph.range}
          />
        </div>
      </div>
    </div>
  );
}

function NodeTimeline({
  timeline,
  node,
}: {
  readonly timeline?: RunTimeline;
  readonly node: NodeView;
}) {
  const projection = nodeTimelineV2(timeline, node.id);
  const reading = transcriptEntries(projection.tree, new Set());
  const rows = reading.flatMap((entry) =>
    entry.entryKind === "row" ? [entry.row] : [],
  );
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
  return (
    <section aria-label={`Timeline for ${node.label}`} className="node-view">
      <header className="node-view-head">
        <span className="breadcrumb-node">{node.label}</span>
        <div className="node-view-facts">
          <span className="node-view-state">{node.status}</span>
          <span className="node-view-meta">
            {node.kind} node · turns {LOADING_TEXT}
          </span>
        </div>
      </header>
      <section
        aria-label="Node timeline"
        className="node-timeline-sticky"
        data-testid="node-timeline"
      >
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
      <section aria-label="Node transcript" className="node-transcript">
        {unheld.length > 0 && (
          <button className="load-earlier" disabled type="button">
            Load earlier rows
          </button>
        )}
        {rows.map((row) => (
          <article
            aria-label={row.displayLabel}
            className="transcript-item"
            key={row.id}
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
              <span className="eyebrow">{row.displayKind}</span>
              <strong>{row.displayLabel}</strong>
            </button>
          </article>
        ))}
      </section>
    </section>
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
        <div className="min-h-0 flex-1">{children}</div>
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
  const opened = nodes.find((node) => node.id === address.nodeId);
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
