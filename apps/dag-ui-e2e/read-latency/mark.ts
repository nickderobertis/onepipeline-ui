/**
 * The first useful screen's mark: a rendered state checked against the answer the
 * browser received, and that answer against the complete document. A view's first
 * screen is drawn through the app's own view models, so the expected values here are
 * those models' over the received answer; each failure is named, so a test can hold
 * the check to refusing one wrong value at a time.
 */
import type { LiveRunDetail, RunTimeline } from "@onepipeline-ui/dag-model";
// eslint-disable-next-line @nx/enforce-module-boundaries -- the mark checks the screen against the app's own view models, the spike's check, so the expected value cannot be a second reading of the app.
import { graphTimeline } from "../../dag-ui/src/features/timeline/graph-timeline";
// eslint-disable-next-line @nx/enforce-module-boundaries -- the mark checks the screen against the app's own view models, the spike's check, so the expected value cannot be a second reading of the app.
import {
  nodeTimelineV2,
  transcriptEntries,
} from "../../dag-ui/src/features/timeline/timeline-model";
// eslint-disable-next-line @nx/enforce-module-boundaries -- the mark checks the screen against the app's own view models, the spike's check, so the expected value cannot be a second reading of the app.
import { LOADING_TEXT } from "../../dag-ui/src/lib/loading";
// eslint-disable-next-line @nx/enforce-module-boundaries -- the mark checks the screen against the app's own view models, the spike's check, so the expected value cannot be a second reading of the app.
import {
  awaitedLine,
  isUnhealthy,
  nodeReason,
  nodeViews,
} from "../../dag-ui/src/lib/run-model";
// eslint-disable-next-line @nx/enforce-module-boundaries -- the mark checks the screen against the app's own view models, the spike's check, so the expected value cannot be a second reading of the app.
import { formatDurationSeconds } from "../../dag-ui/src/lib/time";

export type FirstView = "graph" | "overall" | "node";

export interface Bar {
  readonly id: string;
  readonly left: number;
  readonly width: number;
}

export interface Tile {
  readonly value: string | null;
}

export interface ScreenState {
  at: number;
  first: boolean;
  header: string | null;
  hero: string | null;
  hero_lines: string;
  cards: {
    name: string | null;
    reason: string | null;
    awaits: string | null;
  }[];
  status: Tile | null;
  nodes: Tile | null;
  wall: Tile | null;
  turns: Tile | null;
  still_loading: boolean;
  range: readonly [number, number] | null;
  bars: Bar[];
  line: number;
  node_heading: string | null;
  node_state: string | null;
  rows: (string | null)[];
}

