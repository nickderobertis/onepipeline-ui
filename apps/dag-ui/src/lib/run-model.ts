import { DAG_NODE_STATES } from "@onepipeline-ui/dag-layout";
import {
  type AwaitedRelease,
  type Failure,
  type GraphResultItem,
  type LiveGraphState,
  type LiveNodeTelemetry,
  type LiveRunDetail,
  type NodeControl,
  type NodeDetail,
  type NodeStatus,
  nodeStatusSchema,
  type PlanTask,
  type RunLaunch,
} from "@onepipeline-ui/dag-model";

/** How a launching harness is named wherever this app names one. */
export type LauncherName = "Claude" | "Codex" | "Unattributed";

export interface NodeView {
  readonly id: string;
  readonly label: string;
  readonly kind: "agent" | "human" | "command" | "lifecycle";
  /** The authoritative `GraphState.node_status`, rendered without client-side defaults. */
  readonly status: NodeStatus;
  /**
   * The plan's task for this node. Absent only on a node that is not on the run's
   * graph (`offGraph`): its records outlived the plan entry, and nothing else
   * holds a task for it.
   */
  readonly task?: PlanTask;
  /**
   * A node the run recorded work for that its graph no longer holds — one a live
   * edit replaced or removed. Opened by an address naming it, never drawn on the
   * graph.
   */
  readonly offGraph?: true;
  readonly telemetry?: LiveNodeTelemetry;
  readonly result?: GraphResultItem;
  readonly detail?: NodeDetail;
  /**
   * Whether the run has a turn it can reach for this node. Served for a node in
   * flight and absent for every other, because a node with no turn has none to
   * reach — which is not the same answer as "cannot".
   */
  readonly control?: NodeControl;
  /** How this node failed, when it did; served typed rather than parsed out of prose. */
  readonly failure?: Failure;
  /**
   * Everything holding this node up, in the order a reader should be told it: the
   * plan nodes gating it, then the human action refs its settled result named.
   * Empty for a node nothing is holding.
   */
  readonly blockers: readonly string[];
  /**
   * The plan nodes that name this one as a dependency, in plan order: what this
   * node's settling releases, which is what a reader deciding whether to act on a
   * waiting node needs to know.
   */
  readonly dependents: readonly string[];
}

/**
 * The run's graph state, or `undefined` for a run the server could not project one
 * for — a run whose plan this host cannot read at all.
 *
 * One object, not the last of a list. Execution is continuous, so a run has one
 * graph it is converging toward rather than a round per batch, and reading "the
 * latest" of anything is what this replaced.
 */
export function graphOf(detail: LiveRunDetail): LiveGraphState | undefined {
  return detail.graph ?? undefined;
}

/**
 * The graph overrides a graph holds: the run-wide list every future node
 * dispatch composes first, and each plan node's own. Absent on the wire is the
 * empty list, which is what the engine reads it as.
 */
export function currentOverrides(graph: LiveGraphState): {
  readonly run: readonly string[];
  readonly nodes: ReadonlyMap<string, readonly string[]>;
} {
  return {
    run: graph.run_node_sets ?? [],
    nodes: new Map(graph.plan.tasks.map((task) => [task.id, task.sets ?? []])),
  };
}

export function nodeViews(detail: LiveRunDetail): NodeView[] {
  const graph = graphOf(detail);
  if (!graph) return [];
  const telemetry = new Map(detail.run.nodes.map((node) => [node.node, node]));
  return graph.plan.tasks.flatMap((task) => {
    const rawKind = readString(task, "kind");
    const kind =
      rawKind === "human" || rawKind === "command"
        ? rawKind
        : hasLifecycleShape(task)
          ? "lifecycle"
          : "agent";
    // `node_results` holds only what a *terminal journal event* carried, so it is
    // empty for every node the scheduler settled without dispatching. A run whose
    // driver closed out also recorded a whole-graph result, and for those nodes it is
    // the only record there is — the one that carries what blocked them.
    const result =
      graph.node_results[task.id] ?? graph.result?.results?.[task.id];
    const status = graph.node_status[task.id];
    // The server excludes a run it cannot fold into authoritative node statuses.
    // Stay defensive if an older server violates that invariant: omit the unusable
    // task instead of inventing a state for it or taking down the remaining graph.
    if (status === undefined) return [];
    return [
      {
        id: task.id,
        label: readString(task, "name") ?? task.id,
        status,
        kind,
        task,
        telemetry: telemetry.get(task.id),
        result,
        detail: detail.node_details[task.id],
        control: graph.node_control[task.id],
        failure: telemetry.get(task.id)?.failure,
        blockers: [
          ...(graph.node_gated_by[task.id] ?? []),
          ...(result?.blocked_by ?? []),
        ],
        dependents: graph.plan.tasks
          .filter((other) => other.deps?.includes(task.id))
          .map((other) => other.id),
      },
    ];
  });
}

