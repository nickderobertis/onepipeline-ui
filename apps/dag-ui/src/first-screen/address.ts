/**
 * What an address asks to be shown, read without the rest of the app.
 *
 * This is the first-screen chunk's reading of the address: it imports nothing that
 * parses a payload, because everything on this path counts against a run's first
 * second. `src/test/first-screen-address.test.ts` holds its two copied words to
 * `useUrlSelection`'s, which is the reading the rest of the app takes.
 */
import type { SubscriptionView } from "@onepipeline-ui/dag-model";

export type FirstScreenKind = "graph" | "overall" | "node";

export interface FirstAddress {
  readonly runId: string;
  readonly nodeId?: string;
  readonly kind: FirstScreenKind;
  readonly view: SubscriptionView;
}

function usable(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > 512)
    return undefined;
  for (const character of value)
    if (character.charCodeAt(0) < 32) return undefined;
  return /[/?#]/u.test(value) ? undefined : value;
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
  if (named === "channel" || (tab !== null && tab !== "timeline"))
    return undefined;
  const filter =
    params.get("detail") === "decisions" ? FILTERS.decisions : FILTERS.activity;
  const kind: FirstScreenKind =
    named === "overall" || (named !== "graph" && nodeId === undefined)
      ? "overall"
      : nodeId === undefined
        ? "graph"
        : "node";
  return {
    runId,
    ...(kind === "node" && nodeId !== undefined ? { nodeId } : {}),
    kind,
    view: subscriptionView(runId, kind, nodeId, filter),
  };
}