// llmlint: ignore-block[e2e_uses_accessible_selectors] a passive observer inside the page, which times the moment a state is on screen and serialises it for `checkScreen`: Playwright's role engine does not exist there, and every reading is of an element the app names (`Run header`, `Run metrics`, `Node transcript`, a card's aria-label) or of the plot's own geometry, which no role carries.
export const SCREEN_OBSERVER = `
(() => {
  const states = [];
  window.__firstScreen = states;
  // The first answer as the page received it: a tee, read beside the page's own use.
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await original(...args);
    const input = args[0];
    const url = String(input?.url ?? input);
    const method = (args[1]?.method ?? input?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("/api/v2/subscriptions") && window.__firstAnswer === undefined) {
      response.clone().text().then((text) => { window.__firstAnswer = text; }, () => {});
    }
    return response;
  };
  const text = (root, selector) => root?.querySelector(selector)?.textContent?.trim() ?? null;
  const tile = (metrics, name) => {
    const found = metrics?.querySelector('[role="group"][aria-label="' + name + '"]');
    return found ? { value: text(found, "strong") } : null;
  };
  const snapshot = () => {
    const metrics = document.querySelector('[aria-label="Run metrics"]');
    const node = document.querySelector('[aria-label^="Timeline for "]');
    const transcript = document.querySelector('[aria-label="Node transcript"]');
    const plot = document.querySelector("[data-first-plot-range]");
    const box = plot?.getBoundingClientRect();
    const raw = plot?.getAttribute("data-first-plot-range");
    const bars = [...document.querySelectorAll(".first-plot-bar")].map((bar) => {
      const at = bar.getBoundingClientRect();
      return {
        id: bar.getAttribute("data-span-id"),
        left: box && box.width > 0 ? ((at.left - box.left) / box.width) * 100 : -1,
        width: box && box.width > 0 ? (at.width / box.width) * 100 : -1,
      };
    });
    return {
      at: performance.now(),
      first: Boolean(document.querySelector("[data-first-screen]")),
      header: text(document, '[aria-label="Run header"] h2'),
      hero: text(document, ".overall-hero h2"),
      hero_lines: [...document.querySelectorAll(".overall-hero p")].map((p) => p.textContent).join("\\n"),
      cards: [...document.querySelectorAll("article.dag-node")].map((card) => ({
        name: card.getAttribute("aria-label"),
        reason: text(card, ".node-reason"),
        awaits: text(card, ".node-awaits"),
      })),
      status: tile(metrics, "Status"),
      nodes: tile(metrics, "Nodes"),
      wall: tile(metrics, "Wall time"),
      turns: tile(metrics, "Turns"),
      still_loading: document.body?.textContent?.includes("still loading") ?? false,
      range: raw ? raw.split(",").map(Number) : null,
      bars,
      line: bars.length,
      node_heading: node?.getAttribute("aria-label") ?? null,
      node_state: text(document, ".node-view-state"),
      rows: transcript ? [...transcript.querySelectorAll(".transcript-item")].map((row) => row.getAttribute("aria-label")) : [],
    };
  };
  const look = () => { states.push(snapshot()); };
  const observer = new MutationObserver(look);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  // Once a reading has its mark, nothing reads the states after it: stopped, so a
  // reading taken later is of the page alone.
  window.__firstScreenStop = () => observer.disconnect();
})();
`;
// llmlint: ignore-end[e2e_uses_accessible_selectors]

/** What a first answer's `visible` holds, as the marks read it. */
export interface Visible {
  readonly detail: LiveRunDetail;
  readonly timeline?: RunTimeline;
}

/** The tolerance of the plot's geometry: 0.02% of the axis. */
const GEOMETRY = 0.02;
/** The first screen draws a span no narrower than this share of the axis. */
const SHORTEST_BAR = 0.05;

function bars(
  state: ScreenState,
  items: readonly { id: string; start: number; end?: number | null }[],
  range: readonly [number, number],
  label: string,
  fallbackEnd: number,
): string[] {
  const out: string[] = [];
  if (state.range === null) out.push(`${label}: no plot range drawn`);
  else if (state.range[0] !== range[0] || state.range[1] !== range[1])
    out.push(
      `${label}: axis drawn over ${state.range}, the answer's is ${range}`,
    );
  const span = Math.max(range[1] - range[0], 1);
  if (state.bars.length !== items.length)
    out.push(
      `${label}: ${state.bars.length} spans drawn, the answer has ${items.length}`,
    );
  for (const item of items) {
    const bar = state.bars.find((drawn) => drawn.id === item.id);
    if (bar === undefined) {
      out.push(`span ${item.id}: missing from ${label}`);
      continue;
    }
    const end = item.end ?? fallbackEnd;
    const left = ((item.start - range[0]) / span) * 100;
    const width = Math.max(((end - item.start) / span) * 100, SHORTEST_BAR);
    if (Math.abs(bar.left - left) > GEOMETRY)
      out.push(`span ${item.id}: left ${bar.left}% is not ${left}%`);
    if (Math.abs(bar.width - width) > GEOMETRY)
      out.push(`span ${item.id}: width ${bar.width}% is not ${width}%`);
  }
  return out;
}

function checkGraph(state: ScreenState, detail: LiveRunDetail): string[] {
  const out: string[] = [];
  if (state.header !== detail.run.run_id)
    out.push(`run header: ${state.header} is not ${detail.run.run_id}`);
  const views = nodeViews(detail);
  if (state.cards.length !== views.length)
    out.push(
      `cards: ${state.cards.length} drawn, the answer has ${views.length}`,
    );
  for (const node of views) {
    const name = `${node.label}: ${node.status}`;
    const card = state.cards.find((held) => held.name === name);
    if (card === undefined) {
      const named = state.cards.find((held) =>
        held.name?.startsWith(`${node.label}:`),
      );
      out.push(
        `card ${node.id} state: drawn ${named?.name ?? "nothing"}, the answer has ${name}`,
      );
      continue;
    }
    const reason = isUnhealthy(node.status) ? nodeReason(node) : undefined;
    if ((card.reason ?? undefined) !== reason)
      out.push(`card ${node.id} reason: ${card.reason} is not ${reason}`);
    const awaits = awaitedLine(node);
    if ((card.awaits ?? undefined) !== awaits)
      out.push(`card ${node.id} awaits: ${card.awaits} is not ${awaits}`);
  }
  return out;
}