/**
 * The node an address names: the graph's own view of it, or — for a node the
 * graph does not hold — a view of what the run recorded for it, so a link to a
 * node a live edit replaced opens that node's timeline rather than the graph.
 *
 * `undefined` while the graph itself is not known, so a first answer that has
 * not brought the plan yet does not call every node off the graph. Every field
 * of an off-graph view is one the server served for that node — its status
 * from the run's own per-node record, `unknown` where it recorded none — and
 * none is filled in: it has no task, no dependencies and nothing it unblocks.
 */
export function openedNode(
  detail: LiveRunDetail | undefined,
  nodes: readonly NodeView[],
  nodeId: string | undefined,
): NodeView | undefined {
  if (nodeId === undefined || detail === undefined) return undefined;
  const graph = graphOf(detail);
  if (graph === undefined) return undefined;
  const onGraph = nodes.find(({ id }) => id === nodeId);
  if (onGraph !== undefined) return onGraph;
  if (graph.plan.tasks.some((task) => task.id === nodeId)) return undefined;
  const telemetry = detail.run.nodes.find(({ node }) => node === nodeId);
  const status = nodeStatusSchema.safeParse(telemetry?.status);
  const result = graph.node_results[nodeId] ?? graph.result?.results?.[nodeId];
  return {
    id: nodeId,
    label: nodeId,
    // Not a kind the plan declared: the header names the node off the graph
    // instead, and nothing else reads an off-graph node's kind.
    kind: "agent",
    offGraph: true,
    status: status.success ? status.data : "unknown",
    telemetry,
    result,
    detail: detail.node_details[nodeId],
    failure: telemetry?.failure,
    blockers: [],
    dependents: [],
  };
}

export function nodeKindWord(node: NodeView): string {
  return node.offGraph === true ? "off-graph" : node.kind;
}

/**
 * How the run's graph stands as a whole — `failed`, `waiting` or `complete` — read
 * from the engine's own per-node statuses (`GET /status`'s `node_status`) by the
 * engine's own rule (`graph::state_of`): any node failed or skipped fails the
 * graph, only a graph whose every node is done is complete, and anything else is
 * waiting. An empty graph is complete, as the engine reads it.
 *
 * Derived here rather than served because it is a pure reading of statuses every
 * client already holds.
 */
export function graphStateWord(
  statuses: Readonly<Record<string, string>>,
): "failed" | "waiting" | "complete" {
  const all = Object.values(statuses);
  if (all.some((status) => status === "failed" || status === "skipped"))
    return "failed";
  if (all.every((status) => status === "done")) return "complete";
  return "waiting";
}

/** The harness that launched a run, named the one way this app names it. */
export function launcherName(launch?: RunLaunch): LauncherName {
  switch (launch?.launcher) {
    case "claude-code":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return "Unattributed";
  }
}

/**
 * How one run's launch is named on screen — as the tag on its row in the run list
 * and beside a run-level transcript alike, so the two never disagree about the same
 * run.
 *
 * It names the *session*, not the launch: one planner session launches many runs
 * and mints a fresh `launch_id` for each, so a row tagged by launch id told an
 * operator nothing about which planner it belonged to. The join is served on the
 * list row itself, so a row is tagged before a single run's detail — let alone its
 * transcripts — has been read.
 *
 * There are three honest answers, and none of them is "unknown session". A run
 * whose launching session is named reads as that session. A run that recorded a
 * launch but nothing that can name its session — every run launched before the
 * launcher was detected, once its short-lived provenance record has gone — reads as
 * the launch it does know. A run with no launch record at all is unattributed, which
 * is what an e2e fixture and a bare `run-plan` genuinely are.
 */
export function launchLabel(launch?: RunLaunch): string {
  const name = launcherName(launch);
  if (launch?.session_key !== undefined) {
    return `${name} session · ${shortId(launch.session_key)}`;
  }
  return launch === undefined
    ? "Unattributed"
    : `${name} launch · ${shortId(launch.launch_id)}`;
}

/**
 * The one-line reason a node is not making progress, or `undefined` when it is.
 *
 * Shared by the graph card and the node detail banner so the short line under a card
 * and the headline of the view it opens cannot say different things.
 */
export function nodeReason(node: NodeView): string | undefined {
  if (node.blockers.length > 0 && REASON_IS_A_BLOCKER.has(node.status)) {
    return `blocked by ${node.blockers.join(", ")}`;
  }
  if (!isOwnWorkLost(node.status)) return undefined;
  return recordedReason(node) ?? `${node.status}, with no reason recorded`;
}

