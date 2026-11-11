/**
 * What an address asks to be shown, read without the rest of the app.
 *
 * This is the first-screen chunk's reading of the address: it imports nothing that
 * parses a payload, because everything on this path counts against a run's first
 * second. `src/test/first-screen-address.test.ts` holds what it reads to `useUrlSelection`'s
 * reading, which is the one the rest of the app takes, over a table of addresses.
 */
import type { SubscriptionView } from "@onepipeline-ui/dag-model";

export type FirstScreenKind = "graph" | "overall" | "node";

export interface FirstAddress {
  readonly runId: string;
  readonly nodeId?: string;
  readonly kind: FirstScreenKind;
  readonly view: SubscriptionView;
}

/**
 * Whether an address value can be the opaque identifier the read API takes: a
 * run, a node or a timeline item is a non-empty token with no control character
 * and none of `/?#`, which is exactly what the telemetry client refuses to put
 * in a path. The one reading of it: `useUrlSelection` takes it from here, so a
 * shared address that could never be served lands where an unnamed one does on
 * the first screen and in the app alike.
 */
export function isOpaqueId(value: string): boolean {
  const hasControlCharacter = [...value].some(
    (character) => character.charCodeAt(0) < 32,
  );
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !hasControlCharacter &&
    !/[/?#]/u.test(value)
  );
}

function usable(value: string | null): string | undefined {
  return value !== null && isOpaqueId(value) ? value : undefined;
}

/**
 * Which page a run's view shows: its graph, Overall, its channel, or a node's
 * timeline where the graph names a node. The app and the first screen both read
 * the address through this.
 */
export function runPageKind(
  view: "graph" | "overall" | "channel",
  nodeId: string | undefined,
): "graph" | "overall" | "node" | "channel" {
  if (view === "overall" || view === "channel") return view;
  return nodeId === undefined ? "graph" : "node";
}

/** The server's two profile names for the two levels of detail. */
const FILTERS = { decisions: "planner", activity: "detailed" } as const;

/** The view a run's page subscribes to, once it knows what it shows. */
export function subscriptionView(
  runId: string | undefined,
  kind: "graph" | "overall" | "node" | "channel",
  nodeId: string | undefined,
  filter: string | undefined,
): SubscriptionView {
  if (runId === undefined) return { type: "sidebar" };
  const filtered = filter === undefined ? {} : { filter };
  switch (kind) {
    case "channel":
      return { type: "channel", run_id: runId };
    case "overall":
      return { type: "timeline", run_id: runId, scope: "run", ...filtered };
    case "node":
      return nodeId === undefined
        ? { type: "detail", run_id: runId, ...filtered }
        : {
            type: "timeline",
            run_id: runId,
            scope: "node",
            node: nodeId,
            ...filtered,
          };
    case "graph":
      return { type: "detail", run_id: runId, ...filtered };
  }
}

/**
 * The first screen `search` asks for, or `undefined` where none is drawn: no run, the
 * Host or action-items page, a channel, or a node's tab other than its timeline.
 */
export function firstAddress(
  search: string,
  pathname: string,
): FirstAddress | undefined {
  const params = new URLSearchParams(search);
  const runId = usable(params.get("run"));
  if (
    runId === undefined ||
    params.get("page") === "host" ||
    pathname.replace(/\/$/u, "") === "/human-items"
  )
    return undefined;
  const nodeId = usable(params.get("node"));
  const named = params.get("view");
  const tab = params.get("tab");
  if (tab !== null && tab !== "timeline") return undefined;
  const filter =
    params.get("detail") === "decisions" ? FILTERS.decisions : FILTERS.activity;
  // An address naming no view, or one this app has no page for, opens the graph
  // where it names a node and Overall where it names none, as `useUrlSelection` does.
  const kind = runPageKind(
    named === "overall" || named === "graph" || named === "channel"
      ? named
      : nodeId === undefined
        ? "overall"
        : "graph",
    nodeId,
  );
  if (kind === "channel") return undefined;
  return {
    runId,
    ...(kind === "node" && nodeId !== undefined ? { nodeId } : {}),
    kind,
    view: subscriptionView(runId, kind, nodeId, filter),
  };
}
