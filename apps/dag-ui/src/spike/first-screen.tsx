// llmlint: ignore-file[changed_behavior_has_e2e] Spike `first-screen` prototype, never
// shipped: only `scripts/spike-run-open-costs-build.sh` builds it, into its own directory,
// and `--measure first-*` of `scripts/spike-run-open-costs.mjs` drives it in a real browser.
/**
 * The cheapest client that draws a run's first screen: no router, no design-system barrel,
 * no flow canvas, no schema validation of a payload it does not draw. It reads the first
 * answer and renders Graph, Overall or a node timeline from it with the real app's own
 * view models and stylesheet, under the same accessible names. The rest of the app is a
 * separate chunk, fetched once the first screen is drawn.
 */
import "../styles.css";
import { layoutDag } from "@onepipeline-ui/dag-layout";
import type { RunDetail, RunTimeline } from "@onepipeline-ui/dag-model";
import { createRoot } from "react-dom/client";
import { graphTimeline } from "../features/timeline/graph-timeline";
import {
  nodeTimelineV2,
  transcriptEntries,
} from "../features/timeline/timeline-model";
import {
  awaitedLine,
  isUnhealthy,
  type NodeView,
  nodeReason,
  nodeViews,
} from "../lib/run-model";
import { formatDurationSeconds } from "../lib/time";

interface FirstAnswer {
  readonly detail: RunDetail;
  readonly timeline?: RunTimeline;
  readonly loading: readonly string[];
}

const Loading = () => (
  <span aria-busy="true" className="first-loading">
    loading
  </span>
);

function isLoading(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { loading?: unknown }).loading === true
  );
}

function RunHeader({ run }: { readonly run: string }) {
  return (
    <section aria-label="Run header" className="topbar run-topbar">
      <div className="topbar-title">
        <div>
          <p className="eyebrow">Execution telemetry</p>
          <h2>{run}</h2>
        </div>
      </div>
    </section>
  );
}

/** The graph as plain positioned cards: the flow canvas loads with the rest of the app. */
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
      lines:
        (reasons.get(node.id) === undefined ? 0 : 1) +
        (awaits.get(node.id) === undefined ? 0 : 1),
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
  return (
    // biome-ignore lint/a11y/useSemanticElements: a canvas of positioned cards, not a form group; `fieldset` is for controls.
    <div
      aria-label="DAG execution graph"
      className="first-graph"
      role="group"
      style={{ position: "relative", width, height }}
    >
      <svg
        aria-hidden="true"
        height={height}
        style={{ position: "absolute", inset: 0 }}
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
          <article
            aria-label={`${node.label}: ${node.state}`}
            className={`dag-node state-${node.state} token-${node.style}`}
            key={node.id}
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
  );
}

const LANE_COLOURS = ["#5b8def", "#35b39a", "#c98b3b", "#b569c9", "#6f7a8c"];

/**
 * A plotted line over its whole axis. A first answer holds every span of the line, so no
 * stretch is ever unheld and nothing here hatches; a source that held less would have to.
 */
function Plot({
  items,
  range,
  label,
}: {
  readonly items: readonly {
    readonly id: string;
    readonly laneId?: string;
    readonly start: number;
    readonly end?: number | null;
  }[];
  readonly range: readonly [number, number];
  readonly label: string;
}) {
  const lanes = [...new Set(items.map((item) => item.laneId))];
  const span = Math.max(range[1] - range[0], 1);
  const at = (time: number) => ((time - range[0]) / span) * 1000;
  return (
    <svg
      aria-label={label}
      data-first-plot={items.length}
      preserveAspectRatio="none"
      role="img"
      style={{ display: "block", width: "100%", height: 40 }}
      viewBox="0 0 1000 40"
    >
      {items.map((item) => {
        const from = at(item.start);
        return (
          <rect
            fill={
              LANE_COLOURS[lanes.indexOf(item.laneId) % LANE_COLOURS.length]
            }
            height={30}
            key={item.id}
            width={Math.max(at(item.end ?? range[1]) - from, 0.5)}
            x={from}
            y={5}
          />
        );
      })}
    </svg>
  );
}

