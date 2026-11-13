// llmlint: ignore-file[stateful_logic_extracted_to_hooks] this app was copied whole from
// the repository it was written in, and its implementation is the spec — see
// apps/dag-ui/AGENTS.md. Its effects and subscriptions sit beside render because that is
// where they were written; lifting them into hooks would be rewriting behaviour this
// repository imported precisely so as not to reimplement it, with nothing but the copied
// journeys to catch what moved. The two hooks it does have — useConversation and
// useStickyBottom — are the ones that were extracted upstream.
import { layoutDag } from "@onepipeline-ui/dag-layout";
import {
  Background,
  Controls,
  type Edge,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import {
  awaitedLine,
  isUnhealthy,
  type NodeView,
  nodeReason,
} from "../../lib/run-model";
import { type DagFlowNode, DagNodeCard } from "./DagNodeCard";
import { DagRoutedEdge } from "./DagRoutedEdge";

const nodeTypes = { dagNode: DagNodeCard };
const edgeTypes = { routed: DagRoutedEdge };

export function DagGraph({
  nodes: nodeViews,
  selectedNodeId,
  onSelectNode,
  journalSeq,
}: {
  readonly nodes: readonly NodeView[];
  /** The journal sequence number of the last record this view has rendered. */
  readonly journalSeq?: number;
  readonly selectedNodeId?: string;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  // The one-line reason a card and the list beside it both state, keyed by node so
  // the layout's own sorted order cannot pair a card with another node's reason.
  const reasons = useMemo(() => {
    const found = new Map<string, string | undefined>();
    for (const node of nodeViews) {
      if (isUnhealthy(node.status)) found.set(node.id, nodeReason(node));
    }
    return found;
  }, [nodeViews]);
  const awaits = useMemo(
    () => new Map(nodeViews.map((node) => [node.id, awaitedLine(node)])),
    [nodeViews],
  );
  const { nodes, edges } = useMemo(() => {
    const drawn = new Set(nodeViews.map((node) => node.id));
    const layout = layoutDag({
      nodes: nodeViews.map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        state: node.status,
        // The card carries its awaits line inside its border, so it is laid out
        // one line taller.
        ...(awaits.get(node.id) === undefined ? {} : { lines: 1 }),
      })),
      edges: nodeViews.flatMap((node) =>
        (node.task.deps ?? [])
          // A cross-DAG dependency (`run:<run_id>#<node_id>`) names a node in
          // another run, which this graph cannot draw an edge to. The node detail
          // still lists it, so the prerequisite stays visible.
          .filter((dependency) => drawn.has(dependency))
          .map((dependency) => ({
            id: `${dependency}->${node.id}`,
            source: dependency,
            target: node.id,
          })),
      ),
    });
    return {
      nodes: layout.nodes.map(
        (node): DagFlowNode => ({
          id: node.id,
          type: "dagNode",
          position: { x: node.x, y: node.y },
          data: {
            label: node.label,
            kind: node.kind,
            state: node.state,
            style: node.style,
            selected: node.id === selectedNodeId,
            ...(reasons.get(node.id) === undefined
              ? {}
              : { reason: reasons.get(node.id) }),
            ...(awaits.get(node.id) === undefined
              ? {}
              : { awaits: awaits.get(node.id) }),
          },
          // The node's own dimensions rather than a style: React Flow hides a card
          // it holds no size for, and every live update hands it new node objects
          // whose measured size it drops until a resize observation re-measures
          // them, so on a busy page the whole graph stayed hidden for longer than a
          // reader waits after a node settled. The layout already knows each card's
          // size, so the card is drawn at it from the first frame.
          width: node.width,
          height: node.height,
          measured: { width: node.width, height: node.height },
          // React Flow also gates edges on handle bounds. These point anchors
          // are already known by the routed layout; waiting for ResizeObserver
          // can leave visible cards without dependencies until it delivers them.
          // llmlint: ignore[contracts_have_one_source_or_a_drift_gate] These anchors only initialize React Flow. DagRoutedEdge ignores its calculated endpoint coordinates and draws the authoritative layout edge.points; nodesConnectable=false disables connection gestures. Their positions cannot change the routed path or create a second geometry contract.
          handles: [
            {
              type: "target",
              position: Position.Left,
              x: 0,
              y: node.height / 2,
              width: 0,
              height: 0,
            },
            {
              type: "source",
              position: Position.Right,
              x: node.width,
              y: node.height / 2,
              width: 0,
              height: 0,
            },
          ],
        }),
      ),
      edges: layout.edges.map(
        (edge): Edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "routed",
          data: { points: edge.points },
          animated:
            nodeViews.find(({ id }) => id === edge.target)?.status ===
            "running",
        }),
      ),
    };
  }, [nodeViews, reasons, awaits, selectedNodeId]);

  return (
    <div className="graph-wrap" data-journal-seq={journalSeq}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        // React Flow scopes its own variables to `.react-flow`, so the document-level
        // `dark` class never reaches its canvas chrome; this is its own switch for it.
        colorMode="dark"
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        // `fitView` never zooms out past `minZoom`, so this floor decides whether the
        // graph arrives whole or cropped. Kept below what the narrowest viewport in
        // the matrix needs; the controls zoom in from there.
        minZoom={0.05}
        // `fitView` alone waits for a resize observation of every card, and a card
        // already carries its laid-out size, so on a loaded browser that holds those
        // observations back the graph opened unfitted — at scale 1, cropped — until
        // the window was resized: nothing else hands React Flow its nodes again once
        // a quiet run's changes are pushed rather than re-read. The canvas is fitted
        // as soon as it exists, from the sizes the layout already gave.
        onInit={(flow) => void flow.fitView()}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        aria-label="DAG execution graph"
      >
        {/* No minimap: these graphs are a handful of nodes that fit the canvas, so a
            second miniature of them was chrome over the thing being read. */}
        <Background color="var(--border)" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {/* The keyboard path to the graph, and the only reading of it available without
          the canvas: it states the same authoritative status each card paints, and the
          same reason each card truncates, so nothing here is pointer-only. */}
      <ol className="accessible-node-list" aria-label="DAG nodes">
        {nodeViews.map((node) => (
          <li key={node.id}>
            <button type="button" onClick={() => onSelectNode(node.id)}>
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
