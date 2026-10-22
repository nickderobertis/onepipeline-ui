import type {
  ChannelQueue,
  LiveActivity,
  RunDetail,
  RunTimeline,
  SidebarRow,
  SubscriptionView,
} from "@onepipeline-ui/dag-model";
import { liveActivityListSchema } from "@onepipeline-ui/dag-model";
import {
  type LiveState,
  type LiveView,
  type TelemetryClient,
  TelemetryClientError,
} from "@onepipeline-ui/telemetry-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newestRows } from "../../lib/sidebar-model";

// llmlint: ignore-file[changed_behavior_has_e2e] The browser journeys in
// apps/dag-ui-e2e/dag-ui-live-updates.spec.ts drive every branch a conforming
// server reaches against the real one: the opening snapshot, a run.changed row
// for another run, a detail, timeline and channel patch for the open run, a
// switch of view replacing the subscription, and a stream dropped and resumed.
// What only a broken peer reaches — a frame that fails validation, a patch that
// does not apply — is proven in App.test.tsx at the browser boundary.

/** Which of a run's views the page shows. */
export type RunViewKind = "graph" | "overall" | "node" | "channel";

export interface DagTelemetryOptions {
  /** The run the address names. */
  readonly runId?: string;
  readonly view: RunViewKind;
  /** The node a node timeline is of. */
  readonly nodeId?: string;
  /** The filter profile every payload is read under. */
  readonly filter?: string;
  /**
   * Whether an address naming no run opens the first one served: not on the
   * Host page, which is about the host rather than any run.
   */
  readonly selectFirst: boolean;
  /** The Host page subscribes to the sidebar alone. */
  readonly host: boolean;
}

export interface DagTelemetryState {
  /** The sidebar's trimmed rows. */
  readonly rows?: readonly SidebarRow[];
  /** The run being shown: the requested one when it is served, else the newest. */
  readonly runId?: string;
  readonly detail?: RunDetail;
  readonly timeline?: RunTimeline;
  readonly channel?: ChannelQueue;
  /**
   * A timeline view the server would not subscribe, reported where the timeline
   * would have been, beside the detail already on screen.
   */
  readonly timelineError?: Error;
  readonly loading: boolean;
  readonly lastUpdated?: string;
  readonly activity: readonly LiveActivity[];
  readonly error?: Error;
  /** An explicit re-send the server made, named, so the reader knows it happened. */
  readonly notice?: string;
  /** Subscribe again, from scratch. */
  readonly refresh: () => void;
}

/**
 * The page's one subscription: the sidebar and the one visible run view, kept
 * current by what the server pushes (`docs/contract.md`, "Subscriptions").
 *
 * Nothing here polls or re-reads. A tab subscribes to what it shows; moving to
 * another view replaces the subscription, so a view left behind is neither read
 * nor pushed; and every change arrives as a trimmed row or a patch of the
 * payload already on screen.
 */
export function useDagTelemetry(
  client: TelemetryClient,
  options: DagTelemetryOptions,
): DagTelemetryState {
  const [state, setState] = useState<LiveState>();
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [error, setError] = useState<Error>();
  //: The stream dropped and has not delivered since — cleared by what it sends next.
  const [streamError, setStreamError] = useState<Error>();
  const [notice, setNotice] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const rows = state?.sidebar;
  const requested = options.runId;
  const runId =
    rows === undefined
      ? requested
      : requested !== undefined && rows.some((row) => row.id === requested)
        ? requested
        : requested !== undefined || options.selectFirst
          ? newestRows(rows)[0]?.id
          : undefined;
  const view = useMemo(
    () =>
      subscriptionView(
        options.host ? undefined : runId,
        options.view,
        options.nodeId,
        options.filter,
      ),
    [options.host, runId, options.view, options.nodeId, options.filter],
  );
  const live = useRef<LiveView | undefined>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is not read here — bumping it is how a refresh asks for a new subscription; the view in effect is read off the ref so a view change replaces the subscription below rather than tearing this one down.
  useEffect(() => {
    setError(undefined);
    const subscription = client.live({
      view: viewRef.current,
      onState: (next, cause) => {
        setState(next);
        setLastUpdated(new Date().toISOString());
        setError(undefined);
        setStreamError(undefined);
        if (cause.kind === "reset")
          setNotice(`The live view was re-sent whole: ${cause.reason}.`);
      },
      onError: (caught) => {
        // A run the address names that is not served is not an error: the
        // sidebar is subscribed to instead, and the newest run is opened.
        if (
          caught instanceof TelemetryClientError &&
          (caught.code === "run_not_found" || caught.code === "node_not_found")
        ) {
          subscription.change({ type: "sidebar" });
          return;
        }
        setError(caught);
      },
      onDisconnected: () =>
        setStreamError(new Error("Live telemetry stream disconnected")),
      onConnected: () => setStreamError(undefined),
    });
    live.current = subscription;
    return () => {
      subscription.close();
      if (live.current === subscription) live.current = undefined;
    };
  }, [client, generation]);

  useEffect(() => {
    live.current?.change(view);
  }, [view]);

  const refresh = useCallback(() => {
    setNotice(undefined);
    setGeneration((current) => current + 1);
  }, []);

  const visible = state?.visible;
  const shown =
    visible !== undefined &&
    visible.type !== "sidebar" &&
    visible.run_id === runId &&
    sameView(visible, view)
      ? visible
      : undefined;
  // The detail stays on screen across a change of view of the same run.
  const heldDetail = useRef<RunDetail | undefined>(undefined);
  const detail =
    shown?.detail ??
    (heldDetail.current?.run.run_id === runId ? heldDetail.current : undefined);
  heldDetail.current = detail;
  const activity = useMemo(() => activityOf(detail), [detail]);
  const timelineRefused =
    error !== undefined && view.type === "timeline" && detail !== undefined;
  return {
    rows,
    runId,
    detail,
    timeline: shown && "timeline" in shown ? shown.timeline : undefined,
    channel: shown && "channel" in shown ? shown.channel : undefined,
    timelineError: timelineRefused ? error : undefined,
    loading: state === undefined && error === undefined,
    lastUpdated,
    activity,
    error: timelineRefused ? streamError : (error ?? streamError),
    notice,
    refresh,
  };
}

/** The subscription a page state shows. */
function subscriptionView(
  runId: string | undefined,
  kind: RunViewKind,
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

/** Whether the visible state the server sent is the view the page asks for. */
function sameView(
  visible: Exclude<LiveState["visible"], { type: "sidebar" }>,
  view: SubscriptionView,
): boolean {
  if (view.type !== visible.type) return false;
  if (view.type === "timeline" && visible.type === "timeline")
    return (
      view.scope === visible.scope &&
      (view.scope === "run" ||
        (visible.scope === "node" && visible.node === view.node))
    );
  return true;
}

/** The header's live activity line, as the detail carries it. */
function activityOf(detail: RunDetail | undefined): readonly LiveActivity[] {
  const candidate = (detail?.run as Record<string, unknown> | undefined)
    ?.live_activity;
  if (candidate === undefined) return [];
  const parsed = liveActivityListSchema.safeParse(candidate);
  return parsed.success ? parsed.data : [];
}