/**
 * Statuses for a node that finished its work and waits on a release before it may
 * land: its change request held as a draft, or its branch held unlanded on its
 * origin. Neither is lost work nor a blocker: nothing has gone wrong, and what it
 * waits on is another repository's release, which `awaiting` names.
 */
const AWAITS_RELEASE: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "complete-but-draft",
  "complete-but-held",
]);

/**
 * The releases a node holding finished work still awaits, in the order its
 * settlement listed them — read off the served `awaiting` and never out of the
 * detail sentence. Empty for every node not in one of those two statuses.
 */
export function awaitedReleases(node: NodeView): readonly AwaitedRelease[] {
  if (!AWAITS_RELEASE.has(node.status)) return [];
  return node.result?.awaiting ?? [];
}

/**
 * The one short line a held node's card carries: the first release it awaits, by
 * its target and the producer's last path segment, and `+N` for the rest —
 * `awaits crate of engine +1`. Short enough to show whole on a 200-pixel card; the
 * node view names every entry in full. `undefined` for a node awaiting nothing.
 */
export function awaitedLine(node: NodeView): string | undefined {
  const [first, ...rest] = awaitedReleases(node);
  if (first === undefined) return undefined;
  const producer = first.producer.split("/").filter(Boolean).at(-1);
  const more = rest.length > 0 ? ` +${rest.length}` : "";
  return `awaits ${first.target} of ${producer ?? first.producer}${more}`;
}

/**
 * What the run itself recorded about a lost outcome, or `undefined` when it recorded
 * nothing — the classified failure detail first, then the lifecycle's own prose, the
 * dispatch's error, and last the outcome word, which is a classification rather than
 * a sentence and so is the least it can say.
 *
 * One chain, read by the card's line and the node view's banner alike: two orders
 * would let a card and the view it opens explain the same failure differently.
 */
export function recordedReason(node: NodeView): string | undefined {
  // A command's outcome word says which of its two ways it failed — it exited
  // non-zero, or it outlived its deadline — which its detail sentence leaves to
  // the reader to infer, so it leads.
  const outcome = node.result?.outcome?.trim();
  if (node.kind === "command" && outcome) {
    return [outcome, (node.failure?.detail || node.result?.detail)?.trim()]
      .filter(Boolean)
      .join(": ");
  }
  const recorded =
    node.failure?.detail ||
    node.result?.detail ||
    node.result?.error ||
    node.telemetry?.outcome ||
    node.result?.outcome;
  return recorded?.trim() || undefined;
}

/**
 * Statuses whose reason is named in `blockers` rather than in the node's own record.
 *
 * They are three different conditions: `blocked` is held behind a dependency,
 * `skipped` is terminal because a prerequisite did not complete, and `waiting` is
 * journaled on the node itself. All this set decides is where the sentence comes
 * from — a waiting node's own result names the human action it waits for, exactly as
 * a blocked node's names what holds it, so one line reads all three.
 */
const REASON_IS_A_BLOCKER: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "blocked",
  "skipped",
  "waiting",
]);
/** Statuses that mean this node's own work ran, or was cut short, without finishing. */
const OWN_WORK_LOST: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "failed",
  "not-completed",
  "cancelled",
]);

/**
 * A run row's own nodes, counted by status: `2 done · 1 blocked`.
 *
 * `RunSummary.node_counts` is counted on the server over the same derivation the
 * graph renders, so this line and the cards it opens cannot describe different
 * graphs — which is the disagreement an operator saw between the two. Ordered by the
 * contract's own vocabulary so the words hold their places between polls; a count the
 * vocabulary does not know is still shown, after them, rather than dropped.
 */
export function nodeCountSummary(
  counts: Readonly<Record<string, number>>,
): string {
  const known: readonly string[] = DAG_NODE_STATES;
  const positive = (name: string) => (counts[name] ?? 0) > 0;
  return [
    ...known.filter(positive),
    ...Object.keys(counts)
      .filter((name) => !known.includes(name))
      .sort()
      .filter(positive),
  ]
    .map((name) => `${counts[name]} ${name}`)
    .join(" · ");
}

/** Whether a node's own work ran, or was cut short, without finishing. */
export function isOwnWorkLost(status: NodeStatus): boolean {
  return OWN_WORK_LOST.has(status);
}

/** Whether a node's status is one an operator has to act on, banner and all. */
export function isUnhealthy(status: NodeStatus): boolean {
  return isOwnWorkLost(status) || status === "blocked" || status === "skipped";
}

export function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const result = value[key];
  return typeof result === "string" && result.length > 0 ? result : undefined;
}

function hasLifecycleShape(task: PlanTask): boolean {
  return "repo" in task || "steps" in task;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