function checkOverall(state: ScreenState, visible: Visible): string[] {
  const { detail, timeline } = visible;
  const out: string[] = [];
  if (state.hero !== detail.run.run_id)
    out.push(`hero: ${state.hero} is not ${detail.run.run_id}`);
  if (!state.hero_lines.includes(detail.run.phase))
    out.push(
      `hero phase: ${state.hero_lines} does not say ${detail.run.phase}`,
    );
  const metric = (name: string, tile: Tile | null, value: string) => {
    if (tile?.value !== value)
      out.push(`metric ${name}: ${tile?.value ?? "missing"} is not ${value}`);
  };
  metric("Status", state.status, detail.run.state);
  metric("Nodes", state.nodes, String(detail.run.nodes.length));
  metric(
    "Wall time",
    state.wall,
    detail.run.timing.wall_seconds === null
      ? "not measured"
      : formatDurationSeconds(detail.run.timing.wall_seconds),
  );
  metric(
    "Turns",
    state.turns,
    typeof detail.run.turns === "number"
      ? String(detail.run.turns)
      : LOADING_TEXT,
  );
  const graph = graphTimeline(timeline, nodeViews(detail));
  out.push(
    ...bars(
      state,
      graph.line.items,
      graph.range,
      "whole-run line",
      graph.range[1],
    ),
  );
  return out;
}

function checkNode(
  state: ScreenState,
  visible: Visible,
  nodeId: string,
): string[] {
  const { detail, timeline } = visible;
  const out: string[] = [];
  const node = nodeViews(detail).find((view) => view.id === nodeId);
  if (node === undefined) return [`node ${nodeId}: not in the answer`];
  if (state.node_heading !== `Timeline for ${node.label}`)
    out.push(`node heading: ${state.node_heading} is not ${node.label}`);
  if (state.node_state !== node.status)
    out.push(`node state: ${state.node_state} is not ${node.status}`);
  const projection = nodeTimelineV2(timeline, node.id);
  const starts = projection.items.map((item) => item.start);
  const ends = projection.items.map((item) => item.end ?? item.start);
  const range: readonly [number, number] =
    starts.length === 0
      ? [0, 1]
      : [Math.min(...starts), Math.max(...ends, ...starts) + 1];
  out.push(
    ...bars(
      state,
      projection.items.map((item) => ({
        ...item,
        end: item.end ?? item.start,
      })),
      range,
      "node plot",
      range[1],
    ),
  );
  const rows = transcriptEntries(projection.tree, new Set()).flatMap((entry) =>
    entry.entryKind === "row" ? [entry.row.displayLabel] : [],
  );
  if (state.rows.length !== rows.length)
    out.push(`rows: ${state.rows.length} drawn, the answer has ${rows.length}`);
  rows.forEach((row, index) => {
    if (state.rows[index] !== row)
      out.push(`row ${index}: ${state.rows[index]} is not ${row}`);
  });
  return out;
}

/** Every way `state` does not draw `visible`, named; empty where it does. */
export function checkScreen(
  view: FirstView,
  visible: Visible,
  state: ScreenState,
  nodeId?: string,
): string[] {
  if (view === "graph") return checkGraph(state, visible.detail);
  if (view === "overall") return checkOverall(state, visible);
  return checkNode(state, visible, nodeId ?? "");
}

type Json = Record<string, unknown>;