function Overall({
  answer,
  nodes,
}: {
  readonly answer: FirstAnswer;
  readonly nodes: readonly NodeView[];
}) {
  const { detail, timeline } = answer;
  const graph = graphTimeline(timeline, nodes);
  const turns: unknown = detail.run.turns;
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
          <dl>
            <dt>Status</dt>
            <dd>{detail.run.state}</dd>
          </dl>
          <dl>
            <dt>Nodes</dt>
            <dd>{detail.run.nodes.length}</dd>
          </dl>
          <dl>
            <dt>Wall time</dt>
            <dd>
              {detail.run.timing.wall_seconds === null
                ? "not measured"
                : formatDurationSeconds(detail.run.timing.wall_seconds)}
            </dd>
          </dl>
          <dl>
            <dt>Turns</dt>
            <dd>{isLoading(turns) ? <Loading /> : String(turns)}</dd>
          </dl>
        </section>
        <div className="section-heading">
          <h3>Graph timeline</h3>
        </div>
        <div className="graph-timeline">
          <Plot
            items={graph.line.items.map((item) => ({
              id: item.id,
              laneId: item.laneId,
              start: item.start,
              end: item.end,
            }))}
            label="Graph timeline"
            range={graph.range}
          />
          {answer.loading.includes("timeline.spans[harness_scope]") && (
            <p className="eyebrow">
              Session links <Loading />
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeTimeline({
  answer,
  node,
}: {
  readonly answer: FirstAnswer;
  readonly node: NodeView;
}) {
  const projection = nodeTimelineV2(answer.timeline, node.id);
  const reading = transcriptEntries(projection.tree, new Set());
  const rows = reading.flatMap((entry) =>
    entry.entryKind === "row" ? [entry.row] : [],
  );
  const starts = projection.items.map((item) => item.start);
  const ends = projection.items.map((item) => item.end ?? item.start);
  const range: readonly [number, number] = [
    Math.min(...starts),
    Math.max(...ends, ...starts) + 1,
  ];
  return (
    <section aria-label={`Timeline for ${node.label}`} className="node-view">
      <header className="node-view-head">
        <span className="breadcrumb-node">{node.label}</span>
        <div className="node-view-facts">
          <span className="node-view-state">{node.status}</span>
        </div>
      </header>
      <section aria-label="Node timeline" data-testid="node-timeline">
        <Plot
          items={projection.items.map((item) => ({
            id: item.id,
            laneId: item.laneId,
            start: item.start,
            end: item.end,
          }))}
          label="Node timeline plot"
          range={range}
        />
      </section>
      <section aria-label="Node transcript" className="node-transcript">
        {rows.map((row) => (
          <article
            aria-label={row.displayLabel}
            className="transcript-item"
            key={row.id}
          >
            <span className="eyebrow">{row.displayKind}</span>
            <strong>{row.displayLabel}</strong>
          </article>
        ))}
      </section>
    </section>
  );
}

function FirstScreen({
  answer,
  run,
  view,
  nodeId,
}: {
  readonly answer: FirstAnswer;
  readonly run: string;
  readonly view: string | null;
  readonly nodeId: string | null;
}) {
  const nodes = nodeViews(answer.detail);
  const opened = nodes.find((node) => node.id === nodeId);
  return (
    <main className="workspace">
      <RunHeader run={run} />
      {view === "overall" ? (
        <Overall answer={answer} nodes={nodes} />
      ) : opened !== undefined ? (
        <NodeTimeline answer={answer} node={opened} />
      ) : (
        <Graph nodes={nodes} />
      )}
    </main>
  );
}

async function start() {
  const root = document.getElementById("root");
  if (!root) throw new Error("DAG UI root element is missing");
  const params = new URLSearchParams(window.location.search);
  const run = params.get("run");
  if (run === null) {
    // No run: the sidebar alone, which is the read a warm server has answered.
    await fetch("/api/v2/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: { type: "sidebar" } }),
    });
    await import("../app/App");
    return;
  }
  const view = params.get("view");
  const nodeId = params.get("node");
  const answered = await fetch(
    `/api/v2/spike/first-screen?run=${encodeURIComponent(run)}`,
    {
      method: "POST",
      body: view === "overall" ? "overall" : (nodeId ?? "graph"),
    },
  );
  if (!answered.ok) throw new Error(`first answer: ${answered.status}`);
  const answer = (await answered.json()) as FirstAnswer;
  createRoot(root).render(
    <FirstScreen answer={answer} nodeId={nodeId} run={run} view={view} />,
  );
}

await start();