/** Every kept value of the answer's detail equals the complete document's. */
export function checkAnswer(
  visible: Visible,
  complete: {
    readonly detail: Json;
    readonly timeline: { readonly spans: readonly Json[] };
  },
  scope: "run" | "node" | undefined,
): string[] {
  const out: string[] = [];
  const detail = visible.detail as unknown as Json & {
    run: Json & { nodes: Json[]; timing: Json };
    graph: Json & {
      plan: Json & { tasks: Json[] };
      node_results?: Record<string, Json>;
    };
  };
  const whole = complete.detail as typeof detail;
  const compare = (name: string, held: unknown, value: unknown) => {
    if (JSON.stringify(held ?? null) !== JSON.stringify(value ?? null))
      out.push(
        `${name}: answer ${JSON.stringify(held)} is not the complete document's ${JSON.stringify(value)}`,
      );
  };
  for (const key of ["run_id", "state", "phase", "last_event"])
    compare(`run.${key}`, detail.run[key], whole.run[key]);
  compare(
    "run.timing.wall_seconds",
    detail.run.timing.wall_seconds,
    whole.run.timing.wall_seconds,
  );
  if (typeof detail.run.turns === "number")
    compare("run.turns", detail.run.turns, whole.run.turns);
  else if (
    typeof detail.run.turns !== "object" ||
    (detail.run.turns as { loading?: boolean } | null)?.loading !== true
  )
    out.push("run.turns: neither a value nor marked loading");
  compare("run.nodes", detail.run.nodes.length, whole.run.nodes.length);
  detail.run.nodes.forEach((node, index) => {
    for (const key of ["node", "status", "outcome", "failure"])
      compare(
        `run.nodes[${node.node}].${key}`,
        node[key],
        whole.run.nodes[index]?.[key],
      );
  });
  for (const key of [
    "last_seq",
    "run_id",
    "node_status",
    "node_gated_by",
    "node_control",
    "result",
  ])
    compare(`graph.${key}`, detail.graph[key], whole.graph[key]);
  compare("graph.plan.goal", detail.graph.plan.goal, whole.graph.plan.goal);
  compare(
    "graph.plan.tasks",
    detail.graph.plan.tasks.length,
    whole.graph.plan.tasks.length,
  );
  detail.graph.plan.tasks.forEach((task, index) => {
    for (const key of ["id", "kind", "name", "deps", "repo", "steps"])
      compare(
        `plan.tasks[${task.id}].${key}`,
        task[key],
        whole.graph.plan.tasks[index]?.[key],
      );
  });
  for (const [node, result] of Object.entries(detail.graph.node_results ?? {}))
    for (const key of ["blocked_by", "awaiting", "outcome", "error", "detail"])
      compare(
        `graph.node_results.${node}.${key}`,
        result[key],
        whole.graph.node_results?.[node]?.[key],
      );
  for (const [node, result] of Object.entries(whole.graph.node_results ?? {}))
    if (result.awaiting !== undefined || result.blocked_by !== undefined)
      compare(
        `graph.node_results.${node}.awaiting`,
        detail.graph.node_results?.[node]?.awaiting,
        result.awaiting,
      );
  if (scope !== undefined && visible.timeline !== undefined) {
    const spans = visible.timeline.spans as unknown as Json[];
    // Before the rest Overall withholds the harness spans; a tab opening a run
    // already read holds them with `complete: true`.
    const finished =
      (visible.detail as unknown as { progress?: { complete?: boolean } })
        .progress?.complete === true;
    const ordinary = complete.timeline.spans.filter(
      (span) =>
        scope === "node" || finished || span.harness_scope === undefined,
    );
    if (spans.length !== ordinary.length)
      out.push(
        `spans: the answer holds ${spans.length}, the complete document ${ordinary.length}`,
      );
    const byId = new Map(ordinary.map((span) => [span.id, span]));
    for (const span of spans) {
      const whole = byId.get(span.id);
      if (whole === undefined) {
        out.push(`span ${String(span.id)}: not in the complete document`);
        continue;
      }
      for (const key of [
        "kind",
        "status",
        "started_at",
        "ended_at",
        "label",
        "parent_id",
        "node_id",
      ])
        compare(`span ${String(span.id)}.${key}`, span[key], whole[key]);
      if (scope === "node") {
        const held = (span.events as Json[]).map((event) => event.id);
        const all = (whole.events as Json[]).map((event) => event.id);
        compare(
          `span ${String(span.id)}.events`,
          held,
          all.slice(-held.length || all.length),
        );
        compare(
          `span ${String(span.id)}.events_total`,
          span.events_total ?? held.length,
          all.length,
        );
      }
    }
  }
  return out;
}
